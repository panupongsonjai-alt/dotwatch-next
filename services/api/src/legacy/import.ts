import pg from "pg";
import type { Pool } from "../db/pool";
import { generateDeviceSecret, hashDeviceSecret } from "../auth/deviceSecret";
import { decryptOldSecret, eventLimits, isLineId, mapRole, mapSeverity, mergeRules, normalizeMetricKey, type OldRule } from "./keys";

/**
 * One-way import from the old dotWatch database (ADR 0001, decision 4).
 * Re-runnable: every created row is recorded in legacy_ids, telemetry progress in legacy_copy_progress,
 * and all inserts are "on conflict do nothing". A second run only adds what changed in the old system.
 * The old database is only read.
 */

export interface ImportOptions {
  legacy: pg.Pool;
  target: Pool;
  pepper: string;
  /** The old DEVICE_SECRET_ENCRYPTION_KEY. With it, boards keep their current secret. */
  legacySecretKey?: string;
  dryRun: boolean;
  includeInactive: boolean;
  telemetry: boolean;
  /** Telemetry is copied in time windows of this size. */
  windowHours: number;
  /** Data up to this moment is copied and verified; later rows wait for the next run. */
  cutoff: Date;
  log: (line: string) => void;
}

export interface VerifyRow {
  code: string;
  metric: string;
  old: number;
  imported: number;
}

export interface ImportReport {
  counts: Record<string, number>;
  warnings: string[];
  newSecrets: { code: string; name: string; secret: string }[];
  verify: VerifyRow[];
  telemetryRows: number;
}

type Q = { query: pg.Pool["query"] };

