import { z } from "zod";
import { can, ROLES, type Role } from "./permissions";

/** Organizations and membership (ADR 0001, decision 7). */
export interface Member {
  userId: string;
  email: string | null;
  displayName: string | null;
  role: Role;
}

export interface Invitation {
  id: string;
  orgId: string;
  orgName: string;
  email: string;
  role: Role;
  invitedBy: string | null;
  createdAt: number;
  expiresAt: number;
}

export interface MembersResponse {
  members: Member[];
  /** Only filled for admins and owners. */
  invitations: Invitation[];
}

export const INVITE_DAYS = 14;

const orgName = z.string().trim().min(1).max(80);
export const createOrgSchema = z.object({ name: orgName });
export const renameOrgSchema = z.object({ name: orgName });
export const inviteSchema = z.object({ email: z.string().trim().toLowerCase().email().max(254), role: z.enum(ROLES) });
export const memberRoleSchema = z.object({ role: z.enum(ROLES) });
export const moveDeviceSchema = z.object({ orgId: z.string().uuid() });

/**
 * Who may change whose role. Admins manage members, viewers and other admins;
 * anything that touches the owner role needs an owner. `to = null` means removal.
 */
export function canAssignRole(actor: Role | null | undefined, from: Role | null, to: Role | null): boolean {
  if (!can(actor, "org.manage_members")) return false;
  if (from === "owner" || to === "owner") return actor === "owner";
  return true;
}

export const ROLE_LABEL: Record<Role, string> = {
  owner: "เจ้าของ",
  admin: "ผู้ดูแล",
  member: "สมาชิก",
  viewer: "ผู้ดู",
};
