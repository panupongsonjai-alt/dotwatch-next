type Level = "info" | "warn" | "error";

function write(level: Level, msg: string, extra?: Record<string, unknown>) {
  if (process.env.NODE_ENV === "test" && level === "info") return;
  const line = JSON.stringify({ t: new Date().toISOString(), level, msg, ...extra });
  (level === "error" ? console.error : console.log)(line);
}

export const log = {
  info: (msg: string, extra?: Record<string, unknown>) => write("info", msg, extra),
  warn: (msg: string, extra?: Record<string, unknown>) => write("warn", msg, extra),
  error: (msg: string, extra?: Record<string, unknown>) => write("error", msg, extra),
};
