// Bundles the API (and @dotwatch/shared, which ships as TypeScript source) into dist/.
import { build } from "esbuild";
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));
const external = Object.keys(pkg.dependencies).filter((d) => d !== "@dotwatch/shared");

await build({
  entryPoints: { server: "src/server.ts", migrate: "src/scripts/migrate.ts" },
  outdir: "dist",
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  sourcemap: true,
  external,
  logLevel: "info",
});
