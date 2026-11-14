/**
 * Collector building blocks that don't touch the network or the database:
 * feed/API parsers, page fingerprints and the keyword rules that suggest a
 * signal type. Suggestions are only hints for a reviewer; nothing here verifies.
 */
import { z } from "zod";
import { normalizeDomain } from "./candidate.ts";
import { SIGNAL_TYPE_SLUGS, type SignalType } from "./signals.ts";

export const ADAPTERS = ["rss", "github_releases", "page_watch", "registry_listing"] as const;
export type Adapter = (typeof ADAPTERS)[number];

/** One thing a source published. */
export interface CollectedItem {
  url: string;
  title: string;
  published_at: string | null;
  excerpt: string | null;
  /** The website of the company the item is about, when it can be told from the item. */
  domain: string | null;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1]?.toLowerCase() === "x" ? Number.parseInt(e.slice(2), 16) : Number.parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** Plain text from HTML or markup: no tags, scripts or styles; collapsed spaces. */
export function toText(html: string): string {
  return decodeEntities(
    html
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
      .replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, " ")
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/\s+/g, " ")
    .trim();
}

export function excerpt(text: string | null | undefined, max = 500): string | null {
  if (!text) return null;
  const t = text.trim();
  if (!t) return null;
  return t.length <= max ? t : `${t.slice(0, max - 1).replace(/\s+\S*$/, "")}…`;
}

/** YYYY-MM-DD from any date string a feed might use, or null. */
export function toIsoDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const t = Date.parse(value.trim());
  return Number.isNaN(t) ? null : new Date(t).toISOString().slice(0, 10);
}

function tag(block: string, name: string): string | null {
  const m = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i"));
  return m?.[1] ?? null;
}

function httpOnly(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url.trim());
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : null;
  } catch {
    return null;
  }
}

