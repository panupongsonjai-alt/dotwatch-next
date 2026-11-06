import { can, type Role } from "@dotwatch/shared";
import type { Pool } from "../db/pool";
import { notFound } from "../lib/errors";
import { roleInOrg } from "./users";

/**
 * Looks up a live device and the caller's role in its organization.
 * Devices the caller cannot read look exactly like devices that do not exist (404).
 */
export async function deviceAccess(pool: Pool, userId: string, deviceId: string): Promise<{ orgId: string; role: Role }> {
  const { rows } = await pool.query<{ org_id: string }>("select org_id from devices where id = $1 and deleted_at is null", [deviceId]);
  const device = rows[0];
  if (!device) throw notFound("Device not found.");
  const role = await roleInOrg(pool, userId, device.org_id);
  if (!role || !can(role, "device.read")) throw notFound("Device not found.");
  return { orgId: device.org_id, role };
}
