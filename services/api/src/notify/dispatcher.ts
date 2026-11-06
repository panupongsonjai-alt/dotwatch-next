import type { Pool } from "../db/pool";
import { log } from "../lib/log";
import { toEvent, EVENT_COLUMNS, type EventRow } from "../alarms/store";
import { buildMessage, type Reason } from "./messages";
import { logOnly, SendError, type Channels } from "./channels";

/**
 * Notification pipeline (ADR 0001, decision 9), driven by alarm_events state:
 *   1. enqueue — single statements that flip a flag on the event and insert one job per matching recipient
 *      (opened, closed, and reminders while nobody has acknowledged, up to the organization's ceiling);
 *   2. deliver — claim due jobs with SKIP LOCKED, send with no transaction open, record the result,
 *      retry with backoff on temporary errors.
 * Every statement is idempotent, so a crash between steps or a second instance never double-sends.
 */

const MATCH = `t.org_id = ev.org_id and t.enabled and t.address is not null
               and (t.min_severity = 'warning' or ev.severity = 'critical')`;

const ENQUEUE_OPENED = `
with ev as (
  update alarm_events set notified_open = true, last_notified_at = $1
   where not notified_open
  returning id, org_id, severity
)
insert into notification_jobs (org_id, event_id, target_id, reason)
select ev.org_id, ev.id, t.id, 'opened' from ev join notification_targets t on ${MATCH}`;

const ENQUEUE_CLOSED = `
with ev as (
  update alarm_events set notified_close = true
   where not notified_close and ended_at is not null and notified_open
  returning id, org_id, severity
)
insert into notification_jobs (org_id, event_id, target_id, reason)
select ev.org_id, ev.id, t.id, 'closed' from ev join notification_targets t on ${MATCH}`;

const ENQUEUE_REMINDERS = `
with ev as (
  update alarm_events e set reminders_sent = e.reminders_sent + 1, last_notified_at = $1
    from organizations o
   where o.id = e.org_id
     and e.ended_at is null and e.acknowledged_at is null and e.notified_open
     and o.notify_repeat_minutes is not null
     and e.reminders_sent < o.notify_max_reminders
     and e.last_notified_at <= $1::timestamptz - make_interval(mins => o.notify_repeat_minutes)
  returning e.id, e.org_id, e.severity, e.reminders_sent
)
insert into notification_jobs (org_id, event_id, target_id, reason, reminder_no)
select ev.org_id, ev.id, t.id, 'reminder', ev.reminders_sent from ev join notification_targets t on ${MATCH}`;

const CLAIM = `
update notification_jobs j set status = 'sending', claimed_at = $1, attempts = j.attempts + 1
 where j.id in (
   select id from notification_jobs
    where (status = 'pending' and next_attempt_at <= $1)
       or (status = 'sending' and claimed_at < $1::timestamptz - interval '5 minutes')
    order by id
    limit $2
    for update skip locked)
returning j.id`;

const LOAD = `
select j.id, j.reason, j.reminder_no, j.attempts, j.retry_key, j.target_id,
       t.kind, t.address, t.enabled, o.name as org_name, o.notify_max_reminders, d.name as device_name,
       case when ms.metric_key is null then null else
         json_build_object('label', ms.label, 'unit', ms.unit, 'decimals', ms.decimals, 'sortOrder', ms.sort_order, 'hidden', ms.hidden)
       end as metric_setting,
       ${EVENT_COLUMNS.split(",").map((c) => `e.${c.trim()} as e_${c.trim()}`).join(", ")}
  from notification_jobs j
  join notification_targets t on t.id = j.target_id
  join organizations o on o.id = j.org_id
  left join alarm_events e on e.id = j.event_id
  left join devices d on d.id = e.device_id
  left join metric_settings ms on ms.device_id = e.device_id and ms.metric_key = e.metric_key
 where j.id = any($1::bigint[])
 order by j.id`;

export const MAX_ATTEMPTS = 5;
export const backoffMs = (attempt: number) => Math.min(30 * 60_000, 30_000 * 2 ** (attempt - 1));

