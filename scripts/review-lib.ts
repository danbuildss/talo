/**
 * The review loop behind `npm run review`, kept separate from the terminal so it can be
 * tested with simulated answers. It only calls the admin API; every rule (what counts as
 * verified, which page must be checked) is still enforced by the server.
 */

export const SUMMARY_PREFIX = "Search summary";

export interface QueueItem {
  subject_type: "company" | "signal";
  id: string;
  label: string;
  company_id: string;
  company_status: string;
  check_url: string | null;
}

export interface ApiResult {
  ok: boolean;
  status: number;
  body: unknown;
}

export interface ReviewIO {
  /** Call the admin API (path under /api/admin). */
  api(method: "GET" | "POST" | "PATCH", path: string, body?: unknown): Promise<ApiResult>;
  /** Ask the reviewer a question and return their answer (trimmed). */
  ask(question: string): Promise<string>;
  /** Open a link in the browser. */
  open(url: string): void;
  print(line?: string): void;
}

export interface ReviewSummary {
  approved: number;
  rejected: number;
  skipped: number;
  failed: number;
  remaining: number;
}

/** True when a signal's excerpt is still Claude's search summary, not the source's own words. */
export function needsExactExcerpt(excerpt: string | null | undefined): boolean {
  return !excerpt || excerpt.trim().startsWith(SUMMARY_PREFIX);
}

function errorMessage(r: ApiResult): string {
  const e = (r.body as { error?: { message?: string; details?: unknown } } | null)?.error;
  if (!e) return `HTTP ${r.status}`;
  const details = Array.isArray(e.details)
    ? ` (${(e.details as { path?: string; message?: string }[]).map((d) => `${d.path}: ${d.message}`).join("; ")})`
    : "";
  return `${e.message ?? `HTTP ${r.status}`}${details}`;
}

const wrap = (label: string, text: string | null | undefined) => (text ? `  ${label}: ${text}` : null);

async function showCompany(io: ReviewIO, id: string): Promise<{ domain: string } | null> {
  const r = await io.api("GET", `/companies/${id}`);
  if (!r.ok) {
    io.print(`  Couldn't load the company: ${errorMessage(r)}`);
    return null;
  }
  const { company } = r.body as {
    company: { name: string; primary_domain: string; description: string | null; categories: { label: string }[] };
  };
  for (const line of [
    `  COMPANY  ${company.name}`,
    wrap("Website", `https://${company.primary_domain}`),
    wrap("Description", company.description),
    wrap("Sectors", company.categories.map((c) => c.label).join(", ")),
    "  Check: is this the company's real website, and is the description right?",
  ]) {
    if (line) io.print(line);
  }
  return { domain: company.primary_domain };
}

interface SignalView {
  title: string;
  company_name: string;
  company_status: string;
  factual_claim: string;
  source_excerpt: string;
  opportunity_note: string | null;
  event_date: string | null;
  primary_source: { url: string } | null;
}

async function showSignal(io: ReviewIO, id: string): Promise<SignalView | null> {
  const r = await io.api("GET", `/signals/${id}`);
  if (!r.ok) {
    io.print(`  Couldn't load the signal: ${errorMessage(r)}`);
    return null;
  }
  const { signal } = r.body as { signal: SignalView };
  for (const line of [
    `  SIGNAL   ${signal.company_name}: ${signal.title}`,
    wrap("Date", signal.event_date),
    wrap("Claim", signal.factual_claim),
    wrap("Excerpt", signal.source_excerpt),
    wrap("Our view", signal.opportunity_note),
    wrap("Source", signal.primary_source?.url),
    "  Check: does the page say exactly what the claim says?",
  ]) {
    if (line) io.print(line);
  }
  if (signal.company_status !== "verified") {
    io.print("  Note: the company isn't verified yet; this signal stays hidden until it is.");
  }
  return signal;
}

async function reject(io: ReviewIO, item: QueueItem): Promise<boolean> {
  const reason = await io.ask("  Reason for rejecting (e.g. 'page doesn't say this', 'wrong company'): ");
  if (!reason) {
    io.print("  Not rejected: a reason is required.");
    return false;
  }
  const path = item.subject_type === "company" ? `/companies/${item.id}/review` : `/signals/${item.id}/review`;
  const r = await io.api("POST", path, { action: "reject", reason });
  io.print(r.ok ? "  ✗ Rejected." : `  Couldn't reject: ${errorMessage(r)}`);
  return r.ok;
}

