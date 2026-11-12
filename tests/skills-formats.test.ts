import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { checkResearch } from "../scripts/check-research.ts";
import { buildSchemas } from "../scripts/schema-json.ts";
import { companyProfileSchema } from "../shared/company.ts";
import { outreachFileSchema } from "../shared/outreach.ts";

const NOW = new Date("2026-11-12T12:00:00Z");
const load = (name: string) => JSON.parse(readFileSync(new URL(`../samples/${name}`, import.meta.url), "utf8"));

const company = load("company.sample.json");
const candidates = load("candidates.sample.json");
const outreach = load("outreach.sample.json");

describe("company profile (talo.company.v1)", () => {
  it("accepts the fictional sample", () => {
    expect(companyProfileSchema.safeParse(company).success).toBe(true);
  });

  it("needs at least one sourced claim", () => {
    expect(companyProfileSchema.safeParse({ ...company, claims: [] }).success).toBe(false);
  });

  it("rejects a claim without an http(s) link", () => {
    const bad = { ...company, claims: [{ ...company.claims[0], url: "javascript:alert(1)" }] };
    expect(companyProfileSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects unknown partnership goals", () => {
    expect(companyProfileSchema.safeParse({ ...company, partnership_goals: ["acquisition"] }).success).toBe(false);
  });
});

describe("outreach drafts (talo.outreach.v1)", () => {
  const draft = outreach.drafts[0];
  const withDraft = (d: Record<string, unknown>) => ({ ...outreach, drafts: [{ ...draft, ...d }] });

  it("accepts the fictional sample and defaults every draft to 'draft'", () => {
    const parsed = outreachFileSchema.safeParse(outreach);
    expect(parsed.success).toBe(true);
    expect(parsed.data?.drafts.every((d) => d.approval_status === "draft")).toBe(true);
  });

  it("never lets research mark a draft approved", () => {
    expect(outreachFileSchema.safeParse(withDraft({ approval_status: "approved" })).success).toBe(false);
  });

  it("refuses a named recipient without a public source", () => {
    const result = outreachFileSchema.safeParse(withDraft({ recipient: { name: "Alex Doe", role: "Head of BD" } }));
    expect(result.success).toBe(false);
  });

  it("allows a recipient with only a public channel", () => {
    const result = outreachFileSchema.safeParse(withDraft({ recipient: { public_channel: "partner form" } }));
    expect(result.success).toBe(true);
  });

  it("keeps openers short", () => {
    expect(outreachFileSchema.safeParse(withDraft({ message: "x".repeat(1201) })).success).toBe(false);
    expect(outreachFileSchema.safeParse(withDraft({ purpose: "proposal", message: "x".repeat(1201) })).success).toBe(
      true,
    );
  });

  it("requires a subject for email", () => {
    expect(outreachFileSchema.safeParse(withDraft({ channel: "email", subject: undefined })).success).toBe(false);
  });
});

describe("checkResearch", () => {
  it("summarises a company profile", () => {
    const report = checkResearch(company, NOW);
    expect(report.ok).toBe(true);
    expect(report.lines[0]).toMatch(/Company profile: .* \(acme-agents\.example\)/);
  });

  it("ranks candidates by score and explains Needs verification", () => {
    const report = checkResearch(candidates, NOW);
    expect(report.ok).toBe(true);
    expect(report.lines[1]).toMatch(/^\s+73\s+Northwind Agents/);
    expect(report.lines.join("\n")).toMatch(/Lumen Ledger.*Needs verification/);
    expect(report.lines.join("\n")).toMatch(/Partnership readiness has no score yet/);
  });

  it("summarises outreach drafts", () => {
    const report = checkResearch(outreach, NOW);
    expect(report.ok).toBe(true);
    expect(report.lines[0]).toMatch(/awaiting approval/);
  });

  it("reports invalid files with paths", () => {
    const report = checkResearch({ ...outreach, drafts: [{ ...outreach.drafts[0], approval_status: "sent" }] }, NOW);
    expect(report.ok).toBe(false);
    expect(report.lines.join("\n")).toMatch(/drafts\[0\]\.approval_status/);
  });

  it("rejects unknown formats", () => {
    expect(checkResearch({ format: "nope" }, NOW).ok).toBe(false);
    expect(checkResearch(null, NOW).ok).toBe(false);
  });
});

describe("JSON Schema files", () => {
  it.each(Object.entries(buildSchemas()))("schemas/%s is up to date (run npm run schema)", (file, text) => {
    expect(readFileSync(new URL(`../schemas/${file}`, import.meta.url), "utf8")).toBe(text);
  });
});
