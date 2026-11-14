/**
 * Collector admin routes, mounted under /api/admin (admin login required).
 * Watched sources, runs, and the inbox of collected items.
 */
import { Hono } from "hono";
import { z } from "zod";
import { watchedSourceInputSchema } from "../../shared/collector.ts";
import { signalInputSchema } from "../../shared/signals.ts";
import {
  closeInboxItem,
  createWatchedSource,
  getInboxItem,
  listInbox,
  listRuns,
  listWatchedSources,
  runSource,
  updateWatchedSource,
} from "../db/collector.ts";
import { createSignal, DuplicateSignalError } from "../db/signals.ts";
import { ConflictError, NotFoundError } from "../db/util.ts";
import type { AppEnv } from "../env.ts";
import { jsonError } from "../http.ts";

const promoteSchema = signalInputSchema
  .omit({ primary_source: true, is_sample: true })
  .extend({ primary_source: signalInputSchema.shape.primary_source.optional() });

async function readJson(c: { req: { json: () => Promise<unknown> } }) {
  return c.req.json().catch(() => undefined);
}

function invalid(c: Parameters<typeof jsonError>[0], error: z.ZodError) {
  return jsonError(
    c,
    400,
    "invalid_request",
    "Some fields are invalid.",
    error.issues.map((i) => ({ path: i.path.map(String).join("."), message: i.message })),
  );
}

function fail(c: Parameters<typeof jsonError>[0], err: unknown) {
  if (err instanceof NotFoundError) return jsonError(c, 404, "not_found", err.message);
  if (err instanceof DuplicateSignalError)
    return jsonError(c, 409, "conflict", err.message, { existing_id: err.existingId });
  if (err instanceof ConflictError) return jsonError(c, 409, "conflict", err.message);
  throw err;
}

export const collector = new Hono<AppEnv>()
  .get("/watched-sources", async (c) => c.json({ sources: await listWatchedSources(c.env.DB) }))
  .post("/watched-sources", async (c) => {
    const parsed = watchedSourceInputSchema.safeParse(await readJson(c));
    if (!parsed.success) return invalid(c, parsed.error);
    try {
      return c.json({ source: await createWatchedSource(c.env.DB, parsed.data, c.get("adminEmail")) }, 201);
    } catch (err) {
      return fail(c, err);
    }
  })
  .patch("/watched-sources/:id", async (c) => {
    const parsed = z
      .strictObject({ enabled: z.boolean().optional(), interval_hours: z.number().int().min(1).max(720).optional() })
      .safeParse(await readJson(c));
    if (!parsed.success) return invalid(c, parsed.error);
    try {
      return c.json({ source: await updateWatchedSource(c.env.DB, c.req.param("id"), parsed.data) });
    } catch (err) {
      return fail(c, err);
    }
  })
  // Check one source now, outside the schedule.
  .post("/watched-sources/:id/run", async (c) => {
    try {
      return c.json({ outcome: await runSource(c.env.DB, c.req.param("id"), { env: c.env }) });
    } catch (err) {
      return fail(c, err);
    }
  })
  .get("/runs", async (c) => c.json({ runs: await listRuns(c.env.DB, c.req.query("source_id")) }))

  .get("/inbox", async (c) => {
    const status = z.enum(["new", "promoted", "dismissed"]).catch("new").parse(c.req.query("status"));
    return c.json({ items: await listInbox(c.env.DB, status) });
  })
  .post("/inbox/:id/dismiss", async (c) => {
    try {
      await closeInboxItem(c.env.DB, c.req.param("id"), { status: "dismissed" }, c.get("adminEmail"));
      return c.json({ status: "dismissed" });
    } catch (err) {
      return fail(c, err);
    }
  })
  // Turn an inbox item into a signal (needs_review). The person writes the factual claim;
  // the item's link is the primary source unless a better one is given.
  .post("/inbox/:id/promote", async (c) => {
    const parsed = promoteSchema.safeParse(await readJson(c));
    if (!parsed.success) return invalid(c, parsed.error);
    try {
      const item = await getInboxItem(c.env.DB, c.req.param("id"));
      if (!item) throw new NotFoundError("inbox item not found");
      if (item.status !== "new") throw new ConflictError(`this item was already ${item.status}`);
      const primary = parsed.data.primary_source ?? {
        url: item.url,
        kind: "announcement" as const,
        title: item.title,
        published_at: item.published_at,
      };
      const signalId = await createSignal(
        c.env.DB,
        { ...parsed.data, primary_source: primary, is_sample: false },
        c.get("adminEmail"),
      );
      await closeInboxItem(c.env.DB, item.id, { status: "promoted", signalId }, c.get("adminEmail"));
      return c.json({ signal_id: signalId, status: "needs_review" }, 201);
    } catch (err) {
      return fail(c, err);
    }
  });
