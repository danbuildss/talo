/**
 * Add the approved watched sources (seeds/watched-sources.json). Already-added ones are skipped.
 *   npm run sources:seed
 */
import { readFileSync } from "node:fs";
import { taloFetch } from "./talo-api.ts";

const { sources } = JSON.parse(readFileSync(new URL("../seeds/watched-sources.json", import.meta.url), "utf8")) as {
  sources: Record<string, unknown>[];
};
let added = 0;
let skipped = 0;
for (const s of sources) {
  const res = await taloFetch("/api/admin/watched-sources", { method: "POST", body: JSON.stringify(s) });
  if (res.status === 201) added += 1;
  else if (res.status === 409) skipped += 1;
  else {
    console.error(`✗ ${s.name}: ${res.status} ${await res.text()}`);
    process.exitCode = 1;
  }
}
console.log(`Watched sources: ${added} added, ${skipped} already there.`);
