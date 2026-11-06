import { useCallback, useEffect, useState, type FormEvent } from "react";
import { LINE_ID, NOTIFY_LIMITS, SEVERITIES, type NotificationsResponse, type NotificationTarget, type Severity, type TargetKind } from "@dotwatch/shared";
import { api, ApiError } from "../lib/api";
import { ago } from "../lib/devices";
import { SEVERITY_LABEL } from "../lib/alarms";
import { addressLabel, REPEAT_CHOICES, targetState } from "../lib/notify";

const LEVEL_TEXT: Record<Severity, string> = { warning: "ทุกระดับ (เตือน + วิกฤต)", critical: "เฉพาะวิกฤต" };

export function NotificationsPage({ orgId, orgName, now }: { orgId: string; orgName: string; now: number }) {
  const [data, setData] = useState<NotificationsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState<TargetKind | null>(null);

  const load = useCallback(() => {
    api.notifications(orgId).then(
      (d) => {
        setData(d);
        setError(null);
      },
      (err) => setError(err instanceof ApiError && err.status === 403 ? "เฉพาะเจ้าของและผู้ดูแลองค์กรที่ตั้งค่าการแจ้งเตือนได้" : "โหลดการตั้งค่าไม่สำเร็จ"),
    );
  }, [orgId]);
  useEffect(load, [load]);

  // While a LINE code waits to be sent, or right after a test, follow the status.
  const waiting = data?.targets.some((t) => targetState(t, now) === "waiting");
  const [followUntil, setFollowUntil] = useState(0);
  useEffect(() => {
    if (!waiting && Date.now() > followUntil) return;
    const id = setInterval(() => document.visibilityState === "visible" && load(), 4000);
    return () => clearInterval(id);
  }, [waiting, followUntil, load]);

  const replace = (t: NotificationTarget) => setData((d) => d && { ...d, targets: d.targets.map((x) => (x.id === t.id ? t : x)) });

  if (error) return <p className="notice" role="alert">{error}</p>;
  if (!data) return <p className="hint">กำลังโหลด…</p>;

  return (
    <div className="notify-page">
      <a className="back" href="#/">← อุปกรณ์ทั้งหมด</a>
      <h1 className="page-title spaced">การแจ้งเตือน · {orgName}</h1>

      {(!data.channels.line || !data.channels.email) && (
        <div className="notice">
          {!data.channels.line && <p>LINE ยังไม่ได้ใส่ key: ระบบจะเขียนข้อความลง log ของ API แทนการส่งจริง (โหมดทดลอง)</p>}
          {!data.channels.email && <p>อีเมลยังไม่ได้ใส่ key: ระบบจะเขียนข้อความลง log ของ API แทนการส่งจริง (โหมดทดลอง)</p>}
        </div>
      )}

      <ReminderSettings orgId={orgId} initial={data.settings} />

      <section className="dv-section">
        <div className="section-head">
          <h2>ผู้รับแจ้งเตือน</h2>
          <div className="row-gap">
            <button className="secondary" onClick={() => setAdding("line")}>+ LINE</button>
            <button className="secondary" onClick={() => setAdding("email")}>+ อีเมล</button>
          </div>
        </div>

        {adding && (
          <AddTarget
            orgId={orgId}
            kind={adding}
            webhook={data.channels.lineWebhook}
            onAdded={(t) => {
              setData((d) => d && { ...d, targets: [...d.targets, t] });
              setAdding(null);
            }}
            onCancel={() => setAdding(null)}
          />
        )}

        {data.targets.length === 0 && !adding && <p className="hint">ยังไม่มีผู้รับ แจ้งเตือนจะขึ้นเฉพาะบนเว็บ</p>}
        <ul className="targets">
          {data.targets.map((t) => (
            <TargetRow
              key={t.id}
              target={t}
              now={now}
              webhook={data.channels.lineWebhook}
              onChange={replace}
              onDelete={() => setData((d) => d && { ...d, targets: d.targets.filter((x) => x.id !== t.id) })}
              onTested={() => {
                setFollowUntil(Date.now() + 20_000);
                setTimeout(load, 1500);
              }}
            />
          ))}
        </ul>
      </section>
    </div>
  );
}

