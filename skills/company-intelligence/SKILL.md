---
name: company-intelligence
description: Talo skill A. Build an evidence-backed profile of a client company from public sources, as a talo.company.v1 file. Use first, before scouting partners for a client.
---

# Skill A: Company Intelligence

**Purpose:** understand the client well enough to know what partners would help them, and what they can offer a partner in return.

Follow `docs/RESEARCH-METHODOLOGY.md`. If anything here conflicts with it, the methodology wins.

## Input

- Company name and website (required).
- Anything the client or Dan supplies: product summary, target customers, goals, partners to avoid, regions.
- Public links: docs, blog, changelog, pricing, partner/integrations page, official X account.

## Steps

1. **Read the official sources first:** homepage, product and docs pages, pricing, about, blog or changelog, any integrations or partners page, the official X account if reachable. Note the URL and today's date for each.
2. **Write down what is stated** (verified): what the product does, who it is for, SDKs and platforms, listed integrations and partners, pricing model, stage signals (team page, funding announcements, customer logos the company itself shows).
3. **Write down what you infer**, labelled as inference, with the source that led you there: likely stage, likely goals, gaps a partner could fill.
4. **Map partnership goals** to Talo's types: `integration`, `distribution`, `ecosystem`, `channel`, `creator`. V1 focuses on integration and distribution.
5. **List strengths and limitations** honestly, from a partner's point of view: what makes them attractive, what might put a partner off.
6. **List open questions** for the client: anything important you could not find or confirm. Never fill gaps with guesses.

## Rules

- Every claim in `claims[]` has an http(s) `url`, an `accessed_at` date and a `claim_type` of `verified` or `inference`.
- Never invent numbers (users, revenue, funding), customers, partners or quotes. If the company shows a number itself, record it as "the company states…".
- Existing partners and competitors only with a source, or leave the source off and say so in `open_questions`.
- Don't scrape against a site's terms. If a page can't be reached (X often can't), note it in `open_questions` and ask Dan for a screenshot or link.
- Client research is private: save output under `private/<client>/`, never in a committed folder.

## Output

A JSON file in the `talo.company.v1` format: `private/<client>/company.json`.

- Rules: `shared/company.ts` · JSON Schema: `schemas/company-profile.schema.json` · Example: `samples/company.sample.json`.
- Check it: `npm run check:research -- private/<client>/company.json`. Fix every error before moving on.

## Before handing off

- [ ] Every capability and target user is backed by a claim with a link.
- [ ] Inferences are labelled as inference.
- [ ] Open questions list what you couldn't confirm.
- [ ] The checker passes.
- [ ] Time spent is noted in the research log (`private/<client>/log.md`).

Next: **Skill B, Partnership Scout**, using this profile.
