/**
 * Check a research file before it goes anywhere: clear, row-level errors,
 * and duplicate domains flagged.
 */
import { type Candidate, candidateFileSchema } from "./candidate.ts";

export interface ValidationError {
  /** Where the problem is, e.g. "candidates[2].sources[0].url". */
  path: string;
  message: string;
}

export interface DuplicateGroup {
  domain: string;
  /** Positions in the file (0-based) that share this domain. */
  indexes: number[];
}

export type ValidationResult =
  | { ok: true; candidates: Candidate[]; duplicates: DuplicateGroup[] }
  | { ok: false; errors: ValidationError[] };

function formatPath(path: readonly PropertyKey[]): string {
  let out = "";
  for (const part of path) {
    if (typeof part === "number") out += `[${part}]`;
    else out += out === "" ? String(part) : `.${String(part)}`;
  }
  return out === "" ? "(file)" : out;
}

/** Groups candidates that share a normalized domain. */
export function findDuplicates(candidates: Pick<Candidate, "domain">[]): DuplicateGroup[] {
  const byDomain = new Map<string, number[]>();
  candidates.forEach((c, index) => {
    const list = byDomain.get(c.domain) ?? [];
    list.push(index);
    byDomain.set(c.domain, list);
  });
  return [...byDomain.entries()]
    .filter(([, indexes]) => indexes.length > 1)
    .map(([domain, indexes]) => ({ domain, indexes }));
}

/**
 * Validates a parsed research file (the result of JSON.parse).
 * All-or-nothing: any error means nothing in the file is accepted.
 */
export function validateCandidateFile(input: unknown): ValidationResult {
  const parsed = candidateFileSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((issue) => {
        let message = issue.message;
        if (issue.code === "unrecognized_keys") {
          const computed = issue.keys.filter((k) =>
            ["overall_score", "evidence_confidence", "verification_status"].includes(k),
          );
          message =
            computed.length > 0
              ? `${computed.join(", ")} can't be supplied: Talo calculates it from the factor scores and sources`
              : `unknown field(s): ${issue.keys.join(", ")}`;
        }
        return { path: formatPath(issue.path), message };
      }),
    };
  }
  const { candidates } = parsed.data;
  return { ok: true, candidates, duplicates: findDuplicates(candidates) };
}
