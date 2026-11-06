import { createCipheriv, randomBytes } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runImport, type ImportOptions } from "../src/legacy/import";
import { mergeRules, normalizeMetricKey } from "../src/legacy/keys";
import { verifyDeviceSecret } from "../src/auth/deviceSecret";
import { PEPPER, resetDatabase, startTestServer, type TestEnv } from "./helpers";

/** A small copy of the old system's schema (only the columns the import reads) with known data. */
const KEY = randomBytes(32);
const encrypt = (secret: string) => {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", KEY, iv);
  const data = Buffer.concat([c.update(secret, "utf8"), c.final()]);
  return ["v1", iv.toString("base64"), c.getAuthTag().toString("base64"), data.toString("base64")].join(":");
};

const LEGACY_SCHEMA = `
create table users (id bigserial primary key, firebase_uid text unique not null, email text, display_name text);
create table organizations (id bigserial primary key, name text not null, owner_user_id bigint references users(id), is_active boolean not null default true);
create table organization_members (id bigserial primary key, organization_id bigint not null references organizations(id), user_id bigint not null references users(id), role text not null, is_active boolean not null default true);
create table devices (id bigserial primary key, user_id bigint not null references users(id), organization_id bigint references organizations(id),
  device_code text unique not null, name text not null, secret_hash text not null, secret_encrypted text, firmware_version text,
  is_active boolean not null default true, last_seen_at timestamptz, created_at timestamptz not null default now());
create table sensor_readings (time timestamptz not null, device_id bigint not null references devices(id), temperature double precision not null, humidity double precision not null);
create table device_metric_readings (time timestamptz not null, device_id bigint not null references devices(id), metric_key text not null, value double precision not null);
create table device_metrics (id bigserial primary key, device_id bigint not null references devices(id), metric_key text not null, metric_name text not null,
  unit text default '', visible boolean not null default true, sort_order integer default 0, decimal_places smallint not null default 2);
create table alarm_rules (id bigserial primary key, user_id bigint not null references users(id), device_id bigint references devices(id),
  metric text not null, operator text not null, threshold double precision not null, severity text not null default 'warning', is_active boolean not null default true);
create table alarm_events (id bigserial primary key, user_id bigint not null references users(id), device_id bigint references devices(id),
  rule_id bigint references alarm_rules(id), metric text not null, operator text, threshold double precision, value double precision,
  severity text not null default 'warning', triggered_at timestamptz not null, acknowledged_at timestamptz, resolved_at timestamptz);
create table notification_preferences (user_id bigint primary key references users(id), line_enabled boolean not null default false, line_target_id text,
  email_enabled boolean not null default false, email_address text);
`;

let env: TestEnv;
let legacy: pg.Pool;
const T0 = Date.UTC(2026, 9, 1);
const H = 3_600_000;
const LINE = `U${"a".repeat(32)}`;

