# RESUME HERE — `docs/CURRENT_STATE.md` is LIVE and current through 2026-08-20.

> ## ▶ TO RESTART, PASTE THIS
> ```
> Read docs/CURRENT_STATE.md and docs/current-state-build/00_RESUME_HERE.md
> on main, then continue that work.
> ```
> The deliverable shipped, survived a full audit cycle, and just closed out a
> real production incident end to end. This is not a "pick up where we left
> off" file anymore — it's a living document with a working close ritual.
> Read `CURRENT_STATE.md` itself first; this file is only about what's left.

---

## WHAT'S ACTUALLY LEFT — three things, none urgent

1. **`docs/CURRENT_STATE.md` defects #12, #13, #14 are still open.** All three
   need an owner decision, not more code from a thread:
   - #12 — a real hole in published-pricing immutability (schema-level)
   - #13 — four dead falsification tests, claimed then dropped, open for anyone
   - #14 — which lease term to quote when a prospect doesn't name one. A cheap
     third option now exists (present the published menu, zero schema change)
     but it's still the owner's call
2. **The gate doesn't exist yet.** Nothing mechanically fails if a thread ships
   a domain and skips its `CURRENT_STATE.md` row. The close ritual is a
   convention, proven to work today by two independent threads following it
   correctly under real pressure — but still not enforced.
3. **~40% of the codebase remains at headline-only survey depth.** Wave 2 found
   148 capabilities across teams/access, management, onboarding, money/pricing,
   the app repo, `server.js`, and `tools/` — full detail is in
   `05_WAVE2_RESULTS.md`, not yet promoted row-by-row into the main index.

None of these block anything. They're the next things to pick up, not gaps
blocking today's close.

## WHAT SHIPPED TODAY (2026-08-19 → 2026-08-20), in order

- `docs/CURRENT_STATE.md` built, merged to `main`, `CLAUDE.md` and
  `THREAD_HANDOFF.md` updated to route every new thread to it (PR #123).
- The open/close ritual: a `SessionStart` hook that fires automatically, and a
  paste-able closing prompt written into the file itself.
- Wave 1 (44 capabilities, adversarially verified) and a second independent
  PR-level review by Codex, both folded in.
- Wave 2 completed on the third attempt (started/stopped twice before) — 148
  capabilities across the areas listed above, plus three completeness critics
  that found 8 things nobody had mapped, including a real security gap in a
  team-roster route with no property-scope check (defect #9) and a UI button
  that silently fakes success instead of sending a real invite (defect #8).
- **A real production incident, closed end to end, coordinated across two
  Claude threads with zero silent overwrites**: the `market_rent` pricing bug
  (defect #1) was fixed, proven with a real CI test, merged to `main` — which
  also resolved defect #7 (production had drifted 39+ commits ahead of `main`)
  — then deployed and confirmed live by the owner. A privilege-escalation path
  in `orgchart.js` (defect #15) got closed in the same deploy, found by the
  fixing thread as a byproduct, not gone looking for.
- **A live Neon credential, pasted into a chat during this work, rotated and
  confirmed** (defect #16).
- **I corrected two of my own mistakes on the record, in place**, rather than
  letting them stand: I initially under-rated defect #14's severity (called it
  "disclosed, not the same as #1" before checking the actual sort order and
  real numbers — it's actually the highest price on the sheet, not an
  arbitrary one), and I introduced a real self-contradiction in this file's
  own snapshot section (said "resolved" in one line, "not resolved" two lines
  below) which a disk-change diff caught before it could confuse anyone.

## THE COORDINATION PATTERN THAT WORKED

Two separate Claude threads touched this same file today without either one
silently overwriting the other. What made that work, concretely:
- Every claim from the other thread got independently re-verified against
  actual source before being recorded — never taken on trust, including once
  finding a claim was right but incomplete (the #14 severity correction).
- The other thread did the same back — re-ran my checks rather than trusting
  my report, and caught nothing wrong, which is itself informative.
- A hard boundary was stated and held: neither thread would trigger a deploy
  without the owner saying so explicitly. Merging to `main` and deploying to
  production stayed two separate, distinct actions the whole time.
- When a message arrived cut off mid-sentence (the #14 finding, first pass),
  the instinct was to go read the actual code rather than guess or wait
  around — and to say plainly "your message cut off here" rather than
  silently fill the gap with something invented.

This is worth preserving as the model for the next time two threads need to
coordinate on the same file, not just as a one-off story.

## KNOWN COVERAGE GAPS — still true, unchanged from before

- Roughly 40% of the codebase is at headline survey depth or unsurveyed.
- The close ritual is not mechanically enforced.
- App-repo doors, `server.js`'s legacy inline surfaces, and `tools/` have
  real detail sitting in `05_WAVE2_RESULTS.md` that hasn't been promoted.

---

## STANDING CONSTRAINTS (unchanged)

- **No product code changes from work on this file.** Everything here is
  documentation and one hook. Code fixes belong to whatever thread owns that
  fix, coordinated through `CURRENT_STATE.md`, not made here.
- **No taxonomy improvement without the owner.** Evidence grain first, always.
- **Never upgrade a row because code looks finished, or because a deploy
  happened.** Only an actual observation moves a rung — see defect #1's own
  entry for the live example: deployed and not yet `PRODUCTION_PROVEN`,
  stated plainly, on purpose.
- **`NOT_FOUND` over a plausible guess**, always.
- **Verify before recording, in both directions.** Every cross-thread report
  today was checked against real source before being written down, and at
  least one of those checks corrected the checker, not just the report.

## FILES IN THIS FOLDER

| File | What it is |
|---|---|
| `01_DESIGN_SPEC.md` | The three rules locked with the owner, before any row was written |
| `02_INVENTORY_DRAFT.md` | The raw evidence-grain draft that became `CURRENT_STATE.md` |
| `03_WAVE1_RESULTS.md` | Full wave 1 detail — 44 capabilities, claimed vs. verified rung |
| `04_FINDINGS_REPORT.md` | The shareable version, written for an outside audience |
| `05_WAVE2_RESULTS.md` | Full wave 2 detail — 148 capabilities, not yet promoted row-by-row |
| `wave1_new_domains.js` / `wave2_coverage_gaps.js` | Both re-runnable; both already run to completion once |
