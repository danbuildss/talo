/**
 * Outreach drafts produced by the Outreach Specialist skill (talo.outreach.v1).
 * Drafts only: research can never mark a draft approved or sent. A named recipient
 * must come with a public source, so names can't be invented.
 */
import { z } from "zod";
import { domainSchema, httpUrl, PIPELINE_STAGES } from "./candidate.ts";

export const CHANNELS = ["email", "x_dm", "telegram", "linkedin", "github", "proposal"] as const;
export type Channel = (typeof CHANNELS)[number];

export const PURPOSES = ["opener", "alternative", "follow_up", "proposal"] as const;
export type Purpose = (typeof PURPOSES)[number];

/** Short first messages get read. Proposals can be longer. */
export const MAX_LENGTH: Readonly<Record<Purpose, number>> = {
  opener: 1200,
  alternative: 1200,
  follow_up: 800,
  proposal: 6000,
};

const text = (field: string, max = 2000) =>
  z
    .string({ error: `${field} is required` })
    .trim()
    .min(1, { error: `${field} can't be empty` })
    .max(max, { error: `${field} is too long (max ${max} characters)` });

const recipientSchema = z
  .strictObject({
    name: text("name", 200).optional(),
    role: text("role", 200).optional(),
    public_channel: text("public_channel", 300).optional(),
    source_url: httpUrl.optional(),
  })
  .refine((r) => !(r.name || r.role) || r.source_url, {
    error: "a named recipient or role needs a source_url showing it publicly",
    path: ["source_url"],
  });

export const draftSchema = z
  .strictObject({
    candidate_domain: domainSchema,
    channel: z.enum(CHANNELS, { error: `channel must be one of: ${CHANNELS.join(", ")}` }),
    purpose: z.enum(PURPOSES, { error: `purpose must be one of: ${PURPOSES.join(", ")}` }),
    recipient: recipientSchema.optional(),
    subject: text("subject", 200).optional(),
    message: text("message", 6000),
    /** Links backing every specific claim the message makes about the recipient. */
    personalization_sources: z.array(httpUrl).max(10).default([]),
    approval_status: z
      .literal("draft", { error: 'approval_status must be "draft": only a person approves' })
      .default("draft"),
  })
  .superRefine((d, ctx) => {
    if (d.message.length > MAX_LENGTH[d.purpose]) {
      ctx.addIssue({
        code: "custom",
        path: ["message"],
        message: `a ${d.purpose} should be under ${MAX_LENGTH[d.purpose]} characters (this one is ${d.message.length})`,
      });
    }
    if (d.channel === "email" && !d.subject) {
      ctx.addIssue({ code: "custom", path: ["subject"], message: "an email needs a subject" });
    }
  });
export type Draft = z.infer<typeof draftSchema>;

export const outreachFileSchema = z.strictObject({
  format: z.literal("talo.outreach.v1", { error: 'format must be "talo.outreach.v1"' }),
  drafts: z.array(draftSchema).min(1, { error: "the file has no drafts" }).max(200),
  suggested_stages: z
    .array(
      z.strictObject({
        candidate_domain: domainSchema,
        stage: z.enum(PIPELINE_STAGES),
      }),
    )
    .default([]),
  is_sample: z.boolean().default(false),
});
export type OutreachFile = z.infer<typeof outreachFileSchema>;
