import { describe, expect, it } from "vitest";
import { generateDeviceCode, generateDeviceSecret, hashDeviceSecret, parseDeviceAuthHeader, verifyDeviceSecret } from "../src/auth/deviceSecret";
import { loadConfig } from "../src/config";
import { withDeadlockRetry } from "../src/db/retry";

describe("device secrets", () => {
  it("verifies only the right secret with the right pepper", () => {
    const s = generateDeviceSecret();
    const h = hashDeviceSecret(s, "pepper-aaaaaaaaaaaa");
    expect(verifyDeviceSecret(s, h, "pepper-aaaaaaaaaaaa")).toBe(true);
    expect(verifyDeviceSecret(s + "x", h, "pepper-aaaaaaaaaaaa")).toBe(false);
    expect(verifyDeviceSecret(s, h, "pepper-bbbbbbbbbbbb")).toBe(false);
  });
  it("parses the device auth header", () => {
    expect(parseDeviceAuthHeader("Device ABC:s3cr:et")).toEqual({ code: "ABC", secret: "s3cr:et" });
    expect(parseDeviceAuthHeader("Bearer x")).toBeNull();
    expect(parseDeviceAuthHeader("Device :x")).toBeNull();
    expect(parseDeviceAuthHeader("Device ABC:")).toBeNull();
  });
  it("generates readable codes", () => {
    expect(generateDeviceCode()).toMatch(/^DW-[A-Z2-9]{6}$/);
  });
});

describe("config", () => {
  const base = { DATABASE_URL: "postgres://x", DEVICE_SECRET_PEPPER: "0123456789abcdef" };
  it("refuses dev auth in production", () => {
    expect(() => loadConfig({ ...base, NODE_ENV: "production", AUTH_MODE: "dev" })).toThrow(/not allowed in production/);
  });
  it("requires a Firebase project id in firebase mode", () => {
    expect(() => loadConfig({ ...base, AUTH_MODE: "firebase" })).toThrow(/FIREBASE_PROJECT_ID/);
  });
  it("accepts a valid production config", () => {
    expect(loadConfig({ ...base, NODE_ENV: "production", AUTH_MODE: "firebase", FIREBASE_PROJECT_ID: "p" }).AUTH_MODE).toBe("firebase");
  });
});

describe("withDeadlockRetry", () => {
  const noSleep = async () => undefined;
  const pgError = (code: string) => Object.assign(new Error(code), { code });

  it("retries deadlocks and returns the eventual result", async () => {
    let calls = 0;
    const result = await withDeadlockRetry("t", async () => {
      calls++;
      if (calls < 3) throw pgError("40P01");
      return "ok";
    }, { sleep: noSleep });
    expect(result).toBe("ok");
    expect(calls).toBe(3);
  });

  it("does not retry other errors", async () => {
    let calls = 0;
    await expect(withDeadlockRetry("t", async () => { calls++; throw pgError("23505"); }, { sleep: noSleep })).rejects.toThrow("23505");
    expect(calls).toBe(1);
  });

  it("gives up after the attempt limit", async () => {
    let calls = 0;
    await expect(withDeadlockRetry("t", async () => { calls++; throw pgError("40P01"); }, { attempts: 4, sleep: noSleep })).rejects.toThrow();
    expect(calls).toBe(4);
  });
});
