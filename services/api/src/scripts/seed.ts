// Local only: creates the dev user, its personal organization and a demo device,
// then writes .demo-device.json for `npm run simulate`.
import { writeFileSync } from "node:fs";
import { loadConfig } from "../config";
import { createPool } from "../db/pool";
import { resolveUser, listOrganizations } from "../auth/users";
import { generateDeviceSecret, hashDeviceSecret } from "../auth/deviceSecret";

const config = loadConfig();
if (config.NODE_ENV === "production" || config.AUTH_MODE !== "dev") {
  console.error("seed runs only with AUTH_MODE=dev outside production");
  process.exit(1);
}

const pool = createPool(config);
try {
  const user = await resolveUser(pool, { uid: "dev-user", email: "dev@dotwatch.local", name: "Dev" });
  const org = (await listOrganizations(pool, user.id))[0]!;
  const secret = generateDeviceSecret();
  await pool.query(
    `insert into devices (org_id, code, name, secret_hash) values ($1, 'DEMO-001', 'ห้องเย็น 1 (จำลอง)', $2)
     on conflict (code) do update set secret_hash = excluded.secret_hash, deleted_at = null`,
    [org.id, hashDeviceSecret(secret, config.DEVICE_SECRET_PEPPER)],
  );
  const demo = { apiUrl: `http://localhost:${config.PORT}`, code: "DEMO-001", secret };
  writeFileSync(".demo-device.json", JSON.stringify(demo, null, 2));
  console.log("dev user   : dev-user (token: dev:dev-user)");
  console.log(`org        : ${org.name} (${org.id})`);
  console.log("device     : DEMO-001 — credentials written to services/api/.demo-device.json");
} finally {
  await pool.end();
}
