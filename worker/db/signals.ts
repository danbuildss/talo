/**
 * Signals and verification reviews. Every status change writes a review row in the
 * same batch, so the audit log can't miss one.
 */
import { normalizeAlias, normalizeUrl, type SourceInput } from "../../shared/registry.ts";
import {
  type EffectiveStatus,
  effectiveSignalStatus,
  nextStatus,
  type ReviewInput,
  type ReviewStatus,
  type SignalInput,
  type SignalType,
} from "../../shared/signals.ts";
import { addSource, findByAliases } from "./companies.ts";
import { ConflictError, NotFoundError, newId, nowIso } from "./util.ts";

export class DuplicateSignalError extends ConflictError {
  constructor(readonly existingId: string) {
    super("this signal is already recorded (same company, type and primary source)");
  }
}

export class InvalidReviewError extends ConflictError {}

export interface Signal {
  id: string;
  company_id: string;
  company_name: string;
  company_slug: string;
  company_status: ReviewStatus;
  signal_type: SignalType;
  title: string;
  factual_claim: string;
  source_excerpt: string;
  opportunity_note: string | null;
  event_date: string | null;
  discovered_at: string;
  last_verified_at: string | null;
  status: ReviewStatus;
  effective_status: EffectiveStatus;
  rejected_reason: string | null;
  is_sample: boolean;
  primary_source: { url: string; title: string; kind: string; published_at: string | null } | null;
  corroborating_sources: { url: string; title: string; kind: string; published_at: string | null }[];
}

type SignalRow = Omit<Signal, "effective_status" | "is_sample" | "primary_source" | "corroborating_sources"> & {
  is_sample: number;
};

export function dedupeKey(companyId: string, type: SignalType, primaryUrl: string): string {
  return `${companyId}|${type}|${primaryUrl}`;
}

async function companyIdForDomain(db: D1Database, domain: string): Promise<string> {
  const value = normalizeAlias("domain", domain);
  const [hit] = value ? await findByAliases(db, [{ kind: "domain", value }]) : [];
  if (!hit) throw new NotFoundError(`no company with the domain ${domain}; add the company first`);
  return hit.company_id;
}

/** Record a signal as needs_review with its sources. The company must already exist. */
export async function createSignal(
  db: D1Database,
  input: SignalInput,
  createdBy: string,
  now = new Date(),
): Promise<string> {
  const companyId = await companyIdForDomain(db, input.company_domain);
  const primaryUrl = normalizeUrl(input.primary_source.url);
  if (!primaryUrl) throw new ConflictError("primary_source.url isn't a valid http(s) link");
  const key = dedupeKey(companyId, input.signal_type, primaryUrl);
  const existing = await db
    .prepare("SELECT id FROM signal_events WHERE dedupe_key = ?")
    .bind(key)
    .first<{ id: string }>();
  if (existing) throw new DuplicateSignalError(existing.id);

  // Sources are shared evidence: store each URL once, then link it.
  const sourceIds: { id: string; role: "primary" | "corroborating" }[] = [
    { id: await addSource(db, companyId, input.primary_source, now), role: "primary" },
  ];
  for (const s of input.corroborating_sources as SourceInput[]) {
    const id = await addSource(db, companyId, s, now);
    if (!sourceIds.some((x) => x.id === id)) sourceIds.push({ id, role: "corroborating" });
  }

  const id = newId();
  const at = nowIso(now);
  try {
    await db.batch([
      db
        .prepare(
          `INSERT INTO signal_events (id, company_id, signal_type, title, factual_claim, source_excerpt, opportunity_note,
            event_date, discovered_at, status, dedupe_key, is_sample, created_by, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'needs_review', ?, ?, ?, ?, ?)`,
        )
        .bind(
          id,
          companyId,
          input.signal_type,
          input.title,
          input.factual_claim,
          input.source_excerpt,
          input.opportunity_note ?? null,
          input.event_date ?? null,
          at,
          key,
          input.is_sample ? 1 : 0,
          createdBy,
          at,
          at,
        ),
      ...sourceIds.map((s) =>
        db.prepare("INSERT INTO signal_sources (signal_id, source_id, role) VALUES (?, ?, ?)").bind(id, s.id, s.role),
      ),
    ]);
  } catch (err) {
    if (err instanceof Error && /UNIQUE constraint failed: signal_events.dedupe_key/i.test(err.message)) {
      const row = await db
        .prepare("SELECT id FROM signal_events WHERE dedupe_key = ?")
        .bind(key)
        .first<{ id: string }>();
      throw new DuplicateSignalError(row?.id ?? "");
    }
    throw err;
  }
  return id;
}

