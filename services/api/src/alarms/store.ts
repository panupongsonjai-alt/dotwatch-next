import { evaluateAlarm, type AlarmEvent, type AlarmPhase, type AlarmRule, type AlarmRuleInput, type Severity } from "@dotwatch/shared";
import { withTransaction, type Pool } from "../db/pool";
import type pg from "pg";

interface RuleRow {
  id: string;
  device_id: string;
  metric_key: string;
  severity: Severity;
  min_value: number | null;
  max_value: number | null;
  delay_seconds: number;
  hysteresis: number;
  enabled: boolean;
  phase: AlarmPhase;
  phase_since: Date | null;
  last_eval_time: Date | null;
}

interface EventRow {
  id: string;
  org_id: string;
  device_id: string;
  rule_id: string | null;
  metric_key: string;
  severity: Severity;
  min_value: number | null;
  max_value: number | null;
  started_at: Date;
  start_value: number;
  ended_at: Date | null;
  end_value: number | null;
  acknowledged_at: Date | null;
  acknowledged_by: string | null;
}

const RULE_COLUMNS = `id, device_id, metric_key, severity, min_value, max_value, delay_seconds, hysteresis, enabled, phase, phase_since, last_eval_time`;
export const EVENT_COLUMNS = `id, org_id, device_id, rule_id, metric_key, severity, min_value, max_value, started_at, start_value,
  ended_at, end_value, acknowledged_at, acknowledged_by`;

export const toRule = (r: RuleRow): AlarmRule => ({
  id: r.id,
  deviceId: r.device_id,
  metric: r.metric_key,
  severity: r.severity,
  min: r.min_value,
  max: r.max_value,
  delaySec: r.delay_seconds,
  hysteresis: r.hysteresis,
  enabled: r.enabled,
  phase: r.phase,
});

export const toEvent = (r: EventRow): AlarmEvent => ({
  id: r.id,
  orgId: r.org_id,
  deviceId: r.device_id,
  ruleId: r.rule_id,
  metric: r.metric_key,
  severity: r.severity,
  min: r.min_value,
  max: r.max_value,
  startedAt: r.started_at.getTime(),
  startValue: r.start_value,
  endedAt: r.ended_at ? r.ended_at.getTime() : null,
  endValue: r.end_value,
  acknowledgedAt: r.acknowledged_at ? r.acknowledged_at.getTime() : null,
  acknowledgedBy: r.acknowledged_by,
});

/** What changed for subscribers and (next step) notification channels. */
export interface AlarmChange {
  kind: "opened" | "closed";
  event: AlarmEvent;
}

/**
 * Evaluates the device's enabled rules against the newest values that just advanced `latest`.
 * One short transaction: lock the rule rows (in id order, same as rule edits), compute in memory, write.
 * Nothing outside the database is awaited while the rows are locked.
 */
export async function evaluateDeviceAlarms(
  pool: Pool,
  device: { id: string; orgId: string },
  values: { metric: string; time: number; value: number }[],
): Promise<AlarmChange[]> {
  if (values.length === 0) return [];
  const byMetric = new Map(values.map((v) => [v.metric, v]));
  return withTransaction(pool, async (client) => {
    const { rows } = await client.query<RuleRow>(
      `select ${RULE_COLUMNS} from alarm_rules
        where device_id = $1 and enabled and metric_key = any($2::text[])
        order by id for update`,
      [device.id, [...byMetric.keys()]],
    );
    const changes: AlarmChange[] = [];
    for (const rule of rows) {
      const v = byMetric.get(rule.metric_key)!;
      if (rule.last_eval_time && rule.last_eval_time.getTime() >= v.time) continue; // already seen something newer
      const limits = { min: rule.min_value, max: rule.max_value, delaySec: rule.delay_seconds, hysteresis: rule.hysteresis };
      const result = evaluateAlarm(limits, { phase: rule.phase, since: rule.phase_since?.getTime() ?? null }, v.value, v.time);

      await client.query(
        "update alarm_rules set phase = $2, phase_since = $3, last_eval_time = $4 where id = $1",
        [rule.id, result.state.phase, result.state.since === null ? null : new Date(result.state.since), new Date(v.time)],
      );

      if (result.transition.kind === "open") {
        const ev = await client.query<EventRow>(
          `insert into alarm_events (org_id, device_id, rule_id, metric_key, severity, min_value, max_value, started_at, start_value)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           on conflict (rule_id) where ended_at is null do nothing
           returning ${EVENT_COLUMNS}`,
          [device.orgId, device.id, rule.id, rule.metric_key, rule.severity, rule.min_value, rule.max_value,
            new Date(result.transition.startedAt), v.value],
        );
        if (ev.rows[0]) changes.push({ kind: "opened", event: toEvent(ev.rows[0]) });
      } else if (result.transition.kind === "close") {
        const ev = await closeOpenEvent(client, rule.id, result.transition.endedAt, v.value);
        if (ev) changes.push({ kind: "closed", event: ev });
      }
    }
    return changes;
  });
}

