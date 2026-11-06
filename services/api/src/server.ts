import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config";
import { createPool } from "./db/pool";
import { createTokenVerifier } from "./auth/userToken";
import { createRealtimeHub } from "./realtime/hub";
import { createApp } from "./app";
import { log } from "./lib/log";
import { startOfflineMonitor } from "./alarms/offline";
import { startNotifier } from "./notify/dispatcher";
import { emailChannel, lineChannel } from "./notify/channels";

const config = loadConfig();
const pool = createPool(config);
const verifyToken = createTokenVerifier(config);
const hub = createRealtimeHub({ pool, verifyToken });

/** apps/web/dist, found from src/ (tsx) or dist/ (bundled). */
function findWebDir(): string | null {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 5; i++) {
    const candidate = join(dir, "apps", "web", "dist");
    if (existsSync(join(candidate, "index.html"))) return candidate;
    dir = dirname(dir);
  }
  return null;
}
const webDir = findWebDir();
const channels = {
  line: lineChannel(config.LINE_CHANNEL_ACCESS_TOKEN),
  email: emailChannel(config.RESEND_API_KEY, config.EMAIL_FROM),
};
const app = createApp({
  pool,
  verifyToken,
  broadcaster: hub,
  pepper: config.DEVICE_SECRET_PEPPER,
  corsOrigins: config.CORS_ORIGIN.split(",").map((s) => s.trim()).filter(Boolean),
  notify: {
    channels: { line: channels.line.configured, lineWebhook: config.LINE_CHANNEL_SECRET.length > 0, email: channels.email.configured },
    lineChannelSecret: config.LINE_CHANNEL_SECRET,
    lineAccessToken: config.LINE_CHANNEL_ACCESS_TOKEN,
  },
  appUrl: config.APP_URL.replace(/\/$/, ""),
  webDir,
  webConfig: {
    authMode: config.AUTH_MODE,
    firebase: {
      apiKey: config.FIREBASE_API_KEY,
      authDomain: config.FIREBASE_AUTH_DOMAIN || (config.FIREBASE_PROJECT_ID ? `${config.FIREBASE_PROJECT_ID}.firebaseapp.com` : ""),
      projectId: config.FIREBASE_PROJECT_ID,
    },
  },
  mailer: async (to, subject, text) => {
    if (channels.email.configured) await channels.email.send(to, { subject, text }, randomUUID());
    else log.info("invitation email (dry run, no credentials)", { to, subject, text });
  },
});

const server = createServer(app);
server.keepAliveTimeout = 65_000; // longer than device send interval so boards can reuse TLS (decision 10)
server.headersTimeout = 66_000;
hub.attach(server);
const offline = startOfflineMonitor({ pool, broadcaster: hub });
const notifier = startNotifier({
  pool,
  channels,
  appUrl: config.APP_URL.replace(/\/$/, ""),
  timeZone: config.APP_TIMEZONE,
  intervalMs: config.NOTIFY_INTERVAL_MS,
});
server.listen(config.PORT, () =>
  log.info("api listening", {
    port: config.PORT,
    auth: config.AUTH_MODE,
    web: webDir ? "served" : "not built",
    line: channels.line.configured ? "on" : "dry run",
    email: channels.email.configured ? "on" : "dry run",
  }),
);

let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  log.info("shutting down", { signal });
  offline.stop();
  notifier.stop();
  server.close();
  await hub.close();
  await pool.end();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
