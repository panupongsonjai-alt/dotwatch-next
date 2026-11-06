import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { can, type Me } from "@dotwatch/shared";
import { api, ApiError } from "./lib/api";
import { onAuthChange, signOut } from "./lib/auth";
import { realtime, type LinkState } from "./lib/realtime";
import { devicesReducer } from "./lib/devices";
import { alarmsReducer, sortAlarms, worstByDevice } from "./lib/alarms";
import { SignIn } from "./components/SignIn";
import { DevicePanel } from "./components/DevicePanel";
import { AlarmStrip } from "./components/AlarmStrip";
import { AlarmRulesDialog } from "./components/AlarmRulesDialog";
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
  const [openAlarms, dispatchAlarm] = useReducer(alarmsReducer, {});
  const [rulesFor, setRulesFor] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [link, setLink] = useState<LinkState>("connecting");
  const orgIdRef = useRef<string | null>(null);
  orgIdRef.current = orgId;
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

  const loadAlarms = useCallback(() => {
    if (!orgId) return;
    dispatchAlarm({ type: "load", events: [] });
    api.openAlarms(orgId).then(
      (r) => dispatchAlarm({ type: "load", events: r.events }),
      () => setLoadError("โหลดรายการแจ้งเตือนไม่สำเร็จ ระบบจะลองใหม่เมื่อเชื่อมต่อกลับมา"),
    );
  }, [orgId]);

  useEffect(loadAlarms, [loadAlarms]);

  useEffect(() => {
    realtime.start();
    const offState = realtime.onState(setLink);
    const offMsg = realtime.onMessage((msg) => {
      if (msg.type === "values") dispatch({ type: "values", values: msg.values });
      if (msg.type === "device_seen") dispatch({ type: "seen", deviceId: msg.deviceId, lastSeenAt: msg.lastSeenAt });
      if (msg.type === "alarm" && msg.orgId === orgIdRef.current) dispatchAlarm({ type: "event", event: msg.event });
    });
    return () => {
      offState();
      offMsg();
      realtime.stop();
    };
  }, []);

  useEffect(() => realtime.onResync(loadDevices), [loadDevices]);
  useEffect(() => realtime.onResync(loadAlarms), [loadAlarms]);

  useEffect(() => {
    if (!orgId) return;
    realtime.subscribe(orgId);
    return () => realtime.unsubscribe(orgId);
  }, [orgId]);

  const list = useMemo(() => Object.values(devices).sort((a, b) => a.name.localeCompare(b.name, "th")), [devices]);
  const org = me?.organizations.find((o) => o.id === orgId);
  const alarmList = useMemo(() => sortAlarms(Object.values(openAlarms)), [openAlarms]);
  const worst = useMemo(() => worstByDevice(alarmList), [alarmList]);
  const ack = useCallback(async (id: string) => {
    const r = await api.ackAlarm(id);
    dispatchAlarm({ type: "event", event: r.event });
  }, []);
  const rulesDevice = rulesFor ? devices[rulesFor] : undefined;

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
        <AlarmStrip events={alarmList} devices={devices} now={now} canAck={can(org?.role, "alarm.ack")} onAck={ack} />
        {me && list.length === 0 && !loadError && (
          <section className="empty">
            <h1>ยังไม่มีอุปกรณ์ในองค์กรนี้</h1>
            <p>รัน <code>npm run db:seed</code> แล้ว <code>npm run simulate</code> เพื่อดูอุปกรณ์จำลองส่งค่าเข้ามา หรือแฟลชบอร์ดด้วยเฟิร์มแวร์ใน <code>firmware/esp32</code></p>
          </section>
        )}
        <div className="grid">
          {list.map((d) => (
            <DevicePanel key={d.id} device={d} now={now} alarm={worst[d.id]} onRules={setRulesFor} />
          ))}
        </div>
        {rulesDevice && (
          <AlarmRulesDialog
            key={rulesDevice.id}
            device={rulesDevice}
            canEdit={can(org?.role, "alarm.edit")}
            onClose={() => setRulesFor(null)}
          />
        )}
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
