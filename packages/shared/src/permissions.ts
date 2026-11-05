/**
 * Single permission model (ADR 0001, decision 7):
 * an organization owns every device; access = role in that organization.
 */
export const ROLES = ["owner", "admin", "member", "viewer"] as const;
export type Role = (typeof ROLES)[number];

export const ACTIONS = [
  "device.read",
  "device.create",
  "device.update",
  "device.delete",
  "device.reset_secret",
  "alarm.edit",
  "alarm.ack",
  "org.manage_members",
  "org.delete",
] as const;
export type Action = (typeof ACTIONS)[number];

const MIN_ROLE: Record<Action, Role> = {
  "device.read": "viewer",
  "alarm.ack": "member",
  "alarm.edit": "member",
  "device.update": "admin",
  "device.create": "admin",
  "device.delete": "admin",
  "device.reset_secret": "admin",
  "org.manage_members": "admin",
  "org.delete": "owner",
};

const RANK: Record<Role, number> = { viewer: 0, member: 1, admin: 2, owner: 3 };

export function isRole(value: unknown): value is Role {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value);
}

/** The only permission check in the system. `role` is the user's role in the device's organization, or null. */
export function can(role: Role | null | undefined, action: Action): boolean {
  if (!role) return false;
  return RANK[role] >= RANK[MIN_ROLE[action]];
}
