import { formatMetric, metricMeta, type AlarmEvent, type MetricSetting } from "@dotwatch/shared";

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
  /** The device's own name/unit for the alarm's metric, if set. */
  metricSetting?: MetricSetting | null;
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

function what(e: AlarmEvent, fmt: (v: number) => string, label: string): string {
  if (e.kind === "offline") return "ขาดการติดต่อ ไม่ส่งค่าเข้ามา";
  if (e.startValue !== null && e.max !== null && e.startValue > e.max) return `${label} สูงกว่า ${fmt(e.max)}`;
  if (e.startValue !== null && e.min !== null && e.startValue < e.min) return `${label} ต่ำกว่า ${fmt(e.min)}`;
  return `${label} ออกนอกช่วงปกติ`;
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
  const settings = c.metricSetting ? { [e.metric]: c.metricSetting } : undefined;
  const fmt = (v: number) => formatMetric(settings, e.metric, v);
  const label = metricMeta(settings, e.metric).label;
  const device = c.deviceName ?? "อุปกรณ์";
  const level = e.severity === "critical" ? "วิกฤต" : "เตือน";
  const link = `${c.appUrl}/#/devices/${e.deviceId}`;

  if (c.reason === "closed") {
    const how =
      e.endValue !== null
        ? `กลับสู่ปกติ (${label} ${fmt(e.endValue)})`
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
  const value = e.kind === "threshold" && e.startValue !== null ? ` (ค่า ${fmt(e.startValue)})` : "";
  const since = e.kind === "offline" ? `ติดต่อล่าสุด ${time(e.startedAt, c.timeZone)}` : `เริ่ม ${time(e.startedAt, c.timeZone)}`;
  const head = c.reason === "reminder" ? `⏰ ยังไม่มีผู้รับทราบ (เตือนซ้ำครั้งที่ ${c.reminderNo}/${c.maxReminders})\n` : "";
  return {
    subject: `${icon} ${level}: ${device} — ${what(e, fmt, label)}`,
    text: `${head}${icon} ${level}: ${device}\n${what(e, fmt, label)}${value}\n${since}\nกดรับทราบ: ${link}`,
  };
}
