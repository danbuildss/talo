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
