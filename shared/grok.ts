/**
 * Pilot A: Grok signal search (official xAI API, x_search tool).
 *
 * Grok helps *find* partnership posts on X. It never verifies anything: results
 * land in the inbox, and a person checks each post before it becomes a signal.
 *
 * Guard against made-up results: a post is kept only if its link is an X post URL
 * AND appears in the citations xAI returned for the search.
 */
import { z } from "zod";
import { normalizeDomain } from "./candidate.ts";
import { type CollectedItem, excerpt, toIsoDate } from "./collector.ts";

export const grokConfigSchema = z.strictObject({
  /** What to look for, in plain words. */
  query: z.string().trim().min(5).max(300),
  /** Only search posts from these accounts (without @), if set. */
  allowed_x_handles: z
    .array(z.string().regex(/^[A-Za-z0-9_]{1,15}$/))
    .max(10)
    .optional(),
  /** How far back to search, in days. */
  lookback_days: z.number().int().min(1).max(30).default(2),
  /** At most this many posts per search. */
  max_posts: z.number().int().min(1).max(15).default(10),
});
export type GrokConfig = z.infer<typeof grokConfigSchema>;

/** Prices used for Talo's own estimate. Set from env; defaults from xAI's public pricing page (Nov 2026). */
export interface GrokPrices {
  per_post_usd: number;
  input_per_million_usd: number;
  output_per_million_usd: number;
}
export const DEFAULT_GROK_PRICES: GrokPrices = {
  per_post_usd: 0.005,
  input_per_million_usd: 1.25,
  output_per_million_usd: 2.5,
};

const INSTRUCTIONS = `You find partnership signals for a curated database. Use X search only.
Find recent posts in which a company announces something that could create a partnership:
a partner or integration program, a request for partners or collaborators, a new integration,
a new API or SDK, a launch on a new chain or platform, or a partnerships role.
Ignore funding news, price talk, giveaways, memes and posts by people who are not speaking for the company.
Never invent posts, links, handles or websites. If unsure about a field, leave it null.
Reply with JSON only, no prose:
{"items":[{"post_url":"https://x.com/<handle>/status/<id>","author_handle":"<handle>","posted_at":"YYYY-MM-DD",
"post_text":"<exact text, max 400 chars>","company_name":"<name or null>","company_website":"<https URL or null>"}]}`;

export function buildGrokRequest(config: GrokConfig, model: string, now: Date) {
  const from = new Date(now.getTime() - config.lookback_days * 86_400_000).toISOString().slice(0, 10);
  const tool: Record<string, unknown> = { type: "x_search", from_date: from };
  if (config.allowed_x_handles?.length) tool.allowed_x_handles = config.allowed_x_handles;
  return {
    model,
    instructions: INSTRUCTIONS,
    input: `Search X for: ${config.query}. Return at most ${config.max_posts} posts from ${from} onwards.`,
    tools: [tool],
    // Never store the conversation on xAI's side.
    store: false,
  };
}

const X_STATUS = /^https:\/\/(?:www\.)?(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})\/status\/(\d{5,25})(?:[/?#].*)?$/;

/** The canonical form of an X post link, or null if it isn't one. */
export function canonicalPostUrl(url: string): string | null {
  const m = url.trim().match(X_STATUS);
  return m ? `https://x.com/${m[1]?.toLowerCase()}/status/${m[2]}` : null;
}

const itemSchema = z.object({
  post_url: z.string(),
  author_handle: z.string().nullable().optional(),
  posted_at: z.string().nullable().optional(),
  post_text: z.string().nullable().optional(),
  company_name: z.string().nullable().optional(),
  company_website: z.string().nullable().optional(),
});

export interface GrokParseResult {
  items: CollectedItem[];
  /** Posts Grok listed but that weren't among its citations: dropped. */
  dropped: number;
  citations: number;
  input_tokens: number;
  output_tokens: number;
}

function collectStrings(value: unknown, into: string[]) {
  if (typeof value === "string") into.push(value);
  else if (Array.isArray(value)) for (const v of value) collectStrings(v, into);
  else if (value && typeof value === "object") for (const v of Object.values(value)) collectStrings(v, into);
}

/**
 * Read an xAI Responses API reply. The answer text must be JSON as instructed;
 * citations are gathered from anywhere in the reply (annotations, citations lists).
 * Throws if the reply has no readable answer, so the run is logged as failed.
 */
export function parseGrokResponse(json: unknown): GrokParseResult {
  const body = z
    .object({
      output: z.array(z.unknown()).optional(),
      output_text: z.string().optional(),
      citations: z.array(z.unknown()).optional(),
      usage: z.object({ input_tokens: z.number().optional(), output_tokens: z.number().optional() }).loose().optional(),
    })
    .loose()
    .parse(json);

  // The answer text: output[].content[] items of type output_text, or a top-level output_text.
  const texts: string[] = [];
  if (body.output_text) texts.push(body.output_text);
  for (const block of body.output ?? []) {
    const content = (block as { content?: unknown }).content;
    if (Array.isArray(content)) {
      for (const c of content) {
        if ((c as { type?: string }).type === "output_text" && typeof (c as { text?: unknown }).text === "string") {
          texts.push((c as { text: string }).text);
        }
      }
    }
  }
  const answer = texts.join("\n");
  const jsonText = answer.match(/\{[\s\S]*\}/)?.[0];
  if (!jsonText) throw new Error("no JSON answer in the reply");
  const parsed = z.object({ items: z.array(z.unknown()) }).parse(JSON.parse(jsonText));

  // Every X post link anywhere in the reply outside the answer text counts as a citation.
  const strings: string[] = [];
  collectStrings(
    {
      ...body,
      output_text: undefined,
      output: (body.output ?? []).map((b) => ({ ...(b as object), content: undefined })),
    },
    strings,
  );
  for (const block of body.output ?? []) {
    const content = (block as { content?: unknown }).content;
    if (Array.isArray(content))
      for (const c of content) collectStrings((c as { annotations?: unknown }).annotations, strings);
  }
  const cited = new Set(strings.map((s) => canonicalPostUrl(s)).filter((u): u is string => u !== null));

  const items: CollectedItem[] = [];
  let dropped = 0;
  for (const raw of parsed.items) {
    const r = itemSchema.safeParse(raw);
    const url = r.success ? canonicalPostUrl(r.data.post_url) : null;
    if (!r.success || !url || !cited.has(url)) {
      dropped += 1;
      continue;
    }
    const handle = url.split("/")[3] ?? "";
    const text = r.data.post_text?.trim() ?? "";
    const website = r.data.company_website ? normalizeDomain(r.data.company_website) : null;
    items.push({
      url,
      title: `@${handle}: ${text.slice(0, 120) || "post"}`.slice(0, 300),
      published_at: toIsoDate(r.data.posted_at),
      excerpt: excerpt(text),
      domain: website,
    });
  }
  return {
    items,
    dropped,
    citations: cited.size,
    input_tokens: body.usage?.input_tokens ?? 0,
    output_tokens: body.usage?.output_tokens ?? 0,
  };
}

/**
 * Talo's estimate of one search's cost. Conservative: every cited post counts as
 * read. The xAI console's spending limit is the hard stop; this is the second one.
 */
export function estimateGrokCost(
  r: Pick<GrokParseResult, "citations" | "input_tokens" | "output_tokens">,
  p: GrokPrices,
): number {
  const cost =
    r.citations * p.per_post_usd +
    (r.input_tokens / 1_000_000) * p.input_per_million_usd +
    (r.output_tokens / 1_000_000) * p.output_per_million_usd;
  return Math.round(cost * 10_000) / 10_000;
}
