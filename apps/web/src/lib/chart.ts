import type { HistoryPoint } from "@dotwatch/shared";

export interface Box {
  width: number;
  height: number;
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/** Splits a series where a bucket is missing, so the line is not drawn across an outage. */
export function segments(points: HistoryPoint[], bucketMs: number): HistoryPoint[][] {
  const out: HistoryPoint[][] = [];
  let cur: HistoryPoint[] = [];
  for (const p of points) {
    const prev = cur[cur.length - 1];
    if (prev && p.t - prev.t > bucketMs * 2.5) {
      out.push(cur);
      cur = [];
    }
    cur.push(p);
  }
  if (cur.length) out.push(cur);
  return out;
}

/** Y range covering data and any alarm limits, padded so the line never touches the frame. */
export function yDomain(points: HistoryPoint[], extra: number[] = []): [number, number] {
  const vals = [...points.flatMap((p) => [p.min, p.max]), ...extra];
  if (vals.length === 0) return [0, 1];
  let lo = Math.min(...vals);
  let hi = Math.max(...vals);
  if (hi - lo < 1e-9) {
    lo -= 1;
    hi += 1;
  }
  const pad = (hi - lo) * 0.08;
  return [lo - pad, hi + pad];
}

/** 3–6 round tick values inside [lo, hi]. */
export function niceTicks(lo: number, hi: number, count = 5): number[] {
  const raw = (hi - lo) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = ([1, 2, 2.5, 5, 10].find((s) => s * mag >= raw) ?? 10) * mag;
  const ticks: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) ticks.push(+v.toFixed(10));
  return ticks;
}

export function scaler(box: Box, from: number, to: number, lo: number, hi: number) {
  const w = box.width - box.left - box.right;
  const h = box.height - box.top - box.bottom;
  return {
    x: (t: number) => box.left + ((t - from) / (to - from)) * w,
    y: (v: number) => box.top + (1 - (v - lo) / (hi - lo)) * h,
    t: (x: number) => from + ((x - box.left) / w) * (to - from),
  };
}

const r = (n: number) => Math.round(n * 10) / 10;

/** SVG path of the average line, one sub-path per segment. Points sit in the middle of their bucket. */
export function linePath(segs: HistoryPoint[][], bucketMs: number, x: (t: number) => number, y: (v: number) => number): string {
  return segs
    .map((s) => s.map((p, i) => `${i ? "L" : "M"}${r(x(p.t + bucketMs / 2))},${r(y(p.avg))}`).join(""))
    .join("");
}

/** SVG path of the min–max band per segment. */
export function bandPath(segs: HistoryPoint[][], bucketMs: number, x: (t: number) => number, y: (v: number) => number): string {
  return segs
    .map((s) => {
      const top = s.map((p, i) => `${i ? "L" : "M"}${r(x(p.t + bucketMs / 2))},${r(y(p.max))}`).join("");
      const bottom = [...s].reverse().map((p) => `L${r(x(p.t + bucketMs / 2))},${r(y(p.min))}`).join("");
      return `${top}${bottom}Z`;
    })
    .join("");
}

/** The bucket nearest to time t, or null when nothing is within one bucket. */
export function nearest(points: HistoryPoint[], t: number, bucketMs: number): HistoryPoint | null {
  let best: HistoryPoint | null = null;
  let dist = Infinity;
  for (const p of points) {
    const d = Math.abs(p.t + bucketMs / 2 - t);
    if (d < dist) {
      dist = d;
      best = p;
    }
  }
  return best && dist <= bucketMs * 1.5 ? best : null;
}

const pad2 = (n: number) => String(n).padStart(2, "0");

/** Axis labels: time of day for short ranges, day/month for long ones (local time). */
export function timeLabel(t: number, rangeMs: number): string {
  const d = new Date(t);
  const hm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  if (rangeMs <= 24 * 3_600_000) return hm;
  return `${d.getDate()}/${d.getMonth() + 1}${rangeMs <= 7 * 86_400_000 ? ` ${hm}` : ""}`;
}

/** X ticks on whole hours / days in local time, at most about 6 of them. */
export function timeTicks(from: number, to: number): number[] {
  const h = 3_600_000;
  const range = to - from;
  const ticks: number[] = [];
  const hourSteps = [1, 2, 3, 6, 12];
  const everyH = hourSteps.find((s) => range / (s * h) <= 6);
  const cur = new Date(from);
  if (everyH) {
    cur.setMinutes(0, 0, 0);
    for (; cur.getTime() <= to; cur.setHours(cur.getHours() + 1))
      if (cur.getTime() >= from && cur.getHours() % everyH === 0) ticks.push(cur.getTime());
    return ticks;
  }
  const everyD = [1, 2, 7, 14, 30].find((s) => range / (s * 24 * h) <= 6) ?? 30;
  cur.setHours(0, 0, 0, 0);
  for (let i = 0; cur.getTime() <= to; cur.setDate(cur.getDate() + 1), i++)
    if (cur.getTime() >= from && i % everyD === 0) ticks.push(cur.getTime());
  return ticks;
}
