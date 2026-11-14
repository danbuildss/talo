/**
 * The shared company registry: input format and the normalization rules that
 * decide when two records are the same company or the same source.
 */
import { z } from "zod";
import { domainSchema, httpUrl, normalizeDomain } from "./candidate.ts";

export const ALIAS_KINDS = ["name", "domain", "github_org", "x_handle"] as const;
export type AliasKind = (typeof ALIAS_KINDS)[number];

export const SOURCE_KINDS = [
  "website",
  "docs",
  "partner_page",
  "announcement",
  "rss_item",
  "github_release",
  "registry_entry",
  "x_post",
  "directory",
  "user_submitted",
] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

export const COMPANY_STATUSES = ["needs_review", "verified", "rejected"] as const;
export type CompanyStatus = (typeof COMPANY_STATUSES)[number];

const LEGAL_SUFFIXES = /\b(inc|incorporated|llc|ltd|limited|corp|corporation|co|gmbh|plc|sa|pte)\b\.?/g;

/** "Acme, Inc." and "acme" are the same name. Keeps meaningful words like "Labs" or "AI". */
export function normalizeName(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\(.*?\)/g, " ")
    .replace(LEGAL_SUFFIXES, " ")
    .replace(/[^a-z0-9]+/g, "");
}

/** Returns the normalized alias, or null if it isn't usable. */
export function normalizeAlias(kind: AliasKind, value: string): string | null {
  const v = value.trim();
  switch (kind) {
    case "name": {
      const n = normalizeName(v);
      return n.length >= 2 ? n : null;
    }
    case "domain":
      return normalizeDomain(v);
    case "github_org": {
      const m = v
        .replace(/^(https?:\/\/)?(www\.)?github\.com\//i, "")
        .replace(/\/.*$/, "")
        .toLowerCase();
      return /^[a-z0-9](?:[a-z0-9-]{0,38})$/.test(m) ? m : null;
    }
    case "x_handle": {
      const m = v
        .replace(/^(https?:\/\/)?(www\.)?(x|twitter)\.com\//i, "")
        .replace(/^@/, "")
        .replace(/[/?].*$/, "")
        .toLowerCase();
      return /^[a-z0-9_]{1,15}$/.test(m) ? m : null;
    }
  }
}

const TRACKING_PARAMS = /^(utm_\w+|ref|ref_src|fbclid|gclid|mc_cid|mc_eid|s|t)$/i;

/**
 * One URL, one source: lowercase host without "www.", no fragment, no tracking
 * parameters, sorted query, no trailing slash. Returns null for non-http(s) URLs.
 */
export function normalizeUrl(input: string): string | null {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  url.hash = "";
  url.hostname = url.hostname.toLowerCase().replace(/^www\./, "");
  const kept = [...url.searchParams.entries()].filter(([k]) => !TRACKING_PARAMS.test(k));
  kept.sort(([a], [b]) => a.localeCompare(b));
  url.search = new URLSearchParams(kept).toString();
  if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, "");
  const out = url.toString();
  return url.pathname === "/" && !url.search ? out.replace(/\/$/, "") : out;
}

export function slugify(name: string): string {
  const s = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\(.*?\)/g, " ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return s || "company";
}

const text = (field: string, max: number) =>
  z
    .string({ error: `${field} is required` })
    .trim()
    .min(1, { error: `${field} can't be empty` })
    .max(max, { error: `${field} is too long (max ${max} characters)` });

export const aliasInputSchema = z
  .strictObject({
    kind: z.enum(ALIAS_KINDS, { error: `kind must be one of: ${ALIAS_KINDS.join(", ")}` }),
    value: text("value", 300),
  })
  .refine((a) => normalizeAlias(a.kind, a.value) !== null, {
    error: "this alias isn't a valid name, domain, GitHub org or X handle",
    path: ["value"],
  });
export type AliasInput = z.infer<typeof aliasInputSchema>;

export const sourceInputSchema = z.strictObject({
  url: httpUrl,
  kind: z.enum(SOURCE_KINDS, { error: `kind must be one of: ${SOURCE_KINDS.join(", ")}` }),
  title: text("title", 300),
  published_at: z.iso.date().nullable().default(null),
  excerpt: text("excerpt", 2000).optional(),
});
export type SourceInput = z.infer<typeof sourceInputSchema>;

/** A company as curated or imported. Always starts as needs_review. */
export const companyInputSchema = z.strictObject({
  name: text("name", 200),
  domain: domainSchema,
  description: text("description", 1000).optional(),
  categories: z
    .array(z.string().regex(/^[a-z0-9-]+$/))
    .max(10)
    .default([]),
  aliases: z.array(aliasInputSchema).max(20).default([]),
  sources: z.array(sourceInputSchema).max(20).default([]),
  is_sample: z.boolean().default(false),
});
export type CompanyInput = z.infer<typeof companyInputSchema>;

/** All aliases for a company input, normalized and de-duplicated, including its name and domain. */
export function aliasesFor(
  input: Pick<CompanyInput, "name" | "domain" | "aliases">,
): { kind: AliasKind; value: string }[] {
  const all: { kind: AliasKind; value: string }[] = [];
  const seen = new Set<string>();
  const add = (kind: AliasKind, raw: string) => {
    const value = normalizeAlias(kind, raw);
    if (value === null || seen.has(`${kind}:${value}`)) return;
    seen.add(`${kind}:${value}`);
    all.push({ kind, value });
  };
  add("name", input.name);
  add("domain", input.domain);
  for (const a of input.aliases) add(a.kind, a.value);
  return all;
}

function levenshtein(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 2) return 3;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0] ?? 0;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j] ?? 0;
      prev[j] = Math.min((prev[j] ?? 0) + 1, (prev[j - 1] ?? 0) + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length] ?? 0;
}

/** The part of a domain before its last dot-label: "acme" for acme.ai and docs.acme.com. */
function domainStem(domain: string): string {
  const parts = domain.split(".");
  return parts.length >= 2 ? (parts[parts.length - 2] ?? domain) : domain;
}

export interface NearDuplicate {
  a: string;
  b: string;
  reason: string;
}

/**
 * Possible duplicates that exact alias matching can't catch, for a person to check:
 * names one letter apart, or the same domain name on different endings (acme.ai / acme.com).
 */
export function findNearDuplicates(companies: { id: string; name: string; primary_domain: string }[]): NearDuplicate[] {
  const out: NearDuplicate[] = [];
  for (let i = 0; i < companies.length; i++) {
    for (let j = i + 1; j < companies.length; j++) {
      const x = companies[i];
      const y = companies[j];
      if (!x || !y) continue;
      const nx = normalizeName(x.name);
      const ny = normalizeName(y.name);
      const sx = domainStem(x.primary_domain);
      const sy = domainStem(y.primary_domain);
      if (sx.length >= 4 && sx === sy) {
        out.push({ a: x.id, b: y.id, reason: `same domain name "${sx}" on different endings` });
      } else if (nx.length >= 5 && levenshtein(nx, ny) <= 1) {
        out.push({ a: x.id, b: y.id, reason: `names "${x.name}" and "${y.name}" are nearly identical` });
      }
    }
  }
  return out;
}
