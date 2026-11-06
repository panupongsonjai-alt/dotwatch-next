import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [
    react(),
    // In dev, settings come from .env.local; answer /config.js so the page does not log a 404.
    {
      name: "dev-config",
      configureServer(server) {
        server.middlewares.use("/config.js", (_req, res) => {
          res.setHeader("content-type", "text/javascript");
          res.end("/* dev: settings come from apps/web/.env.local */");
        });
      },
    },
  ],
  server: { port: 5173 },
});
