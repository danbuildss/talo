# Opportunity Map template

The layout of the brief a client receives. Skill D writes it as `private/<client>/brief.md`, and the Talo app will produce the same layout as a printable page later. Square brackets are placeholders.

---

```markdown
# Opportunity Map: [Client]

Prepared by Talo, built by Somehow Internet · [date] · [Pilot / Snapshot / Opportunity Map]

> A score shows research-based fit. It is not a promise of a reply or a partnership.

## 1. Your company, as a partner sees it
[3–5 sentences: what you do, who for, what makes you attractive to partners, what might put them off.]
Open questions for you: [list]

## 2. Summary
| # | Candidate | Type | Fit | Evidence | Next step |
|---|---|---|---:|---|---|
| 1 | [Name] ([domain]) | Integration | [73] | Medium | [one line] |

Researched [N] organisations · shortlisted [n] · rejected [m] (reasons in the appendix).

## 3. Candidates (one section each)
### [n]. [Name] · [domain]
**Fit [73]/100 · Evidence [Medium] · [Ready / Needs verification]**

**Why it makes sense:** [2–3 sentences]
**For you:** [specific] · **For them:** [specific]
**Proposed first step:** [smallest concrete collaboration]

| Factor | Score | Weight | Why |
|---|---:|---:|---|
| Product and audience alignment | 4/5 | 30% | [reason] |
| Mutual commercial value | 4/5 | 25% | [reason] |
| Partnership readiness | 3/5 | 20% | [reason] |
| Contact accessibility | 3/5 | 15% | [reason] |
| Execution feasibility | 4/5 | 10% | [reason] |

**Risks:** [list]
**Evidence:** [Verified / Inference] [title](url), accessed [date] — [what it shows]
**Draft opener ([channel]):** [message]

## 4. Appendix
- Rejected candidates and why.
- Method: how candidates were found, scored and checked (link to the public methodology).
```

## Rules for every Map

- Every fact has a link and an access date. Inferences are labelled.
- Fit scores and confidence come from Talo's checker (`npm run check:research`), never written by hand.
- Fictional samples are labelled. Client Maps are private and never committed.
