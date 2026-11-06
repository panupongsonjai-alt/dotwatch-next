import { describe, expect, it } from "vitest";
import type { Device, HistoryPoint } from "@dotwatch/shared";
import { bandPath, linePath, nearest, niceTicks, segments, timeTicks, yDomain } from "../src/lib/chart";
import { parseRoute } from "../src/lib/route";
import { devicesReducer, durationText } from "../src/lib/devices";

const p = (t: number, avg: number): HistoryPoint => ({ t, avg, min: avg - 1, max: avg + 1, n: 1, backfilled: false });

describe("chart math", () => {
  it("breaks the line where buckets are missing", () => {
    const segs = segments([p(0, 1), p(60, 1), p(120, 1), p(600, 1), p(660, 1)], 60);
    expect(segs.map((s) => s.length)).toEqual([3, 2]);
    expect(linePath(segs, 60, (t) => t, (v) => v)).toBe("M30,1L90,1L150,1M630,1L690,1");
    expect(bandPath([[p(0, 5)]], 60, (t) => t, (v) => v)).toBe("M30,6L30,4Z");
  });
  it("pads the y range and includes alarm limits", () => {
    const [lo, hi] = yDomain([p(0, 4)], [8]);
    expect(lo).toBeLessThan(3);
    expect(hi).toBeGreaterThan(8);
    expect(yDomain([])).toEqual([0, 1]);
  });
  it("picks round ticks", () => {
    expect(niceTicks(0, 10, 5)).toEqual([0, 2, 4, 6, 8, 10]);
    expect(niceTicks(2.3, 4.1, 4)).toEqual([2.5, 3, 3.5, 4]);
  });
  it("finds the bucket under the pointer only when close", () => {
    const pts = [p(0, 1), p(60, 2)];
    expect(nearest(pts, 95, 60)?.avg).toBe(2);
    expect(nearest(pts, 1000, 60)).toBeNull();
  });
  it("puts at most a handful of time ticks on whole hours or days", () => {
    const from = new Date(2026, 10, 6, 9, 17).getTime();
    const day = timeTicks(from, from + 24 * 3_600_000);
    expect(day.length).toBeGreaterThan(2);
    expect(day.length).toBeLessThanOrEqual(7);
    expect(day.every((t) => new Date(t).getMinutes() === 0)).toBe(true);
    const month = timeTicks(from, from + 30 * 86_400_000);
    expect(month.every((t) => new Date(t).getHours() === 0)).toBe(true);
    expect(month.length).toBeLessThanOrEqual(7);
  });
});

describe("routes", () => {
  it("parses the device page and falls back to the overview", () => {
    expect(parseRoute("#/devices/2071F64A-BC3D-4343-AD74-3D68A4C6D02F")).toEqual({ name: "device", id: "2071f64a-bc3d-4343-ad74-3d68a4c6d02f" });
    expect(parseRoute("#/")).toEqual({ name: "overview" });
    expect(parseRoute("#/devices/nope")).toEqual({ name: "overview" });
  });
});

describe("device list updates", () => {
  const d: Device = { id: "d1", orgId: "o1", code: "A", name: "A", lastSeenAt: 5000, firmwareVersion: null, offlineAfterSec: 900, latest: { temperature: { time: 5000, value: 4 } } };
  it("keeps newer live values when the server returns an older copy", () => {
    const s = devicesReducer({ d1: d }, { type: "upsert", device: { ...d, name: "B", lastSeenAt: 1000, latest: { temperature: { time: 1000, value: 9 } } } });
    expect(s.d1).toMatchObject({ name: "B", lastSeenAt: 5000, latest: { temperature: { value: 4 } } });
  });
  it("removes a deleted device", () => {
    expect(devicesReducer({ d1: d }, { type: "remove", deviceId: "d1" })).toEqual({});
  });
  it("formats durations", () => {
    expect(durationText(900)).toBe("15 นาที");
    expect(durationText(5400)).toBe("1 ชั่วโมง 30 นาที");
  });
});
