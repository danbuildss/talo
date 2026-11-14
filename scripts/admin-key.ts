/**
 * Make a new admin key (Option B login). Prints it once; it is not stored anywhere.
 *   npm run admin:key
 * Put it in Cloudflare as the Secret ADMIN_TOKEN, and on your computer as TALO_ADMIN_TOKEN.
 * Never paste it in chat or commit it.
 */
import { randomBytes } from "node:crypto";

const key = randomBytes(36).toString("base64url"); // 48 characters
console.log("\nYour new admin key (shown once; copy it now):\n");
console.log(`  ${key}\n`);
console.log("1. Cloudflare: Workers & Pages → rightroom → Settings → Variables and Secrets → add Secret ADMIN_TOKEN.");
console.log("2. Your computer: export TALO_ADMIN_TOKEN=<the key> before running npm run registry:import etc.");
console.log("Never paste it in chat or commit it.\n");
