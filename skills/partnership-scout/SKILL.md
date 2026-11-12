---
name: partnership-scout
description: Talo skill B. Find relevant potential partners for a client from public sources, with links and collaboration angles, as an unscored talo.candidates.v1 file. Use after company-intelligence.
---

# Skill B: Partnership Scout

**Purpose:** find organisations that could realistically partner with the client, and show why. **Relevance over volume:** ten strong candidates beat 500 weak ones.

Follow `docs/RESEARCH-METHODOLOGY.md`. If anything here conflicts with it, the methodology wins.

## Input

- The client profile from Skill A (`private/<client>/company.json`).
- The partnership objective (V1: `integration` or `distribution` first).
- Exclusions from the profile (types, regions, competitors).
- Any candidate links Dan or the client supplies.

## Steps

1. **Work out where good partners are visible**, starting from the client's product:
   - Who builds on, next to, or for the same users? (frameworks, platforms, wallets, tools in the same workflow)
   - Who already partners with companies like the client? Check the integrations pages of the client's existing partners and of similar products.
   - Public ecosystem directories, marketplaces, and partner programme pages.
   - Recent official announcements of integrations, partner programmes or developer funds.
2. **Collect a broad pool** (about 15 for a test run; 30–50 for a client Opportunity Map). For each: company name, official domain, what it does, and at least one source.
3. **Note signals** that make a candidate timely: a public partner programme, an open integrations form, a recent launch, a call for partners.
4. **Write one collaboration angle** per candidate: the concrete thing the two could do together.
5. **Drop obvious misfits now** (competitors, excluded types, no public presence) and note why in the log.

## Rules

- Each candidate needs its official domain and at least one source with `url`, `title`, `accessed_at`, `summary`, `claim_type` and the factors it `supports`.
- Don't score yet. Leave `scores` empty (`{}`) or add only factors you have strong evidence for. Scoring is Skill C's job.
- `pipeline_stage` is `discovered`.
- Never include personal contact details. Contacts come later and only from public business sources.
- Never claim a company "is looking for partners" unless a source says so; otherwise it's an inference.
- Use official sources over third-party listings where possible. Third-party listings are fine as leads, then confirm on the company's own site.

## Output

A JSON file in the `talo.candidates.v1` format: `private/<client>/candidates.scouted.json`.

- Rules: `shared/candidate.ts` · JSON Schema: `schemas/candidate-file.schema.json` · Example: `samples/candidates.sample.json`.
- Check it: `npm run check:research -- private/<client>/candidates.scouted.json`. Unscored candidates will show "Needs verification": that's expected at this stage.
- Duplicates are flagged by the checker; merge them.

## Before handing off

- [ ] Every candidate has an official domain and at least one source.
- [ ] Each has a collaboration angle in `proposed_collaboration` and an honest `evidence_summary`.
- [ ] No duplicates.
- [ ] The checker passes.
- [ ] Time spent and dropped candidates (with reasons) are in `private/<client>/log.md`.

Next: **Skill C, Partnership Strategist**, using the profile and this file.
