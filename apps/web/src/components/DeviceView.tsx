import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import {
  can, HISTORY_RANGES, OFFLINE_ALARM_LIMITS, type AlarmEvent, type AlarmRule, type Device, type HistoryRange,
  type HistoryResponse, type Organization, type Role,
} from "@dotwatch/shared";
import { api } from "../lib/api";
import { ago, describeMetric, durationText, formatValue, isOffline, orderMetrics } from "../lib/devices";
import { alarmDuration, describeAlarm, SEVERITY_LABEL } from "../lib/alarms";
import { HistoryChart, type LimitLine } from "./HistoryChart";
import { AlarmStrip } from "./AlarmStrip";
import { AlarmRulesDialog } from "./AlarmRulesDialog";
import { SecretBox } from "./SecretBox";
import { MetricSettingsEditor } from "./MetricSettingsEditor";

interface Props {
  device: Device;
  role: Role | undefined;
  now: number;
  openAlarms: AlarmEvent[];
  onAck: (id: string) => Promise<void>;
  onUpdated: (d: Device) => void;
  onDeleted: (id: string) => void;
  /** Organizations this user may move the device into. */
  moveTargets?: Organization[];
}

const RANGE_LABEL: Record<HistoryRange, string> = { "6h": "6 ชม.", "24h": "24 ชม.", "7d": "7 วัน", "30d": "30 วัน" };
const OFFLINE_CHOICES = [5, 10, 15, 30, 60, 120, 360].map((m) => m * 60).filter((s) => s >= OFFLINE_ALARM_LIMITS.minSec);

