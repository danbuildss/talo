/**
 * Print Talo's data quality report. Exit code 1 if any must-be-zero check fails.
 *   npm run data:audit
 */
import { TALO_URL, taloFetch } from "./talo-api.ts";

/** The shape returned by GET /api/admin/audit (worker/db/audit.ts). */
interface AuditReport {
  ok: boolean;
  generated_at: string;
  totals: { companies: Record<string, number>; signals: Record<string, number> };
  checks: { label: string; count: number; standard: "must_be_zero" | "info"; examples: string[] }[];
  near_duplicates: { a: string; b: string; reason: string }[];
}

const res = await taloFetch("/api/admin/audit");
if (!res.ok) {
  console.error(`Audit request failed: ${res.status} ${await res.text()}`);
  process.exit(2);
}
const report = (await res.json()) as AuditReport;
console.log(`Talo data audit · ${TALO_URL} · ${report.generated_at}`);
console.log(
  `Companies: ${JSON.stringify(report.totals.companies)}  Signals: ${JSON.stringify(report.totals.signals)}\n`,
);
for (const c of report.checks) {
  const mark = c.standard === "info" ? "·" : c.count === 0 ? "✓" : "✗";
  console.log(
    `${mark} ${c.label}: ${c.count}${c.examples.length ? `  e.g. ${c.examples.slice(0, 3).join(", ")}` : ""}`,
  );
}
for (const d of report.near_duplicates) console.log(`  possible duplicate: ${d.a} / ${d.b} (${d.reason})`);
console.log(report.ok ? "\nAudit passed." : "\nAudit FAILED: fix the ✗ items.");
process.exit(report.ok ? 0 : 1);
