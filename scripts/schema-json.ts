import { z } from "zod";
import { candidateFileSchema } from "../shared/candidate.ts";

export function buildSchemaJson(): string {
  const schema = z.toJSONSchema(candidateFileSchema, { io: "input", unrepresentable: "any" });
  const withMeta = {
    $id: "https://github.com/danbuildss/talo/schemas/candidate-file.schema.json",
    title: "Talo research file (talo.candidates.v1)",
    description:
      "Candidates produced by Talo research. overall_score, evidence_confidence and verification_status are calculated by Talo and must not be included.",
    ...schema,
  };
  return `${JSON.stringify(withMeta, null, 2)}\n`;
}
