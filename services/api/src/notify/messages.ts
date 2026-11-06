import type { AlarmEvent } from "@dotwatch/shared";

/** Thai labels for message text. Kept here so the API does not depend on the web app. */
const METRICS: Record<string, { label: string; unit: string; digits: number }> = {
  temperature: { label: "อุณหภูมิ", unit: "°C", digits: 1 },
  humidity: { label: "ความชื้น", unit: "%", digits: 0 },
};
const metric = (k: string) => METRICS[k] ?? { label: k.replace(/_/g, " "), unit: "", digits: 2 };
const fmt = (k: string, v: number) => {
  const m = metric(k);
  return `${v.toFixed(m.digits)}${m.unit ? ` ${m.unit}` : ""}`;
};

export type Reason = "opened" | "closed" | "reminder" | "test";

export interface MessageContext {
  reason: Reason;
  reminderNo: number | null;
  maxReminders: number;
  event: AlarmEvent | null;
  deviceName: string | null;
  orgName: string;
  appUrl: string;
  timeZone: string;
}

export interface Message {
  subject: string;
  text: string;
}

function time(ms: number, tz: string): string {
  return new Intl.DateTimeFormat("th-TH", { timeZone: tz, day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(ms);
}

function minutes(ms: number): string {
  const m = Math.max(1, Math.round(ms / 60_000));
  if (m < 60) return `${m} นาที`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h} ชม. ${m % 60} นาที` : `${h} ชม.`;
}

function what(e: AlarmEvent): string {
  if (e.kind === "offline") return "ขาดการติดต่อ ไม่ส่งค่าเข้ามา";
  const m = metric(e.metric).label;
  if (e.startValue !== null && e.max !== null && e.startValue > e.max) return `${m} สูงกว่า ${fmt(e.metric, e.max)}`;
  if (e.startValue !== null && e.min !== null && e.startValue < e.min) return `${m} ต่ำกว่า ${fmt(e.metric, e.min)}`;
  return `${m} ออกนอกช่วงปกติ`;
}

/** Plain text that reads well in LINE and in email. */
export function buildMessage(c: MessageContext): Message {
  if (c.reason === "test" || !c.event) {
    return {
      subject: "dotWatch: ทดสอบการแจ้งเตือน",
      text: `ทดสอบการแจ้งเตือนจาก dotWatch (${c.orgName})\nถ้าได้รับข้อความนี้ แปลว่าช่องทางนี้พร้อมรับแจ้งเตือนแล้ว`,
    };
  }
  const e = c.event;
  const device = c.deviceName ?? "อุปกรณ์";
  const level = e.severity === "critical" ? "วิกฤต" : "เตือน";
  const link = `${c.appUrl}/#/devices/${e.deviceId}`;

  if (c.reason === "closed") {
    const how =
      e.endValue !== null
        ? `กลับสู่ปกติ (${metric(e.metric).label} ${fmt(e.metric, e.endValue)})`
        : e.kind === "offline"
          ? "กลับมาส่งค่าแล้ว หรือปิดการแจ้งเตือนขาดการติดต่อ"
          : "ปิดแล้ว เพราะมีการแก้กฎหรือลบอุปกรณ์";
    const end = e.endedAt ?? Date.now();
    return {
      subject: `✅ ${device}: ${how}`,
      text: `✅ ${device}\n${how}\nเวลา ${time(end, c.timeZone)} · นาน ${minutes(end - e.startedAt)}\n${link}`,
    };
  }

  const icon = e.severity === "critical" ? "🔴" : "🟠";
  const value = e.kind === "threshold" && e.startValue !== null ? ` (ค่า ${fmt(e.metric, e.startValue)})` : "";
  const since = e.kind === "offline" ? `ติดต่อล่าสุด ${time(e.startedAt, c.timeZone)}` : `เริ่ม ${time(e.startedAt, c.timeZone)}`;
  const head = c.reason === "reminder" ? `⏰ ยังไม่มีผู้รับทราบ (เตือนซ้ำครั้งที่ ${c.reminderNo}/${c.maxReminders})\n` : "";
  return {
    subject: `${icon} ${level}: ${device} — ${what(e)}`,
    text: `${head}${icon} ${level}: ${device}\n${what(e)}${value}\n${since}\nกดรับทราบ: ${link}`,
  };
}
