import type { Role } from "./permissions";

export interface Organization {
  id: string;
  name: string;
  personal: boolean;
  role: Role;
}

export interface MetricValue {
  time: number;
  value: number;
}

export interface Device {
  id: string;
  orgId: string;
  code: string;
  name: string;
  lastSeenAt: number | null;
  firmwareVersion: string | null;
  latest: Record<string, MetricValue>;
}

export interface Me {
  id: string;
  email: string | null;
  displayName: string | null;
  organizations: Organization[];
}

export interface CreateDeviceResponse {
  device: Device;
  /** Shown once. Store it on the device; the server keeps only a hash. */
  secret: string;
}

/** A device counts as offline after this long without a reading. */
export const OFFLINE_AFTER_MS = 5 * 60 * 1000;