function ReminderSettings({ orgId, initial }: { orgId: string; initial: NotificationsResponse["settings"] }) {
  const [repeat, setRepeat] = useState(initial.repeatMinutes === null ? "off" : String(initial.repeatMinutes));
  const [max, setMax] = useState(initial.maxReminders);
  const [state, setState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const choices = initial.repeatMinutes !== null && !REPEAT_CHOICES.includes(initial.repeatMinutes)
    ? [...REPEAT_CHOICES, initial.repeatMinutes].sort((a, b) => a - b)
    : REPEAT_CHOICES;

  async function save(e: FormEvent) {
    e.preventDefault();
    setState("saving");
    try {
      await api.saveNotifySettings(orgId, { repeatMinutes: repeat === "off" ? null : Number(repeat), maxReminders: max });
      setState("saved");
    } catch {
      setState("error");
    }
  }

  return (
    <section className="dv-section">
      <h2>เตือนซ้ำ</h2>
      <form className="row" onSubmit={save}>
        <label>
          ถ้ายังไม่มีใครกดรับทราบ เตือนซ้ำทุก
          <select value={repeat} onChange={(e) => { setRepeat(e.target.value); setState("idle"); }}>
            <option value="off">ไม่เตือนซ้ำ</option>
            {choices.map((m) => <option key={m} value={m}>{m} นาที</option>)}
          </select>
        </label>
        <label>
          สูงสุด (ครั้ง)
          <select value={max} onChange={(e) => { setMax(Number(e.target.value)); setState("idle"); }} disabled={repeat === "off"}>
            {Array.from({ length: NOTIFY_LIMITS.maxReminders.max }, (_, i) => i + 1).map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>
        <button className="secondary" disabled={state === "saving"}>บันทึก</button>
        {state === "saved" && <span className="hint" role="status">บันทึกแล้ว</span>}
        {state === "error" && <span className="form-error" role="alert">บันทึกไม่สำเร็จ</span>}
      </form>
      <p className="hint">เพดานจำนวนครั้งช่วยไม่ให้แจ้งเตือนที่ถูกลืมใช้โควตาข้อความ LINE จนหมด</p>
    </section>
  );
}

function AddTarget({ orgId, kind, webhook, onAdded, onCancel }: {
  orgId: string; kind: TargetKind; webhook: boolean; onAdded: (t: NotificationTarget) => void; onCancel: () => void;
}) {
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [level, setLevel] = useState<Severity>("warning");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const a = address.trim();
    if (!name.trim()) return setError("ใส่ชื่อผู้รับ");
    if (kind === "email" && !/^\S+@\S+\.\S+$/.test(a)) return setError("ใส่อีเมลให้ถูกต้อง");
    if (kind === "line" && a && !LINE_ID.test(a)) return setError("LINE ID ต้องขึ้นต้นด้วย U, C หรือ R ตามด้วยตัวอักษร 32 ตัว");
    if (kind === "line" && !a && !webhook) return setError("ยังเชื่อมด้วยรหัสไม่ได้เพราะยังไม่ได้ตั้ง webhook ให้ใส่ LINE ID แทน");
    setBusy(true);
    setError(null);
    try {
      const r = await api.addTarget(orgId, kind === "email"
        ? { kind, name: name.trim(), address: a, minSeverity: level }
        : { kind, name: name.trim(), ...(a ? { address: a } : {}), minSeverity: level });
      onAdded(r.target);
    } catch (err) {
      setError(err instanceof ApiError && err.status === 409 ? "มีผู้รับนี้อยู่แล้ว" : "เพิ่มไม่สำเร็จ ลองใหม่อีกครั้ง");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="add-target" onSubmit={submit}>
      <h3>{kind === "line" ? "เพิ่มผู้รับทาง LINE" : "เพิ่มผู้รับทางอีเมล"}</h3>
      <div className="row">
        <label>
          ชื่อ
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} placeholder={kind === "line" ? "เช่น กลุ่มช่างเทคนิค" : "เช่น หัวหน้าคลัง"} autoFocus />
        </label>
        <label>
          {kind === "line" ? "LINE ID (ไม่บังคับ)" : "อีเมล"}
          <input value={address} onChange={(e) => setAddress(e.target.value)} placeholder={kind === "line" ? (webhook ? "เว้นว่างเพื่อเชื่อมด้วยรหัส" : "U… จาก LINE Developers") : "name@example.com"} inputMode={kind === "email" ? "email" : "text"} />
        </label>
        <label>
          รับระดับ
          <select value={level} onChange={(e) => setLevel(e.target.value as Severity)}>
            {SEVERITIES.map((s) => <option key={s} value={s}>{LEVEL_TEXT[s]}</option>)}
          </select>
        </label>
      </div>
      {error && <p className="form-error" role="alert">{error}</p>}
      <footer>
        <button type="button" className="quiet" onClick={onCancel}>ยกเลิก</button>
        <span className="grow" />
        <button className="primary" disabled={busy}>{busy ? "กำลังเพิ่ม…" : "เพิ่ม"}</button>
      </footer>
    </form>
  );
}

function TargetRow({ target: t, now, webhook, onChange, onDelete, onTested }: {
  target: NotificationTarget; now: number; webhook: boolean;
  onChange: (t: NotificationTarget) => void; onDelete: () => void; onTested: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const state = targetState(t, now);

  const run = async (fn: () => Promise<void>, fail: string) => {
    setBusy(true);
    setMsg(null);
    try {
      await fn();
    } catch {
      setMsg(fail);
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className={`target target-${state}`}>
      <div className="target-main">
        <span className={`chip chip-${t.kind}`}>{t.kind === "line" ? "LINE" : "อีเมล"}</span>
        <div>
          <strong>{t.name}</strong>
          <span className="hint">{addressLabel(t)} · {t.minSeverity === "critical" ? "เฉพาะ" : "ทุกระดับ ตั้งแต่"}{SEVERITY_LABEL[t.minSeverity]}</span>
        </div>
      </div>

      {state === "waiting" && (
        <div className="link-code">
          <p>ให้คนที่จะรับแจ้งเตือน <strong>เพิ่มเพื่อน LINE OA ของ dotWatch</strong> แล้วพิมพ์รหัสนี้ในแชท หรือเชิญ OA เข้ากลุ่มแล้วพิมพ์ในกลุ่ม</p>
          <code className="code-big">{t.linkCode}</code>
          <span className="hint">หมดอายุใน {Math.max(1, Math.round(((t.linkExpiresAt ?? now) - now) / 60_000))} นาที · หน้านี้จะอัปเดตเองเมื่อเชื่อมสำเร็จ</span>
        </div>
      )}
      {state === "expired" && <p className="form-error">รหัสหมดอายุแล้ว{webhook ? " กดขอรหัสใหม่" : ""}</p>}
      {state === "error" && <p className="form-error">ส่งไม่สำเร็จล่าสุด: {t.lastError}</p>}
      {state === "linked" && t.lastError && <p className="hint">{t.lastError}</p>}
      {state === "linked" && t.lastSentAt && !t.lastError && <p className="hint">ส่งสำเร็จล่าสุด {ago(now - t.lastSentAt)}</p>}
      {msg && <p className="form-error" role="alert">{msg}</p>}

      <div className="target-actions">
        <select
          aria-label="รับระดับ"
          value={t.minSeverity}
          disabled={busy}
          onChange={(e) => void run(async () => onChange((await api.updateTarget(t.id, { minSeverity: e.target.value as Severity })).target), "บันทึกไม่สำเร็จ")}
        >
          {SEVERITIES.map((s) => <option key={s} value={s}>{LEVEL_TEXT[s]}</option>)}
        </select>
        <label className="toggle">
          <input
            type="checkbox"
            checked={t.enabled}
            disabled={busy}
            onChange={(e) => void run(async () => onChange((await api.updateTarget(t.id, { enabled: e.target.checked })).target), "บันทึกไม่สำเร็จ")}
          />
          เปิดใช้
        </label>
        {t.address ? (
          <button className="secondary" disabled={busy || !t.enabled} onClick={() => void run(async () => { await api.testTarget(t.id); onTested(); setMsg(null); }, "ส่งทดสอบไม่สำเร็จ")}>
            ส่งทดสอบ
          </button>
        ) : (
          webhook && (
            <button className="secondary" disabled={busy} onClick={() => void run(async () => onChange((await api.newLinkCode(t.id)).target), "ขอรหัสใหม่ไม่สำเร็จ")}>
              ขอรหัสใหม่
            </button>
          )
        )}
        <button
          className="quiet danger-text"
          disabled={busy}
          onClick={() => window.confirm(`ลบผู้รับ "${t.name}"?`) && void run(async () => { await api.deleteTarget(t.id); onDelete(); }, "ลบไม่สำเร็จ")}
        >
          ลบ
        </button>
      </div>
    </li>
  );
}
