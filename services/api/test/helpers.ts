import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import pg from "pg";
import { createPool, type Pool } from "../src/db/pool";
import { migrate } from "../src/db/migrate";
import { createTokenVerifier } from "../src/auth/userToken";
import { createRealtimeHub, type RealtimeHub } from "../src/realtime/hub";
import { createApp } from "../src/app";
import { generateDeviceSecret, hashDeviceSecret } from "../src/auth/deviceSecret";
import { resolveUser, listOrganizations } from "../src/auth/users";

export const PEPPER = "test-pepper-0123456789";

export interface TestEnv {
  url: string;
  wsUrl: string;
  pool: Pool;
  hub: RealtimeHub;
  close(): Promise<void>;
}

export async function resetDatabase() {
  // Recreate the test database from template0 instead of dropping the schema in place.
  // Dropping and re-creating timescaledb inside one database can fail with
  // "extension timescaledb has already been loaded with another version" (seen on Windows + Docker);
  // a brand-new database on brand-new connections never has a stale library loaded.
  const url = process.env.TEST_DATABASE_URL!;
  const dbName = new URL(url).pathname.slice(1);
  if (!dbName.includes("test")) throw new Error(`Refusing to reset "${dbName}": the database name must contain "test".`);
  const admin = new URL(url);
  admin.pathname = "/postgres";
  const client = new pg.Client({ connectionString: admin.toString() });
  await client.connect();
  try {
    await client.query(`drop database if exists "${dbName}" with (force)`);
    await client.query(`create database "${dbName}" template template0`);
  } finally {
    await client.end();
  }
  const pool = createPool({ DATABASE_URL: url, DB_POOL_MAX: 2, DB_CONNECTION_TIMEOUT_MS: 5000, DB_STATEMENT_TIMEOUT_MS: 30000 });
  await migrate(pool);
  await pool.end();
}

export const LINE_SECRET = "test-line-secret";

export async function startTestServer(opts: { poolMax?: number; now?: () => number } = {}): Promise<TestEnv> {
  const pool = createPool({
    DATABASE_URL: process.env.TEST_DATABASE_URL!,
    DB_POOL_MAX: opts.poolMax ?? 5,
    DB_CONNECTION_TIMEOUT_MS: 5000,
    DB_STATEMENT_TIMEOUT_MS: 10000,
  });
  const verifyToken = createTokenVerifier({ AUTH_MODE: "dev", FIREBASE_PROJECT_ID: "" });
  const hub = createRealtimeHub({ pool, verifyToken });
  const app = createApp({ pool, verifyToken, broadcaster: hub, pepper: PEPPER, corsOrigins: [], now: opts.now,
    notify: { channels: { line: true, lineWebhook: true, email: false }, lineChannelSecret: LINE_SECRET, lineAccessToken: "" } });
  const server: Server = createServer(app);
  hub.attach(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    wsUrl: `ws://127.0.0.1:${port}/v1/ws`,
    pool,
    hub,
    async close() {
      await hub.close();
      await new Promise<void>((r) => server.close(() => r()));
      await pool.end();
    },
  };
}

/** Creates (or reuses) a dev user and returns its personal org. */
export async function userWithOrg(pool: Pool, uid: string) {
  const user = await resolveUser(pool, { uid, email: `${uid}@test.local`, name: uid });
  const org = (await listOrganizations(pool, user.id))[0]!;
  return { user, org, token: `dev:${uid}` };
}

export async function addDevice(pool: Pool, orgId: string, code: string) {
  const secret = generateDeviceSecret();
  const { rows } = await pool.query<{ id: string }>(
    "insert into devices (org_id, code, name, secret_hash) values ($1, $2, $2, $3) returning id",
    [orgId, code, hashDeviceSecret(secret, PEPPER)],
  );
  return { id: rows[0]!.id, code, secret, auth: `Device ${code}:${secret}` };
}

export async function post(url: string, body: unknown, authorization?: string) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...(authorization ? { authorization } : {}) },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
}

export async function get(url: string, authorization: string) {
  const res = await fetch(url, { headers: { authorization } });
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
}
