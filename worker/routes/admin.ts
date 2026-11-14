/**
 * Admin curation API (behind admin login, like all of /api).
 * See docs/DATA-ENGINE.md §5 and PLAN.md Phase 3 step 4.
 */
import { type Context, Hono } from "hono";
import { z } from "zod";
import { ALIAS_KINDS, COMPANY_STATUSES } from "../../shared/registry.ts";
import { companyPatchSchema, registryFileSchema, signalPatchSchema } from "../../shared/registry-file.ts";
import { REVIEW_STATUSES, reviewInputSchema, SIGNAL_TYPE_SLUGS } from "../../shared/signals.ts";
import { auditData } from "../db/audit.ts";
import { addAlias, DuplicateCompanyError, getCompany, listCompanies, mergeCompanies } from "../db/companies.ts";
import { ImportRejectedError, importRegistryFile, reviewQueue, updateCompany, updateSignal } from "../db/curation.ts";
import { DuplicateSignalError, getSignal, listSignals, reviewCompany, reviewSignal } from "../db/signals.ts";
import { ConflictError, NotFoundError } from "../db/util.ts";
import type { AppEnv } from "../env.ts";
import { jsonError } from "../http.ts";

async function body<T extends z.ZodType>(c: Context<AppEnv>, schema: T): Promise<z.infer<T> | Response> {
  const raw = await c.req.json().catch(() => undefined);
  if (raw === undefined) return jsonError(c, 400, "invalid_request", "The request body must be JSON.");
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return jsonError(
      c,
      400,
      "invalid_request",
      "Some fields are invalid.",
      parsed.error.issues.map((i) => ({ path: i.path.map(String).join("."), message: i.message })),
    );
  }
  return parsed.data;
}

/** Turns data-layer errors into clear API errors. Anything else becomes a 500 without details. */
function fail(c: Context<AppEnv>, err: unknown): Response {
  if (err instanceof NotFoundError) return jsonError(c, 404, "not_found", err.message);
  if (err instanceof ImportRejectedError) {
    return jsonError(c, 409, "conflict", "Nothing was imported: fix these problems first.", err.problems);
  }
  if (err instanceof DuplicateCompanyError) return jsonError(c, 409, "conflict", err.message, err.existing);
  if (err instanceof DuplicateSignalError) {
    return jsonError(c, 409, "conflict", err.message, { existing_id: err.existingId });
  }
  if (err instanceof ConflictError) return jsonError(c, 409, "conflict", err.message);
  throw err;
}

const pageQuery = {
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
};
const companyQuery = z.object({
  q: z.string().trim().max(200).optional(),
  category: z.string().max(60).optional(),
  status: z.enum(COMPANY_STATUSES).optional(),
  ...pageQuery,
});
const signalQuery = z.object({
  status: z.enum(REVIEW_STATUSES).optional(),
  type: z.enum(SIGNAL_TYPE_SLUGS).optional(),
  company_id: z.string().max(60).optional(),
  category: z.string().max(60).optional(),
  ...pageQuery,
});

export const admin = new Hono<AppEnv>()
  // Import a talo.registry.v1 file. ?dry_run=1 checks it without saving.
  .post("/import", async (c) => {
    const file = await body(c, registryFileSchema);
    if (file instanceof Response) return file;
    try {
      const dryRun = ["1", "true"].includes(c.req.query("dry_run") ?? "");
      const result = await importRegistryFile(c.env.DB, file, c.get("adminEmail"), { dryRun });
      return c.json(result, dryRun ? 200 : 201);
    } catch (err) {
      return fail(c, err);
    }
  })

  .get("/queue", async (c) => c.json({ items: await reviewQueue(c.env.DB) }))
  .get("/audit", async (c) => c.json(await auditData(c.env.DB)))

  // Companies
  .get("/companies", async (c) => {
    const q = companyQuery.safeParse(c.req.query());
    if (!q.success) return jsonError(c, 400, "invalid_request", "Invalid filters.");
    return c.json({ companies: await listCompanies(c.env.DB, q.data) });
  })
  .get("/companies/:id", async (c) => {
    const company = await getCompany(c.env.DB, c.req.param("id"));
    if (!company) return jsonError(c, 404, "not_found", "Company not found.");
    const signals = await listSignals(c.env.DB, { companyId: company.id, limit: 200 });
    return c.json({ company, signals });
  })
  .patch("/companies/:id", async (c) => {
    const patch = await body(c, companyPatchSchema);
    if (patch instanceof Response) return patch;
    try {
      const result = await updateCompany(c.env.DB, c.req.param("id"), patch, c.get("adminEmail"));
      return c.json({ ...result, company: await getCompany(c.env.DB, c.req.param("id")) });
    } catch (err) {
      return fail(c, err);
    }
  })
  .post("/companies/:id/aliases", async (c) => {
    const input = await body(
      c,
      z.strictObject({ kind: z.enum(ALIAS_KINDS), value: z.string().trim().min(1).max(300) }),
    );
    if (input instanceof Response) return input;
    try {
      if (!(await getCompany(c.env.DB, c.req.param("id")))) throw new NotFoundError("company not found");
      await addAlias(c.env.DB, c.req.param("id"), input.kind, input.value);
      return c.json({ company: await getCompany(c.env.DB, c.req.param("id")) }, 201);
    } catch (err) {
      return fail(c, err);
    }
  })
  .post("/companies/:id/merge", async (c) => {
    const input = await body(c, z.strictObject({ duplicate_id: z.string().min(1).max(60) }));
    if (input instanceof Response) return input;
    try {
      await mergeCompanies(c.env.DB, c.req.param("id"), input.duplicate_id);
      return c.json({ company: await getCompany(c.env.DB, c.req.param("id")) });
    } catch (err) {
      return fail(c, err);
    }
  })
  .post("/companies/:id/review", async (c) => {
    const review = await body(c, reviewInputSchema);
    if (review instanceof Response) return review;
    try {
      const status = await reviewCompany(c.env.DB, c.req.param("id"), review, c.get("adminEmail"));
      return c.json({ status });
    } catch (err) {
      return fail(c, err);
    }
  })

  // Signals
  .get("/signals", async (c) => {
    const q = signalQuery.safeParse(c.req.query());
    if (!q.success) return jsonError(c, 400, "invalid_request", "Invalid filters.");
    const { company_id, ...rest } = q.data;
    return c.json({ signals: await listSignals(c.env.DB, { ...rest, companyId: company_id }) });
  })
  .get("/signals/:id", async (c) => {
    const signal = await getSignal(c.env.DB, c.req.param("id"));
    return signal ? c.json({ signal }) : jsonError(c, 404, "not_found", "Signal not found.");
  })
  .patch("/signals/:id", async (c) => {
    const patch = await body(c, signalPatchSchema);
    if (patch instanceof Response) return patch;
    try {
      const result = await updateSignal(c.env.DB, c.req.param("id"), patch, c.get("adminEmail"));
      return c.json({ ...result, signal: await getSignal(c.env.DB, c.req.param("id")) });
    } catch (err) {
      return fail(c, err);
    }
  })
  .post("/signals/:id/review", async (c) => {
    const review = await body(c, reviewInputSchema);
    if (review instanceof Response) return review;
    try {
      const status = await reviewSignal(c.env.DB, c.req.param("id"), review, c.get("adminEmail"));
      return c.json({ status });
    } catch (err) {
      return fail(c, err);
    }
  });
