import { useState } from "react";

/** Shows a device's code and secret once, with copy buttons. The server keeps only a hash. */
export function SecretBox({ code, secret }: { code: string; secret: string }) {
  const [copied, setCopied] = useState<string | null>(null);
  const copy = async (label: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(label);
    } catch {
      setCopied(null);
    }
  };
  return (
    <div className="secret">
      <p className="secret-warn">คัดลอกรหัสลับเก็บไว้ตอนนี้ ปิดหน้าต่างแล้วจะดูอีกไม่ได้ ต้องออกรหัสใหม่เท่านั้น</p>
      <dl>
        <div>
          <dt>รหัสอุปกรณ์</dt>
          <dd><code>{code}</code></dd>
          <button type="button" className="secondary" onClick={() => void copy("code", code)}>{copied === "code" ? "คัดลอกแล้ว" : "คัดลอก"}</button>
        </div>
        <div>
          <dt>รหัสลับ</dt>
          <dd><code>{secret}</code></dd>
          <button type="button" className="secondary" onClick={() => void copy("secret", secret)}>{copied === "secret" ? "คัดลอกแล้ว" : "คัดลอก"}</button>
        </div>
      </dl>
      <p className="hint">ใส่ทั้งสองค่าใน <code>config.h</code> ของบอร์ด หรือไฟล์ตั้งค่าของ Pi</p>
    </div>
  );
}
