import { createServer } from "node:http";
import { loadConfig } from "./config";
import { createPool } from "./db/pool";
import { createTokenVerifier } from "./auth/userToken";
import { createRealtimeHub } from "./realtime/hub";
import { createApp } from "./app";
import { log } from "./lib/log";
import { startOfflineMonitor } from "./alarms/offline";

const config = loadConfig();
const pool = createPool(config);
const verifyToken = createTokenVerifier(config);
const hub = createRealtimeHub({ pool, verifyToken });
const app = createApp({
  pool,
  verifyToken,
  broadcaster: hub,
  pepper: config.DEVICE_SECRET_PEPPER,
  corsOrigins: config.CORS_ORIGIN.split(",").map((s) => s.trim()).filter(Boolean),
});

const server = createServer(app);
server.keepAliveTimeout = 65_000; // longer than device send interval so boards can reuse TLS (decision 10)
server.headersTimeout = 66_000;
hub.attach(server);
const offline = startOfflineMonitor({ pool, broadcaster: hub });
server.listen(config.PORT, () => log.info("api listening", { port: config.PORT, auth: config.AUTH_MODE }));

let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  log.info("shutting down", { signal });
  offline.stop();
  server.close();
  await hub.close();
  await pool.end();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
