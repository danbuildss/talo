/**
 * Admin curation: importing registry files, editing records and the review queue.
 *
 * Imports are checked in full before anything is written: duplicates against the
 * database and within the file, signals pointing at unknown companies, unknown
 * categories. If any row has a problem, nothing is stored.
 */

import { aliasesFor, normalizeAlias, normalizeUrl } from "../../shared/registry.ts";
import type { CompanyPatch, RegistryFile, SignalPatch } from "../../shared/registry-file.ts";
import type { ReviewStatus } from "../../shared/signals.ts";
import { createCompany, findByAliases } from "./companies.ts";
import { createSignal, dedupeKey } from "./signals.ts";
import { ConflictError, NotFoundError, newId, nowIso } from "./util.ts";

export interface ImportProblem {
  path: string;
  message: string;
}

export interface ImportResult {
  dry_run: boolean;
  companies_added: number;
  signals_added: number;
  company_ids: string[];
  signal_ids: string[];
}

export class ImportRejectedError extends Error {
  constructor(readonly problems: ImportProblem[]) {
    super(`import rejected: ${problems.length} problem(s)`);
  }
}

async function knownCategories(db: D1Database): Promise<Set<string>> {
  const { results } = await db.prepare("SELECT slug FROM categories").all<{ slug: string }>();
  return new Set(results.map((r) => r.slug));
}

/** Find every problem in a registry file without writing anything. */
export async function checkRegistryFile(db: D1Database, file: RegistryFile): Promise<ImportProblem[]> {
  const problems: ImportProblem[] = [];
  const categories = await knownCategories(db);

  // Companies: clashes with the database, and with each other inside the file.
  const inFile = new Map<string, number>(); // "kind:value" -> company index
  const fileDomains = new Set<string>();
  for (const [i, company] of file.companies.entries()) {
    const aliases = aliasesFor(company);
    for (const c of company.categories) {
      if (!categories.has(c)) problems.push({ path: `companies[${i}].categories`, message: `unknown category: ${c}` });
    }
    for (const hit of await findByAliases(db, aliases)) {
      problems.push({
        path: `companies[${i}]`,
        message: `already in Talo (${hit.kind} "${hit.value}", company ${hit.company_id})`,
      });
    }
    for (const a of aliases) {
      const key = `${a.kind}:${a.value}`;
      const other = inFile.get(key);
      if (other !== undefined && other !== i) {
        problems.push({ path: `companies[${i}]`, message: `duplicates companies[${other}] (${a.kind} "${a.value}")` });
      } else inFile.set(key, i);
      if (a.kind === "domain") fileDomains.add(a.value);
    }
  }

  // Signals: the company must exist (in the database or this file); no duplicate events.
  const seenEvents = new Map<string, number>();
  for (const [i, signal] of file.signals.entries()) {
    const domain = normalizeAlias("domain", signal.company_domain);
    const primary = normalizeUrl(signal.primary_source.url);
    if (!domain || !primary) continue; // already rejected by the schema
    const [hit] = await findByAliases(db, [{ kind: "domain", value: domain }]);
    if (!hit && !fileDomains.has(domain)) {
      problems.push({
        path: `signals[${i}].company_domain`,
        message: `no company with the domain ${domain} in Talo or in this file`,
      });
      continue;
    }
    const companyRef = hit?.company_id ?? `file:${domain}`;
    const key = dedupeKey(companyRef, signal.signal_type, primary);
    const other = seenEvents.get(key);
    if (other !== undefined) {
      problems.push({ path: `signals[${i}]`, message: `duplicates signals[${other}]` });
    } else seenEvents.set(key, i);
    if (hit) {
      const exists = await db
        .prepare("SELECT id FROM signal_events WHERE dedupe_key = ?")
        .bind(key)
        .first<{ id: string }>();
      if (exists) problems.push({ path: `signals[${i}]`, message: `already in Talo (signal ${exists.id})` });
    }
  }
  return problems;
}

/** Check, then (unless dry_run) add everything as needs_review. */
export async function importRegistryFile(
  db: D1Database,
  file: RegistryFile,
  importedBy: string,
  options: { dryRun?: boolean; now?: Date } = {},
): Promise<ImportResult> {
  const problems = await checkRegistryFile(db, file);
  if (problems.length > 0) throw new ImportRejectedError(problems);
  const result: ImportResult = {
    dry_run: options.dryRun ?? false,
    companies_added: 0,
    signals_added: 0,
    company_ids: [],
    signal_ids: [],
  };
  if (options.dryRun) return result;
  for (const c of file.companies) {
    result.company_ids.push((await createCompany(db, c, importedBy, options.now)).id);
    result.companies_added += 1;
  }
  for (const s of file.signals) {
    result.signal_ids.push(await createSignal(db, s, importedBy, options.now));
    result.signals_added += 1;
  }
  return result;
}

function reopenStatement(
  db: D1Database,
  subject: "company" | "signal",
  id: string,
  from: ReviewStatus,
  editor: string,
  fields: string[],
  at: string,
) {
  return db
    .prepare(
      `INSERT INTO verification_reviews (id, subject_type, subject_id, action, from_status, to_status, reviewer, reason, created_at)
       VALUES (?, ?, ?, 'reopen', ?, 'needs_review', ?, ?, ?)`,
    )
    .bind(newId(), subject, id, from, editor, `edited: ${fields.join(", ")}`, at);
}

