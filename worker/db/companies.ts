/**
 * The shared company registry. Duplicates are stopped by UNIQUE(kind, value) on
 * aliases: before inserting, every alias of the new company is looked up, and any
 * match is reported as a conflict naming the existing company.
 */
import {
  type AliasKind,
  aliasesFor,
  type CompanyInput,
  type CompanyStatus,
  normalizeAlias,
  normalizeUrl,
  type SourceInput,
  slugify,
} from "../../shared/registry.ts";
import { ConflictError, NotFoundError, newId, nowIso } from "./util.ts";

export interface Company {
  id: string;
  slug: string;
  name: string;
  primary_domain: string;
  description: string | null;
  status: CompanyStatus;
  is_sample: boolean;
  first_seen_at: string;
  last_verified_at: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface CompanyDetail extends Company {
  aliases: { kind: AliasKind; value: string }[];
  categories: { slug: string; label: string; kind: string }[];
  sources: StoredSource[];
}

export interface StoredSource {
  id: string;
  url: string;
  kind: string;
  company_id: string | null;
  title: string;
  published_at: string | null;
  excerpt: string | null;
  first_seen_at: string;
}

type CompanyRow = Omit<Company, "is_sample"> & { is_sample: number };
const toCompany = (r: CompanyRow): Company => ({ ...r, is_sample: r.is_sample === 1 });

/** Thrown when a new company matches an existing one by any alias. */
export class DuplicateCompanyError extends ConflictError {
  constructor(readonly existing: { company_id: string; kind: AliasKind; value: string }[]) {
    super(`matches an existing company (${existing.map((e) => `${e.kind} "${e.value}"`).join(", ")})`);
  }
}

/** Existing companies that share any of these aliases. */
export async function findByAliases(
  db: D1Database,
  aliases: { kind: AliasKind; value: string }[],
): Promise<{ company_id: string; kind: AliasKind; value: string }[]> {
  if (aliases.length === 0) return [];
  const where = aliases.map(() => "(kind = ? AND value = ?)").join(" OR ");
  const { results } = await db
    .prepare(`SELECT company_id, kind, value FROM company_aliases WHERE ${where}`)
    .bind(...aliases.flatMap((a) => [a.kind, a.value]))
    .all<{ company_id: string; kind: AliasKind; value: string }>();
  return results;
}

async function uniqueSlug(db: D1Database, name: string): Promise<string> {
  const base = slugify(name);
  const { results } = await db
    .prepare("SELECT slug FROM companies WHERE slug = ? OR slug LIKE ?")
    .bind(base, `${base}-%`)
    .all<{ slug: string }>();
  const taken = new Set(results.map((r) => r.slug));
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
}

async function categoryIds(db: D1Database, slugs: string[]): Promise<Map<string, string>> {
  if (slugs.length === 0) return new Map();
  const { results } = await db
    .prepare(`SELECT id, slug FROM categories WHERE slug IN (${slugs.map(() => "?").join(",")})`)
    .bind(...slugs)
    .all<{ id: string; slug: string }>();
  return new Map(results.map((r) => [r.slug, r.id]));
}

function sourceStatement(db: D1Database, s: SourceInput, companyId: string | null, at: string) {
  const url = normalizeUrl(s.url);
  if (!url) throw new ConflictError(`source url isn't a valid http(s) link: ${s.url}`);
  // A URL is stored once. If it already exists, only attach it to the company when it has none.
  return db
    .prepare(
      `INSERT INTO sources (id, url, kind, company_id, title, published_at, excerpt, first_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(url) DO UPDATE SET company_id = COALESCE(sources.company_id, excluded.company_id)`,
    )
    .bind(newId(), url, s.kind, companyId, s.title, s.published_at, s.excerpt ?? null, at);
}

/**
 * Add a company as needs_review, with its aliases, categories and sources, all at once.
 * Throws DuplicateCompanyError if any alias already belongs to another company,
 * and ConflictError for unknown categories.
 */
export async function createCompany(
  db: D1Database,
  input: CompanyInput,
  createdBy: string,
  now = new Date(),
): Promise<Company> {
  const aliases = aliasesFor(input);
  const clashes = await findByAliases(db, aliases);
  if (clashes.length > 0) throw new DuplicateCompanyError(clashes);

  const cats = await categoryIds(db, input.categories);
  const unknown = input.categories.filter((c) => !cats.has(c));
  if (unknown.length > 0) throw new ConflictError(`unknown categories: ${unknown.join(", ")}`);

  const at = nowIso(now);
  const company: Company = {
    id: newId(),
    slug: await uniqueSlug(db, input.name),
    name: input.name,
    primary_domain: input.domain,
    description: input.description ?? null,
    status: "needs_review",
    is_sample: input.is_sample,
    first_seen_at: at,
    last_verified_at: null,
    created_by: createdBy,
    created_at: at,
    updated_at: at,
  };
  const statements = [
    db
      .prepare(
        `INSERT INTO companies (id, slug, name, primary_domain, description, status, is_sample, first_seen_at,
          last_verified_at, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        company.id,
        company.slug,
        company.name,
        company.primary_domain,
        company.description,
        company.status,
        company.is_sample ? 1 : 0,
        company.first_seen_at,
        null,
        createdBy,
        at,
        at,
      ),
    ...aliases.map((a) =>
      db
        .prepare("INSERT INTO company_aliases (id, company_id, kind, value, created_at) VALUES (?, ?, ?, ?, ?)")
        .bind(newId(), company.id, a.kind, a.value, at),
    ),
    ...[...cats.values()].map((id) =>
      db.prepare("INSERT INTO company_categories (company_id, category_id) VALUES (?, ?)").bind(company.id, id),
    ),
    ...input.sources.map((s) => sourceStatement(db, s, company.id, at)),
  ];
  try {
    await db.batch(statements);
  } catch (err) {
    // Another request added a clashing alias in between: report it the same way.
    if (err instanceof Error && /UNIQUE constraint failed/i.test(err.message)) {
      throw new DuplicateCompanyError(await findByAliases(db, aliases));
    }
    throw err;
  }
  return company;
}

/** Add one more alias. Fails if it belongs to another company. */
export async function addAlias(db: D1Database, companyId: string, kind: AliasKind, raw: string, now = new Date()) {
  const value = normalizeAlias(kind, raw);
  if (value === null) throw new ConflictError(`not a valid ${kind}: ${raw}`);
  const [hit] = await findByAliases(db, [{ kind, value }]);
  if (hit && hit.company_id !== companyId) throw new DuplicateCompanyError([hit]);
  if (hit) return;
  await db
    .prepare("INSERT INTO company_aliases (id, company_id, kind, value, created_at) VALUES (?, ?, ?, ?, ?)")
    .bind(newId(), companyId, kind, value, nowIso(now))
    .run();
}

/** Attach evidence to a company. The same URL is never stored twice. Returns the source id. */
export async function addSource(
  db: D1Database,
  companyId: string | null,
  source: SourceInput,
  now = new Date(),
): Promise<string> {
  await sourceStatement(db, source, companyId, nowIso(now)).run();
  const row = await db
    .prepare("SELECT id FROM sources WHERE url = ?")
    .bind(normalizeUrl(source.url))
    .first<{ id: string }>();
  if (!row) throw new Error("source was not stored");
  return row.id;
}

export async function getCompany(db: D1Database, idOrSlug: string): Promise<CompanyDetail | null> {
  const row = await db
    .prepare("SELECT * FROM companies WHERE id = ? OR slug = ?")
    .bind(idOrSlug, idOrSlug)
    .first<CompanyRow>();
  if (!row) return null;
  const [aliases, cats, sources] = await db.batch([
    db.prepare("SELECT kind, value FROM company_aliases WHERE company_id = ? ORDER BY kind, value").bind(row.id),
    db
      .prepare(
        `SELECT c.slug, c.label, c.kind FROM categories c JOIN company_categories cc ON cc.category_id = c.id
         WHERE cc.company_id = ? ORDER BY c.kind, c.label`,
      )
      .bind(row.id),
    db
      .prepare(
        `SELECT id, url, kind, company_id, title, published_at, excerpt, first_seen_at FROM sources
         WHERE company_id = ? ORDER BY COALESCE(published_at, first_seen_at) DESC`,
      )
      .bind(row.id),
  ]);
  return {
    ...toCompany(row),
    aliases: (aliases?.results ?? []) as CompanyDetail["aliases"],
    categories: (cats?.results ?? []) as CompanyDetail["categories"],
    sources: (sources?.results ?? []) as StoredSource[],
  };
}

export interface CompanyFilter {
  q?: string;
  category?: string;
  status?: CompanyStatus;
  limit?: number;
  offset?: number;
}

export async function listCompanies(db: D1Database, filter: CompanyFilter = {}): Promise<Company[]> {
  const where: string[] = [];
  const args: unknown[] = [];
  if (filter.q) {
    const like = `%${filter.q.toLowerCase().replace(/[%_\\]/g, (m) => `\\${m}`)}%`;
    where.push(
      `(LOWER(name) LIKE ? ESCAPE '\\' OR LOWER(COALESCE(description, '')) LIKE ? ESCAPE '\\' OR primary_domain LIKE ? ESCAPE '\\')`,
    );
    args.push(like, like, like);
  }
  if (filter.category) {
    where.push(
      "id IN (SELECT cc.company_id FROM company_categories cc JOIN categories c ON c.id = cc.category_id WHERE c.slug = ?)",
    );
    args.push(filter.category);
  }
  if (filter.status) {
    where.push("status = ?");
    args.push(filter.status);
  }
  const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200);
  const offset = Math.max(filter.offset ?? 0, 0);
  const sql = `SELECT * FROM companies ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY name COLLATE NOCASE LIMIT ? OFFSET ?`;
  const { results } = await db
    .prepare(sql)
    .bind(...args, limit, offset)
    .all<CompanyRow>();
  return results.map(toCompany);
}

/**
 * Merge a duplicate into the company we keep: aliases, categories, sources and
 * workspace candidates move over, then the duplicate is deleted. All at once.
 */
export async function mergeCompanies(db: D1Database, keepId: string, dropId: string, now = new Date()) {
  if (keepId === dropId) throw new ConflictError("can't merge a company into itself");
  const both = await db
    .prepare("SELECT id FROM companies WHERE id IN (?, ?)")
    .bind(keepId, dropId)
    .all<{ id: string }>();
  if (both.results.length !== 2) throw new NotFoundError("company not found");
  await db.batch([
    db.prepare("UPDATE company_aliases SET company_id = ? WHERE company_id = ?").bind(keepId, dropId),
    db
      .prepare(
        "INSERT OR IGNORE INTO company_categories (company_id, category_id) SELECT ?, category_id FROM company_categories WHERE company_id = ?",
      )
      .bind(keepId, dropId),
    db.prepare("UPDATE sources SET company_id = ? WHERE company_id = ?").bind(keepId, dropId),
    db.prepare("UPDATE partner_candidates SET company_id = ? WHERE company_id = ?").bind(keepId, dropId),
    db.prepare("UPDATE companies SET updated_at = ? WHERE id = ?").bind(nowIso(now), keepId),
    db.prepare("DELETE FROM companies WHERE id = ?").bind(dropId),
  ]);
}
