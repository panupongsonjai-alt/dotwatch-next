import { log } from "../lib/log";

/** Postgres errors that mean "nothing was written, try the same thing again". */
const RETRYABLE = new Set(["40P01", "40001"]); // deadlock_detected, serialization_failure

/**
 * Re-runs an idempotent statement when Postgres aborts it with a deadlock or serialization failure.
 * Ingest can deadlock while TimescaleDB opens a new chunk (the chunk's FK to `devices` needs a table lock
 * that conflicts with concurrent device touches). Postgres already rolled the statement back,
 * and both ingest statements are safe to repeat, so a short jittered retry is the correct fix.
 */
export async function withDeadlockRetry<T>(
  label: string,
  fn: () => Promise<T>,
  opts: { attempts?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<T> {
  const attempts = opts.attempts ?? 5;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (!code || !RETRYABLE.has(code) || attempt >= attempts) throw err;
      log.warn("retrying after transient database conflict", { label, code, attempt });
      await sleep(5 + Math.random() * 20 * attempt);
    }
  }
}
