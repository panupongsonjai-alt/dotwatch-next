import { randomInt } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import {
  can, createTargetSchema, NOTIFY_LIMITS, notificationSettingsSchema, updateTargetSchema,
  type ChannelStatus, type NotificationTarget, type NotificationsResponse, type TargetKind, type Severity,
} from "@dotwatch/shared";
import type { Pool } from "../db/pool";
import { roleInOrg } from "../auth/users";
import { forbidden, HttpError, notFound } from "../lib/errors";

interface TargetRow {
  id: string;
  org_id: string;
  kind: TargetKind;
  name: string;
  address: string | null;
  min_severity: Severity;
  enabled: boolean;
  link_code: string | null;
  link_expires_at: Date | null;
  last_sent_at: Date | null;
  last_error: string | null;
}

const COLS = "id, org_id, kind, name, address, min_severity, enabled, link_code, link_expires_at, last_sent_at, last_error";

const toTarget = (r: TargetRow): NotificationTarget => ({
  id: r.id,
  kind: r.kind,
  name: r.name,
  address: r.address,
  minSeverity: r.min_severity,
  enabled: r.enabled,
  linkCode: r.link_code,
  linkExpiresAt: r.link_expires_at?.getTime() ?? null,
  lastSentAt: r.last_sent_at?.getTime() ?? null,
  lastError: r.last_error,
});

// No 0/O/1/I so the code survives being read aloud or typed on a phone.
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const newLinkCode = () => Array.from({ length: 6 }, () => ALPHABET[randomInt(ALPHABET.length)]).join("");

const idParam = z.string().uuid();

/** Organization recipients and reminder settings. Admins and owners only (notify.manage). */
export function notificationRoutes(deps: { pool: Pool; channels: ChannelStatus }): Router {
  const router = Router();

  const requireOrg = async (userId: string, orgId: string) => {
    const role = await roleInOrg(deps.pool, userId, orgId);
    if (!role) throw notFound("Organization not found.");
    if (!can(role, "notify.manage")) throw forbidden("Only owners and admins can manage notifications.");
  };
  const requireTarget = async (userId: string, id: string) => {
    const { rows } = await deps.pool.query<TargetRow>(`select ${COLS} from notification_targets where id = $1`, [id]);
    const t = rows[0];
    if (!t) throw notFound("Recipient not found.");
    const role = await roleInOrg(deps.pool, userId, t.org_id);
    if (!role) throw notFound("Recipient not found.");
    if (!can(role, "notify.manage")) throw forbidden("Only owners and admins can manage notifications.");
    return t;
  };

  router.get("/orgs/:orgId/notifications", async (req, res, next) => {
    try {
      const orgId = idParam.parse(req.params.orgId);
      await requireOrg(req.user!.id, orgId);
      const org = await deps.pool.query<{ notify_repeat_minutes: number | null; notify_max_reminders: number }>(
        "select notify_repeat_minutes, notify_max_reminders from organizations where id = $1",
        [orgId],
      );
      const targets = await deps.pool.query<TargetRow>(`select ${COLS} from notification_targets where org_id = $1 order by created_at`, [orgId]);
      const body: NotificationsResponse = {
        settings: { repeatMinutes: org.rows[0]!.notify_repeat_minutes, maxReminders: org.rows[0]!.notify_max_reminders },
        targets: targets.rows.map(toTarget),
        channels: deps.channels,
      };
      res.json(body);
    } catch (err) {
      next(err);
    }
  });

  router.put("/orgs/:orgId/notifications/settings", async (req, res, next) => {
    try {
      const orgId = idParam.parse(req.params.orgId);
      await requireOrg(req.user!.id, orgId);
      const s = notificationSettingsSchema.parse(req.body);
      await deps.pool.query("update organizations set notify_repeat_minutes = $2, notify_max_reminders = $3 where id = $1", [
        orgId, s.repeatMinutes, s.maxReminders,
      ]);
      res.json({ settings: s });
    } catch (err) {
      next(err);
    }
  });

  router.post("/orgs/:orgId/notification-targets", async (req, res, next) => {
    try {
      const orgId = idParam.parse(req.params.orgId);
      await requireOrg(req.user!.id, orgId);
      const input = createTargetSchema.parse(req.body);
      const count = await deps.pool.query<{ n: number }>("select count(*)::int as n from notification_targets where org_id = $1", [orgId]);
      if (count.rows[0]!.n >= NOTIFY_LIMITS.maxTargetsPerOrg) throw new HttpError(400, "too_many", "Too many recipients.");
      const address = input.address ?? null;
      const code = address ? null : newLinkCode();
      const { rows } = await deps.pool.query<TargetRow>(
        `insert into notification_targets (org_id, kind, name, address, min_severity, link_code, link_expires_at)
         values ($1, $2, $3, $4, $5, $6, case when $6::text is null then null else now() + make_interval(mins => $7) end)
         returning ${COLS}`,
        [orgId, input.kind, input.name, address, input.minSeverity, code, NOTIFY_LIMITS.linkCodeMinutes],
      );
      res.status(201).json({ target: toTarget(rows[0]!) });
    } catch (err) {
      if ((err as { code?: string }).code === "23505") return next(new HttpError(409, "duplicate", "This recipient already exists."));
      next(err);
    }
  });

  router.patch("/notification-targets/:id", async (req, res, next) => {
    try {
      const id = idParam.parse(req.params.id);
      await requireTarget(req.user!.id, id);
      const b = updateTargetSchema.parse(req.body);
      const { rows } = await deps.pool.query<TargetRow>(
        `update notification_targets set name = coalesce($2, name), min_severity = coalesce($3, min_severity), enabled = coalesce($4, enabled)
          where id = $1 returning ${COLS}`,
        [id, b.name ?? null, b.minSeverity ?? null, b.enabled ?? null],
      );
      res.json({ target: toTarget(rows[0]!) });
    } catch (err) {
      next(err);
    }
  });

  router.delete("/notification-targets/:id", async (req, res, next) => {
    try {
      const id = idParam.parse(req.params.id);
      await requireTarget(req.user!.id, id);
      await deps.pool.query("delete from notification_targets where id = $1", [id]);
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  router.post("/notification-targets/:id/link-code", async (req, res, next) => {
    try {
      const id = idParam.parse(req.params.id);
      const t = await requireTarget(req.user!.id, id);
      if (t.kind !== "line") throw new HttpError(400, "not_line", "Only LINE recipients use link codes.");
      const { rows } = await deps.pool.query<TargetRow>(
        `update notification_targets set link_code = $2, link_expires_at = now() + make_interval(mins => $3)
          where id = $1 returning ${COLS}`,
        [id, newLinkCode(), NOTIFY_LIMITS.linkCodeMinutes],
      );
      res.json({ target: toTarget(rows[0]!) });
    } catch (err) {
      next(err);
    }
  });

  router.post("/notification-targets/:id/test", async (req, res, next) => {
    try {
      const id = idParam.parse(req.params.id);
      const t = await requireTarget(req.user!.id, id);
      if (!t.address) throw new HttpError(400, "not_linked", "Link this LINE recipient first.");
      await deps.pool.query("insert into notification_jobs (org_id, target_id, reason) values ($1, $2, 'test')", [t.org_id, id]);
      res.status(202).json({ queued: true });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
