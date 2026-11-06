import { Router, type NextFunction, type Request, type Response } from "express";
import type { Me } from "@dotwatch/shared";
import type { Pool } from "../db/pool";
import { bearerToken, type TokenVerifier } from "../auth/userToken";
import { listOrganizations, resolveUser, type CurrentUser } from "../auth/users";
import { HttpError, unauthorized } from "../lib/errors";
import type { Broadcaster } from "../realtime/hub";
import { alarmRoutes } from "./alarms";
import { deviceRoutes } from "./devices";

declare module "express-serve-static-core" {
  interface Request {
    user?: CurrentUser;
  }
}

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

  router.use(deviceRoutes(deps));
  router.use(alarmRoutes(deps));

  router.use((_req, _res, next) => next(new HttpError(404, "not_found", "No such endpoint.")));
  return router;
}
