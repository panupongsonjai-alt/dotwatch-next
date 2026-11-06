import { describe, expect, it } from "vitest";
import type { Device } from "@dotwatch/shared";
import { devicesReducer, freshness, isOffline, orderMetrics } from "../src/lib/devices";

const device = (over: Partial<Device> = {}): Device => ({
  id: "d1", orgId: "o1", code: "A", name: "A", lastSeenAt: 1000, firmwareVersion: null, offlineAfterSec: 900, metrics: {},
  latest: { temperature: { time: 1000, value: 4 } }, ...over,
});

describe("devicesReducer", () => {
  it("applies newer live values and ignores older ones", () => {
    let s = devicesReducer({}, { type: "load", devices: [device()] });
    s = devicesReducer(s, { type: "values", values: [{ deviceId: "d1", metric: "temperature", time: 2000, value: 5 }] });
    expect(s.d1!.latest.temperature!.value).toBe(5);
    const same = devicesReducer(s, { type: "values", values: [{ deviceId: "d1", metric: "temperature", time: 1500, value: 1 }] });
    expect(same).toBe(s);
  });
  it("ignores values for devices not on screen", () => {
    const s = devicesReducer({}, { type: "load", devices: [device()] });
    expect(devicesReducer(s, { type: "values", values: [{ deviceId: "x", metric: "t", time: 1, value: 1 }] })).toBe(s);
  });
  it("moves lastSeenAt forward only", () => {
    const s = devicesReducer({}, { type: "load", devices: [device()] });
    expect(devicesReducer(s, { type: "seen", deviceId: "d1", lastSeenAt: 500 })).toBe(s);
    expect(devicesReducer(s, { type: "seen", deviceId: "d1", lastSeenAt: 3000 }).d1!.lastSeenAt).toBe(3000);
  });
});

describe("display helpers", () => {
  it("drains freshness toward offline", () => {
    expect(freshness(1000, 1000)).toBe(1);
    expect(freshness(null, 1000)).toBe(0);
    expect(isOffline(0, 10 * 60_000)).toBe(true);
  });
  it("orders temperature, humidity, then others", () => {
    expect(orderMetrics(["pressure", "humidity", "temperature", "co2"])).toEqual(["temperature", "humidity", "co2", "pressure"]);
  });
});

import { describeMetric, formatValue } from "../src/lib/devices";
describe("per-device metric names", () => {
  const settings = { ch_1: { label: "ช่อง 1", unit: "bar", decimals: 2, sortOrder: 0, hidden: false }, rssi: { label: "สัญญาณ", unit: "dBm", decimals: 0, sortOrder: 5, hidden: true } };
  it("uses the device's label, unit, order and hides hidden metrics", () => {
    expect(describeMetric("ch_1", settings).label).toBe("ช่อง 1");
    expect(formatValue("ch_1", 1.5, settings)).toBe("1.50 bar");
    expect(orderMetrics(["temperature", "rssi", "ch_1"], settings)).toEqual(["ch_1", "temperature"]);
    expect(orderMetrics(["temperature", "rssi", "ch_1"], settings, true)).toEqual(["ch_1", "temperature", "rssi"]);
  });
});
