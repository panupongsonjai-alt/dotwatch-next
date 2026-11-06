import { useState, type FormEvent } from "react";
import { authErrorText, authMode, resetPassword, signIn, signUp } from "../lib/auth";

type Mode = "signin" | "signup" | "reset";

export function SignIn() {
  const [mode, setMode] = useState<Mode>("signin");
  const [identity, setIdentity] = useState(authMode === "dev" ? "dev-user" : "");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const dev = authMode === "dev";

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setInfo(null);
    try {
      if (mode === "signin") await signIn(identity, password);
      else if (mode === "signup") await signUp(identity, password);
      else {
        await resetPassword(identity);
        setInfo("ส่งลิงก์ตั้งรหัสผ่านใหม่ไปที่อีเมลแล้ว ถ้าไม่เห็นให้ดูในโฟลเดอร์สแปม");
      }
    } catch (err) {
      setError(authErrorText(err));
    } finally {
      setBusy(false);
    }
  }

  const switchTo = (m: Mode) => {
    setMode(m);
    setError(null);
    setInfo(null);
  };

  return (
    <main className="signin">
      <form onSubmit={submit}>
        <div className="brand brand-lg">dotWatch</div>
        {!dev && <h1 className="signin-title">{mode === "signin" ? "เข้าสู่ระบบ" : mode === "signup" ? "สร้างบัญชี" : "ลืมรหัสผ่าน"}</h1>}
        <label>
          {dev ? "ชื่อผู้ใช้ (โหมดพัฒนา)" : "อีเมล"}
          <input
            value={identity}
            onChange={(e) => setIdentity(e.target.value)}
            autoComplete={dev ? "username" : "email"}
            type={dev ? "text" : "email"}
            required
          />
        </label>
        {!dev && mode !== "reset" && (
          <label>
            รหัสผ่าน
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete={mode === "signup" ? "new-password" : "current-password"}
              minLength={6}
              required
            />
          </label>
        )}
        {error && <p className="form-error" role="alert">{error}</p>}
        {info && <p className="hint" role="status">{info}</p>}
        <button disabled={busy}>
          {busy ? "กำลังดำเนินการ…" : mode === "signin" ? "เข้าสู่ระบบ" : mode === "signup" ? "สร้างบัญชี" : "ส่งลิงก์ตั้งรหัสผ่านใหม่"}
        </button>
        {dev ? (
          <p className="hint">ใส่ชื่อใดก็ได้ ถ้าจะทดสอบคำเชิญให้ใส่ <code>ชื่อ:อีเมล</code> เช่น <code>mike:mike@example.com</code></p>
        ) : (
          <p className="signin-links">
            {mode !== "signin" && <button type="button" className="link-button" onClick={() => switchTo("signin")}>เข้าสู่ระบบ</button>}
            {mode !== "signup" && <button type="button" className="link-button" onClick={() => switchTo("signup")}>สร้างบัญชีใหม่</button>}
            {mode !== "reset" && <button type="button" className="link-button" onClick={() => switchTo("reset")}>ลืมรหัสผ่าน</button>}
          </p>
        )}
        {!dev && mode === "signin" && <p className="hint">ผู้ใช้ระบบเดิมใช้อีเมลและรหัสผ่านเดิมได้เลย</p>}
      </form>
    </main>
  );
}
