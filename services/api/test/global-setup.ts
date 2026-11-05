import { existsSync } from "node:fs";
import pg from "pg";

export default async function setup() {
  if (existsSync(".env")) process.loadEnvFile(".env");
  const url = process.env.TEST_DATABASE_URL ?? "postgres://dotwatch:dotwatch@localhost:5432/dotwatch_test";
  const dbName = new URL(url).pathname.slice(1);
  if (!dbName.includes("test")) throw new Error(`Refusing to run tests against "${dbName}": the database name must contain "test".`);
  process.env.TEST_DATABASE_URL = url;

  const admin = new URL(url);
  admin.pathname = "/postgres";
  const client = new pg.Client({ connectionString: admin.toString() });
  await client.connect();
  const exists = await client.query("select 1 from pg_database where datname = $1", [dbName]);
  if (exists.rowCount === 0) await client.query(`create database "${dbName}"`);
  await client.end();
}
