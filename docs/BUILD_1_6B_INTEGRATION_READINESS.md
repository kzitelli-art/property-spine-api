# Builds 1–6B — integration readiness audit

**Audited 2026-07-29. Analysis and documentation only — nothing was modified,
rebased, renumbered or resolved.**

> **Builds 1–6B remain Built but dormant.**
>
> Every claim in this document is about *source and git state*. No Build has
> been exercised against a real database through real HTTP, and none has been
> verified in a browser. Nothing here upgrades any Build's proof level, and
> "integrates cleanly" is not "works".

---

## 1. Current main state

| | SHA | Date | Subject |
|---|---|---|---|
| API `origin/main` | `21adf9e` | 2026-07-28 | Phase H: published is not quotable — two false reads found by browser proof |
| App `origin/main` | `ae7abe3` | — | Card renders server-supplied before/after labels |

**API migration ceiling on main: `111`** (`111_governed_charge_rulings.sql`),
112 tracked migration files including `000_schema_migrations.sql`.

**Migrations 112–117 are free on `origin/main`.** So is 118.

Main has not moved since the Builds forked. `git merge-base 57eb7e8
origin/main` is `21adf9e` itself, and **`origin/main` is an ancestor of both
Build 6B tips** — the integration is a fast-forward, not a rebase.

### Every other branch, checked for collision

| Branch | Merge-base with main | Last commit | Highest migration | Occupies 112–117 | Touches Build files |
|---|---|---|---|---|---|
| `agent/governed-terms-review-big-build` (API `e8c3dca`) | **none — unrelated history** | 2026-07-19 | 086 | no | `server.js`, `src/surfaces/availability_read.js` *(see below)* |
| `feat/org-onboarding-wizard` (`bf16989`) | `5cd198b` | 2026-07-27 | 106 | no | none |
| `fix/prospect-text-punctuation-and-no-promises` | none — unrelated history | 2026-07-25 | 090 | no | none |
| `fix/scheduling-adapter-seam-require` | none — unrelated history | 2026-07-25 | 090 | no | none |
| `tools/qa_provision.js` | none — unrelated history | 2026-07-06 | 070 | no | none |
| `claude/build-6-live-runtime-proof` (`a269fce`) | `21adf9e` | — | 117 | yes — *same blobs* | descends from Build 5 |
| `claude/runtime-baseline-intake-kit` (`51971b9`) | `21adf9e` | — | 117 | yes — *same blobs* | descends from `a269fce` |

**No branch anywhere occupies migrations 112–117** except the Build line
itself and its two descendants, which carry byte-identical blobs.

### The economic-plumbing branch

`agent/governed-terms-review-big-build` is at API `e8c3dca` / app `03744fd`.
Its last commit is **2026-07-19**, before the Build sequence began, so it has
not moved during this work.

Three things about it matter more than its SHA:

1. **It shares no history with `main`.** `git merge-base origin/main
   origin/agent/governed-terms-review-big-build` returns nothing. It cannot be
   merged without `--allow-unrelated-histories`, so it is not a branch that
   will collide with the Builds in any ordinary workflow.
2. **Its highest migration is 086.** The 088–111 files in its tree are
   pre-restructuring copies, not new numbers.
3. **The live economic work is on `main`, not on that branch.** Main's last
   eight commits (2026-07-28) are Slice B/D/E/G and Phase H — governed
   charges, pricing publication. The economic thread has been landing directly.

So the standing instruction — *do not touch the economic-plumbing thread's
files* — is best read against **`main`**, and against the two files below.

---

## 2. Branch lineage — VERIFIED

Every SHA is an ancestor of the next. No re-parenting, no orphan, no
force-push in either repo.

### API

