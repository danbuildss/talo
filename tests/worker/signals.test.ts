import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { companyInputSchema } from "../../shared/registry.ts";
import { SIGNAL_TYPES, signalInputSchema } from "../../shared/signals.ts";
import { auditData } from "../../worker/db/audit.ts";
import { createCompany } from "../../worker/db/companies.ts";
import {
  createSignal,
  DuplicateSignalError,
  getSignal,
  InvalidReviewError,
  listSignals,
  reviewCompany,
  reviewSignal,
} from "../../worker/db/signals.ts";
import { NotFoundError } from "../../worker/db/util.ts";

const ADMIN = "admin@talo.example";
const NOW = new Date("2026-11-14T12:00:00Z");
let n = 0;

async function company(overrides: Record<string, unknown> = {}) {
  n += 1;
  return createCompany(
    env.DB,
    companyInputSchema.parse({
      name: `Signal Co ${n} (fictional)`,
      domain: `signalco${n}.example`,
      categories: ["ai-agents"],
      is_sample: true,
      ...overrides,
    }),
    ADMIN,
    NOW,
  );
}

function signal(domain: string, overrides: Record<string, unknown> = {}) {
  return signalInputSchema.parse({
    company_domain: domain,
    signal_type: "partner_program_launched",
    title: "Launched a developer partner program",
    factual_claim: "The company opened applications for integration partners.",
    source_excerpt: "We're opening our partner program to developers.",
    opportunity_note: "Tools for agent builders could apply.",
    event_date: "2026-11-10",
    primary_source: { url: `https://${domain}/blog/partners?utm_source=x`, kind: "announcement", title: "Partners" },
    is_sample: true,
    ...overrides,
  });
}

/** A company and signal that are both verified the proper way. */
async function verifiedPair(at = NOW) {
  const c = await company();
  await reviewCompany(env.DB, c.id, { action: "verify", checked_url: `https://${c.primary_domain}/about` }, ADMIN, at);
  const id = await createSignal(env.DB, signal(c.primary_domain), ADMIN, at);
  await reviewSignal(
    env.DB,
    id,
    { action: "verify", checked_url: `https://${c.primary_domain}/blog/partners` },
    ADMIN,
    at,
  );
  return { c, id };
}

describe("signal types table", () => {
  it("matches the types in code", async () => {
    const { results } = await env.DB.prepare("SELECT slug, intent, freshness_days FROM signal_types").all<{
      slug: keyof typeof SIGNAL_TYPES;
      intent: string;
      freshness_days: number;
    }>();
    expect(results).toHaveLength(Object.keys(SIGNAL_TYPES).length);
    for (const r of results) {
      expect(SIGNAL_TYPES[r.slug]).toMatchObject({ intent: r.intent, freshness_days: r.freshness_days });
    }
  });
});

