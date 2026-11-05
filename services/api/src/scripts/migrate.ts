import { loadConfig } from "../config";
import { createPool } from "../db/pool";
import { migrate } from "../db/migrate";

const config = loadConfig();
const pool = createPool(config);
try {
  const applied = await migrate(pool, { requireTimescale: config.REQUIRE_TIMESCALE });
  console.log(applied.length ? `applied: ${applied.join(", ")}` : "database is up to date");
} catch (err) {
  console.error((err as Error).message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
