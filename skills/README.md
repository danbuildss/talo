# Talo research skills

Four skills, run in order in a Claude session. Each one writes a JSON file that the next one reads, and that the Talo app will import later.

| Order | Skill | Reads | Writes |
|---|---|---|---|
| A | [Company Intelligence](company-intelligence/SKILL.md) | Client website and links | `company.json` (talo.company.v1) |
| B | [Partnership Scout](partnership-scout/SKILL.md) | `company.json` | `candidates.scouted.json` (talo.candidates.v1, unscored) |
| C | [Partnership Strategist](partnership-strategist/SKILL.md) | both | `candidates.json` (scored, ranked, rejections kept) |
| D | [Outreach Specialist](outreach-specialist/SKILL.md) | profile + shortlist | `outreach.json` (talo.outreach.v1) + `brief.md` |

All rules come from [`docs/RESEARCH-METHODOLOGY.md`](../docs/RESEARCH-METHODOLOGY.md).

## Running a research job

1. Make a private folder for the client: `private/<client>/`. `private/` is never committed (it's in `.git/info/exclude`).
2. Ask Claude to follow each skill in order, e.g. *"Follow skills/company-intelligence/SKILL.md for <company>, <website>."*
3. After each step, check the output:
   ```bash
   npm run check:research -- private/<client>/company.json
   ```
4. Keep a research log in `private/<client>/log.md`: time per step, candidates dropped and why, claims that failed verification.

To use them as Claude Code skills, copy or symlink the folders into `.claude/skills/`.
