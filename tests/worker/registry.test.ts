import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { companyInputSchema } from "../../shared/registry.ts";
import {
  addAlias,
  addSource,
  createCompany,
  DuplicateCompanyError,
  getCompany,
  listCompanies,
  mergeCompanies,
} from "../../worker/db/companies.ts";
import { ConflictError } from "../../worker/db/util.ts";
import { createWorkspace } from "../../worker/db/workspaces.ts";

const ADMIN = "admin@talo.example";
let n = 0;
/** A unique fictional company each time, so tests don't collide. */
function input(overrides: Record<string, unknown> = {}) {
  n += 1;
  return companyInputSchema.parse({
    name: `Fictional Co ${n}`,
    domain: `fictional${n}.example`,
    description: "Sample record for tests.",
    categories: ["ai-agents"],
    is_sample: true,
    ...overrides,
  });
}

describe("categories", () => {
  it("are seeded by the migration", async () => {
    const { results } = await env.DB.prepare("SELECT slug FROM categories").all<{ slug: string }>();
    expect(results.map((r) => r.slug)).toEqual(expect.arrayContaining(["ai-agents", "payments", "x402", "base"]));
  });
});

describe("createCompany", () => {
  it("stores a company as needs_review with aliases, categories and sources", async () => {
    const c = await createCompany(
      env.DB,
      input({
        name: "Acme Agents (fictional)",
        domain: "acme-agents.example",
        aliases: [{ kind: "github_org", value: "acme-agents" }],
        categories: ["ai-agents", "base"],
        sources: [{ url: "https://acme-agents.example/about?utm_source=x", kind: "website", title: "About" }],
      }),
      ADMIN,
    );
    expect(c.status).toBe("needs_review");
    expect(c.slug).toBe("acme-agents");
    const d = await getCompany(env.DB, "acme-agents");
    expect(d?.aliases).toEqual([
      { kind: "domain", value: "acme-agents.example" },
      { kind: "github_org", value: "acme-agents" },
      { kind: "name", value: "acmeagents" },
    ]);
    expect(d?.categories.map((x) => x.slug).sort()).toEqual(["ai-agents", "base"]);
    expect(d?.sources[0]?.url).toBe("https://acme-agents.example/about");
  });

  it.each([
    ["same domain", { domain: "https://www.dupe-domain.example/home" }],
    ["same name, different spelling", { name: "DUPE NAME, Inc." }],
    ["same GitHub org", { aliases: [{ kind: "github_org", value: "github.com/dupe-org" }] }],
  ])("refuses a duplicate by %s and names the existing company", async (_label, clash) => {
    const original = await createCompany(
      env.DB,
      input({ name: "Dupe Name", domain: "dupe-domain.example", aliases: [{ kind: "github_org", value: "dupe-org" }] }),
      ADMIN,
    ).catch(async () => (await listCompanies(env.DB, { q: "dupe" }))[0]);
    const attempt = createCompany(env.DB, input(clash), ADMIN);
    await expect(attempt).rejects.toBeInstanceOf(DuplicateCompanyError);
    const err = (await attempt.catch((e) => e)) as DuplicateCompanyError;
    expect(err.existing.map((e) => e.company_id)).toContain(original?.id);
  });

  it("refuses unknown categories and stores nothing", async () => {
    const i = input({ categories: ["not-a-category"] });
    await expect(createCompany(env.DB, i, ADMIN)).rejects.toBeInstanceOf(ConflictError);
    expect(await listCompanies(env.DB, { q: i.domain })).toEqual([]);
  });

  it("gives clashing slugs a number", async () => {
    const a = await createCompany(env.DB, input({ name: "Same Slug", domain: "same-slug-1.example" }), ADMIN);
    const b = await createCompany(
      env.DB,
      input({ name: "Same-Slug!", domain: "same-slug-2.example", aliases: [] }),
      ADMIN,
    ).catch((e) => e);
    // "Same-Slug!" normalizes to the same name as "Same Slug", so it is a duplicate, not a second slug.
    expect(b).toBeInstanceOf(DuplicateCompanyError);
    const c = await createCompany(env.DB, input({ name: "Same Slug Labs", domain: "same-slug-3.example" }), ADMIN);
    expect(a.slug).toBe("same-slug");
    expect(c.slug).toBe("same-slug-labs");
  });
});

