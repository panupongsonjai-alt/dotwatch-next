import type { Organization, Role } from "@dotwatch/shared";
import { withTransaction, type Pool } from "../db/pool";
import type { VerifiedToken } from "./userToken";

export interface CurrentUser {
  id: string;
  uid: string;
  email: string | null;
  displayName: string | null;
}

/**
 * One indexed read per request. Only the very first sign-in writes:
 * user + personal organization + owner membership (decision 7).
 */
export async function resolveUser(pool: Pool, token: VerifiedToken): Promise<CurrentUser> {
  const found = await pool.query<{ id: string; email: string | null; display_name: string | null }>(
    "select id, email, display_name from users where firebase_uid = $1",
    [token.uid],
  );
  const row = found.rows[0];
  if (row) return { id: row.id, uid: token.uid, email: row.email, displayName: row.display_name };

  return withTransaction(pool, async (client) => {
    const inserted = await client.query<{ id: string }>(
      `insert into users (firebase_uid, email, display_name) values ($1, $2, $3)
       on conflict (firebase_uid) do nothing returning id`,
      [token.uid, token.email, token.name],
    );
    const newId = inserted.rows[0]?.id;
    if (!newId) {
      // another request created this user at the same moment
      const again = await client.query<{ id: string }>("select id from users where firebase_uid = $1", [token.uid]);
      return { id: again.rows[0]!.id, uid: token.uid, email: token.email, displayName: token.name };
    }
    const label = token.name || token.email || "ส่วนตัว";
    const org = await client.query<{ id: string }>(
      "insert into organizations (name, personal) values ($1, true) returning id",
      [label],
    );
    await client.query("insert into memberships (org_id, user_id, role) values ($1, $2, 'owner')", [org.rows[0]!.id, newId]);
    return { id: newId, uid: token.uid, email: token.email, displayName: token.name };
  });
}

export async function roleInOrg(pool: Pool, userId: string, orgId: string): Promise<Role | null> {
  const { rows } = await pool.query<{ role: Role }>(
    "select role from memberships where user_id = $1 and org_id = $2",
    [userId, orgId],
  );
  return rows[0]?.role ?? null;
}

export async function listOrganizations(pool: Pool, userId: string): Promise<Organization[]> {
  const { rows } = await pool.query<{ id: string; name: string; personal: boolean; role: Role }>(
    `select o.id, o.name, o.personal, m.role
       from memberships m join organizations o on o.id = m.org_id
      where m.user_id = $1
      order by o.personal desc, o.name`,
    [userId],
  );
  return rows;
}
