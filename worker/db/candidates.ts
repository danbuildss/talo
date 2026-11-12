/**
 * Candidate storage. Every function takes a workspaceId and every query filters
 * by it, so one workspace can never read or change another's data.
 */
import type { Candidate, Scores, Source } from "../../shared/candidate.ts";
import { type Evaluation, evaluate } from "../../shared/scoring.ts";
import { ConflictError, fromJson, newId, nowIso } from "./util.ts";

export interface StoredCandidate extends Omit<Candidate, "scores" | "sources"> {
  candidate_id: string;
  workspace_id: string;
  sources: Source[];
  scores: Scores;
  evaluation: Pick<Evaluation, "overall_score" | "evidence_confidence" | "verification_status">;
  evaluated_at: string;
  created_at: string;
  updated_at: string;
}

interface CandidateRow {
  id: string;
  workspace_id: string;
  company_name: string;
  domain: string;
  industry: string;
  partnership_type: Candidate["partnership_type"];
  pipeline_stage: Candidate["pipeline_stage"];
  evidence_summary: string;
  mutual_benefits_json: string;
  proposed_collaboration: string | null;
  risks_json: string;
  recommended_next_action: string;
  research_timestamp: string;
  is_sample: number;
  created_at: string;
  updated_at: string;
}

interface SourceRow {
  candidate_id: string;
  url: string;
  title: string;
  published_at: string | null;
  accessed_at: string;
  summary: string;
  claim_type: Source["claim_type"];
  supports_json: string;
}

interface EvaluationRow {
  candidate_id: string;
  scores_json: string;
  overall_score: number | null;
  evidence_confidence: Evaluation["evidence_confidence"];
  verification_status: Evaluation["verification_status"];
  evaluated_at: string;
}

