import { describe, expect, it } from "vitest";
import { call } from "./helpers.ts";

let n = 0;
/** A fictional registry file with one company and one signal, unique per call. */
function registry(extra: { companies?: unknown[]; signals?: unknown[] } = {}) {
  n += 1;
  const domain = `admin-co-${n}.example`;
  return {
    domain,
    file: {
      format: "talo.registry.v1",
      companies: [
        {
          name: `Admin Co ${n} (fictional)`,
          domain,
          description: "Sample company for tests.",
          categories: ["ai-agents"],
          is_sample: true,
        },
        ...(extra.companies ?? []),
      ],
      signals: [
        {
          company_domain: domain,
          signal_type: "partner_program_launched",
          title: "Opened a partner program",
          factual_claim: "The company opened applications for partners.",
          source_excerpt: "Applications are open.",
          event_date: "2026-11-10",
          primary_source: { url: `https://${domain}/partners`, kind: "partner_page", title: "Partners" },
          is_sample: true,
        },
        ...(extra.signals ?? []),
      ],
    },
  };
}

const post = (path: string, body: unknown) => call(path, { method: "POST", body: JSON.stringify(body) });
const patch = (path: string, body: unknown) => call(path, { method: "PATCH", body: JSON.stringify(body) });
const json = async <T>(res: Response) => (await res.json()) as T;

async function importOne() {
  const r = registry();
  const res = await post("/api/admin/import", r.file);
  expect(res.status).toBe(201);
  const out = await json<{ company_ids: string[]; signal_ids: string[] }>(res);
  return { ...r, companyId: out.company_ids[0] as string, signalId: out.signal_ids[0] as string };
}

describe("admin API is admin-only", () => {
  it.each(["/api/admin/queue", "/api/admin/audit", "/api/admin/companies", "/api/admin/signals"])(
    "%s needs a login",
    async (path) => {
      expect((await call(path, { as: null })).status).toBe(401);
    },
  );
});

describe("import", () => {
  it("imports companies and signals as needs_review", async () => {
    const { companyId, signalId } = await importOne();
    const company = await json<{ company: { status: string } }>(await call(`/api/admin/companies/${companyId}`));
    expect(company.company.status).toBe("needs_review");
    const signal = await json<{ signal: { status: string } }>(await call(`/api/admin/signals/${signalId}`));
    expect(signal.signal.status).toBe("needs_review");
  });

  it("dry run checks without saving", async () => {
    const r = registry();
    const res = await post("/api/admin/import?dry_run=1", r.file);
    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({ dry_run: true, companies_added: 0 });
    const list = await json<{ companies: unknown[] }>(await call(`/api/admin/companies?q=${r.domain}`));
    expect(list.companies).toEqual([]);
  });

  it("refuses the whole file if any row clashes, and says which rows", async () => {
    const first = await importOne();
    const r = registry({
      companies: [{ name: "Another (fictional)", domain: first.domain }],
      signals: [
        {
          company_domain: "nobody.example",
          signal_type: "product_launched",
          title: "x",
          factual_claim: "x",
          source_excerpt: "x",
          primary_source: { url: "https://nobody.example/x", kind: "announcement", title: "x" },
        },
      ],
    });
    const res = await post("/api/admin/import", r.file);
    expect(res.status).toBe(409);
    const err = await json<{ error: { details: { path: string; message: string }[] } }>(res);
    const paths = err.error.details.map((d) => d.path);
    expect(paths).toContain("companies[1]");
    expect(paths).toContain("signals[1].company_domain");
    // Nothing from this file was saved, not even the valid first company.
    const list = await json<{ companies: unknown[] }>(await call(`/api/admin/companies?q=${r.domain}`));
    expect(list.companies).toEqual([]);
  });

  it("catches duplicates inside the same file", async () => {
    const r = registry();
    const dupe = { ...(r.file.companies[0] as object), name: "Different Name (fictional)" };
    const res = await post("/api/admin/import", { ...r.file, companies: [r.file.companies[0], dupe] });
    expect(res.status).toBe(409);
    expect(JSON.stringify(await res.json())).toMatch(/duplicates companies\[0\]/);
  });

  it("refuses files that try to set their own status or include funding", async () => {
    const r = registry();
    const withStatus = { ...r.file, companies: [{ ...(r.file.companies[0] as object), status: "verified" }] };
    expect((await post("/api/admin/import", withStatus)).status).toBe(400);
    const funding = { ...r.file, signals: [{ ...(r.file.signals[0] as object), signal_type: "funding_raised" }] };
    expect((await post("/api/admin/import", funding)).status).toBe(400);
  });
});

