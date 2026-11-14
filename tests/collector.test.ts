import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  backoffHours,
  pageFingerprint,
  parseFeed,
  parseGithubReleases,
  parseGithubRepo,
  parseKeyMap,
  parseMcpRegistry,
  suggestSignalType,
  toIsoDate,
  toText,
  watchedSourceInputSchema,
} from "../shared/collector.ts";

const RSS = `<?xml version="1.0"?><rss><channel><title>Blog</title>
<item><title><![CDATA[Introducing the Acme Partner Program]]></title><link>https://acme.example/blog/partners</link>
<pubDate>Mon, 10 Nov 2026 09:00:00 GMT</pubDate><description>&lt;p&gt;Become a partner &amp;amp; grow.&lt;/p&gt;</description></item>
<item><title>Bad link</title><link>javascript:alert(1)</link></item>
<item><title>No link but guid</title><guid>https://acme.example/post-2</guid></item>
</channel></rss>`;

const ATOM = `<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>Now live on Base</title>
<link rel="self" href="https://acme.example/self"/><link rel="alternate" href="https://acme.example/base-launch"/>
<updated>2026-11-12T10:00:00Z</updated><summary>We deploy to Base mainnet.</summary></entry></feed>`;

describe("parseFeed", () => {
  it("reads RSS items, decodes text and skips unsafe links", () => {
    const items = parseFeed(RSS);
    expect(items.map((i) => i.url)).toEqual(["https://acme.example/blog/partners", "https://acme.example/post-2"]);
    expect(items[0]).toMatchObject({
      title: "Introducing the Acme Partner Program",
      published_at: "2026-11-10",
      excerpt: "Become a partner & grow.",
    });
  });

  it("reads Atom entries using the alternate link", () => {
    expect(parseFeed(ATOM)).toEqual([
      {
        url: "https://acme.example/base-launch",
        title: "Now live on Base",
        published_at: "2026-11-12",
        excerpt: "We deploy to Base mainnet.",
        domain: null,
      },
    ]);
  });

  it("returns nothing for something that isn't a feed", () => {
    expect(parseFeed("<html><body>hello</body></html>")).toEqual([]);
  });
});

describe("helpers", () => {
  it("toText strips scripts, tags and entities", () => {
    expect(toText("<p>Hi <script>evil()</script><b>there</b> &amp; &#39;you&#39;</p>")).toBe("Hi there & 'you'");
  });
  it("toIsoDate handles feed dates and junk", () => {
    expect(toIsoDate("Tue, 11 Nov 2026 08:00:00 +0000")).toBe("2026-11-11");
    expect(toIsoDate("not a date")).toBeNull();
    expect(toIsoDate(null)).toBeNull();
  });
  it("parseGithubRepo only accepts repository links", () => {
    expect(parseGithubRepo("https://github.com/coinbase/x402")).toEqual({ owner: "coinbase", repo: "x402" });
    expect(parseGithubRepo("https://github.com/coinbase")).toBeNull();
    expect(parseGithubRepo("https://gitlab.com/a/b")).toBeNull();
  });
  it("backoff doubles per failure and caps at a week", () => {
    expect(backoffHours(24, 1)).toBe(48);
    expect(backoffHours(24, 2)).toBe(96);
    expect(backoffHours(24, 9)).toBe(168);
  });
});

describe("parseGithubReleases", () => {
  it("lists published releases and skips drafts", () => {
    const items = parseGithubReleases(
      [
        {
          html_url: "https://github.com/o/r/releases/tag/v2.0.0",
          name: "v2.0.0",
          tag_name: "v2.0.0",
          published_at: "2026-11-01T00:00:00Z",
          body: "## New SDK\n* faster",
        },
        { html_url: "https://github.com/o/r/releases/tag/v3", name: null, tag_name: "v3", draft: true },
      ],
      "o/r",
    );
    expect(items).toEqual([
      {
        url: "https://github.com/o/r/releases/tag/v2.0.0",
        title: "o/r v2.0.0",
        published_at: "2026-11-01",
        excerpt: "New SDK faster",
        domain: null,
      },
    ]);
  });
  it("throws on an unexpected shape", () => {
    expect(() => parseGithubReleases({ message: "rate limited" }, "o/r")).toThrow();
  });
});

