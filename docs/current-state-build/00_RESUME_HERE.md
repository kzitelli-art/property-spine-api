# CLOSED OUT 2026-08-24. `docs/CURRENT_STATE.md` is live on `main`.

> ## ▶ FOR ANY THREAD PICKING THIS UP
> ```
> Read docs/CURRENT_STATE.md on main.
> ```
> That is the deliverable and it is finished. This folder is its build history
> and the re-runnable audit machinery. **This thread is closed** — not because
> the work was wrong, but to reduce coordination cost while three agents work
> the same repo.

---

## ⛔ READ THIS BEFORE YOU TOUCH ANYTHING — `main` CANNOT BOOT

As of 2026-08-24:

```text
origin/main    41dea52    migration ceiling 187   clean, fully audited
production     61f99bf    ledger 189              NOT an ancestor of main
```

**`main` has 187 migration files against a 189 database. It will refuse to
start.** Two further branches carry 190 and 191. Recorded as **defect #28** in
`CURRENT_STATE.md` — a *recurrence* of #7, which was marked resolved on 20 Aug
and was false again within 48 hours.

**Reconciliation is deliberately held.** The owner is away from the machine and
cannot safely release 190/191 against a 189 ledger remotely. **Do not attempt
it. Do not merge to `main`.**

## THREE AGENTS, ONE REPO — coordination state at close

| Branch / SHA | Owner | Carries |
|---|---|---|
| `61f99bf` | — | **what is actually deployed** |
| `3173913` | another CC thread | Q5, Build 2, Build 3 — +62 vs main |
| `9746f12` | Codex | Skyline lease — **migrations 190, 191** |
| `7e67f50` | Codex | guarantor agent |

**This thread merged 17 PRs to `main` and is now stopped.** Every further
change from here goes to a branch and waits.

**Do not touch** (owned by other threads): `index.html`, `migrations/`,
`operator.js`, `leasingleads.js`, `leasepackets.js`, `applicationSubmission.js`.

## WHAT THIS THREAD TOUCHED — for collision checks

**Authored — 21 files, all docs, tests or tooling. Zero `src/`, zero SQL, zero
`server.js`:**

```
.claude/hooks/session_start.sh    docs/current-state-build/ (11 files)
.claude/settings.json             migrations/README.md      ← doc only
.env.example                      tests/full_lifecycle_arc.js
CLAUDE.md                         tests/gate_current_state.js
docs/CURRENT_STATE.md             tests/verify_source_governance.js
docs/THREAD_HANDOFF.md
```

**PR #128 is the exception and it was NOT authored here** — it was the
orientation thread's branch, merged by this one: 97 files, 25 in `src/`, 7
migrations, plus `server.js`. Confirmed by the owner to sit *below* the fork and
already inside `7e67f50`, so it poses no collision.

## WHAT SHIPPED

- **`docs/CURRENT_STATE.md`** — ~350 capabilities surveyed, 28 defects tracked
  with file-and-line evidence, 9 resolved or ruled. `CLAUDE.md` routes every new
  thread to it automatically.
- **`tests/gate_current_state.js`** — registered as gate 38 of 38. Fails the
  build if a `src/` directory is unlisted, a banned word is used as a rung, or
  defect numbering collides. **Falsified three ways**, not merely run green.
- **The audit is re-runnable** — three workflow scripts, all run to completion,
  with method recorded in `AUDIT_SCRIPTS.md`.
- **Real fixes**: the `market_rent` pricing bug (deployed), a
  privilege-escalation path in `orgchart.js`, two docs that instructed
  incorrectly, 62 undocumented environment variables, and a test that defaulted
  to driving a full lease lifecycle against live production.

## THE FINDING THAT MATTERS MOST — corroborated by two independent threads

**The register's rungs are weaker than they read.**

```text
.db.js proofs      68     referenced by CI: 0
*_proof.js files   89     referenced by CI: 0
in the 38-gate array      0
```

Spot-checked the exact proofs cited for Compliance, Debt, Equity and Deal
Setup — all four are in the unrun set. **`HTTP_PROVEN` means "a human ran this
once and it passed," not "this is verified."** Another CC thread measured the
same problem independently and got 68 and 94 against these 68 and 89. Two
methods, one finding.

## OPEN, AND WAITING FOR THE OWNER

| # | What | Status |
|---|---|---|
| 28 / 7 | `main` cannot boot — 187 vs 189 | **Held.** Needs the owner at the machine. |
| 17 | Wire the 265 unrun proofs into CI | **Ruled yes, deliberately not started.** Wiring is safe; the first run goes red and the fixes land in `operator.js`, `leasingleads.js`, `leasepackets.js` — owned by other threads. |
| 14 | Quote the 12-month base term, not `terms[0]` | **Ruled, ready to build.** Needs no schema change. |
| 27 | What if a property publishes no 12-month term? | **Open sub-decision.** Must not fall back to `terms[0]`. |
| 13 / 20 | 47 tests pinned to a demo UUID nothing creates | Unclaimed |
| 12 | Property delete cascades past the pricing freeze | **Ruled: allowed for now.** Revisit "with more real properties." |
| 18 | `main` unprotected — red CI cannot block a merge | **Ruled: not yet.** Deliberate, not an oversight. |

## STANDING CONSTRAINTS

- **Do not merge to `main`.** Branch and PR only, until the owner reconciles.
- **Never upgrade a rung because code looks finished, or because a deploy
  happened.** Only an observation moves it.
- **`NOT_FOUND` over a plausible guess**, always.
- **Verify before recording, in both directions.** Every cross-thread report
  here was checked against source first, and at least once that check corrected
  the checker rather than the report.
