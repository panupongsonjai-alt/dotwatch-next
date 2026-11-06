import { useEffect, useMemo, useRef, useState } from "react";
import { SEVERITIES, type Device } from "@dotwatch/shared";
import { api, ApiError } from "../lib/api";
import { describeMetric, orderMetrics } from "../lib/devices";
import { blankDraft, draftsToInput, SEVERITY_LABEL, toDraft, type DraftErrors, type RuleDraft } from "../lib/alarms";

interface Props {
  device: Device;
  canEdit: boolean;
  onClose: () => void;
}

const PHASE_TEXT = { normal: "ปกติ", pending: "ออกนอกช่วง กำลังรอ", active: "กำลังแจ้งเตือน" } as const;

export function AlarmRulesDialog({ device, canEdit, onClose }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const [drafts, setDrafts] = useState<RuleDraft[] | null>(null);
  const [phases, setPhases] = useState<Record<string, keyof typeof PHASE_TEXT>>({});
  const [errors, setErrors] = useState<DraftErrors>({});
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    ref.current?.showModal();
  }, []);

  useEffect(() => {
    let alive = true;
    api.alarmRules(device.id).then(
      (r) => {
        if (!alive) return;
        setDrafts(r.rules.map(toDraft));
        setPhases(Object.fromEntries(r.rules.map((x) => [x.id, x.phase])));
      },
      () => alive && setLoadError("โหลดกฎแจ้งเตือนไม่สำเร็จ ปิดหน้าต่างแล้วลองใหม่"),
    );
    return () => {
      alive = false;
    };
  }, [device.id]);

  const metrics = useMemo(
    () => orderMetrics([...new Set([...Object.keys(device.latest), ...(drafts ?? []).map((d) => d.metric)])], device.metrics, true),
    [device.latest, device.metrics, drafts],
  );

  const update = (key: string, patch: Partial<RuleDraft>) => {
    setSaved(false);
    setDrafts((ds) => ds && ds.map((d) => (d.key === key ? { ...d, ...patch } : d)));
  };

  const addRule = () => {
    setSaved(false);
    setDrafts((ds) => {
      const list = ds ?? [];
      // Suggest the first metric+severity pair that has no rule yet.
      for (const m of metrics.length ? metrics : ["temperature"])
        for (const s of SEVERITIES) if (!list.some((d) => d.metric === m && d.severity === s)) return [...list, blankDraft(m, s)];
      return [...list, blankDraft(metrics[0] ?? "temperature")];
    });
  };

  const remove = (key: string) => {
    setSaved(false);
    setDrafts((ds) => ds && ds.filter((d) => d.key !== key));
  };

  async function save() {
    if (!drafts) return;
    const { rules, errors: found } = draftsToInput(drafts);
    setErrors(found);
    if (Object.keys(found).length) return;
    setSaving(true);
    try {
      const r = await api.saveAlarmRules(device.id, rules);
      setDrafts(r.rules.map(toDraft));
      setPhases(Object.fromEntries(r.rules.map((x) => [x.id, x.phase])));
      setSaved(true);
    } catch (err) {
      setErrors({ "": [err instanceof ApiError && err.status === 403 ? "คุณไม่มีสิทธิ์แก้กฎแจ้งเตือนขององค์กรนี้" : `บันทึกไม่สำเร็จ: ${(err as Error).message}`] });
    } finally {
      setSaving(false);
    }
  }

  return (
    <dialog ref={ref} className="modal rules" onClose={onClose} aria-labelledby="rules-title">
      <header>
        <h2 id="rules-title">กฎแจ้งเตือน · {device.name}</h2>
        <button className="quiet" onClick={() => ref.current?.close()} aria-label="ปิด">✕</button>
      </header>

      <p className="hint">
        แจ้งเตือนเมื่อค่าออกนอกช่วงปกติต่อเนื่องเกิน "รอ" นาที และปิดเองเมื่อค่ากลับเข้าช่วงลึกกว่า "กันกะพริบ"
        {!canEdit && " — บทบาทผู้ดูแก้ไขไม่ได้"}
      </p>

      {loadError && <p className="form-error" role="alert">{loadError}</p>}
      {!drafts && !loadError && <p className="hint">กำลังโหลด…</p>}

      {drafts && (
        <>
          {drafts.length === 0 && <p className="hint">ยังไม่มีกฎสำหรับอุปกรณ์นี้</p>}
          <fieldset disabled={!canEdit || saving} className="rule-list">
            {drafts.map((d) => {
              const unit = describeMetric(d.metric, device.metrics).unit;
              const phase = phases[d.key];
              return (
                <div key={d.key} className={`rule${errors[d.key] ? " has-error" : ""}`}>
                  <label className="f-metric">
                    ค่าที่วัด
                    <select value={d.metric} onChange={(e) => update(d.key, { metric: e.target.value })}>
                      {metrics.map((m) => (
                        <option key={m} value={m}>{describeMetric(m, device.metrics).label}</option>
                      ))}
                    </select>
                  </label>
                  <label className="f-sev">
                    ระดับ
                    <select value={d.severity} onChange={(e) => update(d.key, { severity: e.target.value as RuleDraft["severity"] })}>
                      {SEVERITIES.map((s) => (
                        <option key={s} value={s}>{SEVERITY_LABEL[s]}</option>
                      ))}
                    </select>
                  </label>
                  <label>
                    ต่ำสุด{unit && ` (${unit})`}
                    <input inputMode="decimal" value={d.min} placeholder="ไม่กำหนด" onChange={(e) => update(d.key, { min: e.target.value })} />
                  </label>
                  <label>
                    สูงสุด{unit && ` (${unit})`}
                    <input inputMode="decimal" value={d.max} placeholder="ไม่กำหนด" onChange={(e) => update(d.key, { max: e.target.value })} />
                  </label>
                  <label>
                    รอ (นาที)
                    <input inputMode="decimal" value={d.delayMin} onChange={(e) => update(d.key, { delayMin: e.target.value })} />
                  </label>
                  <label>
                    กันกะพริบ{unit && ` (${unit})`}
                    <input inputMode="decimal" value={d.hysteresis} onChange={(e) => update(d.key, { hysteresis: e.target.value })} />
                  </label>
                  <label className="f-on">
                    <input type="checkbox" checked={d.enabled} onChange={(e) => update(d.key, { enabled: e.target.checked })} />
                    เปิดใช้
                  </label>
                  {canEdit && (
                    <button type="button" className="quiet f-del" onClick={() => remove(d.key)} aria-label="ลบกฎนี้">ลบ</button>
                  )}
                  {phase && phase !== "normal" && <p className={`phase phase-${phase}`}>{PHASE_TEXT[phase]}</p>}
                  {errors[d.key]?.map((m) => (
                    <p key={m} className="form-error">{m}</p>
                  ))}
                </div>
              );
            })}
          </fieldset>

          {errors[""]?.map((m) => (
            <p key={m} className="form-error" role="alert">{m}</p>
          ))}

          {canEdit && (
            <footer>
              <button type="button" className="secondary" onClick={addRule} disabled={saving}>+ เพิ่มกฎ</button>
              <span className="grow" />
              {saved && <span className="saved" role="status">บันทึกแล้ว</span>}
              <button type="button" className="primary" onClick={() => void save()} disabled={saving}>
                {saving ? "กำลังบันทึก…" : "บันทึก"}
              </button>
            </footer>
          )}
        </>
      )}
    </dialog>
  );
}
