// Import everything from the old dotWatch database. See docs/MIGRATION.md.
// Usage: npm run legacy:import -- [--dry-run] [--yes] [--no-telemetry] [--include-inactive] [--window-hours 24]
import { MIGRATE_ENV } from "./load-migrate-env";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { loadConfig } from "../config";
import { connectionOptions, createPool } from "../db/pool";
import { runImport, type ImportReport } from "../legacy/import";

const flag = (name: string) => process.argv.includes(`--${name}`);
const num = (name: string, fallback: number) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? Number(process.argv[i + 1]) : fallback;
};

if (!existsSync(MIGRATE_ENV)) {
  console.error(`ไม่พบไฟล์ services/api/${MIGRATE_ENV}: คัดลอก .env.migrate.example เป็น ${MIGRATE_ENV} แล้วใส่ค่าให้ครบ 4 ค่า`);
  process.exit(1);
}
const config = loadConfig();
let legacyUrl = (process.env.LEGACY_DATABASE_URL ?? "").trim();
if (!legacyUrl) {
  console.error(`ใส่ LEGACY_DATABASE_URL ใน ${MIGRATE_ENV} ก่อน`);
  process.exit(1);
}
try {
  const u = new URL(legacyUrl);
  // Render's "Internal Database URL" (host like dpg-abc123-a) only resolves inside Render.
  if (/^dpg-[a-z0-9]+-a$/.test(u.hostname)) {
    console.error("LEGACY_DATABASE_URL เป็น Internal URL ของ Render ซึ่งใช้จากเครื่องนี้ไม่ได้\nใช้ External Database URL แทน (Render → ฐานข้อมูลเก่า → Connect → External)");
    process.exit(1);
  }
  // Render requires SSL from outside.
  if (u.hostname.endsWith(".render.com") && !u.searchParams.has("sslmode")) {
    u.searchParams.set("sslmode", "require");
    legacyUrl = u.toString();
  }
} catch {
  console.error("LEGACY_DATABASE_URL อ่านไม่ได้ ตรวจว่า copy มาครบทั้งเส้น");
  process.exit(1);
}
if (config.DATABASE_URL === process.env.LEGACY_DATABASE_URL) {
  console.error("DATABASE_URL กับ LEGACY_DATABASE_URL เป็นฐานเดียวกัน ตรวจไฟล์ .env.migrate");
  process.exit(1);
}
const dryRun = flag("dry-run");
const host = (u: string) => {
  try {
    const x = new URL(u);
    return `${x.hostname}${x.pathname}`;
  } catch {
    return "(unreadable url)";
  }
};

console.log(`จาก (อ่านอย่างเดียว): ${host(legacyUrl)}`);
console.log(`ไปที่:               ${host(config.DATABASE_URL)}`);
console.log(dryRun ? "โหมด: ทดลอง (ไม่เขียนอะไรเลย)\n" : "โหมด: ย้ายจริง\n");
if (!dryRun && !flag("yes")) {
  console.error("ตรวจปลายทางด้านบนให้ถูก แล้วรันใหม่พร้อม --yes เพื่อย้ายจริง (หรือ --dry-run เพื่อทดลอง)");
  process.exit(1);
}

const legacy = new pg.Pool({ ...connectionOptions(legacyUrl), max: 2, statement_timeout: 600_000 });
const target = createPool({ ...config, DB_STATEMENT_TIMEOUT_MS: 30 * 60_000 });
const cutoff = new Date();
const started = Date.now();
let report: ImportReport;
try {
  report = await runImport({
    legacy,
    target,
    pepper: config.DEVICE_SECRET_PEPPER,
    legacySecretKey: process.env.LEGACY_SECRET_KEY || undefined,
    dryRun,
    includeInactive: flag("include-inactive"),
    telemetry: !flag("no-telemetry"),
    windowHours: num("window-hours", 24),
    cutoff,
    log: (l) => console.log(l),
  });
} catch (err) {
  console.error(`\nหยุดเพราะเกิดข้อผิดพลาด: ${(err as Error).message}\nรันคำสั่งเดิมซ้ำได้ ระบบจะทำต่อจากที่ค้าง`);
  process.exit(1);
} finally {
  await legacy.end();
  await target.end();
}

const mismatches = report.verify.filter((v) => v.old !== v.imported);
const dir = join("..", "..", "_reports", `legacy-import-${cutoff.toISOString().replace(/[:.]/g, "-")}`);
mkdirSync(dir, { recursive: true });
const lines = [
  `# ผลการย้ายข้อมูล ${cutoff.toISOString()}${dryRun ? " (ทดลอง)" : ""}`,
  "",
  `ใช้เวลา ${Math.round((Date.now() - started) / 1000)} วินาที · ข้อมูลย้อนหลังที่เพิ่ม ${report.telemetryRows.toLocaleString()} แถว`,
  "",
  "| รายการ | จำนวน |",
  "|---|---|",
  ...Object.entries(report.counts).map(([k, v]) => `| ${k} | ${v.toLocaleString()} |`),
  "",
  `## ตรวจยอดแถว (ข้อมูลก่อน ${cutoff.toISOString()})`,
  "",
  report.verify.length === 0 ? "ไม่ได้ตรวจ" : mismatches.length === 0 ? `ตรงกันครบ ${report.verify.length} ชุด ✅` : `ไม่ตรง ${mismatches.length} จาก ${report.verify.length} ชุด ❌`,
  "",
  ...(report.verify.length ? ["| อุปกรณ์ | ค่าที่วัด | ระบบเก่า | ระบบใหม่ | |", "|---|---|---|---|---|"] : []),
  ...report.verify.map((v) => `| ${v.code} | ${v.metric} | ${v.old.toLocaleString()} | ${v.imported.toLocaleString()} | ${v.old === v.imported ? "✅" : "❌"} |`),
  "",
  "## ข้อควรรู้",
  "",
  ...(report.warnings.length ? report.warnings.map((w) => `- ${w}`) : ["- ไม่มี"]),
  ...(report.counts.rules_inclusive_operator
    ? [`- กฎเดิมแบบ ">=" หรือ "<=" ${report.counts.rules_inclusive_operator} ชุด: ระบบใหม่แจ้งเตือนเมื่อเกินค่าจริงๆ ค่าที่เท่ากับขีดพอดีจะไม่แจ้ง`]
    : []),
];
writeFileSync(join(dir, "report.md"), lines.join("\n"));
if (report.newSecrets.length && !dryRun) {
  writeFileSync(join(dir, "new-device-secrets.csv"), ["code,name,secret", ...report.newSecrets.map((s) => `${s.code},"${s.name.replace(/"/g, '""')}",${s.secret}`)].join("\n"));
}

console.log("\nสรุป");
for (const [k, v] of Object.entries(report.counts)) console.log(`  ${k}: ${v.toLocaleString()}`);
if (report.verify.length) console.log(mismatches.length ? `  ตรวจยอดแถว: ไม่ตรง ${mismatches.length} ชุด ❌` : `  ตรวจยอดแถว: ตรงกันครบ ✅`);
if (report.newSecrets.length) {
  console.log(
    dryRun
      ? `  อุปกรณ์ที่ต้องออกรหัสลับใหม่: ${report.newSecrets.length}`
      : `  อุปกรณ์ที่ได้รหัสลับใหม่ ${report.newSecrets.length} ตัว: ดูไฟล์ new-device-secrets.csv (ห้าม commit ไฟล์นี้)`,
  );
}
console.log(`  รายงาน: ${join(dir, "report.md")}`);
process.exitCode = mismatches.length ? 2 : 0;
