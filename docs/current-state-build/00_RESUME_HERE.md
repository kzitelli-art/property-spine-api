# RESUME HERE — `docs/CURRENT_STATE.md` is LIVE. This folder is its build history.

> ## ▶ TO RESTART, PASTE THIS
> ```
> Read docs/current-state-build/00_RESUME_HERE.md on main and continue that work.
> ```
> **The deliverable already shipped.** `docs/CURRENT_STATE.md` exists on `main`
> (merged PR #123, `d9b827e`, 2026-08-20). `CLAUDE.md` already routes every new
> thread to it. What's left is **extending coverage**, not building the thing.
>
> **First move: re-fetch and re-stamp.** Do not trust any SHA below without
> checking. Both repos moved substantially during the build of this file —
> assume they've moved again.
>
> ### ⚠ TOKEN BUDGET — the owner watches this
> Wave 2 (below) is the expensive remaining piece — ten agents. **Run it, report,
> then ask before running anything bigger.** If the owner says they're near a
> limit, stop all background tasks immediately (`TaskStop`) rather than only
> saving files — a paused conversation does not pause a running workflow. This
> was a real mistake made once already in this build; don't repeat it.

---

## WHAT'S ACTUALLY LEFT — one job, clearly

**Run `wave2_coverage_gaps.js`.** It was started twice and stopped twice (once
for a token pause, once because the user went to sleep) — it has **never
completed**. It covers: Teams/access/invites/roles (the single highest-value
gap — see below), the Management door, onboarding & rent-roll intake internals,
money/pricing at real grain, the entire app repo, `server.js`'s inline routes,
and `tools/` — plus three completeness critics hunting for files, database
tables, and env flags/integrations that nothing else has found yet.

The script hardcodes worktree paths that won't exist in a fresh container.
Recreate first:
```bash
git worktree add <scratch>/main-api origin/main     # in property-spine-api
git worktree add <scratch>/main-app origin/main     # in property-spine-app
```
Update the `API` / `APP` constants at the top of the script, then:
```
Workflow({scriptPath: "docs/current-state-build/wave2_coverage_gaps.js"})
```

**⚠ Survey against the DEPLOYED commit, not `main`, if they've diverged again.**
As of this writing production runs `30cb992` (branch
`claude/property-spine-orientation-cso2ao`), 39 commits ahead of `main`, and
that fact is recorded as defect #7 in `CURRENT_STATE.md` itself. Check
`CURRENT_STATE.md`'s own STATE SNAPSHOT section for the current answer — it
should already say which commit is actually running in production.

**When wave 2 lands: fold it into `docs/CURRENT_STATE.md` directly**, following
that file's own "CLOSING A THREAD" section. Do not write a new numbered results
file in this folder the way wave 1 did — that pattern was reasonable when the
target file didn't exist yet; now that it does, findings belong in it directly,
not in a growing pile of build artifacts nobody will re-read.

## THE OTHER OPEN ITEM: THE GATE

`CURRENT_STATE.md`'s close ritual is currently **honor-system only**. Nothing
mechanically fails if a thread ships a domain and doesn't add a row. The file
itself says so. A test that discovers domains (the way
`tests/gate_ask_spine_readers.js` discovers Ask Spine registrations) and fails
when one has no corresponding row would close that gap. Not built. Worth doing
before this decays the way `docs/CODEBASE_STATE.md` did.

---

## WHY THIS EXISTS (unchanged — still the reason any of this matters)

Threads kept losing track of what was built. Renewals, turnovers, an
obligations queue, a follow-up ladder and a person-correction path were each
built, then later described as missing in a subsequent thread. Root cause:
**a historical narrative was being asked to answer a current-state question.**

`docs/THREAD_HANDOFF.md`, measured 2026-08-19: 3,992 lines, 50 banner sections,
34 instances of supersession language. Its own top banner said "EQUITY IS
LIVE" while Equity was merged and not production-verified — the file
demonstrated the exact problem it was being asked to solve. It's now
relabelled as history at the top of the file itself; the rulings inside it are
kept, its present tense is not to be trusted.

## WHAT SHIPPED (2026-08-19 → 2026-08-20)

- `docs/CURRENT_STATE.md` — ~114 capability rows, each with proof rung, file
  path, and evidence. Explicit "not yet surveyed" section so absence is never
  read as absence. **~60% coverage, stated up front, not hidden.**
- `CLAUDE.md` — opens by routing to it, grep-first, before `PHILOSOPHY.md` and
  before `THREAD_HANDOFF.md`.
- `docs/THREAD_HANDOFF.md` — relabelled as history, its own two stale
  present-tense claims named inline as the demonstration. All 3,992 lines and
  every ruling preserved.
- `.claude/hooks/session_start.sh` + `.claude/settings.json` — fires
  automatically at the start of every thread, prints the three-document
  priority order, and runs the staleness check itself.
- The close ritual, written directly into `CURRENT_STATE.md`'s own
  "CLOSING A THREAD" section, with a paste-able prompt.
- Wave 1 complete: 44 capabilities, independently adversarially verified (40
  had a claim corrected on review — mostly downgraded one rung, two reversed
  outright, one *upgraded* to `PRODUCTION_PROVEN`). Folded into the file.
- A second, independent PR-level review by Codex on the Asset Management and
  Meeting Evidence domains, spot-checked (4/5 claims confirmed against real
  source) and folded in — including the second and third genuinely
  `PRODUCTION_PROVEN` findings in the whole system (Meeting Evidence webhook
  ingress; binding/finality), both stated narrowly next to the fact that the
  pipeline downstream of them still produces zero receipts.
- The pricing bug (`agent.js` quoting `units.market_rent` directly to real
  prospects, unit-530 incident, $237 off, nine phones) documented in full and
  handed to a separate thread to fix. Recorded as defect #1.
- A shareable findings report (`04_FINDINGS_REPORT.md`) written for an
  audience outside this repo.

## KNOWN GAPS — stated, not hidden

- **~40% of the codebase is unsurveyed.** See "WHAT'S ACTUALLY LEFT" above.
- **The gate doesn't exist yet.** The close ritual is a convention, not an
  enforcement mechanism.
- **Production may still not run `main`.** Check `CURRENT_STATE.md`'s own
  snapshot for the current answer before assuming this is resolved.
- **The pricing bug's fix status** lives in whatever thread is handling it,
  not here — check `CURRENT_STATE.md` defect #1 for its current state.

---

## STANDING CONSTRAINTS (unchanged)

- **No product code changes from this build effort.** This is documentation
  and one hook. If a thread working from this file starts editing `src/`, it
  has drifted from the assignment — that belongs to whatever thread owns the
  actual fix (pricing, teams, etc.), not to the CURRENT_STATE.md build.
- **No taxonomy improvement without the owner.** Evidence grain first, always.
- **Never upgrade a row because code looks finished.** Only an observed proof
  rung upgrades a row.
- **`NOT_FOUND` over a plausible guess**, always.

## HISTORICAL BUILD ARTIFACTS IN THIS FOLDER

Kept for provenance, not required reading to continue the work:

| File | What it is |
|---|---|
| `01_DESIGN_SPEC.md` | The three rules locked with the owner, before any row was written |
| `02_INVENTORY_DRAFT.md` | The raw evidence-grain draft that became `CURRENT_STATE.md` |
| `03_WAVE1_RESULTS.md` | Full wave 1 detail — all 44 capabilities, claimed vs. adversarially-verified rung |
| `04_FINDINGS_REPORT.md` | The shareable version, written for an outside audience |
| `wave1_new_domains.js` | Re-runnable — already run once, results are in `CURRENT_STATE.md` |
| `wave2_coverage_gaps.js` | Re-runnable — **not yet run to completion**, this is the actual next step |