/**
 * Edit a company. If it was verified and its name or description changes, it goes
 * back to needs_review (logged), because the verified facts changed.
 * Categories can change without re-review: they are Talo's labels, not claims.
 */
export async function updateCompany(
  db: D1Database,
  id: string,
  patch: CompanyPatch,
  editor: string,
  now = new Date(),
): Promise<{ reopened: boolean }> {
  const row = await db
    .prepare("SELECT status, name FROM companies WHERE id = ?")
    .bind(id)
    .first<{ status: ReviewStatus; name: string }>();
  if (!row) throw new NotFoundError("company not found");
  const at = nowIso(now);
  const statements: D1PreparedStatement[] = [];
  const factFields: string[] = [];

  if (patch.name !== undefined && patch.name !== row.name) {
    const value = normalizeAlias("name", patch.name);
    if (!value) throw new ConflictError("that name isn't usable");
    const [hit] = await findByAliases(db, [{ kind: "name", value }]);
    if (hit && hit.company_id !== id) throw new ConflictError(`another company already uses the name "${patch.name}"`);
    statements.push(db.prepare("UPDATE companies SET name = ? WHERE id = ?").bind(patch.name, id));
    if (!hit) {
      statements.push(
        db
          .prepare("INSERT INTO company_aliases (id, company_id, kind, value, created_at) VALUES (?, ?, 'name', ?, ?)")
          .bind(newId(), id, value, at),
      );
    }
    factFields.push("name");
  }
  if (patch.description !== undefined) {
    statements.push(db.prepare("UPDATE companies SET description = ? WHERE id = ?").bind(patch.description, id));
    factFields.push("description");
  }
  if (patch.categories !== undefined) {
    const known = await knownCategories(db);
    const unknown = patch.categories.filter((c) => !known.has(c));
    if (unknown.length) throw new ConflictError(`unknown categories: ${unknown.join(", ")}`);
    statements.push(db.prepare("DELETE FROM company_categories WHERE company_id = ?").bind(id));
    for (const slug of new Set(patch.categories)) {
      statements.push(
        db
          .prepare(
            "INSERT INTO company_categories (company_id, category_id) SELECT ?, id FROM categories WHERE slug = ?",
          )
          .bind(id, slug),
      );
    }
  }
  const reopened = row.status === "verified" && factFields.length > 0;
  if (reopened) {
    statements.push(db.prepare("UPDATE companies SET status = 'needs_review' WHERE id = ?").bind(id));
    statements.push(reopenStatement(db, "company", id, row.status, editor, factFields, at));
  }
  statements.push(db.prepare("UPDATE companies SET updated_at = ? WHERE id = ?").bind(at, id));
  await db.batch(statements);
  return { reopened };
}

/** Edit a signal. If it was verified and any field changes, it goes back to needs_review (logged). */
export async function updateSignal(
  db: D1Database,
  id: string,
  patch: SignalPatch,
  editor: string,
  now = new Date(),
): Promise<{ reopened: boolean }> {
  const row = await db
    .prepare("SELECT status FROM signal_events WHERE id = ?")
    .bind(id)
    .first<{ status: ReviewStatus }>();
  if (!row) throw new NotFoundError("signal not found");
  const at = nowIso(now);
  const fields = Object.keys(patch) as (keyof SignalPatch)[];
  const statements: D1PreparedStatement[] = fields.map((f) =>
    // Field names come from the strict schema's fixed list, never from the request.
    db.prepare(`UPDATE signal_events SET ${f} = ? WHERE id = ?`).bind(patch[f] ?? null, id),
  );
  const reopened = row.status === "verified";
  if (reopened) {
    statements.push(db.prepare("UPDATE signal_events SET status = 'needs_review' WHERE id = ?").bind(id));
    statements.push(reopenStatement(db, "signal", id, row.status, editor, fields, at));
  }
  statements.push(db.prepare("UPDATE signal_events SET updated_at = ? WHERE id = ?").bind(at, id));
  await db.batch(statements);
  return { reopened };
}

export interface QueueItem {
  subject_type: "company" | "signal";
  id: string;
  label: string;
  company_id: string;
  company_status: ReviewStatus;
  created_at: string;
  /** The page to open when reviewing. */
  check_url: string | null;
}

/** Everything waiting for review, oldest first. Companies come before their signals. */
export async function reviewQueue(db: D1Database, limit = 100): Promise<QueueItem[]> {
  const { results } = await db
    .prepare(
      `SELECT 'company' AS subject_type, c.id, c.name AS label, c.id AS company_id, c.status AS company_status,
         c.created_at, 'https://' || c.primary_domain AS check_url, 0 AS ord
       FROM companies c WHERE c.status = 'needs_review'
       UNION ALL
       SELECT 'signal', se.id, c.name || ': ' || se.title, c.id, c.status, se.created_at,
         (SELECT s.url FROM signal_sources ss JOIN sources s ON s.id = ss.source_id
          WHERE ss.signal_id = se.id AND ss.role = 'primary'), 1
       FROM signal_events se JOIN companies c ON c.id = se.company_id WHERE se.status = 'needs_review'
       ORDER BY created_at, ord LIMIT ?`,
    )
    .bind(Math.min(Math.max(limit, 1), 500))
    .all<QueueItem & { ord: number }>();
  return results.map(({ ord: _ord, ...item }) => item);
}
