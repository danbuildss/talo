/**
 * Data quality report (docs/DATA-ENGINE.md §7). Each check has a standard; the
 * report passes only when every "must be zero" check is zero.
 */
import { findNearDuplicates, type NearDuplicate } from "../../shared/registry.ts";
import { effectiveSignalStatus, type ReviewStatus, type SignalType } from "../../shared/signals.ts";

export interface AuditCheck {
  id: string;
  label: string;
  count: number;
  /** "must_be_zero" checks fail the audit; "info" checks are reported only. */
  standard: "must_be_zero" | "info";
  examples: string[];
}

export interface AuditReport {
  ok: boolean;
  generated_at: string;
  totals: { companies: Record<string, number>; signals: Record<string, number> };
  checks: AuditCheck[];
  near_duplicates: NearDuplicate[];
}

async function ids(db: D1Database, sql: string): Promise<string[]> {
  const { results } = await db.prepare(sql).all<{ id: string }>();
  return results.map((r) => r.id);
}

function check(id: string, label: string, standard: AuditCheck["standard"], found: string[]): AuditCheck {
  return { id, label, standard, count: found.length, examples: found.slice(0, 10) };
}

export async function auditData(db: D1Database, now = new Date()): Promise<AuditReport> {
  const publishedNoPrimary = await ids(
    db,
    `SELECT se.id FROM signal_events se WHERE se.status = 'verified'
     AND NOT EXISTS (SELECT 1 FROM signal_sources ss WHERE ss.signal_id = se.id AND ss.role = 'primary')`,
  );
  const verifiedSignalsNoReview = await ids(
    db,
    `SELECT se.id FROM signal_events se WHERE se.status = 'verified' AND NOT EXISTS (
       SELECT 1 FROM verification_reviews vr WHERE vr.subject_type = 'signal' AND vr.subject_id = se.id
       AND vr.action = 'verify' AND vr.checked_url IS NOT NULL)`,
  );
  const verifiedCompaniesNoReview = await ids(
    db,
    `SELECT c.id FROM companies c WHERE c.status = 'verified' AND NOT EXISTS (
       SELECT 1 FROM verification_reviews vr WHERE vr.subject_type = 'company' AND vr.subject_id = c.id
       AND vr.action = 'verify' AND vr.checked_url IS NOT NULL)`,
  );
  const verifiedSignalsOnUnverifiedCompany = await ids(
    db,
    `SELECT se.id FROM signal_events se JOIN companies c ON c.id = se.company_id
     WHERE se.status = 'verified' AND c.status != 'verified'`,
  );
  const signalsMissingExcerpt = await ids(
    db,
    `SELECT id FROM signal_events WHERE status = 'verified' AND (TRIM(source_excerpt) = '' OR TRIM(factual_claim) = '')`,
  );

  const { results: verified } = await db
    .prepare("SELECT id, signal_type, status, last_verified_at FROM signal_events WHERE status = 'verified'")
    .all<{ id: string; signal_type: SignalType; status: ReviewStatus; last_verified_at: string | null }>();
  const stale = verified.filter((s) => effectiveSignalStatus(s, now) === "stale").map((s) => s.id);

  const backlogSignals = await ids(db, "SELECT id FROM signal_events WHERE status = 'needs_review'");
  const backlogCompanies = await ids(db, "SELECT id FROM companies WHERE status = 'needs_review'");

  const { results: companies } = await db
    .prepare("SELECT id, name, primary_domain FROM companies WHERE status != 'rejected'")
    .all<{ id: string; name: string; primary_domain: string }>();
  const nearDuplicates = findNearDuplicates(companies);

  const count = async (table: string) => {
    const { results } = await db
      .prepare(`SELECT status, COUNT(*) AS n FROM ${table} GROUP BY status`)
      .all<{ status: string; n: number }>();
    return Object.fromEntries(results.map((r) => [r.status, r.n]));
  };
  const signalTotals = await count("signal_events");
  if (stale.length) signalTotals.stale = stale.length;

  const checks: AuditCheck[] = [
    check(
      "published_without_primary_source",
      "Verified signals without a primary source",
      "must_be_zero",
      publishedNoPrimary,
    ),
    check(
      "verified_signal_without_review",
      "Verified signals without a recorded verification",
      "must_be_zero",
      verifiedSignalsNoReview,
    ),
    check(
      "verified_company_without_review",
      "Verified companies without a recorded verification",
      "must_be_zero",
      verifiedCompaniesNoReview,
    ),
    check(
      "verified_signal_missing_claim_or_excerpt",
      "Verified signals missing the claim or source excerpt",
      "must_be_zero",
      signalsMissingExcerpt,
    ),
    check(
      "verified_signal_on_unverified_company",
      "Verified signals whose company isn't verified (hidden from Discover)",
      "info",
      verifiedSignalsOnUnverifiedCompany,
    ),
    check("stale_signals", "Signals past their freshness window (shown with their last-verified date)", "info", stale),
    check("signals_awaiting_review", "Signals waiting for review", "info", backlogSignals),
    check("companies_awaiting_review", "Companies waiting for review", "info", backlogCompanies),
    check(
      "possible_duplicate_companies",
      "Possible duplicate companies to check",
      "info",
      nearDuplicates.map((d) => `${d.a} / ${d.b}`),
    ),
  ];

  return {
    ok: checks.every((c) => c.standard !== "must_be_zero" || c.count === 0),
    generated_at: now.toISOString(),
    totals: { companies: await count("companies"), signals: signalTotals },
    checks,
    near_duplicates: nearDuplicates,
  };
}
