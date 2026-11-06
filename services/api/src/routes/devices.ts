import { Router } from "express";
import { z } from "zod";
import {
  can, createDeviceSchema, historyQuerySchema, pickBucketMs, updateDeviceSchema,
  type CreateDeviceResponse, type Device, type HistoryPoint, type HistoryResponse, type MetricValue, type ResetSecretResponse,
} from "@dotwatch/shared";
import type { Pool } from "../db/pool";
import { roleInOrg } from "../auth/users";
import { deviceAccess } from "../auth/deviceAccess";
import { generateDeviceCode, generateDeviceSecret, hashDeviceSecret } from "../auth/deviceSecret";
import { forbidden } from "../lib/errors";
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
});

const DEVICE_COLUMNS = `
  select d.id, d.org_id, d.code, d.name, d.last_seen_at, d.firmware_version, d.offline_after_sec,
         coalesce(
           (select jsonb_object_agg(l.metric_key, jsonb_build_object('time', (extract(epoch from l.time) * 1000)::bigint, 'value', l.value))
              from latest l where l.device_id = d.id),
           '{}'::jsonb) as latest`;

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

/** Device list, create, update, delete, secret reset and history. Mounted inside the user router. */
export function deviceRoutes(deps: { pool: Pool; pepper: string; broadcaster: Broadcaster; now?: () => number }): Router {
  const router = Router();
  const now = deps.now ?? Date.now;
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

  router.get("/devices/:id/history", async (req, res, next) => {
    try {
      const id = idParam.parse(req.params.id);
      await deviceAccess(deps.pool, req.user!.id, id);
      const q = historyQuerySchema.parse(req.query);
      const bucketMs = pickBucketMs(q.from, q.to);
      const { rows } = await deps.pool.query<{ metric_key: string; t: number } & Omit<HistoryPoint, "t">>(HISTORY_SQL, [
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
