import express, { type NextFunction, type Request, type Response } from "express";
import { ZodError } from "zod";
import type { Pool } from "./db/pool";
import type { TokenVerifier } from "./auth/userToken";
import type { Broadcaster } from "./realtime/hub";
import { ingestRouter } from "./routes/ingest";
import { userRouter } from "./routes/user";
import { HttpError } from "./lib/errors";
import { log } from "./lib/log";

export interface AppDeps {
  pool: Pool;
  verifyToken: TokenVerifier;
  broadcaster: Broadcaster;
  pepper: string;
  corsOrigins: string[];
  now?: () => number;
}

export function createApp(deps: AppDeps) {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1);

  app.use((req, res, next) => {
    const origin = req.header("origin");
    if (origin && deps.corsOrigins.includes(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
    }
    if (req.method === "OPTIONS") return void res.sendStatus(204);
    next();
  });

  app.get("/health", async (_req, res) => {
    try {
      await deps.pool.query("select 1");
      res.json({ ok: true });
    } catch {
      res.status(503).json({ ok: false });
    }
  });

  app.use("/v1/ingest", express.json({ limit: "256kb" }), ingestRouter(deps));
  app.use("/v1", express.json({ limit: "64kb" }), userRouter(deps));

  // Errors from user input never become 500 (audit 3.12).
  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof HttpError) return void res.status(err.status).json({ error: err.code, message: err.message });
    if (err instanceof ZodError)
      return void res.status(400).json({ error: "invalid_request", message: err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
    if ((err as { type?: string }).type === "entity.parse.failed")
      return void res.status(400).json({ error: "invalid_json", message: "Body is not valid JSON." });
    if ((err as { type?: string }).type === "entity.too.large")
      return void res.status(413).json({ error: "too_large", message: "Body is too large." });
    const pgCode = (err as { code?: string }).code;
    if (pgCode === "23505") return void res.status(409).json({ error: "duplicate", message: "This code is already in use." });
    if (pgCode === "22P02") return void res.status(400).json({ error: "invalid_id", message: "Malformed id." });
    log.error("unhandled error", { path: req.path, error: (err as Error).message });
    res.status(500).json({ error: "internal", message: "Something went wrong on the server." });
  });

  return app;
}
