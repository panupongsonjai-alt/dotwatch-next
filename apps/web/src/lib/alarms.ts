import { ALARM_LIMITS, alarmRulesBodySchema, type AlarmEvent, type AlarmRule, type AlarmRuleInput, type Severity } from "@dotwatch/shared";
import { describeMetric, durationText, formatValue } from "./devices";

/** Open alarms of the selected organization, keyed by event id. */
export type OpenAlarms = Record<string, AlarmEvent>;

export type AlarmAction = { type: "load"; events: AlarmEvent[] } | { type: "event"; event: AlarmEvent };

export function alarmsReducer(state: OpenAlarms, action: AlarmAction): OpenAlarms {
  switch (action.type) {
    case "load":
      return Object.fromEntries(action.events.filter((e) => e.endedAt === null).map((e) => [e.id, e]));
    case "event": {
      const e = action.event;
      if (e.endedAt !== null) {
        if (!state[e.id]) return state;
        const { [e.id]: _closed, ...rest } = state;
        return rest;
      }
      return { ...state, [e.id]: e };
    }
  }
}

const SEVERITY_RANK: Record<Severity, number> = { critical: 0, warning: 1 };

/** Critical first, then not yet acknowledged, then newest. */
export function sortAlarms(events: AlarmEvent[]): AlarmEvent[] {
  return [...events].sort(
    (a, b) =>
      SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
      Number(a.acknowledgedAt !== null) - Number(b.acknowledgedAt !== null) ||
      b.startedAt - a.startedAt,
  );
}

/** The most severe open alarm per device. */
export function worstByDevice(events: AlarmEvent[]): Record<string, Severity> {
  const out: Record<string, Severity> = {};
  for (const e of events) {
    const cur = out[e.deviceId];
    if (!cur || SEVERITY_RANK[e.severity] < SEVERITY_RANK[cur]) out[e.deviceId] = e.severity;
  }
  return out;
}

export const SEVERITY_LABEL: Record<Severity, string> = { warning: "เตือน", critical: "วิกฤต" };

const fmt = formatValue;

/** "สูงกว่า 4.0 °C" / "ต่ำกว่า 2.0 °C" / "นอกช่วง 2.0–8.0 °C" for the value that opened the alarm. */
export function describeBreach(e: Pick<AlarmEvent, "metric" | "min" | "max" | "startValue">): string {
  const v = e.startValue;
  if (v !== null && e.max !== null && v > e.max) return `สูงกว่า ${fmt(e.metric, e.max)}`;
  if (v !== null && e.min !== null && v < e.min) return `ต่ำกว่า ${fmt(e.metric, e.min)}`;
  if (e.min !== null && e.max !== null) return `นอกช่วง ${fmt(e.metric, e.min)} – ${fmt(e.metric, e.max)}`;
  return "ออกนอกช่วงปกติ";
}

/** One line for any alarm: "อุณหภูมิ สูงกว่า 8.0 °C" or "ขาดการติดต่อ" */
export function describeAlarm(e: AlarmEvent): string {
  if (e.kind === "offline") return "ขาดการติดต่อ ไม่ส่งค่าเข้ามา";
  return `${describeMetric(e.metric).label} ${describeBreach(e)}`;
}

/** "ช่วง 08:15–09:40 (1 ชั่วโมง 25 นาที)" style duration for a closed or open alarm. */
export function alarmDuration(e: AlarmEvent, now: number): string {
  return durationText(Math.max(60, ((e.endedAt ?? now) - e.startedAt) / 1000));
}

/* ---------- rule editor form ---------- */

/** What the user types: strings, so a half-typed number is not lost. */
export interface RuleDraft {
  key: string;
  metric: string;
  severity: Severity;
  min: string;
  max: string;
  delayMin: string;
  hysteresis: string;
  enabled: boolean;
}

export type DraftErrors = Record<string, string[]>;

let seq = 0;
const newKey = () => `r${++seq}`;

const numText = (n: number | null) => (n === null ? "" : String(n));

