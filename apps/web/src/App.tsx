import { useCallback, useEffect, useMemo, useReducer, useState } from "react";
import type { Me } from "@dotwatch/shared";
import { api, ApiError } from "./lib/api";
import { onAuthChange, signOut } from "./lib/auth";
import { realtime, type LinkState } from "./lib/realtime";
import { devicesReducer } from "./lib/devices";
import { SignIn } from "./components/SignIn";
import { DevicePanel } from "./components/DevicePanel";
import { useNow } from "./components/useNow";

export function App() {
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  useEffect(() => onAuthChange(setSignedIn), []);
  if (signedIn === null) return null;
  return signedIn ? <Monitor /> : <SignIn />;
}

function Monitor() {
  const [me, setMe] = useState<Me | null>(null);
  const [orgId, setOrgId] = useState<string | null>(null);
  const [devices, dispatch] = useReducer(devicesReducer, {});
  const [loadError, setLoadError] = useState<string | null>(null);
  const [link, setLink] = useState<LinkState>("connecting");
  const now = useNow(1000);

  useEffect(() => {
    api.me().then(
      (m) => {
        setMe(m);
        setOrgId((cur) => cur ?? m.organizations[0]?.id ?? null);
      },
      (err) => {
        if (err instanceof ApiError && err.status === 401) void signOut();
        else setLoadError("เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ ตรวจว่า API เปิดอยู่ แล้วโหลดหน้านี้ใหม่");
      },
    );
  }, []);

  const loadDevices = useCallback(() => {
    if (!orgId) return;
    api.devices(orgId).then(
      (r) => {
        dispatch({ type: "load", devices: r.devices });
        setLoadError(null);
      },
      () => setLoadError("โหลดรายการอุปกรณ์ไม่สำเร็จ ระบบจะลองใหม่เมื่อเชื่อมต่อกลับมา"),
    );
  }, [orgId]);

  useEffect(loadDevices, [loadDevices]);

  useEffect(() => {
    realtime.start();
    const offState = realtime.onState(setLink);
    const offMsg = realtime.onMessage((msg) => {
      if (msg.type === "values") dispatch({ type: "values", values: msg.values });
      if (msg.type === "device_seen") dispatch({ type: "seen", deviceId: msg.deviceId, lastSeenAt: msg.lastSeenAt });
    });
    return () => {
      offState();
      offMsg();
      realtime.stop();
    };
  }, []);

  useEffect(() => realtime.onResync(loadDevices), [loadDevices]);

  useEffect(() => {
    if (!orgId) return;
    realtime.subscribe(orgId);
    return () => realtime.unsubscribe(orgId);
  }, [orgId]);

  const list = useMemo(() => Object.values(devices).sort((a, b) => a.name.localeCompare(b.name, "th")), [devices]);
  const org = me?.organizations.find((o) => o.id === orgId);

  return (
    <div className="shell">
      <header className="bar">
        <div className="brand">dotWatch</div>
        {me && me.organizations.length > 1 ? (
          <select className="org" value={orgId ?? ""} onChange={(e) => setOrgId(e.target.value)} aria-label="องค์กร">
            {me.organizations.map((o) => (
              <option key={o.id} value={o.id}>{o.personal ? `${o.name} (ส่วนตัว)` : o.name}</option>
            ))}
          </select>
        ) : (
          <div className="org-name">{org?.name}</div>
        )}
        <LinkStatus state={link} />
        <button className="quiet" onClick={() => void signOut()}>ออกจากระบบ</button>
      </header>

      <main>
        {loadError && <p className="notice" role="alert">{loadError}</p>}
        {me && list.length === 0 && !loadError && (
          <section className="empty">
            <h1>ยังไม่มีอุปกรณ์ในองค์กรนี้</h1>
            <p>รัน <code>npm run db:seed</code> แล้ว <code>npm run simulate</code> เพื่อดูอุปกรณ์จำลองส่งค่าเข้ามา หรือแฟลชบอร์ดด้วยเฟิร์มแวร์ใน <code>firmware/esp32</code></p>
          </section>
        )}
        <div className="grid">
          {list.map((d) => (
            <DevicePanel key={d.id} device={d} now={now} />
          ))}
        </div>
      </main>
    </div>
  );
}

function LinkStatus({ state }: { state: LinkState }) {
  const text = state === "live" ? "สด" : state === "connecting" ? "กำลังเชื่อมต่อ" : "ขาดการเชื่อมต่อ กำลังต่อใหม่";
  return (
    <div className={`link link-${state}`} role="status" aria-live="polite">
      <span className="dot" aria-hidden="true" />
      {text}
    </div>
  );
}
