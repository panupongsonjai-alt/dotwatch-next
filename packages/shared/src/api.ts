import type { Role } from "./permissions";
import type { Invitation } from "./orgs";

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
  /** Offline alarm after this many seconds without a reading; null = off. */
  offlineAfterSec: number | null;
  latest: Record<string, MetricValue>;
}

export interface Me {
  id: string;
  email: string | null;
  displayName: string | null;
  /** Invitations can be accepted only with a verified email (always true in dev mode). */
  emailVerified: boolean;
  organizations: Organization[];
  /** Pending invitations for this user's email. */
  invitations: Invitation[];
}

export interface CreateDeviceResponse {
  device: Device;
  /** Shown once. Store it on the device; the server keeps only a hash. */
  secret: string;
}

/** A device counts as offline after this long without a reading. */
export const OFFLINE_AFTER_MS = 5 * 60 * 1000;
