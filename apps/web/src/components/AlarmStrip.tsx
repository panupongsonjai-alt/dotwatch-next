import { useState } from "react";
import type { AlarmEvent, Device } from "@dotwatch/shared";
import { ago, formatValue } from "../lib/devices";
import { describeAlarm, SEVERITY_LABEL } from "../lib/alarms";
import { deviceHref } from "../lib/route";

interface Props {
  events: AlarmEvent[];
  devices: Record<string, Device>;
  now: number;
  canAck: boolean;
  onAck: (id: string) => Promise<void>;
}

/** Open alarms of the organization, most urgent first. Hidden when there are none. */
export function AlarmStrip({ events, devices, now, canAck, onAck }: Props) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (events.length === 0) return null;

  async function ack(id: string) {
    setBusy(id);
    setError(null);
    try {
      await onAck(id);
    } catch {
      setError("รับทราบไม่สำเร็จ ลองใหม่อีกครั้ง");
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="alarms" aria-labelledby="alarms-title">
      <h2 id="alarms-title">
        แจ้งเตือนที่เปิดอยู่ <span className="count">{events.length}</span>
      </h2>
      {error && <p className="form-error" role="alert">{error}</p>}
      <ul>
        {events.map((e) => {
          const device = devices[e.deviceId];
          const current = e.kind === "threshold" ? device?.latest[e.metric] : undefined;
          return (
            <li key={e.id} className={`alarm alarm-${e.severity}${e.acknowledgedAt ? " is-acked" : ""}`}>
              <span className="sev">{SEVERITY_LABEL[e.severity]}</span>
              <div className="what">
                <a href={deviceHref(e.deviceId)}><strong>{device?.name ?? "อุปกรณ์ที่ไม่ได้แสดง"}</strong></a>
                <span>
                  {describeAlarm(e)}
                  {current && ` · ตอนนี้ ${formatValue(e.metric, current.value)}`}
                </span>
              </div>
              <span className="when">{e.kind === "offline" ? "ติดต่อล่าสุด" : "เริ่ม"} {ago(now - e.startedAt)}</span>
              {e.acknowledgedAt ? (
                <span className="acked">รับทราบแล้ว</span>
              ) : canAck ? (
                <button className="ack" onClick={() => void ack(e.id)} disabled={busy === e.id}>
                  {busy === e.id ? "กำลังบันทึก…" : "รับทราบ"}
                </button>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
