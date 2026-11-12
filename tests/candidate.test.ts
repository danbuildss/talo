import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildSchemaJson } from "../scripts/schema-json.ts";
import { type CandidateInput, normalizeDomain } from "../shared/candidate.ts";
import { evaluate } from "../shared/scoring.ts";
import { findDuplicates, validateCandidateFile } from "../shared/validate.ts";

const NOW = new Date("2026-11-12T12:00:00Z");
const sample = JSON.parse(readFileSync(new URL("../samples/candidates.sample.json", import.meta.url), "utf8"));

function minimal(overrides: Record<string, unknown> = {}): CandidateInput {
  return {
    company_name: "Test Co (fictional)",
    domain: "test.example",
    industry: "Dev tools",
    partnership_type: "integration",
    sources: [],
    research_timestamp: "2026-11-12T10:00:00Z",
    evidence_summary: "Nothing yet.",
    scores: {},
    mutual_benefits: { for_client: "a", for_partner: "b" },
    recommended_next_action: "Research.",
    ...overrides,
  } as CandidateInput;
}

const file = (...candidates: unknown[]) => ({ format: "talo.candidates.v1", candidates });

describe("normalizeDomain", () => {
  it.each([
    ["example.com", "example.com"],
    ["https://www.Example.com/partners?x=1", "example.com"],
    ["http://docs.example.com:8080/a", "docs.example.com"],
    ["EXAMPLE.COM.", "example.com"],
    ["  www.sub.example.io  ", "sub.example.io"],
  ])("%s → %s", (input, expected) => {
    expect(normalizeDomain(input)).toBe(expected);
  });

  it.each(["", "not a domain", "localhost", "javascript:alert(1)", "ftp://example.com", "1.2.3.4"])(
    "rejects %j",
    (input) => {
      expect(normalizeDomain(input)).toBeNull();
    },
  );
});

describe("validateCandidateFile", () => {
  it("accepts the fictional sample file and normalizes its domains", () => {
    const result = validateCandidateFile(sample);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.candidates.map((c) => c.domain)).toEqual(["northwind.example", "lumenledger.example"]);
    expect(result.candidates.every((c) => c.is_sample)).toBe(true);
    expect(result.duplicates).toEqual([]);
  });

  it("scores the sample as expected", () => {
    const result = validateCandidateFile(sample);
    if (!result.ok) throw new Error("sample should be valid");
    const [northwind, lumen] = result.candidates.map((c) => evaluate(c, NOW));
    expect(northwind?.overall_score).toBe(73);
    expect(northwind?.evidence_confidence).toBe("medium");
    expect(northwind?.verification_status).toBe("ready");
    expect(lumen?.overall_score).toBeNull();
    expect(lumen?.verification_status).toBe("needs_verification");
  });

  it("applies defaults", () => {
    const result = validateCandidateFile(file(minimal()));
    if (!result.ok) throw new Error("should be valid");
    expect(result.candidates[0]?.pipeline_stage).toBe("discovered");
    expect(result.candidates[0]?.is_sample).toBe(false);
    expect(result.candidates[0]?.risks).toEqual([]);
  });

  it("rejects a supplied overall score with a plain explanation", () => {
    const result = validateCandidateFile(file({ ...minimal(), overall_score: 95 }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]?.path).toBe("candidates[0]");
    expect(result.errors[0]?.message).toMatch(/overall_score can't be supplied/);
  });

  it.each([
    ["score above 5", { scores: { alignment: { score: 6, reason: "r" } } }, "candidates[0].scores.alignment.score"],
    [
      "fractional score",
      { scores: { alignment: { score: 3.5, reason: "r" } } },
      "candidates[0].scores.alignment.score",
    ],
    [
      "score without reason",
      { scores: { alignment: { score: 3, reason: "" } } },
      "candidates[0].scores.alignment.reason",
    ],
    ["unknown factor", { scores: { vibes: { score: 3, reason: "r" } } }, "candidates[0].scores"],
    ["bad domain", { domain: "not a domain" }, "candidates[0].domain"],
    ["bad partnership type", { partnership_type: "merger" }, "candidates[0].partnership_type"],
  ])("rejects %s", (_name, overrides, path) => {
    const result = validateCandidateFile(file(minimal(overrides)));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.map((e) => e.path)).toContain(path);
  });

  it.each(["javascript:alert(1)", "data:text/html,hi", "example.com/no-scheme", "ftp://example.com/f"])(
    "rejects source url %j",
    (url) => {
      const result = validateCandidateFile(
        file(
          minimal({
            sources: [{ url, title: "t", accessed_at: "2026-11-10", summary: "s", claim_type: "verified" }],
          }),
        ),
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.errors.map((e) => e.path)).toContain("candidates[0].sources[0].url");
    },
  );

  it("rejects a source without an access date", () => {
    const result = validateCandidateFile(
      file(minimal({ sources: [{ url: "https://a.example", title: "t", summary: "s", claim_type: "verified" }] })),
    );
    expect(result.ok).toBe(false);
  });

  it("rejects the whole file if one candidate is bad (all or nothing)", () => {
    const result = validateCandidateFile(file(minimal(), minimal({ domain: "" })));
    expect(result.ok).toBe(false);
  });

  it("rejects an empty file and a wrong format tag", () => {
    expect(validateCandidateFile(file()).ok).toBe(false);
    expect(validateCandidateFile({ format: "other", candidates: [minimal()] }).ok).toBe(false);
    expect(validateCandidateFile("not an object").ok).toBe(false);
  });
});

describe("duplicates", () => {
  it("flags candidates that share a domain after normalization", () => {
    const result = validateCandidateFile(
      file(
        minimal({ domain: "https://www.acme.example" }),
        minimal({ domain: "other.example" }),
        minimal({ domain: "ACME.example/partners" }),
      ),
    );
    if (!result.ok) throw new Error("should be valid");
    expect(result.duplicates).toEqual([{ domain: "acme.example", indexes: [0, 2] }]);
  });

  it("returns nothing when all domains differ", () => {
    expect(findDuplicates([{ domain: "a.example" }, { domain: "b.example" }])).toEqual([]);
  });
});

describe("JSON Schema file", () => {
  it("is up to date with shared/candidate.ts (run npm run schema)", () => {
    const committed = readFileSync(new URL("../schemas/candidate-file.schema.json", import.meta.url), "utf8");
    expect(committed).toBe(buildSchemaJson());
  });
});
