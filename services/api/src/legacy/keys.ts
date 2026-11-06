import { createDecipheriv } from "node:crypto";
import { LINE_ID, type Severity } from "@dotwatch/shared";

/** Old metric keys were free text ("Temp 1", "CH-03"). New keys must be snake_case and start with a letter. */
export function normalizeMetricKey(raw: string): string {
  let k = raw.trim().toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/_+/g, "_").replace(/^_|_$/g, "");
  if (!k) k = "metric";
  if (!/^[a-z]/.test(k)) k = `m_${k}`;
  return k.slice(0, 48);
}

/** Old roles: owner, admin, operator, viewer. */
export function mapRole(old: string): "owner" | "admin" | "member" | "viewer" {
  const r = old.trim().toLowerCase();
  if (r === "owner" || r === "admin" || r === "viewer") return r;
  return "member";
}

export function mapSeverity(old: string | null): Severity {
  return ["critical", "high", "danger", "alarm"].includes((old ?? "").trim().toLowerCase()) ? "critical" : "warning";
}

export interface OldRule {
  id: string;
  operator: string;
  threshold: number;
  active: boolean;
}

export type MergedRule =
  | { ok: true; min: number | null; max: number | null; enabled: boolean; ruleIds: string[] }
  | { ok: false; reason: string; ruleIds: string[] };

/**
 * Old rules were one comparison each ("> 8"). Rules on the same device, metric and severity merge into one
 * range: every "greater than" becomes the upper limit (the lowest one wins) and every "less than" the lower
 * limit (the highest one wins). ">" and ">=" both map to max — the new rule fires strictly above max, so an
 * old ">= 8" no longer fires at exactly 8.0; noted in the report.
 */
export function mergeRules(rules: OldRule[]): MergedRule {
  const ids = rules.map((r) => r.id);
  let min: number | null = null;
  let max: number | null = null;
  for (const r of rules) {
    const op = r.operator.trim();
    if (op === ">" || op === ">=") max = max === null ? r.threshold : Math.min(max, r.threshold);
    else if (op === "<" || op === "<=") min = min === null ? r.threshold : Math.max(min, r.threshold);
    else return { ok: false, reason: `ตัวเปรียบเทียบ "${op}" แปลงเป็นช่วงปกติไม่ได้`, ruleIds: ids };
  }
  if (min !== null && max !== null && min >= max) return { ok: false, reason: `ค่าต่ำสุด ${min} ไม่น้อยกว่าค่าสูงสุด ${max}`, ruleIds: ids };
  return { ok: true, min, max, enabled: rules.some((r) => r.active), ruleIds: ids };
}

/** Old event limits from its single comparison. */
export function eventLimits(operator: string | null, threshold: number | null): { min: number | null; max: number | null } {
  if (threshold === null || !operator) return { min: null, max: null };
  const op = operator.trim();
  if (op === ">" || op === ">=") return { min: null, max: threshold };
  if (op === "<" || op === "<=") return { min: threshold, max: null };
  return { min: null, max: null };
}

/** Old AES-256-GCM format `v1:<iv>:<tag>:<data>` (base64), key as 32 bytes base64 or 64 hex. */
export function decryptOldSecret(payload: string, rawKey: string): string | null {
  const parts = payload.split(":");
  if (parts.length !== 4 || parts[0] !== "v1") return null;
  const value = rawKey.trim();
  let key = Buffer.from(value, "base64");
  if (key.length !== 32 && /^[0-9a-f]{64}$/i.test(value)) key = Buffer.from(value, "hex");
  if (key.length !== 32) throw new Error("LEGACY_SECRET_KEY must be 32 bytes as base64 or 64 hex characters");
  try {
    const d = createDecipheriv("aes-256-gcm", key, Buffer.from(parts[1]!, "base64"));
    d.setAuthTag(Buffer.from(parts[2]!, "base64"));
    return Buffer.concat([d.update(Buffer.from(parts[3]!, "base64")), d.final()]).toString("utf8");
  } catch {
    return null;
  }
}

export const isLineId = (s: string | null): s is string => !!s && LINE_ID.test(s.trim());
