// Imported first by legacy-import: values in .env.migrate win over .env, so the import can target production
// without touching the dev settings. Node never overwrites a variable that is already set.
import { existsSync } from "node:fs";

export const MIGRATE_ENV = ".env.migrate";
if (existsSync(MIGRATE_ENV)) process.loadEnvFile(MIGRATE_ENV);
