import { useCallback, useEffect, useState, type FormEvent } from "react";
import { can, canAssignRole, ROLE_LABEL, ROLES, type Me, type MembersResponse, type Organization, type Role } from "@dotwatch/shared";
import { api, ApiError } from "../lib/api";

interface Props {
  me: Me;
  org: Organization;
  onChanged: () => void;
  onSwitch: (orgId: string) => void;
}

const errorText = (err: unknown, fallback: string) => {
  if (!(err instanceof ApiError)) return fallback;
  if (err.status === 409 && /owner/i.test(err.message)) return "องค์กรต้องมีเจ้าของอย่างน้อย 1 คน ตั้งคนอื่นเป็นเจ้าของก่อน";
  if (err.status === 409 && /already a member/i.test(err.message)) return "คนนี้เป็นสมาชิกอยู่แล้ว";
  if (err.status === 409 && /devices/i.test(err.message)) return "ย้ายหรือลบอุปกรณ์ขององค์กรนี้ก่อน";
  if (err.status === 409 && /personal/i.test(err.message)) return "องค์กรส่วนตัวลบหรือออกไม่ได้";
  if (err.status === 403) return "บทบาทของคุณทำรายการนี้ไม่ได้";
  return fallback;
};

export function OrgPage({ me, org, onChanged, onSwitch }: Props) {
  const [data, setData] = useState<MembersResponse | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const manage = can(org.role, "org.manage_members");

  const load = useCallback(() => {
    api.members(org.id).then(setData, () => setMsg({ ok: false, text: "โหลดรายชื่อสมาชิกไม่สำเร็จ" }));
  }, [org.id]);
  useEffect(load, [load]);

  const run = async (fn: () => Promise<void>, ok: string | null, fail: string) => {
    setBusy(true);
    setMsg(null);
    try {
      await fn();
      if (ok) setMsg({ ok: true, text: ok });
    } catch (err) {
      setMsg({ ok: false, text: errorText(err, fail) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="org-page">
      <a className="back" href="#/">← อุปกรณ์ทั้งหมด</a>
      <h1 className="page-title spaced">องค์กร · {org.name}{org.personal ? " (ส่วนตัว)" : ""}</h1>
      {msg && <p className={msg.ok ? "notice ok" : "notice"} role="status">{msg.text}</p>}

      {manage && (
        <RenameOrg org={org} busy={busy} onSave={(name) => void run(async () => { await api.renameOrg(org.id, name); onChanged(); }, "เปลี่ยนชื่อแล้ว", "เปลี่ยนชื่อไม่สำเร็จ")} />
      )}

      <section className="dv-section">
        <h2>สมาชิก {data && <span className="count-muted">{data.members.length}</span>}</h2>
        {!data ? (
          <p className="hint">กำลังโหลด…</p>
        ) : (
          <ul className="members">
            {data.members.map((m) => {
              const you = m.userId === me.id;
              const options = ROLES.filter((r) => r === m.role || canAssignRole(org.role, m.role, r));
              return (
                <li key={m.userId}>
                  <div>
                    <strong>{m.displayName ?? m.email ?? "ผู้ใช้"}{you && " (คุณ)"}</strong>
                    {m.email && m.displayName && <span className="hint">{m.email}</span>}
                  </div>
                  <select
                    aria-label={`บทบาทของ ${m.email ?? m.displayName}`}
                    value={m.role}
                    disabled={busy || options.length < 2}
                    onChange={(e) => void run(async () => { await api.setMemberRole(org.id, m.userId, e.target.value as Role); load(); if (you) onChanged(); }, null, "เปลี่ยนบทบาทไม่สำเร็จ")}
                  >
                    {options.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
                  </select>
                  {you
                    ? !org.personal && (
                        <button className="quiet danger-text" disabled={busy} onClick={() => window.confirm(`ออกจาก "${org.name}"?`) && void run(async () => { await api.removeMember(org.id, m.userId); onChanged(); window.location.hash = "#/"; }, null, "ออกจากองค์กรไม่สำเร็จ")}>
                          ออกจากองค์กร
                        </button>
                      )
                    : canAssignRole(org.role, m.role, null) && (
                        <button className="quiet danger-text" disabled={busy} onClick={() => window.confirm(`นำ ${m.email ?? m.displayName} ออกจากองค์กร?`) && void run(async () => { await api.removeMember(org.id, m.userId); load(); }, null, "นำออกไม่สำเร็จ")}>
                          นำออก
                        </button>
                      )}
                </li>
              );
            })}
          </ul>
        )}

        {manage && data && data.invitations.length > 0 && (
          <>
            <h3 className="sub">คำเชิญที่ยังไม่ตอบรับ</h3>
            <ul className="members">
              {data.invitations.map((i) => (
                <li key={i.id}>
                  <div>
                    <strong>{i.email}</strong>
                    <span className="hint">{i.expiresAt < Date.now() ? "หมดอายุแล้ว" : `หมดอายุ ${new Date(i.expiresAt).toLocaleDateString("th-TH")}`}</span>
                  </div>
                  <span>{ROLE_LABEL[i.role]}</span>
                  <button className="quiet danger-text" disabled={busy} onClick={() => void run(async () => { await api.cancelInvitation(i.id); load(); }, null, "ยกเลิกไม่สำเร็จ")}>
                    ยกเลิก
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}

        {manage && <InviteForm actor={org.role} busy={busy} onInvite={(email, role) => void run(async () => { await api.invite(org.id, email, role); load(); }, `ส่งคำเชิญถึง ${email} แล้ว ผู้รับต้องเข้าสู่ระบบด้วยอีเมลนี้แล้วกดรับคำเชิญ`, "ส่งคำเชิญไม่สำเร็จ")} />}
      </section>

      <CreateOrg busy={busy} onCreate={(name) => void run(async () => { const r = await api.createOrg(name); onChanged(); onSwitch(r.organization.id); }, `สร้าง "${name}" แล้ว`, "สร้างองค์กรไม่สำเร็จ")} />

      {can(org.role, "org.delete") && !org.personal && (
        <DeleteOrg org={org} busy={busy} onDelete={() => void run(async () => {
          await api.deleteOrg(org.id);
          onChanged();
          onSwitch(me.organizations.find((o) => o.personal)?.id ?? me.organizations[0]!.id);
          window.location.hash = "#/";
        }, null, "ลบองค์กรไม่สำเร็จ")} />
      )}
    </div>
  );
}

function RenameOrg({ org, busy, onSave }: { org: Organization; busy: boolean; onSave: (name: string) => void }) {
  const [name, setName] = useState(org.name);
  useEffect(() => setName(org.name), [org.name]);
  return (
    <section className="dv-section">
      <form className="row" onSubmit={(e) => { e.preventDefault(); if (name.trim() && name.trim() !== org.name) onSave(name.trim()); }}>
        <label className="grow-label">
          ชื่อองค์กร
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />
        </label>
        <button className="secondary" disabled={busy || !name.trim() || name.trim() === org.name}>บันทึกชื่อ</button>
      </form>
    </section>
  );
}

function InviteForm({ actor, busy, onInvite }: { actor: Role; busy: boolean; onInvite: (email: string, role: Role) => void }) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("member");
  const roles = ROLES.filter((r) => canAssignRole(actor, null, r));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!/^\S+@\S+\.\S+$/.test(email.trim())) return;
    onInvite(email.trim(), role);
    setEmail("");
  };
  return (
    <form className="row invite-form" onSubmit={submit}>
      <label className="grow-label">
        เชิญด้วยอีเมล
        <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@example.com" required />
      </label>
      <label>
        บทบาท
        <select value={role} onChange={(e) => setRole(e.target.value as Role)}>
          {roles.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
        </select>
      </label>
      <button className="primary" disabled={busy}>ส่งคำเชิญ</button>
      <p className="hint role-help">ผู้ดู: ดูอย่างเดียว · สมาชิก: แก้กฎแจ้งเตือนและกดรับทราบ · ผู้ดูแล: จัดการอุปกรณ์ สมาชิก และการแจ้งเตือน · เจ้าของ: ทุกอย่างรวมถึงลบองค์กร</p>
    </form>
  );
}

function CreateOrg({ busy, onCreate }: { busy: boolean; onCreate: (name: string) => void }) {
  const [name, setName] = useState("");
  return (
    <section className="dv-section">
      <h2>สร้างองค์กรใหม่</h2>
      <p className="hint">ใช้เมื่ออยากแยกอุปกรณ์เป็นกลุ่ม เช่น ต่อสาขาหรือต่อลูกค้า แล้วเชิญคนที่เกี่ยวข้องเข้าแต่ละกลุ่ม ย้ายอุปกรณ์เข้าได้ที่หน้าตั้งค่าของอุปกรณ์</p>
      <form className="row" onSubmit={(e) => { e.preventDefault(); if (name.trim()) { onCreate(name.trim()); setName(""); } }}>
        <label className="grow-label">
          ชื่อองค์กร
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} placeholder="เช่น สาขาบางนา" />
        </label>
        <button className="secondary" disabled={busy || !name.trim()}>สร้าง</button>
      </form>
    </section>
  );
}

function DeleteOrg({ org, busy, onDelete }: { org: Organization; busy: boolean; onDelete: () => void }) {
  const [confirm, setConfirm] = useState("");
  return (
    <section className="dv-section settings">
      <div className="danger-row first">
        <div>
          <strong>ลบองค์กร</strong>
          <p className="hint">ต้องย้ายหรือลบอุปกรณ์ทั้งหมดก่อน สมาชิกทุกคนจะหมดสิทธิ์ทันที พิมพ์ชื่อองค์กรเพื่อยืนยัน</p>
          <input value={confirm} onChange={(e) => setConfirm(e.target.value)} aria-label="พิมพ์ชื่อองค์กรเพื่อยืนยัน" />
        </div>
        <button className="danger" disabled={busy || confirm.trim() !== org.name} onClick={onDelete}>ลบองค์กร</button>
      </div>
    </section>
  );
}
