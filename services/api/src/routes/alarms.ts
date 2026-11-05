import { Router } from "express";
import { z } from "zod";
import { alarmRulesBodySchema, can, isRole, type AlarmEvent } from "@dotwatch/shared";
import type { Pool } from "../db/pool";
import { roleInOrg } from "../auth/users";
import { forbidden, notFound } from "../lib/errors";
import type { Broadcaster } from "../realtime/hub";
import { EVENT_COLUMNS, listRules, replaceRules, toEvent } from "../alarms/store";

const listQuery = z.object({
  orgId: z.string().uuid().optional(),
  deviceId: z.string().uuid().optional(),
  state: z.enum(["open", "all"]).default("open"),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  before: z.coerce.number().int().positive().optional(),
});

/** Routes mounted inside the user router (req.user is set). */
export function alarmRoutes(deps: { pool: Pool; broadcaster: Broadcaster; now?: () => number }): Router {
  const router = Router();
  const now = deps.now ?? Date.now;

  const deviceAccess = async (userId: string, deviceId: string) => {
    const { rows } = await deps.pool.query<{ org_id: string }>(
      "select org_id from devices where id = $1 and deleted_at is null",
      [deviceId],
    );
    const device = rows[0];
    if (!device) throw notFound("Device not found.");
    const role = await roleInOrg(deps.pool, userId, device.org_id);
    if (!can(role, "device.read")) throw notFound("Device not found.");
    return { orgId: device.org_id, role };
  };

  router.get("/devices/:id/alarm-rules", async (req, res, next) => {
    try {
      const deviceId = z.string().uuid().parse(req.params.id);
      await deviceAccess(req.user!.id, deviceId);
      res.json({ rules: await listRules(deps.pool, deviceId) });
    } catch (err) {
      next(err);
    }
  });

  router.put("/devices/:id/alarm-rules", async (req, res, next) => {
    try {
      const deviceId = z.string().uuid().parse(req.params.id);
      const { orgId, role } = await deviceAccess(req.user!.id, deviceId);
      if (!can(role, "alarm.edit")) throw forbidden("Viewers cannot change alarm rules.");
      const body = alarmRulesBodySchema.parse(req.body);
      const result = await replaceRules(deps.pool, { id: deviceId, orgId }, body.rules, now());
      for (const event of result.closed) deps.broadcaster.publishAlarm(orgId, event);
      res.json({ rules: result.rules });
    } catch (err) {
      next(err);
    }
  });

  router.get("/alarms", async (req, res, next) => {
    try {
      const q = listQuery.parse(req.query);
      const { rows } = await deps.pool.query(
        `select ${EVENT_COLUMNS.split(",").map((c) => `e.${c.trim()}`).join(", ")}, m.role
           from alarm_events e
           join memberships m on m.org_id = e.org_id and m.user_id = $1
          where ($2::uuid is null or e.org_id = $2)
            and ($3::uuid is null or e.device_id = $3)
            and ($4 = 'all' or e.ended_at is null)
            and ($5::timestamptz is null or e.started_at < $5)
          order by e.started_at desc
          limit $6`,
        [req.user!.id, q.orgId ?? null, q.deviceId ?? null, q.state, q.before ? new Date(q.before) : null, q.limit],
      );
      const events: AlarmEvent[] = rows.filter((r) => isRole(r.role) && can(r.role, "device.read")).map(toEvent);
      res.json({ events });
    } catch (err) {
      next(err);
    }
  });

  router.post("/alarms/:id/ack", async (req, res, next) => {
    try {
      const id = z.string().uuid().parse(req.params.id);
      const found = await deps.pool.query<{ org_id: string }>("select org_id from alarm_events where id = $1", [id]);
      const orgId = found.rows[0]?.org_id;
      const role = orgId ? await roleInOrg(deps.pool, req.user!.id, orgId) : null;
      if (!orgId || !can(role, "device.read")) throw notFound("Alarm not found.");
      if (!can(role, "alarm.ack")) throw forbidden("Viewers cannot acknowledge alarms.");
      const { rows } = await deps.pool.query(
        `update alarm_events set acknowledged_at = coalesce(acknowledged_at, now()), acknowledged_by = coalesce(acknowledged_by, $2)
          where id = $1 returning ${EVENT_COLUMNS}`,
        [id, req.user!.id],
      );
      const event = toEvent(rows[0]);
      deps.broadcaster.publishAlarm(orgId, event);
      res.json({ event });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