export interface NotifierDeps {
  pool: Pool;
  channels: Channels;
  appUrl: string;
  timeZone: string;
}

export async function enqueue(pool: Pool, now: number): Promise<number> {
  const at = new Date(now);
  const a = await pool.query(ENQUEUE_OPENED, [at]);
  const b = await pool.query(ENQUEUE_CLOSED);
  const c = await pool.query(ENQUEUE_REMINDERS, [at]);
  return (a.rowCount ?? 0) + (b.rowCount ?? 0) + (c.rowCount ?? 0);
}

export async function deliver(deps: NotifierDeps, now: number, batch = 20): Promise<{ sent: number; failed: number }> {
  const claimed = await deps.pool.query<{ id: string }>(CLAIM, [new Date(now), batch]);
  if (claimed.rows.length === 0) return { sent: 0, failed: 0 };
  const { rows } = await deps.pool.query(LOAD, [claimed.rows.map((r) => r.id)]);
  let sent = 0;
  let failed = 0;

  // One at a time keeps us well inside LINE's rate limits for a handful of recipients.
  for (const r of rows) {
    const event = r.e_id ? toEvent(Object.fromEntries(Object.entries(r).filter(([k]) => k.startsWith("e_") && k !== "e_metric_setting").map(([k, v]) => [k.slice(2), v])) as unknown as EventRow) : null;
    const message = buildMessage({
      reason: r.reason as Reason,
      reminderNo: r.reminder_no,
      maxReminders: r.notify_max_reminders,
      event,
      deviceName: r.device_name,
      orgName: r.org_name,
      appUrl: deps.appUrl,
      timeZone: deps.timeZone,
      metricSetting: r.metric_setting,
    });
    const channel = deps.channels[r.kind as "line" | "email"];
    try {
      if (!r.enabled || !r.address) throw new SendError("recipient is turned off or not linked", true);
      if (channel.configured) await channel.send(r.address, message, r.retry_key);
      else logOnly(r.kind, message, r.address);
      const status = channel.configured ? "sent" : "dry_run";
      await deps.pool.query("update notification_jobs set status = $2, sent_at = $3, error = null where id = $1", [r.id, status, new Date(now)]);
      await deps.pool.query(
        "update notification_targets set last_sent_at = $2, last_error = $3 where id = $1",
        [r.target_id, new Date(now), channel.configured ? null : "ยังไม่ได้ใส่ key ของช่องทางนี้ ข้อความถูกเขียนลง log ของ API แทน"],
      );
      sent++;
    } catch (err) {
      const e = err instanceof SendError ? err : new SendError((err as Error).message, false);
      const giveUp = e.permanent || r.attempts >= MAX_ATTEMPTS;
      await deps.pool.query(
        `update notification_jobs set status = $2, error = $3, next_attempt_at = $4 where id = $1`,
        [r.id, giveUp ? "failed" : "pending", e.message.slice(0, 500), new Date(now + backoffMs(r.attempts))],
      );
      if (giveUp) {
        await deps.pool.query("update notification_targets set last_error = $2 where id = $1", [r.target_id, e.message.slice(0, 300)]);
        failed++;
      }
      log.warn("notification send failed", { jobId: r.id, channel: r.kind, attempt: r.attempts, giveUp, error: e.message });
    }
  }
  return { sent, failed };
}

/** Runs enqueue + deliver on an interval; a slow run is never overlapped. */
export function startNotifier(deps: NotifierDeps & { intervalMs?: number; now?: () => number }) {
  const now = deps.now ?? Date.now;
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await enqueue(deps.pool, now());
      // Drain everything that is due, in small batches.
      for (let i = 0; i < 10; i++) {
        const r = await deliver(deps, now());
        if (r.sent + r.failed === 0) break;
      }
    } catch (err) {
      log.error("notifier tick failed", { error: (err as Error).message });
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), deps.intervalMs ?? 5_000);
  timer.unref();
  return { stop: () => clearInterval(timer), tick };
}
