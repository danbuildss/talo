/**
 * Import a talo.registry.v1 file. Everything is added as needs_review.
 *   npm run registry:import -- file.json            (check, then import)
 *   npm run registry:import -- file.json --dry-run  (check only)
 */
import { readFileSync } from "node:fs";
import { taloFetch } from "./talo-api.ts";

const [file, ...flags] = process.argv.slice(2);
if (!file) {
  console.error("usage: npm run registry:import -- <file.json> [--dry-run]");
  process.exit(2);
}
const dryRun = flags.includes("--dry-run");
const res = await taloFetch(`/api/admin/import${dryRun ? "?dry_run=1" : ""}`, {
  method: "POST",
  body: readFileSync(file, "utf8"),
});
const json = (await res.json()) as {
  companies_added?: number;
  signals_added?: number;
  error?: { message: string; details?: unknown };
};
if (!res.ok) {
  console.error(`Not imported: ${json.error?.message ?? res.status}`);
  for (const p of (json.error?.details as { path: string; message: string }[] | undefined) ?? []) {
    console.error(`  ✗ ${p.path}: ${p.message}`);
  }
  process.exit(1);
}
console.log(
  dryRun
    ? "Check passed: nothing was saved (dry run)."
    : `Imported ${json.companies_added} companies and ${json.signals_added} signals, all as needs_review.`,
);
