import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import type { ServerMessage } from "@dotwatch/shared";
import { addDevice, get, post, resetDatabase, startTestServer, userWithOrg, type TestEnv } from "./helpers";

let env: TestEnv;

beforeAll(async () => {
  await resetDatabase();
  env = await startTestServer();
});
afterAll(async () => env.close());
beforeEach(async () => {
  await env.pool.query("truncate readings, latest, devices, memberships, organizations, users cascade");
});

const count = async (sql: string, params: unknown[] = []) => Number((await env.pool.query(sql, params)).rows[0].n);

describe("ingest", () => {
  it("stores a batch, advances latest and touches the device", async () => {
    const { org } = await userWithOrg(env.pool, "alice");
    const dev = await addDevice(env.pool, org.id, "ROOM-1");
    const t = Date.now() - 10_000;
    const res = await post(`${env.url}/v1/ingest`, {
      fw: "1.2.0",
      readings: [{ t, m: { temperature: 4.1, humidity: 60 } }, { t: t + 5000, m: { temperature: 4.3 } }],
    }, dev.auth);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, accepted: 2, rejected: [], commands: [] });
    expect(await count("select count(*) n from readings where device_id = $1", [dev.id])).toBe(3);
    const latest = await env.pool.query("select metric_key, value from latest where device_id = $1 order by metric_key", [dev.id]);
    expect(latest.rows).toEqual([{ metric_key: "humidity", value: 60 }, { metric_key: "temperature", value: 4.3 }]);
    const d = await env.pool.query("select firmware_version, last_seen_at from devices where id = $1", [dev.id]);
    expect(d.rows[0].firmware_version).toBe("1.2.0");
    expect(d.rows[0].last_seen_at).not.toBeNull();
  });

  it("is idempotent when a device retries the same batch", async () => {
    const { org } = await userWithOrg(env.pool, "alice");
    const dev = await addDevice(env.pool, org.id, "ROOM-1");
    const batch = { readings: [{ t: Date.now() - 1000, m: { temperature: 5 } }] };
    await post(`${env.url}/v1/ingest`, batch, dev.auth);
    const again = await post(`${env.url}/v1/ingest`, batch, dev.auth);
    expect(again.status).toBe(200);
    expect(await count("select count(*) n from readings")).toBe(1);
  });

  it("rejects stale readings one by one instead of failing the batch (no poisoned queue)", async () => {
    const { org } = await userWithOrg(env.pool, "alice");
    const dev = await addDevice(env.pool, org.id, "ROOM-1");
    const now = Date.now();
    const res = await post(`${env.url}/v1/ingest`, {
      readings: [
        { t: now - 8 * 24 * 3600_000, m: { temperature: 1 } },
        { t: now - 2 * 3600_000, m: { temperature: 2 } },
        { t: now + 3600_000, m: { temperature: 3 } },
      ],
    }, dev.auth);
    expect(res.status).toBe(200);
    expect(res.body.accepted).toBe(1);
    expect(res.body.rejected).toEqual([{ index: 0, reason: "too_old" }, { index: 2, reason: "in_future" }]);
    const row = await env.pool.query("select value, backfilled from readings");
    expect(row.rows).toEqual([{ value: 2, backfilled: true }]);
  });

  it("never moves latest backwards when an old queued reading arrives", async () => {
    const { org } = await userWithOrg(env.pool, "alice");
    const dev = await addDevice(env.pool, org.id, "ROOM-1");
    const now = Date.now();
    await post(`${env.url}/v1/ingest`, { readings: [{ t: now - 1000, m: { temperature: 9 } }] }, dev.auth);
    await post(`${env.url}/v1/ingest`, { readings: [{ t: now - 3600_000, m: { temperature: 1 } }] }, dev.auth);
    const latest = await env.pool.query("select value from latest");
    expect(latest.rows[0].value).toBe(9);
    expect(await count("select count(*) n from readings")).toBe(2);
  });

  it("returns 401 for missing, unknown or wrong credentials", async () => {
    const { org } = await userWithOrg(env.pool, "alice");
    const dev = await addDevice(env.pool, org.id, "ROOM-1");
    const body = { readings: [{ m: { temperature: 1 } }] };
    expect((await post(`${env.url}/v1/ingest`, body)).status).toBe(401);
    expect((await post(`${env.url}/v1/ingest`, body, "Device NOPE:x")).status).toBe(401);
    expect((await post(`${env.url}/v1/ingest`, body, `Device ${dev.code}:wrong`)).status).toBe(401);
  });

  it("returns 400 (not 500) for malformed payloads", async () => {
    const { org } = await userWithOrg(env.pool, "alice");
    const dev = await addDevice(env.pool, org.id, "ROOM-1");
    expect((await post(`${env.url}/v1/ingest`, { readings: [{ m: { "Bad Key": 1 } }] }, dev.auth)).status).toBe(400);
    expect((await post(`${env.url}/v1/ingest`, "{not json", dev.auth)).status).toBe(400);
  });

  it("survives many concurrent devices with a tiny pool (audit 3.1 deadlock regression)", async () => {
    const small = await startTestServer({ poolMax: 2 });
    try {
      const { org } = await userWithOrg(small.pool, "bob");
      const devices = await Promise.all(Array.from({ length: 6 }, (_, i) => addDevice(small.pool, org.id, `CC-${i}`)));
      const started = Date.now();
      const results = await Promise.all(
        Array.from({ length: 40 }, (_, i) =>
          post(`${small.url}/v1/ingest`, { readings: [{ t: Date.now() - i, m: { temperature: i } }] }, devices[i % 6]!.auth),
        ),
      );
      expect(results.every((r) => r.status === 200)).toBe(true);
      expect(Date.now() - started).toBeLessThan(5000);
    } finally {
      await small.close();
    }
  });
});

