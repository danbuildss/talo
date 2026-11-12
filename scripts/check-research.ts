/**
 * Check a research file and print what Talo makes of it.
 *
 *   npm run check:research -- path/to/file.json [more files...]
 *
 * Works for all three formats (talo.company.v1, talo.candidates.v1, talo.outreach.v1).
 * For candidate files it prints each candidate's fit score, confidence and status,
 * calculated by shared/scoring.ts. Exit code 1 if any file is invalid.
 */
import { readFileSync } from "node:fs";
import type { z } from "zod";
import { companyProfileSchema } from "../shared/company.ts";
import { outreachFileSchema } from "../shared/outreach.ts";
import { evaluate } from "../shared/scoring.ts";
import { validateCandidateFile } from "../shared/validate.ts";

export interface Report {
  ok: boolean;
  lines: string[];
}

function issuesToLines(error: z.ZodError): string[] {
  return error.issues.map((i) => {
    const path = i.path
      .map((p, n) => (typeof p === "number" ? `[${p}]` : n === 0 ? String(p) : `.${String(p)}`))
      .join("");
    return `  ✗ ${path || "(file)"}: ${i.message}`;
  });
}

const STATUS_LABEL = { ready: "ready", needs_verification: "Needs verification" } as const;

export function checkResearch(input: unknown, now: Date = new Date()): Report {
  const format = typeof input === "object" && input !== null ? (input as { format?: unknown }).format : undefined;

  if (format === "talo.company.v1") {
    const parsed = companyProfileSchema.safeParse(input);
    if (!parsed.success) return { ok: false, lines: ["Company profile: invalid", ...issuesToLines(parsed.error)] };
    const p = parsed.data;
    const inferred = p.claims.filter((c) => c.claim_type === "inference").length;
    return {
      ok: true,
      lines: [
        `Company profile: ${p.company_name} (${p.domain})`,
        `  ${p.claims.length} claims (${p.claims.length - inferred} verified, ${inferred} inference)`,
        `  ${p.open_questions.length} open questions to confirm`,
      ],
    };
  }

  if (format === "talo.outreach.v1") {
    const parsed = outreachFileSchema.safeParse(input);
    if (!parsed.success) return { ok: false, lines: ["Outreach drafts: invalid", ...issuesToLines(parsed.error)] };
    return {
      ok: true,
      lines: [
        `Outreach drafts: ${parsed.data.drafts.length} drafts, all awaiting approval`,
        ...parsed.data.drafts.map(
          (d) => `  • ${d.candidate_domain} · ${d.channel} · ${d.purpose} · ${d.message.length} chars`,
        ),
      ],
    };
  }

  if (format === "talo.candidates.v1") {
    const result = validateCandidateFile(input);
    if (!result.ok) {
      return { ok: false, lines: ["Candidates: invalid", ...result.errors.map((e) => `  ✗ ${e.path}: ${e.message}`)] };
    }
    const lines = [`Candidates: ${result.candidates.length}`];
    const rows = result.candidates
      .map((c) => ({ c, e: evaluate(c, now) }))
      .sort((a, b) => (b.e.overall_score ?? -1) - (a.e.overall_score ?? -1));
    for (const { c, e } of rows) {
      const score = (e.overall_score === null ? "—" : String(e.overall_score)).padStart(3);
      lines.push(
        `  ${score}  ${c.company_name} (${c.domain}) · ${c.pipeline_stage} · evidence ${e.evidence_confidence} · ${STATUS_LABEL[e.verification_status]}`,
      );
      for (const issue of e.issues) lines.push(`         - ${issue}`);
    }
    for (const d of result.duplicates) {
      lines.push(`  ! duplicate domain ${d.domain} at positions ${d.indexes.join(", ")}`);
    }
    return { ok: true, lines };
  }

  return {
    ok: false,
    lines: ['Unknown file: "format" must be talo.company.v1, talo.candidates.v1 or talo.outreach.v1'],
  };
}

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  const files = process.argv.slice(2);
  if (files.length === 0) {
    console.error("usage: npm run check:research -- <file.json> [...]");
    process.exit(2);
  }
  let allOk = true;
  for (const file of files) {
    let report: Report;
    try {
      report = checkResearch(JSON.parse(readFileSync(file, "utf8")));
    } catch (err) {
      report = { ok: false, lines: [`Could not read ${file}: ${(err as Error).message}`] };
    }
    console.log(`\n${file}`);
    for (const line of report.lines) console.log(line);
    allOk &&= report.ok;
  }
  process.exit(allOk ? 0 : 1);
}
