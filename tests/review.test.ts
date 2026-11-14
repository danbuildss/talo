import { describe, expect, it } from "vitest";
import { type ApiResult, needsExactExcerpt, type QueueItem, type ReviewIO, runReview } from "../scripts/review-lib.ts";

/** A tiny fake of the admin API with one company and one signal, enforcing the same basic rules. */
function fakeServer() {
  const state = {
    company: {
      id: "c1",
      name: "Acme (fictional)",
      primary_domain: "acme.example",
      description: "Agent SDK.",
      categories: [{ label: "AI agents" }],
      status: "needs_review",
    },
    signal: {
      id: "s1",
      title: "Partner program",
      company_name: "Acme (fictional)",
      factual_claim: "Acme opened a partner program.",
      source_excerpt: "Search summary, replace with the source's exact words when verifying: partner program opened.",
      opportunity_note: null,
      event_date: "2026-11-10",
      primary_source: { url: "https://acme.example/partners" },
      status: "needs_review",
    },
    calls: [] as { method: string; path: string; body?: unknown }[],
  };
  const queue = (): QueueItem[] => [
    ...(state.company.status === "needs_review"
      ? [
          {
            subject_type: "company" as const,
            id: "c1",
            label: "Acme",
            company_id: "c1",
            company_status: state.company.status,
            check_url: "https://acme.example",
          },
        ]
      : []),
    ...(state.signal.status === "needs_review"
      ? [
          {
            subject_type: "signal" as const,
            id: "s1",
            label: "Acme: Partner program",
            company_id: "c1",
            company_status: state.company.status,
            check_url: "https://acme.example/partners",
          },
        ]
      : []),
  ];
  const ok = (body: unknown): ApiResult => ({ ok: true, status: 200, body });
  const fail = (status: number, message: string): ApiResult => ({ ok: false, status, body: { error: { message } } });
  async function api(method: "GET" | "POST" | "PATCH", path: string, body?: unknown): Promise<ApiResult> {
    state.calls.push({ method, path, body });
    const b = body as Record<string, string> | undefined;
    if (path === "/queue") return ok({ items: queue() });
    if (path === "/companies/c1") return ok({ company: state.company });
    if (path === "/signals/s1" && method === "GET")
      return ok({ signal: { ...state.signal, company_status: state.company.status } });
    if (path === "/signals/s1" && method === "PATCH") {
      state.signal.source_excerpt = b?.source_excerpt ?? state.signal.source_excerpt;
      return ok({});
    }
    if (path === "/companies/c1/review") {
      if (b?.action === "verify" && !String(b.checked_url).includes("acme.example"))
        return fail(409, "checked_url must be a page on the company's own domain");
      state.company.status = b?.action === "verify" ? "verified" : "rejected";
      return ok({ status: state.company.status });
    }
    if (path === "/signals/s1/review") {
      if (b?.action === "verify" && b.checked_url !== "https://acme.example/partners")
        return fail(409, "checked_url must be one of this signal's own sources");
      state.signal.status = b?.action === "verify" ? "verified" : "rejected";
      return ok({ status: state.signal.status });
    }
    return fail(404, "not found");
  }
  return { state, api };
}

function io(server: ReturnType<typeof fakeServer>, answers: string[]) {
  const printed: string[] = [];
  const opened: string[] = [];
  const asked: string[] = [];
  const reviewIO: ReviewIO = {
    api: server.api,
    async ask(q) {
      asked.push(q);
      return answers.shift() ?? "q";
    },
    open: (url) => opened.push(url),
    print: (line = "") => printed.push(line),
  };
  return { reviewIO, printed, opened, asked };
}

describe("needsExactExcerpt", () => {
  it("flags Claude's search summaries and empty excerpts", () => {
    expect(needsExactExcerpt("Search summary, replace …")).toBe(true);
    expect(needsExactExcerpt("")).toBe(true);
    expect(needsExactExcerpt("Today we're opening our partner program.")).toBe(false);
  });
});

describe("runReview", () => {
  it("approves a company, then a signal after the exact sentence is pasted", async () => {
    const server = fakeServer();
    const t = io(server, ["a", "", "a", "Today we're opening the Acme partner program.", ""]);
    const summary = await runReview(t.reviewIO);
    expect(summary).toMatchObject({ approved: 2, rejected: 0 });
    expect(server.state.company.status).toBe("verified");
    expect(server.state.signal.status).toBe("verified");
    expect(server.state.signal.source_excerpt).toBe("Today we're opening the Acme partner program.");
    expect(t.opened).toEqual(["https://acme.example", "https://acme.example/partners"]);
    expect(t.printed.at(-1)).toMatch(/queue is empty/);
  });

  it("won't approve a signal without the page's own words", async () => {
    const server = fakeServer();
    server.state.company.status = "verified";
    const t = io(server, ["a", "", "q"]);
    const summary = await runReview(t.reviewIO);
    expect(server.state.signal.status).toBe("needs_review");
    expect(summary.failed).toBe(1);
    expect(t.printed.join("\n")).toMatch(/must be the page's own words/);
  });

  it("won't accept a pasted search summary as the excerpt", async () => {
    const server = fakeServer();
    server.state.company.status = "verified";
    const t = io(server, ["a", "Search summary, …", "q"]);
    await runReview(t.reviewIO);
    expect(server.state.signal.status).toBe("needs_review");
  });

  it("shows the server's reason when verification is refused", async () => {
    const server = fakeServer();
    const t = io(server, ["a", "https://crunchbase.example/acme", "q"]);
    await runReview(t.reviewIO);
    expect(server.state.company.status).toBe("needs_review");
    expect(t.printed.join("\n")).toMatch(/Not verified: checked_url must be a page on the company's own domain/);
  });

  it("rejects with a reason, and refuses to reject without one", async () => {
    const server = fakeServer();
    const t = io(server, ["r", "", "r", "Wrong company"]);
    // First attempt has no reason (item is set aside), so the signal comes next; reject it.
    const summary = await runReview(t.reviewIO);
    expect(server.state.company.status).toBe("needs_review");
    expect(server.state.signal.status).toBe("rejected");
    expect(summary).toMatchObject({ rejected: 1, failed: 1 });
  });

  it("skips, quits cleanly, and can run without opening links", async () => {
    const server = fakeServer();
    const t = io(server, ["s", "q"]);
    const summary = await runReview(t.reviewIO, { openLinks: false });
    expect(summary).toMatchObject({ skipped: 1, approved: 0 });
    expect(t.opened).toEqual([]);
    expect(t.printed.at(-1)).toMatch(/Stopped/);
  });

  it("asks again when the 'page you checked' answer isn't a link", async () => {
    const server = fakeServer();
    const t = io(server, ["a", "I looked at their homepage", "", "q"]);
    await runReview(t.reviewIO);
    expect(server.state.company.status).toBe("verified");
    expect(t.printed.join("\n")).toMatch(/That isn't a link/);
  });

  it("notes when a signal's company isn't verified yet", async () => {
    const server = fakeServer();
    const t = io(server, ["s", "q"]);
    await runReview(t.reviewIO);
    expect(t.printed.join("\n")).toMatch(/company isn't verified yet/);
  });
});