```
21adf9e (main)
  └─ b89364e  Source comparison: contract vs current source
     └─ 575262a  Relabel unit-status audit as preliminary
        └─ b36bf6c  BUILD 1: post-move-out initial unit triage (112)
           └─ e036990  BUILD 1 corrections
              └─ 57eb7e8  ★ BUILD 1 FROZEN
                 └─ bbeaefb  BUILD 2: normal turn scope and ordered flow (113)
                    └─ 089da41  ★ BUILD 2 FROZEN (114)
                       └─ 7756c88  BUILD 3: work acceptance, proof, progression (115)
                          └─ c3a1e12  ★ BUILD 3 FROZEN
                             └─ 1d30dfb  BUILD 4: readiness walk + certification (116)
                                └─ f8174c9  ★ BUILD 4 FROZEN
                                   └─ 8fc4982  ★ BUILD 5 FROZEN (117)
                                      └─ 62b25e8  ★ BUILD 6A FROZEN
                                         └─ f1730bc  BUILD 6B: operator-language cleanup
                                            └─ b562339  ★ BUILD 6B FROZEN
```

15 commits. `a269fce` (Build 6, blocked) branches off **Build 5**, is **not**
an ancestor of 6A or 6B, and carries the baseline intake kit downstream. It is
outside the integration.

### App

```
ae7abe3 (main)
  └─ 065fc6d  ★ BUILD 1   → f0051a4 ★ B2 → 978882c ★ B3 → cf604e2 ★ B4
     → 9e9fff0 ★ B5 → d3e2ff8 ★ B6A → 3116576 → f60511a ★ BUILD 6B FROZEN
```

8 commits. **No SHA failed the ancestry check in either repo.**

Note: the API Build 1 tip and the app Build 1 tip both live on
`claude/mobile-code-quality-iy1u16`; Builds 2–6B each have their own branch.

---

## 3. Change inventory

**API: 36 files, +12,049 / −2.** **App: 7 files, +2,301 / −0.**
Only **four** files in the two repos combined are modifications rather than
additions.

### Migration (6 files, all new)

`migrations/112_unit_triage_capture.sql` · `113_unit_turn_scope.sql` ·
`114_inherited_work_stage_decision.sql` · `115_work_acceptance_and_proof.sql` ·
`116_readiness_certification.sql` · `117_staff_agent_capture.sql`

### Shared runtime file (3 — the only API files that were MODIFIED)

| File | Change | Risk |
|---|---|---|
| `server.js` | +47 / −1. Six mounts appended after `workOrderService`; one existing line changed to pass `unitTriageService` into `turnoversModule`. | **Low.** Append-only in a region main does not touch. |
| `src/maintenance/turnovers.js` | +36 / −0. Optional injected `unitTriageService`; spawns the initial-walk obligation from the same `move_out` event, same transaction. Absent injection ⇒ prior behaviour exactly. | **Low.** Soft-deploy shape, mirrors `recordEffectivePossession`. |
| `src/surfaces/availability_read.js` | +209 / −1. Adds `require("../maintenance/unit_triage_service")` for `deriveReadiness`, and a triage overlay **entirely inside `if (p.triage)`**. Certification **falls through** rather than returning, so every earlier guard still wins. | **Medium — the one file to review closely.** See §4. |

### New isolated file (17 API)

`src/maintenance/`: `unit_triage.js`, `unit_triage_interpreter.js`,
`unit_triage_service.js`, `unit_turn_scope.js`, `unit_turn_scope_service.js`,
`turn_scope_interpreter.js`, `turn_sequence.js`, `work_acceptance.js`,
`work_acceptance_service.js`, `work_proof.js`, `readiness.js`,
`readiness_gate.js`, `readiness_service.js`
`src/agent/`: `staff_agent.js`, `staff_agent_intent.js`, `staff_agent_service.js`
`src/surfaces/`: `unit_turn.js`, `unit_turn_read.js`

### App composition (1 modified)

`index.html` — six `<script>` tags, one `.ut-*` style block, and
`LIVE_RESOURCES` / `WRITE_ACTIONS` registrations. One tag per door, no
duplicates. Mount points are at the document root; **permanent navigation
placement has never been ruled on** (see §8).

### Diagnostic surface (5 app files)

`unit-triage-door.js`, `turn-scope-door.js`, `work-acceptance-door.js`,
`readiness-door.js`, `staff-agent-door.js` — the Build 1–5 doors. Build 6A
demoted them from the primary path; they remain mounted deliberately.