async function closeOpenEvent(client: pg.PoolClient, ruleId: string, endedAt: number, endValue: number | null) {
  const { rows } = await client.query<EventRow>(
    `update alarm_events set ended_at = $2, end_value = $3
      where rule_id = $1 and ended_at is null
      returning ${EVENT_COLUMNS}`,
    [ruleId, new Date(endedAt), endValue],
  );
  return rows[0] ? toEvent(rows[0]) : null;
}

export async function listRules(pool: Pool, deviceId: string): Promise<AlarmRule[]> {
  const { rows } = await pool.query<RuleRow>(
    `select ${RULE_COLUMNS} from alarm_rules where device_id = $1 order by metric_key, severity`,
    [deviceId],
  );
  return rows.map(toRule);
}

const sameLimits = (r: RuleRow, i: AlarmRuleInput) =>
  r.min_value === i.min && r.max_value === i.max && r.delay_seconds === i.delaySec && r.hysteresis === i.hysteresis && r.enabled === i.enabled;

/**
 * Replaces the device's rule set. A rule whose limits change (or that is removed or disabled)
 * starts over from "normal", and its open event is closed at `now` with no end value —
 * the old event was judged against limits that no longer exist.
 */
export async function replaceRules(
  pool: Pool,
  device: { id: string; orgId: string },
  inputs: AlarmRuleInput[],
  now: number,
): Promise<{ rules: AlarmRule[]; closed: AlarmEvent[] }> {
  return withTransaction(pool, async (client) => {
    const { rows: existing } = await client.query<RuleRow>(
      `select ${RULE_COLUMNS} from alarm_rules where device_id = $1 order by id for update`,
      [device.id],
    );
    const key = (m: string, s: string) => `${m}/${s}`;
    const byKey = new Map(existing.map((r) => [key(r.metric_key, r.severity), r]));
    const wanted = new Set(inputs.map((i) => key(i.metric, i.severity)));
    const closed: AlarmEvent[] = [];

    for (const r of existing) {
      if (wanted.has(key(r.metric_key, r.severity))) continue;
      const ev = await closeOpenEvent(client, r.id, now, null);
      if (ev) closed.push(ev);
      await client.query("delete from alarm_rules where id = $1", [r.id]);
    }

    for (const i of inputs) {
      const prev = byKey.get(key(i.metric, i.severity));
      if (prev && sameLimits(prev, i)) continue;
      if (prev) {
        const ev = await closeOpenEvent(client, prev.id, now, null);
        if (ev) closed.push(ev);
        await client.query(
          `update alarm_rules set min_value = $2, max_value = $3, delay_seconds = $4, hysteresis = $5, enabled = $6,
                  phase = 'normal', phase_since = null, last_eval_time = null, updated_at = now()
            where id = $1`,
          [prev.id, i.min, i.max, i.delaySec, i.hysteresis, i.enabled],
        );
      } else {
        await client.query(
          `insert into alarm_rules (org_id, device_id, metric_key, severity, min_value, max_value, delay_seconds, hysteresis, enabled)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [device.orgId, device.id, i.metric, i.severity, i.min, i.max, i.delaySec, i.hysteresis, i.enabled],
        );
      }
    }

    const { rows } = await client.query<RuleRow>(
      `select ${RULE_COLUMNS} from alarm_rules where device_id = $1 order by metric_key, severity`,
      [device.id],
    );
    return { rules: rows.map(toRule), closed };
  });
}