export async function runImport(o: ImportOptions): Promise<ImportReport> {
  const report: ImportReport = { counts: {}, warnings: [], newSecrets: [], verify: [], telemetryRows: 0 };
  const count = (k: string, n = 1) => (report.counts[k] = (report.counts[k] ?? 0) + n);
  const warn = (w: string) => {
    report.warnings.push(w);
    o.log(`  ! ${w}`);
  };
  const L: Q = o.legacy;
  const T: Q = o.target;

  const hasTable = async (t: string) => (await L.query("select to_regclass($1) is not null as ok", [t])).rows[0].ok as boolean;
  const hasColumn = async (t: string, c: string) =>
    (await L.query("select 1 from information_schema.columns where table_name = $1 and column_name = $2", [t, c])).rows.length > 0;

  // ---------- id mapping ----------
  const mapCache = new Map<string, string>();
  const mapped = async (kind: string, oldId: string | number | null): Promise<string | null> => {
    if (oldId === null || oldId === undefined) return null;
    const k = `${kind}:${oldId}`;
    if (mapCache.has(k)) return mapCache.get(k)!;
    const { rows } = await T.query("select new_id from legacy_ids where kind = $1 and old_id = $2", [kind, String(oldId)]);
    if (rows[0]) mapCache.set(k, rows[0].new_id);
    return rows[0]?.new_id ?? null;
  };
  const remember = async (kind: string, oldId: string | number, newId: string) => {
    mapCache.set(`${kind}:${oldId}`, newId);
    if (!o.dryRun) await T.query("insert into legacy_ids (kind, old_id, new_id) values ($1, $2, $3) on conflict do nothing", [kind, String(oldId), newId]);
  };
  const fakeId = () => `dry-${Math.random().toString(16).slice(2)}`;

  // ---------- users and personal organizations ----------
  o.log("ผู้ใช้");
  const users = await L.query<{ id: string; firebase_uid: string; email: string | null; display_name: string | null }>(
    "select id::text, firebase_uid, email, display_name from users order by id",
  );
  for (const u of users.rows) {
    let userId = await mapped("user", u.id);
    if (!userId) {
      if (o.dryRun) userId = fakeId();
      else {
        const { rows } = await T.query(
          `insert into users (firebase_uid, email, display_name) values ($1, lower($2), $3)
           on conflict (firebase_uid) do update set email = coalesce(users.email, excluded.email),
                  display_name = coalesce(users.display_name, excluded.display_name)
           returning id`,
          [u.firebase_uid, u.email, u.display_name],
        );
        userId = rows[0].id as string;
      }
      await remember("user", u.id, userId);
      count("users");
    }
    if (!(await mapped("personal_org", u.id))) {
      // Someone who already signed in to the new system has a personal organization; reuse it.
      const existing = o.dryRun
        ? { rows: [] }
        : await T.query(
            "select o.id from organizations o join memberships m on m.org_id = o.id where m.user_id = $1 and o.personal and m.role = 'owner' limit 1",
            [userId],
          );
      let orgId: string = existing.rows[0]?.id;
      if (!orgId) {
        if (o.dryRun) orgId = fakeId();
        else {
          const org = await T.query("insert into organizations (name, personal) values ($1, true) returning id", [u.display_name || u.email || "ส่วนตัว"]);
          orgId = org.rows[0].id;
          await T.query("insert into memberships (org_id, user_id, role) values ($1, $2, 'owner') on conflict do nothing", [orgId, userId]);
        }
        count("personal_orgs");
      }
      await remember("personal_org", u.id, orgId);
    }
  }

  // ---------- shared organizations ----------
  if (await hasTable("organizations")) {
    o.log("องค์กร");
    const orgs = await L.query<{ id: string; name: string; owner_user_id: string | null; is_active: boolean }>(
      "select id::text, name, owner_user_id::text, coalesce(is_active, true) as is_active from organizations order by id",
    );
    for (const org of orgs.rows) {
      if (!org.is_active) {
        warn(`องค์กร "${org.name}" ปิดใช้งานในระบบเก่า: ไม่ย้าย อุปกรณ์ขององค์กรนี้ไปอยู่ในองค์กรส่วนตัวของเจ้าของอุปกรณ์`);
        continue;
      }
      if (await mapped("org", org.id)) continue;
      const newId = o.dryRun ? fakeId() : (await T.query("insert into organizations (name) values ($1) returning id", [org.name])).rows[0].id;
      await remember("org", org.id, newId);
      count("orgs");
    }
    if (await hasTable("organization_members")) {
      const members = await L.query<{ organization_id: string; user_id: string; role: string }>(
        "select organization_id::text, user_id::text, role from organization_members where coalesce(is_active, true)",
      );
      const owners = orgs.rows.filter((r) => r.is_active && r.owner_user_id).map((r) => ({ organization_id: r.id, user_id: r.owner_user_id!, role: "owner" }));
      for (const m of [...owners, ...members.rows]) {
        const orgId = await mapped("org", m.organization_id);
        const userId = await mapped("user", m.user_id);
        if (!orgId || !userId) continue;
        if (!o.dryRun) {
          const r = await T.query("insert into memberships (org_id, user_id, role) values ($1, $2, $3) on conflict do nothing", [orgId, userId, mapRole(m.role)]);
          count("memberships", r.rowCount ?? 0);
        } else count("memberships");
      }
    }
  }

  // ---------- devices ----------
  o.log("อุปกรณ์");
  const orgColumn = await hasColumn("devices", "organization_id");
  const encColumn = await hasColumn("devices", "secret_encrypted");
  const devices = await L.query<{
    id: string; user_id: string; organization_id: string | null; device_code: string; name: string;
    secret_encrypted: string | null; firmware_version: string | null; is_active: boolean; last_seen_at: Date | null; created_at: Date;
  }>(
    `select id::text, user_id::text, ${orgColumn ? "organization_id::text" : "null::text as organization_id"}, device_code, name,
            ${encColumn ? "secret_encrypted" : "null::text as secret_encrypted"}, firmware_version, coalesce(is_active, true) as is_active,
            last_seen_at, created_at
       from devices order by id`,
  );
  const imported: { oldId: string; newId: string; code: string; ownerOld: string; orgId: string }[] = [];
  for (const d of devices.rows) {
    if (!d.is_active && !o.includeInactive) {
      warn(`อุปกรณ์ ${d.device_code} ถูกปิดใช้งานในระบบเก่า: ไม่ย้าย (ใช้ --include-inactive ถ้าต้องการย้าย)`);
      continue;
    }
    const orgId = (await mapped("org", d.organization_id)) ?? (await mapped("personal_org", d.user_id));
    if (!orgId) {
      warn(`อุปกรณ์ ${d.device_code}: ไม่พบเจ้าของ ข้าม`);
      continue;
    }
    let newId = await mapped("device", d.id);
    if (!newId) {
      const clash = o.dryRun ? { rows: [] } : await T.query("select id from devices where code = $1", [d.device_code]);
      if (clash.rows[0]) {
        warn(`รหัสอุปกรณ์ ${d.device_code} มีอยู่แล้วในระบบใหม่ (สร้างเองก่อนย้าย): ข้ามอุปกรณ์นี้และข้อมูลของมัน`);
        continue;
      }
      let secret = d.secret_encrypted && o.legacySecretKey ? decryptOldSecret(d.secret_encrypted, o.legacySecretKey) : null;
      if (!secret) {
        secret = generateDeviceSecret();
        report.newSecrets.push({ code: d.device_code, name: d.name, secret });
      } else count("secrets_kept");
      newId = o.dryRun
        ? fakeId()
        : (
            await T.query(
              `insert into devices (org_id, code, name, secret_hash, firmware_version, last_seen_at, created_at)
               values ($1, $2, $3, $4, $5, $6, $7) returning id`,
              [orgId, d.device_code, d.name, hashDeviceSecret(secret, o.pepper), d.firmware_version, d.last_seen_at, d.created_at],
            )
          ).rows[0].id;
      await remember("device", d.id, newId!);
      count("devices");
    }
    imported.push({ oldId: d.id, newId: newId!, code: d.device_code, ownerOld: d.user_id, orgId });
  }
  const byOld = new Map(imported.map((d) => [d.oldId, d]));

  // ---------- metric names and units ----------
  if (await hasTable("device_metrics")) {
    o.log("ชื่อและหน่วยของค่าที่วัด");
    const decimals = (await hasColumn("device_metrics", "decimal_places")) ? "decimal_places" : "2";
    const rows = await L.query<{ device_id: string; metric_key: string; metric_name: string; unit: string | null; visible: boolean; sort_order: number | null; decimals: number | null }>(
      `select device_id::text, metric_key, metric_name, unit, coalesce(visible, true) as visible, sort_order, ${decimals} as decimals
         from device_metrics order by device_id, sort_order nulls last, id`,
    );
    for (const r of rows.rows) {
      const dev = byOld.get(r.device_id);
      if (!dev) continue;
      if (!o.dryRun) {
        const res = await T.query(
          `insert into metric_settings (device_id, metric_key, label, unit, decimals, sort_order, hidden)
           values ($1, $2, $3, $4, $5, $6, $7) on conflict do nothing`,
          [dev.newId, normalizeMetricKey(r.metric_key), (r.metric_name || r.metric_key).slice(0, 60), (r.unit ?? "").slice(0, 16),
            Math.max(0, Math.min(4, r.decimals ?? 2)), Math.max(0, r.sort_order ?? 0), !r.visible],
        );
        count("metric_settings", res.rowCount ?? 0);
      } else count("metric_settings");
    }
  }

  // ---------- alarm rules ----------
  const ruleMap = new Map<string, string>();
  if (await hasTable("alarm_rules")) {
    o.log("กฎแจ้งเตือน");
    const rules = await L.query<{ id: string; device_id: string; metric: string; operator: string; threshold: number; severity: string; is_active: boolean }>(
      "select id::text, device_id::text, metric, operator, threshold, severity, coalesce(is_active, true) as is_active from alarm_rules where device_id is not null order by id",
    );
    const groups = new Map<string, { dev: (typeof imported)[number]; metric: string; severity: string; rules: OldRule[] }>();
    for (const r of rules.rows) {
      const dev = byOld.get(r.device_id);
      if (!dev) continue;
      const metric = normalizeMetricKey(r.metric);
      const severity = mapSeverity(r.severity);
      const k = `${dev.newId}/${metric}/${severity}`;
      if (!groups.has(k)) groups.set(k, { dev, metric, severity, rules: [] });
      groups.get(k)!.rules.push({ id: r.id, operator: r.operator, threshold: r.threshold, active: r.is_active });
    }
    for (const g of groups.values()) {
      const m = mergeRules(g.rules);
      if (!m.ok) {
        warn(`กฎของ ${g.dev.code} (${g.metric}, ${g.severity}): ${m.reason} — ไม่ย้าย ให้ตั้งใหม่ในระบบใหม่`);
        continue;
      }
      if (g.rules.some((r) => r.operator.trim() === ">=" || r.operator.trim() === "<=")) count("rules_inclusive_operator");
      let newRuleId: string;
      if (o.dryRun) newRuleId = fakeId();
      else {
        const res = await T.query(
          `insert into alarm_rules (org_id, device_id, metric_key, severity, min_value, max_value, enabled)
           values ($1, $2, $3, $4, $5, $6, $7)
           on conflict (device_id, metric_key, severity) do update set metric_key = excluded.metric_key
           returning id`,
          [g.dev.orgId, g.dev.newId, g.metric, g.severity, m.min, m.max, m.enabled],
        );
        newRuleId = res.rows[0].id;
      }
      for (const id of m.ruleIds) ruleMap.set(id, newRuleId);
      count("alarm_rules");
    }
  }

  // ---------- alarm history ----------
  if (await hasTable("alarm_events")) {
    o.log("ประวัติแจ้งเตือน");
    const events = await L.query<{
      id: string; device_id: string; rule_id: string | null; metric: string; operator: string | null; threshold: number | null;
      value: number; severity: string; triggered_at: Date; acknowledged_at: Date | null; resolved_at: Date | null;
    }>(
      `select id::text, device_id::text, rule_id::text, metric, operator, threshold, value, severity, triggered_at, acknowledged_at, resolved_at
         from alarm_events where device_id is not null and value is not null order by id`,
    );
    for (const e of events.rows) {
      const dev = byOld.get(e.device_id);
      if (!dev || (await mapped("alarm_event", e.id))) continue;
      const lim = eventLimits(e.operator, e.threshold);
      // Imported alarms are history: anything still open in the old system closes at the import
      // and the new rules re-open it on the next reading if it is still out of range.
      const newId = o.dryRun
        ? fakeId()
        : (
            await T.query(
              `insert into alarm_events (org_id, device_id, rule_id, kind, metric_key, severity, min_value, max_value,
                                         started_at, start_value, ended_at, end_value, acknowledged_at,
                                         notified_open, notified_close)
               values ($1, $2, $3, 'threshold', $4, $5, $6, $7, $8, $9, $10, null, $11, true, true) returning id`,
              [dev.orgId, dev.newId, e.rule_id ? (ruleMap.get(e.rule_id) ?? null) : null, normalizeMetricKey(e.metric), mapSeverity(e.severity),
                lim.min, lim.max, e.triggered_at, e.value, e.resolved_at ?? o.cutoff, e.acknowledged_at],
            )
          ).rows[0].id;
      await remember("alarm_event", e.id, newId);
      count("alarm_events");
    }
  }

  // ---------- notification recipients ----------
  if (await hasTable("notification_preferences")) {
    o.log("ผู้รับแจ้งเตือน");
    const prefs = await L.query<{ user_id: string; line_enabled: boolean; line_target_id: string | null; email_enabled: boolean; email_address: string | null; name: string | null }>(
      `select p.user_id::text, p.line_enabled, p.line_target_id, p.email_enabled, p.email_address, coalesce(u.display_name, u.email) as name
         from notification_preferences p join users u on u.id = p.user_id`,
    );
    for (const p of prefs.rows) {
      // The old system notified the owner of each device, so the recipient goes where that person's devices went.
      const orgs = [...new Set(imported.filter((d) => d.ownerOld === p.user_id).map((d) => d.orgId))];
      const targets: { kind: "line" | "email"; address: string }[] = [];
      if (p.line_enabled && isLineId(p.line_target_id)) targets.push({ kind: "line", address: p.line_target_id.trim() });
      else if (p.line_enabled && p.line_target_id) warn(`LINE ID ของ ${p.name ?? p.user_id} ไม่อยู่ในรูปแบบที่ใช้ได้: ไม่ย้าย`);
      if (p.email_enabled && p.email_address?.includes("@")) targets.push({ kind: "email", address: p.email_address.trim().toLowerCase() });
      for (const orgId of orgs) {
        for (const t of targets) {
          if (o.dryRun) {
            count("notification_targets");
            continue;
          }
          const r = await T.query(
            `insert into notification_targets (org_id, kind, name, address) values ($1, $2, $3, $4) on conflict do nothing`,
            [orgId, t.kind, (p.name ?? (t.kind === "line" ? "LINE" : t.address)).slice(0, 60), t.address],
          );
          count("notification_targets", r.rowCount ?? 0);
        }
      }
    }
  }

  // ---------- telemetry ----------
  const sources: { name: string; table: string; sql: string }[] = [];
  if (await hasTable("device_metric_readings")) {
    sources.push({
      name: "metrics",
      table: "device_metric_readings",
      sql: "select time, metric_key, value from device_metric_readings where device_id = $1 and time >= $2 and time < $3",
    });
  }
  if (await hasTable("sensor_readings")) {
    // The old system wrote temperature/humidity to both tables with the same timestamp (old 6.5);
    // the primary key on readings collapses the copies.
    sources.push({
      name: "sensor",
      table: "sensor_readings",
      sql: `select time, 'temperature' as metric_key, temperature as value from sensor_readings where device_id = $1 and time >= $2 and time < $3 and temperature is not null
            union all
            select time, 'humidity', humidity from sensor_readings where device_id = $1 and time >= $2 and time < $3 and humidity is not null`,
    });
  }

  if (o.telemetry && !o.dryRun) {
    o.log("ข้อมูลย้อนหลัง");
    const windowMs = o.windowHours * 3_600_000;
    for (const dev of imported) {
      for (const src of sources) {
        const range = await L.query<{ min: Date | null }>(`select min(time) as min from ${src.table} where device_id = $1`, [dev.oldId]);
        if (!range.rows[0]?.min) continue;
        const progress = await T.query("select copied_until from legacy_copy_progress where old_device_id = $1 and source = $2", [dev.oldId, src.name]);
        // Re-copy the last 2 days on every run: the old system may still receive late rows from Pi queues.
        let from = progress.rows[0]
          ? new Date(Math.max(range.rows[0].min.getTime(), progress.rows[0].copied_until.getTime() - 2 * 86_400_000))
          : range.rows[0].min;
        let copied = 0;
        while (from < o.cutoff) {
          const to = new Date(Math.min(from.getTime() + windowMs, o.cutoff.getTime()));
          const { rows } = await L.query<{ time: Date; metric_key: string; value: number }>(src.sql, [dev.oldId, from, to]);
          if (rows.length) {
            const res = await T.query(
              `insert into readings (device_id, metric_key, time, value, backfilled)
               select $1, k, t, v, false from unnest($2::text[], $3::timestamptz[], $4::float8[]) as x(k, t, v)
               on conflict do nothing`,
              [dev.newId, rows.map((r) => normalizeMetricKey(r.metric_key)), rows.map((r) => r.time), rows.map((r) => r.value)],
            );
            copied += res.rowCount ?? 0;
          }
          await T.query(
            `insert into legacy_copy_progress (old_device_id, source, copied_until, rows_copied) values ($1, $2, $3, $4)
             on conflict (old_device_id, source) do update set copied_until = excluded.copied_until,
                    rows_copied = legacy_copy_progress.rows_copied + $4`,
            [dev.oldId, src.name, to, rows.length],
          );
          from = to;
        }
        if (copied) o.log(`  ${dev.code} (${src.name}): +${copied.toLocaleString()} แถว`);
        report.telemetryRows += copied;
      }
      // Newest value per metric, so cards show something before the board reports again.
      await T.query(
        `insert into latest (device_id, metric_key, time, value)
         select distinct on (metric_key) device_id, metric_key, time, value from readings where device_id = $1
          order by metric_key, time desc
         on conflict (device_id, metric_key) do update set time = excluded.time, value = excluded.value where latest.time < excluded.time`,
        [dev.newId],
      );
    }
    const rollup = await T.query("select 1 from pg_class where relname = 'readings_1h'");
    if (rollup.rows.length) {
      o.log("สรุปรายชั่วโมงสำหรับกราฟช่วงยาว (อาจใช้เวลาหลายนาที)");
      await T.query("call refresh_continuous_aggregate('readings_1h', null, now() - interval '1 hour')");
    }
  }

  // ---------- verification ----------
  if (sources.length && !o.dryRun) {
    o.log("ตรวจยอดแถว");
    const unions = sources
      .map((s) =>
        s.name === "metrics"
          ? "select time, metric_key from device_metric_readings where device_id = $1 and time < $2"
          : "select time, 'temperature' from sensor_readings where device_id = $1 and time < $2 and temperature is not null union select time, 'humidity' from sensor_readings where device_id = $1 and time < $2 and humidity is not null",
      )
      .join(" union ");
    for (const dev of imported) {
      const old = await L.query<{ metric_key: string; n: string }>(`select metric_key, count(*)::text as n from (${unions}) x(time, metric_key) group by 1`, [dev.oldId, o.cutoff]);
      const fresh = await T.query<{ metric_key: string; n: string }>(
        "select metric_key, count(*)::text as n from readings where device_id = $1 and time < $2 group by 1",
        [dev.newId, o.cutoff],
      );
      const want = new Map<string, number>();
      for (const r of old.rows) want.set(normalizeMetricKey(r.metric_key), (want.get(normalizeMetricKey(r.metric_key)) ?? 0) + Number(r.n));
      const got = new Map(fresh.rows.map((r) => [r.metric_key, Number(r.n)]));
      for (const k of new Set([...want.keys(), ...got.keys()])) {
        report.verify.push({ code: dev.code, metric: k, old: want.get(k) ?? 0, imported: got.get(k) ?? 0 });
      }
    }
  }
  return report;
}
