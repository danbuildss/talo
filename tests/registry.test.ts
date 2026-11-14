import { describe, expect, it } from "vitest";
import {
  aliasesFor,
  companyInputSchema,
  findNearDuplicates,
  normalizeAlias,
  normalizeName,
  normalizeUrl,
  slugify,
} from "../shared/registry.ts";

describe("normalizeName", () => {
  it.each([
    ["Acme, Inc.", "acme"],
    ["ACME Inc", "acme"],
    ["Acme Labs", "acmelabs"],
    ["Nous Research", "nousresearch"],
    ["Café AI Ltd", "cafeai"],
    ["Northwind Agents (fictional)", "northwindagents"],
  ])("%s → %s", (input, expected) => expect(normalizeName(input)).toBe(expected));
});

describe("normalizeAlias", () => {
  it.each([
    ["domain", "https://www.Acme.com/about", "acme.com"],
    ["github_org", "https://github.com/Acme-Labs/repo", "acme-labs"],
    ["github_org", "acme-labs", "acme-labs"],
    ["x_handle", "@AcmeHQ", "acmehq"],
    ["x_handle", "https://x.com/AcmeHQ/status/1", "acmehq"],
    ["x_handle", "https://twitter.com/acmehq", "acmehq"],
  ] as const)("%s %s → %s", (kind, input, expected) => expect(normalizeAlias(kind, input)).toBe(expected));

  it.each([
    ["name", "!"],
    ["domain", "not a domain"],
    ["github_org", "-bad-"],
    ["x_handle", "way_too_long_handle_name"],
  ] as const)("rejects %s %j", (kind, input) => expect(normalizeAlias(kind, input)).toBeNull());
});

describe("normalizeUrl", () => {
  it.each([
    ["https://www.Example.com/", "https://example.com"],
    ["https://example.com/blog/post/", "https://example.com/blog/post"],
    ["https://example.com/p?utm_source=x&b=2&a=1#top", "https://example.com/p?a=1&b=2"],
    ["https://example.com/?ref=hn", "https://example.com"],
    ["http://Docs.Example.com/x", "http://docs.example.com/x"],
  ])("%s → %s", (input, expected) => expect(normalizeUrl(input)).toBe(expected));

  it.each(["javascript:alert(1)", "ftp://example.com", "not a url"])("rejects %j", (input) =>
    expect(normalizeUrl(input)).toBeNull(),
  );

  it("treats tracking variants as one URL", () => {
    expect(normalizeUrl("https://www.acme.com/launch?utm_campaign=a")).toBe(normalizeUrl("https://acme.com/launch/"));
  });
});

describe("slugify", () => {
  it.each([
    ["Acme Labs", "acme-labs"],
    ["Northwind Agents (fictional)", "northwind-agents"],
    ["Café — AI!", "cafe-ai"],
    ["!!!", "company"],
  ])("%s → %s", (input, expected) => expect(slugify(input)).toBe(expected));
});

describe("companyInputSchema and aliasesFor", () => {
  it("normalizes the domain and collects name, domain and extra aliases once each", () => {
    const input = companyInputSchema.parse({
      name: "Acme, Inc.",
      domain: "https://www.acme.com",
      aliases: [
        { kind: "name", value: "ACME" },
        { kind: "github_org", value: "acme-hq" },
        { kind: "domain", value: "acme.com" },
      ],
    });
    expect(input.domain).toBe("acme.com");
    expect(aliasesFor(input)).toEqual([
      { kind: "name", value: "acme" },
      { kind: "domain", value: "acme.com" },
      { kind: "github_org", value: "acme-hq" },
    ]);
  });

  it("rejects invalid aliases, unknown fields and non-http sources", () => {
    expect(
      companyInputSchema.safeParse({ name: "A", domain: "a.com", aliases: [{ kind: "x_handle", value: "!!" }] })
        .success,
    ).toBe(false);
    expect(companyInputSchema.safeParse({ name: "A", domain: "a.com", status: "verified" }).success).toBe(false);
    expect(
      companyInputSchema.safeParse({
        name: "A",
        domain: "a.com",
        sources: [{ url: "javascript:x", kind: "website", title: "t" }],
      }).success,
    ).toBe(false);
  });
});

describe("findNearDuplicates", () => {
  const co = (id: string, name: string, primary_domain: string) => ({ id, name, primary_domain });

  it("flags the same domain name on different endings", () => {
    expect(findNearDuplicates([co("1", "Acme", "acme.ai"), co("2", "Acme Labs", "acme.com")])).toEqual([
      { a: "1", b: "2", reason: 'same domain name "acme" on different endings' },
    ]);
  });

  it("flags names one letter apart", () => {
    const pairs = findNearDuplicates([co("1", "Northwind", "nw.com"), co("2", "Northwnd", "northwnd.io")]);
    expect(pairs).toHaveLength(1);
  });

  it("leaves clearly different companies alone", () => {
    expect(
      findNearDuplicates([co("1", "Acme", "acme.com"), co("2", "Globex", "globex.com"), co("3", "Base", "base.org")]),
    ).toEqual([]);
  });
});
