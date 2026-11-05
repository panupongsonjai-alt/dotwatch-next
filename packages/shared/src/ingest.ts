import { z } from "zod";

/**
 * Device ↔ backend contract, version 1 (ADR 0001, decision 10).
 * Same shape for ESP firmware and the Pi agent.
 */
export const INGEST_LIMITS = {
  maxReadingsPerBatch: 500,
  maxMetricsPerReading: 64,
  /** Readings older than this are rejected individually (decision 11: backfill up to 7 days). */
  maxAgeMs: 7 * 24 * 60 * 60 * 1000,
  /** Tolerate small clock drift on the device. */
  maxFutureSkewMs: 5 * 60 * 1000,
  /** Older than this at arrival = marked as backfill (shaded in charts). */
  backfillThresholdMs: 60 * 1000,
} as const;

export const metricKeySchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]{0,47}$/, "metric key must be snake_case, max 48 chars");

const metricsSchema = z
  .record(metricKeySchema, z.number().finite())
  .refine((m) => Object.keys(m).length > 0, "at least one metric")
  .refine((m) => Object.keys(m).length <= INGEST_LIMITS.maxMetricsPerReading, "too many metrics");

export const ingestReadingSchema = z.object({
  /** Epoch milliseconds measured on the device. Omit if the device has no clock yet; server time is used. */
  t: z.number().int().positive().optional(),
  m: metricsSchema,
});

export const ingestBatchSchema = z.object({
  fw: z.string().max(32).optional(),
  readings: z.array(ingestReadingSchema).min(1).max(INGEST_LIMITS.maxReadingsPerBatch),
});

export type IngestReading = z.infer<typeof ingestReadingSchema>;
export type IngestBatch = z.infer<typeof ingestBatchSchema>;

export type DeviceCommand =
  | { type: "set_interval"; seconds: number }
  | { type: "reboot" }
  | { type: "firmware_available"; version: string; url: string; sha256: string };

export interface IngestResponse {
  ok: true;
  accepted: number;
  /** Index into the request's readings + reason. Rejected items must be dropped by the device, never retried. */
  rejected: { index: number; reason: "too_old" | "in_future" }[];
  serverTime: number;
  commands: DeviceCommand[];
}

export type ReadingCheck = { ok: true; time: number; backfilled: boolean } | { ok: false; reason: "too_old" | "in_future" };

/** Pure decision for one reading — shared by API and tests. */
export function checkReadingTime(deviceTime: number | undefined, now: number): ReadingCheck {
  const time = deviceTime ?? now;
  if (time < now - INGEST_LIMITS.maxAgeMs) return { ok: false, reason: "too_old" };
  if (time > now + INGEST_LIMITS.maxFutureSkewMs) return { ok: false, reason: "in_future" };
  return { ok: true, time: Math.min(time, now), backfilled: now - time > INGEST_LIMITS.backfillThresholdMs };
}
