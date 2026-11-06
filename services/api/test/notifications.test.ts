import { createHmac } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { checkOffline } from "../src/alarms/offline";
import { backoffMs, deliver, enqueue, MAX_ATTEMPTS, type NotifierDeps } from "../src/notify/dispatcher";
import { SendError, type Channel } from "../src/notify/channels";
import { buildMessage } from "../src/notify/messages";
import type { Message } from "../src/notify/messages";
import { addDevice, get, LINE_SECRET, post, resetDatabase, startTestServer, userWithOrg, type TestEnv } from "./helpers";

let env: TestEnv;

beforeAll(async () => {
  await resetDatabase();
  env = await startTestServer();
});
afterAll(async () => env.close());
beforeEach(async () => {
  await env.pool.query("truncate notification_jobs, notification_targets, readings, latest, alarm_events, alarm_rules, devices, memberships, organizations, users cascade");
});

async function call(method: string, url: string, authorization: string, body?: unknown) {
  const res = await fetch(url, { method, headers: { "content-type": "application/json", authorization }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
}

/** A channel that records what it was asked to send and can be told to fail. */
function fakeChannel(configured = true) {
  const sent: { to: string; message: Message; key: string }[] = [];
  const ch: Channel & { sent: typeof sent; fail: SendError | null } = {
    configured,
    sent,
    fail: null,
    async send(to, message, key) {
      if (ch.fail) throw ch.fail;
      sent.push({ to, message, key });
    },
  };
  return ch;
}

function deps(line = fakeChannel(), email = fakeChannel()): NotifierDeps & { line: ReturnType<typeof fakeChannel>; email: ReturnType<typeof fakeChannel> } {
  return { pool: env.pool, channels: { line, email }, appUrl: "https://app.test", timeZone: "Asia/Bangkok", line, email };
}

async function setup() {
  const owner = await userWithOrg(env.pool, "olivia");
  const auth = `Bearer ${owner.token}`;
  const dev = await addDevice(env.pool, owner.org.id, "COLD-1");
  await call("PUT", `${env.url}/v1/devices/${dev.id}/alarm-rules`, auth, {
    rules: [
      { metric: "temperature", severity: "warning", max: 8 },
      { metric: "temperature", severity: "critical", max: 12 },
    ],
  });
  const line = await post(`${env.url}/v1/orgs/${owner.org.id}/notification-targets`, { kind: "line", name: "กลุ่มช่าง", address: `C${"a".repeat(32)}` }, auth);
  const mail = await post(`${env.url}/v1/orgs/${owner.org.id}/notification-targets`, { kind: "email", name: "หัวหน้า", address: "Boss@Example.com", minSeverity: "critical" }, auth);
  return { owner, auth, dev, lineId: line.body.target.id as string, mailId: mail.body.target.id as string };
}

const reading = (dev: { auth: string }, temperature: number, t = Date.now()) =>
  post(`${env.url}/v1/ingest`, { readings: [{ t, m: { temperature } }] }, dev.auth);

describe("recipients API", () => {
  it("lets admins manage recipients and keeps everyone else out", async () => {
    const { owner, auth, mailId } = await setup();
    const listed = await get(`${env.url}/v1/orgs/${owner.org.id}/notifications`, auth);
    expect(listed.body.settings).toEqual({ repeatMinutes: 30, maxReminders: 3 });
    expect(listed.body.targets.map((t: any) => t.address)).toEqual([`C${"a".repeat(32)}`, "boss@example.com"]);
    expect(listed.body.channels).toEqual({ line: true, lineWebhook: true, email: false });

    const member = await userWithOrg(env.pool, "mike");
    await env.pool.query("insert into memberships (org_id, user_id, role) values ($1, $2, 'member')", [owner.org.id, member.user.id]);
    expect((await get(`${env.url}/v1/orgs/${owner.org.id}/notifications`, `Bearer ${member.token}`)).status).toBe(403);
    expect((await call("DELETE", `${env.url}/v1/notification-targets/${mailId}`, `Bearer ${member.token}`)).status).toBe(403);
    const outsider = await userWithOrg(env.pool, "otto");
    expect((await get(`${env.url}/v1/orgs/${owner.org.id}/notifications`, `Bearer ${outsider.token}`)).status).toBe(404);

    expect((await post(`${env.url}/v1/orgs/${owner.org.id}/notification-targets`, { kind: "email", name: "x", address: "boss@example.com" }, auth)).status).toBe(409);
    expect((await post(`${env.url}/v1/orgs/${owner.org.id}/notification-targets`, { kind: "email", name: "x", address: "nope" }, auth)).status).toBe(400);
    expect((await call("PATCH", `${env.url}/v1/notification-targets/${mailId}`, auth, { enabled: false })).body.target.enabled).toBe(false);
    expect((await call("PUT", `${env.url}/v1/orgs/${owner.org.id}/notifications/settings`, auth, { repeatMinutes: null, maxReminders: 2 })).status).toBe(200);
    expect((await call("DELETE", `${env.url}/v1/notification-targets/${mailId}`, auth)).status).toBe(204);
  });
});

describe("delivery", () => {
  it("sends opened and closed alarms to the right recipients by severity", async () => {
    const { dev } = await setup();
    const d = deps();
    await reading(dev, 9); // warning only
    expect(await enqueue(env.pool, Date.now())).toBe(1);
    expect(await enqueue(env.pool, Date.now())).toBe(0); // idempotent
    await deliver(d, Date.now());
    expect(d.line.sent).toHaveLength(1);
    expect(d.line.sent[0]!.message.text).toContain("🟠 เตือน: COLD-1");
    expect(d.line.sent[0]!.message.text).toContain("https://app.test/#/devices/");
    expect(d.email.sent).toHaveLength(0); // email recipient wants critical only

    await reading(dev, 13); // critical too
    await enqueue(env.pool, Date.now());
    await deliver(d, Date.now());
    expect(d.line.sent).toHaveLength(2);
    expect(d.email.sent).toHaveLength(1);
    expect(d.email.sent[0]!.to).toBe("boss@example.com");

    await reading(dev, 4); // both close
    await enqueue(env.pool, Date.now());
    await deliver(d, Date.now());
    expect(d.line.sent.slice(2).map((s) => s.message.text.split("\n")[1])).toEqual(["กลับสู่ปกติ (อุณหภูมิ 4.0 °C)", "กลับสู่ปกติ (อุณหภูมิ 4.0 °C)"]);
    expect(d.email.sent).toHaveLength(2);
  });

  it("reminds until acknowledged, up to the ceiling", async () => {
    const { owner, auth, dev } = await setup();
    await call("PUT", `${env.url}/v1/orgs/${owner.org.id}/notifications/settings`, auth, { repeatMinutes: 10, maxReminders: 2 });
    const d = deps();
    await reading(dev, 9);
    const t0 = Date.now();
    await enqueue(env.pool, t0);
    expect(await enqueue(env.pool, t0 + 5 * 60_000)).toBe(0); // too early
    expect(await enqueue(env.pool, t0 + 11 * 60_000)).toBe(1);
    expect(await enqueue(env.pool, t0 + 22 * 60_000)).toBe(1);
    expect(await enqueue(env.pool, t0 + 60 * 60_000)).toBe(0); // ceiling reached
    await deliver(d, t0 + 61 * 60_000);
    expect(d.line.sent.map((s) => s.message.text.split("\n")[0])).toEqual([
      "🟠 เตือน: COLD-1",
      "⏰ ยังไม่มีผู้รับทราบ (เตือนซ้ำครั้งที่ 1/2)",
      "⏰ ยังไม่มีผู้รับทราบ (เตือนซ้ำครั้งที่ 2/2)",
    ]);

    // a new alarm, acknowledged: no reminders
    await reading(dev, 4);
    await reading(dev, 9.5);
    const t1 = Date.now();
    await enqueue(env.pool, t1);
    const open = await get(`${env.url}/v1/alarms?orgId=${owner.org.id}`, auth);
    await post(`${env.url}/v1/alarms/${open.body.events[0].id}/ack`, {}, auth);
    expect(await enqueue(env.pool, t1 + 60 * 60_000)).toBe(0);
  });

  it("retries temporary errors with backoff and gives up on permanent ones", async () => {
    const { dev } = await setup();
    const d = deps();
    await reading(dev, 9);
    await enqueue(env.pool, Date.now());
    const t0 = Date.now();
    d.line.fail = new SendError("HTTP 500", false);
    await deliver(d, t0);
    let job = (await env.pool.query("select status, attempts, next_attempt_at from notification_jobs")).rows[0];
    expect(job).toMatchObject({ status: "pending", attempts: 1 });
    expect(job.next_attempt_at.getTime()).toBe(t0 + backoffMs(1));
    await deliver(d, t0 + 1000); // not due yet
    expect((await env.pool.query("select attempts from notification_jobs")).rows[0].attempts).toBe(1);

    d.line.fail = null;
    await deliver(d, t0 + backoffMs(1));
    job = (await env.pool.query("select status, attempts, retry_key from notification_jobs")).rows[0];
    expect(job).toMatchObject({ status: "sent", attempts: 2 });
    expect(d.line.sent[0]!.key).toBe(job.retry_key);

    await reading(dev, 4);
    await enqueue(env.pool, Date.now());
    d.line.fail = new SendError("HTTP 400 invalid to", true);
    await deliver(d, Date.now());
    const failed = (await env.pool.query("select status from notification_jobs where reason = 'closed'")).rows[0];
    expect(failed.status).toBe("failed");
    const target = (await env.pool.query("select last_error from notification_targets where kind = 'line'")).rows[0];
    expect(target.last_error).toContain("HTTP 400");
    expect(MAX_ATTEMPTS).toBe(5);
  });

  it("dry-runs channels without credentials and sends test messages", async () => {
    const { auth, lineId } = await setup();
    const d = deps(fakeChannel(false));
    expect((await post(`${env.url}/v1/notification-targets/${lineId}/test`, {}, auth)).status).toBe(202);
    await deliver(d, Date.now());
    expect(d.line.sent).toHaveLength(0);
    const job = (await env.pool.query("select status from notification_jobs")).rows[0];
    expect(job.status).toBe("dry_run");
  });

  it("notifies offline alarms", async () => {
    const { dev } = await setup();
    await env.pool.query("update devices set last_seen_at = now() - interval '1 hour' where id = $1", [dev.id]);
    await checkOffline(env.pool, Date.now());
    const d = deps();
    await enqueue(env.pool, Date.now());
    await deliver(d, Date.now());
    expect(d.line.sent[0]!.message.text).toContain("ขาดการติดต่อ");
    expect(d.email.sent[0]!.message.subject).toContain("🔴 วิกฤต");
  });

  it("does not resend alarms that existed before the upgrade", async () => {
    // events inserted with notified flags = true behave like pre-migration rows
    const { dev, owner } = await setup();
    await env.pool.query(
      `insert into alarm_events (org_id, device_id, metric_key, severity, started_at, start_value, notified_open, notified_close)
       values ($1, $2, 'temperature', 'critical', now(), 20, true, true)`,
      [owner.org.id, dev.id],
    );
    expect(await enqueue(env.pool, Date.now())).toBe(0);
  });
});

describe("LINE linking", () => {
  const sign = (body: string) => createHmac("sha256", LINE_SECRET).update(body).digest("base64");
  const webhook = (body: string, signature = sign(body)) =>
    fetch(`${env.url}/v1/line/webhook`, { method: "POST", headers: { "content-type": "application/json", "x-line-signature": signature }, body });

  it("links a recipient when its code is sent in a group, and rejects bad signatures", async () => {
    const { owner, auth } = await setup();
    const created = await post(`${env.url}/v1/orgs/${owner.org.id}/notification-targets`, { kind: "line", name: "ห้องควบคุม" }, auth);
    const code = created.body.target.linkCode as string;
    expect(code).toMatch(/^[A-HJ-NP-Z2-9]{6}$/);
    const groupId = `C${"b".repeat(32)}`;
    const body = JSON.stringify({ events: [{ type: "message", replyToken: "r", source: { type: "group", groupId, userId: `U${"c".repeat(32)}` }, message: { type: "text", text: `รหัส ${code.toLowerCase()}` } }] });

    expect((await webhook(body, sign("tampered"))).status).toBe(401);
    expect((await webhook(body)).status).toBe(200);
    await new Promise((r) => setTimeout(r, 100));
    const t = (await get(`${env.url}/v1/orgs/${owner.org.id}/notifications`, auth)).body.targets.find((x: any) => x.id === created.body.target.id);
    expect(t).toMatchObject({ address: groupId, linkCode: null });

    // the code is single use
    await env.pool.query("update notification_targets set address = null where id = $1", [created.body.target.id]);
    await webhook(body);
    await new Promise((r) => setTimeout(r, 100));
    expect((await env.pool.query("select address from notification_targets where id = $1", [created.body.target.id])).rows[0].address).toBeNull();
  });
});

describe("messages", () => {
  it("reads naturally in Thai", () => {
    const base = {
      id: "e", kind: "threshold" as const, orgId: "o", deviceId: "d", ruleId: "r", metric: "temperature", severity: "critical" as const,
      min: 2, max: 8, startedAt: Date.UTC(2026, 10, 6, 7, 5), startValue: 9.24, endedAt: null, endValue: null, acknowledgedAt: null, acknowledgedBy: null,
    };
    const m = buildMessage({ reason: "opened", reminderNo: null, maxReminders: 3, event: base, deviceName: "ห้องเย็น 1", orgName: "ร้าน", appUrl: "https://x", timeZone: "Asia/Bangkok" });
    expect(m.text).toBe("🔴 วิกฤต: ห้องเย็น 1\nอุณหภูมิ สูงกว่า 8.0 °C (ค่า 9.2 °C)\nเริ่ม 6 พ.ย. 14:05\nกดรับทราบ: https://x/#/devices/d");
    const closed = buildMessage({ reason: "closed", reminderNo: null, maxReminders: 3, event: { ...base, endedAt: base.startedAt + 25 * 60_000, endValue: 7.1 }, deviceName: "ห้องเย็น 1", orgName: "ร้าน", appUrl: "https://x", timeZone: "Asia/Bangkok" });
    expect(closed.text).toContain("นาน 25 นาที");
  });
});