/** RSS 2.0 and Atom. Items without a usable http(s) link are skipped. */
export function parseFeed(xml: string): CollectedItem[] {
  const items: CollectedItem[] = [];
  const blocks = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) ?? xml.match(/<entry[\s>][\s\S]*?<\/entry>/gi) ?? [];
  for (const block of blocks) {
    let link = toText(tag(block, "link") ?? "");
    if (!link) {
      // Atom: <link rel="alternate" href="…"/> (or the first link with an href)
      const links = [...block.matchAll(/<link\b([^>]*)\/?>/gi)].map((m) => m[1] ?? "");
      const alt =
        links.find((a) => /rel=["']alternate["']/i.test(a)) ?? links.find((a) => !/rel=/i.test(a)) ?? links[0];
      link = decodeEntities(alt?.match(/href=["']([^"']+)["']/i)?.[1] ?? "");
    }
    const url = httpOnly(link || toText(tag(block, "guid") ?? ""));
    if (!url) continue;
    const title = toText(tag(block, "title") ?? "") || url;
    const body = tag(block, "description") ?? tag(block, "summary") ?? tag(block, "content") ?? "";
    items.push({
      url,
      title: title.slice(0, 300),
      published_at: toIsoDate(
        tag(block, "pubDate") ?? tag(block, "published") ?? tag(block, "updated") ?? tag(block, "dc:date"),
      ),
      // Feeds often escape the HTML inside descriptions (&lt;p&gt;): unescape first, then strip tags.
      excerpt: excerpt(toText(decodeEntities(body.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")))),
      domain: null,
    });
  }
  return items;
}

/** "https://github.com/owner/repo" → {owner, repo}, or null. */
export function parseGithubRepo(url: string): { owner: string; repo: string } | null {
  const m = url.match(/^https:\/\/github\.com\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/);
  return m?.[1] && m[2] ? { owner: m[1], repo: m[2] } : null;
}

const githubRelease = z.object({
  html_url: z.string(),
  name: z.string().nullable().optional(),
  tag_name: z.string(),
  published_at: z.string().nullable().optional(),
  body: z.string().nullable().optional(),
  draft: z.boolean().optional(),
});

/** GitHub REST "list releases" response. Drafts are skipped. */
export function parseGithubReleases(json: unknown, repoLabel: string): CollectedItem[] {
  const list = z.array(githubRelease).parse(json);
  return list
    .filter((r) => !r.draft)
    .map((r) => ({
      url: r.html_url,
      title: `${repoLabel} ${r.name?.trim() || r.tag_name}`.slice(0, 300),
      published_at: toIsoDate(r.published_at),
      excerpt: excerpt(r.body ? toText(r.body.replace(/[#*_`>]/g, " ")) : null),
      domain: null,
    }));
}

/**
 * Official MCP Registry list response. The shape is read defensively: entries may be
 * wrapped as { server: {...}, _meta: {...} }. Anything unexpected throws, so the run
 * is logged as failed instead of storing junk.
 */
export function parseMcpRegistry(json: unknown, registryBase: string): CollectedItem[] {
  const body = z.object({ servers: z.array(z.unknown()) }).parse(json);
  const items: CollectedItem[] = [];
  for (const raw of body.servers) {
    const entry = z
      .object({ server: z.record(z.string(), z.unknown()).optional(), _meta: z.unknown().optional() })
      .loose()
      .parse(raw);
    const s = (entry.server ?? entry) as Record<string, unknown>;
    const name = typeof s.name === "string" ? s.name : null;
    if (!name) continue;
    const repo = (s.repository as { url?: unknown } | undefined)?.url;
    const website =
      typeof s.websiteUrl === "string" ? s.websiteUrl : typeof s.website_url === "string" ? s.website_url : null;
    const link = httpOnly(website) ?? httpOnly(typeof repo === "string" ? repo : null);
    const meta = JSON.stringify(entry._meta ?? {});
    const published = meta.match(/"(?:publishedAt|published_at)"\s*:\s*"([^"]+)"/)?.[1] ?? null;
    items.push({
      url: link ?? `${registryBase.replace(/\/$/, "")}?search=${encodeURIComponent(name)}`,
      title: `MCP server published: ${typeof s.title === "string" ? s.title : name}`.slice(0, 300),
      published_at: toIsoDate(published),
      excerpt: excerpt(typeof s.description === "string" ? s.description : null),
      domain: website ? normalizeDomain(website) : null,
    });
  }
  return items;
}

/**
 * A JSON object of { key: value } (e.g. the elizaOS plugin index: package → "github:org/repo").
 * Returns every key with an item; the runner keeps only keys it hasn't seen before.
 */
export function parseKeyMap(json: unknown, label: string): { key: string; item: CollectedItem }[] {
  const map = z.record(z.string(), z.unknown()).parse(json);
  return Object.entries(map).map(([key, value]) => {
    const ref = typeof value === "string" ? value : "";
    const gh = ref.match(/^github:([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)$/);
    const url = gh ? `https://github.com/${gh[1]}/${gh[2]}` : (httpOnly(ref) ?? `https://www.npmjs.com/package/${key}`);
    return {
      key,
      item: { url, title: `${label}: ${key}`.slice(0, 300), published_at: null, excerpt: null, domain: null },
    };
  });
}

/** A fingerprint of a page's visible text, to notice changes without storing the page. */
export async function pageFingerprint(html: string): Promise<{ hash: string; text: string; title: string | null }> {
  const text = toText(html);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  const hash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  const title = toText(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "") || null;
  return { hash, text, title };
}

/**
 * Keyword rules: which signal type an item *might* be. Most explicit intent first.
 * Only a suggestion for the reviewer; the source's own hint is used when nothing matches.
 */
const RULES: [SignalType, RegExp][] = [
  [
    "collaboration_request",
    /\b(looking for|seeking|call for|calling all) (partners|collaborators|integrations?|builders)\b/i,
  ],
  [
    "partner_program_launched",
    /\b(partner|partners|partnership|integrations?|ecosystem|affiliate) (program|programme|network|portal)\b|\bbecome a partner\b/i,
  ],
  [
    "partnerships_role_posted",
    /\b(head of|director of|manager,?|lead,?) (partnerships|bd|business development|ecosystem)\b|\bpartnerships (lead|manager)\b/i,
  ],
  ["integration_announced", /\bintegrat(es|ed|ion) with\b|\bnew integration\b|\bnow integrated\b|\bpartners? with\b/i],
  [
    "ecosystem_expansion",
    /\b(now (live|available) on|expands? to|launch(es|ed)? on|deploy(s|ed)? (on|to)) (base|ethereum|solana|arbitrum|optimism|polygon|avalanche|bnb|mainnet)\b/i,
  ],
  ["api_or_sdk_released", /\b(sdk|api|cli|library|mcp server)\b.*\b(release|released|launch|launched|available|v\d)/i],
  ["product_launched", /\b(introducing|launch(es|ed|ing)?|now available|announcing|unveil(s|ed)?)\b/i],
];

export function suggestSignalType(
  item: Pick<CollectedItem, "title" | "excerpt">,
  hint: SignalType | null,
): SignalType | null {
  const text = `${item.title} ${item.excerpt ?? ""}`;
  for (const [type, re] of RULES) if (re.test(text)) return type;
  return hint;
}

export const watchedSourceInputSchema = z.strictObject({
  name: z.string().trim().min(1).max(200),
  adapter: z.enum(ADAPTERS),
  url: z.url({ protocol: /^https$/, error: "url must be an https link" }),
  config: z
    .strictObject({ format: z.enum(["mcp_registry", "key_map"]).optional(), label: z.string().max(80).optional() })
    .default({}),
  terms_note: z
    .string()
    .trim()
    .min(10, { error: "say why Talo may read this source (terms checked, public feed…)" })
    .max(500),
  company_domain: z.string().trim().max(200).optional(),
  signal_type_hint: z.enum(SIGNAL_TYPE_SLUGS).optional(),
  interval_hours: z.number().int().min(1).max(720).default(24),
  enabled: z.boolean().default(true),
});
export type WatchedSourceInput = z.infer<typeof watchedSourceInputSchema>;

/** After repeated failures a source is paused for a person to look at. */
export const MAX_FAILURES = 5;

/** Next try after a failure: the interval doubled per failure, at most 7 days. */
export function backoffHours(intervalHours: number, failures: number): number {
  return Math.min(intervalHours * 2 ** Math.max(failures, 0), 24 * 7);
}
