import { Router, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { can, type CreateDeviceResponse, type Device, type Me, type MetricValue } from "@dotwatch/shared";
import type { Pool } from "../db/pool";
import { bearerToken, type TokenVerifier } from "../auth/userToken";
import { listOrganizations, resolveUser, roleInOrg, type CurrentUser } from "../auth/users";
import { generateDeviceCode, generateDeviceSecret, hashDeviceSecret } from "../auth/deviceSecret";
import { forbidden, HttpError, unauthorized } from "../lib/errors";
import type { Broadcaster } from "../realtime/hub";
import { alarmRoutes } from "./alarms";

declare module "express-serve-static-core" {
  interface Request {
    user?: CurrentUser;
  }
}

interface DeviceRow {
  id: string;
  org_id: string;
  code: string;
  name: string;
  last_seen_at: Date | null;
  firmware_version: string | null;
  latest: Record<string, MetricValue>;
}

const toDevice = (r: DeviceRow): Device => ({
  id: r.id,
  orgId: r.org_id,
  code: r.code,
  name: r.name,
  lastSeenAt: r.last_seen_at ? r.last_seen_at.getTime() : null,
  firmwareVersion: r.firmware_version,
  latest: r.latest,
});

const DEVICE_COLUMNS = `
  select d.id, d.org_id, d.code, d.name, d.last_seen_at, d.firmware_version,
         coalesce(
           (select jsonb_object_agg(l.metric_key, jsonb_build_object('time', (extract(epoch from l.time) * 1000)::bigint, 'value', l.value))
              from latest l where l.device_id = d.id),
           '{}'::jsonb) as latest`;
const DEVICE_SELECT = `${DEVICE_COLUMNS} from devices d`;

const createDeviceBody = z.object({
  orgId: z.string().uuid(),
  name: z.string().trim().min(1).max(80),
  code: z.string().trim().regex(/^[A-Za-z0-9_-]{3,32}$/).optional(),
});

const listQuery = z.object({ orgId: z.string().uuid().optional() });

export function userRouter(deps: { pool: Pool; verifyToken: TokenVerifier; pepper: string; broadcaster: Broadcaster; now?: () => number }): Router {
  const router = Router();

  router.use(async (req: Request, _res: Response, next: NextFunction) => {
    try {
      const token = bearerToken(req.header("authorization"));
      if (!token) throw unauthorized();
      req.user = await resolveUser(deps.pool, await deps.verifyToken(token));
      next();
    } catch (err) {
      next(err);
    }
  });

  router.get("/me", async (req, res, next) => {
    try {
      const u = req.user!;
      const me: Me = { id: u.id, email: u.email, displayName: u.displayName, organizations: await listOrganizations(deps.pool, u.id) };
      res.json(me);
    } catch (err) {
      next(err);
    }
  });

  // Only devices of organizations the user belongs to — one indexed path (fixes audit 3.3 by design).
  router.get("/devices", async (req, res, next) => {
    try {
      const { orgId } = listQuery.parse(req.query);
      const { rows } = await deps.pool.query<DeviceRow & { role: string }>(
        `${DEVICE_COLUMNS}, m.role
           from devices d
           join memberships m on m.org_id = d.org_id and m.user_id = $1
          where d.deleted_at is null and ($2::uuid is null or d.org_id = $2)
          order by d.name, d.code`,
        [req.user!.id, orgId ?? null],
      );
      const visible = rows.filter((r) => can(r.role as never, "device.read"));
      res.json({ devices: visible.map(toDevice) });
    } catch (err) {
      next(err);
    }
  });

  router.post("/devices", async (req, res, next) => {
    try {
      const body = createDeviceBody.parse(req.body);
      const role = await roleInOrg(deps.pool, req.user!.id, body.orgId);
      if (!can(role, "device.create")) throw forbidden("Only owners and admins can add devices.");
      const secret = generateDeviceSecret();
      const code = body.code?.toUpperCase() ?? generateDeviceCode();
      const { rows } = await deps.pool.query<{ id: string }>(
        "insert into devices (org_id, code, name, secret_hash) values ($1, $2, $3, $4) returning id",
        [body.orgId, code, body.name, hashDeviceSecret(secret, deps.pepper)],
      );
      const created = await deps.pool.query<DeviceRow>(`${DEVICE_SELECT} where d.id = $1`, [rows[0]!.id]);
      const response: CreateDeviceResponse = { device: toDevice(created.rows[0]!), secret };
      res.status(201).json(response);
    } catch (err) {
      next(err);
    }
  });

  router.use(alarmRoutes(deps));

  router.use((_req, _res, next) => next(new HttpError(404, "not_found", "No such endpoint.")));
  return router;
}
