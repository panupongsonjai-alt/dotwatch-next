import { z } from "zod";

/**
 * History (ADR 0001, decision 11 / old 6.8): one request returns every metric asked for,
 * already bucketed so a chart never gets more points than it can draw.
 */
export const HISTORY_LIMITS = {
  maxMetrics: 8,
  maxRangeMs: 366 * 24 * 60 * 60 * 1000,
  targetPoints: 360,
} as const;

/** Bucket sizes that line up with clock time. Largest is 6 h so buckets never straddle a timezone question. */
export const BUCKET_STEPS_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000, 3 * 60 * 60_000, 6 * 60 * 60_000] as const;

export function pickBucketMs(fromMs: number, toMs: number): number {
  const ideal = (toMs - fromMs) / HISTORY_LIMITS.targetPoints;
  return BUCKET_STEPS_MS.find((s) => s >= ideal) ?? BUCKET_STEPS_MS[BUCKET_STEPS_MS.length - 1]!;
}

export const HISTORY_RANGES = {
  "6h": 6 * 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
} as const;
export type HistoryRange = keyof typeof HISTORY_RANGES;

export const historyQuerySchema = z
  .object({
    metrics: z
      .string()
      .transform((s) => [...new Set(s.split(",").map((m) => m.trim()).filter(Boolean))])
      .pipe(z.array(z.string().regex(/^[a-z][a-z0-9_]{0,47}$/)).min(1).max(HISTORY_LIMITS.maxMetrics)),
    from: z.coerce.number().int().positive(),
    to: z.coerce.number().int().positive(),
  })
  .refine((q) => q.to > q.from, { message: "to must be after from", path: ["to"] })
  .refine((q) => q.to - q.from <= HISTORY_LIMITS.maxRangeMs, { message: "range is too long", path: ["from"] });

export interface HistoryPoint {
  /** Bucket start, epoch ms. */
  t: number;
  avg: number;
  min: number;
  max: number;
  /** Readings in the bucket. */
  n: number;
  /** At least one reading arrived late from a device queue. */
  backfilled: boolean;
}

export interface HistoryResponse {
  from: number;
  to: number;
  bucketMs: number;
  series: Record<string, HistoryPoint[]>;
}
