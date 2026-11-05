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

async function put(url: string, body: unknown, authorization: string) {
  const res = await fetch(url, { method: "PUT", headers: { "content-type": "application/json", authorization }, body: JSON.stringify(body) });
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
}

const coldRoom = { metric: "temperature", severity: "warning", min: 2, max: 8, hysteresis: 0.5 };

async function setup() {
  const owner = await userWithOrg(env.pool, "olivia");
  const dev = await addDevice(env.pool, owner.org.id, "COLD-1");
  return { owner, dev, auth: `Bearer ${owner.token}` };
}

const send = (dev: { auth: string }, t: number, temperature: number) =>
  post(`${env.url}/v1/ingest`, { readings: [{ t, m: { temperature } }] }, dev.auth);

describe("alarm rules API", () => {
  it("saves, lists and replaces a device's rules", async () => {
    const { dev, auth } = await setup();
    const saved = await put(`${env.url}/v1/devices/${dev.id}/alarm-rules`, { rules: [coldRoom, { metric: "temperature", severity: "critical", max: 12 }] }, auth);
    expect(saved.status).toBe(200);
    expect(saved.body.rules).toHaveLength(2);
    expect(saved.body.rules[1]).toMatchObject({ metric: "temperature", severity: "warning", min: 2, max: 8, delaySec: 0, hysteresis: 0.5, phase: "normal" });

    const replaced = await put(`${env.url}/v1/devices/${dev.id}/alarm-rules`, { rules: [coldRoom] }, auth);
    expect(replaced.body.rules).toHaveLength(1);
    const listed = await get(`${env.url}/v1/devices/${dev.id}/alarm-rules`, auth);
    expect(listed.body.rules).toHaveLength(1);
  });

  it("rejects invalid rules with 400", async () => {
    const { dev, auth } = await setup();
    const res = await put(`${env.url}/v1/devices/${dev.id}/alarm-rules`, { rules: [{ metric: "temperature", severity: "warning", min: 8, max: 2 }] }, auth);
    expect(res.status).toBe(400);
  });

  it("lets viewers read but not edit, and hides other organizations' devices", async () => {
    const { owner, dev } = await setup();
    const viewer = await userWithOrg(env.pool, "victor");
    await env.pool.query("insert into memberships (org_id, user_id, role) values ($1, $2, 'viewer')", [owner.org.id, viewer.user.id]);
    expect((await get(`${env.url}/v1/devices/${dev.id}/alarm-rules`, `Bearer ${viewer.token}`)).status).toBe(200);
    expect((await put(`${env.url}/v1/devices/${dev.id}/alarm-rules`, { rules: [coldRoom] }, `Bearer ${viewer.token}`)).status).toBe(403);

    const stranger = await userWithOrg(env.pool, "sam");
    expect((await get(`${env.url}/v1/devices/${dev.id}/alarm-rules`, `Bearer ${stranger.token}`)).status).toBe(404);
  });
});

