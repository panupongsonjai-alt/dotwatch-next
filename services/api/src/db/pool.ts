import pg from "pg";
import type { Config } from "../config";
import { log } from "../lib/log";

// Return bigint counts as numbers; telemetry counts here stay far below 2^53.
pg.types.setTypeParser(20, (v) => Number(v));

export type Pool = pg.Pool;

/**
 * Pool rules learned from the old system (audit 3.1):
 * every query uses pool.query() or a client released right after COMMIT,
 * nothing waits on the network while holding a client, and every wait has a timeout.
 */
export function createPool(config: Pick<Config, "DATABASE_URL" | "DB_POOL_MAX" | "DB_CONNECTION_TIMEOUT_MS" | "DB_STATEMENT_TIMEOUT_MS">): Pool {
  const pool = new pg.Pool({
    connectionString: config.DATABASE_URL,
    max: config.DB_POOL_MAX,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: config.DB_CONNECTION_TIMEOUT_MS,
    statement_timeout: config.DB_STATEMENT_TIMEOUT_MS,
    application_name: "dotwatch-api",
  });
  pool.on("error", (err) => log.error("idle database client error", { error: err.message }));
  return pool;
}

export async function withTransaction<T>(pool: Pool, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const result = await fn(client);
    await client.query("commit");
    return result;
  } catch (err) {
    await client.query("rollback").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
