import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Pool } from "./pool";
import { log } from "../lib/log";

/** Works from src/db/ (tsx) and from dist/ (bundled). */
function findMigrationsDir(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 5; i++) {
    const candidate = join(dir, "migrations");
    if (existsSync(candidate)) return candidate;
    dir = dirname(dir);
  }
  throw new Error("migrations directory not found");
}

export async function migrate(pool: Pool, opts: { requireTimescale?: boolean } = {}): Promise<string[]> {
  const dir = findMigrationsDir();
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  const client = await pool.connect();
  const applied: string[] = [];
  try {
    await client.query("select pg_advisory_lock(727001)");
    await client.query(
      "create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())",
    );
    const done = new Set((await client.query<{ name: string }>("select name from schema_migrations")).rows.map((r) => r.name));
    for (const file of files) {
      if (done.has(file)) continue;
      const sql = readFileSync(join(dir, file), "utf8");
      // Some TimescaleDB statements (continuous aggregates) refuse to run inside a transaction.
      // Such files start with this marker and must be safe to re-run if interrupted halfway.
      if (sql.includes("-- migrate:requires timescaledb")) {
        const ts = await client.query("select 1 from pg_extension where extname = 'timescaledb'");
        if (ts.rows.length === 0) {
          log.info("migration skipped: needs timescaledb", { file });
          continue; // not recorded, so it runs once TimescaleDB is there
        }
      }
      if (sql.startsWith("-- migrate:no-transaction")) {
        try {
          for (const part of sql.split(/^-- migrate:split.*$/m)) {
            if (part.replace(/--.*$/gm, "").trim()) await client.query(part);
          }
          await client.query("insert into schema_migrations (name) values ($1)", [file]);
        } catch (err) {
          throw new Error(`migration ${file} failed: ${(err as Error).message}`);
        }
        applied.push(file);
        log.info("migration applied", { file });
        continue;
      }
      await client.query("begin");
      try {
        await client.query(sql);
        await client.query("insert into schema_migrations (name) values ($1)", [file]);
        await client.query("commit");
        applied.push(file);
        log.info("migration applied", { file });
      } catch (err) {
        await client.query("rollback");
        throw new Error(`migration ${file} failed: ${(err as Error).message}`);
      }
    }
    if (opts.requireTimescale) {
      const { rows } = await client
        .query("select 1 from timescaledb_information.hypertables where hypertable_name = 'readings'")
        .catch(() => ({ rows: [] as unknown[] }));
      if (rows.length === 0) throw new Error("REQUIRE_TIMESCALE=true but readings is not a hypertable");
    }
  } finally {
    await client.query("select pg_advisory_unlock(727001)").catch(() => undefined);
    client.release();
  }
  return applied;
}
