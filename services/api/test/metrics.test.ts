import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildMessage } from "../src/notify/messages";
import { addDevice, get, resetDatabase, startTestServer, userWithOrg, type TestEnv } from "./helpers";

let env: TestEnv;
beforeAll(async () => {
  await resetDatabase();
  env = await startTestServer();
});
afterAll(async () => env.close());
beforeEach(async () => {
  await env.pool.query("truncate metric_settings, readings, latest, devices, memberships, organizations, users cascade");
});

const put = async (url: string, body: unknown, authorization: string) => {
  const res = await fetch(url, { method: "PUT", headers: { "content-type": "application/json", authorization }, body: JSON.stringify(body) });
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
};

describe("metric names and units", () => {
  it("saves per-device names, units, order and visibility; admins only", async () => {
    const owner = await userWithOrg(env.pool, "olivia");
    const auth = `Bearer ${owner.token}`;
    const dev = await addDevice(env.pool, owner.org.id, "CH-20");
    const body = { metrics: [
      { metric: "ch_1", label: "ช่อง 1 ห้องแช่แข็ง", unit: "°C", decimals: 1, sortOrder: 0 },
      { metric: "rssi", label: "สัญญาณ", unit: "dBm", decimals: 0, sortOrder: 9, hidden: true },
    ] };
    const saved = await put(`${env.url}/v1/devices/${dev.id}/metrics`, body, auth);
    expect(saved.status).toBe(200);
    expect(saved.body.device.metrics.ch_1).toEqual({ label: "ช่อง 1 ห้องแช่แข็ง", unit: "°C", decimals: 1, sortOrder: 0, hidden: false });
    const listed = await get(`${env.url}/v1/devices?orgId=${owner.org.id}`, auth);
    expect(listed.body.devices[0].metrics.rssi.hidden).toBe(true);

    const viewer = await userWithOrg(env.pool, "vera");
    await env.pool.query("insert into memberships (org_id, user_id, role) values ($1, $2, 'viewer')", [owner.org.id, viewer.user.id]);
    expect((await put(`${env.url}/v1/devices/${dev.id}/metrics`, body, `Bearer ${viewer.token}`)).status).toBe(403);
    expect((await put(`${env.url}/v1/devices/${dev.id}/metrics`, { metrics: [{ metric: "Bad Key", label: "x", decimals: 1, sortOrder: 0 }] }, auth)).status).toBe(400);
  });

  it("uses the device's own name and unit in notifications", () => {
    const m = buildMessage({
      reason: "opened", reminderNo: null, maxReminders: 3, deviceName: "ตู้ 20 ช่อง", orgName: "x", appUrl: "https://x", timeZone: "Asia/Bangkok",
      metricSetting: { label: "ช่อง 3", unit: "bar", decimals: 2, sortOrder: 0, hidden: false },
      event: { id: "e", kind: "threshold", orgId: "o", deviceId: "d", ruleId: null, metric: "ch_3", severity: "warning", min: null, max: 4,
        startedAt: 0, startValue: 4.5, endedAt: null, endValue: null, acknowledgedAt: null, acknowledgedBy: null },
    });
    expect(m.text).toContain("ช่อง 3 สูงกว่า 4.00 bar (ค่า 4.50 bar)");
  });
});
