import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { checkOffline } from "../src/alarms/offline";
import { addDevice, get, post, resetDatabase, startTestServer, userWithOrg, type TestEnv } from "./helpers";

let env: TestEnv;

beforeAll(async () => {
  await resetDatabase();
  env = await startTestServer();
});
afterAll(async () => env.close());
beforeEach(async () => {
  await env.pool.query("truncate readings, latest, alarm_events, alarm_rules, devices, memberships, organizations, users cascade");
});

async function call(method: string, url: string, authorization: string, body?: unknown) {
  const res = await fetch(url, {
    method,
    headers: { "content-type": "application/json", authorization },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
}

async function joinAs(orgId: string, uid: string, role: string) {
  const u = await userWithOrg(env.pool, uid);
  await env.pool.query("insert into memberships (org_id, user_id, role) values ($1, $2, $3)", [orgId, u.user.id, role]);
  return `Bearer ${u.token}`;
}

describe("device management", () => {
  it("creates, renames, resets the secret and soft-deletes a device", async () => {
    const owner = await userWithOrg(env.pool, "olivia");
    const auth = `Bearer ${owner.token}`;
    const created = await post(`${env.url}/v1/devices`, { orgId: owner.org.id, name: "ห้องเย็น 2", code: "cold-2" }, auth);
    expect(created.status).toBe(201);
    expect(created.body.device).toMatchObject({ code: "COLD-2", name: "ห้องเย็น 2", offlineAfterSec: 900 });
    const id = created.body.device.id;
    const oldAuth = `Device COLD-2:${created.body.secret}`;
    expect((await post(`${env.url}/v1/ingest`, { readings: [{ m: { temperature: 4 } }] }, oldAuth)).status).toBe(200);

    const renamed = await call("PATCH", `${env.url}/v1/devices/${id}`, auth, { name: "ห้องเย็น B", offlineAfterSec: null });
    expect(renamed.body.device).toMatchObject({ name: "ห้องเย็น B", offlineAfterSec: null });

    const reset = await post(`${env.url}/v1/devices/${id}/reset-secret`, {}, auth);
    expect(reset.status).toBe(200);
    expect((await post(`${env.url}/v1/ingest`, { readings: [{ m: { temperature: 4 } }] }, oldAuth)).status).toBe(401);
    expect((await post(`${env.url}/v1/ingest`, { readings: [{ m: { temperature: 4 } }] }, `Device COLD-2:${reset.body.secret}`)).status).toBe(200);

    expect((await call("DELETE", `${env.url}/v1/devices/${id}`, auth)).status).toBe(204);
    expect((await get(`${env.url}/v1/devices?orgId=${owner.org.id}`, auth)).body.devices).toEqual([]);
    expect((await get(`${env.url}/v1/devices/${id}`, auth)).status).toBe(404);
    expect((await post(`${env.url}/v1/ingest`, { readings: [{ m: { temperature: 4 } }] }, `Device COLD-2:${reset.body.secret}`)).status).toBe(401);
  });

  it("checks roles: member edits offline alarm only, viewer nothing, outsiders see 404", async () => {
    const owner = await userWithOrg(env.pool, "olivia");
    const dev = await addDevice(env.pool, owner.org.id, "ROLE-1");
    const member = await joinAs(owner.org.id, "mike", "member");
    const viewer = await joinAs(owner.org.id, "vera", "viewer");
    const outsider = `Bearer ${(await userWithOrg(env.pool, "otto")).token}`;
    const url = `${env.url}/v1/devices/${dev.id}`;

    expect((await call("PATCH", url, member, { offlineAfterSec: 600 })).status).toBe(200);
    expect((await call("PATCH", url, member, { name: "x" })).status).toBe(403);
    expect((await call("PATCH", url, viewer, { offlineAfterSec: 600 })).status).toBe(403);
    expect((await call("DELETE", url, member)).status).toBe(403);
    expect((await post(`${url}/reset-secret`, {}, member)).status).toBe(403);
    expect((await get(url, viewer)).status).toBe(200);
    expect((await get(url, outsider)).status).toBe(404);
    expect((await call("DELETE", url, outsider)).status).toBe(404);
  });
});

describe("history", () => {
  it("returns every requested metric bucketed, newest data included, in one request", async () => {
    const owner = await userWithOrg(env.pool, "olivia");
    const dev = await addDevice(env.pool, owner.org.id, "HIST-1");
    const t0 = Date.UTC(2026, 10, 6, 0, 0, 0);
    // 6 hours of readings every 5 minutes, plus one older stray reading outside the range
    const values: string[] = [];
    for (let i = 0; i < 72; i++) {
      const t = new Date(t0 + i * 5 * 60_000).toISOString();
      values.push(`('${dev.id}', 'temperature', '${t}', ${4 + (i % 3)}, false)`, `('${dev.id}', 'humidity', '${t}', 60, ${i === 71})`);
    }
    values.push(`('${dev.id}', 'temperature', '${new Date(t0 - 86_400_000).toISOString()}', 99, false)`);
    await env.pool.query(`insert into readings (device_id, metric_key, time, value, backfilled) values ${values.join(",")}`);

    const auth = `Bearer ${owner.token}`;
    const res = await get(`${env.url}/v1/devices/${dev.id}/history?metrics=temperature,humidity,pressure&from=${t0}&to=${t0 + 6 * 3_600_000}`, auth);
    expect(res.status).toBe(200);
    expect(res.body.bucketMs).toBe(60_000);
    expect(res.body.series.temperature).toHaveLength(72);
    expect(res.body.series.pressure).toEqual([]);
    expect(res.body.series.temperature[0]).toEqual({ t: t0, avg: 4, min: 4, max: 4, n: 1, backfilled: false });
    expect(res.body.series.humidity.at(-1)).toMatchObject({ t: t0 + 71 * 5 * 60_000, backfilled: true });
    expect(Math.max(...res.body.series.temperature.map((p: any) => p.max))).toBe(6);

    const week = await get(`${env.url}/v1/devices/${dev.id}/history?metrics=temperature&from=${t0 - 6 * 86_400_000}&to=${t0 + 86_400_000}`, auth);
    expect(week.body.bucketMs).toBe(3_600_000);
    expect(week.body.series.temperature[0]).toMatchObject({ avg: 99, n: 1 });
    expect(week.body.series.temperature.slice(1).reduce((s: number, p: any) => s + p.n, 0)).toBe(72);

    expect((await get(`${env.url}/v1/devices/${dev.id}/history?metrics=temperature&from=10&to=5`, auth)).status).toBe(400);
  });
});

describe("offline alarms", () => {
  it("opens once when a device goes silent and closes when it reports again", async () => {
    const owner = await userWithOrg(env.pool, "olivia");
    const dev = await addDevice(env.pool, owner.org.id, "OFF-1");
    const never = await addDevice(env.pool, owner.org.id, "OFF-NEVER");
    const quiet = await addDevice(env.pool, owner.org.id, "OFF-DISABLED");
    const now = Date.now();
    const old = new Date(now - 20 * 60_000);
    await env.pool.query("update devices set last_seen_at = $2 where id = any($1)", [[dev.id, quiet.id], old]);
    await env.pool.query("update devices set offline_after_sec = null where id = $1", [quiet.id]);

    const first = await checkOffline(env.pool, now);
    expect(first.opened.map((e) => e.deviceId)).toEqual([dev.id]);
    expect(first.opened[0]).toMatchObject({ kind: "offline", severity: "critical", startValue: null, startedAt: old.getTime() });
    expect((await checkOffline(env.pool, now + 30_000)).opened).toEqual([]);
    expect(never.id).toBeTruthy();

    const auth = `Bearer ${owner.token}`;
    const open = await get(`${env.url}/v1/alarms?orgId=${owner.org.id}`, auth);
    expect(open.body.events).toHaveLength(1);

    // reporting again closes it right away, without waiting for the next check
    expect((await post(`${env.url}/v1/ingest`, { readings: [{ m: { temperature: 4 } }] }, dev.auth)).status).toBe(200);
    expect((await get(`${env.url}/v1/alarms?orgId=${owner.org.id}`, auth)).body.events).toEqual([]);
    const all = await get(`${env.url}/v1/alarms?orgId=${owner.org.id}&state=all`, auth);
    expect(all.body.events[0].endedAt).toBeGreaterThan(old.getTime());
  });

  it("closes the alarm when the offline check is turned off or the device is deleted", async () => {
    const owner = await userWithOrg(env.pool, "olivia");
    const a = await addDevice(env.pool, owner.org.id, "OFF-A");
    const b = await addDevice(env.pool, owner.org.id, "OFF-B");
    const now = Date.now();
    await env.pool.query("update devices set last_seen_at = $2 where id = any($1)", [[a.id, b.id], new Date(now - 3_600_000)]);
    expect((await checkOffline(env.pool, now)).opened).toHaveLength(2);

    const auth = `Bearer ${owner.token}`;
    await call("PATCH", `${env.url}/v1/devices/${a.id}`, auth, { offlineAfterSec: null });
    expect((await checkOffline(env.pool, now + 1000)).closed.map((e) => e.deviceId)).toEqual([a.id]);
    await call("DELETE", `${env.url}/v1/devices/${b.id}`, auth);
    expect((await get(`${env.url}/v1/alarms?orgId=${owner.org.id}`, auth)).body.events).toEqual([]);
  });
});