describe("alarm evaluation on ingest", () => {
  it("opens on a reading outside the range and closes after hysteresis", async () => {
    const { dev, auth } = await setup();
    await put(`${env.url}/v1/devices/${dev.id}/alarm-rules`, { rules: [coldRoom] }, auth);
    const t = Date.now() - 60_000;

    await send(dev, t, 5);
    await send(dev, t + 10_000, 9.2);
    let open = await get(`${env.url}/v1/alarms?state=open`, auth);
    expect(open.body.events).toHaveLength(1);
    expect(open.body.events[0]).toMatchObject({ metric: "temperature", severity: "warning", startValue: 9.2, startedAt: t + 10_000, endedAt: null });

    await send(dev, t + 20_000, 7.8); // inside, but not past hysteresis
    open = await get(`${env.url}/v1/alarms?state=open`, auth);
    expect(open.body.events).toHaveLength(1);

    await send(dev, t + 30_000, 7.2);
    open = await get(`${env.url}/v1/alarms?state=open`, auth);
    expect(open.body.events).toHaveLength(0);
    const all = await get(`${env.url}/v1/alarms?state=all`, auth);
    expect(all.body.events[0]).toMatchObject({ endedAt: t + 30_000, endValue: 7.2 });
  });

  it("waits for the delay before opening", async () => {
    const { dev, auth } = await setup();
    await put(`${env.url}/v1/devices/${dev.id}/alarm-rules`, { rules: [{ ...coldRoom, delaySec: 60 }] }, auth);
    const t = Date.now() - 120_000;
    await send(dev, t, 9);
    await send(dev, t + 30_000, 9);
    expect((await get(`${env.url}/v1/alarms`, auth)).body.events).toHaveLength(0);
    await send(dev, t + 65_000, 9);
    const events = (await get(`${env.url}/v1/alarms`, auth)).body.events;
    expect(events).toHaveLength(1);
    expect(events[0].startedAt).toBe(t);
  });

  it("ignores an old queued reading that arrives after a newer one", async () => {
    const { dev, auth } = await setup();
    await put(`${env.url}/v1/devices/${dev.id}/alarm-rules`, { rules: [coldRoom] }, auth);
    const t = Date.now() - 60_000;
    await send(dev, t + 10_000, 5);
    await send(dev, t, 20); // older than latest: stored, but not evaluated
    expect((await get(`${env.url}/v1/alarms`, auth)).body.events).toHaveLength(0);
  });

  it("closes the open event when the rule changes", async () => {
    const { dev, auth } = await setup();
    await put(`${env.url}/v1/devices/${dev.id}/alarm-rules`, { rules: [coldRoom] }, auth);
    await send(dev, Date.now() - 5_000, 9.5);
    expect((await get(`${env.url}/v1/alarms`, auth)).body.events).toHaveLength(1);
    await put(`${env.url}/v1/devices/${dev.id}/alarm-rules`, { rules: [{ ...coldRoom, max: 10 }] }, auth);
    expect((await get(`${env.url}/v1/alarms`, auth)).body.events).toHaveLength(0);
  });

  it("pushes alarm events to subscribers right away", async () => {
    const { owner, dev, auth } = await setup();
    await put(`${env.url}/v1/devices/${dev.id}/alarm-rules`, { rules: [coldRoom] }, auth);
    const ws = new WebSocket(env.wsUrl);
    const messages: ServerMessage[] = [];
    ws.on("message", (raw) => messages.push(JSON.parse(raw.toString())));
    await new Promise((r) => ws.once("open", r));
    ws.send(JSON.stringify({ type: "auth", token: owner.token }));
    await new Promise((r) => setTimeout(r, 100));
    ws.send(JSON.stringify({ type: "subscribe", orgId: owner.org.id }));
    await new Promise((r) => setTimeout(r, 100));

    await send(dev, Date.now() - 1_000, 11);
    await new Promise((r) => setTimeout(r, 100));
    ws.close();
    const alarm = messages.find((m) => m.type === "alarm");
    expect(alarm).toMatchObject({ type: "alarm", orgId: owner.org.id, event: { severity: "warning", startValue: 11 } });
  });
});

describe("acknowledging alarms", () => {
  it("records who acknowledged, once, and blocks viewers", async () => {
    const { owner, dev, auth } = await setup();
    await put(`${env.url}/v1/devices/${dev.id}/alarm-rules`, { rules: [coldRoom] }, auth);
    await send(dev, Date.now() - 1_000, 12);
    const [event] = (await get(`${env.url}/v1/alarms`, auth)).body.events;

    const viewer = await userWithOrg(env.pool, "vera");
    await env.pool.query("insert into memberships (org_id, user_id, role) values ($1, $2, 'viewer')", [owner.org.id, viewer.user.id]);
    expect((await post(`${env.url}/v1/alarms/${event.id}/ack`, {}, `Bearer ${viewer.token}`)).status).toBe(403);

    const acked = await post(`${env.url}/v1/alarms/${event.id}/ack`, {}, auth);
    expect(acked.status).toBe(200);
    expect(acked.body.event.acknowledgedBy).toBe(owner.user.id);
    const again = await post(`${env.url}/v1/alarms/${event.id}/ack`, {}, auth);
    expect(again.body.event.acknowledgedAt).toBe(acked.body.event.acknowledgedAt);

    const stranger = await userWithOrg(env.pool, "stan");
    expect((await post(`${env.url}/v1/alarms/${event.id}/ack`, {}, `Bearer ${stranger.token}`)).status).toBe(404);
  });
});