export function DeviceView({ device, role, now, openAlarms, onAck, onUpdated, onDeleted, moveTargets = [] }: Props) {
  const [range, setRange] = useState<HistoryRange>("24h");
  const [history, setHistory] = useState<HistoryResponse | null>(null);
  const [historyError, setHistoryError] = useState(false);
  const [rules, setRules] = useState<AlarmRule[]>([]);
  const [rulesOpen, setRulesOpen] = useState(false);
  const [past, setPast] = useState<AlarmEvent[] | null>(null);
  const metrics = useMemo(() => orderMetrics(Object.keys(device.latest), device.metrics), [device.latest, device.metrics]);
  const metricsKey = metrics.join(",");
  const offline = isOffline(device.lastSeenAt, now);

  const loadHistory = useCallback(() => {
    if (!metricsKey) return;
    const to = Date.now();
    api.history(device.id, metricsKey.split(","), to - HISTORY_RANGES[range], to).then(
      (h) => {
        setHistory(h);
        setHistoryError(false);
      },
      () => setHistoryError(true),
    );
  }, [device.id, metricsKey, range]);

  useEffect(() => {
    setHistory(null);
    loadHistory();
    // Short ranges follow live data; long ranges barely move in a minute.
    if (range !== "6h" && range !== "24h") return;
    const id = setInterval(() => document.visibilityState === "visible" && loadHistory(), 60_000);
    return () => clearInterval(id);
  }, [loadHistory, range]);

  const loadRules = useCallback(() => {
    api.alarmRules(device.id).then((r) => setRules(r.rules), () => setRules([]));
  }, [device.id]);
  useEffect(loadRules, [loadRules]);

  const openKey = openAlarms.map((e) => `${e.id}${e.acknowledgedAt ?? ""}`).join();
  useEffect(() => {
    api.deviceAlarms(device.id).then((r) => setPast(r.events), () => setPast([]));
  }, [device.id, openKey]);

  const limitsFor = (metric: string): LimitLine[] =>
    rules
      .filter((r) => r.metric === metric && r.enabled)
      .flatMap((r) => [r.min, r.max].filter((v): v is number => v !== null).map((value) => ({ value, severity: r.severity })));

  return (
    <div className="device-view">
      <a className="back" href="#/">← อุปกรณ์ทั้งหมด</a>

      <header className="dv-head">
        <div>
          <h1>{device.name}</h1>
          <p className="dv-meta">
            <code>{device.code}</code>
            <span className={offline ? "state-off" : "state-on"}>{offline ? "ออฟไลน์" : "ออนไลน์"}</span>
            <span>{device.lastSeenAt ? `ส่งค่าล่าสุด ${ago(now - device.lastSeenAt)}` : "ยังไม่เคยส่งค่า"}</span>
            {device.firmwareVersion && <span>เฟิร์มแวร์ {device.firmwareVersion}</span>}
          </p>
        </div>
        <dl className="dv-now">
          {metrics.map((k) => (
            <div key={k}>
              <dt>{describeMetric(k, device.metrics).label}</dt>
              <dd>{formatValue(k, device.latest[k]!.value, device.metrics)}</dd>
            </div>
          ))}
        </dl>
      </header>

      <AlarmStrip events={openAlarms} devices={{ [device.id]: device }} now={now} canAck={can(role, "alarm.ack")} onAck={onAck} />

      <section className="dv-section" aria-labelledby="hist-title">
        <div className="section-head">
          <h2 id="hist-title">ย้อนหลัง</h2>
          <div className="tabs" role="tablist" aria-label="ช่วงเวลา">
            {(Object.keys(HISTORY_RANGES) as HistoryRange[]).map((r) => (
              <button key={r} role="tab" aria-selected={r === range} className={r === range ? "on" : ""} onClick={() => setRange(r)}>
                {RANGE_LABEL[r]}
              </button>
            ))}
          </div>
        </div>
        {metrics.length === 0 && <p className="hint">ยังไม่มีข้อมูลจากอุปกรณ์นี้</p>}
        {historyError && <p className="notice" role="alert">โหลดข้อมูลย้อนหลังไม่สำเร็จ ระบบจะลองใหม่ในอีก 1 นาที</p>}
        {metrics.length > 0 && !history && !historyError && <p className="hint">กำลังโหลด…</p>}
        {history &&
          metrics.map((m) => (
            <HistoryChart
              key={m}
              metric={m}
              points={history.series[m] ?? []}
              bucketMs={history.bucketMs}
              from={history.from}
              to={history.to}
              limits={limitsFor(m)}
              settings={device.metrics}
            />
          ))}
      </section>

      <section className="dv-section" aria-labelledby="rules-head">
        <div className="section-head">
          <h2 id="rules-head">การแจ้งเตือน</h2>
          <button className="secondary" onClick={() => setRulesOpen(true)}>{can(role, "alarm.edit") ? "แก้กฎแจ้งเตือน" : "ดูกฎแจ้งเตือน"}</button>
        </div>
        {rules.length === 0 ? (
          <p className="hint">ยังไม่มีกฎแจ้งเตือนค่าผิดปกติ</p>
        ) : (
          <ul className="rule-summary">
            {rules.map((r) => (
              <li key={r.id} className={r.enabled ? "" : "is-off"}>
                <span className={`badge badge-${r.severity}`}>{SEVERITY_LABEL[r.severity]}</span>
                {describeMetric(r.metric, device.metrics).label} ปกติ{" "}
                {r.min !== null && r.max !== null
                  ? `${formatValue(r.metric, r.min, device.metrics)} – ${formatValue(r.metric, r.max, device.metrics)}`
                  : r.max !== null
                    ? `ไม่เกิน ${formatValue(r.metric, r.max, device.metrics)}`
                    : `ไม่ต่ำกว่า ${formatValue(r.metric, r.min!, device.metrics)}`}
                {r.delaySec > 0 && ` · รอ ${durationText(r.delaySec)}`}
                {!r.enabled && " · ปิดอยู่"}
              </li>
            ))}
          </ul>
        )}
        <OfflineSetting device={device} canEdit={can(role, "alarm.edit")} onUpdated={onUpdated} />
      </section>

      <section className="dv-section" aria-labelledby="past-title">
        <h2 id="past-title">ประวัติแจ้งเตือน</h2>
        {past === null ? (
          <p className="hint">กำลังโหลด…</p>
        ) : past.length === 0 ? (
          <p className="hint">ยังไม่เคยมีแจ้งเตือน</p>
        ) : (
          <table className="events">
            <thead>
              <tr><th>เริ่ม</th><th>ระดับ</th><th>เรื่อง</th><th>นาน</th><th>สถานะ</th></tr>
            </thead>
            <tbody>
              {past.map((e) => (
                <tr key={e.id}>
                  <td>{new Date(e.startedAt).toLocaleString("th-TH", { dateStyle: "short", timeStyle: "short" })}</td>
                  <td><span className={`badge badge-${e.severity}`}>{SEVERITY_LABEL[e.severity]}</span></td>
                  <td>{describeAlarm(e, device.metrics)}</td>
                  <td>{alarmDuration(e, now)}</td>
                  <td>{e.endedAt === null ? "ยังเปิดอยู่" : "ปิดแล้ว"}{e.acknowledgedAt ? " · รับทราบแล้ว" : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {can(role, "device.update") && <DeviceSettings device={device} role={role} onUpdated={onUpdated} onDeleted={onDeleted} moveTargets={moveTargets} />}

      {rulesOpen && (
        <AlarmRulesDialog
          device={device}
          canEdit={can(role, "alarm.edit")}
          onClose={() => {
            setRulesOpen(false);
            loadRules();
          }}
        />
      )}
    </div>
  );
}

function OfflineSetting({ device, canEdit, onUpdated }: { device: Device; canEdit: boolean; onUpdated: (d: Device) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const value = device.offlineAfterSec;
  const choices = value !== null && !OFFLINE_CHOICES.includes(value) ? [...OFFLINE_CHOICES, value].sort((a, b) => a - b) : OFFLINE_CHOICES;

  async function change(v: string) {
    setBusy(true);
    setError(null);
    try {
      const r = await api.updateDevice(device.id, { offlineAfterSec: v === "off" ? null : Number(v) });
      onUpdated(r.device);
    } catch {
      setError("บันทึกไม่สำเร็จ ลองใหม่อีกครั้ง");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="offline-setting">
      <label>
        แจ้งเตือนเมื่อขาดการติดต่อเกิน
        <select value={value === null ? "off" : String(value)} onChange={(e) => void change(e.target.value)} disabled={!canEdit || busy}>
          <option value="off">ไม่แจ้งเตือน</option>
          {choices.map((s) => (
            <option key={s} value={s}>{durationText(s)}</option>
          ))}
        </select>
      </label>
      {error && <p className="form-error" role="alert">{error}</p>}
    </div>
  );
}

function DeviceSettings({ device, role, onUpdated, onDeleted, moveTargets }: {
  device: Device; role: Role | undefined; onUpdated: (d: Device) => void; onDeleted: (id: string) => void; moveTargets: Organization[];
}) {
  const [moveTo, setMoveTo] = useState("");
  const [name, setName] = useState(device.name);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [confirmCode, setConfirmCode] = useState("");
  const [busy, setBusy] = useState<"name" | "secret" | "delete" | "move" | null>(null);

  async function move() {
    const target = moveTargets.find((o) => o.id === moveTo);
    if (!target || !window.confirm(`ย้าย ${device.name} ไปที่ "${target.name}"? กฎและประวัติแจ้งเตือนจะย้ายไปด้วย`)) return;
    setBusy("move");
    try {
      await api.moveDevice(device.id, target.id);
      onDeleted(device.id);
      window.location.hash = "#/";
    } catch {
      setMsg({ ok: false, text: "ย้ายอุปกรณ์ไม่สำเร็จ ต้องเป็นผู้ดูแลทั้งสององค์กร" });
      setBusy(null);
    }
  }

  useEffect(() => setName(device.name), [device.name]);

  async function rename(e: FormEvent) {
    e.preventDefault();
    if (!name.trim() || name.trim() === device.name) return;
    setBusy("name");
    try {
      onUpdated((await api.updateDevice(device.id, { name: name.trim() })).device);
      setMsg({ ok: true, text: "เปลี่ยนชื่อแล้ว" });
    } catch {
      setMsg({ ok: false, text: "เปลี่ยนชื่อไม่สำเร็จ" });
    } finally {
      setBusy(null);
    }
  }

  async function reset() {
    if (!window.confirm(`ออกรหัสลับใหม่ให้ ${device.code}? รหัสเดิมจะใช้ไม่ได้ทันที บอร์ดจะส่งข้อมูลไม่ผ่านจนกว่าจะใส่รหัสใหม่`)) return;
    setBusy("secret");
    try {
      setSecret((await api.resetSecret(device.id)).secret);
      setMsg(null);
    } catch {
      setMsg({ ok: false, text: "ออกรหัสใหม่ไม่สำเร็จ" });
    } finally {
      setBusy(null);
    }
  }

  async function remove() {
    setBusy("delete");
    try {
      await api.deleteDevice(device.id);
      onDeleted(device.id);
      window.location.hash = "#/";
    } catch {
      setMsg({ ok: false, text: "ลบอุปกรณ์ไม่สำเร็จ" });
      setBusy(null);
    }
  }

  return (
    <section className="dv-section settings" aria-labelledby="set-title">
      <h2 id="set-title">ตั้งค่าอุปกรณ์</h2>
      <form className="row" onSubmit={rename}>
        <label>
          ชื่ออุปกรณ์
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />
        </label>
        <button className="secondary" disabled={busy !== null || !name.trim() || name.trim() === device.name}>บันทึกชื่อ</button>
      </form>
      {msg && <p className={msg.ok ? "hint" : "form-error"} role="status">{msg.text}</p>}

      <div className="danger-row"><MetricSettingsEditor key={Object.keys(device.metrics).join()} device={device} onUpdated={onUpdated} /></div>

      {can(role, "device.reset_secret") && (
        <div className="danger-row">
          <div>
            <strong>ออกรหัสลับใหม่</strong>
            <p className="hint">ใช้เมื่อรหัสหลุดหรือเปลี่ยนบอร์ด รหัสเดิมจะใช้ไม่ได้ทันที</p>
          </div>
          <button className="secondary" onClick={() => void reset()} disabled={busy !== null}>{busy === "secret" ? "กำลังออกรหัส…" : "ออกรหัสใหม่"}</button>
        </div>
      )}
      {secret && <SecretBox code={device.code} secret={secret} />}

      {can(role, "device.delete") && moveTargets.length > 0 && (
        <div className="danger-row">
          <div>
            <strong>ย้ายไปองค์กรอื่น</strong>
            <p className="hint">กฎแจ้งเตือนและประวัติจะย้ายไปด้วย รหัสลับของบอร์ดใช้ต่อได้</p>
            <select value={moveTo} onChange={(e) => setMoveTo(e.target.value)} aria-label="องค์กรปลายทาง">
              <option value="">เลือกองค์กร</option>
              {moveTargets.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
            </select>
          </div>
          <button className="secondary" onClick={() => void move()} disabled={busy !== null || !moveTo}>{busy === "move" ? "กำลังย้าย…" : "ย้าย"}</button>
        </div>
      )}

      {can(role, "device.delete") && (
        <div className="danger-row">
          <div>
            <strong>ลบอุปกรณ์</strong>
            <p className="hint">อุปกรณ์จะหายจากทุกหน้าและส่งข้อมูลไม่ได้อีก พิมพ์ <code>{device.code}</code> เพื่อยืนยัน</p>
            <input value={confirmCode} onChange={(e) => setConfirmCode(e.target.value)} aria-label="พิมพ์รหัสอุปกรณ์เพื่อยืนยัน" />
          </div>
          <button className="danger" onClick={() => void remove()} disabled={busy !== null || confirmCode.trim().toUpperCase() !== device.code}>
            {busy === "delete" ? "กำลังลบ…" : "ลบอุปกรณ์"}
          </button>
        </div>
      )}
    </section>
  );
}
