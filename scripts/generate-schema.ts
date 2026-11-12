/**
 * Writes schemas/candidate-file.schema.json from the Zod schema in shared/candidate.ts,
 * so research tools (and the Claude skills) can check their output against one file.
 * Run: npm run schema. A test fails if the committed file is out of date.
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildSchemaJson } from "./schema-json.ts";

const out = fileURLToPath(new URL("../schemas/candidate-file.schema.json", import.meta.url));
writeFileSync(out, buildSchemaJson());
console.log(`wrote ${out}`);
