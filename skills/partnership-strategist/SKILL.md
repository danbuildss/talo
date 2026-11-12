---
name: partnership-strategist
description: Talo skill C. Verify, score and rank scouted partner candidates for a client with the five-factor rubric, reject weak matches, and write the partnership thesis for each; outputs a scored talo.candidates.v1 file. Use after partnership-scout.
---

# Skill C: Partnership Strategist

**Purpose:** decide which candidates are genuinely worth pursuing, and why. **Challenge weak matches**; don't approve everything.

Follow `docs/RESEARCH-METHODOLOGY.md`, especially the scoring rubric (section 3) and rejection rules (section 5).

## Input

- The client profile (`private/<client>/company.json`).
- The scouted candidates (`private/<client>/candidates.scouted.json`).

## Steps

For each candidate:

1. **Verify.** Open each source again. Does it say what the scout recorded? Fix or remove anything that doesn't hold, and tag each source `verified` or `inference` correctly. Add sources where a factor has none, especially for *alignment* and *readiness*.
2. **Apply the rejection rules first.** No benefit for the partner, a direct competitor, excluded type or region, no verifiable presence, or "same broad sector" as the only link: set `pipeline_stage` to `not_a_fit`, and say why in `evidence_summary`.
3. **Score the five factors** 0–5 with a one-sentence reason each, using the rubric table. When torn between two scores, take the lower and say why.
4. **Write both sides of the value:** `mutual_benefits.for_client` and `mutual_benefits.for_partner`, each specific. If you can't write a convincing `for_partner`, it's probably not a fit.
5. **Propose the collaboration:** the smallest concrete first step (`proposed_collaboration`).
6. **List risks and objections** the partner might raise (`risks`).
7. **Recommend the next action** (`recommended_next_action`): what to verify or do next.
8. **Set the stage:** `qualified` for candidates worth outreach, `researched` for ones that need more checking, `not_a_fit` for rejections.

Then **rank**: run the checker, which calculates each overall score and confidence. Pick the shortlist (5 for a test run, 8–10 for an Opportunity Map) from `qualified` candidates, preferring higher scores with medium or high confidence.

## Rules

- Never write `overall_score`, `evidence_confidence` or `verification_status`: Talo calculates them, and the checker rejects files that include them.
- Each factor score needs a reason a reader can check against the sources.
- A high score means research-based fit, never a promise of a reply or a deal. Say so in any brief.
- Keep rejected candidates in the file, with reasons, so nobody researches them again.

## Output

A JSON file in the `talo.candidates.v1` format: `private/<client>/candidates.json`.

- Check it: `npm run check:research -- private/<client>/candidates.json`. Every `qualified` candidate should be "ready"; if it shows "Needs verification", fix the evidence or move it back to `researched`.

## Before handing off

- [ ] Every source was re-opened and its tag is right.
- [ ] Every scored factor has a specific reason.
- [ ] Each shortlisted candidate has a convincing `for_partner`.
- [ ] Rejections have reasons.
- [ ] The checker passes, and the shortlist is "ready".
- [ ] Time spent and verification failures are in `private/<client>/log.md`.

Next: **Skill D, Outreach Specialist**, for the shortlisted candidates.
