# QB handoff — 2026-09-14 evening

For the thread that takes over as QB until Friday. Read this, then
`CLAUDE.md`, then `docs/CURRENT_STATE.md` rows 73–83, then
`docs/PHILOSOPHY.md` §5, §7, §31, §33, §40. Do not reconstruct history from
git; the board's `docs/handoffs/new-hp/*/QB_GRADE.md` files are the record
of what was graded and why.

## The job

You are the QB. You do not build product. You issue bounded assignments to a
builder thread (Opus), grade its return packets against evidence you read
yourself, integrate what passes into the board branch, keep
`docs/CURRENT_STATE.md` true, and tell Kameron plainly what is decided, what
is blocked, and what only he can decide. Kameron pastes packets to you and
pastes your assignments to the builder.

## Standing constraints (Kameron's, still in force)

No production reads or writes. No shared database actions. No provider
actions (Render, Neon, Twilio, Netlify, Plaid). No customer messages. No
deployment. No merge to `main`. No rebase, reset, amend or force-push. No
production source confirmation (the Skyline tracker mapping and the Greenery
adoption are Kameron's acts). No access grants. Fresh nonce-owned loopback
databases only, via the existing harness; preserve `spine_proofs`; drop only
your own nonce databases through `proof_boundary.js cleanup`. No SQL after a
business action to manufacture an outcome (labelled fixture SQL before
actions is allowed). Synthetic tenants only. Never commit private originals,
rows, credentials, tokens, runtime identifiers; scrub UUIDs, phones, emails,
tokens, database names, passwords and scratch paths from anything committed.
No model identifiers in repo artefacts. Push only to branches you own; never
edit a codex lane or an Opus lane.

## Where everything is

```text
Board (single integration candidate):
  claude/board-20260914 @ 6fa4638 — CI run 564 green (all eight lanes + lender read integrated); confirm the latest run yourself
  https://github.com/kzitelli-art/property-spine-api/tree/claude/board-20260914
App pin (development pin, never a release claim):
  tests/e2e/app_pin.txt → property-spine-app claude/coupled-browser-acceptance-20260914 @ b0be9f4
Production (last known, NOT re-read today; needs Kameron's /health read):
  API d15c968 · app 336c82f · schema ledger 182 rows, ceiling 194
Release candidate (NOT released):
  migrations 195–198 via tools/release/migration_194_198_predeploy.js at pin 03550a8
  (carried on the board); runbook
  docs/handoffs/new-hp/combined-194-198-release/RELEASE_RUNBOOK_20260914.md
Walkthrough 15 Sept with Mike:
  docs/handoffs/new-hp/walkthrough-20260915/RUNSHEET.md (+ fallback screenshots)
Lender read of Skyline (the read that matters):
  docs/handoffs/new-hp/lender-read/SKYLINE_LENDER_READ_20260914.md, row 80
```

Every Opus lane graded today and its grade file:

| # | lane | head | grade | state |
|---|---|---|---|---|
| 1 | `claude-opus/ci-browser-rungs-20260914` | c94a6c3 | `ci-browser-rungs/QB_GRADE.md` | integrated |
| 2 | `claude-opus/matching-basis-20260914` | 6b5403a4 | `matching-basis/QB_GRADE.md` | integrated (two correction rounds) |
| 3 | `claude-opus/ask-gate-reachability-20260914` | 3485fdb6 | `ask-gate-reachability/QB_GRADE.md` | integrated |
| 4 | `claude-opus/debt-vocabulary-20260914` | 09e54623 | `debt-vocabulary/QB_GRADE.md` | integrated |
| 5 | `claude-opus/ask-entitlement-proof-20260914` | 0f66c663 | `ask-entitlement/QB_GRADE.md` | integrated |
| 6 | `claude-opus/compliance-guard-20260914` | 34068706 | `compliance-guard/QB_GRADE.md` | integrated |
| 7 | `claude-opus/rent-roll-lender-lines-20260914` | 371a460a | `rent-roll-lender-lines/QB_GRADE.md` | integrated (row 82) |
| 8 | `claude-opus/silence-not-authorized-20260914` | be3ebed4 | `silence-not-authorized/QB_GRADE.md` | integrated (row 83) |
| 9 | refusal envelope on every domain + a consumer for `withheld` | not started | ruling in `silence-not-authorized/QB_GRADE.md` | next lane to write, after the walkthrough |

## The grading routine (do exactly this per packet)

1. `git fetch origin <lane>`; `git log --oneline <board>..origin/<lane>`;
   `git diff --stat <board> origin/<lane>`. Confirm scope: if the lane was
   "harness only" or "one file", the diff under `src/` must prove it.
2. Read the product diff yourself. Do not grade from the packet's prose.
   Things that have bitten today: a paraphrased regex in a packet dropped a
   whitespace token the source had; a "gathered" claim was a source regex
   while the branch was unreachable; a date compared as a string was only
   right because the read produces ISO strings (checked by reading the
   producer and the CI log's own note line).
3. CI: read the run's conclusion from the GitHub API, and pull the step line
   for the lane's new proof from the job log. Steps early in
   `verify_all.sh` (unit tests, governance) sit outside the fetchable log
   window from both containers; then the run's conclusion plus your own bare
   local run is the evidence, and say so. A pipe eats exit codes: run gates
   bare and read `$?`.
4. Merge the lane into the board worktree with `--no-commit --no-ff`, then
   run on the merged tree: the lane's proof, `tests/gates/
   gate_ask_spine_readers.js`, `tests/scenarios/
   ask_spine_reader_gate_falsification.js`, `tests/gates/
   gate_current_state.js`, and `tests/verify_source_governance.js` (bare).
   Rows must be contiguous; two lanes adding "the next row" collide, so
   renumber the later one at integration and say so in the grade.
5. Scrub the added lines of every committed artefact (UUIDs, phones, emails,
   tokens, `spine_proof_<hex>`, `spineproof`, `*.neon.tech`, scratch paths,
   model names). A Haiku subagent does this well.
6. Write `docs/handoffs/new-hp/<lane>/QB_GRADE.md`: verdict, what you
   verified yourself, claims graded CONFIRMED / PLAUSIBLE / REJECTED with
   evidence, findings recorded, rulings on the packet's owner decisions.
   Record your own errors in it when the lane found one (three today).
7. Commit the merge with the grade, push the board, confirm the board CI run
   is green before handing out the next assignment that branches from it.

Model policy: Haiku for lookups, log extraction and scrubs; Sonnet for
bounded execution with a clear spec; the QB's own model for judgment,
product semantics, doctrine rulings, grading. Re-verify subagent claims;
one invented a SHA, one missed branches through pagination.

## What the rent roll conversation settled (read before touching Skyline or Greenery)

- The rent roll is a **read** of `datedPropertyPositions` at a date
  (`src/surfaces/rent_roll_canonical.js`, WRITES NOTHING). A tracker is
  evidence that establishes an opening position; after that, facts are
  authored live and the tracker is history.
- The import never defines the row set; canonical spaces do. Loading a file
  as the row spine is what produced Greenery's 171 rows against 105 real
  positions.
- Axes are independent and are never collapsed into one status. The
  tenancy axis in code has five values (contested, contractually_occupied,
  activation_pending, unresolved, vacant); the header lists four.
- Occupancy and vacancy are asymmetric; vacancy is established last.
- Read of the Skyline-shaped fixture (synthetic figures, real shape): trusted
  rent $26,350 from 31 positions; denominator 147; contested 13 spaces /
  $26,250 visible and uncounted; needs review 26; not established 0. Three
  lender-facing gaps (row 80) are assignment #7.
- Greenery: establish grain first, retire the 171 through supersession
  (`179_activation_source_supersession.sql`), never delete; no
  property-specific branch, ever.

## Decisions only Kameron can make (ask, do not decide)

0. Ship pins if he says go: API board head 6fa4638 (release 195–198 via the wrapper at the pins carried on the board), app b0be9f4. Nothing is deployed as of this handoff.

1. Release go: 195–198 at API 03550a8 (on the board) and app b0be9f4; who
   runs the runbook; anything in production a deploy must not interrupt.
2. Skyline tracker cutover date: the day the spreadsheet stops being edited
   and Spine is the rent roll.
3. Greenery: the real source file; whether it is unit or bed grain; the
   staff login (name, phone, role, may they author a lease); live leads on
   day one or inventory first.
4. The eight Skyline production reads (runsheet): website form secret, text
   line, published pricing, marketable-now beds, lease configuration ready
   to execute, five allow-lists, ledger mode, Mike's assignment and signing.
5. The `61f99bf` production stamp in CURRENT_STATE waits for his `/health`
   read.
6. Exact-spaces caller migration to the matching read (successor lane); the
   matching screen (app lane, after the walkthrough).

## Traps learned today, in one line each

- Two rows numbered 80 in two lanes; renumber at integration.
- A proof that borrows the shared Skyline fixture measures suite order; the
  proof must own its inventory.
- The Ask gate proved an assignment existed, not that a question reached
  it; now it calls the live router (row 77). Every `registered` domain has
  `reached_by` and `entitled_by`.
- `composite_silence` marks every non-OK read state BLIND, so a
  NOT_AUTHORIZED envelope collapses "may not read" into "did not return"
  (assignment #8).
- The release wrapper's hashes were CRLF; on Linux it refused. Fixed at
  03550a8; a test recomputes the pins from the git blobs.
- `innerText` can read text under a full-screen overlay; ask the document
  with `elementFromPoint`.
- Naming a regression test from pattern instead of a listing (the QB did it
  once today); grep first.

## Prompt to start the new QB thread

```text
You are the QB for Property Spine until Friday. Read, in order:
docs/handoffs/new-hp/qb-handoff/QB_HANDOFF_20260914.md on branch
claude/board-20260914 (kzitelli-art/property-spine-api), then CLAUDE.md,
then docs/CURRENT_STATE.md rows 73–83, then PHILOSOPHY.md §5, §7, §31, §33,
§40. Confirm the board head and its latest CI run yourself before anything
else. Then: grade the next Opus packet Kameron pastes using the routine in
the handoff, integrate what passes, keep CURRENT_STATE true, and report to
Kameron in plain language what is decided, blocked, and his to decide. Use
Haiku for lookups and scrubs, Sonnet for bounded execution, your own model
for judgment. Obey the standing constraints in the handoff verbatim. Never
grade from a packet's prose; read the diff.
```
