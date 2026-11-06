import type { NotificationTarget } from "@dotwatch/shared";

/** Short, recognisable form of an address: emails in full, LINE ids by type and last characters. */
export function addressLabel(t: Pick<NotificationTarget, "kind" | "address">): string {
  if (!t.address) return "ยังไม่ได้เชื่อม";
  if (t.kind === "email") return t.address;
  const type = t.address.startsWith("C") ? "กลุ่ม LINE" : t.address.startsWith("R") ? "ห้องแชท LINE" : "ผู้ใช้ LINE";
  return `${type} …${t.address.slice(-6)}`;
}

export type TargetState = "linked" | "waiting" | "expired" | "error" | "off";

export function targetState(t: NotificationTarget, now: number): TargetState {
  if (!t.enabled) return "off";
  if (!t.address) return t.linkExpiresAt && t.linkExpiresAt > now ? "waiting" : "expired";
  if (t.lastError && !t.lastError.startsWith("ยังไม่ได้ใส่ key")) return "error";
  return "linked";
}

export const REPEAT_CHOICES = [10, 15, 30, 60, 120];