describe("review queue and reviews", () => {
  it("lists new items with the page to check, and they leave the queue once reviewed", async () => {
    const { domain, companyId, signalId } = await importOne();
    const queue = await json<{ items: { id: string; subject_type: string; check_url: string }[] }>(
      await call("/api/admin/queue"),
    );
    const company = queue.items.find((i) => i.id === companyId);
    const signal = queue.items.find((i) => i.id === signalId);
    expect(company?.check_url).toBe(`https://${domain}`);
    expect(signal?.check_url).toBe(`https://${domain}/partners`);

    expect(
      (await post(`/api/admin/companies/${companyId}/review`, { action: "verify", checked_url: `https://${domain}` }))
        .status,
    ).toBe(200);
    expect(
      (
        await post(`/api/admin/signals/${signalId}/review`, {
          action: "verify",
          checked_url: `https://${domain}/partners`,
        })
      ).status,
    ).toBe(200);
    const after = await json<{ items: { id: string }[] }>(await call("/api/admin/queue"));
    expect(after.items.map((i) => i.id)).not.toContain(companyId);
    expect(after.items.map((i) => i.id)).not.toContain(signalId);
  });

  it("explains a bad review instead of accepting it", async () => {
    const { signalId } = await importOne();
    const noUrl = await post(`/api/admin/signals/${signalId}/review`, { action: "verify" });
    expect(noUrl.status).toBe(400);
    const wrongUrl = await post(`/api/admin/signals/${signalId}/review`, {
      action: "verify",
      checked_url: "https://elsewhere.example",
    });
    expect(wrongUrl.status).toBe(409);
    expect(await json(wrongUrl)).toMatchObject({ error: { message: expect.stringMatching(/own sources/) } });
  });
});

describe("editing", () => {
  it("editing a verified company's facts sends it back for review; categories don't", async () => {
    const { domain, companyId } = await importOne();
    await post(`/api/admin/companies/${companyId}/review`, { action: "verify", checked_url: `https://${domain}` });

    const cats = await json<{ reopened: boolean }>(
      await patch(`/api/admin/companies/${companyId}`, { categories: ["ai-agents", "payments"] }),
    );
    expect(cats.reopened).toBe(false);

    const desc = await json<{ reopened: boolean; company: { status: string } }>(
      await patch(`/api/admin/companies/${companyId}`, { description: "Changed description." }),
    );
    expect(desc.reopened).toBe(true);
    expect(desc.company.status).toBe("needs_review");
  });

  it("editing a verified signal sends it back for review", async () => {
    const { domain, companyId, signalId } = await importOne();
    await post(`/api/admin/companies/${companyId}/review`, { action: "verify", checked_url: `https://${domain}` });
    await post(`/api/admin/signals/${signalId}/review`, {
      action: "verify",
      checked_url: `https://${domain}/partners`,
    });
    const res = await json<{ reopened: boolean; signal: { status: string; factual_claim: string } }>(
      await patch(`/api/admin/signals/${signalId}`, { factual_claim: "Corrected claim." }),
    );
    expect(res.reopened).toBe(true);
    expect(res.signal).toMatchObject({ status: "needs_review", factual_claim: "Corrected claim." });
  });

  it("refuses unknown fields and renaming to another company's name", async () => {
    const a = await importOne();
    const b = await importOne();
    expect((await patch(`/api/admin/signals/${a.signalId}`, { status: "verified" })).status).toBe(400);
    const clash = await patch(`/api/admin/companies/${b.companyId}`, { name: `Admin Co ${n - 1} (fictional)` });
    expect(clash.status).toBe(409);
  });
});

describe("aliases, merge, listing and audit", () => {
  it("adds an alias and merges a duplicate", async () => {
    const keep = await importOne();
    const drop = await importOne();
    expect(
      (await post(`/api/admin/companies/${keep.companyId}/aliases`, { kind: "x_handle", value: "@keepco" })).status,
    ).toBe(201);
    const merged = await post(`/api/admin/companies/${keep.companyId}/merge`, { duplicate_id: drop.companyId });
    expect(merged.status).toBe(200);
    expect((await call(`/api/admin/companies/${drop.companyId}`)).status).toBe(404);
    const detail = await json<{ signals: { id: string }[] }>(await call(`/api/admin/companies/${keep.companyId}`));
    expect(detail.signals.map((s) => s.id)).toContain(keep.signalId);
  });

  it("filters companies and signals and validates filters", async () => {
    const { domain, companyId, signalId } = await importOne();
    const companies = await json<{ companies: { id: string }[] }>(
      await call(`/api/admin/companies?q=${domain}&status=needs_review`),
    );
    expect(companies.companies.map((c) => c.id)).toEqual([companyId]);
    const signals = await json<{ signals: { id: string }[] }>(
      await call(`/api/admin/signals?company_id=${companyId}&type=partner_program_launched`),
    );
    expect(signals.signals.map((s) => s.id)).toEqual([signalId]);
    expect((await call("/api/admin/signals?type=funding")).status).toBe(400);
    expect((await call("/api/admin/companies?limit=9999")).status).toBe(400);
  });

  it("returns the audit report", async () => {
    const res = await call("/api/admin/audit");
    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({ ok: expect.any(Boolean), checks: expect.any(Array) });
  });

  it("returns 404 for unknown records", async () => {
    expect((await call("/api/admin/companies/nope")).status).toBe(404);
    expect((await call("/api/admin/signals/nope")).status).toBe(404);
    expect((await post("/api/admin/signals/nope/review", { action: "reopen" })).status).toBe(404);
  });
});
