import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { watchedSourceInputSchema } from "../../shared/collector.ts";
import { companyInputSchema } from "../../shared/registry.ts";
import {
  createWatchedSource,
  getWatchedSource,
  listInbox,
  runDueSources,
  runSource,
  USER_AGENT,
} from "../../worker/db/collector.ts";
import { createCompany } from "../../worker/db/companies.ts";
import { getSignal } from "../../worker/db/signals.ts";
import { call } from "./helpers.ts";

const ADMIN = "admin@talo.example";
let n = 0;

function rss(...items: { title: string; link: string }[]) {
  return `<rss><channel>${items.map((i) => `<item><title>${i.title}</title><link>${i.link}</link></item>`).join("")}</channel></rss>`;
}

/** A fake network: answers from a queue and records the requests it received. */
function fakeFetch(...responses: (Response | Error)[]) {
  const requests: Request[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push(new Request(input, init));
    const next = responses.shift();
    if (!next) throw new Error("no more fake responses");
    if (next instanceof Error) throw next;
    return next;
  }) as typeof fetch;
  return { fetcher, requests };
}

async function source(overrides: Record<string, unknown> = {}) {
  n += 1;
  return createWatchedSource(
    env.DB,
    watchedSourceInputSchema.parse({
      name: `Test feed ${n}`,
      adapter: "rss",
      url: `https://feed${n}.example/rss`,
      terms_note: "Fictional test feed.",
      ...overrides,
    }),
    ADMIN,
  );
}

const ok = (body: string, headers: Record<string, string> = {}) => new Response(body, { status: 200, headers });

describe("RSS collection", () => {
  it("puts new items in the inbox with a suggested signal type, once", async () => {
    const s = await source({ company_domain: "acme-feed.example" });
    const body = rss(
      { title: "Introducing the Acme Partner Program", link: `https://acme-feed-${n}.example/partners` },
      { title: "Weekly notes", link: `https://acme-feed-${n}.example/notes` },
    );
    const first = fakeFetch(ok(body, { etag: '"v1"' }));
    expect(await runSource(env.DB, s.id, { fetcher: first.fetcher })).toMatchObject({ status: "ok", items_new: 2 });
    expect(first.requests[0]?.headers.get("user-agent")).toBe(USER_AGENT);

    const inbox = (await listInbox(env.DB)).filter((i) => i.watched_source_id === s.id);
    const partner = inbox.find((i) => i.title.includes("Partner Program"));
    expect(partner).toMatchObject({
      suggested_signal_type: "partner_program_launched",
      suggested_domain: "acme-feed.example",
      status: "new",
    });

    // Same feed again: nothing new, and the ETag is sent back.
    const second = fakeFetch(ok(body));
    expect(await runSource(env.DB, s.id, { fetcher: second.fetcher })).toMatchObject({ items_new: 0 });
    expect(second.requests[0]?.headers.get("if-none-match")).toBe('"v1"');
  });

  it("treats 304 Not Modified as a quiet success", async () => {
    const s = await source();
    const { fetcher } = fakeFetch(new Response(null, { status: 304 }));
    expect(await runSource(env.DB, s.id, { fetcher })).toMatchObject({ status: "not_modified" });
    expect((await getWatchedSource(env.DB, s.id))?.last_success_at).not.toBeNull();
  });
});

describe("failures", () => {
  it("records the error, backs off, and pauses after 5 failures in a row", async () => {
    const s = await source({ interval_hours: 24 });
    const now = new Date("2026-11-14T00:00:00Z");
    const one = await runSource(env.DB, s.id, {
      fetcher: fakeFetch(new Response("nope", { status: 500 })).fetcher,
      now,
    });
    expect(one).toMatchObject({ status: "failed", error: expect.stringMatching(/answered 500/) });
    const after1 = await getWatchedSource(env.DB, s.id);
    expect(after1?.consecutive_failures).toBe(1);
    expect(after1?.next_run_at).toBe("2026-11-16T00:00:00.000Z"); // 48h backoff

    for (let i = 0; i < 4; i++) {
      await runSource(env.DB, s.id, { fetcher: fakeFetch(new Error("network down")).fetcher, now });
    }
    const paused = await getWatchedSource(env.DB, s.id);
    expect(paused?.enabled).toBe(false);
    expect(paused?.last_error).toMatch(/could not reach/);
    const runs = await call(`/api/admin/runs?source_id=${s.id}`);
    expect(((await runs.json()) as { runs: unknown[] }).runs).toHaveLength(5);
  });

  it("logs a format change as a failure instead of storing junk", async () => {
    const s = await source({ adapter: "github_releases", url: "https://github.com/acme/format-change" });
    const out = await runSource(env.DB, s.id, { fetcher: fakeFetch(ok('{"message":"changed"}')).fetcher });
    expect(out).toMatchObject({ status: "failed", error: expect.stringMatching(/format may have changed/) });
  });
});

