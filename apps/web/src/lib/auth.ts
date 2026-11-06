// Two sign-in modes behind one interface: dev (any name, optionally "name:email") and Firebase email/password (decision 6).
import { config } from "./config";

const MODE = config.authMode;
const DEV_KEY = "dotwatch.devUser";

type Listener = (signedIn: boolean) => void;
const listeners = new Set<Listener>();
interface FbUser {
  email: string | null;
  emailVerified: boolean;
  getIdToken(forceRefresh?: boolean): Promise<string>;
  reload(): Promise<void>;
}
let firebaseUser: FbUser | null = null;
let firebaseReady: Promise<void> | null = null;
let devFallback: string | null = null;

async function firebaseAuth() {
  const { initializeApp } = await import("firebase/app");
  const auth = await import("firebase/auth");
  const app = initializeApp(config.firebase);
  return { auth, instance: auth.getAuth(app) };
}

const fb = MODE === "firebase" ? firebaseAuth() : null;

function readDevUser(): string | null {
  try {
    return localStorage.getItem(DEV_KEY);
  } catch {
    return null;
  }
}

export const authMode = MODE;

export function onAuthChange(fn: Listener): () => void {
  listeners.add(fn);
  if (MODE === "dev") fn(readDevUser() !== null);
  else {
    firebaseReady ??= fb!.then(({ auth, instance }) => {
      auth.onAuthStateChanged(instance, (u) => {
        firebaseUser = u;
        listeners.forEach((l) => l(u !== null));
      });
    });
  }
  return () => listeners.delete(fn);
}

export async function signIn(identity: string, password: string): Promise<void> {
  if (MODE === "dev") {
    try {
      localStorage.setItem(DEV_KEY, identity.trim());
    } catch {
      /* private mode: stays signed in for this tab only */
    }
    devFallback = identity.trim();
    listeners.forEach((l) => l(true));
    return;
  }
  const { auth, instance } = await fb!;
  await auth.signInWithEmailAndPassword(instance, identity, password);
}

export async function signOut(): Promise<void> {
  if (MODE === "dev") {
    try {
      localStorage.removeItem(DEV_KEY);
    } catch {
      /* ignore */
    }
    devFallback = null;
    listeners.forEach((l) => l(false));
    return;
  }
  const { auth, instance } = await fb!;
  await auth.signOut(instance);
}

/** Firebase only: create an account. Existing users from the old system sign in with their current password. */
export async function signUp(email: string, password: string): Promise<void> {
  if (MODE === "dev") return signIn(email, password);
  const { auth, instance } = await fb!;
  const cred = await auth.createUserWithEmailAndPassword(instance, email, password);
  await auth.sendEmailVerification(cred.user).catch(() => undefined);
}

export async function resetPassword(email: string): Promise<void> {
  if (MODE === "dev") return;
  const { auth, instance } = await fb!;
  await auth.sendPasswordResetEmail(instance, email);
}

export async function sendVerification(): Promise<void> {
  if (MODE === "dev" || !firebaseUser) return;
  const { auth } = await fb!;
  await auth.sendEmailVerification(firebaseUser as never);
}

/** After the user clicks the link in the email: reload and get a token that carries email_verified = true. */
export async function refreshVerification(): Promise<boolean> {
  if (MODE === "dev" || !firebaseUser) return true;
  await firebaseUser.reload();
  await firebaseUser.getIdToken(true);
  return firebaseUser.emailVerified;
}

/** Firebase error codes → Thai. */
export function authErrorText(err: unknown): string {
  const code = (err as { code?: string }).code ?? "";
  if (code.includes("invalid-credential") || code.includes("wrong-password") || code.includes("user-not-found")) return "อีเมลหรือรหัสผ่านไม่ถูกต้อง";
  if (code.includes("email-already-in-use")) return "อีเมลนี้มีบัญชีอยู่แล้ว ให้เข้าสู่ระบบแทน";
  if (code.includes("weak-password")) return "รหัสผ่านต้องยาวอย่างน้อย 6 ตัวอักษร";
  if (code.includes("invalid-email")) return "รูปแบบอีเมลไม่ถูกต้อง";
  if (code.includes("too-many-requests")) return "ลองหลายครั้งเกินไป รอสักครู่แล้วลองใหม่";
  if (code.includes("network")) return "เชื่อมต่ออินเทอร์เน็ตไม่ได้";
  return "ทำรายการไม่สำเร็จ ลองใหม่อีกครั้ง";
}

export async function getToken(): Promise<string | null> {
  if (MODE === "dev") {
    // "alice" → dev:alice ; "alice:alice@example.com" → dev:alice:alice@example.com (email counts as verified)
    const uid = readDevUser() ?? devFallback;
    return uid ? `dev:${uid.replace(/\s+/g, "")}` : null;
  }
  return firebaseUser ? firebaseUser.getIdToken() : null;
}
