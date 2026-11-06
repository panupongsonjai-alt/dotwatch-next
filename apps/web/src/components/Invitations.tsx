import { useState } from "react";
import { ROLE_LABEL, type Me } from "@dotwatch/shared";
import { api } from "../lib/api";
import { refreshVerification, sendVerification } from "../lib/auth";

/** Pending invitations for the signed-in user, shown above the device list. */
export function Invitations({ me, onJoined, onChanged }: { me: Me; onJoined: (orgId: string) => void; onChanged: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  if (me.invitations.length === 0) return null;

  const act = async (key: string, fn: () => Promise<void>, fail: string) => {
    setBusy(key);
    setMsg(null);
    try {
      await fn();
    } catch {
      setMsg(fail);
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="invites" aria-label="คำเชิญ">
      {!me.emailVerified && (
        <div className="notice">
          <p>ยืนยันอีเมล <strong>{me.email}</strong> ก่อนรับคำเชิญ ระบบส่งลิงก์ยืนยันไปที่อีเมลนี้แล้ว</p>
          <div className="row-gap">
            <button className="secondary" disabled={busy !== null} onClick={() => void act("send", async () => { await sendVerification(); setMsg("ส่งลิงก์ยืนยันอีกครั้งแล้ว"); }, "ส่งไม่สำเร็จ")}>
              ส่งลิงก์อีกครั้ง
            </button>
            <button className="secondary" disabled={busy !== null} onClick={() => void act("check", async () => {
              if (await refreshVerification()) onChanged();
              else setMsg("ยังไม่ได้ยืนยัน กดลิงก์ในอีเมลก่อน");
            }, "ตรวจไม่สำเร็จ")}>
              ยืนยันแล้ว
            </button>
          </div>
        </div>
      )}
      {me.invitations.map((i) => (
        <div key={i.id} className="invite">
          <p>
            {i.invitedBy ? `${i.invitedBy} เชิญคุณ` : "คุณได้รับเชิญ"}เข้าร่วม <strong>{i.orgName}</strong> ในบทบาท{ROLE_LABEL[i.role]}
          </p>
          <div className="row-gap">
            <button className="primary" disabled={busy !== null || !me.emailVerified} onClick={() => void act(i.id, async () => onJoined((await api.acceptInvitation(i.id)).orgId), "รับคำเชิญไม่สำเร็จ")}>
              รับคำเชิญ
            </button>
            <button className="quiet" disabled={busy !== null} onClick={() => void act(i.id, async () => { await api.cancelInvitation(i.id); onChanged(); }, "ปฏิเสธไม่สำเร็จ")}>
              ปฏิเสธ
            </button>
          </div>
        </div>
      ))}
      {msg && <p className="hint" role="status">{msg}</p>}
    </section>
  );
}