describe("adapters", () => {
  it("GitHub releases: calls the API with a token when set", async () => {
    const s = await source({ adapter: "github_releases", url: "https://github.com/acme/sdk-repo" });
    const { fetcher, requests } = fakeFetch(
      ok(
        JSON.stringify([
          { html_url: `https://github.com/acme/sdk-repo/releases/tag/v1-${n}`, tag_name: "v1", name: "SDK v1" },
        ]),
      ),
    );
    const out = await runSource(env.DB, s.id, { fetcher, env: { GITHUB_TOKEN: "test-token" } });
    expect(out.items_new).toBe(1);
    expect(requests[0]?.url).toBe("https://api.github.com/repos/acme/sdk-repo/releases?per_page=10");
    expect(requests[0]?.headers.get("authorization")).toBe("Bearer test-token");
  });

  it("page watch: first visit records the page; a change becomes one item", async () => {
    const s = await source({ adapter: "page_watch", url: `https://partners-${n}.example/program` });
    const page = (text: string) => ok(`<html><title>Partners</title><body>${text}</body></html>`);
    expect((await runSource(env.DB, s.id, { fetcher: fakeFetch(page("Apply now")).fetcher })).items_new).toBe(0);
    expect((await runSource(env.DB, s.id, { fetcher: fakeFetch(page("Apply now")).fetcher })).items_new).toBe(0);
    const changed = await runSource(env.DB, s.id, {
      fetcher: fakeFetch(page("Applications open for AI partners")).fetcher,
    });
    expect(changed.items_new).toBe(1);
    const item = (await listInbox(env.DB)).find((i) => i.watched_source_id === s.id);
    expect(item?.title).toBe("Page changed: Partners");
  });

  it("registry key map: first visit records keys; only new keys become items", async () => {
    const s = await source({
      adapter: "registry_listing",
      url: `https://registry-${n}.example/index.json`,
      config: { format: "key_map", label: "New plugin" },
    });
    const v1 = ok(JSON.stringify({ "@a/one": `github:a/one-${n}` }));
    const v2 = ok(JSON.stringify({ "@a/one": `github:a/one-${n}`, "@b/two": `github:b/two-${n}` }));
    expect((await runSource(env.DB, s.id, { fetcher: fakeFetch(v1).fetcher })).items_new).toBe(0);
    expect((await runSource(env.DB, s.id, { fetcher: fakeFetch(v2).fetcher })).items_new).toBe(1);
    const item = (await listInbox(env.DB)).find((i) => i.watched_source_id === s.id);
    expect(item).toMatchObject({ title: "New plugin: @b/two", url: `https://github.com/b/two-${n}` });
  });

  it("refuses a GitHub source that isn't a repository link, and a registry without a format", async () => {
    await expect(source({ adapter: "github_releases", url: "https://github.com/onlyowner" })).rejects.toThrow(
      /repository link/,
    );
    await expect(source({ adapter: "registry_listing", url: "https://r.example/x" })).rejects.toThrow(/config.format/);
  });
});

describe("runDueSources", () => {
  it("checks only enabled sources that are due, up to the limit", async () => {
    const now = new Date("2030-01-01T00:00:00Z"); // everything created so far is due
    const paused = await source({ enabled: false });
    const { fetcher, requests } = fakeFetch(...Array.from({ length: 3 }, () => ok(rss())));
    const outcomes = await runDueSources(env.DB, { fetcher, now, limit: 3 });
    expect(outcomes).toHaveLength(3);
    expect(requests.map((r) => r.url)).not.toContain(paused.url);
  });
});

