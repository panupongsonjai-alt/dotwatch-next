import { Router } from "express";
import { z } from "zod";
import {
  can, createDeviceSchema, historyQuerySchema, metricSettingsSchema, moveDeviceSchema, type MetricSetting, pickBucketMs, updateDeviceSchema,
  type CreateDeviceResponse, type Device, type HistoryPoint, type HistoryResponse, type MetricValue, type ResetSecretResponse,
} from "@dotwatch/shared";
import type { Pool } from "../db/pool";
import { roleInOrg } from "../auth/users";
import { deviceAccess } from "../auth/deviceAccess";
import { generateDeviceCode, generateDeviceSecret, hashDeviceSecret } from "../auth/deviceSecret";
import { forbidden, notFound } from "../lib/errors";
import { withTransaction } from "../db/pool";
import type { Broadcaster } from "../realtime/hub";
import { closeDeviceEvents } from "../alarms/store";

interface DeviceRow {
  id: string;
  org_id: string;
  code: string;
  name: string;
  last_seen_at: Date | null;
  firmware_version: string | null;
  offline_after_sec: number | null;
  latest: Record<string, MetricValue>;
  metrics: Record<string, MetricSetting>;
}

const toDevice = (r: DeviceRow): Device => ({
  id: r.id,
  orgId: r.org_id,
  code: r.code,
  name: r.name,
  lastSeenAt: r.last_seen_at ? r.last_seen_at.getTime() : null,
  firmwareVersion: r.firmware_version,
  offlineAfterSec: r.offline_after_sec,
  latest: r.latest,
  metrics: r.metrics,
});

const DEVICE_COLUMNS = `
  select d.id, d.org_id, d.code, d.name, d.last_seen_at, d.firmware_version, d.offline_after_sec,
         coalesce(
           (select jsonb_object_agg(l.metric_key, jsonb_build_object('time', (extract(epoch from l.time) * 1000)::bigint, 'value', l.value))
              from latest l where l.device_id = d.id),
           '{}'::jsonb) as latest,
         coalesce(
           (select jsonb_object_agg(s.metric_key, jsonb_build_object('label', s.label, 'unit', s.unit, 'decimals', s.decimals,
                                                                    'sortOrder', s.sort_order, 'hidden', s.hidden))
              from metric_settings s where s.device_id = d.id),
           '{}'::jsonb) as metrics`;

const listQuery = z.object({ orgId: z.string().uuid().optional() });
const idParam = z.string().uuid();

// date_bin works on plain PostgreSQL 14+ and on TimescaleDB, and uses the (device_id, metric_key, time) primary key.
const HISTORY_SQL = `
select metric_key,
       (extract(epoch from date_bin(make_interval(secs => $4::float8 / 1000), time, timestamptz 'epoch')) * 1000)::bigint as t,
       avg(value) as avg, min(value) as min, max(value) as max, count(*)::int as n, bool_or(backfilled) as backfilled
  from readings
 where device_id = $1 and metric_key = any($2::text[]) and time >= $3 and time < $5
 group by 1, 2
 order by 1, 2`;

// Hourly rollup (TimescaleDB continuous aggregate, migration 008). Re-bucketing keeps the average exact: sum(avg·n)/sum(n).
const ROLLUP_SQL = `
select metric_key,
       (extract(epoch from date_bin(make_interval(secs => $4::float8 / 1000), bucket, timestamptz 'epoch')) * 1000)::bigint as t,
       sum(avg * n) / sum(n) as avg, min(min) as min, max(max) as max, sum(n)::int as n, bool_or(backfilled) as backfilled
  from readings_1h
 where device_id = $1 and metric_key = any($2::text[]) and bucket >= $3 and bucket < $5
 group by 1, 2
 order by 1, 2`;

/** Whether readings_1h exists, re-checked every 10 minutes so a failing query is never tried per request (audit 3.9). */
function rollupCheck(pool: Pool) {
  let known: { value: boolean; at: number } | null = null;
  return async (): Promise<boolean> => {
    if (known && Date.now() - known.at < 10 * 60_000) return known.value;
    const { rows } = await pool.query("select 1 from pg_class where relname = 'readings_1h'");
    known = { value: rows.length > 0, at: Date.now() };
    return known.value;
  };
}

