/**
 * The Talo candidate record: the one format that research produces,
 * the app imports, and exports write back out.
 *
 * Rules that matter (see docs/RESEARCH-METHODOLOGY.md):
 * - Every source has a real http(s) link and an access date.
 * - Each source is tagged "verified" (stated by the source) or "inference" (our reasoning).
 * - Each factor gets a 0–5 score with a reason. The overall score, evidence
 *   confidence and verification status are NEVER supplied by research: they are
 *   computed by code (shared/scoring.ts). Records that try to supply them are rejected.
 */
import { z } from "zod";

export const PARTNERSHIP_TYPES = ["integration", "distribution", "ecosystem", "channel", "creator"] as const;
export type PartnershipType = (typeof PARTNERSHIP_TYPES)[number];

export const PIPELINE_STAGES = [
  "discovered",
  "researched",
  "qualified",
  "outreach_prepared",
  "contacted",
  "replied",
  "in_discussion",
  "proposal",
  "partnered",
  "not_a_fit",
  "declined",
  "on_hold",
  "archived",
] as const;
export type PipelineStage = (typeof PIPELINE_STAGES)[number];

export const FACTORS = ["alignment", "mutual_value", "readiness", "contact_access", "feasibility"] as const;
export type Factor = (typeof FACTORS)[number];

export const CLAIM_TYPES = ["verified", "inference"] as const;
export type ClaimType = (typeof CLAIM_TYPES)[number];

/** A calendar date, YYYY-MM-DD. */
const isoDate = z.iso.date({ error: "must be a date like 2026-11-12" });

/** A date-time with timezone, e.g. 2026-11-12T18:00:00Z. */
const isoDateTime = z.iso.datetime({
  offset: true,
  error: "must be a date-time like 2026-11-12T18:00:00Z",
});

const text = (field: string, max = 2000) =>
  z
    .string({ error: `${field} is required` })
    .trim()
    .min(1, { error: `${field} can't be empty` })
    .max(max, { error: `${field} is too long (max ${max} characters)` });

/** Only http and https links are accepted: no javascript:, data:, file: etc. */
export const httpUrl = z
  .string({ error: "url is required" })
  .trim()
  .refine(
    (value) => {
      try {
        const url = new URL(value);
        return url.protocol === "https:" || url.protocol === "http:";
      } catch {
        return false;
      }
    },
    { error: "url must be a full http(s) link" },
  );

const HOSTNAME = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/**
 * Turn "https://www.Example.com/partners?x=1" into "example.com".
 * Returns null when the input isn't a usable domain.
 */
export function normalizeDomain(input: string): string | null {
  let value = input.trim().toLowerCase();
  if (value === "") return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//.test(value)) value = `https://${value}`;
  let host: string;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    host = url.hostname;
  } catch {
    return null;
  }
  host = host.replace(/\.$/, "").replace(/^www\./, "");
  return HOSTNAME.test(host) ? host : null;
}

export const domainSchema = z.string({ error: "domain is required" }).transform((value, ctx) => {
  const domain = normalizeDomain(value);
  if (domain === null) {
    ctx.addIssue({ code: "custom", message: "domain must be a website address like example.com" });
    return z.NEVER;
  }
  return domain;
});

export const sourceSchema = z.strictObject({
  url: httpUrl,
  title: text("title", 300),
  published_at: isoDate.nullable().default(null),
  accessed_at: isoDate,
  summary: text("summary"),
  claim_type: z.enum(CLAIM_TYPES, { error: 'claim_type must be "verified" or "inference"' }),
  supports: z.array(z.enum(FACTORS, { error: `supports must list factors from: ${FACTORS.join(", ")}` })).default([]),
});
export type Source = z.infer<typeof sourceSchema>;

export const factorScoreSchema = z.strictObject({
  score: z
    .number({ error: "score must be a number" })
    .int({ error: "score must be a whole number from 0 to 5" })
    .min(0, { error: "score must be 0–5" })
    .max(5, { error: "score must be 0–5" }),
  reason: text("reason", 500),
});
export type FactorScore = z.infer<typeof factorScoreSchema>;

/** Factors may be missing while research is in progress; the candidate then shows "Needs verification". */
export const scoresSchema = z.strictObject({
  alignment: factorScoreSchema.optional(),
  mutual_value: factorScoreSchema.optional(),
  readiness: factorScoreSchema.optional(),
  contact_access: factorScoreSchema.optional(),
  feasibility: factorScoreSchema.optional(),
});
export type Scores = z.infer<typeof scoresSchema>;

export const candidateSchema = z.strictObject({
  candidate_id: z.uuid({ error: "candidate_id must be a UUID" }).optional(),
  company_name: text("company_name", 200),
  domain: domainSchema,
  industry: text("industry", 200),
  partnership_type: z.enum(PARTNERSHIP_TYPES, {
    error: `partnership_type must be one of: ${PARTNERSHIP_TYPES.join(", ")}`,
  }),
  sources: z.array(sourceSchema).max(50, { error: "at most 50 sources per candidate" }),
  research_timestamp: isoDateTime,
  evidence_summary: text("evidence_summary"),
  scores: scoresSchema,
  mutual_benefits: z.strictObject({
    for_client: text("for_client"),
    for_partner: text("for_partner"),
  }),
  proposed_collaboration: text("proposed_collaboration").optional(),
  risks: z.array(text("risk", 500)).max(20).default([]),
  recommended_next_action: text("recommended_next_action", 500),
  pipeline_stage: z
    .enum(PIPELINE_STAGES, { error: `pipeline_stage must be one of: ${PIPELINE_STAGES.join(", ")}` })
    .default("discovered"),
  is_sample: z.boolean().default(false),
});
/** A candidate as written by research (before defaults are applied). */
export type CandidateInput = z.input<typeof candidateSchema>;
/** A validated candidate. */
export type Candidate = z.infer<typeof candidateSchema>;

/** A research file: one or more candidates. */
export const candidateFileSchema = z.strictObject({
  format: z.literal("talo.candidates.v1", { error: 'format must be "talo.candidates.v1"' }),
  candidates: z
    .array(candidateSchema)
    .min(1, { error: "the file has no candidates" })
    .max(500, { error: "at most 500 candidates per file" }),
});
export type CandidateFile = z.infer<typeof candidateFileSchema>;
