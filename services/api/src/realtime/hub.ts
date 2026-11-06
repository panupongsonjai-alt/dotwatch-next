import type { IncomingMessage, Server } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { z } from "zod";
import { can, mergeLatest, REALTIME_FLUSH_MS, type AlarmEvent, type LiveValue, type ServerMessage } from "@dotwatch/shared";
import type { Pool } from "../db/pool";
import { resolveUser, roleInOrg } from "../auth/users";
import type { TokenVerifier } from "../auth/userToken";
import { log } from "../lib/log";

/** Fan-out boundary. In-process today; a Redis pub/sub version can implement the same interface (decision 13). */
export interface Broadcaster {
  publishValues(orgId: string, values: LiveValue[]): void;
  publishDeviceSeen(orgId: string, deviceId: string, lastSeenAt: number): void;
  /** Sent immediately (not batched): alarms must not wait for the next flush. */
  publishAlarm(orgId: string, event: AlarmEvent): void;
  /** A user's role in an organization changed or ended: drop their subscription if access is gone, and tell them. */
  membershipChanged(orgId: string, userId: string, stillHasAccess: boolean): void;
}

const clientMessage = z.discriminatedUnion("type", [
  z.object({ type: z.literal("auth"), token: z.string().min(1) }),
  z.object({ type: z.literal("subscribe"), orgId: z.string().uuid() }),
  z.object({ type: z.literal("unsubscribe"), orgId: z.string().uuid() }),
]);

interface Session {
  socket: WebSocket;
  userId: string | null;
  orgs: Set<string>;
  pending: Map<string, LiveValue[]>;
  alive: boolean;
}

export interface RealtimeHub extends Broadcaster {
  attach(server: Server): void;
  close(): Promise<void>;
  /** for tests and health */
  stats(): { sessions: number; subscriptions: number };
}

export function createRealtimeHub(deps: { pool: Pool; verifyToken: TokenVerifier; path?: string; authTimeoutMs?: number }): RealtimeHub {
  const path = deps.path ?? "/v1/ws";
  const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });
  const sessions = new Set<Session>();
  const byOrg = new Map<string, Set<Session>>();

  const send = (s: Session, msg: ServerMessage) => {
    if (s.socket.readyState === s.socket.OPEN) s.socket.send(JSON.stringify(msg));
  };

  const unsubscribe = (s: Session, orgId: string) => {
    s.orgs.delete(orgId);
    s.pending.delete(orgId);
    const set = byOrg.get(orgId);
    set?.delete(s);
    if (set && set.size === 0) byOrg.delete(orgId);
  };

  const flushTimer = setInterval(() => {
    for (const s of sessions) {
      for (const [orgId, values] of s.pending) {
        if (values.length) send(s, { type: "values", orgId, values: mergeLatest(values) });
      }
      s.pending.clear();
    }
  }, REALTIME_FLUSH_MS);

  const pingTimer = setInterval(() => {
    for (const s of sessions) {
      if (!s.alive) {
        s.socket.terminate();
        continue;
      }
      s.alive = false;
      s.socket.ping();
    }
  }, 30_000);

  wss.on("connection", (socket: WebSocket) => {
    const session: Session = { socket, userId: null, orgs: new Set(), pending: new Map(), alive: true };
    sessions.add(session);
    const authTimer = setTimeout(() => {
      if (!session.userId) {
        send(session, { type: "error", code: "unauthorized", message: "Send an auth message first." });
        socket.close(4401, "auth timeout");
      }
    }, deps.authTimeoutMs ?? 10_000);

    socket.on("pong", () => (session.alive = true));
    socket.on("close", () => {
      clearTimeout(authTimer);
      for (const orgId of [...session.orgs]) unsubscribe(session, orgId);
      sessions.delete(session);
    });

    socket.on("message", async (raw) => {
      let parsed: z.infer<typeof clientMessage>;
      try {
        parsed = clientMessage.parse(JSON.parse(raw.toString()));
      } catch {
        send(session, { type: "error", code: "bad_message", message: "Unrecognized message." });
        return;
      }
      try {
        if (parsed.type === "auth") {
          const token = await deps.verifyToken(parsed.token);
          const user = await resolveUser(deps.pool, token);
          session.userId = user.id;
          clearTimeout(authTimer);
          send(session, { type: "ready", userId: user.id });
          return;
        }
        if (!session.userId) {
          send(session, { type: "error", code: "unauthorized", message: "Send an auth message first." });
          return;
        }
        if (parsed.type === "subscribe") {
          const role = await roleInOrg(deps.pool, session.userId, parsed.orgId);
          if (!can(role, "device.read")) {
            send(session, { type: "error", code: "forbidden", message: "No access to this organization." });
            return;
          }
          session.orgs.add(parsed.orgId);
          if (!byOrg.has(parsed.orgId)) byOrg.set(parsed.orgId, new Set());
          byOrg.get(parsed.orgId)!.add(session);
          send(session, { type: "subscribed", orgId: parsed.orgId });
          return;
        }
        unsubscribe(session, parsed.orgId);
      } catch (err) {
        const status = (err as { status?: number }).status;
        if (status === 401) {
          send(session, { type: "error", code: "unauthorized", message: "Sign in again." });
          socket.close(4401, "unauthorized");
        } else {
          log.error("realtime message failed", { error: (err as Error).message });
          send(session, { type: "error", code: "bad_message", message: "Could not process the message." });
        }
      }
    });
  });

  return {
    attach(server) {
      server.on("upgrade", (req: IncomingMessage, socket, head) => {
        const url = new URL(req.url ?? "/", "http://x");
        if (url.pathname !== path) {
          socket.destroy();
          return;
        }
        wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
      });
    },
    publishValues(orgId, values) {
      const subs = byOrg.get(orgId);
      if (!subs || values.length === 0) return;
      for (const s of subs) {
        const list = s.pending.get(orgId) ?? [];
        list.push(...values);
        s.pending.set(orgId, list);
      }
    },
    publishDeviceSeen(orgId, deviceId, lastSeenAt) {
      const subs = byOrg.get(orgId);
      if (!subs) return;
      for (const s of subs) send(s, { type: "device_seen", orgId, deviceId, lastSeenAt });
    },
    publishAlarm(orgId, event) {
      const subs = byOrg.get(orgId);
      if (!subs) return;
      for (const s of subs) send(s, { type: "alarm", orgId, event });
    },
    membershipChanged(orgId, userId, stillHasAccess) {
      for (const s of sessions) {
        if (s.userId !== userId) continue;
        if (!stillHasAccess) unsubscribe(s, orgId);
        send(s, { type: "membership", orgId });
      }
    },
    stats() {
      let subscriptions = 0;
      for (const s of byOrg.values()) subscriptions += s.size;
      return { sessions: sessions.size, subscriptions };
    },
    async close() {
      clearInterval(flushTimer);
      clearInterval(pingTimer);
      for (const s of sessions) s.socket.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    },
  };
}
