import { describe, expect, it } from "vitest";
import type { NotificationTarget } from "@dotwatch/shared";
import { addressLabel, targetState } from "../src/lib/notify";
import { parseRoute } from "../src/lib/route";

const t = (over: Partial<NotificationTarget> = {}): NotificationTarget => ({
  id: "t", kind: "line", name: "x", address: `C${"a".repeat(26)}123abc`, minSeverity: "warning", enabled: true,
  linkCode: null, linkExpiresAt: null, lastSentAt: null, lastError: null, ...over,
});

describe("recipient display", () => {
  it("labels LINE ids by type without showing the whole id", () => {
    expect(addressLabel(t())).toBe("กลุ่ม LINE …123abc");
    expect(addressLabel(t({ address: `U${"0".repeat(32)}` }))).toBe("ผู้ใช้ LINE …000000");
    expect(addressLabel(t({ kind: "email", address: "a@b.co" }))).toBe("a@b.co");
    expect(addressLabel(t({ address: null }))).toBe("ยังไม่ได้เชื่อม");
  });
  it("derives a state for the list", () => {
    expect(targetState(t({ address: null, linkCode: "ABCDEF", linkExpiresAt: 2000 }), 1000)).toBe("waiting");
    expect(targetState(t({ address: null, linkCode: "ABCDEF", linkExpiresAt: 500 }), 1000)).toBe("expired");
    expect(targetState(t({ lastError: "HTTP 400" }), 0)).toBe("error");
    expect(targetState(t({ lastError: "ยังไม่ได้ใส่ key ของช่องทางนี้" }), 0)).toBe("linked");
    expect(targetState(t({ enabled: false }), 0)).toBe("off");
  });
  it("routes to the notifications page", () => {
    expect(parseRoute("#/settings/notifications")).toEqual({ name: "notifications" });
  });
});
