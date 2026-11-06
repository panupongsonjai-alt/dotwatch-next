import { z } from "zod";

/**
 * Alarm rules (ADR 0001, decision 9): a normal range per metric, a delay before the alarm opens,
 * and hysteresis before it closes. One rule per device + metric + severity.
 */
export const SEVERITIES = ["warning", "critical"] as const;
export type Severity = (typeof SEVERITIES)[number];

export const ALARM_PHASES = ["normal", "pending", "active"] as const;
export type AlarmPhase = (typeof ALARM_PHASES)[number];

export const ALARM_LIMITS = {
  maxDelaySec: 24 * 60 * 60,
  maxRulesPerDevice: 64,
} as const;

export interface AlarmLimits {
  min: number | null;
  max: number | null;
  /** The value must stay outside the range this long before the alarm opens. */
  delaySec: number;
  /** The value must come back this far inside the range before the alarm closes. */
  hysteresis: number;
}

export interface AlarmRule extends AlarmLimits {
  id: string;
  deviceId: string;
  metric: string;
  severity: Severity;
  enabled: boolean;
  phase: AlarmPhase;
}

/** threshold = a rule's range was crossed; offline = the device stopped reporting. */
export const ALARM_KINDS = ["threshold", "offline"] as const;
export type AlarmKind = (typeof ALARM_KINDS)[number];

export interface AlarmEvent {
  id: string;
  kind: AlarmKind;
  orgId: string;
  deviceId: string;
  ruleId: string | null;
  metric: string;
  severity: Severity;
  min: number | null;
  max: number | null;
  /** threshold: when the value left the range; offline: the device's last contact. */
  startedAt: number;
  /** null for offline alarms. */
  startValue: number | null;
  endedAt: number | null;
  endValue: number | null;
  acknowledgedAt: number | null;
  acknowledgedBy: string | null;
}

const finite = z.number().finite();

export const alarmRuleInputSchema = z
  .object({
    metric: z.string().regex(/^[a-z][a-z0-9_]{0,31}$/),
    severity: z.enum(SEVERITIES),
    min: finite.nullable().default(null),
    max: finite.nullable().default(null),
    delaySec: z.number().int().min(0).max(ALARM_LIMITS.maxDelaySec).default(0),
    hysteresis: finite.min(0).default(0),
    enabled: z.boolean().default(true),
  })
  .superRefine((r, ctx) => {
    if (r.min === null && r.max === null) ctx.addIssue({ code: "custom", message: "Set a minimum, a maximum or both." });
    if (r.min !== null && r.max !== null) {
      if (r.min >= r.max) ctx.addIssue({ code: "custom", path: ["max"], message: "Maximum must be greater than minimum." });
      else if (r.hysteresis * 2 >= r.max - r.min)
        ctx.addIssue({ code: "custom", path: ["hysteresis"], message: "Hysteresis must be less than half the range." });
    }
  });
export type AlarmRuleInput = z.infer<typeof alarmRuleInputSchema>;

export const alarmRulesBodySchema = z
  .object({ rules: z.array(alarmRuleInputSchema).max(ALARM_LIMITS.maxRulesPerDevice) })
  .superRefine((b, ctx) => {
    const seen = new Set<string>();
    b.rules.forEach((r, i) => {
      const k = `${r.metric}/${r.severity}`;
      if (seen.has(k)) ctx.addIssue({ code: "custom", path: ["rules", i], message: `Duplicate rule for ${k}.` });
      seen.add(k);
    });
  });

export function isOutside(l: Pick<AlarmLimits, "min" | "max">, value: number): boolean {
  return (l.min !== null && value < l.min) || (l.max !== null && value > l.max);
}

/** Back inside the range by at least the hysteresis margin. */
export function isRecovered(l: Pick<AlarmLimits, "min" | "max" | "hysteresis">, value: number): boolean {
  return (l.min === null || value >= l.min + l.hysteresis) && (l.max === null || value <= l.max - l.hysteresis);
}

export interface AlarmPhaseState {
  phase: AlarmPhase;
  /** pending: when the value first left the range; active: when the alarm opened. */
  since: number | null;
}

export type AlarmTransition =
  | { kind: "none" }
  | { kind: "open"; startedAt: number }
  | { kind: "close"; endedAt: number };

/**
 * Pure state machine, evaluated on each newer reading of the metric.
 * normal → pending when the value leaves the range (or straight to active when delay is 0),
 * pending → active once it has stayed outside for delaySec, pending → normal if it returns,
 * active → normal only after it is back inside by the hysteresis margin.
 */
export function evaluateAlarm(
  limits: AlarmLimits,
  state: AlarmPhaseState,
  value: number,
  time: number,
): { state: AlarmPhaseState; transition: AlarmTransition } {
  const outside = isOutside(limits, value);
  const delayMs = limits.delaySec * 1000;

  if (state.phase === "active") {
    if (isRecovered(limits, value)) return { state: { phase: "normal", since: null }, transition: { kind: "close", endedAt: time } };
    return { state, transition: { kind: "none" } };
  }

  if (!outside) return { state: { phase: "normal", since: null }, transition: { kind: "none" } };

  const since = state.phase === "pending" && state.since !== null ? state.since : time;
  if (time - since >= delayMs) {
    return { state: { phase: "active", since }, transition: { kind: "open", startedAt: since } };
  }
  return { state: { phase: "pending", since }, transition: { kind: "none" } };
}