/** Statements that store one validated candidate with its sources, evaluation and an "imported" event. */
export function insertCandidateStatements(
  db: D1Database,
  workspaceId: string,
  candidate: Candidate,
  createdBy: string,
  now = new Date(),
): { id: string; statements: D1PreparedStatement[] } {
  const id = candidate.candidate_id ?? newId();
  const at = nowIso(now);
  const e = evaluate(candidate, now);
  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        `INSERT INTO partner_candidates (id, workspace_id, company_name, domain, industry, partnership_type, pipeline_stage,
          evidence_summary, mutual_benefits_json, proposed_collaboration, risks_json, recommended_next_action,
          research_timestamp, is_sample, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        id,
        workspaceId,
        candidate.company_name,
        candidate.domain,
        candidate.industry,
        candidate.partnership_type,
        candidate.pipeline_stage,
        candidate.evidence_summary,
        JSON.stringify(candidate.mutual_benefits),
        candidate.proposed_collaboration ?? null,
        JSON.stringify(candidate.risks),
        candidate.recommended_next_action,
        candidate.research_timestamp,
        candidate.is_sample ? 1 : 0,
        at,
        at,
      ),
    ...candidate.sources.map((s, position) =>
      db
        .prepare(
          `INSERT INTO evidence_sources (id, workspace_id, candidate_id, position, url, title, published_at, accessed_at,
            summary, claim_type, supports_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          newId(),
          workspaceId,
          id,
          position,
          s.url,
          s.title,
          s.published_at,
          s.accessed_at,
          s.summary,
          s.claim_type,
          JSON.stringify(s.supports),
        ),
    ),
    db
      .prepare(
        `INSERT INTO evaluations (id, workspace_id, candidate_id, scores_json, overall_score, evidence_confidence,
          verification_status, evaluated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        newId(),
        workspaceId,
        id,
        JSON.stringify(candidate.scores),
        e.overall_score,
        e.evidence_confidence,
        e.verification_status,
        at,
      ),
    db
      .prepare(
        `INSERT INTO pipeline_events (id, workspace_id, candidate_id, event_type, to_stage, created_by, created_at)
         VALUES (?, ?, ?, 'imported', ?, ?, ?)`,
      )
      .bind(newId(), workspaceId, id, candidate.pipeline_stage, createdBy, at),
  ];
  return { id, statements };
}

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Error && /UNIQUE constraint failed/i.test(err.message);
}

/** Store one candidate atomically. Throws ConflictError if the domain already exists in this workspace. */
export async function insertCandidate(
  db: D1Database,
  workspaceId: string,
  candidate: Candidate,
  createdBy: string,
  now = new Date(),
): Promise<string> {
  const { id, statements } = insertCandidateStatements(db, workspaceId, candidate, createdBy, now);
  try {
    await db.batch(statements);
  } catch (err) {
    if (isUniqueViolation(err)) throw new ConflictError(`${candidate.domain} is already in this workspace`);
    throw err;
  }
  return id;
}

function assemble(row: CandidateRow, sources: SourceRow[], ev: EvaluationRow | undefined): StoredCandidate {
  return {
    candidate_id: row.id,
    workspace_id: row.workspace_id,
    company_name: row.company_name,
    domain: row.domain,
    industry: row.industry,
    partnership_type: row.partnership_type,
    pipeline_stage: row.pipeline_stage,
    evidence_summary: row.evidence_summary,
    mutual_benefits: fromJson(row.mutual_benefits_json) as Candidate["mutual_benefits"],
    proposed_collaboration: row.proposed_collaboration ?? undefined,
    risks: fromJson<string[]>(row.risks_json) ?? [],
    recommended_next_action: row.recommended_next_action,
    research_timestamp: row.research_timestamp,
    is_sample: row.is_sample === 1,
    sources: sources.map((s) => ({
      url: s.url,
      title: s.title,
      published_at: s.published_at,
      accessed_at: s.accessed_at,
      summary: s.summary,
      claim_type: s.claim_type,
      supports: fromJson<Source["supports"]>(s.supports_json) ?? [],
    })),
    scores: (ev ? fromJson<Scores>(ev.scores_json) : null) ?? {},
    evaluation: {
      overall_score: ev?.overall_score ?? null,
      evidence_confidence: ev?.evidence_confidence ?? "low",
      verification_status: ev?.verification_status ?? "needs_verification",
    },
    evaluated_at: ev?.evaluated_at ?? row.created_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

const LATEST_EVALUATIONS = `SELECT e.* FROM evaluations e
  WHERE e.workspace_id = ?1 AND e.evaluated_at = (
    SELECT MAX(e2.evaluated_at) FROM evaluations e2 WHERE e2.workspace_id = ?1 AND e2.candidate_id = e.candidate_id)`;

export async function listCandidates(db: D1Database, workspaceId: string): Promise<StoredCandidate[]> {
  const [cands, sources, evals] = await db.batch([
    db.prepare("SELECT * FROM partner_candidates WHERE workspace_id = ? ORDER BY company_name").bind(workspaceId),
    db
      .prepare("SELECT * FROM evidence_sources WHERE workspace_id = ? ORDER BY candidate_id, position")
      .bind(workspaceId),
    db.prepare(LATEST_EVALUATIONS).bind(workspaceId),
  ]);
  const byCandidate = new Map<string, SourceRow[]>();
  for (const s of (sources?.results ?? []) as SourceRow[]) {
    const list = byCandidate.get(s.candidate_id) ?? [];
    list.push(s);
    byCandidate.set(s.candidate_id, list);
  }
  const evalBy = new Map(((evals?.results ?? []) as EvaluationRow[]).map((e) => [e.candidate_id, e]));
  return ((cands?.results ?? []) as CandidateRow[]).map((r) =>
    assemble(r, byCandidate.get(r.id) ?? [], evalBy.get(r.id)),
  );
}

export async function getCandidate(db: D1Database, workspaceId: string, id: string): Promise<StoredCandidate | null> {
  const [cand, sources, evals] = await db.batch([
    db.prepare("SELECT * FROM partner_candidates WHERE workspace_id = ? AND id = ?").bind(workspaceId, id),
    db
      .prepare("SELECT * FROM evidence_sources WHERE workspace_id = ? AND candidate_id = ? ORDER BY position")
      .bind(workspaceId, id),
    db
      .prepare(
        "SELECT * FROM evaluations WHERE workspace_id = ? AND candidate_id = ? ORDER BY evaluated_at DESC LIMIT 1",
      )
      .bind(workspaceId, id),
  ]);
  const row = (cand?.results ?? [])[0] as CandidateRow | undefined;
  if (!row) return null;
  return assemble(row, (sources?.results ?? []) as SourceRow[], (evals?.results ?? [])[0] as EvaluationRow | undefined);
}
