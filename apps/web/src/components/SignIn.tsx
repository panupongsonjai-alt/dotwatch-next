import { useState, type FormEvent } from "react";
import { authMode, signIn } from "../lib/auth";

export function SignIn() {
  const [identity, setIdentity] = useState(authMode === "dev" ? "dev-user" : "");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await signIn(identity, password);
    } catch {
      setError("อีเมลหรือรหัสผ่านไม่ถูกต้อง");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="signin">
      <form onSubmit={submit}>
        <div className="brand brand-lg">dotWatch</div>
        <label>
          {authMode === "dev" ? "ชื่อผู้ใช้ (โหมดพัฒนา)" : "อีเมล"}
          <input
            value={identity}
            onChange={(e) => setIdentity(e.target.value)}
            type={authMode === "dev" ? "text" : "email"}
            autoComplete="username"
            required
          />
        </label>
        {authMode === "firebase" && (
          <label>
            รหัสผ่าน
            <input value={password} onChange={(e) => setPassword(e.target.value)} type="password" autoComplete="current-password" required />
          </label>
        )}
        {error && <p className="notice" role="alert">{error}</p>}
        <button disabled={busy}>{busy ? "กำลังเข้าสู่ระบบ" : "เข้าสู่ระบบ"}</button>
        {authMode === "dev" && <p className="hint">โหมดพัฒนา: ใช้ชื่อ <code>dev-user</code> เพื่อเห็นอุปกรณ์จาก <code>npm run db:seed</code></p>}
      </form>
    </main>
  );
}
