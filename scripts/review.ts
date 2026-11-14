/**
 * Review the queue from the terminal: one company or signal at a time, with its
 * source opened in your browser.
 *   npm run review              (opens each source in your browser)
 *   npm run review -- --no-open (doesn't open links)
 * Needs TALO_URL and TALO_ADMIN_TOKEN (see docs/DEPLOY.md).
 */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { runReview } from "./review-lib.ts";
import { TALO_URL, taloFetch } from "./talo-api.ts";

if (!process.env.TALO_ADMIN_TOKEN && !TALO_URL.includes("localhost")) {
  console.error("Set your admin key first: read -s TALO_ADMIN_TOKEN && export TALO_ADMIN_TOKEN");
  process.exit(2);
}

// Lines are queued as they arrive, so nothing typed or pasted ahead of a question is lost.
// End of input (Ctrl-D) counts as quitting.
const rl = createInterface({ input: process.stdin, terminal: false });
const lines: string[] = [];
const waiting: ((line: string | null) => void)[] = [];
let closed = false;
rl.on("line", (line) => {
  const next = waiting.shift();
  if (next) next(line);
  else lines.push(line);
});
rl.on("close", () => {
  closed = true;
  for (const next of waiting.splice(0)) next(null);
});
function nextLine(): Promise<string | null> {
  const queued = lines.shift();
  if (queued !== undefined) return Promise.resolve(queued);
  if (closed) return Promise.resolve(null);
  return new Promise((resolve) => waiting.push(resolve));
}
const openCommand = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";

console.log(`Reviewing ${TALO_URL}. Nothing is approved unless you press a.`);
const summary = await runReview(
  {
    async api(method, path, body) {
      const res = await taloFetch(`/api/admin${path}`, {
        method,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { ok: res.ok, status: res.status, body: await res.json().catch(() => null) };
    },
    async ask(question) {
      process.stdout.write(question);
      const line = await nextLine();
      if (line === null) {
        process.stdout.write("\n");
        return "q";
      }
      if (!process.stdin.isTTY) process.stdout.write(`${line}\n`);
      return line.trim();
    },
    open(url) {
      // Only http(s) links from the API, passed as one argument (no shell).
      if (/^https?:\/\//.test(url)) spawn(openCommand, [url], { stdio: "ignore", detached: true }).unref();
    },
    print(line = "") {
      console.log(line);
    },
  },
  { openLinks: !process.argv.includes("--no-open") },
);
rl.close();
console.log(
  `\nThis session: ${summary.approved} approved, ${summary.rejected} rejected, ${summary.skipped} skipped` +
    `${summary.failed ? `, ${summary.failed} not completed` : ""}.`,
);
