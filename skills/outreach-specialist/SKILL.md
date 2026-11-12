---
name: outreach-specialist
description: Talo skill D. Draft honest, specific outreach (opener, alternative angle, follow-up, optional proposal) for shortlisted partner candidates, as a talo.outreach.v1 file. Drafts only; a person approves and sends. Use after partnership-strategist.
---

# Skill D: Outreach Specialist

**Purpose:** give the client a credible first message for each shortlisted partner, one that shows the value to *them*. Talo never sends anything: a person reviews, edits, approves and sends.

Follow `docs/RESEARCH-METHODOLOGY.md` and the voice in `brand/BRAND.md`. Drafts are written in the **client's** voice, not Talo's.

## Input

- The client profile (`private/<client>/company.json`).
- The scored candidates (`private/<client>/candidates.json`). Draft only for `qualified` candidates.
- The channel to use (email, X DM, Telegram, LinkedIn, or GitHub for open-source projects that take pull requests or issues) if known; otherwise suggest the best public channel found.

## For each shortlisted candidate, write

1. **Opener** (`purpose: "opener"`): short, about 60–120 words. Who you are in one line; one specific, sourced reason you're writing; what's in it for them; one small, easy ask.
2. **Alternative angle** (`purpose: "alternative"`) where a second angle is genuinely different (e.g. co-marketing instead of integration).
3. **Follow-up** (`purpose: "follow_up"`): one short, polite nudge that adds something new (an outline, a doc link).
4. **Proposal** (`purpose: "proposal"`), optional, for the strongest one or two: a one-page outline of the collaboration, both sides' benefits, first step, what each side does.

Also suggest a pipeline stage per candidate (`suggested_stages`), usually `outreach_prepared`.

## Rules

- **No fake familiarity.** Never "loved your recent post" unless the post is real, linked in `personalization_sources`, and the client actually saw it.
- **No invented people.** Only name a recipient or role if a public source shows it (`recipient.source_url`). Otherwise address the team or the public channel.
- **Only true claims.** Every specific statement about the partner is backed by a link in `personalization_sources`. Claims about the client come from the profile.
- **No promises** of results, and no implying a partnership or endorsement that doesn't exist.
- **No mass messaging.** Each draft is written for one company.
- Calm, specific, no hype, no exclamation marks.
- `approval_status` is always `draft`. The checker rejects anything else.

## Output

A JSON file in the `talo.outreach.v1` format: `private/<client>/outreach.json`.

- Rules: `shared/outreach.ts` · JSON Schema: `schemas/outreach-file.schema.json` · Example: `samples/outreach.sample.json`.
- Check it: `npm run check:research -- private/<client>/outreach.json`.

## Before handing off

- [ ] Every specific claim about the partner has a source link.
- [ ] No recipient names or roles without a public source.
- [ ] Openers are short and end with one small ask.
- [ ] The checker passes.
- [ ] Time spent is in `private/<client>/log.md`.

Last step: write the **brief** (`private/<client>/brief.md`) for the client using the Opportunity Map layout: company summary, the shortlist with score breakdowns and sources, the both-sides value, risks, next actions and drafts. Include the line: *"A score shows research-based fit. It is not a promise of a reply or a partnership."*