describe("aliases and sources", () => {
  it("adds an alias, and refuses one that belongs to another company", async () => {
    const a = await createCompany(env.DB, input(), ADMIN);
    const b = await createCompany(env.DB, input(), ADMIN);
    await addAlias(env.DB, a.id, "x_handle", "@AliasOwner");
    await addAlias(env.DB, a.id, "x_handle", "aliasowner"); // same company again: no-op
    await expect(addAlias(env.DB, b.id, "x_handle", "https://x.com/aliasowner")).rejects.toBeInstanceOf(
      DuplicateCompanyError,
    );
    await expect(addAlias(env.DB, b.id, "domain", "not a domain")).rejects.toBeInstanceOf(ConflictError);
  });

  it("stores each source URL once, even with tracking parameters", async () => {
    const c = await createCompany(env.DB, input(), ADMIN);
    const one = await addSource(env.DB, c.id, {
      url: "https://news.example/launch?utm_source=x",
      kind: "announcement",
      title: "Launch",
      published_at: "2026-11-01",
    });
    const two = await addSource(env.DB, c.id, {
      url: "https://www.news.example/launch/",
      kind: "announcement",
      title: "Launch again",
      published_at: null,
    });
    expect(two).toBe(one);
    expect((await getCompany(env.DB, c.id))?.sources).toHaveLength(1);
  });
});

describe("listCompanies", () => {
  it("searches by name, description and domain, filters by category and status", async () => {
    const pay = await createCompany(
      env.DB,
      input({
        name: "Zebra Payments",
        domain: "zebrapay.example",
        categories: ["payments"],
        description: "Card rails",
      }),
      ADMIN,
    );
    expect((await listCompanies(env.DB, { q: "zebra" })).map((c) => c.id)).toContain(pay.id);
    expect((await listCompanies(env.DB, { q: "card rails" })).map((c) => c.id)).toContain(pay.id);
    expect((await listCompanies(env.DB, { q: "zebrapay.example" })).map((c) => c.id)).toContain(pay.id);
    expect((await listCompanies(env.DB, { category: "payments" })).map((c) => c.id)).toContain(pay.id);
    expect((await listCompanies(env.DB, { category: "wallets" })).map((c) => c.id)).not.toContain(pay.id);
    expect((await listCompanies(env.DB, { status: "verified" })).map((c) => c.id)).not.toContain(pay.id);
  });

  it("treats % and _ in searches as plain text", async () => {
    await createCompany(env.DB, input({ name: "Percent Co", domain: "percent.example" }), ADMIN);
    expect(await listCompanies(env.DB, { q: "%" })).toEqual([]);
  });
});

describe("mergeCompanies", () => {
  it("moves aliases, categories, sources and workspace candidates, then deletes the duplicate", async () => {
    const keep = await createCompany(env.DB, input({ categories: ["ai-agents"] }), ADMIN);
    const drop = await createCompany(
      env.DB,
      input({
        categories: ["payments"],
        sources: [{ url: "https://drop.example/page", kind: "website", title: "Page" }],
      }),
      ADMIN,
    );
    const ws = await createWorkspace(env.DB, { name: "Merge test", ownerEmail: ADMIN });
    await env.DB.prepare(
      `INSERT INTO partner_candidates (id, workspace_id, company_name, domain, industry, partnership_type, pipeline_stage,
        evidence_summary, mutual_benefits_json, risks_json, recommended_next_action, research_timestamp, created_at, updated_at, company_id)
       VALUES ('cand-merge', ?, 'x', 'x.example', 'x', 'integration', 'discovered', 'x', '{}', '[]', 'x', '2026-11-14T00:00:00Z', 'now', 'now', ?)`,
    )
      .bind(ws.id, drop.id)
      .run();

    await mergeCompanies(env.DB, keep.id, drop.id);

    expect(await getCompany(env.DB, drop.id)).toBeNull();
    const kept = await getCompany(env.DB, keep.id);
    expect(kept?.aliases.map((a) => a.value)).toContain(drop.primary_domain);
    expect(kept?.categories.map((c) => c.slug).sort()).toEqual(["ai-agents", "payments"]);
    expect(kept?.sources.map((s) => s.url)).toContain("https://drop.example/page");
    const cand = await env.DB.prepare("SELECT company_id FROM partner_candidates WHERE id = 'cand-merge'").first<{
      company_id: string;
    }>();
    expect(cand?.company_id).toBe(keep.id);
    // The duplicate's domain now finds the kept company.
    await expect(createCompany(env.DB, input({ domain: drop.primary_domain }), ADMIN)).rejects.toBeInstanceOf(
      DuplicateCompanyError,
    );
  });

  it("refuses to merge a company into itself", async () => {
    const c = await createCompany(env.DB, input(), ADMIN);
    await expect(mergeCompanies(env.DB, c.id, c.id)).rejects.toBeInstanceOf(ConflictError);
  });
});