/** Ask which page was checked; Enter means the default. Asks again once if the answer isn't a link. */
async function askCheckedPage(io: ReviewIO, question: string, fallback: string): Promise<string | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const answer = await io.ask(question);
    if (!answer) return fallback;
    if (/^https?:\/\//i.test(answer)) return answer;
    io.print("  That isn't a link. Press Enter to use the page shown, or paste a link starting with https://");
  }
  return null;
}

async function approveCompany(io: ReviewIO, item: QueueItem, domain: string): Promise<boolean> {
  const checked = await askCheckedPage(
    io,
    `  Which page did you check? Press Enter for https://${domain}, or paste the page you used: `,
    `https://${domain}`,
  );
  if (!checked) {
    io.print("  Not verified: no page given.");
    return false;
  }
  const r = await io.api("POST", `/companies/${item.id}/review`, { action: "verify", checked_url: checked });
  io.print(r.ok ? "  ✓ Verified." : `  Not verified: ${errorMessage(r)}`);
  return r.ok;
}

async function approveSignal(io: ReviewIO, item: QueueItem, signal: SignalView): Promise<boolean> {
  if (needsExactExcerpt(signal.source_excerpt)) {
    const exact = await io.ask("  Paste the exact sentence from the page that supports the claim: ");
    if (!exact || exact.startsWith(SUMMARY_PREFIX)) {
      io.print("  Not verified: the excerpt must be the page's own words.");
      return false;
    }
    const patched = await io.api("PATCH", `/signals/${item.id}`, { source_excerpt: exact });
    if (!patched.ok) {
      io.print(`  Couldn't save the excerpt: ${errorMessage(patched)}`);
      return false;
    }
  }
  const source = signal.primary_source?.url ?? "";
  const checked = await askCheckedPage(
    io,
    "  Which page did you check? Press Enter for the source above, or paste it: ",
    source,
  );
  if (!checked) {
    io.print("  Not verified: no page given.");
    return false;
  }
  const r = await io.api("POST", `/signals/${item.id}/review`, { action: "verify", checked_url: checked });
  io.print(r.ok ? "  ✓ Verified." : `  Not verified: ${errorMessage(r)}`);
  return r.ok;
}

/** Go through the review queue until it's empty or the reviewer quits. */
export async function runReview(io: ReviewIO, options: { openLinks?: boolean } = {}): Promise<ReviewSummary> {
  const summary: ReviewSummary = { approved: 0, rejected: 0, skipped: 0, failed: 0, remaining: 0 };
  const skipped = new Set<string>();

  for (;;) {
    const q = await io.api("GET", "/queue");
    if (!q.ok) {
      io.print(`Couldn't load the review queue: ${errorMessage(q)}`);
      summary.failed += 1;
      return summary;
    }
    const items = (q.body as { items: QueueItem[] }).items;
    const todo = items.filter((i) => !skipped.has(i.id));
    summary.remaining = items.length;
    const item = todo[0];
    if (!item) {
      io.print(
        items.length ? "Only skipped items are left. Run it again to see them." : "The review queue is empty. 🎉",
      );
      return summary;
    }

    io.print();
    io.print(`── ${items.length} waiting ─────────────────────────────`);
    const company = item.subject_type === "company" ? await showCompany(io, item.id) : null;
    const signal = item.subject_type === "signal" ? await showSignal(io, item.id) : null;
    if (!company && !signal) {
      skipped.add(item.id);
      summary.failed += 1;
      continue;
    }
    if (options.openLinks !== false && item.check_url) io.open(item.check_url);

    const choice = (await io.ask("  [a]pprove  [r]eject  [s]kip  [q]uit: ")).toLowerCase();
    if (choice === "q") {
      io.print("Stopped. Everything you did is saved; run `npm run review` to continue.");
      return summary;
    }
    if (choice === "s" || !["a", "r"].includes(choice)) {
      if (choice !== "s") io.print("  Didn't recognise that; skipping for now.");
      skipped.add(item.id);
      summary.skipped += 1;
      continue;
    }
    const done =
      choice === "r"
        ? await reject(io, item)
        : company
          ? await approveCompany(io, item, company.domain)
          : await approveSignal(io, item, signal as SignalView);
    if (done) {
      if (choice === "r") summary.rejected += 1;
      else summary.approved += 1;
    } else {
      // Leave it for later rather than asking again straight away.
      skipped.add(item.id);
      summary.failed += 1;
    }
  }
}