describe("user API and permissions", () => {
  it("creates a personal organization with owner role on first sign-in", async () => {
    const me = await get(`${env.url}/v1/me`, "Bearer dev:carol");
    expect(me.status).toBe(200);
    expect(me.body.organizations).toHaveLength(1);
    expect(me.body.organizations[0]).toMatchObject({ personal: true, role: "owner" });
    // second call does not create another org
    const again = await get(`${env.url}/v1/me`, "Bearer dev:carol");
    expect(again.body.organizations).toHaveLength(1);
  });

  it("lists only devices of organizations the user belongs to, with latest values", async () => {
    const a = await userWithOrg(env.pool, "alice");
    const b = await userWithOrg(env.pool, "bob");
    const devA = await addDevice(env.pool, a.org.id, "A-1");
    await addDevice(env.pool, b.org.id, "B-1");
    await post(`${env.url}/v1/ingest`, { readings: [{ m: { temperature: 3.5 } }] }, devA.auth);

    const list = await get(`${env.url}/v1/devices`, `Bearer ${a.token}`);
    expect(list.status).toBe(200);
    expect(list.body.devices.map((d: any) => d.code)).toEqual(["A-1"]);
    expect(list.body.devices[0].latest.temperature.value).toBe(3.5);
  });

  it("shares devices with organization members (old 6.3: members saw nothing live)", async () => {
    const a = await userWithOrg(env.pool, "alice");
    const v = await userWithOrg(env.pool, "victor");
    await env.pool.query("insert into memberships (org_id, user_id, role) values ($1, $2, 'viewer')", [a.org.id, v.user.id]);
    await addDevice(env.pool, a.org.id, "A-1");
    const list = await get(`${env.url}/v1/devices?orgId=${a.org.id}`, `Bearer ${v.token}`);
    expect(list.body.devices.map((d: any) => d.code)).toEqual(["A-1"]);
  });

  it("lets owners create devices, blocks viewers, and the new secret works", async () => {
    const a = await userWithOrg(env.pool, "alice");
    const v = await userWithOrg(env.pool, "victor");
    await env.pool.query("insert into memberships (org_id, user_id, role) values ($1, $2, 'viewer')", [a.org.id, v.user.id]);

    const denied = await post(`${env.url}/v1/devices`, { orgId: a.org.id, name: "X" }, `Bearer ${v.token}`);
    expect(denied.status).toBe(403);

    const created = await post(`${env.url}/v1/devices`, { orgId: a.org.id, name: "ห้องเย็น 2", code: "cold-2" }, `Bearer ${a.token}`);
    expect(created.status).toBe(201);
    expect(created.body.device.code).toBe("COLD-2");
    const ingest = await post(`${env.url}/v1/ingest`, { readings: [{ m: { temperature: 2 } }] }, `Device COLD-2:${created.body.secret}`);
    expect(ingest.status).toBe(200);

    const dup = await post(`${env.url}/v1/devices`, { orgId: a.org.id, name: "dup", code: "COLD-2" }, `Bearer ${a.token}`);
    expect(dup.status).toBe(409);
  });

  it("returns 400 for a malformed org id and 401 without a token", async () => {
    expect((await get(`${env.url}/v1/devices?orgId=12`, "Bearer dev:alice")).status).toBe(400);
    expect((await get(`${env.url}/v1/devices`, "")).status).toBe(401);
  });
});

