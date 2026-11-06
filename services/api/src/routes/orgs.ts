import { Router } from "express";
import { z } from "zod";
import {
  can, canAssignRole, createOrgSchema, INVITE_DAYS, inviteSchema, memberRoleSchema, renameOrgSchema, ROLE_LABEL,
  type Invitation, type Member, type MembersResponse, type Organization, type Role,
} from "@dotwatch/shared";
import { withTransaction, type Pool } from "../db/pool";
import { roleInOrg } from "../auth/users";
import { forbidden, HttpError, notFound } from "../lib/errors";
import { log } from "../lib/log";
import type { Broadcaster } from "../realtime/hub";

/** Sends an invitation email; dry-runs to the log without credentials. */
export type InviteMailer = (to: string, subject: string, text: string) => Promise<void>;

interface InvitationRow {
  id: string;
  org_id: string;
  org_name: string;
  email: string;
  role: Role;
  invited_by_name: string | null;
  created_at: Date;
  expires_at: Date;
}

const INVITATION_SELECT = `
  select i.id, i.org_id, o.name as org_name, i.email, i.role,
         coalesce(u.display_name, u.email) as invited_by_name, i.created_at, i.expires_at
    from org_invitations i
    join organizations o on o.id = i.org_id
    left join users u on u.id = i.invited_by`;

const toInvitation = (r: InvitationRow): Invitation => ({
  id: r.id,
  orgId: r.org_id,
  orgName: r.org_name,
  email: r.email,
  role: r.role,
  invitedBy: r.invited_by_name,
  createdAt: r.created_at.getTime(),
  expiresAt: r.expires_at.getTime(),
});

export async function pendingInvitationsFor(pool: Pool, email: string | null): Promise<Invitation[]> {
  if (!email) return [];
  const { rows } = await pool.query<InvitationRow>(
    `${INVITATION_SELECT} where i.email = $1 and i.expires_at > now() order by i.created_at`,
    [email.toLowerCase()],
  );
  return rows.map(toInvitation);
}

const idParam = z.string().uuid();

/**
 * Organizations, members and invitations. Every role change goes through canAssignRole and keeps at least
 * one owner; the owner count is checked with the org's membership rows locked, so two concurrent demotions
 * cannot both succeed.
 */
