# The audit machinery — how to re-run it

Three workflow scripts produced everything in `docs/CURRENT_STATE.md`. All three
ran to completion at least once. Keeping them is the point: **the audit is
re-runnable, not a one-time artifact.** When the codebase drifts far enough that
`CURRENT_STATE.md` stops being trustworthy, re-run these rather than re-deriving
an audit from scratch.

| Script | Covers | Ran |
|---|---|---|
| `wave1_new_domains.js` | Meeting Evidence · person ingress · forward leasing · rent-roll grain · tenancy · the release rail. **Includes an adversarial pass that tries to REFUTE each proof rung** — 40 of 44 claims were corrected by it. | 2026-08-19, 44 capabilities |
| `wave2_coverage_gaps.js` | Teams/access/invites · management door · onboarding & rent-roll intake · money/pricing at grain · the whole app repo · `server.js` inline routes · `tools/` — plus three completeness critics. | 2026-08-20, 148 capabilities |
| `wave3_final_gaps.js` | Migrations 001–119 · `src/shared` + `src/governance` · a census of all 292 test files · **what CI actually runs vs. what merely exists** · a final critic. | 2026-08-20, 58 findings |

## Before re-running: two things will break

**1. The worktree paths are hardcoded and will not exist.** Each script opens with:

```js
const API = '/tmp/claude-0/.../scratchpad/main-api'
const APP = '/tmp/claude-0/.../scratchpad/main-app'
```

Recreate them and update those two constants:

```bash
git worktree add <scratch>/main-api origin/main     # in property-spine-api
git worktree add <scratch>/main-app origin/main     # in property-spine-app
```

**2. The SHAs in each prompt are stale.** Each script tells its agents which
commit they're reading (`main = b7720b2`). Update it, or the agents will report
against a commit that no longer describes reality.

Then: `Workflow({scriptPath: "docs/current-state-build/wave3_final_gaps.js"})`

## What made these produce trustworthy results

Worth preserving as method, not just as scripts. Each of these caught something a
naive survey would have missed:

- **Adversarial verification.** Wave 1 gave every claim to a second agent told to
  *refute* it, defaulting to rejection when uncertain. It corrected 40 of 44 claims
  — including reversing one to `PRODUCTION_PROVEN` and demolishing another that
  had been staged as the only production evidence in the repo.
- **"Open the file, the filename proves nothing."** Every wave was told explicitly
  that a `*.db.js` name is not evidence, and that a hand-built fake pool passed to a
  real router is not an HTTP proof. That instruction is why the fake-pool population
  turned out to be 10 files rather than the 3 found by accident.
- **Completeness critics that only look for what's missing.** Separate agents whose
  entire job was finding unlisted files, unowned database tables, and behavior-changing
  env flags. Every wave's critics found things its surveyors didn't.
- **Making agents state their own method AND its limits.** Each returns a
  `method_note` saying what it searched and what it explicitly did not. A bounded
  scope is fine; an unstated one is a false claim.
- **Letting agents contradict each other, and not resolving it by picking a side.**
  Wave 3's test census and its critic reached opposite conclusions about CI. Both
  were partly right — that contradiction *is* defect #17, and flattening it to one
  answer would have lost the finding.

## What they cost

Roughly 8.7M subagent tokens across three waves and ~3,000 tool calls. Wave 2 alone
spawns ten agents. **Run one wave at a time and report between them** — the owner
watches token spend, and a paused conversation does not pause a running workflow.
