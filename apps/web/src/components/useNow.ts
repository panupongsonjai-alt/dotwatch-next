import { useEffect, useState } from "react";

/** Ticks once per interval while the tab is visible. */
export function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => {
      if (document.visibilityState === "visible") setNow(Date.now());
    }, intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}