export function orgRoutes(deps: { pool: Pool; broadcaster: Broadcaster; appUrl: string; mailer: InviteMailer }): Router {
  const router = Router();

  const roleOrThrow = async (userId: string, orgId: string) => {
    const role = await roleInOrg(deps.pool, userId, orgId);
    if (!role) throw notFound("Organization not found.");
    return role;
  };

  router.post("/orgs", async (req, res, next) => {
    try {
      const { name } = createOrgSchema.parse(req.body);
      const org = await withTransaction(deps.pool, async (c) => {
        const { rows } = await c.query<{ id: string }>("insert into organizations (name) values ($1) returning id", [name]);
        await c.query("insert into memberships (org_id, user_id, role) values ($1, $2, 'owner')", [rows[0]!.id, req.user!.id]);
        return rows[0]!.id;
      });
      const body: Organization = { id: org, name, personal: false, role: "owner" };
      res.status(201).json({ organization: body });
    } catch (err) {
      next(err);
    }
  });

  router.patch("/orgs/:orgId", async (req, res, next) => {
    try {
      const orgId = idParam.parse(req.params.orgId);
      const role = await roleOrThrow(req.user!.id, orgId);
      if (!can(role, "org.manage_members")) throw forbidden("Only owners and admins can rename the organization.");
      const { name } = renameOrgSchema.parse(req.body);
      await deps.pool.query("update organizations set name = $2 where id = $1", [orgId, name]);
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  router.delete("/orgs/:orgId", async (req, res, next) => {
    try {
      const orgId = idParam.parse(req.params.orgId);
      const role = await roleOrThrow(req.user!.id, orgId);
      if (!can(role, "org.delete")) throw forbidden("Only owners can delete the organization.");
      const org = await deps.pool.query<{ personal: boolean; live: number; members: string[] }>(
        `select o.personal,
                (select count(*)::int from devices d where d.org_id = o.id and d.deleted_at is null) as live,
                (select array_agg(user_id) from memberships m where m.org_id = o.id) as members
           from organizations o where o.id = $1`,
        [orgId],
      );
      const o = org.rows[0]!;
      if (o.personal) throw new HttpError(409, "personal", "A personal organization cannot be deleted.");
      if (o.live > 0) throw new HttpError(409, "has_devices", "Move or delete the organization's devices first.");
      // Soft-deleted devices keep their rows (telemetry purge comes later), so they must not block the delete.
      await withTransaction(deps.pool, async (c) => {
        const dead = await c.query<{ id: string }>("select id from devices where org_id = $1", [orgId]);
        if (dead.rows.length) {
          const ids = dead.rows.map((r) => r.id);
          await c.query("delete from readings where device_id = any($1)", [ids]);
          await c.query("delete from latest where device_id = any($1)", [ids]);
          await c.query("delete from devices where id = any($1)", [ids]);
        }
        await c.query("delete from organizations where id = $1", [orgId]);
      });
      for (const userId of o.members ?? []) deps.broadcaster.membershipChanged(orgId, userId, false);
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  router.get("/orgs/:orgId/members", async (req, res, next) => {
    try {
      const orgId = idParam.parse(req.params.orgId);
      const role = await roleOrThrow(req.user!.id, orgId);
      const { rows } = await deps.pool.query<{ user_id: string; email: string | null; display_name: string | null; role: Role }>(
        `select m.user_id, u.email, u.display_name, m.role
           from memberships m join users u on u.id = m.user_id
          where m.org_id = $1
          order by case m.role when 'owner' then 0 when 'admin' then 1 when 'member' then 2 else 3 end, coalesce(u.display_name, u.email)`,
        [orgId],
      );
      const members: Member[] = rows.map((r) => ({ userId: r.user_id, email: r.email, displayName: r.display_name, role: r.role }));
      let invitations: Invitation[] = [];
      if (can(role, "org.manage_members")) {
        const inv = await deps.pool.query<InvitationRow>(`${INVITATION_SELECT} where i.org_id = $1 order by i.created_at`, [orgId]);
        invitations = inv.rows.map(toInvitation);
      }
      const body: MembersResponse = { members, invitations };
      res.json(body);
    } catch (err) {
      next(err);
    }
  });

  router.post("/orgs/:orgId/invitations", async (req, res, next) => {
    try {
      const orgId = idParam.parse(req.params.orgId);
      const actor = await roleOrThrow(req.user!.id, orgId);
      const { email, role } = inviteSchema.parse(req.body);
      if (!canAssignRole(actor, null, role)) throw forbidden(role === "owner" ? "Only owners can invite owners." : "Only owners and admins can invite.");
      const already = await deps.pool.query(
        "select 1 from memberships m join users u on u.id = m.user_id where m.org_id = $1 and lower(u.email) = $2",
        [orgId, email],
      );
      if (already.rows.length) throw new HttpError(409, "already_member", "This person is already a member.");
      const { rows } = await deps.pool.query<{ id: string }>(
        `insert into org_invitations (org_id, email, role, invited_by, expires_at)
         values ($1, $2, $3, $4, now() + make_interval(days => $5))
         on conflict (org_id, email) do update set role = excluded.role, invited_by = excluded.invited_by,
                created_at = now(), expires_at = excluded.expires_at
         returning id`,
        [orgId, email, role, req.user!.id, INVITE_DAYS],
      );
      const inv = toInvitation((await deps.pool.query<InvitationRow>(`${INVITATION_SELECT} where i.id = $1`, [rows[0]!.id])).rows[0]!);
      const who = req.user!.displayName ?? req.user!.email ?? "ผู้ดูแล";
      // The invitation is saved either way; a mail problem is logged, not returned as an error.
      deps
        .mailer(
          email,
          `คำเชิญเข้าร่วม "${inv.orgName}" บน dotWatch`,
          `${who} เชิญคุณเข้าร่วม "${inv.orgName}" ในบทบาท${ROLE_LABEL[role]}\n` +
            `เข้าสู่ระบบด้วยอีเมลนี้ที่ ${deps.appUrl} แล้วกดรับคำเชิญ (ภายใน ${INVITE_DAYS} วัน)`,
        )
        .catch((err) => log.warn("invitation email failed", { error: (err as Error).message }));
      res.status(201).json({ invitation: inv });
    } catch (err) {
      next(err);
    }
  });

  router.delete("/invitations/:id", async (req, res, next) => {
    try {
      const id = idParam.parse(req.params.id);
      const inv = await deps.pool.query<{ org_id: string; email: string }>("select org_id, email from org_invitations where id = $1", [id]);
      const row = inv.rows[0];
      if (!row) throw notFound("Invitation not found.");
      const role = await roleInOrg(deps.pool, req.user!.id, row.org_id);
      const isInvitee = req.user!.email?.toLowerCase() === row.email;
      if (!isInvitee && !can(role, "org.manage_members")) throw notFound("Invitation not found.");
      await deps.pool.query("delete from org_invitations where id = $1", [id]);
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  router.post("/invitations/:id/accept", async (req, res, next) => {
    try {
      const id = idParam.parse(req.params.id);
      const me = req.user!;
      if (!me.email || !me.emailVerified) throw new HttpError(403, "email_not_verified", "Verify your email address first.");
      const org = await withTransaction(deps.pool, async (c) => {
        const { rows } = await c.query<{ org_id: string; role: Role }>(
          "delete from org_invitations where id = $1 and email = $2 and expires_at > now() returning org_id, role",
          [id, me.email!.toLowerCase()],
        );
        const inv = rows[0];
        if (!inv) throw notFound("Invitation not found or expired.");
        await c.query(
          `insert into memberships (org_id, user_id, role) values ($1, $2, $3)
           on conflict (org_id, user_id) do nothing`,
          [inv.org_id, me.id, inv.role],
        );
        return inv.org_id;
      });
      res.json({ orgId: org });
    } catch (err) {
      next(err);
    }
  });

  router.patch("/orgs/:orgId/members/:userId", async (req, res, next) => {
    try {
      const orgId = idParam.parse(req.params.orgId);
      const userId = idParam.parse(req.params.userId);
      const { role: to } = memberRoleSchema.parse(req.body);
      await changeMember(orgId, req.user!.id, userId, to);
      deps.broadcaster.membershipChanged(orgId, userId, true);
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  router.delete("/orgs/:orgId/members/:userId", async (req, res, next) => {
    try {
      const orgId = idParam.parse(req.params.orgId);
      const userId = idParam.parse(req.params.userId);
      await changeMember(orgId, req.user!.id, userId, null);
      deps.broadcaster.membershipChanged(orgId, userId, false);
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  /** Role change or removal (to = null). Leaving is removing yourself and needs no admin rights. */
  async function changeMember(orgId: string, actorId: string, userId: string, to: Role | null) {
    await withTransaction(deps.pool, async (c) => {
      const { rows } = await c.query<{ user_id: string; role: Role; personal: boolean }>(
        `select m.user_id, m.role, o.personal from memberships m join organizations o on o.id = m.org_id
          where m.org_id = $1 order by m.user_id for update of m`,
        [orgId],
      );
      const actor = rows.find((r) => r.user_id === actorId);
      if (!actor) throw notFound("Organization not found.");
      const target = rows.find((r) => r.user_id === userId);
      if (!target) throw notFound("Member not found.");
      const leaving = to === null && actorId === userId;
      if (!leaving && !canAssignRole(actor.role, target.role, to)) {
        throw forbidden(target.role === "owner" || to === "owner" ? "Only owners can change owners." : "Only owners and admins can change members.");
      }
      if (leaving && target.personal) throw new HttpError(409, "personal", "You cannot leave your personal organization.");
      const owners = rows.filter((r) => r.role === "owner").length;
      if (target.role === "owner" && to !== "owner" && owners <= 1) {
        throw new HttpError(409, "last_owner", "An organization needs at least one owner. Make someone else owner first.");
      }
      if (to === null) await c.query("delete from memberships where org_id = $1 and user_id = $2", [orgId, userId]);
      else await c.query("update memberships set role = $3 where org_id = $1 and user_id = $2", [orgId, userId, to]);
    });
  }

  return router;
}