beforeAll(async () => {
  await resetDatabase();
  env = await startTestServer();
  const url = new URL(process.env.TEST_DATABASE_URL!);
  const name = `${url.pathname.slice(1)}_legacy`;
  const admin = new URL(url);
  admin.pathname = "/postgres";
  const c = new pg.Client({ connectionString: admin.toString() });
  await c.connect();
  await c.query(`drop database if exists "${name}" with (force)`);
  await c.query(`create database "${name}" template template0`);
  await c.end();
  url.pathname = `/${name}`;
  legacy = new pg.Pool({ connectionString: url.toString(), max: 2 });
  await legacy.query(LEGACY_SCHEMA);
  await legacy.query(`
    insert into users (firebase_uid, email, display_name) values ('fb-olivia', 'Olivia@Example.com', 'Olivia'), ('fb-mike', 'mike@example.com', null);
    insert into organizations (name, owner_user_id) values ('บริษัทห้องเย็น', 1), ('ปิดแล้ว', 1);
    update organizations set is_active = false where id = 2;
    insert into organization_members (organization_id, user_id, role) values (1, 2, 'operator');
    insert into devices (user_id, organization_id, device_code, name, secret_hash, secret_encrypted, last_seen_at) values
      (1, null, 'DW-OLD1', 'ห้องเย็น 1', 'bcrypt', '${encrypt("old-secret-1")}', '2026-10-04T00:00:00Z'),
      (1, 1, 'DW-OLD2', 'ตู้แช่ 2', 'bcrypt', null, null),
      (2, null, 'DW-OFF', 'เลิกใช้', 'bcrypt', null, null);
    update devices set is_active = false where device_code = 'DW-OFF';
    insert into device_metrics (device_id, metric_key, metric_name, unit, sort_order, decimal_places) values (1, 'CH-1', 'ช่อง 1 แรงดัน', 'bar', 5, 1);
    insert into alarm_rules (user_id, device_id, metric, operator, threshold, severity) values
      (1, 1, 'temperature', '>', 8, 'warning'), (1, 1, 'temperature', '<', 2, 'warning'),
      (1, 1, 'temperature', '>=', 12, 'Critical'), (1, 1, 'humidity', '==', 50, 'warning');
    insert into alarm_events (user_id, device_id, rule_id, metric, operator, threshold, value, severity, triggered_at, acknowledged_at, resolved_at) values
      (1, 1, 1, 'temperature', '>', 8, 9.5, 'warning', '2026-10-02T03:00:00Z', '2026-10-02T03:10:00Z', '2026-10-02T04:00:00Z'),
      (1, 1, 3, 'temperature', '>=', 12, 13, 'critical', '2026-10-03T01:00:00Z', null, null);
    insert into notification_preferences values (1, true, '${LINE}', true, 'Olivia@Example.com'), (2, true, 'not-a-line-id', false, null);
  `);
  // 3 days of hourly readings: sensor table + the same moments in the metric table (the old double write) + one extra channel
  for (let i = 0; i < 72; i++) {
    const t = new Date(T0 + i * H).toISOString();
    await legacy.query(
      `insert into sensor_readings values ($1, 1, $2, 60);
       insert into device_metric_readings values ($1, 1, 'temperature', $2), ($1, 1, 'CH-1', $3), ($1, 2, 'Temp 2', 5)`.replace(/\$1/g, `'${t}'`).replace(/\$2/g, String(4 + (i % 3))).replace(/\$3/g, String(i)),
    );
  }
});

afterAll(async () => {
  await legacy.end();
  await env.close();
});

const opts = (over: Partial<ImportOptions> = {}): ImportOptions => ({
  legacy, target: env.pool, pepper: PEPPER, legacySecretKey: KEY.toString("base64"), dryRun: false,
  includeInactive: false, telemetry: true, windowHours: 24, cutoff: new Date(T0 + 100 * H), log: () => {}, ...over,
});

describe("legacy import helpers", () => {
  it("normalizes free-text metric keys", () => {
    expect(normalizeMetricKey("CH-1")).toBe("ch_1");
    expect(normalizeMetricKey(" Temp 2 ")).toBe("temp_2");
    expect(normalizeMetricKey("3phase")).toBe("m_3phase");
  });
  it("merges one-sided rules into a range", () => {
    expect(mergeRules([{ id: "1", operator: ">", threshold: 8, active: true }, { id: "2", operator: "<", threshold: 2, active: false }])).toMatchObject({ ok: true, min: 2, max: 8, enabled: true });
    expect(mergeRules([{ id: "1", operator: "<", threshold: 9, active: true }, { id: "2", operator: ">", threshold: 3, active: true }]).ok).toBe(false);
  });
});

