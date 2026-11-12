# Research methodology

How Talo research is done, so that every recommendation can be checked by someone else. The four research skills in `skills/` follow this document, and the code in `shared/` enforces the parts that can be enforced.

**Core rule:** a claim is only as good as its source. Facts have links; guesses are labelled as guesses; anything unsupported says **Needs verification**.

---

## 1. Allowed sources

| Allowed | Not allowed |
|---|---|
| Official company websites and blogs | Scraping that breaks a site's terms |
| Developer docs, API references, changelogs | Logged-in or paywalled content shared without permission |
| Public partner, integrations and ecosystem pages | Leaked or private documents |
| Public ecosystem directories | Personal social profiles beyond public business roles |
| Official announcements and press releases | Guessed email addresses or invented contacts |
| Public X posts viewed by permitted means | Unofficial API resellers |
| Links supplied by Dan or the client | |

Record every source with: link (http or https only), title, publication date if known, the date we accessed it, and a one-line summary of what it shows.

If a page could only be read through a search excerpt (not opened directly), say so in the brief. A person opens every link once before anything is sent to the client or a partner.

## 2. Verified vs inference

Each source is tagged:

- **verified**: the source directly states the fact. *"Their integrations page lists 12 partners."*
- **inference**: our reasoning from what the source shows. *"Their roadmap suggests they want more tooling partners."*

An inference never appears as a fact in a brief. Each source also lists which scoring factors it **supports**, so the confidence rules (section 4) can check that the important factors rest on verified evidence.

## 3. Scoring: five factors, 0–5 each

Each factor gets a whole-number score from 0 to 5 **and a one-sentence reason**. Research never supplies the overall number; Talo calculates it (`shared/scoring.ts`), and a research file that includes `overall_score`, `evidence_confidence` or `verification_status` is rejected.

`overall = round( Σ score ÷ 5 × weight )`, giving 0–100.

| Factor | Weight | 0 | 3 | 5 |
|---|---:|---|---|---|
| **Product and audience alignment** | 30% | Different users, no product overlap | Overlapping users or adjacent product; fit needs explaining | Same users, products clearly complement each other |
| **Mutual commercial value** | 25% | Only one side benefits | Both benefit, but one side clearly more, or value is modest | Clear, specific gain for both sides |
| **Partnership readiness** | 20% | No sign they partner at all | Has partners or integrations but no programme or open invitation | Public partner programme, integrations page or open call for partners |
| **Contact accessibility** | 15% | No route in | Public form or general contact; no named person | Named partnerships lead with a public business channel, or a warm path |
| **Execution feasibility** | 10% | Needs major work or deals neither side can do | Doable with real effort on one side | Small, well-defined first step (e.g. a listing, a joint guide) |

Scores 1, 2 and 4 sit between the descriptions. When unsure between two scores, take the lower one and say why.

A factor may be left unscored while research is in progress. The candidate then has no overall score and shows **Needs verification**.

## 4. Evidence confidence (separate from fit)

Fit says how good the match looks. Confidence says how sure we are of the evidence behind it.

| Confidence | Rule |
|---|---|
| **High** | Every factor is supported by at least one verified source, sources come from at least two different websites, and every source was accessed in the last 90 days. |
| **Medium** | Every factor is scored, and verified sources support both *alignment* and *readiness*. |
| **Low** | Anything less. |

**Needs verification** is shown instead of a headline score when confidence is Low or any factor is unscored. Talo lists the reasons, e.g. "Partnership readiness has no verified source".

Every score is shown with: *"A score shows research-based fit. It is not a promise of a reply or a partnership."*

## 5. Rejection rules

The strategist marks a candidate **Not a fit** (pipeline stage `not_a_fit`) when any of these apply:

1. No plausible benefit for the partner.
2. Direct competitor of the client.
3. In a partner type or geography the client excluded.
4. No verifiable public presence.
5. The only "fit" is being in the same broad sector.

Rejected candidates are kept with their reason, so the same company isn't researched twice.

## 6. Contacts

Only public business contacts with a source: a name, a business role and a public channel (partner form, business email published by the company, public X account). No personal phone numbers, private emails or guessed addresses. If no contact is found, say so and score contact accessibility accordingly.

## 7. Output format

Research output is a **Talo research file**: JSON in the `talo.candidates.v1` format.

- The rules live in `shared/candidate.ts`.
- The same rules as a JSON Schema are in `schemas/candidate-file.schema.json`, generated with `npm run schema`.
- A fictional example is in `samples/candidates.sample.json`.

Domains are normalized (`https://www.Example.com/partners` becomes `example.com`), and candidates sharing a domain are flagged as duplicates. A file with any invalid candidate is rejected as a whole, with a message saying exactly where each problem is.

## 8. Research log

For every research run, record (privately):

- Time spent on each step: company intelligence, scouting, strategy, outreach.
- Candidates researched, kept and rejected, with the rejection reason.
- Claims that failed verification.

This tells us what an Opportunity Map really costs to make, and what to automate first.

## 9. Privacy

Client names, research files, briefs and drafts are never committed to this public repository. Real client data lives only in the Talo database behind login. Confidential client information is never sent to an outside AI service without permission.
