import { describe, expect, it } from "vitest";
import { alarmRuleInputSchema, alarmRulesBodySchema, evaluateAlarm, isOutside, isRecovered, type AlarmLimits, type AlarmPhaseState } from "../src";

const cold: AlarmLimits = { min: 2, max: 8, delaySec: 0, hysteresis: 0.5 };
const normal: AlarmPhaseState = { phase: "normal", since: null };

/** Feed readings in order and collect transitions. */
function run(limits: AlarmLimits, readings: [number, number][]) {
  let state = normal;
  const out: string[] = [];
  for (const [t, v] of readings) {
    const r = evaluateAlarm(limits, state, v, t);
    state = r.state;
    if (r.transition.kind === "open") out.push(`open@${r.transition.startedAt}`);
    if (r.transition.kind === "close") out.push(`close@${r.transition.endedAt}`);
  }
  return { out, state };
}

describe("alarm limits", () => {
  it("detects outside and recovered with hysteresis", () => {
    expect(isOutside(cold, 8.1)).toBe(true);
    expect(isOutside(cold, 8)).toBe(false);
    expect(isRecovered(cold, 7.6)).toBe(false);
    expect(isRecovered(cold, 7.5)).toBe(true);
    expect(isOutside({ min: null, max: 30 }, -100)).toBe(false);
  });
});

describe("evaluateAlarm", () => {
  it("opens immediately without delay and closes only after hysteresis", () => {
    const { out, state } = run(cold, [[1, 5], [2, 9], [3, 7.8], [4, 7.4], [5, 5]]);
    expect(out).toEqual(["open@2", "close@4"]);
    expect(state.phase).toBe("normal");
  });

  it("waits for the delay and starts the event when the value first left the range", () => {
    const limits = { ...cold, delaySec: 60 };
    const { out, state } = run(limits, [[0, 9], [30_000, 9.5], [59_000, 9.2], [61_000, 9.1]]);
    expect(out).toEqual(["open@0"]);
    expect(state).toEqual({ phase: "active", since: 0 });
  });

  it("cancels a pending alarm when the value returns before the delay", () => {
    const limits = { ...cold, delaySec: 60 };
    const { out, state } = run(limits, [[0, 9], [30_000, 7], [70_000, 9], [100_000, 9]]);
    expect(out).toEqual([]);
    expect(state).toEqual({ phase: "pending", since: 70_000 });
  });

  it("does not flap around the limit", () => {
    const { out } = run(cold, [[1, 8.2], [2, 7.9], [3, 8.1], [4, 7.9], [5, 8.3], [6, 7.0]]);
    expect(out).toEqual(["open@1", "close@6"]);
  });
});

describe("rule validation", () => {
  it("needs a limit, an ordered range and sane hysteresis", () => {
    expect(alarmRuleInputSchema.safeParse({ metric: "temperature", severity: "warning" }).success).toBe(false);
    expect(alarmRuleInputSchema.safeParse({ metric: "temperature", severity: "warning", min: 8, max: 2 }).success).toBe(false);
    expect(alarmRuleInputSchema.safeParse({ metric: "temperature", severity: "warning", min: 2, max: 8, hysteresis: 3 }).success).toBe(false);
    expect(alarmRuleInputSchema.parse({ metric: "temperature", severity: "critical", max: 10 })).toMatchObject({ min: null, delaySec: 0, hysteresis: 0, enabled: true });
  });
  it("rejects duplicate metric + severity", () => {
    const rule = { metric: "temperature", severity: "warning", max: 8 };
    expect(alarmRulesBodySchema.safeParse({ rules: [rule, rule] }).success).toBe(false);
  });
});
