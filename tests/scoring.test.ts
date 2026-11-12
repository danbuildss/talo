import { describe, expect, it } from "vitest";
import { FACTORS, type Scores, type Source } from "../shared/candidate.ts";
import { evaluate, evidenceConfidence, fitScore, WEIGHTS } from "../shared/scoring.ts";

const NOW = new Date("2026-11-12T12:00:00Z");

function allScores(score: number): Scores {
  return Object.fromEntries(FACTORS.map((f) => [f, { score, reason: "test" }])) as Scores;
}

function source(overrides: Partial<Source> = {}): Source {
  return {
    url: "https://a.example/page",
    title: "t",
    published_at: null,
    accessed_at: "2026-11-10",
    summary: "s",
    claim_type: "verified",
    supports: [...FACTORS],
    ...overrides,
  };
}

describe("fitScore", () => {
  it("weights add up to 100", () => {
    expect(Object.values(WEIGHTS).reduce((a, b) => a + b, 0)).toBe(100);
  });

  it.each([
    [0, 0],
    [3, 60],
    [4, 80],
    [5, 100],
  ])("all factors at %i gives %i", (score, expected) => {
    expect(fitScore(allScores(score))).toBe(expected);
  });

  it("matches the worked example in the brand sketch (4,4,3,3,4 → 73)", () => {
    expect(
      fitScore({
        alignment: { score: 4, reason: "r" },
        mutual_value: { score: 4, reason: "r" },
        readiness: { score: 3, reason: "r" },
        contact_access: { score: 3, reason: "r" },
        feasibility: { score: 4, reason: "r" },
      }),
    ).toBe(73);
  });

  it("weights alignment more than feasibility", () => {
    const a = fitScore({ ...allScores(0), alignment: { score: 5, reason: "r" } });
    const f = fitScore({ ...allScores(0), feasibility: { score: 5, reason: "r" } });
    expect(a).toBe(30);
    expect(f).toBe(10);
  });

  it("returns null when any factor is missing", () => {
    const { feasibility: _omit, ...partial } = allScores(5);
    expect(fitScore(partial)).toBeNull();
  });
});

describe("evidenceConfidence", () => {
  it("is high with verified support for every factor, two sites, all fresh", () => {
    const sources = [source(), source({ url: "https://b.example/x" })];
    expect(evidenceConfidence({ sources, scores: allScores(4) }, NOW)).toBe("high");
  });

  it("is not high when all sources come from one site", () => {
    const sources = [source(), source({ url: "https://www.a.example/other" })];
    expect(evidenceConfidence({ sources, scores: allScores(4) }, NOW)).toBe("medium");
  });

  it("is not high when a source is older than 90 days", () => {
    const sources = [source(), source({ url: "https://b.example/x", accessed_at: "2026-08-01" })];
    expect(evidenceConfidence({ sources, scores: allScores(4) }, NOW)).toBe("medium");
  });

  it("is medium when only alignment and readiness are verified", () => {
    const sources = [
      source({ supports: ["alignment", "readiness"] }),
      source({ url: "https://b.example/x", claim_type: "inference", supports: ["mutual_value"] }),
    ];
    expect(evidenceConfidence({ sources, scores: allScores(4) }, NOW)).toBe("medium");
  });

  it("is low when readiness has only inference", () => {
    const sources = [source({ supports: ["alignment"] }), source({ claim_type: "inference", supports: ["readiness"] })];
    expect(evidenceConfidence({ sources, scores: allScores(4) }, NOW)).toBe("low");
  });

  it("is low with no sources", () => {
    expect(evidenceConfidence({ sources: [], scores: allScores(5) }, NOW)).toBe("low");
  });

  it("is low when a factor is unscored, even with great sources", () => {
    const { contact_access: _omit, ...partial } = allScores(5);
    const sources = [source(), source({ url: "https://b.example/x" })];
    expect(evidenceConfidence({ sources, scores: partial }, NOW)).toBe("low");
  });
});

describe("evaluate", () => {
  it("is ready with a score when evidence is medium or better", () => {
    const result = evaluate({ sources: [source(), source({ url: "https://b.example/x" })], scores: allScores(4) }, NOW);
    expect(result.overall_score).toBe(80);
    expect(result.verification_status).toBe("ready");
    expect(result.issues).toEqual([]);
    expect(result.breakdown.map((b) => b.points)).toEqual([24, 20, 16, 12, 8]);
  });

  it("needs verification when evidence is low, even with a high score", () => {
    const result = evaluate({ sources: [], scores: allScores(5) }, NOW);
    expect(result.overall_score).toBe(100);
    expect(result.verification_status).toBe("needs_verification");
    expect(result.issues).toContain("No sources yet");
    expect(result.issues).toContain("Partnership readiness has no verified source");
  });

  it("needs verification and names the missing factor", () => {
    const { readiness: _omit, ...partial } = allScores(4);
    const result = evaluate({ sources: [source()], scores: partial }, NOW);
    expect(result.overall_score).toBeNull();
    expect(result.verification_status).toBe("needs_verification");
    expect(result.issues).toContain("Partnership readiness has no score yet");
  });

  it("is deterministic", () => {
    const input = { sources: [source()], scores: allScores(3) };
    expect(evaluate(input, NOW)).toEqual(evaluate(input, NOW));
  });
});