export function toDraft(rule: AlarmRule): RuleDraft {
  return {
    key: rule.id,
    metric: rule.metric,
    severity: rule.severity,
    min: numText(rule.min),
    max: numText(rule.max),
    delayMin: String(Math.round((rule.delaySec / 60) * 100) / 100),
    hysteresis: String(rule.hysteresis),
    enabled: rule.enabled,
  };
}

export function blankDraft(metric: string, severity: Severity = "warning"): RuleDraft {
  return { key: newKey(), metric, severity, min: "", max: "", delayMin: "0", hysteresis: "0", enabled: true };
}

/** Empty text → null; otherwise a finite number or undefined (invalid). Accepts a comma as the decimal mark. */
export function parseNumber(text: string): number | null | undefined {
  const t = text.trim().replace(",", ".");
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Turns the form into API input. Errors are in Thai, keyed by draft key ("" = whole form).
 * Mirrors the shared schema, which runs afterwards as a final guard.
 */
export function draftsToInput(drafts: RuleDraft[]): { rules: AlarmRuleInput[]; errors: DraftErrors } {
  const errors: DraftErrors = {};
  const add = (key: string, msg: string) => (errors[key] ??= []).push(msg);
  const rules: AlarmRuleInput[] = [];
  const seen = new Map<string, string>();

  if (drafts.length > ALARM_LIMITS.maxRulesPerDevice) add("", `ตั้งได้ไม่เกิน ${ALARM_LIMITS.maxRulesPerDevice} กฎต่ออุปกรณ์`);

  for (const d of drafts) {
    const metric = d.metric.trim();
    const min = parseNumber(d.min);
    const max = parseNumber(d.max);
    const delayMin = parseNumber(d.delayMin);
    const hysteresis = parseNumber(d.hysteresis);

    if (!/^[a-z][a-z0-9_]{0,31}$/.test(metric)) add(d.key, "ชื่อค่าที่วัดต้องเป็นตัวอักษรอังกฤษพิมพ์เล็ก ตัวเลข หรือ _ เช่น temperature");
    if (min === undefined) add(d.key, "ค่าต่ำสุดต้องเป็นตัวเลข");
    if (max === undefined) add(d.key, "ค่าสูงสุดต้องเป็นตัวเลข");
    if (min === null && max === null) add(d.key, "ใส่ค่าต่ำสุด ค่าสูงสุด หรือทั้งสองค่า");
    if (typeof min === "number" && typeof max === "number" && min >= max) add(d.key, "ค่าสูงสุดต้องมากกว่าค่าต่ำสุด");
    if (delayMin === undefined || delayMin === null || delayMin < 0 || delayMin * 60 > ALARM_LIMITS.maxDelaySec)
      add(d.key, `เวลารอต้องอยู่ระหว่าง 0 ถึง ${ALARM_LIMITS.maxDelaySec / 60} นาที`);
    if (hysteresis === undefined || hysteresis === null || hysteresis < 0) add(d.key, "ระยะกันกะพริบต้องเป็นตัวเลขตั้งแต่ 0 ขึ้นไป");
    else if (typeof min === "number" && typeof max === "number" && min < max && hysteresis * 2 >= max - min)
      add(d.key, "ระยะกันกะพริบต้องน้อยกว่าครึ่งหนึ่งของช่วงปกติ");

    const dupKey = `${metric}/${d.severity}`;
    if (seen.has(dupKey)) add(d.key, `มีกฎ "${describeMetric(metric).label} · ${SEVERITY_LABEL[d.severity]}" ซ้ำแล้ว`);
    seen.set(dupKey, d.key);

    if (!errors[d.key]) {
      rules.push({
        metric,
        severity: d.severity,
        min: min ?? null,
        max: max ?? null,
        delaySec: Math.round((delayMin ?? 0) * 60),
        hysteresis: hysteresis ?? 0,
        enabled: d.enabled,
      });
    }
  }

  if (Object.keys(errors).length === 0) {
    const check = alarmRulesBodySchema.safeParse({ rules });
    if (!check.success) add("", check.error.issues.map((i) => i.message).join("; "));
  }
  return { rules, errors };
}