describe("parseMcpRegistry", () => {
  it("reads wrapped and plain entries, preferring the website link", () => {
    const items = parseMcpRegistry(
      {
        servers: [
          {
            server: {
              name: "io.acme/tools",
              title: "Acme Tools",
              description: "Tools for agents",
              websiteUrl: "https://www.acme.example/mcp",
              repository: { url: "https://github.com/acme/mcp" },
            },
            _meta: { "io.modelcontextprotocol.registry/official": { publishedAt: "2026-11-09T12:00:00Z" } },
          },
          { name: "io.beta/server", repository: { url: "https://github.com/beta/server" } },
          { server: { description: "no name: skipped" } },
        ],
      },
      "https://registry.modelcontextprotocol.io/v0/servers",
    );
    expect(items).toEqual([
      {
        url: "https://www.acme.example/mcp",
        title: "MCP server published: Acme Tools",
        published_at: "2026-11-09",
        excerpt: "Tools for agents",
        domain: "acme.example",
      },
      {
        url: "https://github.com/beta/server",
        title: "MCP server published: io.beta/server",
        published_at: null,
        excerpt: null,
        domain: null,
      },
    ]);
  });
  it("throws when the response isn't a server list", () => {
    expect(() => parseMcpRegistry({ data: [] }, "https://x.example")).toThrow();
  });
});

describe("parseKeyMap", () => {
  it("turns registry keys into links", () => {
    expect(
      parseKeyMap({ "@acme/plugin-x": "github:acme/plugin-x", other: "https://other.example/p" }, "New plugin"),
    ).toEqual([
      {
        key: "@acme/plugin-x",
        item: {
          url: "https://github.com/acme/plugin-x",
          title: "New plugin: @acme/plugin-x",
          published_at: null,
          excerpt: null,
          domain: null,
        },
      },
      {
        key: "other",
        item: {
          url: "https://other.example/p",
          title: "New plugin: other",
          published_at: null,
          excerpt: null,
          domain: null,
        },
      },
    ]);
  });
});

describe("pageFingerprint", () => {
  it("ignores markup and scripts, notices text changes", async () => {
    const a = await pageFingerprint(
      "<html><head><title>Partners</title><script>x=1</script></head><body><p>Join  us</p></body></html>",
    );
    const b = await pageFingerprint(
      "<html><head><title>Partners</title><script>x=2</script></head><body><div>Join us</div></body></html>",
    );
    const c = await pageFingerprint(
      "<html><head><title>Partners</title></head><body><p>Join us today</p></body></html>",
    );
    expect(a.hash).toBe(b.hash);
    expect(a.hash).not.toBe(c.hash);
    expect(a.title).toBe("Partners");
  });
});

describe("suggestSignalType", () => {
  it.each([
    ["We're looking for partners to build on our API", "collaboration_request"],
    ["Introducing the Acme Partner Program", "partner_program_launched"],
    ["Acme integrates with Stripe", "integration_announced"],
    ["Acme is now live on Base", "ecosystem_expansion"],
    ["Hiring: Head of Partnerships", "partnerships_role_posted"],
    ["Python SDK v2 released", "api_or_sdk_released"],
    ["Announcing Acme Cloud", "product_launched"],
  ])("%s → %s", (title, type) => expect(suggestSignalType({ title, excerpt: null }, null)).toBe(type));

  it("falls back to the source's hint, or nothing", () => {
    expect(suggestSignalType({ title: "o/r 1.2.3", excerpt: "bug fixes" }, "api_or_sdk_released")).toBe(
      "api_or_sdk_released",
    );
    expect(suggestSignalType({ title: "Weekly notes", excerpt: null }, null)).toBeNull();
  });

  it("never suggests funding", () => {
    expect(suggestSignalType({ title: "Acme raises $10M Series A", excerpt: null }, null)).toBeNull();
  });
});

describe("watched sources input and the approved seed list", () => {
  it("needs https and a reason Talo may read the source", () => {
    const base = {
      name: "x",
      adapter: "rss",
      url: "https://a.example/feed",
      terms_note: "Public RSS feed for syndication.",
    };
    expect(watchedSourceInputSchema.safeParse(base).success).toBe(true);
    expect(watchedSourceInputSchema.safeParse({ ...base, url: "http://a.example/feed" }).success).toBe(false);
    expect(watchedSourceInputSchema.safeParse({ ...base, terms_note: "ok" }).success).toBe(false);
  });

  it("has the 14 approved sources, all valid, unconfirmed ones paused", () => {
    const seeds = JSON.parse(readFileSync(new URL("../seeds/watched-sources.json", import.meta.url), "utf8"));
    expect(seeds.sources).toHaveLength(14);
    for (const s of seeds.sources) {
      const parsed = watchedSourceInputSchema.safeParse(s);
      expect(parsed.success, s.name).toBe(true);
      if (/to confirm/i.test(s.terms_note)) expect(parsed.data?.enabled, s.name).toBe(false);
    }
  });
});
