import { existsSync } from "node:fs";
import { z } from "zod";

if (existsSync(".env")) process.loadEnvFile(".env");

const bool = z.enum(["true", "false"]).transform((v) => v === "true");

const schema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    PORT: z.coerce.number().int().default(4000),
    DATABASE_URL: z.string().min(1),
    AUTH_MODE: z.enum(["dev", "firebase"]).default("dev"),
    FIREBASE_PROJECT_ID: z.string().default(""),
    DEVICE_SECRET_PEPPER: z.string().min(16, "DEVICE_SECRET_PEPPER must be at least 16 characters"),
    CORS_ORIGIN: z.string().default("http://localhost:5173"),
    DB_POOL_MAX: z.coerce.number().int().min(1).default(10),
    DB_CONNECTION_TIMEOUT_MS: z.coerce.number().int().default(10_000),
    DB_STATEMENT_TIMEOUT_MS: z.coerce.number().int().default(30_000),
    REQUIRE_TIMESCALE: bool.default("false"),
  })
  .superRefine((c, ctx) => {
    if (c.NODE_ENV === "production" && c.AUTH_MODE === "dev")
      ctx.addIssue({ code: "custom", message: "AUTH_MODE=dev is not allowed in production" });
    if (c.AUTH_MODE === "firebase" && !c.FIREBASE_PROJECT_ID)
      ctx.addIssue({ code: "custom", message: "FIREBASE_PROJECT_ID is required when AUTH_MODE=firebase" });
  });

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join(".") || "config"}: ${i.message}`);
    throw new Error(`Invalid configuration:\n${lines.join("\n")}`);
  }
  return parsed.data;
}