### Primary operator surface (1 app file)

`unit-turn-page.js` — the two-screen path (turn list → Unit Turn page).

### Documentation (2)

`docs/MAINTENANCE_UNIT_STATUS_SOURCE_COMPARISON.md`,
`docs/BUILD_6B_DEFERRED_DISPLAY_LANGUAGE.md`

### Test or harness (7)

`tests/proofs/unit_triage_proof.js` · `unit_turn_scope_proof.js` ·
`work_acceptance_proof.js` · `readiness_certification_proof.js` ·
`staff_agent_proof.js` · `unit_turn_page_proof.js` ·
`operator_language_proof.js`

### Authority foundations — read, never modified

The Builds add no identity or authority code. They **consume**
`src/identity/staff_session_service.js` (`resolveStaffSession`), the
`x-staff-session` header, and `property_team_assignments`
(`allowed_modules`, `primary_for_modules`, `role_title`). Not one of those
files appears in the change inventory.

### Files also touched by economic work

`server.js` and `src/surfaces/availability_read.js` appear in the
`agent/governed-terms-review-big-build` tree. That branch shares no history
with main, so this is not a git conflict — it is a **review overlap**: whoever
lands economic changes to `availability_read.js` and whoever lands the Builds
are editing the same file for different reasons.

---

## 4. Conflict map

### Textual conflicts: NONE

Simulated in disposable worktrees against current `origin/main`. The frozen
branches were not rewritten and nothing was force-pushed.

| Simulation | Result |
|---|---|
| `git rebase --onto origin/main 21adf9e b562339` | "up to date" — main is already the base. Resulting tree **identical** to `b562339`. |
| `git merge --no-commit --no-ff b562339` onto main (API) | clean, **0 conflicted files** |
| `git merge --no-commit --no-ff f60511a` onto main (app) | clean, **0 conflicted files** |

### Migration-number collisions: NONE

112–117 free on main; 117 files, zero duplicate numbers, zero gaps in 001–117
after integration. `migrations/migrate.js`'s duplicate-number and
spent-number guards both pass on the integrated folder.

### Route-mount conflicts: NONE

27 Build routes against 99 existing `/operator/*` routes on main — **no exact
path collision**. Six `app.use` mounts, each appearing exactly once; no
duplicated `require`.

### Semantic checks where git reports clean

| Check | Result |
|---|---|
| `server.js` parses after integration | OK |
| All 10 Build service/pure modules load | 10/10 |
| `availability_read` ⇄ `unit_triage_service` require cycle | **No cycle.** `unit_triage_service` requires `unit_triage_interpreter` and `tenancy/position_classifier`; it does not require `availability_read`. Both load together. |
| Build harnesses on the integrated tree | 909 assertions pass, **1 fails** (see below) |

### One real finding — a stale assertion in the Build 6B harness

`tests/proofs/operator_language_proof.js` §8 asserts that Build 6B changed only a
named allow-list of files. Build 6B's own final commit (`b562339`) added
`docs/BUILD_6B_DEFERRED_DISPLAY_LANGUAGE.md`, which is **not in that list**,
so the assertion fails **at the frozen Build 6B tip**:

```
  assertions passed: 243
  assertions failed: 1
   ✗ only the language surfaces changed  — docs/BUILD_6B_DEFERRED_DISPLAY_LANGUAGE.md
```

This corrects an earlier report of 244/0: the harness was run **before** that
documentation file was committed and not re-run afterwards.

It is a defect in the harness's own bookkeeping, not in the product — no
source or migration file is implicated, and the other 243 assertions
(including every removal Build 6B exists to prove) still pass. **Not fixed
here**, because Builds 1–6B are frozen. It is a one-line pre-merge commit:
add the doc path to `ALLOWED`.

### Changed assumptions from newer main: NONE

Main has not advanced past the fork point. Every assumption the Builds were
written against still holds — but this is a fact with a shelf life. **If main
advances before integration, re-run this simulation**, paying attention to:

