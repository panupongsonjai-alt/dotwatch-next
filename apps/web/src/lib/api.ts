import type { AlarmEvent, AlarmRule, AlarmRuleInput, Device, Me } from "@dotwatch/shared";
import { getToken } from "./auth";

export const API_URL = (import.meta.env.VITE_API_URL ?? "http://localhost:4000").replace(/\/$/, "");

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = await getToken();
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}), ...init.headers },
    signal: AbortSignal.timeout(20_000),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, body?.message ?? `Request failed (${res.status})`);
  return body as T;
}

export const api = {
  me: () => request<Me>("/v1/me"),
  devices: (orgId: string) => request<{ devices: Device[] }>(`/v1/devices?orgId=${encodeURIComponent(orgId)}`),
  openAlarms: (orgId: string) =>
    request<{ events: AlarmEvent[] }>(`/v1/alarms?state=open&limit=200&orgId=${encodeURIComponent(orgId)}`),
  alarmRules: (deviceId: string) => request<{ rules: AlarmRule[] }>(`/v1/devices/${encodeURIComponent(deviceId)}/alarm-rules`),
  saveAlarmRules: (deviceId: string, rules: AlarmRuleInput[]) =>
    request<{ rules: AlarmRule[] }>(`/v1/devices/${encodeURIComponent(deviceId)}/alarm-rules`, {
      method: "PUT",
      body: JSON.stringify({ rules }),
    }),
  ackAlarm: (id: string) => request<{ event: AlarmEvent }>(`/v1/alarms/${encodeURIComponent(id)}/ack`, { method: "POST" }),
};
