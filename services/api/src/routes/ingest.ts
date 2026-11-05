import { Router } from "express";
import { checkReadingTime, ingestBatchSchema, type IngestResponse, type LiveValue } from "@dotwatch/shared";
import type { Pool } from "../db/pool";
import { parseDeviceAuthHeader, verifyDeviceSecret } from "../auth/deviceSecret";
import { HttpError, unauthorized } from "../lib/errors";
import type { Broadcaster } from "../realtime/hub";

/**
 * POST /v1/ingest — two short autocommit statements, each on one pooled connection, never held across awaits:
 *  1. insert readings (idempotent) and advance `latest` only forward;
 *  2. touch the device (last_seen_at, firmware).
 * They are deliberately NOT one statement (audit 3.1): when an insert opens a new TimescaleDB chunk, the
 * chunk's FK to `devices` needs a ShareRowExclusiveLock on `devices`, which conflicts with the
 * RowExclusiveLock any concurrent `update devices` holds. If that update shared a transaction with a readings
 * insert, the two would wait on each other and deadlock. The touch statement never touches `readings`,
 * so it always finishes and releases its lock.
 * Broadcast happens after the database answers.
 */
const INGEST_SQL = `
with input as (
  select * from unnest($2::text[], $3::timestamptz[], $4::float8[], $5::bool[]) as t(metric_key, time, value, backfilled)
),
ins as (
  insert into readings (device_id, metric_key, time, value, backfilled)
  select $1, metric_key, time, value, backfilled from input
  on conflict do nothing
  returning 1
),
newest as (
  select distinct on (metric_key) metric_key, time, value from input order by metric_key, time desc
),
up as (
  insert into latest (device_id, metric_key, time, value)
  select $1, metric_key, time, value from newest
  on conflict (device_id, metric_key) do update
     set time = excluded.time, value = excluded.value
   where latest.time < excluded.time
  returning metric_key, time, value
)
select (select count(*) from ins) as inserted,
       (select coalesce(json_agg(json_build_object('metric', metric_key, 'time', (extract(epoch from time) * 1000)::bigint, 'value', value)), '[]') from up) as changed
`;

const TOUCH_SQL = `
update devices set last_seen_at = now(), firmware_version = coalesce($2, firmware_version)
 where id = $1
returning (extract(epoch from last_seen_at) * 1000)::bigint as last_seen
`;

export function ingestRouter(deps: { pool: Pool; pepper: string; broadcaster: Broadcaster; now?: () => number }): Router {
  const router = Router();
  const now = deps.now ?? Date.now;

  router.post("/", async (req, res, next) => {
    try {
      const creds = parseDeviceAuthHeader(req.header("authorization"));
      if (!creds) throw unauthorized("Missing device credentials.");
      const found = await deps.pool.query<{ id: string; org_id: string; secret_hash: Buffer }>(
        "select id, org_id, secret_hash from devices where code = $1 and deleted_at is null",
        [creds.code],
      );
      const device = found.rows[0];
      if (!device || !verifyDeviceSecret(creds.secret, device.secret_hash, deps.pepper)) {
        throw unauthorized("Unknown device or wrong secret.");
      }

      const parsed = ingestBatchSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new HttpError(400, "invalid_payload", parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
      }

      const at = now();
      const keys: string[] = [];
      const times: Date[] = [];
      const values: number[] = [];
      const backfilled: boolean[] = [];
      const rejected: IngestResponse["rejected"] = [];

      parsed.data.readings.forEach((reading, index) => {
        const check = checkReadingTime(reading.t, at);
        if (!check.ok) {
          rejected.push({ index, reason: check.reason });
          return;
        }
        for (const [key, value] of Object.entries(reading.m)) {
          keys.push(key);
          times.push(new Date(check.time));
          values.push(value);
          backfilled.push(check.backfilled);
        }
      });

      let accepted = 0;
      if (keys.length > 0) {
        const { rows } = await deps.pool.query<{ inserted: number; changed: { metric: string; time: number; value: number }[] }>(
          INGEST_SQL,
          [device.id, keys, times, values, backfilled],
        );
        const row = rows[0]!;
        accepted = parsed.data.readings.length - rejected.length;
        const live: LiveValue[] = row.changed.map((c) => ({ deviceId: device.id, metric: c.metric, time: Number(c.time), value: c.value }));
        deps.broadcaster.publishValues(device.org_id, live);
        const touched = await deps.pool.query<{ last_seen: string }>(TOUCH_SQL, [device.id, parsed.data.fw ?? null]);
        deps.broadcaster.publishDeviceSeen(device.org_id, device.id, Number(touched.rows[0]!.last_seen));
      }

      const body: IngestResponse = { ok: true, accepted, rejected, serverTime: at, commands: [] };
      res.json(body);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