- `src/surfaces/availability_read.js` — the guard-precedence chain the triage
  overlay falls through
- `src/tenancy/space_position.js` — still filters `turn_status` to
  `'in_progress'`, which is why the shared readiness classifier was left alone
- `src/maintenance/turnovers.js` — the `move_out` event path
- `server.js` — the mount region after `workOrderService`

---

## 5. The six migrations as a set

| # | File | Purpose | Depends on | Creates / alters |
|---|---|---|---|---|
| 112 | `unit_triage_capture.sql` | Post-move-out initial triage. Readiness is derived, never stored. | `properties`, `units`, `users`, `obligations` | **creates** `unit_observations`, `unit_triage_confirmations`, `unit_triage_findings`, `unit_triage_required_work` + 10 indexes |
| 113 | `unit_turn_scope.sql` | Normal turn scope and ordered flow. One work list, not two. | **112** | **creates** `unit_turn_scopes`, `unit_turn_appliances`; **alters** `unit_triage_required_work` (+`stage`, `turn_scope_id`, `disturbs_painted_surfaces`, `sequence_exception*`), `unit_triage_findings` |
| 114 | `inherited_work_stage_decision.sql` | Inherited work that a complete scope never placed. **No new table.** | **112, 113** | **alters** `unit_triage_required_work` (+`stage_decision_required`, `stage_decision_note`) + 1 partial index |
| 115 | `work_acceptance_and_proof.sql` | Acceptance ≠ completion ≠ proof. | **112** (work rows), **113** (stages) | **creates** `work_acceptances`, `work_completion_claims`, `work_reopenings`; **alters** `unit_triage_required_work` status CHECK to add `complete` |
| 116 | `readiness_certification.sql` | The only path that may establish `ready`, and only from a human certification. | **112–115** | **creates** `unit_readiness_walks`, `unit_readiness_certifications`, `reclean_rulings`; **alters** `unit_triage_required_work` (+`readiness_walk_id`), `unit_triage_findings` |
| 117 | `staff_agent_capture.sql` | Conversation capture. **Owns no domain model.** | `properties`, `users`, `units` only | **creates** `staff_agent_threads`, `staff_agent_messages`, `staff_agent_proposals` + unique confirmation index |

**Ordering is strict.** 113–116 each ALTER a table 112 creates, so the set
must apply in numeric order. 117 is independent of 113–116 but is the door
into all of them.

### Safe to renumber before deployment? **Yes — with two caveats.**

- **No Build source file references a migration number in code.** Numbers
  appear only in comments in three files (`unit_turn_scope_service.js`,
  `turn_scope_interpreter.js`, `turn_sequence.js`) and in commit messages.
  No app file references a migration number at all.
- **Caveat 1 — the baseline intake kit does.**
  `scripts/runtime-proof/baseline_analysis.js` (on
  `claude/runtime-baseline-intake-kit`, `51971b9`) hard-codes `"112"`–`"117"`
  in its `BUILD_MIGRATIONS` table. Renumbering requires updating it in the
  same change, or the verifier will report the Builds as pending forever.
- **Caveat 2 — relative order must be preserved.** Renumbering means shifting
  the whole block, never resequencing within it.

### Proposed contiguous replacement range — NOT NEEDED TODAY

112–117 are free. If main claims any of them before integration, use the next
free contiguous block of six and shift all six together, preserving order:

```
112 → N+0   unit_triage_capture
113 → N+1   unit_turn_scope
114 → N+2   inherited_work_stage_decision
115 → N+3   work_acceptance_and_proof
116 → N+4   readiness_certification
117 → N+5   staff_agent_capture
```

Never renumber a subset, and never fill a gap left elsewhere — the runner keys
on the number alone, so a partial reshuffle silently skips a migration.

### Deployed anywhere known? **No.**

None of the six is recorded in any ledger this work has seen. The production
ledger has never been read — that is precisely what the baseline artifacts are
for. **Ledger state is unknown, not empty**, and the verifier exists to
establish which.

