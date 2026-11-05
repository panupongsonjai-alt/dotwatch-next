/** WebSocket protocol between API and web/mobile (decision 13). */
export interface LiveValue {
  deviceId: string;
  metric: string;
  time: number;
  value: number;
}

export type ClientMessage =
  | { type: "auth"; token: string }
  | { type: "subscribe"; orgId: string }
  | { type: "unsubscribe"; orgId: string };

export type ServerMessage =
  | { type: "ready"; userId: string }
  | { type: "subscribed"; orgId: string }
  | { type: "values"; orgId: string; values: LiveValue[] }
  | { type: "device_seen"; orgId: string; deviceId: string; lastSeenAt: number }
  | { type: "error"; code: "unauthorized" | "forbidden" | "bad_message"; message: string };

/** Server flushes batched values at this interval. */
export const REALTIME_FLUSH_MS = 500;

/** Reconnect delay: exponential with jitter, capped — but attempts are never capped. */
export function reconnectDelayMs(attempt: number, random: () => number = Math.random): number {
  const base = Math.min(30_000, 1_000 * 2 ** Math.min(attempt, 5));
  return Math.round(base / 2 + random() * (base / 2));
}

/** Keep only the newest value per device+metric. */
export function mergeLatest(values: LiveValue[]): LiveValue[] {
  const byKey = new Map<string, LiveValue>();
  for (const v of values) {
    const k = `${v.deviceId}\u0000${v.metric}`;
    const prev = byKey.get(k);
    if (!prev || v.time >= prev.time) byKey.set(k, v);
  }
  return [...byKey.values()];
}
