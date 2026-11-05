import { OFFLINE_AFTER_MS, type Device, type LiveValue } from "@dotwatch/shared";

export type DeviceMap = Record<string, Device>;

export type DeviceAction =
  | { type: "load"; devices: Device[] }
  | { type: "values"; values: LiveValue[] }
  | { type: "seen"; deviceId: string; lastSeenAt: number };

export function devicesReducer(state: DeviceMap, action: DeviceAction): DeviceMap {
  switch (action.type) {
    case "load":
      return Object.fromEntries(action.devices.map((d) => [d.id, d]));
    case "values": {
      let next = state;
      for (const v of action.values) {
        const d = next[v.deviceId];
        if (!d) continue;
        const prev = d.latest[v.metric];
        if (prev && prev.time > v.time) continue;
        if (next === state) next = { ...state };
        next[v.deviceId] = { ...d, latest: { ...d.latest, [v.metric]: { time: v.time, value: v.value } } };
      }
      return next;
    }
    case "seen": {
      const d = state[action.deviceId];
      if (!d || (d.lastSeenAt ?? 0) >= action.lastSeenAt) return state;
      return { ...state, [action.deviceId]: { ...d, lastSeenAt: action.lastSeenAt } };
    }
  }
}

/** 1 = just reported, 0 = about to count as offline. */
export function freshness(lastSeenAt: number | null, now: number): number {
  if (!lastSeenAt) return 0;
  return Math.max(0, Math.min(1, 1 - (now - lastSeenAt) / OFFLINE_AFTER_MS));
}

export function isOffline(lastSeenAt: number | null, now: number): boolean {
  return !lastSeenAt || now - lastSeenAt > OFFLINE_AFTER_MS;
}

const METRIC_LABELS: Record<string, { label: string; unit: string; digits: number }> = {
  temperature: { label: "อุณหภูมิ", unit: "°C", digits: 1 },
  humidity: { label: "ความชื้น", unit: "%", digits: 0 },
};

export function describeMetric(key: string) {
  return METRIC_LABELS[key] ?? { label: key.replace(/_/g, " "), unit: "", digits: 2 };
}

/** Temperature first, then humidity, then the rest alphabetically. */
export function orderMetrics(keys: string[]): string[] {
  const rank = (k: string) => (k === "temperature" ? 0 : k === "humidity" ? 1 : 2);
  return [...keys].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

export function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} วินาทีที่แล้ว`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} นาทีที่แล้ว`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} ชั่วโมงที่แล้ว`;
  return `${Math.round(h / 24)} วันที่แล้ว`;
}
