import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { can, type Device, type Me } from "@dotwatch/shared";
import { api, ApiError } from "./lib/api";
import { onAuthChange, signOut } from "./lib/auth";
import { realtime, type LinkState } from "./lib/realtime";
import { devicesReducer } from "./lib/devices";
import { alarmsReducer, sortAlarms, worstByDevice } from "./lib/alarms";
import { NOTIFICATIONS_HREF, useRoute } from "./lib/route";
import { SignIn } from "./components/SignIn";
import { DevicePanel } from "./components/DevicePanel";
import { AlarmStrip } from "./components/AlarmStrip";
import { DeviceView } from "./components/DeviceView";
import { AddDeviceDialog } from "./components/AddDeviceDialog";
import { NotificationsPage } from "./components/NotificationsPage";
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
  const [devicesLoaded, setDevicesLoaded] = useState(false);
  const [openAlarms, dispatchAlarm] = useReducer(alarmsReducer, {});
  const [loadError, setLoadError] = useState<string | null>(null);
  const [link, setLink] = useState<LinkState>("connecting");
  const [adding, setAdding] = useState(false);
  const orgIdRef = useRef<string | null>(null);
  orgIdRef.current = orgId;
  const now = useNow(1000);
  const route = useRoute();

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
        setDevicesLoaded(true);
        setLoadError(null);
      },
      () => setLoadError("โหลดรายการอุปกรณ์ไม่สำเร็จ ระบบจะลองใหม่เมื่อเชื่อมต่อกลับมา"),
    );
  }, [orgId]);

  const loadAlarms = useCallback(() => {
    if (!orgId) return;
    api.openAlarms(orgId).then(
      (r) => dispatchAlarm({ type: "load", events: r.events }),
      () => setLoadError("โหลดรายการแจ้งเตือนไม่สำเร็จ ระบบจะลองใหม่เมื่อเชื่อมต่อกลับมา"),
    );
  }, [orgId]);

  useEffect(() => {
    setDevicesLoaded(false);
    dispatch({ type: "load", devices: [] });
    dispatchAlarm({ type: "load", events: [] });
    loadDevices();
    loadAlarms();
  }, [loadDevices, loadAlarms]);

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
  const upsert = useCallback((device: Device) => dispatch({ type: "upsert", device }), []);
  const remove = useCallback((deviceId: string) => dispatch({ type: "remove", deviceId }), []);

  const current = route.name === "device" ? devices[route.id] : undefined;

  return (
    <div className="shell">
      <header className="bar">
        <a className="brand" href="#/">dotWatch</a>
        {me && me.organizations.length > 1 ? (
          <select
            className="org"
            value={orgId ?? ""}
            onChange={(e) => {
              setOrgId(e.target.value);
              window.location.hash = "#/";
            }}
            aria-label="องค์กร"
          >
            {me.organizations.map((o) => (
              <option key={o.id} value={o.id}>{o.personal ? `${o.name} (ส่วนตัว)` : o.name}</option>
            ))}
          </select>
        ) : (
          <div className="org-name">{org?.name}</div>
        )}
        <LinkStatus state={link} />
        {can(org?.role, "notify.manage") && <a className="quiet nav" href={NOTIFICATIONS_HREF}>การแจ้งเตือน</a>}
        <button className="quiet" onClick={() => void signOut()}>ออกจากระบบ</button>
      </header>

      <main>
        {loadError && <p className="notice" role="alert">{loadError}</p>}

        {route.name === "notifications" ? (
          orgId && org && <NotificationsPage key={orgId} orgId={orgId} orgName={org.name} now={now} />
        ) : route.name === "device" ? (
          current ? (
            <DeviceView
              key={current.id}
              device={current}
              role={org?.role}
              now={now}
              openAlarms={alarmList.filter((e) => e.deviceId === current.id)}
              onAck={ack}
              onUpdated={upsert}
              onDeleted={remove}
            />
          ) : (
            devicesLoaded && (
              <section className="empty">
                <h1>ไม่พบอุปกรณ์นี้</h1>
                <p>อาจถูกลบไปแล้ว หรืออยู่ในองค์กรอื่น <a href="#/">กลับไปหน้าอุปกรณ์ทั้งหมด</a></p>
              </section>
            )
          )
        ) : (
          <>
            <AlarmStrip events={alarmList} devices={devices} now={now} canAck={can(org?.role, "alarm.ack")} onAck={ack} />
            <div className="section-head">
              <h1 className="page-title">อุปกรณ์ {devicesLoaded && <span className="count-muted">{list.length}</span>}</h1>
              {orgId && can(org?.role, "device.create") && (
                <button className="primary" onClick={() => setAdding(true)}>+ เพิ่มอุปกรณ์</button>
              )}
            </div>
            {devicesLoaded && list.length === 0 && !loadError && (
              <section className="empty">
                <h2>ยังไม่มีอุปกรณ์ในองค์กรนี้</h2>
                <p>กด "เพิ่มอุปกรณ์" แล้วใส่รหัสที่ได้ในบอร์ด หรือรัน <code>npm run db:seed</code> กับ <code>npm run simulate</code> เพื่อดูอุปกรณ์จำลอง</p>
              </section>
            )}
            <div className="grid">
              {list.map((d) => (
                <DevicePanel key={d.id} device={d} now={now} alarm={worst[d.id]} />
              ))}
            </div>
          </>
        )}

        {adding && orgId && (
          <AddDeviceDialog orgId={orgId} onCreated={(r) => upsert(r.device)} onClose={() => setAdding(false)} />
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