---

## 6. Runtime prerequisites for the thin golden path

### Known from source

| Prerequisite | Detail |
|---|---|
| `DATABASE_URL` | Neon Postgres. `prestart` runs `node migrations/migrate.js`. |
| **No new environment variable** | The 18 Build-added source files reference **zero** `process.env` values. |
| Authenticated staff session | `x-staff-session` header → `staff_session_service.resolveStaffSession`. Reads `staff_sessions`, `users`, `property_team_assignments`, `properties`. |
| Property assignment | An active `property_team_assignments` row for the operator at the property. Property is server-derived from the session — a client-supplied `property_id` is refused. |
| Module permission — operate | `allowed_modules` must include `maintenance` **or** `management` for every Build door. |
| Module permission — certify | Readiness certification needs **three** conditions: an active assignment, `allowed_modules` including `management`, **and** either an eligible manager `role_title` or `primary_for_modules` including `management`. Management access alone is not sufficient. |
| Migration ceiling | Baseline must be applied through **111** before 112 runs. |
| DB function | `gen_random_uuid()` — used on 15 primary keys across 112–117. `now()` on 23 defaults. |
| Photo storage | **None required.** `photos` is `text[]` — *references only*. No upload library, no bucket, no CDN, and nothing inspects an image. |
| App → API URL | Pinned to `https://property-spine-api.onrender.com` in `index.html`. |
| Background process | **None.** Every Build write is synchronous inside its request transaction. |

### Assumed

- `gen_random_uuid()` is available on the baseline — pgcrypto or PG ≥ 13. The
  migrations do not `CREATE EXTENSION`, so they assume prior migrations did.
  **The verifier checks this before anything is applied.**
- The Render deployment already serves `main` with the same `DATABASE_URL` the
  baseline is exported from.
- The `x-staff-session` flow used by existing operator surfaces works
  unchanged for these doors — the Builds add no auth code, only consume it.

### Still unknown

- **The production ledger's actual contents.** Whether 112–117 are free
  *there*, whether the ledger and the objects agree, whether the historical
  chain left a spent number. Unknowable until the artifacts arrive.
- **Where the operator surfaces live in the app's navigation.** The mount
  points sit at the document root because no host-surface placement was ever
  ruled on. Reachability from the maintenance hub is unverified.
- **Whether a real staff session in production carries the module permissions
  the golden path needs**, for any specific person.
- **Whether `gen_random_uuid()` is actually present** on the real baseline.

No configuration value has been manufactured anywhere in this document.

---

## 7. Recommended integration approach

### **Option A — rebase and merge Build 6B as one cumulative change.**

Because:

1. **There is no rebase to do.** `origin/main` is an ancestor of both Build 6B
   tips. Integration is a fast-forward with zero conflicts in either repo,
   proven by simulation. Options B and C both introduce risk that Option A
   does not have.
2. **Option B (sequential merges) buys nothing and costs six merge points.**
   The intermediate SHAs are already in the history Option A merges — Build 3's
   reasoning is not lost by merging Build 6B, because Build 3's commit *is* an
   ancestor of it. Sequential merging would re-expose six intermediate states
   as separately-deployable, and three of them contain behaviour Build 6B
   deliberately removed (conversational acceptance, readiness requests,
   the failed-walk door, generic corrections). Landing those as their own
   merge points makes them look like product decisions that were reversed,
   rather than a build sequence that converged.
3. **Option C (replay onto a release candidate) discards the reasoning without
   reducing any risk.** Its usual justification is a messy history over a moved
   base. The base has not moved and the history is a clean linear chain where
   every commit message records a ruling. Replaying would require re-proving
   all 910 assertions against a re-authored tree to reach a state git can
   already produce for free.
4. **The final product is what Option A delivers.** The end state of the merge
   is the two-screen Unit Turn experience with three staff-agent purposes —
   exactly the simplified product. The Build 1–5 doors survive as *diagnostic
   routes*, which is a deliberate Build 6A decision, not an accident of
   history.

### Sequence

