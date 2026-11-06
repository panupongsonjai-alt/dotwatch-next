import { useState } from "react";
import { metricMeta, type Device } from "@dotwatch/shared";
import { api } from "../lib/api";
import { orderMetrics } from "../lib/devices";

interface Row {
  metric: string;
  label: string;
  unit: string;
  decimals: number;
  hidden: boolean;
}

const toRows = (d: Device): Row[] =>
  orderMetrics([...Object.keys(d.latest), ...Object.keys(d.metrics)], d.metrics, true).map((k) => {
    const m = metricMeta(d.metrics, k);
    return { metric: k, label: m.label, unit: m.unit, decimals: m.decimals, hidden: m.hidden };
  });

/** Names, units, decimals, order and visibility of a device's metrics. */
export function MetricSettingsEditor({ device, onUpdated }: { device: Device; onUpdated: (d: Device) => void }) {
  const [rows, setRows] = useState(() => toRows(device));
  const [state, setState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  if (rows.length === 0) return null;

  const edit = (i: number, patch: Partial<Row>) => {
    setState("idle");
    setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  };
  const move = (i: number, by: number) => {
    setState("idle");
    setRows((rs) => {
      const next = [...rs];
      const [r] = next.splice(i, 1);
      next.splice(i + by, 0, r!);
      return next;
    });
  };
  const invalid = rows.some((r) => !r.label.trim());

  async function save() {
    setState("saving");
    try {
      const r = await api.saveMetrics(
        device.id,
        rows.map((x, i) => ({ metric: x.metric, label: x.label.trim(), unit: x.unit.trim(), decimals: x.decimals, sortOrder: i, hidden: x.hidden })),
      );
      onUpdated(r.device);
      setState("saved");
    } catch {
      setState("error");
    }
  }

  return (
    <div className="metric-editor">
      <strong>ชื่อและหน่วยของค่าที่วัด</strong>
      <p className="hint">ใช้บนการ์ด กราฟ และข้อความแจ้งเตือน ค่าที่ซ่อนยังบันทึกอยู่ แค่ไม่แสดงบนการ์ดและกราฟ</p>
      <div className="metric-table" role="table">
        <div className="mt-head" role="row">
          <span>รหัส</span><span>ชื่อที่แสดง</span><span>หน่วย</span><span>ทศนิยม</span><span>แสดง</span><span>ลำดับ</span>
        </div>
        {rows.map((r, i) => (
          <div key={r.metric} className={`mt-row${r.hidden ? " is-hidden" : ""}`} role="row">
            <code>{r.metric}</code>
            <input aria-label={`ชื่อของ ${r.metric}`} value={r.label} maxLength={60} onChange={(e) => edit(i, { label: e.target.value })} />
            <input aria-label={`หน่วยของ ${r.metric}`} value={r.unit} maxLength={16} onChange={(e) => edit(i, { unit: e.target.value })} />
            <select aria-label={`ทศนิยมของ ${r.metric}`} value={r.decimals} onChange={(e) => edit(i, { decimals: Number(e.target.value) })}>
              {[0, 1, 2, 3, 4].map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
            <input type="checkbox" aria-label={`แสดง ${r.metric}`} checked={!r.hidden} onChange={(e) => edit(i, { hidden: !e.target.checked })} />
            <span className="mt-order">
              <button type="button" className="quiet" aria-label="เลื่อนขึ้น" disabled={i === 0} onClick={() => move(i, -1)}>▲</button>
              <button type="button" className="quiet" aria-label="เลื่อนลง" disabled={i === rows.length - 1} onClick={() => move(i, 1)}>▼</button>
            </span>
          </div>
        ))}
      </div>
      <div className="row-gap">
        <button className="secondary" disabled={state === "saving" || invalid} onClick={() => void save()}>{state === "saving" ? "กำลังบันทึก…" : "บันทึก"}</button>
        {state === "saved" && <span className="hint" role="status">บันทึกแล้ว</span>}
        {state === "error" && <span className="form-error" role="alert">บันทึกไม่สำเร็จ</span>}
        {invalid && <span className="form-error">ทุกค่าต้องมีชื่อ</span>}
      </div>
    </div>
  );
}
