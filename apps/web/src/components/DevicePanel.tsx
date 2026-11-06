import { memo } from "react";
import type { Device, Severity } from "@dotwatch/shared";
import { ago, describeMetric, freshness, isOffline, orderMetrics } from "../lib/devices";
import { SEVERITY_LABEL } from "../lib/alarms";
import { deviceHref } from "../lib/route";

interface Props {
  device: Device;
  now: number;
  /** Most severe open alarm on this device, if any. */
  alarm?: Severity;
}

export const DevicePanel = memo(function DevicePanel({ device, now, alarm }: Props) {
  const offline = isOffline(device.lastSeenAt, now);
  const keys = orderMetrics(Object.keys(device.latest), device.metrics);
  const [primaryKey, ...rest] = keys;
  const primary = primaryKey ? device.latest[primaryKey] : undefined;
  const primaryMeta = primaryKey ? describeMetric(primaryKey, device.metrics) : null;
  const fresh = freshness(device.lastSeenAt, now);

  return (
    <a className="panel-link" href={deviceHref(device.id)}>
    <article className={`panel${offline ? " is-offline" : ""}${alarm ? ` has-${alarm}` : ""}`} aria-label={device.name}>
      <header className="panel-head">
        <h2>{device.name}</h2>
        {alarm ? <span className={`badge badge-${alarm}`}>{SEVERITY_LABEL[alarm]}</span> : <span className="code">{device.code}</span>}
      </header>

      {primary && primaryMeta ? (
        <p className="reading">
          <span className="value">{primary.value.toFixed(primaryMeta.digits)}</span>
          <span className="unit">{primaryMeta.unit}</span>
          <span className="label">{primaryMeta.label}</span>
        </p>
      ) : (
        <p className="reading reading-none">ยังไม่มีข้อมูล</p>
      )}

      {rest.length > 0 && (
        <dl className="minor">
          {rest.map((k) => {
            const m = describeMetric(k, device.metrics);
            const v = device.latest[k]!;
            return (
              <div key={k}>
                <dt>{m.label}</dt>
                <dd>{v.value.toFixed(m.digits)}{m.unit && <span className="unit">{m.unit}</span>}</dd>
              </div>
            );
          })}
        </dl>
      )}

      <footer className="panel-foot">
        <div className="fresh" aria-hidden="true">
          <span style={{ transform: `scaleX(${fresh})` }} />
        </div>
        <p className="seen">
          {offline && <strong>ออฟไลน์</strong>}
          <span>{device.lastSeenAt ? `ส่งค่าล่าสุด ${ago(now - device.lastSeenAt)}` : "ยังไม่เคยส่งค่า"}</span>
        </p>
      </footer>
    </article>
    </a>
  );
});
