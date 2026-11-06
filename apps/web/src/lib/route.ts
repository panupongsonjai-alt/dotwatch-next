import { useEffect, useState } from "react";

/** Screens, addressed by the URL hash so the back button and bookmarks work without a router. */
export type Route = { name: "overview" } | { name: "device"; id: string } | { name: "notifications" } | { name: "org" };

export const NOTIFICATIONS_HREF = "#/settings/notifications";
export const ORG_HREF = "#/settings/org";

export function parseRoute(hash: string): Route {
  if (hash === NOTIFICATIONS_HREF) return { name: "notifications" };
  if (hash === ORG_HREF) return { name: "org" };
  const m = /^#\/devices\/([0-9a-f-]{36})$/i.exec(hash);
  return m ? { name: "device", id: m[1]!.toLowerCase() } : { name: "overview" };
}

export const deviceHref = (id: string) => `#/devices/${id}`;

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseRoute(window.location.hash));
  useEffect(() => {
    const on = () => {
      setRoute(parseRoute(window.location.hash));
      window.scrollTo(0, 0);
    };
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return route;
}
