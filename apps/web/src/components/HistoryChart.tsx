import { useEffect, useMemo, useRef, useState, type PointerEvent } from "react";
import type { HistoryPoint } from "@dotwatch/shared";
import { describeMetric, formatValue, type MetricSettings } from "../lib/devices";
import { bandPath, linePath, nearest, niceTicks, scaler, segments, timeLabel, timeTicks, yDomain, type Box } from "../lib/chart";

export interface LimitLine {
  value: number;
  severity: "warning" | "critical";
}

interface Props {
  metric: string;
  points: HistoryPoint[];
  bucketMs: number;
  from: number;
  to: number;
  limits: LimitLine[];
  settings?: MetricSettings;
}

const HEIGHT = 200;

/** Average line over a min–max band, alarm limits as dashed lines, gaps where the device was silent. */
export function HistoryChart({ metric, points, bucketMs, from, to, limits, settings }: Props) {
  const wrap = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(640);
  const [hoverT, setHoverT] = useState<number | null>(null);
  const meta = describeMetric(metric, settings);

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setWidth(Math.max(280, Math.round(entry!.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const box: Box = { width, height: HEIGHT, left: 44, right: 12, top: 10, bottom: 24 };
  const [lo, hi] = useMemo(() => yDomain(points, limits.map((l) => l.value)), [points, limits]);
  const s = scaler(box, from, to, lo, hi);
  const segs = useMemo(() => segments(points, bucketMs), [points, bucketMs]);
  const yTicks = niceTicks(lo, hi, 4);
  const xTicks = timeTicks(from, to);
  const hover = hoverT === null ? null : nearest(points, hoverT, bucketMs);
  const backfilled = points.some((p) => p.backfilled);

  const onMove = (e: PointerEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    setHoverT(s.t(((e.clientX - rect.left) / rect.width) * width));
  };

  return (
    <figure className="chart">
      <figcaption>
        <span className="chart-title">{meta.label}</span>
        {hover ? (
          <span className="chart-read">
            {timeLabel(hover.t, 2 * 86_400_000)} · เฉลี่ย {formatValue(metric, hover.avg, settings)} (ต่ำสุด{" "}
            {formatValue(metric, hover.min, settings)} สูงสุด {formatValue(metric, hover.max, settings)})
          </span>
        ) : (
          points.length > 0 && <span className="chart-read muted">ชี้บนกราฟเพื่อดูค่า</span>
        )}
      </figcaption>
      <div ref={wrap} className="chart-wrap">
        {points.length === 0 ? (
          <p className="chart-empty">ไม่มีข้อมูลในช่วงนี้</p>
        ) : (
          <svg
            width={width}
            height={HEIGHT}
            viewBox={`0 0 ${width} ${HEIGHT}`}
            role="img"
            aria-label={`กราฟ${meta.label}`}
            onPointerMove={onMove}
            onPointerLeave={() => setHoverT(null)}
          >
            {yTicks.map((v) => (
              <g key={v}>
                <line className="grid-line" x1={box.left} x2={width - box.right} y1={s.y(v)} y2={s.y(v)} />
                <text className="axis" x={box.left - 6} y={s.y(v)} textAnchor="end" dominantBaseline="middle">
                  {v.toFixed(Math.max(0, meta.digits - (Math.abs(hi - lo) > 10 ? 1 : 0)))}
                </text>
              </g>
            ))}
            {xTicks.map((t) => (
              <text key={t} className="axis" x={s.x(t)} y={HEIGHT - 6} textAnchor="middle">
                {timeLabel(t, to - from)}
              </text>
            ))}
            {limits.map((l) => (
              <line key={`${l.severity}${l.value}`} className={`limit limit-${l.severity}`} x1={box.left} x2={width - box.right} y1={s.y(l.value)} y2={s.y(l.value)} />
            ))}
            <path className="band" d={bandPath(segs, bucketMs, s.x, s.y)} />
            <path className="line" d={linePath(segs, bucketMs, s.x, s.y)} />
            {hover && (
              <g>
                <line className="cross" x1={s.x(hover.t + bucketMs / 2)} x2={s.x(hover.t + bucketMs / 2)} y1={box.top} y2={HEIGHT - box.bottom} />
                <circle className="dot" cx={s.x(hover.t + bucketMs / 2)} cy={s.y(hover.avg)} r={3.5} />
              </g>
            )}
          </svg>
        )}
      </div>
      {backfilled && <p className="chart-note">บางช่วงเป็นข้อมูลที่อุปกรณ์เก็บไว้ตอนออฟไลน์แล้วส่งตามมา</p>}
    </figure>
  );
}
