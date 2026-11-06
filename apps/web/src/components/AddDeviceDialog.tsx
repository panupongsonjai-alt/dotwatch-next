import { useEffect, useRef, useState, type FormEvent } from "react";
import type { CreateDeviceResponse } from "@dotwatch/shared";
import { api, ApiError } from "../lib/api";
import { SecretBox } from "./SecretBox";

interface Props {
  orgId: string;
  onCreated: (r: CreateDeviceResponse) => void;
  onClose: () => void;
}

export function AddDeviceDialog({ orgId, onCreated, onClose }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<CreateDeviceResponse | null>(null);

  useEffect(() => ref.current?.showModal(), []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const c = code.trim();
    if (!name.trim()) return setError("ใส่ชื่ออุปกรณ์");
    if (c && !/^[A-Za-z0-9_-]{3,32}$/.test(c)) return setError("รหัสอุปกรณ์ใช้ได้เฉพาะ A–Z, 0–9, - และ _ ยาว 3–32 ตัว หรือเว้นว่างให้ระบบตั้งให้");
    setBusy(true);
    setError(null);
    try {
      const r = await api.createDevice({ orgId, name: name.trim(), ...(c ? { code: c } : {}) });
      setCreated(r);
      onCreated(r);
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 409
          ? "รหัสอุปกรณ์นี้ถูกใช้แล้ว ลองรหัสอื่น"
          : err instanceof ApiError && err.status === 403
            ? "เฉพาะเจ้าของและผู้ดูแลองค์กรเท่านั้นที่เพิ่มอุปกรณ์ได้"
            : "เพิ่มอุปกรณ์ไม่สำเร็จ ลองใหม่อีกครั้ง",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <dialog ref={ref} className="modal" onClose={onClose} aria-labelledby="add-title">
      <header>
        <h2 id="add-title">{created ? "เพิ่มอุปกรณ์แล้ว" : "เพิ่มอุปกรณ์"}</h2>
        <button className="quiet" onClick={() => ref.current?.close()} aria-label="ปิด">✕</button>
      </header>
      {created ? (
        <>
          <SecretBox code={created.device.code} secret={created.secret} />
          <footer>
            <span className="grow" />
            <button className="primary" onClick={() => ref.current?.close()}>เสร็จ</button>
          </footer>
        </>
      ) : (
        <form onSubmit={submit} className="stack">
          <label>
            ชื่ออุปกรณ์
            <input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} placeholder="เช่น ห้องเย็น 2" autoFocus />
          </label>
          <label>
            รหัสอุปกรณ์ (ไม่บังคับ)
            <input value={code} onChange={(e) => setCode(e.target.value)} maxLength={32} placeholder="เว้นว่างให้ระบบตั้งให้" />
          </label>
          {error && <p className="form-error" role="alert">{error}</p>}
          <footer>
            <span className="grow" />
            <button className="primary" disabled={busy}>{busy ? "กำลังเพิ่ม…" : "เพิ่มอุปกรณ์"}</button>
          </footer>
        </form>
      )}
    </dialog>
  );
}
