import { reconnectDelayMs, type ClientMessage, type ServerMessage } from "@dotwatch/shared";
import { API_URL } from "./api";
import { getToken } from "./auth";

export type LinkState = "connecting" | "live" | "reconnecting";

type Handler = (msg: ServerMessage) => void;

/**
 * One shared socket for the whole app (fixes old 6.9).
 * Reconnects forever with backoff; reconnects at once when the tab becomes visible;
 * emits "resync" after every reconnect so the page refetches what it missed.
 */
class RealtimeLink {
  private ws: WebSocket | null = null;
  private attempt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private orgs = new Set<string>();
  private handlers = new Set<Handler>();
  private stateHandlers = new Set<(s: LinkState) => void>();
  private resyncHandlers = new Set<() => void>();
  private state: LinkState = "connecting";
  private started = false;
  private everReady = false;

  start() {
    if (this.started) return;
    this.started = true;
    document.addEventListener("visibilitychange", this.onVisible);
    void this.open();
  }

  stop() {
    this.started = false;
    document.removeEventListener("visibilitychange", this.onVisible);
    if (this.timer) clearTimeout(this.timer);
    this.ws?.close();
    this.ws = null;
    this.everReady = false;
  }

  subscribe(orgId: string) {
    this.orgs.add(orgId);
    this.send({ type: "subscribe", orgId });
  }

  unsubscribe(orgId: string) {
    this.orgs.delete(orgId);
    this.send({ type: "unsubscribe", orgId });
  }

  onMessage(fn: Handler) {
    this.handlers.add(fn);
    return () => void this.handlers.delete(fn);
  }

  onState(fn: (s: LinkState) => void) {
    this.stateHandlers.add(fn);
    fn(this.state);
    return () => void this.stateHandlers.delete(fn);
  }

  onResync(fn: () => void) {
    this.resyncHandlers.add(fn);
    return () => void this.resyncHandlers.delete(fn);
  }

  private setState(s: LinkState) {
    this.state = s;
    this.stateHandlers.forEach((h) => h(s));
  }

  private send(msg: ClientMessage) {
    if (this.ws?.readyState === WebSocket.OPEN && this.state === "live") this.ws.send(JSON.stringify(msg));
  }

  private onVisible = () => {
    if (document.visibilityState === "visible" && this.state !== "live" && this.started) {
      if (this.timer) clearTimeout(this.timer);
      this.attempt = 0;
      void this.open();
    }
  };

  private async open() {
    if (!this.started) return;
    this.ws?.close();
    const token = await getToken();
    if (!token) return;
    const ws = new WebSocket(`${API_URL.replace(/^http/, "ws")}/v1/ws`);
    this.ws = ws;
    ws.onopen = () => ws.send(JSON.stringify({ type: "auth", token } satisfies ClientMessage));
    ws.onmessage = (ev) => {
      const msg = JSON.parse(String(ev.data)) as ServerMessage;
      if (msg.type === "ready") {
        const reconnected = this.everReady;
        this.everReady = true;
        this.attempt = 0;
        this.setState("live");
        this.orgs.forEach((orgId) => ws.send(JSON.stringify({ type: "subscribe", orgId } satisfies ClientMessage)));
        if (reconnected) this.resyncHandlers.forEach((h) => h());
        return;
      }
      this.handlers.forEach((h) => h(msg));
    };
    ws.onclose = () => {
      if (this.ws !== ws || !this.started) return;
      this.setState("reconnecting");
      const delay = reconnectDelayMs(this.attempt++);
      this.timer = setTimeout(() => void this.open(), delay);
    };
  }
}

export const realtime = new RealtimeLink();