describe("collector API", () => {
  it("adds a source, runs it on demand, and lists sources", async () => {
    n += 1;
    const res = await call("/api/admin/watched-sources", {
      method: "POST",
      body: JSON.stringify({
        name: "API feed",
        adapter: "rss",
        url: `https://api-feed-${n}.example/rss`,
        terms_note: "Fictional public feed.",
      }),
    });
    expect(res.status).toBe(201);
    const dupe = await call("/api/admin/watched-sources", {
      method: "POST",
      body: JSON.stringify({
        name: "Again",
        adapter: "rss",
        url: `https://api-feed-${n}.example/rss`,
        terms_note: "Fictional public feed.",
      }),
    });
    expect(dupe.status).toBe(409);
    const list = (await (await call("/api/admin/watched-sources")).json()) as { sources: { url: string }[] };
    expect(list.sources.map((s) => s.url)).toContain(`https://api-feed-${n}.example/rss`);
  });

  it("pausing and re-enabling a source resets its failures", async () => {
    const s = await source();
    await runSource(env.DB, s.id, { fetcher: fakeFetch(new Error("down")).fetcher });
    const off = await call(`/api/admin/watched-sources/${s.id}`, {
      method: "PATCH",
      body: JSON.stringify({ enabled: false }),
    });
    expect(((await off.json()) as { source: { enabled: boolean } }).source.enabled).toBe(false);
    const on = await call(`/api/admin/watched-sources/${s.id}`, {
      method: "PATCH",
      body: JSON.stringify({ enabled: true }),
    });
    expect(((await on.json()) as { source: { consecutive_failures: number } }).source.consecutive_failures).toBe(0);
  });

  it("promotes an inbox item into a needs_review signal, or dismisses it, once", async () => {
    const s = await source({ company_domain: "promo.example" });
    await runSource(env.DB, s.id, {
      fetcher: fakeFetch(
        ok(
          rss(
            { title: "Acme partner program", link: "https://promo.example/partners" },
            { title: "Noise", link: "https://promo.example/noise" },
          ),
        ),
      ).fetcher,
    });
    await createCompany(
      env.DB,
      companyInputSchema.parse({ name: "Promo Co (fictional)", domain: "promo.example", is_sample: true }),
      ADMIN,
    );
    const items = (await listInbox(env.DB)).filter((i) => i.watched_source_id === s.id);
    const good = items.find((i) => i.url.endsWith("/partners"));
    const noise = items.find((i) => i.url.endsWith("/noise"));

    const promoted = await call(`/api/admin/inbox/${good?.id}/promote`, {
      method: "POST",
      body: JSON.stringify({
        company_domain: "promo.example",
        signal_type: "partner_program_launched",
        title: "Opened a partner program",
        factual_claim: "Promo Co opened a partner program.",
        source_excerpt: "Join the Promo partner program.",
      }),
    });
    expect(promoted.status).toBe(201);
    const { signal_id } = (await promoted.json()) as { signal_id: string };
    const signal = await getSignal(env.DB, signal_id);
    expect(signal).toMatchObject({ status: "needs_review", primary_source: { url: "https://promo.example/partners" } });

    const again = await call(`/api/admin/inbox/${good?.id}/promote`, { method: "POST", body: JSON.stringify({}) });
    expect(again.status).toBe(400);
    expect((await call(`/api/admin/inbox/${noise?.id}/dismiss`, { method: "POST" })).status).toBe(200);
    expect((await call(`/api/admin/inbox/${noise?.id}/dismiss`, { method: "POST" })).status).toBe(409);
    const left = (await listInbox(env.DB)).filter((i) => i.watched_source_id === s.id);
    expect(left).toEqual([]);
  });

  it("is admin-only", async () => {
    for (const path of ["/api/admin/watched-sources", "/api/admin/inbox", "/api/admin/runs"]) {
      expect((await call(path, { as: null })).status).toBe(401);
    }
  });
});

describe("robustness (found in the first local run)", () => {
  it("keeps the first copy when a source lists the same link twice in one response", async () => {
    const s = await source();
    const link = `https://dup-in-run-${n}.example/post`;
    const out = await runSource(env.DB, s.id, {
      fetcher: fakeFetch(ok(rss({ title: "One", link }, { title: "Same link again", link: `${link}?utm_source=x` })))
        .fetcher,
    });
    expect(out).toMatchObject({ status: "ok", items_new: 1 });
  });

  it("an unreadable response is recorded as a failed run, not a crash", async () => {
    const s = await source({
      adapter: "registry_listing",
      url: `https://broken-${n}.example/x.json`,
      config: { format: "mcp_registry" },
    });
    const out = await runSource(env.DB, s.id, { fetcher: fakeFetch(ok("not json at all")).fetcher });
    expect(out.status).toBe("failed");
    const runs = (await (await call(`/api/admin/runs?source_id=${s.id}`)).json()) as { runs: { status: string }[] };
    expect(runs.runs[0]?.status).toBe("failed");
  });
});

