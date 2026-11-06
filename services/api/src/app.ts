import { existsSync } from "node:fs";
import { join } from "node:path";
import express, { type NextFunction, type Request, type Response } from "express";
import { ZodError } from "zod";
import type { Pool } from "./db/pool";
import type { TokenVerifier } from "./auth/userToken";
import type { Broadcaster } from "./realtime/hub";
import { ingestRouter } from "./routes/ingest";
import { userRouter } from "./routes/user";
import { lineWebhook } from "./notify/lineWebhook";
import type { ChannelStatus } from "@dotwatch/shared";
import type { InviteMailer } from "./routes/orgs";
import { HttpError } from "./lib/errors";
import { log } from "./lib/log";

export interface AppDeps {
  pool: Pool;
  verifyToken: TokenVerifier;
  broadcaster: Broadcaster;
  pepper: string;
  corsOrigins: string[];
  now?: () => number;
  /** What the notification channels can do; secrets for the LINE webhook. */
  notify?: { channels: ChannelStatus; lineChannelSecret: string; lineAccessToken: string };
  /** Web app address, used in emails. */
  appUrl?: string;
  /** Invitation emails; defaults to writing them to the log. */
  mailer?: InviteMailer;
  /** Built web app (apps/web/dist) to serve at "/", so web and API share one address. */
  webDir?: string | null;
  /** Sent to the browser as window.DOTWATCH_CONFIG by /config.js. */
  webConfig?: { authMode: "dev" | "firebase"; firebase: { apiKey: string; authDomain: string; projectId: string } };
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
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
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

  const notify = deps.notify ?? { channels: { line: false, lineWebhook: false, email: false }, lineChannelSecret: "", lineAccessToken: "" };
  // Raw body: the signature is computed over the exact bytes LINE sent.
  app.use("/v1/line/webhook", lineWebhook({ pool: deps.pool, channelSecret: notify.lineChannelSecret, accessToken: notify.lineAccessToken }));
  app.use("/v1/ingest", express.json({ limit: "256kb" }), ingestRouter(deps));
  app.use(
    "/v1",
    express.json({ limit: "64kb" }),
    userRouter({
      ...deps,
      channels: notify.channels,
      appUrl: deps.appUrl ?? "http://localhost:5173",
      mailer: deps.mailer ?? (async (to, subject, text) => log.info("invitation email (dry run)", { to, subject, text })),
    }),
  );

  // One address for everything: the web app and its settings come from the API.
  if (deps.webConfig) {
    const body = `window.DOTWATCH_CONFIG = ${JSON.stringify(deps.webConfig)};\n`;
    app.get("/config.js", (_req, res) => {
      res.setHeader("content-type", "text/javascript; charset=utf-8");
      res.setHeader("cache-control", "no-cache");
      res.send(body);
    });
  }
  if (deps.webDir && existsSync(join(deps.webDir, "index.html"))) {
    const webDir = deps.webDir;
    app.use((_req, res, next) => {
      res.setHeader("x-content-type-options", "nosniff");
      res.setHeader("referrer-policy", "strict-origin-when-cross-origin");
      next();
    });
    app.use(
      express.static(webDir, {
        index: "index.html",
        setHeaders: (res, path) =>
          // Vite puts a content hash in every asset name, so assets never change; index.html must always be fresh.
          res.setHeader("cache-control", /[\\/]assets[\\/]/.test(path) ? "public, max-age=31536000, immutable" : "no-cache"),
      }),
    );
    // Screens use the URL hash, so any other page path just gets the app.
    app.get(/^(?!\/v1\/).*/, (_req, res) => {
      res.setHeader("cache-control", "no-cache");
      res.sendFile(join(webDir, "index.html"));
    });
  }

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
