/**
 * Where settings come from:
 *  - production: the API serves this web app and /config.js sets window.DOTWATCH_CONFIG at page load,
 *    so changing a setting on Render needs no rebuild, and the API is the same address as the page;
 *  - local dev (Vite on :5173): VITE_* values from apps/web/.env.local.
 */
interface RuntimeConfig {
  authMode?: "dev" | "firebase";
  firebase?: { apiKey: string; authDomain: string; projectId: string };
}

const runtime = (globalThis as { DOTWATCH_CONFIG?: RuntimeConfig }).DOTWATCH_CONFIG;

export const config = {
  /** "" = same address as the page. */
  apiUrl: runtime ? "" : (import.meta.env.VITE_API_URL ?? "http://localhost:4000").replace(/\/$/, ""),
  authMode: (runtime?.authMode ?? import.meta.env.VITE_AUTH_MODE ?? "dev") as "dev" | "firebase",
  firebase: runtime?.firebase ?? {
    apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
    authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
    projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  },
};

/** WebSocket address for the API (absolute, as some browsers need). */
export function wsUrl(path: string): string {
  const base = config.apiUrl || window.location.origin;
  return `${base.replace(/^http/, "ws")}${path}`;
}
