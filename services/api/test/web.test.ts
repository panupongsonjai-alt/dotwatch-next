import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resetDatabase, startTestServer, type TestEnv } from "./helpers";

let env: TestEnv;
beforeAll(async () => {
  await resetDatabase();
  const dir = mkdtempSync(join(tmpdir(), "web-"));
  mkdirSync(join(dir, "assets"));
  writeFileSync(join(dir, "index.html"), "<!doctype html><title>dotWatch</title>");
  writeFileSync(join(dir, "assets", "app-abc123.js"), "console.log(1)");
  env = await startTestServer({
    webDir: dir,
    webConfig: { authMode: "firebase", firebase: { apiKey: "k", authDomain: "p.firebaseapp.com", projectId: "p" } },
  });
});
afterAll(async () => env.close());

describe("one address for web and API", () => {
  it("serves the app, its assets and the sign-in settings", async () => {
    const page = await fetch(`${env.url}/`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("<title>dotWatch</title>");
    expect(page.headers.get("cache-control")).toBe("no-cache");

    const asset = await fetch(`${env.url}/assets/app-abc123.js`);
    expect(asset.headers.get("cache-control")).toContain("immutable");

    const cfg = await (await fetch(`${env.url}/config.js`)).text();
    expect(cfg).toBe('window.DOTWATCH_CONFIG = {"authMode":"firebase","firebase":{"apiKey":"k","authDomain":"p.firebaseapp.com","projectId":"p"}};\n');

    expect(await (await fetch(`${env.url}/settings/whatever`)).text()).toContain("dotWatch");
  });

  it("keeps API errors as JSON", async () => {
    const res = await fetch(`${env.url}/v1/nope`, { headers: { authorization: "Bearer dev:x" } });
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("not_found");
    expect((await fetch(`${env.url}/health`)).status).toBe(200);
  });
});
