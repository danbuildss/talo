import { z } from "zod";
import { candidateFileSchema } from "../shared/candidate.ts";
import { companyProfileSchema } from "../shared/company.ts";
import { outreachFileSchema } from "../shared/outreach.ts";

const BASE = "https://github.com/danbuildss/talo/schemas";

const SCHEMAS = {
  "candidate-file.schema.json": {
    schema: candidateFileSchema,
    title: "Talo research file (talo.candidates.v1)",
    description:
      "Candidates produced by the Partnership Scout and Partnership Strategist skills. overall_score, evidence_confidence and verification_status are calculated by Talo and must not be included.",
  },
  "company-profile.schema.json": {
    schema: companyProfileSchema,
    title: "Talo company profile (talo.company.v1)",
    description: "The client profile produced by the Company Intelligence skill. Every claim carries a source.",
  },
  "outreach-file.schema.json": {
    schema: outreachFileSchema,
    title: "Talo outreach drafts (talo.outreach.v1)",
    description:
      "Drafts produced by the Outreach Specialist skill. Drafts only: approval_status is always draft; a person approves and sends.",
  },
} as const;

/** File name → JSON text, for every schema in schemas/. */
export function buildSchemas(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [file, { schema, title, description }] of Object.entries(SCHEMAS)) {
    const json = z.toJSONSchema(schema, { io: "input", unrepresentable: "any" });
    out[file] = `${JSON.stringify({ $id: `${BASE}/${file}`, title, description, ...json }, null, 2)}\n`;
  }
  return out;
}
