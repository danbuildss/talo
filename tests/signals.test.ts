import { describe, expect, it } from "vitest";
import {
  effectiveSignalStatus,
  isPublic,
  nextStatus,
  reviewInputSchema,
  SIGNAL_TYPES,
  signalInputSchema,
} from "../shared/signals.ts";

const NOW = new Date("2026-11-14T12:00:00Z");

describe("signal types", () => {
  it("has the seven agreed types and no funding type", () => {
    expect(Object.keys(SIGNAL_TYPES).sort()).toEqual([
      "api_or_sdk_released",
      "collaboration_request",
      "ecosystem_expansion",
      "integration_announced",
      "partner_program_launched",
      "partnerships_role_posted",
      "product_launched",
    ]);
    expect(Object.keys(SIGNAL_TYPES).some((t) => t.includes("fund"))).toBe(false);
  });
});

describe("effectiveSignalStatus", () => {
  const sig = (status: "needs_review" | "verified" | "rejected", last: string | null) => ({
    status,
    last_verified_at: last,
    signal_type: "partner_program_launched" as const, // 30-day window
  });

  it("stays verified inside the freshness window", () => {
    expect(effectiveSignalStatus(sig("verified", "2026-10-20T12:00:00Z"), NOW)).toBe("verified");
  });
  it("becomes stale after the window", () => {
    expect(effectiveSignalStatus(sig("verified", "2026-10-10T12:00:00Z"), NOW)).toBe("stale");
  });
  it("uses each type's own window", () => {
    expect(
      effectiveSignalStatus(
        { status: "verified", last_verified_at: "2026-10-10T12:00:00Z", signal_type: "product_launched" },
        NOW,
      ),
    ).toBe("verified");
  });
  it("leaves other statuses alone", () => {
    expect(effectiveSignalStatus(sig("needs_review", null), NOW)).toBe("needs_review");
    expect(effectiveSignalStatus(sig("rejected", "2020-01-01T00:00:00Z"), NOW)).toBe("rejected");
  });
});

describe("isPublic", () => {
  it("needs both the signal and its company verified", () => {
    expect(isPublic("verified", "verified")).toBe(true);
    expect(isPublic("verified", "needs_review")).toBe(false);
    expect(isPublic("needs_review", "verified")).toBe(false);
    expect(isPublic("rejected", "verified")).toBe(false);
  });
});

describe("nextStatus", () => {
  it.each([
    ["needs_review", "verify", "verified"],
    ["verified", "verify", "verified"],
    ["needs_review", "reject", "rejected"],
    ["verified", "reject", "rejected"],
    ["verified", "reopen", "needs_review"],
    ["rejected", "reopen", "needs_review"],
  ] as const)("%s + %s → %s", (from, action, to) => expect(nextStatus(from, action)).toBe(to));

  it.each([
    ["rejected", "verify"],
    ["rejected", "reject"],
    ["needs_review", "reopen"],
  ] as const)("refuses %s + %s", (from, action) => expect(nextStatus(from, action)).toBeNull());
});

describe("reviewInputSchema", () => {
  it("needs a checked page to verify and a reason to reject", () => {
    expect(reviewInputSchema.safeParse({ action: "verify" }).success).toBe(false);
    expect(reviewInputSchema.safeParse({ action: "verify", checked_url: "https://a.example/x" }).success).toBe(true);
    expect(reviewInputSchema.safeParse({ action: "verify", checked_url: "javascript:alert(1)" }).success).toBe(false);
    expect(reviewInputSchema.safeParse({ action: "reject" }).success).toBe(false);
    expect(reviewInputSchema.safeParse({ action: "reject", reason: "Duplicate" }).success).toBe(true);
    expect(reviewInputSchema.safeParse({ action: "reopen" }).success).toBe(true);
  });
});

describe("signalInputSchema", () => {
  const ok = {
    company_domain: "acme.example",
    signal_type: "partner_program_launched",
    title: "Launched a developer partner program",
    factual_claim: "Acme opened applications for integration partners.",
    source_excerpt: "Today we're opening our partner program to developers.",
    primary_source: { url: "https://acme.example/blog/partners", kind: "announcement", title: "Partners" },
  };

  it("accepts a complete signal", () => {
    expect(signalInputSchema.safeParse(ok).success).toBe(true);
  });
  it("refuses funding as a signal type", () => {
    const r = signalInputSchema.safeParse({ ...ok, signal_type: "funding_raised" });
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toMatch(/funding is not a signal type/);
  });
  it("needs a claim, an excerpt and a primary source", () => {
    for (const field of ["factual_claim", "source_excerpt", "primary_source"]) {
      const { [field]: _omit, ...rest } = ok as Record<string, unknown>;
      expect(signalInputSchema.safeParse(rest).success, field).toBe(false);
    }
  });
  it("can't be submitted as already verified", () => {
    expect(signalInputSchema.safeParse({ ...ok, status: "verified" }).success).toBe(false);
  });
});
