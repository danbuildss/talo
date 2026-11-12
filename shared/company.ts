/**
 * The client company profile produced by the Company Intelligence skill (talo.company.v1).
 * Every factual claim carries a source; inferences are labelled; unknowns become open questions.
 */
import { z } from "zod";
import { CLAIM_TYPES, domainSchema, httpUrl, PARTNERSHIP_TYPES } from "./candidate.ts";

const text = (field: string, max = 2000) =>
  z
    .string({ error: `${field} is required` })
    .trim()
    .min(1, { error: `${field} can't be empty` })
    .max(max, { error: `${field} is too long (max ${max} characters)` });

const list = (field: string, max = 30, itemMax = 300) => z.array(text(field, itemMax)).max(max).default([]);

export const claimSchema = z.strictObject({
  statement: text("statement", 500),
  claim_type: z.enum(CLAIM_TYPES, { error: 'claim_type must be "verified" or "inference"' }),
  url: httpUrl,
  accessed_at: z.iso.date({ error: "must be a date like 2026-11-12" }),
});
export type Claim = z.infer<typeof claimSchema>;

const namedCompany = z.strictObject({
  name: text("name", 200),
  domain: domainSchema.optional(),
  source_url: httpUrl.optional(),
});

export const companyProfileSchema = z.strictObject({
  format: z.literal("talo.company.v1", { error: 'format must be "talo.company.v1"' }),
  company_name: text("company_name", 200),
  domain: domainSchema,
  one_liner: text("one_liner", 300),
  summary: text("summary"),
  sector: text("sector", 200),
  stage: text("stage", 200).optional(),
  target_users: list("target_user"),
  capabilities: list("capability"),
  existing_partners: z.array(namedCompany).max(100).default([]),
  competitors: z.array(namedCompany).max(50).default([]),
  partnership_goals: z
    .array(z.enum(PARTNERSHIP_TYPES, { error: `partnership_goals must use: ${PARTNERSHIP_TYPES.join(", ")}` }))
    .max(5)
    .default([]),
  partner_types_wanted: list("partner_type_wanted"),
  partner_types_excluded: list("partner_type_excluded"),
  geographies: list("geography"),
  strengths: list("strength"),
  limitations: list("limitation"),
  claims: z.array(claimSchema).min(1, { error: "a profile needs at least one sourced claim" }).max(100),
  open_questions: list("open_question", 30, 500),
  researched_at: z.iso.datetime({ offset: true, error: "must be a date-time like 2026-11-12T18:00:00Z" }),
  is_sample: z.boolean().default(false),
});
export type CompanyProfile = z.infer<typeof companyProfileSchema>;