/** Device list, create, update, delete, secret reset and history. Mounted inside the user router. */
export function deviceRoutes(deps: { pool: Pool; pepper: string; broadcaster: Broadcaster; now?: () => number }): Router {
  const router = Router();
  const now = deps.now ?? Date.now;
  const hasRollup = rollupCheck(deps.pool);
  const loadDevice = async (id: string) => toDevice((await deps.pool.query<DeviceRow>(`${DEVICE_COLUMNS} from devices d where d.id = $1`, [id])).rows[0]!);

  // Only devices of organizations the user belongs to — one indexed path (fixes audit 3.3 by design).
  router.get("/devices", async (req, res, next) => {
    try {
      const { orgId } = listQuery.parse(req.query);
      const { rows } = await deps.pool.query<DeviceRow & { role: string }>(
        `${DEVICE_COLUMNS}, m.role
           from devices d
           join memberships m on m.org_id = d.org_id and m.user_id = $1
          where d.deleted_at is null and ($2::uuid is null or d.org_id = $2)
          order by d.name, d.code`,
        [req.user!.id, orgId ?? null],
      );
      res.json({ devices: rows.filter((r) => can(r.role as never, "device.read")).map(toDevice) });
    } catch (err) {
      next(err);
    }
  });

  router.post("/devices", async (req, res, next) => {
    try {
      const body = createDeviceSchema.parse(req.body);
      const role = await roleInOrg(deps.pool, req.user!.id, body.orgId);
      if (!can(role, "device.create")) throw forbidden("Only owners and admins can add devices.");
      const secret = generateDeviceSecret();
      const code = body.code?.toUpperCase() ?? generateDeviceCode();
      const { rows } = await deps.pool.query<{ id: string }>(
        "insert into devices (org_id, code, name, secret_hash) values ($1, $2, $3, $4) returning id",
        [body.orgId, code, body.name, hashDeviceSecret(secret, deps.pepper)],
      );
      const response: CreateDeviceResponse = { device: await loadDevice(rows[0]!.id), secret };
      res.status(201).json(response);
    } catch (err) {
      next(err);
    }
  });

  router.get("/devices/:id", async (req, res, next) => {
    try {
      const id = idParam.parse(req.params.id);
      await deviceAccess(deps.pool, req.user!.id, id);
      res.json({ device: await loadDevice(id) });
    } catch (err) {
      next(err);
    }
  });

  router.patch("/devices/:id", async (req, res, next) => {
    try {
      const id = idParam.parse(req.params.id);
      const { role } = await deviceAccess(deps.pool, req.user!.id, id);
      const body = updateDeviceSchema.parse(req.body);
      if (body.name !== undefined && !can(role, "device.update")) throw forbidden("Only owners and admins can rename devices.");
      if (body.offlineAfterSec !== undefined && !can(role, "alarm.edit")) throw forbidden("Viewers cannot change alarm settings.");
      await deps.pool.query(
        `update devices set name = coalesce($2, name),
                offline_after_sec = case when $3 then $4::int else offline_after_sec end
          where id = $1`,
        [id, body.name ?? null, body.offlineAfterSec !== undefined, body.offlineAfterSec ?? null],
      );
      res.json({ device: await loadDevice(id) });
    } catch (err) {
      next(err);
    }
  });

  // Soft delete (old 6.6): the request returns at once; telemetry stays until a purge job removes it.
  router.delete("/devices/:id", async (req, res, next) => {
    try {
      const id = idParam.parse(req.params.id);
      const { orgId, role } = await deviceAccess(deps.pool, req.user!.id, id);
      if (!can(role, "device.delete")) throw forbidden("Only owners and admins can delete devices.");
      await deps.pool.query("update devices set deleted_at = now() where id = $1 and deleted_at is null", [id]);
      for (const e of await closeDeviceEvents(deps.pool, id, now())) deps.broadcaster.publishAlarm(orgId, e);
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  // Moving a device carries its rules and alarm history with it; open alarms follow the new organization.
  router.post("/devices/:id/move", async (req, res, next) => {
    try {
      const id = idParam.parse(req.params.id);
      const { orgId: from, role } = await deviceAccess(deps.pool, req.user!.id, id);
      const { orgId: to } = moveDeviceSchema.parse(req.body);
      const target = await roleInOrg(deps.pool, req.user!.id, to);
      if (!target) throw notFound("Organization not found.");
      if (!can(role, "device.delete") || !can(target, "device.create")) {
        throw forbidden("Moving a device needs admin rights in both organizations.");
      }
      if (from !== to) {
        await withTransaction(deps.pool, async (c) => {
          await c.query("update devices set org_id = $2 where id = $1", [id, to]);
          await c.query("update alarm_rules set org_id = $2 where device_id = $1", [id, to]);
          await c.query("update alarm_events set org_id = $2 where device_id = $1", [id, to]);
        });
      }
      res.json({ device: await loadDevice(id) });
    } catch (err) {
      next(err);
    }
  });

  router.post("/devices/:id/reset-secret", async (req, res, next) => {
    try {
      const id = idParam.parse(req.params.id);
      const { role } = await deviceAccess(deps.pool, req.user!.id, id);
      if (!can(role, "device.reset_secret")) throw forbidden("Only owners and admins can reset device secrets.");
      const secret = generateDeviceSecret();
      await deps.pool.query("update devices set secret_hash = $2 where id = $1", [id, hashDeviceSecret(secret, deps.pepper)]);
      const body: ResetSecretResponse = { secret };
      res.json(body);
    } catch (err) {
      next(err);
    }
  });

  // Replaces the device's metric names, units and order. Metrics left out go back to defaults.
  router.put("/devices/:id/metrics", async (req, res, next) => {
    try {
      const id = idParam.parse(req.params.id);
      const { role } = await deviceAccess(deps.pool, req.user!.id, id);
      if (!can(role, "device.update")) throw forbidden("Only owners and admins can rename metrics.");
      const { metrics } = metricSettingsSchema.parse(req.body);
      await withTransaction(deps.pool, async (c) => {
        await c.query("delete from metric_settings where device_id = $1", [id]);
        if (metrics.length) {
          await c.query(
            `insert into metric_settings (device_id, metric_key, label, unit, decimals, sort_order, hidden)
             select $1, * from unnest($2::text[], $3::text[], $4::text[], $5::smallint[], $6::int[], $7::bool[])
             on conflict (device_id, metric_key) do nothing`,
            [id, metrics.map((m) => m.metric), metrics.map((m) => m.label), metrics.map((m) => m.unit), metrics.map((m) => m.decimals),
              metrics.map((m) => m.sortOrder), metrics.map((m) => m.hidden)],
          );
        }
      });
      res.json({ device: await loadDevice(id) });
    } catch (err) {
      next(err);
    }
  });

  router.get("/devices/:id/history", async (req, res, next) => {
    try {
      const id = idParam.parse(req.params.id);
      await deviceAccess(deps.pool, req.user!.id, id);
      const q = historyQuerySchema.parse(req.query);
      const bucketMs = pickBucketMs(q.from, q.to);
      const sql = bucketMs >= 3_600_000 && (await hasRollup()) ? ROLLUP_SQL : HISTORY_SQL;
      const { rows } = await deps.pool.query<{ metric_key: string; t: number } & Omit<HistoryPoint, "t">>(sql, [
        id, q.metrics, new Date(q.from), bucketMs, new Date(q.to),
      ]);
      const series: Record<string, HistoryPoint[]> = Object.fromEntries(q.metrics.map((m) => [m, []]));
      for (const r of rows) series[r.metric_key]!.push({ t: Number(r.t), avg: r.avg, min: r.min, max: r.max, n: r.n, backfilled: r.backfilled });
      const body: HistoryResponse = { from: q.from, to: q.to, bucketMs, series };
      res.json(body);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
