import type {
  AlarmEvent, AlarmRule, AlarmRuleInput, CreateDeviceInput, CreateDeviceResponse, Device, HistoryResponse, Me,
  ResetSecretResponse, UpdateDeviceInput, CreateTargetInput, NotificationSettings, NotificationTarget,
  NotificationsResponse, UpdateTargetInput, Invitation, MembersResponse, Organization, Role, MetricSettingsInput,
} from "@dotwatch/shared";
import { getToken } from "./auth";

import { config } from "./config";

export const API_URL = config.apiUrl;

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
  const body = res.status === 204 ? null : await res.json().catch(() => null);
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
  deviceAlarms: (deviceId: string, limit = 20) =>
    request<{ events: AlarmEvent[] }>(`/v1/alarms?state=all&limit=${limit}&deviceId=${encodeURIComponent(deviceId)}`),
  createDevice: (input: CreateDeviceInput) =>
    request<CreateDeviceResponse>("/v1/devices", { method: "POST", body: JSON.stringify(input) }),
  updateDevice: (id: string, input: UpdateDeviceInput) =>
    request<{ device: Device }>(`/v1/devices/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(input) }),
  deleteDevice: (id: string) => request<null>(`/v1/devices/${encodeURIComponent(id)}`, { method: "DELETE" }),
  resetSecret: (id: string) => request<ResetSecretResponse>(`/v1/devices/${encodeURIComponent(id)}/reset-secret`, { method: "POST" }),
  history: (id: string, metrics: string[], from: number, to: number) =>
    request<HistoryResponse>(
      `/v1/devices/${encodeURIComponent(id)}/history?metrics=${encodeURIComponent(metrics.join(","))}&from=${from}&to=${to}`,
    ),
  notifications: (orgId: string) => request<NotificationsResponse>(`/v1/orgs/${encodeURIComponent(orgId)}/notifications`),
  saveNotifySettings: (orgId: string, settings: NotificationSettings) =>
    request<{ settings: NotificationSettings }>(`/v1/orgs/${encodeURIComponent(orgId)}/notifications/settings`, {
      method: "PUT",
      body: JSON.stringify(settings),
    }),
  addTarget: (orgId: string, input: CreateTargetInput) =>
    request<{ target: NotificationTarget }>(`/v1/orgs/${encodeURIComponent(orgId)}/notification-targets`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
  updateTarget: (id: string, input: UpdateTargetInput) =>
    request<{ target: NotificationTarget }>(`/v1/notification-targets/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(input) }),
  deleteTarget: (id: string) => request<null>(`/v1/notification-targets/${encodeURIComponent(id)}`, { method: "DELETE" }),
  newLinkCode: (id: string) => request<{ target: NotificationTarget }>(`/v1/notification-targets/${encodeURIComponent(id)}/link-code`, { method: "POST" }),
  testTarget: (id: string) => request<{ queued: boolean }>(`/v1/notification-targets/${encodeURIComponent(id)}/test`, { method: "POST" }),
  createOrg: (name: string) => request<{ organization: Organization }>("/v1/orgs", { method: "POST", body: JSON.stringify({ name }) }),
  renameOrg: (orgId: string, name: string) =>
    request<{ ok: true }>(`/v1/orgs/${encodeURIComponent(orgId)}`, { method: "PATCH", body: JSON.stringify({ name }) }),
  deleteOrg: (orgId: string) => request<null>(`/v1/orgs/${encodeURIComponent(orgId)}`, { method: "DELETE" }),
  members: (orgId: string) => request<MembersResponse>(`/v1/orgs/${encodeURIComponent(orgId)}/members`),
  invite: (orgId: string, email: string, role: Role) =>
    request<{ invitation: Invitation }>(`/v1/orgs/${encodeURIComponent(orgId)}/invitations`, { method: "POST", body: JSON.stringify({ email, role }) }),
  cancelInvitation: (id: string) => request<null>(`/v1/invitations/${encodeURIComponent(id)}`, { method: "DELETE" }),
  acceptInvitation: (id: string) => request<{ orgId: string }>(`/v1/invitations/${encodeURIComponent(id)}/accept`, { method: "POST" }),
  setMemberRole: (orgId: string, userId: string, role: Role) =>
    request<{ ok: true }>(`/v1/orgs/${encodeURIComponent(orgId)}/members/${encodeURIComponent(userId)}`, { method: "PATCH", body: JSON.stringify({ role }) }),
  removeMember: (orgId: string, userId: string) =>
    request<null>(`/v1/orgs/${encodeURIComponent(orgId)}/members/${encodeURIComponent(userId)}`, { method: "DELETE" }),
  saveMetrics: (id: string, metrics: MetricSettingsInput["metrics"]) =>
    request<{ device: Device }>(`/v1/devices/${encodeURIComponent(id)}/metrics`, { method: "PUT", body: JSON.stringify({ metrics }) }),
  moveDevice: (id: string, orgId: string) =>
    request<{ device: Device }>(`/v1/devices/${encodeURIComponent(id)}/move`, { method: "POST", body: JSON.stringify({ orgId }) }),
  ackAlarm: (id: string) => request<{ event: AlarmEvent }>(`/v1/alarms/${encodeURIComponent(id)}/ack`, { method: "POST" }),
};
