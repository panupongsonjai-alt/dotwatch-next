import { describe, expect, it } from "vitest";
import {
  can, checkReadingTime, ingestBatchSchema, INGEST_LIMITS, mergeLatest, reconnectDelayMs,
} from "../src";

describe("can()", () => {
  it("viewer reads but cannot edit", () => {
    expect(can("viewer", "device.read")).toBe(true);
    expect(can("viewer", "alarm.edit")).toBe(false);
  });
  it("member edits alarms but cannot create devices", () => {
    expect(can("member", "alarm.edit")).toBe(true);
    expect(can("member", "device.create")).toBe(false);
  });
  it("only owner deletes the org", () => {
    expect(can("admin", "org.delete")).toBe(false);
    expect(can("owner", "org.delete")).toBe(true);
  });
  it("no role means no access", () => {
    expect(can(null, "device.read")).toBe(false);
    expect(can(undefined, "device.read")).toBe(false);
  });
});

describe("ingest contract", () => {
  it("accepts a normal batch", () => {
    const r = ingestBatchSchema.safeParse({ fw: "1.0.0", readings: [{ t: 1, m: { temperature: 4.2, humidity: 61 } }] });
    expect(r.success).toBe(true);
  });
  it("rejects bad metric keys, empty metrics and NaN", () => {
    expect(ingestBatchSchema.safeParse({ readings: [{ m: { Temperature: 1 } }] }).success).toBe(false);
    expect(ingestBatchSchema.safeParse({ readings: [{ m: {} }] }).success).toBe(false);
    expect(ingestBatchSchema.safeParse({ readings: [{ m: { t: Number.NaN } }] }).success).toBe(false);
  });
  it("rejects oversized batches", () => {
    const readings = Array.from({ length: INGEST_LIMITS.maxReadingsPerBatch + 1 }, () => ({ m: { a: 1 } }));
    expect(ingestBatchSchema.safeParse({ readings }).success).toBe(false);
  });
  it("classifies reading times", () => {
    const now = 1_800_000_000_000;
    expect(checkReadingTime(undefined, now)).toEqual({ ok: true, time: now, backfilled: false });
    expect(checkReadingTime(now - 30_000, now)).toMatchObject({ ok: true, backfilled: false });
    expect(checkReadingTime(now - 3_600_000, now)).toMatchObject({ ok: true, backfilled: true });
    expect(checkReadingTime(now - INGEST_LIMITS.maxAgeMs - 1, now)).toEqual({ ok: false, reason: "too_old" });
    expect(checkReadingTime(now + INGEST_LIMITS.maxFutureSkewMs + 1, now)).toEqual({ ok: false, reason: "in_future" });
    // small drift into the future is clamped to server time
    expect(checkReadingTime(now + 1000, now)).toMatchObject({ ok: true, time: now });
  });
});

describe("realtime helpers", () => {
  it("keeps newest value per device+metric", () => {
    const out = mergeLatest([
      { deviceId: "a", metric: "t", time: 2, value: 2 },
      { deviceId: "a", metric: "t", time: 1, value: 1 },
      { deviceId: "a", metric: "h", time: 1, value: 50 },
    ]);
    expect(out).toHaveLength(2);
    expect(out.find((v) => v.metric === "t")?.value).toBe(2);
  });
  it("backs off but never gives up", () => {
    expect(reconnectDelayMs(0, () => 0)).toBe(500);
    expect(reconnectDelayMs(100, () => 1)).toBe(30_000);
  });
});

import { historyQuerySchema, pickBucketMs, updateDeviceSchema } from "../src/index";

describe("history", () => {
  it("keeps charts under the point budget with clock-aligned buckets", () => {
    const h = 60 * 60 * 1000;
    expect(pickBucketMs(0, 6 * h)).toBe(60_000);
    expect(pickBucketMs(0, 24 * h)).toBe(5 * 60_000);
    expect(pickBucketMs(0, 7 * 24 * h)).toBe(60 * 60_000);
    expect(pickBucketMs(0, 30 * 24 * h)).toBe(3 * 60 * 60_000);
    expect(pickBucketMs(0, 365 * 24 * h)).toBe(6 * 60 * 60_000);
  });
  it("parses a metric list and rejects bad ranges", () => {
    expect(historyQuerySchema.parse({ metrics: "temperature, humidity,temperature", from: "1", to: "2" }).metrics).toEqual(["temperature", "humidity"]);
    expect(historyQuerySchema.safeParse({ metrics: "temperature", from: "5", to: "2" }).success).toBe(false);
    expect(historyQuerySchema.safeParse({ metrics: "", from: "1", to: "2" }).success).toBe(false);
  });
});

describe("device updates", () => {
  it("accepts a rename or an offline threshold, not nothing", () => {
    expect(updateDeviceSchema.safeParse({ name: "ห้อง 2" }).success).toBe(true);
    expect(updateDeviceSchema.safeParse({ offlineAfterSec: null }).success).toBe(true);
    expect(updateDeviceSchema.safeParse({ offlineAfterSec: 30 }).success).toBe(false);
    expect(updateDeviceSchema.safeParse({}).success).toBe(false);
  });
});
