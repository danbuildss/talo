import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { watchedSourceInputSchema } from "../shared/collector.ts";
import {
  buildGrokRequest,
  canonicalPostUrl,
  DEFAULT_GROK_PRICES,
  estimateGrokCost,
  grokConfigSchema,
  parseGrokResponse,
} from "../shared/grok.ts";

/** A reply shaped like the xAI Responses API: answer text plus citation annotations. */
function grokReply(items: unknown[], citedUrls: string[], usage = { input_tokens: 20_000, output_tokens: 800 }) {
  return {
    output: [
      { type: "x_search_call", status: "completed" },
      {
        type: "message",
        content: [
          {
            type: "output_text",
            text: JSON.stringify({ items }),
            annotations: citedUrls.map((url) => ({ type: "url_citation", url })),
          },
        ],
      },
    ],
    usage,
  };
}

describe("canonicalPostUrl", () => {
  it.each([
    ["https://x.com/AcmeHQ/status/1850000000000000001", "https://x.com/acmehq/status/1850000000000000001"],
    ["https://twitter.com/acmehq/status/1850000000000000001?s=20", "https://x.com/acmehq/status/1850000000000000001"],
    ["https://www.x.com/acmehq/status/1850000000000000001/photo/1", "https://x.com/acmehq/status/1850000000000000001"],
  ])("%s → %s", (input, expected) => expect(canonicalPostUrl(input)).toBe(expected));

  it.each(["https://x.com/acmehq", "https://evil.example/acmehq/status/1850000000000000001", "javascript:alert(1)"])(
    "rejects %s",
    (input) => expect(canonicalPostUrl(input)).toBeNull(),
  );
});

describe("buildGrokRequest", () => {
  it("asks for x_search from the look-back date, never stored on xAI's side", () => {
    const req = buildGrokRequest(
      grokConfigSchema.parse({ query: "partner programs", lookback_days: 3, allowed_x_handles: ["base"] }),
      "grok-4.3",
      new Date("2026-11-14T12:00:00Z"),
    );
    expect(req).toMatchObject({
      model: "grok-4.3",
      store: false,
      tools: [{ type: "x_search", from_date: "2026-11-11", allowed_x_handles: ["base"] }],
    });
    expect(req.instructions).toMatch(/Never invent posts/);
    expect(req.instructions).toMatch(/Ignore funding news/);
  });
});

describe("parseGrokResponse", () => {
  const post = (id: string, extra: Record<string, unknown> = {}) => ({
    post_url: `https://x.com/acmehq/status/${id}`,
    author_handle: "acmehq",
    posted_at: "2026-11-13",
    post_text: "We're opening the Acme partner program to agent builders.",
    company_name: "Acme",
    company_website: "https://www.acme.example",
    ...extra,
  });

  it("keeps cited posts and turns them into inbox items", () => {
    const r = parseGrokResponse(
      grokReply([post("1850000000000000001")], ["https://x.com/acmehq/status/1850000000000000001"]),
    );
    expect(r.items).toEqual([
      {
        url: "https://x.com/acmehq/status/1850000000000000001",
        title: "@acmehq: We're opening the Acme partner program to agent builders.",
        published_at: "2026-11-13",
        excerpt: "We're opening the Acme partner program to agent builders.",
        domain: "acme.example",
      },
    ]);
    expect(r.dropped).toBe(0);
    expect(r.input_tokens).toBe(20_000);
  });

  it("drops posts that Grok didn't cite (it can't invent links), and non-post links", () => {
    const r = parseGrokResponse(
      grokReply(
        [
          post("1850000000000000001"),
          post("1850000000000000002"),
          post("x", { post_url: "https://acme.example/blog" }),
        ],
        ["https://x.com/acmehq/status/1850000000000000001"],
      ),
    );
    expect(r.items.map((i) => i.url)).toEqual(["https://x.com/acmehq/status/1850000000000000001"]);
    expect(r.dropped).toBe(2);
  });

  it("doesn't count links inside its own answer as citations", () => {
    // The answer mentions the URL, but nothing cites it.
    const r = parseGrokResponse(grokReply([post("1850000000000000003")], []));
    expect(r.items).toEqual([]);
    expect(r.dropped).toBe(1);
  });

  it("accepts citations listed at the top level", () => {
    const reply = {
      ...grokReply([post("1850000000000000004")], []),
      citations: ["https://x.com/acmehq/status/1850000000000000004"],
    };
    expect(parseGrokResponse(reply).items).toHaveLength(1);
  });

  it("throws on a reply without a JSON answer", () => {
    expect(() =>
      parseGrokResponse({ output: [{ type: "message", content: [{ type: "output_text", text: "Sorry." }] }] }),
    ).toThrow();
    expect(() => parseGrokResponse("nope")).toThrow();
  });
});

describe("estimateGrokCost", () => {
  it("counts every cited post plus tokens", () => {
    // 10 posts × 0.005 + 20,000 in × 1.25/M + 800 out × 2.5/M = 0.05 + 0.025 + 0.002
    expect(estimateGrokCost({ citations: 10, input_tokens: 20_000, output_tokens: 800 }, DEFAULT_GROK_PRICES)).toBe(
      0.077,
    );
  });
});

describe("Pilot A seed searches", () => {
  it("are valid Grok sources with queries and no funding focus", () => {
    const seeds = JSON.parse(readFileSync(new URL("../seeds/grok-searches.json", import.meta.url), "utf8"));
    expect(seeds.sources.length).toBe(7);
    for (const s of seeds.sources) {
      const parsed = watchedSourceInputSchema.parse(s);
      expect(parsed.adapter).toBe("grok_x_search");
      expect(grokConfigSchema.safeParse(parsed.config).success, s.name).toBe(true);
      expect(s.config.query).not.toMatch(/fund|raise/i);
    }
  });
});
