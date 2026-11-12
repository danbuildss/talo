import { Hono } from "hono";
import { z } from "zod";
import { createWorkspace, getWorkspace, listWorkspaces } from "../db/workspaces.ts";
import type { AppEnv } from "../env.ts";
import { jsonError } from "../http.ts";

const createSchema = z.strictObject({
  name: z.string().trim().min(1, { error: "name can't be empty" }).max(200),
  is_sample: z.boolean().optional(),
});

export const workspaces = new Hono<AppEnv>()
  .get("/", async (c) => c.json({ workspaces: await listWorkspaces(c.env.DB) }))
  .post("/", async (c) => {
    const body = await c.req.json().catch(() => undefined);
    const parsed = createSchema.safeParse(body);
    if (!parsed.success) {
      return jsonError(c, 400, "invalid_request", "Invalid workspace.", z.flattenError(parsed.error));
    }
    const ws = await createWorkspace(c.env.DB, {
      name: parsed.data.name,
      ownerEmail: c.get("adminEmail"),
      isSample: parsed.data.is_sample,
    });
    return c.json({ workspace: ws }, 201);
  })
  .get("/:workspaceId", async (c) => {
    const ws = await getWorkspace(c.env.DB, c.req.param("workspaceId"));
    return ws ? c.json({ workspace: ws }) : jsonError(c, 404, "not_found", "Workspace not found.");
  });