1. One pre-merge commit on a fix branch: add
   `docs/BUILD_6B_DEFERRED_DISPLAY_LANGUAGE.md` to `ALLOWED` in
   `tests/proofs/operator_language_proof.js`. **Nothing else.**
2. Re-run all seven harnesses. Expect 910/0.
3. Re-run the conflict simulation — main may have moved by then.
4. Fast-forward or `--no-ff` merge API `b562339` and app `f60511a`.
5. Deploy applies 112–117 via `prestart`.

**Do not do step 4 or 5 before the baseline work in §9 is finished.**

### On the diagnostic doors

They are **not deleted** by this audit, and Option A does not delete them.
Whether the Build 1–5 doors and their five app files should be retired is a
separate governed decision that belongs **after** browser verification confirms
the two-screen path covers every operator need — retiring them first would
remove the only working surface for anything the new page turns out to miss.

---

## 8. Unresolved decisions

Each of these needs a human answer. None is blocking *this audit*; several
block a merge.

1. **Fix the stale harness assertion before merging?** Recommended: yes, as a
   single one-line commit on its own branch. It is currently red at the frozen
   tip.
2. **Where do the operator surfaces live in the app's navigation?** Never
   ruled on. Six mount points sit at the document root. Until this is decided,
   the two screens are reachable only by an explicitly-constructed page state
   — which is a browser-verification blocker, not a code defect.
3. **Retire the Build 1–5 diagnostic doors, and when?** See §7.
4. **Does the grain mismatch get fixed before or after integration?**
   Maintenance captures are unit-grained; positions are space-grained. Fable
   ruled the captures correct and located the real defect in `turnovers` and
   its derivations. That work is deferred to a separate thread and is **not**
   part of Builds 1–6B.
5. **Who runs the baseline export, and when?** See §9.
6. **Four display-language leaks**, recorded in
   `docs/BUILD_6B_DEFERRED_DISPLAY_LANGUAGE.md`, deliberately deferred to live
   browser review: work status labels, generic receipt-key rendering,
   diagnostic proposal-key rendering, raw vacancy values.
7. **Does `availability_read.js` need economic-thread review before merge?**
   It is the one file both threads modify. Recommended: a targeted read of the
   guard-precedence chain by whoever owns the economic work.

---

## 9. Baseline-artifact dependency

**Everything below waits on two files that do not exist yet.**

The owner must run, on a machine with legitimate database access:

```bash
export DATABASE_URL="<connection string>"
./scripts/runtime-proof/export-baseline.sh
```

and send `spine_schema_baseline.sql`, `spine_schema_migrations.sql` and
`manifest.txt` — never the URL. The kit is frozen at `51971b9` on
`claude/runtime-baseline-intake-kit`; see `docs/RUNTIME_BASELINE_HANDOFF.md`.

Blocked until those artifacts arrive:

- **Applying 112–117 anywhere.** Migration numbers are free on `main`; whether
  they are free in the *live ledger* is unknown.
- **Confirming the ledger and the objects agree** on the real baseline.
- **Confirming the foundations exist** — `properties`, `units`, `spaces`,
  `leases`, `users`, `persons`, `property_team_assignments`, `staff_sessions`,
  `unit_events`, `events`, `obligations`, `turnovers`, `schema_migrations`,
  and `gen_random_uuid()`.
- **The thin golden-path runtime proof** — Proven (real DB + real HTTP).
- **Browser verification**, which the Definition of Done requires for operator
  workflows.
- **Any claim that a Build is live, deployed or enforced.**

Not blocked: the merge simulation, the lineage verification, this document —
all complete.

---

## 10. Status

**Builds 1–6B are Built but dormant.**

They integrate cleanly — that is a statement about git and about source, and
it is the only claim this audit makes. The proof ladder position is unchanged:

```
Reported → Locally exercised → Built-but-dormant ← HERE
   → Proven (real DB + real HTTP)   ← blocked on baseline artifacts
   → Browser verified               ← blocked on the above, and on §8.2
```

Nothing in Builds 1–6B has recorded a real fact about a real unit.
