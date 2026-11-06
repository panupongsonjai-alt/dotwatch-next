import { describe, expect, it } from "vitest";
import type { AlarmEvent, AlarmRule } from "@dotwatch/shared";
import { alarmsReducer, blankDraft, describeBreach, draftsToInput, parseNumber, sortAlarms, toDraft, worstByDevice } from "../src/lib/alarms";

const event = (over: Partial<AlarmEvent> = {}): AlarmEvent => ({
  id: "e1", kind: "threshold", orgId: "o1", deviceId: "d1", ruleId: "r1", metric: "temperature", severity: "warning",
  min: 2, max: 8, startedAt: 1000, startValue: 9, endedAt: null, endValue: null, acknowledgedAt: null, acknowledgedBy: null,
  ...over,
});

describe("alarmsReducer", () => {
  it("keeps only open events on load", () => {
    const s = alarmsReducer({}, { type: "load", events: [event(), event({ id: "e2", endedAt: 2000, endValue: 5 })] });
    expect(Object.keys(s)).toEqual(["e1"]);
  });
  it("adds new events, updates acknowledged ones and drops closed ones", () => {
    let s = alarmsReducer({}, { type: "event", event: event() });
    s = alarmsReducer(s, { type: "event", event: event({ acknowledgedAt: 1500, acknowledgedBy: "u1" }) });
    expect(s.e1!.acknowledgedAt).toBe(1500);
    s = alarmsReducer(s, { type: "event", event: event({ endedAt: 3000, endValue: 6 }) });
    expect(s).toEqual({});
  });
  it("ignores a close for an alarm not on screen", () => {
    const s = alarmsReducer({}, { type: "load", events: [] });
    expect(alarmsReducer(s, { type: "event", event: event({ id: "x", endedAt: 1 }) })).toBe(s);
  });
});

describe("alarm display", () => {
  it("sorts critical, then unacknowledged, then newest", () => {
    const list = sortAlarms([
      event({ id: "old-warn", startedAt: 1 }),
      event({ id: "acked-crit", severity: "critical", acknowledgedAt: 5 }),
      event({ id: "new-warn", startedAt: 9 }),
      event({ id: "crit", severity: "critical" }),
    ]);
    expect(list.map((e) => e.id)).toEqual(["crit", "acked-crit", "new-warn", "old-warn"]);
  });
  it("marks each device with its worst open alarm", () => {
    expect(worstByDevice([event(), event({ id: "e2", severity: "critical" }), event({ id: "e3", deviceId: "d2" })])).toEqual({
      d1: "critical",
      d2: "warning",
    });
  });
  it("describes which limit was crossed", () => {
    expect(describeBreach(event())).toBe("สูงกว่า 8.0 °C");
    expect(describeBreach(event({ startValue: 1 }))).toBe("ต่ำกว่า 2.0 °C");
  });
});

describe("rule form", () => {
  const rule: AlarmRule = {
    id: "r1", deviceId: "d1", metric: "temperature", severity: "critical",
    min: 2, max: 8, delaySec: 300, hysteresis: 0.5, enabled: true, phase: "normal",
  };

  it("round-trips a saved rule", () => {
    const { rules, errors } = draftsToInput([toDraft(rule)]);
    expect(errors).toEqual({});
    expect(rules).toEqual([{ metric: "temperature", severity: "critical", min: 2, max: 8, delaySec: 300, hysteresis: 0.5, enabled: true }]);
  });
  it("parses blanks, commas and junk", () => {
    expect(parseNumber("")).toBeNull();
    expect(parseNumber(" 4,5 ")).toBe(4.5);
    expect(parseNumber("abc")).toBeUndefined();
  });
  it("accepts a max-only rule", () => {
    const d = { ...blankDraft("temperature"), max: "4" };
    expect(draftsToInput([d]).rules[0]).toMatchObject({ min: null, max: 4, delaySec: 0, hysteresis: 0 });
  });
  it("explains invalid rules in Thai", () => {
    const empty = blankDraft("temperature");
    const reversed = { ...blankDraft("humidity"), min: "8", max: "2" };
    const wide = { ...blankDraft("temperature", "critical"), min: "2", max: "8", hysteresis: "3" };
    const { rules, errors } = draftsToInput([empty, reversed, wide]);
    expect(rules).toEqual([]);
    expect(errors[empty.key]).toContain("ใส่ค่าต่ำสุด ค่าสูงสุด หรือทั้งสองค่า");
    expect(errors[reversed.key]).toContain("ค่าสูงสุดต้องมากกว่าค่าต่ำสุด");
    expect(errors[wide.key]).toContain("ระยะกันกะพริบต้องน้อยกว่าครึ่งหนึ่งของช่วงปกติ");
  });
  it("rejects two rules for the same metric and severity", () => {
    const a = { ...blankDraft("temperature"), max: "8" };
    const b = { ...blankDraft("temperature"), max: "9" };
    const { errors } = draftsToInput([a, b]);
    expect(errors[a.key]).toBeUndefined();
    expect(errors[b.key]?.[0]).toMatch(/ซ้ำ/);
  });
});

import { describeAlarm } from "../src/lib/alarms";
describe("offline alarms", () => {
  it("describes an offline alarm without a value", () => {
    expect(describeAlarm(event({ kind: "offline", metric: "connection", startValue: null, min: null, max: null }))).toBe("ขาดการติดต่อ ไม่ส่งค่าเข้ามา");
    expect(describeAlarm(event())).toBe("อุณหภูมิ สูงกว่า 8.0 °C");
  });
});