describe("Pilot A: Grok signal search", () => {
  const grokSource = (overrides: Record<string, unknown> = {}) =>
    source({
      adapter: "grok_x_search",
      url: `https://x.com/search?q=test-${n + 1}`,
      config: { query: "companies announcing partner programs" },
      ...overrides,
    });

  function reply(ids: string[], cited = ids) {
    const items = ids.map((id) => ({
      post_url: `https://x.com/acmehq/status/${id}`,
      posted_at: "2026-11-13",
      post_text: "Introducing the Acme partner program",
      company_website: "https://acme-grok.example",
    }));
    return ok(
      JSON.stringify({
        output: [
          {
            type: "message",
            content: [
              {
                type: "output_text",
                text: JSON.stringify({ items }),
                annotations: cited.map((id) => ({ type: "url_citation", url: `https://x.com/acmehq/status/${id}` })),
              },
            ],
          },
        ],
        usage: { input_tokens: 10_000, output_tokens: 500 },
      }),
    );
  }

  it("is skipped (not failed) when no key is set", async () => {
    const s = await grokSource();
    const { fetcher, requests } = fakeFetch();
    const out = await runSource(env.DB, s.id, { fetcher, env: {} });
    expect(out).toMatchObject({ status: "not_modified", error: "Skipped: XAI_API_KEY is not set" });
    expect(requests).toHaveLength(0);
    expect((await getWatchedSource(env.DB, s.id))?.consecutive_failures).toBe(0);
  });

  it("posts the search to xAI, keeps only cited posts, and records the spend", async () => {
    const s = await grokSource();
    const base = `${Date.now()}`.padEnd(18, "0");
    const { fetcher, requests } = fakeFetch(reply([`${base}1`, `${base}2`], [`${base}1`]));
    const out = await runSource(env.DB, s.id, { fetcher, env: { XAI_API_KEY: "test-key" } });
    expect(out).toMatchObject({ status: "ok", items_new: 1 });
    expect(requests[0]?.url).toBe("https://api.x.ai/v1/responses");
    expect(requests[0]?.method).toBe("POST");
    expect(requests[0]?.headers.get("authorization")).toBe("Bearer test-key");
    const item = (await listInbox(env.DB)).find((i) => i.watched_source_id === s.id);
    expect(item).toMatchObject({
      suggested_signal_type: "partner_program_launched",
      suggested_domain: "acme-grok.example",
    });
    const spend = await env.DB.prepare("SELECT posts, estimated_usd FROM spend_ledger WHERE watched_source_id = ?")
      .bind(s.id)
      .first<{ posts: number; estimated_usd: number }>();
    expect(spend?.posts).toBe(1);
    expect(spend?.estimated_usd).toBeGreaterThan(0);
  });

  it("stops at the monthly cap until next month", async () => {
    const s = await grokSource();
    const now = new Date("2031-03-15T00:00:00Z");
    await env.DB.prepare(
      "INSERT INTO spend_ledger (id, provider, posts, estimated_usd, created_at) VALUES (?, 'xai', 0, 49.99, ?)",
    )
      .bind(`cap-test-${n}`, "2031-03-02T00:00:00.000Z")
      .run();
    // Under the cap: runs.
    const under = await runSource(env.DB, s.id, {
      fetcher: fakeFetch(reply([])).fetcher,
      env: { XAI_API_KEY: "k" },
      now,
    });
    expect(under.status).toBe("ok");
    // A cap at or below what's spent: skipped, and not retried before next month.
    const { fetcher, requests } = fakeFetch();
    const over = await runSource(env.DB, s.id, { fetcher, env: { XAI_API_KEY: "k", GROK_MONTHLY_CAP_USD: "40" }, now });
    expect(over).toMatchObject({ status: "not_modified", error: expect.stringMatching(/budget reached/) });
    expect(requests).toHaveLength(0);
    expect((await getWatchedSource(env.DB, s.id))?.next_run_at).toBe("2031-04-01T00:00:00.000Z");
  });

  it("an error from xAI is a normal failure", async () => {
    const s = await grokSource();
    const out = await runSource(env.DB, s.id, {
      fetcher: fakeFetch(new Response("{}", { status: 401 })).fetcher,
      env: { XAI_API_KEY: "wrong" },
    });
    expect(out).toMatchObject({ status: "failed", error: "api.x.ai answered 401" });
  });

  it("refuses a Grok source without a query", async () => {
    await expect(grokSource({ config: {} })).rejects.toThrow(/config.query/);
  });

  it("shows this month's spend", async () => {
    const res = await call("/api/admin/spend");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ provider: "xai", cap_usd: 50, key_configured: false });
  });
});
