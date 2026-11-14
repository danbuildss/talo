/**
 * Partnership signals and the verification rules (docs/DATA-ENGINE.md §3–4).
 * Main rule: no source, no verified claim.
 */
import { z } from "zod";
import { domainSchema } from "./candidate.ts";
import { sourceInputSchema } from "./registry.ts";

export const SIGNAL_TYPES = {
  partner_program_launched: { label: "Partner program launched", intent: "explicit", freshness_days: 30 },
  collaboration_request: { label: "Collaboration request", intent: "explicit", freshness_days: 14 },
  partnerships_role_posted: { label: "Partnerships role posted", intent: "weak", freshness_days: 30 },
  integration_announced: { label: "Integration announced", intent: "implied", freshness_days: 90 },
  api_or_sdk_released: { label: "API or SDK released", intent: "implied", freshness_days: 90 },
  product_launched: { label: "Product launched", intent: "implied", freshness_days: 90 },
  ecosystem_expansion: { label: "Ecosystem expansion", intent: "implied", freshness_days: 90 },
} as const;
export type SignalType = keyof typeof SIGNAL_TYPES;
export const SIGNAL_TYPE_SLUGS = Object.keys(SIGNAL_TYPES) as [SignalType, ...SignalType[]];

/** Stored statuses. */
export const REVIEW_STATUSES = ["needs_review", "verified", "rejected"] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];
/** What people see: stored status, plus "stale" when a verification has expired. */
export type EffectiveStatus = ReviewStatus | "stale";

const DAY_MS = 86_400_000;

/** A verified signal becomes stale when its last check is older than its type's freshness window. */
export function effectiveSignalStatus(
  s: { status: ReviewStatus; last_verified_at: string | null; signal_type: SignalType },
  now: Date,
): EffectiveStatus {
  if (s.status !== "verified" || !s.last_verified_at) return s.status;
  const age = (now.getTime() - Date.parse(s.last_verified_at)) / DAY_MS;
  return age > SIGNAL_TYPES[s.signal_type].freshness_days ? "stale" : "verified";
}

/** Public Discover shows a signal only if it and its company are verified (stale signals show with their date). */
export function isPublic(signalStatus: ReviewStatus, companyStatus: ReviewStatus): boolean {
  return signalStatus === "verified" && companyStatus === "verified";
}

export const REVIEW_ACTIONS = ["verify", "reject", "reopen"] as const;
export type ReviewAction = (typeof REVIEW_ACTIONS)[number];

/**
 * Allowed changes:
 * - verify: needs_review → verified, or verified → verified (a re-check that refreshes the date)
 * - reject: needs_review or verified → rejected (needs a reason)
 * - reopen: verified or rejected → needs_review
 */
export function nextStatus(from: ReviewStatus, action: ReviewAction): ReviewStatus | null {
  switch (action) {
    case "verify":
      return from === "needs_review" || from === "verified" ? "verified" : null;
    case "reject":
      return from === "needs_review" || from === "verified" ? "rejected" : null;
    case "reopen":
      return from === "verified" || from === "rejected" ? "needs_review" : null;
  }
}

export const reviewInputSchema = z
  .strictObject({
    action: z.enum(REVIEW_ACTIONS, { error: `action must be one of: ${REVIEW_ACTIONS.join(", ")}` }),
    /** The page the reviewer opened. Required to verify. */
    checked_url: z.url({ protocol: /^https?$/, error: "checked_url must be a full http(s) link" }).optional(),
    reason: z.string().trim().min(1).max(500).optional(),
  })
  .refine((r) => r.action !== "verify" || r.checked_url, {
    error: "to verify, say which page you checked (checked_url)",
    path: ["checked_url"],
  })
  .refine((r) => r.action !== "reject" || r.reason, {
    error: "to reject, give a reason",
    path: ["reason"],
  });
export type ReviewInput = z.infer<typeof reviewInputSchema>;

const text = (field: string, max: number) =>
  z
    .string({ error: `${field} is required` })
    .trim()
    .min(1, { error: `${field} can't be empty` })
    .max(max, { error: `${field} is too long (max ${max} characters)` });

/** A signal as curated or imported. Always starts as needs_review. */
export const signalInputSchema = z.strictObject({
  /** The company's official domain (or any domain alias). The company must already exist. */
  company_domain: domainSchema,
  signal_type: z.enum(SIGNAL_TYPE_SLUGS, {
    error: `signal_type must be one of: ${SIGNAL_TYPE_SLUGS.join(", ")} (funding is not a signal type)`,
  }),
  title: text("title", 200),
  /** The exact claim the primary source supports. */
  factual_claim: text("factual_claim", 1000),
  /** The words from the source that support the claim. */
  source_excerpt: text("source_excerpt", 2000),
  /** Why it might matter for partnerships. Always shown as Talo's view, never as fact. */
  opportunity_note: text("opportunity_note", 1000).optional(),
  event_date: z.iso.date({ error: "event_date must be a date like 2026-11-12" }).optional(),
  primary_source: sourceInputSchema,
  corroborating_sources: z.array(sourceInputSchema).max(5).default([]),
  is_sample: z.boolean().default(false),
});
export type SignalInput = z.infer<typeof signalInputSchema>;
