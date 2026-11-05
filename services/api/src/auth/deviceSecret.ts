import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Device secrets are 32 random bytes, so a keyed SHA-256 is enough; no bcrypt.
 * Verifying costs microseconds and needs no cache (fixes audit 3.4 at the root).
 */
export function generateDeviceSecret(): string {
  return randomBytes(32).toString("base64url");
}

export function hashDeviceSecret(secret: string, pepper: string): Buffer {
  return createHmac("sha256", pepper).update(secret).digest();
}

export function verifyDeviceSecret(secret: string, hash: Buffer, pepper: string): boolean {
  const candidate = hashDeviceSecret(secret, pepper);
  return candidate.length === hash.length && timingSafeEqual(candidate, hash);
}

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export function generateDeviceCode(): string {
  const bytes = randomBytes(6);
  let out = "DW-";
  for (const b of bytes) out += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return out;
}

/** Header format: `Authorization: Device <code>:<secret>` */
export function parseDeviceAuthHeader(header: string | undefined): { code: string; secret: string } | null {
  if (!header?.startsWith("Device ")) return null;
  const value = header.slice("Device ".length).trim();
  const sep = value.indexOf(":");
  if (sep <= 0 || sep === value.length - 1) return null;
  return { code: value.slice(0, sep), secret: value.slice(sep + 1) };
}
