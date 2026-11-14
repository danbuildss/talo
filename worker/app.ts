import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { AppEnv } from "./env.ts";
import { jsonError, securityHeaders } from "./http.ts";
import { type AuthOptions, requireAdmin } from "./middleware/auth.ts";
import { admin } from "./routes/admin.ts";
import { workspaces } from "./routes/workspaces.ts";

export function createApp(auth: AuthOptions = {}) {
  const app = new Hono<AppEnv>();

  app.use("*", securityHeaders);

  // Public: tells you the Worker is up. Returns no data.
  app.get("/api/health", (c) => c.json({ ok: true }));

  // Everything else under /api needs a verified admin.
  app.use("/api/*", requireAdmin(auth));
  app.use(
    "/api/*",
    bodyLimit({
      maxSize: 5 * 1024 * 1024,
      onError: (c) => jsonError(c, 413, "invalid_request", "Request body is too large (max 5 MB)."),
    }),
  );

  app.get("/api/me", (c) => c.json({ email: c.get("adminEmail") }));
  app.route("/api/workspaces", workspaces);
  app.route("/api/admin", admin);

  app.notFound((c) => jsonError(c, 404, "not_found", "Not found."));
  app.onError((err, c) => {
    // Log the error type and route only: never request bodies or client data.
    console.error(`unhandled error on ${c.req.method} ${c.req.routePath}: ${err.name}`);
    return jsonError(c, 500, "internal", "Something went wrong.");
  });

  return app;
}
