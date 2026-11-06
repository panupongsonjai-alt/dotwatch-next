import type { Config } from "../config";
import { unauthorized } from "../lib/errors";

export interface VerifiedToken {
  uid: string;
  email: string | null;
  name: string | null;
  emailVerified: boolean;
}

export type TokenVerifier = (token: string) => Promise<VerifiedToken>;

/** dev tokens look like `dev:<uid>` or `dev:<uid>:<email>` (email counts as verified); refused in production (see config). */
function devVerifier(): TokenVerifier {
  return async (token) => {
    const [prefix, uid, email] = token.split(":");
    if (prefix !== "dev" || !uid) throw unauthorized("Use a dev token like dev:alice.");
    return { uid, email: email?.toLowerCase() ?? null, name: uid, emailVerified: Boolean(email) };
  };
}

function firebaseVerifier(projectId: string): TokenVerifier {
  let verify: ((t: string) => Promise<{ uid: string; email?: string; name?: string; email_verified?: boolean }>) | null = null;
  return async (token) => {
    if (!verify) {
      const { initializeApp, getApps } = await import("firebase-admin/app");
      const { getAuth } = await import("firebase-admin/auth");
      const app = getApps()[0] ?? initializeApp({ projectId });
      const auth = getAuth(app);
      verify = (t) => auth.verifyIdToken(t);
    }
    try {
      const decoded = await verify(token);
      return {
        uid: decoded.uid,
        email: decoded.email?.toLowerCase() ?? null,
        name: decoded.name ?? null,
        emailVerified: Boolean(decoded.email) && decoded.email_verified === true,
      };
    } catch {
      throw unauthorized();
    }
  };
}

export function createTokenVerifier(config: Pick<Config, "AUTH_MODE" | "FIREBASE_PROJECT_ID">): TokenVerifier {
  return config.AUTH_MODE === "firebase" ? firebaseVerifier(config.FIREBASE_PROJECT_ID) : devVerifier();
}

export function bearerToken(header: string | undefined): string | null {
  if (!header?.startsWith("Bearer ")) return null;
  const token = header.slice("Bearer ".length).trim();
  return token || null;
}
