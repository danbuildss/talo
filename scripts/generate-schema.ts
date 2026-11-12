/**
 * Writes the JSON Schema files in schemas/ from the Zod schemas in shared/,
 * so research tools (and the Claude skills) can check their output.
 * Run: npm run schema. A test fails if the committed files are out of date.
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildSchemas } from "./schema-json.ts";

for (const [file, text] of Object.entries(buildSchemas())) {
  const out = fileURLToPath(new URL(`../schemas/${file}`, import.meta.url));
  writeFileSync(out, text);
  console.log(`wrote schemas/${file}`);
}
