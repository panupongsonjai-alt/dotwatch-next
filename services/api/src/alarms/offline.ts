import type { AlarmEvent } from "@dotwatch/shared";
import type { Pool } from "../db/pool";
import { log } from "../lib/log";
import type { Broadcaster } from "../realtime/hub";
import { EVENT_COLUMNS, toEvent, type EventRow } from "./store";

/**
 * Offline alarms (ADR 0001, decision 8). Two single statements, no locks held across awaits:
 * open one event per device that has been silent longer than its threshold, and close the ones that
 * reported again (or were deleted, or had the alarm turned off). The partial unique index
 * alarm_events_one_open_offline makes opening idempotent, so overlapping runs or a second instance are harmless.
 * startedAt is the device's last contact, so the alarm says how long it has really been silent.
 */
const OPEN_SQL = `
insert into alarm_events (org_id, device_id, kind, metric_key, severity, started_at, start_value)
select d.org_id, d.id, 'offline', 'connection', 'critical', d.last_seen_at, null
  from devices d
 where d.deleted_at is null
   and d.offline_after_sec is not null
   and d.last_seen_at is not null
   and d.last_seen_at < $1::timestamptz - make_interval(secs => d.offline_after_sec)
on conflict (device_id) where ended_at is null and kind = 'offline' do nothing
returning ${EVENT_COLUMNS}`;

const CLOSE_SQL = `
update alarm_events e
   set ended_at = case when d.last_seen_at > e.started_at then d.last_seen_at else $1::timestamptz end
  from devices d
 where e.kind = 'offline' and e.ended_at is null and d.id = e.device_id
   and (d.deleted_at is not null
        or d.offline_after_sec is null
        or d.last_seen_at >= $1::timestamptz - make_interval(secs => d.offline_after_sec))
returning ${EVENT_COLUMNS.split(",").map((c) => `e.${c.trim()}`).join(", ")}`;

export async function checkOffline(pool: Pool, now: number): Promise<{ opened: AlarmEvent[]; closed: AlarmEvent[] }> {
  const at = new Date(now);
  const closed = (await pool.query<EventRow>(CLOSE_SQL, [at])).rows.map(toEvent);
  const opened = (await pool.query<EventRow>(OPEN_SQL, [at])).rows.map(toEvent);
  return { opened, closed };
}

/** Called right after a device reports, so its offline alarm closes without waiting for the next check. */
export async function closeOfflineOnReport(pool: Pool, deviceId: string, seenAt: number): Promise<AlarmEvent[]> {
  const { rows } = await pool.query<EventRow>(
    `update alarm_events set ended_at = $2
      where device_id = $1 and kind = 'offline' and ended_at is null
      returning ${EVENT_COLUMNS}`,
    [deviceId, new Date(seenAt)],
  );
  return rows.map(toEvent);
}

/** Runs the check on an interval; a slow run is never overlapped by the next one. */
export function startOfflineMonitor(deps: { pool: Pool; broadcaster: Broadcaster; intervalMs?: number; now?: () => number }) {
  const now = deps.now ?? Date.now;
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const { opened, closed } = await checkOffline(deps.pool, now());
      for (const e of [...closed, ...opened]) deps.broadcaster.publishAlarm(e.orgId, e);
      if (opened.length || closed.length) log.info("offline check", { opened: opened.length, closed: closed.length });
      // Notification channels (LINE, email, push) hook in here in batch 2.
    } catch (err) {
      log.error("offline check failed", { error: (err as Error).message });
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), deps.intervalMs ?? 30_000);
  timer.unref();
  return { stop: () => clearInterval(timer), tick };
}