describe("legacy import", () => {
  it("dry run writes nothing", async () => {
    const r = await runImport(opts({ dryRun: true }));
    expect(r.counts.devices).toBe(2);
    expect((await env.pool.query("select count(*)::int as n from devices")).rows[0].n).toBe(0);
  });

  it("imports people, organizations, devices, settings, rules, history and telemetry with matching counts", async () => {
    const r = await runImport(opts());
    expect(r.counts).toMatchObject({ users: 2, personal_orgs: 2, orgs: 1, devices: 2, secrets_kept: 1, alarm_rules: 2, alarm_events: 2 });
    expect(r.warnings.join("\n")).toMatch(/ปิดแล้ว/);
    expect(r.warnings.join("\n")).toMatch(/DW-OFF/);
    expect(r.warnings.join("\n")).toMatch(/"==" แปลงเป็นช่วงปกติไม่ได้/);
    expect(r.warnings.join("\n")).toMatch(/LINE ID/);

    // board 1 keeps its old secret; board 2 gets a new one in the report
    const d1 = (await env.pool.query("select id, secret_hash, org_id, last_seen_at from devices where code = 'DW-OLD1'")).rows[0];
    expect(verifyDeviceSecret("old-secret-1", d1.secret_hash, PEPPER)).toBe(true);
    expect(r.newSecrets.map((s) => s.code)).toEqual(["DW-OLD2"]);
    const d2 = (await env.pool.query("select id, secret_hash from devices where code = 'DW-OLD2'")).rows[0];
    expect(verifyDeviceSecret(r.newSecrets[0]!.secret, d2.secret_hash, PEPPER)).toBe(true);

    // organizations and roles
    const org = (await env.pool.query("select id from organizations where name = 'บริษัทห้องเย็น'")).rows[0];
    const roles = await env.pool.query("select u.email, m.role from memberships m join users u on u.id = m.user_id where m.org_id = $1 order by 1", [org.id]);
    expect(roles.rows).toEqual([{ email: "mike@example.com", role: "member" }, { email: "olivia@example.com", role: "owner" }]);

    // telemetry: the double-written temperature collapses, every count matches
    expect(r.verify.length).toBe(4);
    expect(r.verify.every((v) => v.old === v.imported)).toBe(true);
    expect(r.verify.find((v) => v.code === "DW-OLD1" && v.metric === "temperature")).toMatchObject({ old: 72, imported: 72 });
    expect(r.verify.find((v) => v.code === "DW-OLD2")).toMatchObject({ metric: "temp_2", old: 72 });
    const latest = await env.pool.query("select metric_key, value from latest where device_id = $1 order by 1", [d1.id]);
    expect(latest.rows.map((x) => x.metric_key)).toEqual(["ch_1", "humidity", "temperature"]);

    // settings, rules, history, recipients
    const set = (await env.pool.query("select label, unit, decimals from metric_settings where device_id = $1", [d1.id])).rows;
    expect(set).toEqual([{ label: "ช่อง 1 แรงดัน", unit: "bar", decimals: 1 }]);
    const rules = (await env.pool.query("select severity, min_value, max_value from alarm_rules where device_id = $1 order by severity", [d1.id])).rows;
    expect(rules).toEqual([{ severity: "critical", min_value: null, max_value: 12 }, { severity: "warning", min_value: 2, max_value: 8 }]);
    const events = (await env.pool.query("select ended_at, acknowledged_at, notified_open, rule_id is not null as linked from alarm_events order by started_at")).rows;
    expect(events).toHaveLength(2);
    expect(events.every((e) => e.ended_at !== null && e.notified_open && e.linked)).toBe(true);
    const targets = (await env.pool.query("select kind, address from notification_targets order by org_id, kind")).rows;
    expect(targets.filter((t) => t.kind === "line")).toHaveLength(2); // olivia's devices sit in two organizations
    expect(targets.find((t) => t.kind === "email")?.address).toBe("olivia@example.com");
  });

  it("can run again: nothing is duplicated and new old-system rows are picked up", async () => {
    const before = (await env.pool.query("select (select count(*) from readings)::int as r, (select count(*) from devices)::int as d, (select count(*) from alarm_events)::int as e")).rows[0];
    const again = await runImport(opts());
    expect(again.newSecrets).toEqual([]);
    expect(again.counts.devices).toBeUndefined();
    const after = (await env.pool.query("select (select count(*) from readings)::int as r, (select count(*) from devices)::int as d, (select count(*) from alarm_events)::int as e")).rows[0];
    expect(after).toEqual(before);

    await legacy.query(`insert into device_metric_readings values ('${new Date(T0 + 101 * H).toISOString()}', 2, 'Temp 2', 6)`);
    const later = await runImport(opts({ cutoff: new Date(T0 + 120 * H) }));
    expect(later.telemetryRows).toBe(1);
    expect(later.verify.every((v) => v.old === v.imported)).toBe(true);
  });

  it("gives each person exactly one personal organization", async () => {
    const orgs = await env.pool.query(
      "select count(*)::int as n from organizations o join memberships m on m.org_id = o.id join users u on u.id = m.user_id where u.firebase_uid = 'fb-olivia' and o.personal",
    );
    expect(orgs.rows[0].n).toBe(1);
  });
});