describe("createSignal", () => {
  it("stores a signal as needs_review with its primary source", async () => {
    const c = await company();
    const id = await createSignal(env.DB, signal(c.primary_domain), ADMIN, NOW);
    const s = await getSignal(env.DB, id, NOW);
    expect(s?.status).toBe("needs_review");
    expect(s?.effective_status).toBe("needs_review");
    expect(s?.company_id).toBe(c.id);
    expect(s?.primary_source?.url).toBe(`https://${c.primary_domain}/blog/partners`);
  });

  it("finds the company by any of its domains", async () => {
    const c = await company({ aliases: [{ kind: "domain", value: "alt-domain-signal.example" }] });
    const id = await createSignal(env.DB, signal("alt-domain-signal.example"), ADMIN, NOW);
    expect((await getSignal(env.DB, id, NOW))?.company_id).toBe(c.id);
  });

  it("refuses a signal for an unknown company", async () => {
    await expect(createSignal(env.DB, signal("nobody-here.example"), ADMIN, NOW)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("refuses the same event twice, even with a different-looking link", async () => {
    const c = await company();
    await createSignal(env.DB, signal(c.primary_domain), ADMIN, NOW);
    const again = signal(c.primary_domain, {
      primary_source: { url: `https://www.${c.primary_domain}/blog/partners/`, kind: "announcement", title: "Same" },
    });
    await expect(createSignal(env.DB, again, ADMIN, NOW)).rejects.toBeInstanceOf(DuplicateSignalError);
  });

  it("stores corroborating sources separately from the primary one", async () => {
    const c = await company();
    const id = await createSignal(
      env.DB,
      signal(c.primary_domain, {
        corroborating_sources: [{ url: "https://news.example/acme-partners", kind: "announcement", title: "News" }],
      }),
      ADMIN,
      NOW,
    );
    const s = await getSignal(env.DB, id, NOW);
    expect(s?.corroborating_sources.map((x) => x.url)).toEqual(["https://news.example/acme-partners"]);
  });
});

describe("reviewing", () => {
  it("verifies a signal only against its own sources, and logs who checked what", async () => {
    const c = await company();
    const id = await createSignal(env.DB, signal(c.primary_domain), ADMIN, NOW);
    await expect(
      reviewSignal(env.DB, id, { action: "verify", checked_url: "https://elsewhere.example/post" }, ADMIN, NOW),
    ).rejects.toBeInstanceOf(InvalidReviewError);
    expect(
      await reviewSignal(
        env.DB,
        id,
        { action: "verify", checked_url: `https://${c.primary_domain}/blog/partners` },
        ADMIN,
        NOW,
      ),
    ).toBe("verified");
    const s = await getSignal(env.DB, id, NOW);
    expect(s?.last_verified_at).toBe(NOW.toISOString());
    const log = await env.DB.prepare(
      "SELECT action, from_status, to_status, reviewer, checked_url FROM verification_reviews WHERE subject_id = ?",
    )
      .bind(id)
      .all();
    expect(log.results).toEqual([
      {
        action: "verify",
        from_status: "needs_review",
        to_status: "verified",
        reviewer: ADMIN,
        checked_url: `https://${c.primary_domain}/blog/partners`,
      },
    ]);
  });

  it("verifies a company only against a page on its own domain", async () => {
    const c = await company();
    await expect(
      reviewCompany(env.DB, c.id, { action: "verify", checked_url: "https://crunchbase.example/acme" }, ADMIN, NOW),
    ).rejects.toBeInstanceOf(InvalidReviewError);
    expect(
      await reviewCompany(
        env.DB,
        c.id,
        { action: "verify", checked_url: `https://docs.${c.primary_domain}/intro` },
        ADMIN,
        NOW,
      ),
    ).toBe("verified");
  });

  it("rejects with a reason, and can reopen", async () => {
    const c = await company();
    const id = await createSignal(env.DB, signal(c.primary_domain), ADMIN, NOW);
    await reviewSignal(
      env.DB,
      id,
      { action: "reject", reason: "Announcement was for a different company" },
      ADMIN,
      NOW,
    );
    expect((await getSignal(env.DB, id, NOW))?.rejected_reason).toBe("Announcement was for a different company");
    await expect(
      reviewSignal(
        env.DB,
        id,
        { action: "verify", checked_url: `https://${c.primary_domain}/blog/partners` },
        ADMIN,
        NOW,
      ),
    ).rejects.toBeInstanceOf(InvalidReviewError);
    expect(await reviewSignal(env.DB, id, { action: "reopen" }, ADMIN, NOW)).toBe("needs_review");
    expect((await getSignal(env.DB, id, NOW))?.rejected_reason).toBeNull();
  });

  it("can't skip the review log, and the log can't be edited or deleted", async () => {
    const { id } = await verifiedPair();
    await expect(
      env.DB.prepare("UPDATE verification_reviews SET reviewer = 'someone' WHERE subject_id = ?").bind(id).run(),
    ).rejects.toThrow(/append-only/);
    await expect(
      env.DB.prepare("DELETE FROM verification_reviews WHERE subject_id = ?").bind(id).run(),
    ).rejects.toThrow(/append-only/);
    // The database itself refuses a verified signal without a verification date.
    await expect(
      env.DB.prepare("UPDATE signal_events SET last_verified_at = NULL WHERE id = ?").bind(id).run(),
    ).rejects.toThrow();
  });
});

describe("freshness", () => {
  it("shows a verified signal as stale after its window, and a re-check makes it current again", async () => {
    const old = new Date("2026-09-01T12:00:00Z");
    const { c, id } = await verifiedPair(old);
    expect((await getSignal(env.DB, id, NOW))?.effective_status).toBe("stale");
    await reviewSignal(
      env.DB,
      id,
      { action: "verify", checked_url: `https://${c.primary_domain}/blog/partners` },
      ADMIN,
      NOW,
    );
    expect((await getSignal(env.DB, id, NOW))?.effective_status).toBe("verified");
  });
});

describe("listSignals", () => {
  it("public view shows only verified signals of verified companies", async () => {
    const { id: shown } = await verifiedPair();
    const unverifiedCo = await company();
    const hiddenSig = await createSignal(env.DB, signal(unverifiedCo.primary_domain), ADMIN, NOW);
    // Signal verified, but its company isn't: still hidden from Discover.
    await reviewSignal(
      env.DB,
      hiddenSig,
      { action: "verify", checked_url: `https://${unverifiedCo.primary_domain}/blog/partners` },
      ADMIN,
      NOW,
    );
    const pending = await createSignal(env.DB, signal((await company()).primary_domain), ADMIN, NOW);

    const publicIds = (await listSignals(env.DB, { publicOnly: true, limit: 200 }, NOW)).map((s) => s.id);
    expect(publicIds).toContain(shown);
    expect(publicIds).not.toContain(hiddenSig);
    expect(publicIds).not.toContain(pending);
  });

  it("filters by type, company and category, newest event first", async () => {
    const c = await company({ categories: ["payments"] });
    const older = await createSignal(env.DB, signal(c.primary_domain, { event_date: "2026-10-01" }), ADMIN, NOW);
    const newer = await createSignal(
      env.DB,
      signal(c.primary_domain, {
        signal_type: "product_launched",
        event_date: "2026-11-12",
        primary_source: { url: `https://${c.primary_domain}/launch`, kind: "announcement", title: "Launch" },
      }),
      ADMIN,
      NOW,
    );
    expect((await listSignals(env.DB, { companyId: c.id }, NOW)).map((s) => s.id)).toEqual([newer, older]);
    expect((await listSignals(env.DB, { companyId: c.id, type: "product_launched" }, NOW)).map((s) => s.id)).toEqual([
      newer,
    ]);
    expect((await listSignals(env.DB, { category: "payments", limit: 200 }, NOW)).map((s) => s.id)).toContain(older);
    expect((await listSignals(env.DB, { category: "wallets", limit: 200 }, NOW)).map((s) => s.id)).not.toContain(older);
  });
});

describe("auditData", () => {
  it("passes when everything published was verified properly, and reports the backlog", async () => {
    await verifiedPair();
    await createSignal(env.DB, signal((await company()).primary_domain), ADMIN, NOW);
    const report = await auditData(env.DB, NOW);
    const byId = Object.fromEntries(report.checks.map((c) => [c.id, c]));
    expect(byId.published_without_primary_source?.count).toBe(0);
    expect(byId.verified_signal_without_review?.count).toBe(0);
    expect(byId.signals_awaiting_review?.count).toBeGreaterThan(0);
    expect(report.ok).toBe(true);
  });

  it("fails when something was marked verified without a review", async () => {
    const c = await company();
    const id = await createSignal(env.DB, signal(c.primary_domain), ADMIN, NOW);
    // Bypass the review path on purpose, as a bad script might.
    await env.DB.prepare("UPDATE signal_events SET status = 'verified', last_verified_at = ? WHERE id = ?")
      .bind(NOW.toISOString(), id)
      .run();
    const report = await auditData(env.DB, NOW);
    const bad = report.checks.find((c) => c.id === "verified_signal_without_review");
    expect(bad?.examples).toContain(id);
    expect(report.ok).toBe(false);
    // Clean up so later tests in this file see a passing audit.
    await reviewSignal(env.DB, id, { action: "reject", reason: "test cleanup" }, ADMIN, NOW);
  });

  it("lists stale signals and possible duplicate companies", async () => {
    await verifiedPair(new Date("2026-08-01T00:00:00Z"));
    await company({ name: "Twinco (fictional)", domain: "twinco.ai" });
    await company({ name: "Twinco Labs (fictional)", domain: "twinco.io" });
    const report = await auditData(env.DB, NOW);
    expect(report.checks.find((c) => c.id === "stale_signals")?.count).toBeGreaterThan(0);
    expect(report.near_duplicates.some((d) => /twinco/.test(d.reason))).toBe(true);
  });
});
