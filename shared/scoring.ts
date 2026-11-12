/**
 * Fit scoring and evidence confidence. Deterministic: same input, same output.
 * The rules are written out in PLAN.md §5 and docs/RESEARCH-METHODOLOGY.md.
 */
import { type Candidate, FACTORS, type Factor, type Scores, type Source } from "./candidate.ts";

/** Weights in percent. They add up to 100. */
export const WEIGHTS: Readonly<Record<Factor, number>> = {
  alignment: 30,
  mutual_value: 25,
  readiness: 20,
  contact_access: 15,
  feasibility: 10,
};

export const FACTOR_LABELS: Readonly<Record<Factor, string>> = {
  alignment: "Product and audience alignment",
  mutual_value: "Mutual commercial value",
  readiness: "Partnership readiness",
  contact_access: "Contact accessibility",
  feasibility: "Execution feasibility",
};

/** Sources older than this can't count towards High confidence. */
export const FRESH_DAYS = 90;

export type Confidence = "high" | "medium" | "low";
export type VerificationStatus = "ready" | "needs_verification";

export interface FactorBreakdown {
  factor: Factor;
  label: string;
  weight: number;
  score: number | null;
  /** Points out of 100 this factor contributes; null when unscored. */
  points: number | null;
  reason: string | null;
  verified_sources: number;
}

export interface Evaluation {
  /** 0–100, or null when any factor is unscored. */
  overall_score: number | null;
  evidence_confidence: Confidence;
  verification_status: VerificationStatus;
  breakdown: FactorBreakdown[];
  /** Plain-language reasons the candidate needs verification (empty when ready). */
  issues: string[];
}

/**
 * overall = round( Σ score/5 × weight ), i.e. round( Σ score × weight / 5 ).
 * Returns null if any factor is missing.
 */
export function fitScore(scores: Scores): number | null {
  let total = 0;
  for (const factor of FACTORS) {
    const entry = scores[factor];
    if (!entry) return null;
    total += entry.score * WEIGHTS[factor];
  }
  return Math.round(total / 5);
}

function daysBetween(fromIsoDate: string, now: Date): number {
  const from = Date.parse(`${fromIsoDate}T00:00:00Z`);
  return Math.floor((now.getTime() - from) / 86_400_000);
}

function hostOf(url: string): string {
  return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
}

function verifiedFor(sources: Source[], factor: Factor): number {
  return sources.filter((s) => s.claim_type === "verified" && s.supports.includes(factor)).length;
}

/**
 * High: every factor is backed by at least one verified source, sources come from
 *       at least two different websites, and every source was accessed in the last 90 days.
 * Medium: every factor is scored, and verified sources back alignment and readiness.
 * Low: anything less.
 */
export function evidenceConfidence(candidate: Pick<Candidate, "sources" | "scores">, now: Date): Confidence {
  const { sources, scores } = candidate;
  const allScored = FACTORS.every((f) => scores[f] !== undefined);
  if (!allScored) return "low";

  const everyFactorVerified = FACTORS.every((f) => verifiedFor(sources, f) > 0);
  const distinctSites = new Set(sources.map((s) => hostOf(s.url))).size;
  const allFresh = sources.length > 0 && sources.every((s) => daysBetween(s.accessed_at, now) <= FRESH_DAYS);
  if (everyFactorVerified && distinctSites >= 2 && allFresh) return "high";

  if (verifiedFor(sources, "alignment") > 0 && verifiedFor(sources, "readiness") > 0) return "medium";
  return "low";
}

export function evaluate(candidate: Pick<Candidate, "sources" | "scores">, now: Date = new Date()): Evaluation {
  const { sources, scores } = candidate;
  const breakdown: FactorBreakdown[] = FACTORS.map((factor) => {
    const entry = scores[factor];
    return {
      factor,
      label: FACTOR_LABELS[factor],
      weight: WEIGHTS[factor],
      score: entry?.score ?? null,
      points: entry ? Math.round(((entry.score * WEIGHTS[factor]) / 5) * 10) / 10 : null,
      reason: entry?.reason ?? null,
      verified_sources: verifiedFor(sources, factor),
    };
  });

  const overall_score = fitScore(scores);
  const evidence_confidence = evidenceConfidence(candidate, now);

  const issues: string[] = [];
  for (const row of breakdown) {
    if (row.score === null) issues.push(`${row.label} has no score yet`);
  }
  if (sources.length === 0) issues.push("No sources yet");
  if (evidence_confidence === "low" && overall_score !== null) {
    for (const factor of ["alignment", "readiness"] as const) {
      if (verifiedFor(sources, factor) === 0) {
        issues.push(`${FACTOR_LABELS[factor]} has no verified source`);
      }
    }
  }

  const verification_status: VerificationStatus =
    overall_score === null || evidence_confidence === "low" ? "needs_verification" : "ready";

  return { overall_score, evidence_confidence, verification_status, breakdown, issues };
}