describe("realtime", () => {
  function connect(token: string) {
    const ws = new WebSocket(env.wsUrl);
    const inbox: ServerMessage[] = [];
    const waiters: { pred: (m: ServerMessage) => boolean; resolve: (m: ServerMessage) => void }[] = [];
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString()) as ServerMessage;
      inbox.push(msg);
      for (const w of [...waiters]) if (w.pred(msg)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(msg); }
    });
    const next = (pred: (m: ServerMessage) => boolean, ms = 3000) =>
      new Promise<ServerMessage>((resolve, reject) => {
        const hit = inbox.find(pred);
        if (hit) return resolve(hit);
        const t = setTimeout(() => reject(new Error("timeout waiting for message")), ms);
        waiters.push({ pred, resolve: (m) => { clearTimeout(t); resolve(m); } });
      });
    const ready = new Promise<void>((r) => ws.on("open", () => { ws.send(JSON.stringify({ type: "auth", token })); r(); }));
    return { ws, next, ready, send: (m: unknown) => ws.send(JSON.stringify(m)) };
  }

  it("pushes values to every member of the device's organization, batched", async () => {
    const a = await userWithOrg(env.pool, "alice");
    const v = await userWithOrg(env.pool, "victor");
    await env.pool.query("insert into memberships (org_id, user_id, role) values ($1, $2, 'viewer')", [a.org.id, v.user.id]);
    const dev = await addDevice(env.pool, a.org.id, "A-1");

    const c = connect(v.token);
    await c.ready;
    await c.next((m) => m.type === "ready");
    c.send({ type: "subscribe", orgId: a.org.id });
    await c.next((m) => m.type === "subscribed");

    const now = Date.now();
    await post(`${env.url}/v1/ingest`, { readings: [{ t: now - 2000, m: { temperature: 1 } }, { t: now - 1000, m: { temperature: 2 } }] }, dev.auth);
    const msg = await c.next((m) => m.type === "values");
    expect(msg).toMatchObject({ type: "values", orgId: a.org.id });
    if (msg.type === "values") expect(msg.values).toEqual([{ deviceId: dev.id, metric: "temperature", time: now - 1000, value: 2 }]);
    c.ws.close();
  });

  it("refuses subscriptions to organizations the user is not in", async () => {
    const a = await userWithOrg(env.pool, "alice");
    await userWithOrg(env.pool, "mallory");
    const c = connect("dev:mallory");
    await c.ready;
    await c.next((m) => m.type === "ready");
    c.send({ type: "subscribe", orgId: a.org.id });
    const err = await c.next((m) => m.type === "error");
    expect(err).toMatchObject({ code: "forbidden" });
    expect(env.hub.stats().subscriptions).toBe(0);
    c.ws.close();
  });

  it("rejects commands before auth", async () => {
    const ws = new WebSocket(env.wsUrl);
    const msg = await new Promise<ServerMessage>((resolve) => {
      ws.on("open", () => ws.send(JSON.stringify({ type: "subscribe", orgId: "00000000-0000-0000-0000-000000000000" })));
      ws.on("message", (raw) => resolve(JSON.parse(raw.toString())));
    });
    expect(msg).toMatchObject({ type: "error", code: "unauthorized" });
    ws.close();
  });
});