function reviewStatement(
  db: D1Database,
  subject: "company" | "signal",
  subjectId: string,
  review: ReviewInput,
  from: ReviewStatus,
  to: ReviewStatus,
  reviewer: string,
  at: string,
) {
  return db
    .prepare(
      `INSERT INTO verification_reviews (id, subject_type, subject_id, action, from_status, to_status, reviewer,
        checked_url, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      newId(),
      subject,
      subjectId,
      review.action,
      from,
      to,
      reviewer,
      review.checked_url ? normalizeUrl(review.checked_url) : null,
      review.reason ?? null,
      at,
    );
}

/**
 * Review a signal. To verify, the reviewer must have checked the signal's own
 * primary or corroborating source: a page elsewhere doesn't count.
 */
export async function reviewSignal(
  db: D1Database,
  signalId: string,
  review: ReviewInput,
  reviewer: string,
  now = new Date(),
): Promise<ReviewStatus> {
  const row = await db
    .prepare("SELECT status FROM signal_events WHERE id = ?")
    .bind(signalId)
    .first<{ status: ReviewStatus }>();
  if (!row) throw new NotFoundError("signal not found");
  const to = nextStatus(row.status, review.action);
  if (!to) throw new InvalidReviewError(`can't ${review.action} a signal that is ${row.status}`);

  if (review.action === "verify") {
    const { results } = await db
      .prepare("SELECT s.url FROM signal_sources ss JOIN sources s ON s.id = ss.source_id WHERE ss.signal_id = ?")
      .bind(signalId)
      .all<{ url: string }>();
    const checked = normalizeUrl(review.checked_url ?? "");
    if (!checked || !results.some((r) => r.url === checked)) {
      throw new InvalidReviewError("checked_url must be one of this signal's own sources");
    }
  }

  const at = nowIso(now);
  await db.batch([
    db
      .prepare(
        `UPDATE signal_events SET status = ?, updated_at = ?,
           last_verified_at = CASE WHEN ? = 'verified' THEN ? ELSE last_verified_at END,
           rejected_reason = CASE WHEN ? = 'rejected' THEN ? ELSE NULL END
         WHERE id = ?`,
      )
      .bind(to, at, to, at, to, review.reason ?? null, signalId),
    reviewStatement(db, "signal", signalId, review, row.status, to, reviewer, at),
  ]);
  return to;
}

/**
 * Review a company. To verify, the reviewer must have checked a page on one of the
 * company's own domains (its official site confirms who it is).
 */
export async function reviewCompany(
  db: D1Database,
  companyId: string,
  review: ReviewInput,
  reviewer: string,
  now = new Date(),
): Promise<ReviewStatus> {
  const row = await db
    .prepare("SELECT status FROM companies WHERE id = ?")
    .bind(companyId)
    .first<{ status: ReviewStatus }>();
  if (!row) throw new NotFoundError("company not found");
  const to = nextStatus(row.status, review.action);
  if (!to) throw new InvalidReviewError(`can't ${review.action} a company that is ${row.status}`);

  if (review.action === "verify") {
    const host = normalizeAlias("domain", review.checked_url ?? "");
    const { results } = await db
      .prepare("SELECT value FROM company_aliases WHERE company_id = ? AND kind = 'domain'")
      .bind(companyId)
      .all<{ value: string }>();
    const ok = host !== null && results.some((r) => host === r.value || host.endsWith(`.${r.value}`));
    if (!ok) throw new InvalidReviewError("checked_url must be a page on the company's own domain");
  }

  const at = nowIso(now);
  await db.batch([
    db
      .prepare(
        `UPDATE companies SET status = ?, updated_at = ?,
           last_verified_at = CASE WHEN ? = 'verified' THEN ? ELSE last_verified_at END
         WHERE id = ?`,
      )
      .bind(to, at, to, at, companyId),
    reviewStatement(db, "company", companyId, review, row.status, to, reviewer, at),
  ]);
  return to;
}

const SIGNAL_SELECT = `SELECT se.id, se.company_id, c.name AS company_name, c.slug AS company_slug, c.status AS company_status,
  se.signal_type, se.title, se.factual_claim, se.source_excerpt, se.opportunity_note, se.event_date, se.discovered_at,
  se.last_verified_at, se.status, se.rejected_reason, se.is_sample
  FROM signal_events se JOIN companies c ON c.id = se.company_id`;

async function withSources(db: D1Database, rows: SignalRow[], now: Date): Promise<Signal[]> {
  if (rows.length === 0) return [];
  const { results } = await db
    .prepare(
      `SELECT ss.signal_id, ss.role, s.url, s.title, s.kind, s.published_at FROM signal_sources ss
       JOIN sources s ON s.id = ss.source_id WHERE ss.signal_id IN (${rows.map(() => "?").join(",")})`,
    )
    .bind(...rows.map((r) => r.id))
    .all<{ signal_id: string; role: string; url: string; title: string; kind: string; published_at: string | null }>();
  return rows.map((r) => {
    const mine = results.filter((s) => s.signal_id === r.id);
    const strip = ({ url, title, kind, published_at }: (typeof mine)[number]) => ({ url, title, kind, published_at });
    const primary = mine.find((s) => s.role === "primary");
    return {
      ...r,
      is_sample: r.is_sample === 1,
      effective_status: effectiveSignalStatus(r, now),
      primary_source: primary ? strip(primary) : null,
      corroborating_sources: mine.filter((s) => s.role === "corroborating").map(strip),
    };
  });
}

export async function getSignal(db: D1Database, id: string, now = new Date()): Promise<Signal | null> {
  const row = await db.prepare(`${SIGNAL_SELECT} WHERE se.id = ?`).bind(id).first<SignalRow>();
  return row ? ((await withSources(db, [row], now))[0] ?? null) : null;
}

export interface SignalFilter {
  companyId?: string;
  type?: SignalType;
  status?: ReviewStatus;
  category?: string;
  /** Only what public Discover may show: verified signals of verified companies. */
  publicOnly?: boolean;
  limit?: number;
  offset?: number;
}

/** Newest first, by event date (or discovery date when the event date is unknown). */
export async function listSignals(db: D1Database, filter: SignalFilter = {}, now = new Date()): Promise<Signal[]> {
  const where: string[] = [];
  const args: unknown[] = [];
  if (filter.publicOnly) where.push("se.status = 'verified' AND c.status = 'verified'");
  if (filter.status) {
    where.push("se.status = ?");
    args.push(filter.status);
  }
  if (filter.companyId) {
    where.push("se.company_id = ?");
    args.push(filter.companyId);
  }
  if (filter.type) {
    where.push("se.signal_type = ?");
    args.push(filter.type);
  }
  if (filter.category) {
    where.push(
      "se.company_id IN (SELECT cc.company_id FROM company_categories cc JOIN categories cat ON cat.id = cc.category_id WHERE cat.slug = ?)",
    );
    args.push(filter.category);
  }
  const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200);
  const offset = Math.max(filter.offset ?? 0, 0);
  const { results } = await db
    .prepare(
      `${SIGNAL_SELECT} ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
       ORDER BY COALESCE(se.event_date, substr(se.discovered_at, 1, 10)) DESC, se.discovered_at DESC LIMIT ? OFFSET ?`,
    )
    .bind(...args, limit, offset)
    .all<SignalRow>();
  return withSources(db, results, now);
}
