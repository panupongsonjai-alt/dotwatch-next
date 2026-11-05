import type { Device, Me } from "@dotwatch/shared";
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
};
