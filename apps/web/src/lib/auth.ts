// Two sign-in modes behind one interface: dev (any name) and Firebase email/password (decision 6).
const MODE = (import.meta.env.VITE_AUTH_MODE ?? "dev") as "dev" | "firebase";
const DEV_KEY = "dotwatch.devUser";

type Listener = (signedIn: boolean) => void;
const listeners = new Set<Listener>();
let firebaseUser: { getIdToken(): Promise<string> } | null = null;
let firebaseReady: Promise<void> | null = null;
let devFallback: string | null = null;

async function firebaseAuth() {
  const { initializeApp } = await import("firebase/app");
  const auth = await import("firebase/auth");
  const app = initializeApp({
    apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
    authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
    projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  });
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

export async function getToken(): Promise<string | null> {
  if (MODE === "dev") {
    const uid = readDevUser() ?? devFallback;
    return uid ? `dev:${uid}` : null;
  }
  return firebaseUser ? firebaseUser.getIdToken() : null;
}
