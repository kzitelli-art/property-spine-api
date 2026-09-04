# CURRENT STATE — what exists, and at what proof level

> # ⛔ BEFORE YOU BUILD ANYTHING, SEARCH THIS FILE.
>
> This file exists for one reason: **threads keep rebuilding things that already
> exist.** Renewals, turnovers, an obligations queue, a follow-up ladder and a
> person-correction path were each built, then later described as missing.
>
> **Search this file for the thing you are about to build.** If it appears here,
> your job is almost certainly to *extend or connect* it — not to write it again.
>
> ```bash
> grep -in "renewal\|turnover\|notice" docs/CURRENT_STATE.md
> ```

**THIS DOCUMENT DESCRIBES CURRENTLY OBSERVED CAPABILITY, NOT PRODUCT INTENT.**

| File | Answers |
|---|---|
| **`CURRENT_STATE.md`** (this) | **What exists now, and at what proof level** |
| `PHILOSOPHY.md` | What the product should mean · how to decide if a feature belongs |
| `THREAD_HANDOFF.md` | **History.** What happened, and why. Not current-state authority. |

Resolution order for any present-tense question:

```text
CURRENT SOURCE / RUNTIME  →  CURRENT_STATE.md  →  PHILOSOPHY  →  THREAD_HANDOFF
   (always wins)              (this file)         (meaning)      (history only)
```

> ### ⚠ ABSENCE FROM THIS MAP IS NOT ABSENCE FROM THE PRODUCT
> **The survey is complete as of 2026-08-20** — three waves plus four completeness
> critics covered every `src/` directory, all 176 migrations, all 292 test files, CI,
> the app repo, `server.js`'s inline routes, and `tools/`. That means gaps here are now
> *depth*, not *breadth*: ~350 capabilities are recorded, but only the decision-changing
> ones are promoted into the index below. Full detail lives in
> `docs/current-state-build/03_`, `05_` and `06_WAVE3_RESULTS.md`.
>
> **Still: if something is not listed, its state has not been established here — that is
> not evidence it does not exist.** Search the source before concluding anything is
> missing, and add what you find. Four waves each found things the previous ones missed,
> including a full CI pipeline nobody had recorded.

---

## STATE SNAPSHOT

```text
API verified against    bcd3089     2026-08-20  (github main, deployed commit)
PRODUCTION DEPLOYED     bcd3089     2026-08-20  ← confirmed by owner, RESOLVED #7
APP verified against    c6769ba     2026-08-18
Production ledger       ceiling 187 (schema)
Migrations on main      187         → matches production, resolved by PR #128
Surveyed / verified     2026-08-19 (wave 1) · 2026-08-20 (Codex PR review, AM
                        domains) · 2026-08-20 (wave 2, 148 capabilities:
                        teams/access, management door, onboarding intake,
                        money/pricing, app repo, server.js inline, tools/)
                        · 2026-08-20 (pricing fix deployed, PR #128, live)
                        · 2026-08-20 (wave 3 FINAL: migrations 001-119,
                        src/shared + governance, all 292 tests, CI reality —
                        58 findings, survey now complete)
```

✔ **RESOLVED 2026-08-20: production now runs `main`'s lineage.** Was: the
deployed commit lived only on a separate branch, 39+ commits ahead, carrying
migrations `main` lacked. PR #128 landed that branch on `main`; the owner then
deployed `main`'s head (`bcd3089`) manually from the Render dashboard and
confirmed it live directly. See defect #1 for what shipped in that deploy, and
defect #7's row for the full resolution history — kept as a record, not deleted.

**Staleness check — run this, do not trust the SHA above.** Naming a SHA in a file
is self-defeating: committing the file changes the SHA. So the guarantee is stated
as something checkable instead:

```bash
git diff --name-only 77f93f5..HEAD -- src/ migrations/ server.js
```

**Empty → every row below is current.** Non-empty → rows touching those paths are
*navigation only* until reverified. Reverify the row, then update it here.

---

## THE VOCABULARY — say the rung, never "done"

| Rung | Means | How it is earned |
|---|---|---|
| `REPORTED` | A document claims it; no code evidence found | — |
| `LOCALLY_EXERCISED` | Logic tested, **no real database** | a `.test.js` with no `pg` |
| `BUILT_BUT_DORMANT` | Code exists, **nothing calls it** | grep finds no `src/` or `server.js` caller |
| `HTTP_PROVEN` | **One** test: real Postgres **and** real router | `require("pg")` + `listen()` in the same file |
| `BROWSER_VERIFIED` | Real Chromium drives the real surface | a `*.browser.js` — *check it isn't a fake pool* |
| `DEPLOYED` | Confirmed present in the deployed build | `git merge-base --is-ancestor <sha> <deployed>` |
| `PRODUCTION_PROVEN` | **Observed working in production** | a recorded live run |

Never write *done*, *built*, *working*, *live*, *mostly done*. Those blend intent
with evidence — which is the failure this file exists to end.

**Three traps this repo has actually hit:**
- A file named `*.db.js` proves nothing. **Open it.** **Ten** files pass a hand-built
  fake pool to a real router — not the three previously named. See defect #19.
- A browser proof can run against a simulated database. **Check for `fakePool()`.**
- **A rung earned once is not a rung held.** Most `HTTP_PROVEN` and `BROWSER_VERIFIED`
  rungs in this file rest on the 68 `.db.js` proofs and 94 `*_proof.js` files — **none
  of which any automation runs** (defect #17). They passed when a human ran them. Nothing
  re-runs them, so nothing would notice if they broke. Read every rung below as *"was
  demonstrated at least once,"* not *"is continuously verified."*

---

## STRUCTURE THREAD — 2026-08-27 (file renames, server.js decomposition, tests reorg)

A structure-only thread. **No route path changed, no mount order changed, no
behavior changed by intent.** Proof: route-registration inventory extracted from
`git show HEAD:server.js` vs the new structure is set-identical (36 moved
registrations, 1:1, only `app.*` → `router.*` prefixes differ), and
`./tests/e2e/verify_all.sh` ran **ALL PROOFS PASSED** against a real local
Postgres 16 (schema built from the real migration chain via
`tests/e2e/apply_migrations.sh`) — twice, before and after the test reorg.
Browser rung SKIPPED locally (no Chromium) — same honest skip CI reports.

What moved:

| Change | Detail |
|---|---|
| 20 `src/` files renamed | fused/camelCase → snake_case: `leasingleads.js` → `leasing_leads.js`, `teamaccess.js` → `team_access.js`, `leasingShadowImport.js` → `leasing_shadow_import.js`, etc. Full list in git history. Two **pinned git-history references** inside tests (`git show <sha>:src/comms/tenantlink.js` in the conversation gates) initially corrupted by the sweep — restored; pinned SHAs keep the pre-rename path on purpose |
| `server.js` 3,648 → 836 lines | Inline blocks extracted **verbatim** per the organ pattern (docs/architecture.md): Release-0 baseline routes → `src/baseline/baseline_routes.js` (NOT `src/release0/` — that dir is the dormant activation boundary, enforced by `gate_activation_dormant.js`); lease lifecycle → `src/tenancy/lease_lifecycle_routes.js`; AI ingest pipeline + routes → `src/agent/document_ingest.js` + `document_ingest_routes.js`; space-position read → `src/tenancy/space_position_routes.js`; sms-proof → `src/comms/sms_proof_route.js`. Each mount sits at the exact line position its inline block occupied |
| `tests/` reorganized | 290 flat files moved by their existing naming conventions: `gates/` (14) · `proofs/` (68 `*.db.js` + 89 `*_proof.js`) · `unit/` (90 `*.test.js`) · `arcs/` (4) · `scenarios/` (25) · `e2e/`, `fixtures/`, `support/`, `_engine.js`, `_run_receipt.js`, `verify_source_governance.js` unchanged. Runner resolves bare names from `gates/` and slash entries from `tests/` root. CI and `verify_all.sh` needed no changes (they reference only `e2e/` + the runner) |

Rung reality check, stated honestly: the 12 e2e proofs exercise the server and a
slice of the moved routes end-to-end; the other moved routes are proven by the
inventory-identity argument plus the 38 gates, not by individual HTTP proofs.
`gate_property_creation_paths.js` caught a real extraction miss (the baseline
block's `propertyCreation` dependency) — the gate discipline is load-bearing.

**Docs-cleanup follow-on (2026-08-27, on top of the structure work):** 128
dated receipts/close-outs/candidates moved to `docs/archive/` via `git mv`;
13 living docs + all subdirectories stay at `docs/` root; `docs/README.md`
added as the index (living vs historical, with the search-first rule).
Every citation to archived files was rewritten to `docs/archive/…` — cross-repo
citations (`property-spine-app/docs/…`) were checked and left intact. Defect
#2 closed: `migrations/README.md` no longer instructs hand-run production
migrations. No doc content was rewritten or deleted; receipts are kept.

---

## SOURCE AUDIT + SIX FIXES — 2026-09-04 (every `src/` domain read adversarially, then the no-ruling fixes)

A review thread. **No migration, no schema change, no route path changed, no mount
order changed.** All 21 `src/` directories (~124k lines) plus `server.js` and the
shared core were read adversarially — six parallel reviewers, source only, nothing
executed against production.

**38 candidate defects. 19 personally re-verified** against the source and, where a
column was cited, against the migration that defines it. **The other 19 are
reviewer-reported at stated confidence and are deliberately NOT promoted into the
defect table below** — absence of a row here means unverified, not absent.

Six defect classes fixed. Every one was a single line or a wrapper, needed no
product ruling, and touched no schema:

| Fix | Rung earned | Evidence |
|---|---|---|
| `staffSessions` never imported after the 2026-08-27 split — `POST /properties`, `POST /ingest/:runId/promote`, `POST /ingest/:runId/approve` | `HTTP_PROVEN` for the refusal path (real router, real socket, **stub pool** → `LOCALLY_EXERCISED` by defect #19's own rule) | `/properties` returned `500 {"error":"staffSessions is not defined"}`; now `401 no_authenticated_actor`. Both ingest routes threw `ReferenceError` **outside** their try — an unhandled rejection that killed the process under Node 22. Falsified: reverting crashes the harness at `document_ingest_routes.js:319` |
| Both ingest session resolutions moved **inside** their try | same | Same statement, same defect class: a database call with no handler |
| `fileToText({filename:…})` where the parser reads `originalname` — Tax + Utility evidence upload | `LOCALLY_EXERCISED` | `document_ingest.js` dispatches on `file.originalname`, so the type branch never matched and the buffer fell through to `buf.toString("utf8")`. Exercised both ways on a real workbook: old shape returns raw ZIP bytes (`PK\x03\x04…`, 369× the noise), new shape returns `### SHEET:` text. `artifacts.store({filename:…})` beside it is a **different** function and correctly keeps its key. ⚠ **SEVERITY CORRECTED DOWN, 2026-09-04:** the first write-up implied every proposal was built from garbage. Measured, it is narrower — xlsx shared strings stay findable inside the ZIP, so `tax_document_read.propose()` returned the SAME correct fields from the byte dump as from parsed text at both 3 and 400 rows. The parser was genuinely bypassed and the fix is right; the visible consequence varies by format and was often nil for spreadsheets. **PDF SETTLED on the cleanup pass** with a real Chromium-printed bill: old shape → no readable text and an EMPTY proposal (`fields: {}`), new shape → `due_date` and `annual_liability` extracted. So: silently EMPTY for PDFs — how bills actually arrive — and coincidentally correct for spreadsheets |
| `human_approved_at` stamped `now()` on both ternary branches | source-level; **fix not exercised** | `leasing_interactions.js` — every outbound text recorded an approval instant with `human_approved_by_user_id` null, falsifying the drafted/approved split |
| Self-claim wrote an owner onto an already-complete obligation | **`HTTP_PROVEN`** — real `pg.Pool`, real router, real socket, schema built from the real migration chain (ceiling 187) | 5/5. Falsified: without the guard a complete obligation returns `200 "Claimed."` with `status:"complete"` and an `assigned_user_id`. `operator_obligations_security_proof.db.js` 21/21 still passes, so the happy path is intact |
| Two upload doors passed multer straight in (`snapshot_loader`, `leasing_intel`) — oversize threw past the handler | `LOCALLY_EXERCISED` | Now the 413 shape every sibling door returns. Proven with a 10-byte limit over real HTTP |

**Verification run:** all **38 source-governance gates exited 0** with these changes
applied (`tests/verify_source_governance.js`). `unit/conversation_intent_extraction.test.js`
needs `HEAD~1`, so it exits 3 on a shallow clone — identical on clean `HEAD`, and it
passes once the clone is unshallowed. `tests/proofs/forward_rent.db.js` stops at
`no property with enough inventory` (exit 2) **identically on clean `HEAD`** — a
seeding precondition, not a regression.

**RE-CHECK, 2026-09-04 (same day, second pass).** Every fix was re-driven, three
gaps in the first pass were closed, and one claim was corrected down:

- **`POST /properties` is now `HTTP_PROVEN` through the real door** — real `server.js`
  booted against this schema, real operator-key gate, real session: 401 without a
  session, `insufficient_platform_role` then `actor_has_no_organization` as authority
  is granted, and finally a **real property row created** (201). The route was totally
  dead before the fix.
- **The promote path is now `HTTP_PROVEN` at the line that matters.** The first pass
  only reached a 404 — which returns *before* `promoted_by` is used, so it never
  proved the moved `const` was in scope. Re-driven with a real `ingest_run` and an
  approved candidate: a unit is created and `ingest_candidates.promoted_by` equals the
  session user. Falsified: reverting crashes the process at `document_ingest_routes.js:319`.
- **The claim guard and the 413 were re-driven through the real server**, not a stub:
  409 with the operator receipt, 200 + `in_progress` for an open one, and a genuine
  25 MB upload returning `file_too_large`.
- **`human_approved_at` is confirmed against precedent, not just reasoning.**
  `agent.js:2219` carries the identical fix made 2026-07-25 with the ruling written
  out — *"An approval TIME with no approver is a claim that someone reviewed this."*
  Two writers, one already corrected, this one missed. Column is nullable (048), no
  constraint pairs it, and no reader in `src/` would break on null.
- **`forward_rent`**: truth-tabled — exactly one case changes, the vacuous `0/0`.
- Also checked and clean: no circular require from the restored import; the new
  refusal path releases its client via the existing `finally`.

**CLEANUP PASS, 2026-09-04 (third pass, same day).** Every defect the audit left
open was triaged three ways — fix now (doctrine already decides), fix with a ruling
this thread took and named, or record and leave — and the fixes were driven through
the REAL `server.js` against the migration-built schema:

```text
real-DB harness (real server, real gate, real sessions)   36 / 36  with the fixes
same harness on clean HEAD                                 9 / 36  (27 defects re-demonstrated)
no-DB harness (safety net, NODE_ENV, 410s, gates)         16 / 16  with the fixes
source-governance gates                                    38 / 38
work_order_resident_projection.db.js (was dead)             7 / 7
ask_spine_answer 55/55 · meeting_receipt_runtime 81/81 · obligations security 21/21
```

Rows 30–43 below say what moved and to which rung; rows 45–51 are what this pass
found. Two rulings were TAKEN rather than deferred, and are named so they can be
reversed: cross-organization invites refuse rather than adopt (#30); the four dead
or ungoverned legacy lease routes are contained with 410s (#51). One ruling was NOT
taken: no migration was written (#49). No browser rung, nothing deployed, nothing
observed in production. The `property-spine-app` repo is not in this checkout.

**FOURTH PASS, 2026-09-04 — "the rest" (same day).** Every item row #44 left as
*reviewer-reported, not verified* was opened and read before anything was touched.
Each was then fixed, or blocked on a ruling and said so. Nothing was fixed from a
reviewer's description alone. Evidence:

```text
second real-DB harness (real server.js, real sessions)   16 / 16  with the fixes
same harness on clean HEAD                               3 / 16  (13 defects re-demonstrated)
occupancy reconciliation proof, six surfaces             12 / 12  with the fixes
same proof on clean HEAD                                  8 / 12  (three surfaces count 3 of 4
                                                                   units occupied for ONE spanning
                                                                   lease; a commenced pending lease
                                                                   reads as open)
first real-DB harness · no-DB harness                    36 / 36 · 16 / 16  (unchanged)
source-governance gates                                  38 / 38  (parent exit 0)
availability_canonical_proof — revived, was unrunnable   55 passed / 2 failed, IDENTICAL on clean HEAD
```

Rows 52–58 below. Occupancy was done as a slice, not a patch: one predicate
(`spanningLeaseSql`) and one bucket decision (`rentRollBucketOf`) are now the
single upstream decision every surface reads (§7), and the proof reconciles the
Management header, the operator-home desk, the Board tenant line, Availability,
the leasing occupancy facts and the future rent roll against the canonical
positions. Eight fixes are source-level only and are marked NOT EXERCISED in #54 —
they are not claimed higher. No migration (#49), no browser rung, nothing deployed.

**FIFTH PASS, 2026-09-04 — "fix it if you are sure" (same day).** The owner asked
for the remaining issues fixed where I was certain. Certain meant: the doctrine
already decides it, or the evidence is executable. The owner rulings (#49, #56,
#57, #58, #14/#27, #48) were NOT taken. What moved:

```text
CI now runs the database proofs      tests/e2e/db_proofs.sh + tests/proofs/db_proofs.manifest
  run (fails the job)                56 proofs (two pass in manifest order only — said so in the manifest)
  backlog (reported, with a reason)  16 proofs — 9 need the private Skyline rent roll,
                                     7 fail identically on the commit BEFORE this thread
  gate                               gate_db_proof_manifest.js — every *.db.js classified
this thread's own evidence           three scratch harnesses committed as proofs (36 · 16 · 18)
                                     + one new proof exercising the eight #54 fixes (14)
proofs revived                       20 more files with paths broken by the 2026-08-27 reorg;
                                     one BROKEN REQUIRE IN SOURCE (scheduling_adapter_seam)
Ask Spine gate                       scans every src/ directory; 15 domains discovered, 7 newly
                                     declared pending (was 2 directories, 8 domains)
one reader for obligations           ask_spine_service ranks operator_obligations_service.list
/intake/twilio                       verifies X-Twilio-Signature, fail-closed, like its sibling
two dead proofs                      pinned to the commits they were written against
```

Rows 4, 5, 6, 10, 11, 17, 21 and 54 are updated in place; rows 59–63 are what
this pass found. Row 9 (roster scope) is deliberately NOT fixed: gating a team
route on a session is app-first (Open Ruling 2) and the same move broke the
live invite flow once; the app repo is not in this checkout. No migration, no
browser rung, nothing deployed; CI has not yet run this commit.

---

## ⛔ KNOWN LIVE DEFECTS

| # | Defect | Evidence |
|---|---|---|
| 63 | **Three second-harness assertions now DISCRIMINATE (T17, T25b, T27) — was #53's caveat.** T17 seeds a property at the once-hardcoded foreign id and asserts no `another_property` comparison row and no trace of its name; T25b asserts the released membership row's `id` survives re-adding (delete-then-insert also ends `current`); T27 inserts the billback decision FIRST in one transaction and drives the REAL `assignWork`, which must assign the repair and leave the billback unowned. 16/16 in `audit_fixes_real_server_2.db.js`. | `tests/proofs/audit_fixes_real_server_2.db.js` |
| 62 | **A proof of mine encoded the defect I had fixed — corrected.** `compliance_http.db.js` asserted the property UUID appears in the model prompt; §40.8 says the model is never handed a record id, and the composer had been changed to pass the NAME. The assertion now requires the name and the ABSENCE of the id. Pre-thread 64/64 → 63/64 on my change → 64/64. The `ask_spine_contract_proof` "GET only" assertion (6a) was stale before this thread (the door grew `POST /ask`) and is corrected in #5. | `tests/proofs/compliance_http.db.js` |
| 61 | **Twenty more proof files could not run since the 2026-08-27 reorg — REPAIRED — and ONE BROKEN REQUIRE IN SOURCE.** `require.resolve("../src/…")` from `tests/proofs/` (15 files), `_ops_scoped_schema.sql` read from `tests/proofs/` instead of `tests/` (3), `fixtures/compliance/…` one level short (2), a proof that spawned `tests/server.js`, a `receipt` never required, two harnesses seeding `staff_sessions` in the pre-070 shape or literal `work_order_ref`s in the sequence's path, and a harness inserting ledger row 181 into a schema already carrying it. **In source:** `src/shared/scheduling_adapter_seam.js` required `../leasing_scheduling`, which moved to `src/leasing/` — nothing in `server.js` loads that module, so nothing threw; a full scan of relative requires in `src/` + `server.js` now finds zero broken (a commented-out one in `unit_triage.js` aside). After repair: `asset_management_shell` 54/54, `debt_establishment_tool` 19/19, `equity_routes_http` 16/16, `philadelphia_tax_http` 106/106, `operations_reply_policy` 32/32, `technician_route_proof` 48/48, `compliance_persistence` 30/30, `insurance_truth` 52/52, `insurance_establishment` 141/141, `meeting_evidence_hardening` 48/48, `work_order_operator_seams` 42/42 — all in CI's `run` set. | `git show --stat` for this commit; `tests/proofs/db_proofs.manifest` |
| 60 | **A count about the proofs, with its scope.** On a FRESH database built from the chain, before this pass: 47 of 69 `.db.js` proofs passed, 10 refused for the private Skyline artifact, 12 failed. After this pass: 56 pass (the 47, plus 4 new, plus `compliance_http`, `insurance_establishment`, `insurance_truth`, `work_order_operator_seams` repaired, plus `forward_leasing_ledger` and `test_adapter_seam`, which pass only in manifest order because an earlier proof leaves the fixture each needs), 9 still need the artifact, 7 fail as #59. **A trap found on the way:** a proof that dies mid-run leaves its child `server.js` listening; the next run's `/health` poll then talks to a stale server on another database and every assertion lies. The two real-server proofs now refuse a port that already answers and kill their child on exit. Scope: `tests/proofs/*.db.js` only, run one after another in one database as CI will; `*_proof.js` files were not swept. | `tests/e2e/db_proofs.sh` run 2026-09-04 |
| 59 | **Seven database proofs fail on the commit BEFORE this thread — pre-existing, recorded in the manifest as `backlog` with what would promote each, NOT chased.** Run at `ed66d65` (the parent of the audit's first commit) with the same path repairs applied: `debt_routes_http` (W8: observed/projected `value_cents` differ from the pinned specimen), `governed_lease_terms` (2/24: `no_published_pricing_version` — its publication precondition no longer holds), `person_ingress_hostile` (H12, 2/34), `spine_lease_execution` (dies: the instrument snapshot carries no `monthly_rent`), `technician_lifecycle_proof` (8/62 around technician completion replies), `test_identity_bridge` (J2: the static gate misses a planted raw join — the GATE is what to fix), `test_scheduling_interactions` (5/9; calls `sendPropertySms`/`upsertProviderEvent` the module no longer exports), Each is a real defect or a stale harness; none was introduced here. (`test_adapter_seam`, first listed here, passes in manifest order and was promoted.) | `tests/proofs/db_proofs.manifest` backlog section; run 2026-09-04 in a `git worktree` at `ed66d65` |
| 58 | **Inbound SMS is acknowledged before it is durably recorded — RULING RECORDED, NOT CHANGED.** `tenant_link.js` answers the carrier, then writes; a write failure after the ack loses the message. The reviewer was right that this is a gap. The fix (durable inbound row first, ack second) changes delivery semantics on a live carrier path and belongs to the owner. What did change: the failure logs on the ops-line and lead paths no longer say the message was *preserved* when it was not, and they log the full inbound payload so a lost message can be replayed by hand. Source-level, NOT EXERCISED. | `src/comms/tenant_link.js` |
| 57 | **Plaid `/transactions/sync` ignores `modified` and `removed` — BLOCKED on migration numbering (#49).** Verified by reading: only `added` is consumed, so a transaction Plaid later amends or reverses stays in `bank_transactions` as first seen. Reconciling `modified`/`removed` needs the Plaid transaction id stored on the row; the table does not carry it, and this thread writes no migration. Recorded, untouched. | `src/money/plaid.js` sync handler |
| 56 | **Deal ownership was never recorded — PARTLY RESOLVED, ruling NOT taken.** `POST /deal-intakes` created a deal with `organization_id` null on operator-key authority, so nothing could later say whose deal it is. It now accepts an optional `organization_id`, validates it exists, and WARNS when a deal is created without one; it does not refuse, because requiring an organization on this door is the same ruling as #30's authority question and the app callers are unverified. `HTTP_PROVEN` (T25: deal created with an owner). Membership fixes are in #53. | `src/onboarding/deal_intake.js` |
| 55 | **Fourteen proof files could not run since the 2026-08-27 reorg — REPAIRED.** Each required `./fixtures/…` from `tests/proofs/` or `tests/scenarios/` after the fixtures moved one level up; every one died at `Cannot find module` before its first assertion. Now `../fixtures/…`. Revived `availability_canonical_proof.js` runs to the end: 55 passed, 2 failed (*contested is populated (0)*, *evidence_disagrees is populated (0)*) — **identical on clean HEAD with only the path repair**, so the two failures pre-date this thread's Availability change and are recorded, not chased. They join #17 and #46. | `tests/proofs/{availability_canonical_proof,debt_position_falsification.db,turnover_service_proof,slice9_*}.js`; `tests/scenarios/{cross_surface_invariants,slice9_cross_domain_matrix}.js` |
| 54 | **Eight source-level fixes — EXERCISED on the fifth pass (2026-09-04), 14/14 in `tests/proofs/audit_fixes_source_level.db.js`, in CI's `run` set.** Each block calls the shipped module's own entry point against the real schema and reads the database back: (a)–(b) and (d)–(h) `LOCALLY_EXERCISED` against real Postgres, (c) `HTTP_PROVEN` through the real router over a real socket. The pre-fix behaviour each assertion excludes is stated in its name. As first recorded: (a) `activation_service`: a second staged row for one natural key was `do nothing`-swallowed while the count still rose; it is now counted as `duplicate_position`, named in the receipt and returned as `duplicate_positions`. (b) `leasing_scheduling`: the fingerprint fallback matched ANY prior tour for the prospect, so a second booking was affirmed onto the first and its date never appeared; when both sides carry a `scheduled_start` they must agree. (c) `lease_packets`: a resident could complete a required field twice, overwriting `completed_at`, the value, the IP and a signature — second completion is 409, as company-sign already refused. (d) `application_lifecycle`: applicant-typed rent/deposit were stored with `term_source` null and presented as terms of no origin; they are now labelled `application_capture` (the schema's own word) — a LABEL, not completeness gating. (e) `pricing_lifecycle`: `lease_term_months || 12` published a 12-month price nobody proposed; a term with no length is refused `term_length_required`, per `effective_pricing.js`'s own rule. (f) `governed_charge_cutover`: the receipt recorded the current digest as `approved_terms_digest` when no approval digest was supplied; it now records what was approved (or null), what was published, and `approval_bound_to_terms`. (g) `communications_boundary`: a person matched on `primary_phone_e164` with `phone` null resolved and then every reply failed `no_recipient`; the reply uses the number that matched. (h) `meeting_receipt_workflow`: the recipient-scope 403 ran AFTER the canonical meeting and transcript version were committed, leaving durable rows behind a refusal; it runs first. | the eight files named |
| 53 | **Thirteen more defects RESOLVED through the real server — second harness, `HTTP_PROVEN`.** Re-demonstrated on clean HEAD (13/16) then green (16/16): legacy closeout `done:false` and `notify-status` on a COMPLETE work order reopened it → 409, status untouched; `/org/users` listed another organization's assignments for a shared user → scoped to this organization's properties; `/operator/build` answered anonymously → 401 without a staff session; `/auth/sms/start` on a SUPERSEDED invite sent a real code → 410; `/auth/sms/verify` for an inactive account was a raw 500 → 403 with its reason (`httpStatus` errors keep their status); a lead could be booked into ANOTHER property's slot → 409, slot still open; legacy `tours/today` guessed UTC → 409 `TZ_UNAVAILABLE` with no operating timezone, 200 once configured (same rule as the governed path); `paid_but_unmatched` double-counted applied cash — it is now applied-without-cash-proof and the unapplied remainder, no overlap; the Read AI webhook with no body was a 500 → a refusal; deal-intake membership: a released property could not be re-added (now reactivated), a property current on another deal was a raw 23505 → 409 in a sentence, and release keeps the row as history instead of deleting it; establishing the SAME insurance program twice created two program rows → 409, one row. **Three assertions did not discriminate on clean HEAD** and are held at `LOCALLY_EXERCISED`: the economics shadow no longer naming a hardcoded foreign property (T17), released-property reactivation (T25b, depends on T25), and the obligation pick preferring the repair over the billback when both share a `created_at` (T27). | scratch harness `cleanup_db2.js` (not committed — it is a driver, not a proof); the files in `git show --stat` for this commit |
| 52 | **RESOLVED 2026-09-04 — occupancy reconciled across six surfaces.** ~~Five surfaces counted every `lease_status='active'` row as an occupant, date-blind; Availability treated an opening claim as an evidence state of its own; the future rent roll read a commenced pending lease as open.~~ One SQL predicate, `spanningLeaseSql` in `position_classifier.js` (start on or before as-of, end null or on/after), is appended to every active-lease count in the Management surface, its read, the Board tenant line, the desks and the leasing occupancy facts; `property_surface`'s future lateral requires the pending lease to still be in force; Availability derives its state from `rentRollBucketOf`, the same bucket decision `dated_positions` makes; the future rent roll reads `activation_pending_lease_position` and calls it `contractually_locked` or `covered_unproven` by the lease's proof basis. `HTTP_PROVEN` through the real routers on the migration-built schema: `tests/proofs/occupancy_surfaces_reconcile.db.js` seeds one spanning, one ended, one dateless and one commenced-pending lease across four units and asserts every surface says ONE occupied. Falsified: on clean HEAD 4 of 12 go red (leasing facts, Management header and Board all say 3; unit 104 reads `open_or_uncovered`). The proof reads `HARNESS_DATABASE_URL` through the same-target guard, which `gate_harness_isolation` insisted on. | `src/tenancy/position_classifier.js`; `src/surfaces/{management,management_read,board,desks,property_surface,availability_read,future_rent_roll_facts}.js`; `src/leasing/leasing_occupancy_facts.js`; `tests/proofs/occupancy_surfaces_reconcile.db.js` |
| 51 | **Four legacy lease routes CONTAINED (410), 2026-09-04 — reversible, app callers unverified.** `POST /leases/:id/generate-schedule` wrote `label`, `due_on`, `is_move_in_gate`, `recurs` — columns migration 036 rebuilt `scheduled_charges` without — so it failed on every call since; `GET /leases/:id/schedule` ordered by the removed `due_on`; `POST /leases/:id/payments` filtered `status='scheduled'`, a word 036's vocabulary (`claimed | partially_paid | paid`) does not hold, and could only apply nothing; `PATCH /leases/:id/approval` set `lease_status='active'` on ANY lease with a body actor, outside activation — the class `POST /leases` was retired for. Each now warns and answers 410 with the governed path, in `POST /leases`'s exact shape. The app repo is not in this checkout, so callers are unproven — but a caller of a route that has thrown since 036 was already broken. Reversible by deleting four blocks. | `src/tenancy/lease_lifecycle_routes.js` |
| 50 | **A test ENCODED a defect — fixed with the code, 2026-09-04.** `meeting_receipt_runtime_v0.test.js` asserted "transcript-named owner may remain unresolved" with `owner_label = "Katie Leung"` against a transcript whose only line is *"Amory handled Saturday coverage."* — it asserted that an owner nobody said gets accepted. The fixture now names Amory for that case, and a new case proves the invented name is rejected (`extractor_owner_label_missing`). 81/81. The lesson is the repo's own: a green test is a claim about what it looked at. | `tests/unit/meeting_receipt_runtime_v0.test.js`; `src/meeting_evidence/meeting_receipt_extractor_runner.js` |
| 49 | **MIGRATION NUMBERING IS CONTENDED — a ruling is needed before ANY new migration.** `188_native_tour_scheduler.sql` + `189_unified_staff_onboarding.sql` sit on four unmerged branches, and a DIFFERENT `188_meeting_mixed_property_passage_scope.sql` on a fifth. The handoff already records one two-branches-one-number collision. This thread therefore wrote no migration; the `outcome_corrected` widening (#38) waits on it. Whoever merges first takes 188; the others renumber. | `git ls-tree` across `origin/*` for `migrations/18[89]_*` |
| 48 | **`POST /plaid/webhook` is unreachable by Plaid and DELIBERATELY left so.** `/plaid/` is not on the public allowlist; Plaid's POST gets 401 and `ITEM_LOGIN_REQUIRED` is never recorded. Opening it without verifying the `Plaid-Verification` JWT against Plaid's JWKs would make an unauthenticated write to `plaid_item` status; that verification is a feature, not a cleanup. The route's comment used to claim the opposite and now states this. | `src/money/plaid.js` webhook comment; `server.js` `PUBLIC_PREFIXES` |
| 47 | **Every `reminder_sent` tour event failed the status CHECK — fixed as a side effect of #38's projection change.** `recordTourEvent` wrote each event's name into `leasing_tours.status`; `reminder_sent` is not in the eight-word vocabulary, so the reminder write at `leasing_leads.js` (search `type: "reminder_sent"`) hit 23514 and rolled back. Status now moves only for status events; a reminder stamps `reminded_at` and leaves state alone. **Not exercised** — no reminder path was driven; the projection logic is proven through cancel (T5c) and the constraint refusal is proven through correct-outcome (T5d). | `src/leasing/leasing_leads.js` recordTourEvent |
| 46 | **Two proofs fail on CLEAN HEAD — pre-existing, data-dependent, recorded not chased.** `tests/proofs/authority_resolution_proof.js` (*"the refusal cites the demo_attempts evidence"*, *"an existing property_manager assignment is never silently overwritten"*, then a harness error on `swept_tables`) and `tests/proofs/identity_authority_proof.js` (*"a linked user resolves"* → null). Both fail identically with and without this thread's changes, on a migration-built database with no demo seed. They belong to the 94 proofs nothing runs (#17). | run 2026-09-04 with and without the cleanup stash |
| 45 | **REQUEST-PATH SAFETY NET installed — Class 1, 2026-09-04.** A rejected `async` handler is now an honest JSON 500 through Express's ordinary error path instead of an unhandled rejection that terminated the process (Node 22 default); a terminal handler answers in the receipt vocabulary and keeps the stack in the log; `pool.on('error')` stops an idle-client error crashing the process. No-DB proof: a handler that rejects after an `await` → 500 JSON, an error carrying `httpStatus` keeps it, an ordinary handler is untouched, no `unhandledRejection` fires. **It is a floor, not a fix**: the 190 `await pool.connect()` calls outside any try are unchanged; rejections outside the request path still crash loudly, deliberately. Removal condition: Express 5, which awaits handlers natively. | `src/shared/async_route_safety.js`; `server.js` (install at top, `pool.on('error')`, `terminalErrorHandler` last) |
| 44 | **The rest of the 2026-09-04 audit — SPLIT on the cleanup pass (same day).** VERIFIED AND FIXED, each through the real server against the migration-built schema unless noted: `commitment_ledger` now reads the EFFECTIVE published version (both queries carry the effective window; T7); a CONSUMED application link is checked before the lazy expire, so a public load after its date no longer rewrites it to `expired` (T9); the legacy `schedule-move-in` refuses a lease that is not on the unit — on clean HEAD the foreign lease then BLOCKED the right unit's move-in through the `unit_events (lease_id, space_id)` uniqueness, a 500 the guard now prevents (T8); `currentMonthWindow` refuses a bad `as_of` with `bad_as_of` instead of `RangeError` (no-DB proof); an UNRESOLVED named owner in a meeting receipt must be a label the transcript actually contains (`extractor_owner_label_missing`) — the runtime test had encoded the defect, see #50; the property UUID no longer reaches the Ask Spine model, its NAME does (55/55). STILL REVIEWER-REPORTED, NOT VERIFIED, deliberately untouched: Plaid `/transactions/sync` ignoring `modified`/`removed`; date-blind occupancy on five surfaces and `availability_read`'s evidence states (a reconciliation proof across surfaces is the cost, §33); `future_rent_roll_facts` counting pending leases as open; `activation_service` dropping duplicate natural keys; `deal_intake` membership on key-only authority; the `leasing_scheduling` fingerprint merge; `xlsx@^0.18.5` CVEs (a dependency-source decision). **Each of these was opened on the fourth pass — see #52–#58 for what was fixed, what was blocked, and at which rung.** | this file's audit sections; `docs/` |
| 43 | **RESOLVED 2026-09-04.** ~~`sms-number` ran `begin`/`commit` on the POOL.~~ One client, try/finally. `HTTP_PROVEN` through the real server: after the write `pg_stat_activity` shows zero `idle in transaction` connections, and replacing the line retires the old and activates the new in one transaction (T3, T3b, T3c). | `src/comms/tenant_link.js` sms-number route |
| 42 | **RESOLVED 2026-09-04.** ~~Phone-only invites 42P10.~~ The conflict target now names migration 035's partial expression index and repeats its predicate. `HTTP_PROVEN`: a phone-only invite of a new person returns 201, and re-inviting the same digits in a different format takes the update path to the SAME user (T1d, T1e). Applied to both admin surfaces. | `src/identity/org_admin.js`, `src/identity/super_admin.js` |
| 41 | **RESOLVED 2026-09-04.** ~~Any meeting-evidence user could re-activate a REVOKED Read AI connection.~~ The upsert is predicated on `connection_status <> 'revoked'` and refuses with 409 `read_ai_connection_revoked`; a re-authorization now records WHO did it. Real-DB service proof: revoked stays revoked, re-authorization by a second user is recorded as theirs (T10, T10b, T10c). | `src/meeting_evidence/meeting_evidence_service.js` |
| 40 | **RESOLVED for this one door, 2026-09-04 — the composition problem (§40.8) remains unsolved.** ~~Ask Spine gathered work orders with no module check.~~ The `work` gather now requires `maintenance`, level with `/operator/work-orders/status`; without it the fact reads `NOT_AUTHORIZED`. Also: `facts.property_id` was the one record id the model saw on every question — it is stripped from the prompt and the property's NAME is given instead (wording needs a name, never an id). `LOCALLY_EXERCISED`: `ask_spine_answer.test.js` 55/55 (G4 now asserts the name, G4b asserts no UUID), `contracted_service_ask_spine`, `tenancy_ask_spine` pass. | `src/agent/ask_spine_answer.js`; `tests/unit/ask_spine_answer.test.js` |
| 39 | **RESOLVED 2026-09-04.** ~~Cancel / no-show / reschedule rewrote a settled tour.~~ All three lock the row and refuse a terminal tour with 409 in one sentence (`settledTourRefusal`), pointing at `/correct-outcome`. `HTTP_PROVEN`: cancel and no-show on a completed tour → 409 with status still `completed`; cancelling a SCHEDULED tour still works — status `cancelled`, `cancelled_at` set, slot reopened (T5, T5b, T5c). | `src/leasing/leasing_leads.js` |
| 38 | **PARTLY RESOLVED 2026-09-04 — the rest is BLOCKED on migration numbering (#49).** Code side: `recordTourEvent` projects `status` only for the eight-word status vocabulary, so a correction (or a reminder, see #47) never rewrites the tour's state; and the route maps the CHECK refusal (23514) to an honest 409 `outcome_correction_not_enabled` instead of a raw 500 — `HTTP_PROVEN` (T5d). Schema side: `tour_events.event_type` still rejects `outcome_corrected`; widening it is a migration, and 188/189 are claimed on four unmerged branches. The route refuses cleanly until that lands. | `src/leasing/leasing_leads.js`; `migrations/039_tour_scheduling.sql:104` |
| 37 | **RESOLVED 2026-09-04.** ~~Notices written without `space_id`.~~ The resolver already settled the space (single-space, or the body's `space_id` verified against the unit; by-bed without one is refused 409 as before) — it is now written to the column. `HTTP_PROVEN`: `unit_events.space_id` equals the resolved space and the space reader's own predicate (`ue.space_id = s.id and event_type='notice_given' and status='scheduled'`) finds it (T4b, T4c). Rows written before this stay invisible; migration 081's backfill was one-time. | `src/tenancy/notice.js` |
| 36 | **RESOLVED 2026-09-04.** ~~`work_order_status_read` queried `persons.property_id` and `leases.unit_id`.~~ A person is on a property through a LEASE naming them there (the same read `placeOf` and the communications boundary use); the tenancy fallback reaches the unit through `spaces`. The proof that inserted into the same phantom columns is repaired to the real schema and passes **7/7 on the migration-built database** — it could never have run before. | `src/surfaces/work_order_status_read.js`; `tests/proofs/work_order_resident_projection.db.js` |
| 35 | **RESOLVED 2026-09-04.** ~~`/tenant/me` selected the dropped `work_orders.person_id`.~~ A resident's open work is what they REPORTED or what AFFECTS their home (098's two columns). `HTTP_PROVEN` through the real server with a real tenant session: 200, and both work orders listed (T2, T2b). | `src/comms/tenant_link.js` |
| 34 | **RESOLVED with the invariant only, 2026-09-04.** ~~One deposit could cash-prove unlimited payments.~~ Enforced: the deposit row is locked; a link attributes a positive amount ≤ its own payment (unqualified = the whole payment); and Σ attributed across every link on the deposit may not exceed the deposit — the rule migration 037's header already stated. `HTTP_PROVEN`: first $500 payment links to a $500 deposit, the second is refused with `remaining: 0`, a $300 attribution on a $200 payment is refused, exactly one link exists (T6–T6d). On clean HEAD the same sequence produced three links. Accounting semantics beyond the invariant (partial settlement narrative) are untouched and still yours to rule on. | `src/money/payments.js` |
| 33 | **RESOLVED in source, NOT EXERCISED, 2026-09-04.** ~~`publishVersion` closed the live sheet and then matched nothing.~~ The draft is now locked and verified FIRST — exists, on this property, still a draft, and the version `receipt.reviewed_version_id` reviewed — before the prior period is closed; the publish update carries the property predicate and its row count is checked. Not driven end-to-end: `previewPublication` needs a full proposal contract this thread did not build. Say it that way. | `src/money/pricing_lifecycle.js` |
| 32 | **RESOLVED 2026-09-04.** ~~Technician completion closed the billback decision.~~ The close is scoped: `type <> 'billback_decision'` and not any of `FOLLOW_UP_TYPES` (derived from the reasons map, so a new reason cannot be added without this writer learning it). Those stay open for their owner and close through `completeObligation`, which insists on the input. `LOCALLY_EXERCISED` on real rows: the exact predicate closes the repair obligation and leaves billback and a supply follow-up open (T12). `claimCompletion` itself was not driven end-to-end (needs a technician conversation). Behaviour change to know about: a completed work order can now show open follow-ups for other roles — that is the honest state. | `src/technician/lifecycle_service.js:258` |
| 31 | **RESOLVED 2026-09-04 — fail closed.** ~~Unset `NODE_ENV` opened two debug doors.~~ Both guards now treat anything but an explicit `development` or `test` as production; compose sets `NODE_ENV=development` and `.env.example` says unset means production. No-DB proof: with the variable deleted `/auth/sms/start` returns 503 with NO `dev_code`, and the timezone override is ignored; with `development` the override is honoured. Whether Render sets the variable is still a dashboard fact — it no longer matters. | `src/identity/team_access.js`, `src/shared/property_timezone.js`, `docker-compose.yml`, `.env.example` |
| 30 | **RESOLVED 2026-09-04.** ~~Cross-organization account takeover through the invite upsert.~~ Both admin invites look the account up by exact email or normalized phone BEFORE the upsert. Org admin: any existing account outside the caller's organization — another org's, or one with no org, which is where the platform admins live — is refused 409 `user_belongs_to_another_organization`, never adopted. Super admin: an account in a DIFFERENT organization is refused and pointed at `PATCH /admin/users/:id`, the deliberate move; an org-less account may be provisioned. A phone that already signs in a different account is 409, not 500. `HTTP_PROVEN` through the real server with a real org-admin session: invite by the victim's email → 409, by their phone → 409, and their organization and sign-in phone are untouched; on clean HEAD the same request returned 201 and moved them (T1a–T1c). The ruling still open: a person legitimately shared across organizations has no path but the explicit admin move. | `src/identity/org_admin.js`, `src/identity/super_admin.js` |
| 29 | **LOCAL DEV, 2026-08-28 — docker-compose path validated end to end, app repo included (was broken; see #22/#28 for the API-side blockers).** The compose stack is now `db` + `migrate` (one-shot local schema release: reads the local ledger, releases with that ceiling, applies canonical precondition fixtures on data-dependent stops, guarded to local-dev connection shapes) + `api` (`OPERATOR_APP_ORIGIN` overridden to the app's local origin — `/operator/*` CORS allows exactly that, proven by preflight) + `app` — the sibling `property-spine-app` checkout served on :8080 by `tools/dev_static_server.js`, which rewrites the app's hardcoded production API origin to `http://localhost:3000` so a local browser lands on local data; the app repo itself is untouched, and its `localStorage.ps_api_base` override still wins if previously set. Dockerfile installs from the lockfile (`npm ci --omit=dev`) instead of resolving at build time. All proven against a real fresh volume: ledger ceiling 187, `/health` ok, app served with origin rewritten (4 occurrences), traversal guarded 403, second `up` idempotent. **Class-2 scaffolding** — removal conditions stated in the two `tools/dev_*.js` files. **Recorded, not chased:** the api repo root carries a git-tracked 745KB `property-spine-app` HTML snapshot (stale since 2026-07-07, purpose unexplained — already an open question in `docs/archive/MAINTENANCE_UNIT_STATUS_SOURCE_COMPARISON.md`); compose deliberately uses the real sibling repo, never that file. | `docker-compose.yml`; `tools/dev_migration_release.js`; `tools/dev_static_server.js`; `docs/deployment.md` (Docker Compose section rewritten to match reality) |
| 28 | ~~`migrations/migrate.js` hardcodes SSL, so `--apply` cannot build a schema on a local non-SSL Postgres.~~ The runner now takes its answer from `databaseSsl()` (the exact fix this row prescribed), and `database_ssl.js` also honors an explicit `sslmode=disable` in the URL — the compose service name `db` is not a loopback host, so the URL itself declares no-SSL; pinned by a new case in `gate_ci_path_ssl.js`. Production (Neon, `sslmode=require`) unchanged. Adjacent same-class fix made and said so: `src/onboarding/import_rent_roll_truth.js` had the identical hardcoded object and sits in the local-dev blast radius (rent-roll import). | `migrations/migrate.js` (client uses `databaseSsl(url)`); `src/shared/database_ssl.js` (`sslmode=disable` case); `tests/gates/gate_ci_path_ssl.js` (new case); `src/onboarding/import_rent_roll_truth.js` |
| 1 | **DEPLOYED, 2026-08-20 — NOT YET `PRODUCTION_PROVEN`.** ~~The leasing agent quotes `units.market_rent` directly to prospects~~ — fixed (PR #128), and now live in production at commit `bcd3089` (main's head at deploy time), deployed manually from the Render dashboard, confirmed live by the owner directly. **Deploying is not proving** — nobody has yet asked the live agent a price question and observed a governed answer or an honest handoff. That single observation is what moves this row to `PRODUCTION_PROVEN`; until then it stays at the rung the e2e proof earned. | `git show origin/main:src/agent/agent.js`; deploy confirmed by owner |
| 2 | **RESOLVED, 2026-08-27 — docs-cleanup thread.** The named falsehood (*"Safe to run as many times as you want"*) had already been fixed by an earlier thread at `migrations/README.md:39-44`. The second half — the **"How to run a migration"** section still instructing hand-run production migrations (`node migrate.js` against production) with a false *"it undoes that migration and stops"* rollback claim — is now rewritten to the real ceremony: verify-only on boot, and the release-gated `--apply` act. The migration-001-era planning prose below it is marked as history and explicitly not to be followed. `docs/deployment.md` remains correct (fixed earlier). | `migrations/README.md` — "How migrations actually run" section now matches the release gate; historical sections labeled |
| 3 | **An operator screen calls routes that 404.** A whole activation flow written, never mounted. | `src/identity/activation.js`; `grep -c "identity/activation" server.js` = **0** |
| 4 | **RESOLVED — already, and the row was stale.** ~~A test defaults to hitting PRODUCTION.~~ `full_lifecycle_arc.js` refuses without an explicit `ARC_BASE` ("There is deliberately no default"); the row survived the fix. Closed on the fifth pass by reading the file, not by changing it. | `tests/arcs/full_lifecycle_arc.js` |
| 5 | **RESOLVED 2026-09-04.** ~~Ask Spine has two obligation readers (§7).~~ `ask_spine_service.attention` now calls `operator_obligations_service.list` (the read behind `GET /operator/obligations`) and only RANKS the result; it issues no obligations SQL of its own. The contract proof's "the SQL carries a LIMIT 5" became "the service issues no obligations SQL — it ranks the canonical read"; its "GET only" assertion was already stale (the door grew `POST /ask`) and now says what is true: no mutating verb, and the only POST is the question door. `ask_spine_contract_proof` 31/31 · `ask_spine_db_proof` 23/23 · `ask_spine_answer` 55/55. | `src/agent/ask_spine_service.js`; `tests/proofs/ask_spine_contract_proof.js` |
| 6 | **RESOLVED 2026-09-04.** ~~The §40.11 gate scans 2 of ~15 domain dirs.~~ `STANDING_READ_DIRS` is computed from disk — every `src/` directory minus the declared `NOT_DOMAINS` — so a new directory is in scope the day it appears. Widening discovered 15 domains (was 8); the seven new ones are declared `pending` with an owner and the condition that clears each: application_lifecycle, concessions, forward_leasing, leasing_standing (Leasing's own §40.6 projection, still not conversationally readable), opportunity_lifecycle, renewals, unit_move_in. Gate 121/121. Declaring is not wiring. | `tests/gates/gate_ask_spine_readers.js` |
| 7 | **RESOLVED, 2026-08-20 (PR #128).** ~~Production does not run `main`~~ — the branch production was deployed from (`30cb992`) is now confirmed an ancestor of `main`, and `main`'s migration files run through 187, matching what's reportedly released to production. `main` should now boot cleanly against the live database. **Not yet re-verified end to end after this merge** — the next real deploy is the actual test of this, not a git check. | `git merge-base --is-ancestor 30cb992 origin/main` → **YES** (was NO as of 2026-08-19/20 morning) |
| 8 | **A signed-in operator's Invite button silently fakes success.** The app only calls the real invite route `if(key())` — a hidden, `aria-hidden` field populated *only* from an internal-only key in `localStorage` that the real SMS sign-in flow never sets. Without it, the button pushes a fake row and shows: *"Demo invite pending locally. Add an operator key to create a live invite."* This is the exact mechanism behind "no staff member other than the account owner has ever completed a real invite," and it's a direct violation of CLAUDE.md's own non-negotiable — *"Never fixture-fallback... in a signed-in operator workflow."* | `main-app/index.html:12152-12178` (`inviteTeamMember`), `:5953` (`#opKey`), `:8024` (`key()`) |
| 9 | **The team roster read has no property-scope check — unlike every sibling route in the same file.** `GET /properties/:id/team` sits behind the shared `x-operator-key` gate (not public), but performs *no* staff-session resolution and *no* check that the key-holder has any relationship to the `:id` in the URL. Any operator-key holder can read any property's full roster — names, phones, emails — by changing the URL. | `src/identity/team_access.js` — roster handler, compare to `my-access`'s enforced *"BRICK ONE property wall"* two routes below it |
| 10 | **RESOLVED 2026-09-04 — `LOCALLY_EXERCISED`.** ~~Two inbound Twilio SMS webhooks, two different security postures.~~ `/intake/twilio` now takes the sibling's posture: `sms.validateWebhook(req)` (X-Twilio-Signature against `APP_BASE_URL`) before anything is read from the body; no transport, no token, no verified signature → 403 with empty TwiML. `server.js` passes the same `sms` instance the communications boundary uses. Proven over a real socket with a stub transport: unverified → 403, no transport → 403, verified → proceeds. **Operational precondition, same as the sibling:** production must set `TWILIO_AUTH_TOKEN` and an https `APP_BASE_URL`, and the intake number must belong to the same Twilio account — otherwise every intake text is now refused instead of accepted. Reversible by deleting one block. | `src/onboarding/intake.js`; `server.js`; `tests/proofs/audit_fixes_no_db_proof.js` |
| 11 | **RESOLVED — already, and the row was stale.** ~~CLAUDE.md says deploys happen on merge to main.~~ CLAUDE.md's Repo orientation has said "Deploys to Render are MANUAL — merging to `main` deploys nothing" for some time; the row outlived the fix. Closed by reading. | `CLAUDE.md` "Repo orientation" |
| 12 | **RULED 2026-08-20 — ACCEPTED AS INTENDED, WITH A REVISIT TRIGGER.** ~~A real hole in published-pricing immutability~~ — `delete from properties` cascades through the freeze that direct term deletion correctly refuses. Owner's ruling: **allow it for now.** Deleting a property should delete its pricing. **Revisit trigger, stated by the owner: "when we start dealing with more real properties."** Recorded rather than closed, because the day that trigger fires, this becomes a schema change nobody will remember was a deliberate choice. | `tests/e2e/agent_pricing_wall.e2e.js` teardown comments |
| 13 | **CLAIMED, NOT STARTED — open for either party.** Four falsification tests are pinned to a hardcoded demo UUID and nothing runs them. Verified red before AND after the pricing fix, identically, by stashing. `claude/property-spine-orientation-cso2ao` claimed this then spent the time on deploy support instead. Say who's taking it before starting, to avoid duplicate work. | `tests/` — unnamed in the report, flagged for follow-up rather than fixed |
| 14 | **RULED 2026-08-20 — READY TO BUILD, NOT YET BUILT.** Owner's ruling: **the base term is 12 months. Always start there.** So `quotablePricing()` must select the 12-month term when a prospect names none — not `terms[0]`, which sorts shortest-first and is therefore the *most expensive* on a sheet with short-term premium pricing (Skyline's fall ~5mo ≈ $900/bed vs. full-year 12mo = $750/bed). The chosen term is already disclosed downstream (`agent.js:515` states the month count with the rent), so quoting the 12-month rate and naming it is a complete answer. **Simpler than the options considered** — needs no "primary term" data-model change, since 12 months is a universal business rule the adapter can select directly. ⚠ **One sub-decision this ruling does not settle — see #27.** | `src/agent/pricing_adapter.js` ~line 101 |
| 14b | **A THIRD OPTION FOR #14, FOUND WHILE VERIFYING THE DEPLOY: the menu already exists.** `effective_pricing.js:399` — when no term is supplied it does not just refuse, it returns `published_terms`, the sorted list of every term actually on the sheet, specifically so a caller can present the choice instead of guessing. Its own comment: *"With no term supplied the answer is the published menu."* This means a third ruling option for #14 beyond "refuse" or "add a primary-term data field": **have the agent present the published menu and ask which term the prospect wants** — reusing data that already exists, no schema change. Still the owner's call, but the cheapest option to build. | `src/money/effective_pricing.js:399` |
| 27 | **⚠ OPEN SUB-DECISION from #14's ruling: what if a property publishes no 12-month term?** The ruling is "always start at 12 months," but nothing guarantees every published sheet contains one. The adapter needs a defined answer for that case. Two safe options: **fall back to presenting the published menu** (`effective_pricing.js:399` already returns it), or **refuse and hand off** (matching `effective_pricing.js`'s own `lease_term_not_selected` precedent). What it must NOT do is silently fall back to `terms[0]` — that reintroduces exactly the defect #14 exists to close. Cheap to decide, and whoever implements #14 will hit it immediately. | `src/money/effective_pricing.js:99,399` |
| 15 | **RESOLVED, 2026-08-20 — a real privilege-escalation path is now closed.** `orgchart.js` could previously create `owner`/`asset_manager` roles — pricing authority (see #14) among them — through a route gated only by the shared `x-operator-key`, with **no person-level check and no actor recorded**. Landed in the same deploy as defect #1's fix (45 commits, 9 runtime files, zero migrations). Measured on a disposable DB by the reporting thread; not yet independently re-verified against production by me. Kept as a record, not deleted, per this file's own rule. | `src/surfaces/orgchart.js`, `src/identity/authority_resolution.js` — `ASSIGNABLE_ROLES = new Set(["owner", "asset_manager"])` confirmed on `main` |
| 16 | **RESOLVED, 2026-08-20.** ~~A live production database credential was pasted into a chat session during this work~~ — rotated (Neon → Roles → `neondb_owner` → Reset) and `DATABASE_URL` updated in Render. Owner-confirmed directly; not independently verified — no thread working this file has Neon or Render dashboard access to check. If anything else in either repo still references the old credential (a cached env file, a CI secret, a local `.env`), it would now be stale rather than dangerous — worth a quick sweep if one hasn't happened, not urgent. | Reported and resolved directly by the owner, 2026-08-20 |
| 17 | **⚠ THE SINGLE MOST IMPORTANT ROW IN THIS FILE — what CI does and does not cover.** Stated in both directions, because two wave-3 agents contradicted each other and **both were partly right**. ✅ **A real CI pipeline exists and is genuinely strong**: `.github/workflows/verify.yml` runs on every push, provisions a real PostgreSQL 16 container, drops and rebuilds the database from the migration chain, boots the real `server.js`, installs real Chromium, and runs `tests/e2e/verify_all.sh` — 12 e2e proofs plus a browser rung plus 37 source-governance gates. It passed **17/17 on current `main`**. No survey wave before this one had recorded that it exists, which is its own finding. ❌ **But it covers a narrow slice**: it runs **48 of 313** test files. **All 68 `.db.js` real-Postgres proofs are never run** — they require `HARNESS_DATABASE_URL`, which `verify.yml` never sets, so they would refuse rather than run even if invoked. **All 94 `*_proof.js` files are never run.** Those two populations are the evidentiary basis for nearly every `HTTP_PROVEN` rung in this document. **255 of 292 top-level test files are invoked by nothing.** **RULED 2026-08-20: get them running automatically.** Owner's decision. **DONE FOR THE `.db.js` POPULATION, 2026-09-04 (fifth pass):** `tests/e2e/db_proofs.sh` runs from `verify.yml` after `verify_all.sh` (`if: !cancelled()`), builds its own database from the migration chain, unsets `DATABASE_URL`, and runs `tests/proofs/db_proofs.manifest` — 56 `run` proofs fail the job, 16 `backlog` proofs are reported with the condition that promotes each (9 need the private Skyline rent roll; 7 are #59). `gate_db_proof_manifest.js` refuses an unclassified `*.db.js`. Locally the runner passed end to end on a fresh chain-built database; **CI itself has not yet run this commit.** The 94 `*_proof.js` files are still unrun — they are the unguarded population `gate_harness_isolation` freezes, and running them needs the same-target guard first. Safe to do now precisely because #18 was ruled the other way — red informs, it cannot block. Expect a wave of failures on first run: some of these have never executed in CI, and two are already proven permanently dead (#21). That first red is the point — it is the backlog becoming visible. | `.github/workflows/verify.yml:108-109`; `tests/e2e/verify_all.sh:43-98`; `tests/verify_source_governance.js` GATES array (37 entries); `ls tests/*.db.js` = 68, zero referenced by any runner |
| 18 | **RULED 2026-08-20 — DELIBERATE, NOT AN OVERSIGHT.** `main` is not branch-protected, so a red CI does not block a merge. Owner's ruling: **not yet.** Recorded so nobody "fixes" it as a bug later without knowing it was a choice. ⚠ **This ruling makes #17 cheap and safe**: wiring the unrun tests into CI can only inform, never block a merge — so turning them on carries no delivery risk today. If branch protection is ever turned on, revisit #17's status first. | GitHub branches API — every branch sampled returns `"protected": false` |
| 19 | **The fake-pool population is 10 files, not 3.** Seven were previously unnamed. Definition: a real Express router on a real socket driven by real `fetch`, with a hand-built object passed as `pool` and no `require("pg")` in the file. All ten opened and confirmed individually. Includes `ask_spine_http_proof.js:61` (`const pool = { async query(...) }` mounted at `:99` against *"the REAL router"*). Any rung resting on one of these is `LOCALLY_EXERCISED`, not `HTTP_PROVEN`. | wave 3 census; `docs/current-state-build/06_WAVE3_RESULTS.md` |
| 20 | **47 test files are pinned to a hardcoded demo property UUID; 42 never create it, and no migration inserts it.** `a50fbdd0-3642-431e-b532-0dcd6ab8a4fe` ("Property Spine Demo Building"). The migration chain only references or `UPDATE`s it — never inserts. So 42 files must find a row that nothing in the repo guarantees exists. **This supersedes defect #13's "four dead tests"** — that was the visible tip; the real number is 47 pinned, 42 unguaranteed. | `src/surfaces/owner.js:171`; `src/leasing/demo_preflight.js:20`; migrations 073/087/123 reference-only |
| 21 | **RESOLVED 2026-09-04 — both pinned to the commits they were written against.** ~~Two test files can never pass again.~~ `pricing_guards_proof.js` read the pre-fix tree at `HEAD`; it now reads `8165874`, the parent of `562e9f6` where all three guards landed — 17/17 (its behavioural block still SKIPs without `DATABASE_URL`, and is pinned to the demo property, #20). `operator_language_proof.js`'s open-ended `git diff 62b25e8` is bounded at both ends (`62b25e8 e239ecb`, the closure slice's own commit). **Not re-proven green:** it then dies reading `/workspace/property-spine-app/unit-turn-page.js` — the app repo, absent from this checkout (#8/#23 class). | `tests/proofs/pricing_guards_proof.js`; `tests/proofs/operator_language_proof.js` |
| 22 | **RESOLVED, 2026-08-28 — docker-local-dev thread.** ~~The documented from-scratch schema build does not work.~~ Two distinct blockers, both now closed by execution: (1) the self-recording migrations 083/084 collided with the runner's own ledger insert — the runner now defers to a row the file itself recorded (`on conflict do nothing`), which also makes a fresh build's ledger shape identical to production's (normalizer accepts both spellings); (2) the data-dependent migrations 087/110 stop by design on an empty database — the canonical precondition fixtures in `tests/e2e/preconditions/` are now applied by the compose local-dev release too, not just CI's `apply_migrations.sh`. **Proven:** fresh `docker compose` volume built from empty through the governed runner — 175 migrations, ledger ceiling 187, API verified and booted against it. | `migrations/migrate.js` (ledger insert defers to self-record); `tools/dev_migration_release.js` (resume loop); migrate logs: "local schema release complete — the volume now matches this build" |
| 23 | **The app repository has no CI at all.** No `.github` directory, no workflow files. Its **23 browser proofs and 34 test harnesses run only when a human runs them** — including every browser proof backing a `BROWSER_VERIFIED` rung in this file. | `main-app/` — no `.github`; `ls *.browser.js` = 23 |
| 24 | **`property_controls` — a complete compliance/licensing schema built in migration 001 that the Compliance domain built again in migration 168 never mentions.** Zero references in `src/` or `server.js`. Three sibling tables from `001_baseline.sql` are also fully orphaned: `bids`, `documents`, `inventory`. **This is the exact "rebuilt what already existed" failure this whole document was created to stop — found in the schema, 167 migrations apart.** | `migrations/001_baseline.sql` vs `migrations/168_compliance_canonical_truth.sql` |
| 25 | **51 of the 65 environment variables the code actually reads are documented nowhere.** `.env.example` documents 15. Several already known to change real behavior (`EXECUTED_LEASE_INTAKE_ENABLED`, `COMMITMENT_LEDGER_MODE`, `DEMO_MODE`). Which properties have which capability enabled is knowable only by reading the live Render dashboard against seven separate source files. | `grep -o "process\.env\.[A-Z_]*"` across `src/`, `server.js`, `migrations/` = 65 distinct; `.env.example` = 15 |
| 26 | **`DEMO_MODE` boot hook writes durable rent-roll data while bypassing the synthetic-data perimeter its own sibling routes enforce.** In `src/shared/`, beside a fixture-injection door wired to a button in the signed-in operator UI. Directly contradicts the non-negotiable *"Demo data may exist. Demo paths may not."* | `src/shared/` — see `06_WAVE3_RESULTS.md`; `src/shared/synthetic_data_perimeter.js` |

**Correction, not a new defect — the exclusion wall is better than earlier feared, for one route.** `tests/proofs/phase_zero_property_boundary.db.js` genuinely proves, with real Postgres and real HTTP, that a second real user without a property assignment is refused by the property-switcher (`GET/POST /operator/properties[/select]`). The earlier "only tested from inside" concern was wrong for *that* route — but confirmed true, and worse than described, for the roster route above (defect #9): not "only tested from inside," not tested at all, and structurally missing the check its own sibling routes have.

---

## PRODUCTION-PROVEN — the whole list

| Capability | Evidence |
|---|---|
| **Work-order completion guard** | `activation_id d93b08dd-c682-46d2-acf9-78ab6b960827` · `2026-08-12T01:49:57.866Z` · 16/16 on live instance `kbtb6` · irreversible |
| **Migration release gate** | Runs on every boot via `prestart`; deployed sha enforces `EXPECTED_SHA` and refuses on mismatch |
| **Meeting Evidence webhook ingress** (narrow) | Real delivery `c5cb8d0d-…` authenticated + retained byte-for-byte for a real provider meeting. Proves ingestion, not the pipeline downstream of it |
| **Meeting Evidence binding + finality + rejection lineage** (narrow) | A real meeting bound to a real property, qualified final; three model rejections durably retained with no receipt |
| **Meeting Receipt extraction advancement** (narrow, ×2) | Two real specimen runs each cleared one more validation gate post-deploy — proves the gate moved, not that a receipt was produced |

**Five rows above say "narrow" on purpose.** Each is a real, specific, falsifiable
production observation — not a green test suite. None of them means "the feature
works end to end." The Meeting Receipt pipeline specifically has **zero accepted
extractions and zero receipts produced**, despite three of its five entries here
touching production. Say precisely what was observed; do not round up.

Everything else in this document is **at best deployed, not observed.**

---

# THE INDEX

Grouped by where the code lives — a fact, not a taxonomy. Taxonomy is deliberately
unsettled; do not invent one while adding rows.

## Asset Management — `src/asset/`

**PR-level detail below courtesy of a direct review by the engineer who worked these
PRs (Codex), 2026-08-20 — spot-checked by me: schema tables, gate scan dirs, `debt`
registry state and the migration-181 header all confirmed exactly against the
deployed commit `30cb992`. One quoted phrase (*"does not send email"*) did not
resolve against any file I could reach — likely a runtime log or PR description
outside this tree, not treated as confirmed.**

| Capability | Rung | Ask Spine | Files / note |
|---|---|---|---|
| Compliance | `HTTP_PROVEN` + `BROWSER_VERIFIED` | registered | `compliance_*.js`. **The model to copy** — real request + real DB + real browser. Unchanged by recent AM PRs |
| Utilities | `LOCALLY_EXERCISED` ⚠ | registered | `utility_*.js`. Registered but **never proven end-to-end** — HTTP test uses a fake pool; DB test skips the router. Unchanged by recent AM PRs |
| Contracted Services — canonical domain | `LOCALLY_EXERCISED` ⚠ | registered | PRs #104/#105/#107. `contracted_service_http.test.js` uses `pool = { async connect() { return client; } }` — real Express, **fake pool**. Migrations 171/172 released, present in `30cb992`. Docs: *"evidence-backed population rehearsal, not a production canonical write"* |
| Contracted Services — overview integration | `LOCALLY_EXERCISED` | registered | PR #113. `asset_management.js` now consumes the standing projection; **PR supplied no real HTTP/DB proof for the integration itself**. Underlying end-to-end gap unchanged |
| Insurance | `HTTP_PROVEN` + `BROWSER_VERIFIED` | **none** (`pending`) | `insurance_*.js`. *"NEVER seen on a production page by an entitled account"* |
| Tax (Philadelphia) | `HTTP_PROVEN` + `BROWSER_VERIFIED` | **none** (`pending`) | `tax_*.js`, `philadelphia_tax_rules.js`. Clocks only, never amounts |
| Debt — canonical truth | `HTTP_PROVEN` | registered (PR #113) | PR #108. `debt_routes_http.db.js`: real `pg.Pool`, mounts the real AM surface, real `listen()`. Migration 173 released; production establishment recorded **21 source-backed rows**. No authenticated production-route receipt observed. *"THERE ARE NO WRITE ROUTES, AND THAT IS DELIBERATE."* Comparison/causal explanation unclaimed |
| Debt — Ask Spine reader | `LOCALLY_EXERCISED` | registered | PR #113. `debt_ask_spine.test.js` uses hand-built fake services/reader + fake model — **no real DB or HTTP route in this test**, despite the domain being registered |
| Equity — canonical domain | `HTTP_PROVEN` | registered | PR #114. `equity_routes_http.db.js`: real `pg.Pool`, real router, real socket, canonical writers, serialized reads. Migration 174 released; **zero production rows, correctly** |
| Equity — Ask Spine reader | `LOCALLY_EXERCISED` | registered | PR #114. Test *"FAKES THE SAME TWO FUNCTIONS THE CAPITAL STACK UI CALLS"* — no real Ask Spine HTTP/DB proof |
| Equity — ownership reconciliation | `LOCALLY_EXERCISED`/`HTTP_PROVEN` split | registered | PR #114. Real Postgres proves a 77.57% schedule stays `INCOMPLETE` (`equity_position_falsification.db.js`); the real-HTTP test only proves the `NOT_ESTABLISHED` case, not populated reconciliation. *"`accrued_preferred_return` is always `NOT_ESTABLISHED` for every preferred position, unconditionally, for Build 1."* Governing source clause pending |
| Funding boundary wall | enforced | — | `tests/gates/gate_funding_boundary.js` — tax/insurance funding cannot cross into economics |

## Leasing lifecycle — `src/{leasing,applications,tenancy,onboarding}/`

**None of this is registered with Ask Spine** — the gate cannot see these directories.

| Capability | Rung | Files / note |
|---|---|---|
| **Deal Setup / Opening Tenancy** | `HTTP_PROVEN` + `BROWSER_VERIFIED` | `deal_setup_http.db.js` **spawns real `server.js`**, real socket, restart persistence. **Best-proven capability in the repo** |
| Lead intake | `LOCALLY_EXERCISED` | `leasing_leads.js` |
| Tours / appointment attribution | `LOCALLY_EXERCISED` | `appointment_attribution.js`, `appointment_journey.js`, `tour_outcome.js` |
| `tour_chips` · `capture_chase` · `capture_receipt` | `BUILT_BUT_DORMANT` | **no caller in `src/` or `server.js`** |
| Post-tour conversion rail | `LOCALLY_EXERCISED`; one seam `HTTP_PROVEN` | `leasing_conversion.js`. **BLOCKING ruling open** on `conversation_owner_user_id` |
| AI Leasing Strategy | `LOCALLY_EXERCISED` | ⚠ docs say *dormant*; code is wired into the live first-response path (`leasing_leads.js:614`). **Unresolved** |
| Leasing Desk | `LOCALLY_EXERCISED` | `leasing_desk.js`, `leasing_desk_loader.js`. Handoff claims HTTP proof; file inspection contradicts it |
| Application submission / lifecycle | `LOCALLY_EXERCISED` | `application_lifecycle.js`. **Migration 125 does not exist** (124→126) |
| Application target authority (unit/bed) | `LOCALLY_EXERCISED` | `application_target_authority.js`. Unit with >1 space → 409 refusal |
| Proposed terms | `LOCALLY_EXERCISED` | `proposed_terms_service.js` |
| **Lease packet / e-sign** | `LOCALLY_EXERCISED` | **NO E-SIGNATURE EXISTS.** *"does NOT capture a legally-binding signature"* |
| **Executed lease intake** | `LOCALLY_EXERCISED` | **SWITCHED OFF** — 503 unless `EXECUTED_LEASE_INTAKE_ENABLED=true` **and** property allowlisted |
| Tenancy anchor (countersign / confirm-term) | `LOCALLY_EXERCISED` | Fails closed 409 `executed_lease_required` |
| **Pending tenancy creation** | **DOES NOT EXIST** | Confirm hard-codes `lease_status='active'` (`activation_service.js:696`). The phrase appears nowhere in either repo |
| **Active tenancy activation** | `DEPLOYED` | `POST /operator/leasing/leases/:leaseId/activate-tenancy`. Real, works, byte-identical at deployed sha |
| Move-in gates / economic tenancy | `LOCALLY_EXERCISED` | `movein.js`, `economic_tenancy_service.js` |
| Lease void | `LOCALLY_EXERCISED` | **No HTTP route** — ops tool only. Six stuck leases once needed raw SQL |
| Notice to vacate | `REPORTED` | *"built and never used… Live count across the whole database: 0"* |
| Dated / space position | `LOCALLY_EXERCISED` | `dated_positions.js` — *one service, four interpretations*. Most depended-on primitive |
| Renewals | `LOCALLY_EXERCISED` | `renewals_read.js`, `renewal_lifecycle.js`. **No renewal writer.** No browser proof exists |
| `followup_ladder` / `followup_runner` | `BUILT_BUT_DORMANT` | *"DORMANT. Nothing calls this yet. It decides; it cannot send."* |

## Operations — `src/{maintenance,technician,comms,obligations}/`

⚠ The obligation **engine** is `src/shared/obligation_engine.js`, **not** `src/obligations/`
(which is only the authenticated HTTP door).

| Capability | Rung | Files / note |
|---|---|---|
| **Release 0 completion guard** | **`PRODUCTION_PROVEN`** | `proof_evaluation_service.js` + migration 137/140 |
| Work order creation / lifecycle | `HTTP_PROVEN` | `work_order_service.js`. *"the REAL server.js over real HTTP"* |
| Technician SMS operations loop | `HTTP_PROVEN` + `BROWSER_VERIFIED` | `technician/conversation.js`, `lifecycle_service.js` + screenshots |
| Operator work-order actions | `HTTP_PROVEN` | `operator_actions.js` — 4 canonical writes; "Review" deliberately excluded |
| **Obligations queue + self-claim** | `HTTP_PROVEN` + `BROWSER_VERIFIED` | `GET /operator/obligations`, `POST .../claim`. **Exists — do not rebuild** |
| **Turnovers / move-out** | `HTTP_PROVEN` | `turnover_service.js`, `operator_turnover.js`. **Exists — do not rebuild** |
| Unit triage · turn scope · work acceptance · readiness | real-DB service layer, **no HTTP harness** | `unit_triage_service.js`, `unit_turn_scope_service.js`, `work_acceptance_service.js`, `readiness_service.js` |
| Communications boundary | `HTTP_PROVEN` (line layer) | **SMS RAIL FROZEN** — *"no `operations` line row at all"* |
| Tenant link (resident SMS) | `HTTP_PROVEN` | `tenant_link.js` |
| Move-in delivery correlation | `LOCALLY_EXERCISED` | `delivery.js` — test uses a **hand-mocked** `client.query` |
| Prospect fact capture | `LOCALLY_EXERCISED` | `prospect_capture.js` |

**OPEN:** *"a canonical completion through `claimCompletion`, with real proof, end to
end — needs a real technician SMS completion."* The guard is proven; the writer
producing a valid completion through it is not.

## Platform / core — `src/{identity,entity,money,evidence,agent,release0,surfaces}/`

| Capability | Rung | Files / note |
|---|---|---|
| Staff session / server-derived authority | `HTTP_PROVEN` | `staff_session_service.js`. *"The caller never supplies role, modules, TTL, or entitlement"* |
| Property creation | `HTTP_PROVEN` + `BROWSER_VERIFIED` | Single-path enforced by `gate_property_creation_paths.js` |
| Legal entity primitive | `HTTP_PROVEN` + `BROWSER_VERIFIED` | `legal_entity_service.js` |
| Ask Spine (slices 1–2) | `HTTP_PROVEN` | Gathers: `attention, work_orders, compliance, utility, contracted_service, equity, tenancy, debt`. ⚠ *"`references[]` IS NOT IN PRODUCTION"* |
| Asset Management shell | `HTTP_PROVEN` + `BROWSER_VERIFIED` | `asset_management.js` 260/260. Property Expenses **capped** — can never read `established` |
| Money events / accounting | `HTTP_PROVEN` | `money.js`, `bank_bridge.js`, `plaid.js` — lifecycle-arc harnesses only |
| Governed pricing & charges (~26 files) | mixed | *"Everything else economic is **unpublished**."* `$99` admin fee **BLOCKED on one ruling** |
| `concession_schedule_compiler` | `BUILT_BUT_DORMANT` | *"ACTIVATES NOTHING"*; `free_rent_period` *"SPECIFIED BUT NOT IMPLEMENTED"* |
| `economic_adapter` · `pricing_adapter` | `BUILT_BUT_DORMANT` | *"DARK BY CONSTRUCTION."* **See defect #1** |
| `src/identity/activation.js` | **DEAD** | Never mounted; app screen 404s. **See defect #3** |
| Slice 9 market evidence | `HTTP_PROVEN` + `BROWSER_VERIFIED` | `evidence_projection.js`. Rent Survey / Listings permanently `not_connected` |
| Conversational seams (5 pure files) | `LOCALLY_EXERCISED` | `intent.js`, `clarification.js`, `receipt.js`, `technician_intent.js`, `work_reference.js` |
| A2P legal pages | `HTTP_PROVEN` | Header records a real incident: *"BOTH campaign-required URLs returned 404 in production"* |
| Board / desks / management / portfolio reads | `HTTP_PROVEN` (mounted) | `desks.js`: *"NEVER a fake number"* |

## Recently landed — `src/{meeting_evidence,tenancy}/`, migrations 175–181

| Capability | Rung | Note |
|---|---|---|
| Meeting Evidence (Read AI webhook ingress) | **`PRODUCTION_PROVEN`** ↑ | Wave 1 found `BUILT_BUT_DORMANT`, waiting on a signing key. **Superseded** — per Codex PR #115 direct review, spot-checked against schema at `30cb992`: a real webhook delivery (`c5cb8d0d-c5ab-401b-9d38-67a75787b28c`) was authenticated and retained byte-for-byte for provider meeting `be96f9ac-5996-4271-84a2-7098801d4fc4`. Initially unbound, zero downstream writes — narrow proof, not "the feature works end to end." Migration header: *"It does NOT wire transcripts into Ask Spine."* Not registered |
| Meeting Evidence — binding, finality, rejection lineage | **`PRODUCTION_PROVEN`** (narrow) | PR #118, migration 181. The authentic meeting above was manually bound to a real property, qualified final, and three rejected model attempts were durably retained with no receipts/writes. Gate still does not scan `src/meeting_evidence/` — absent from Ask Spine by design, and the gate cannot detect that absence |
| Meeting Receipt v0 pipeline — successful generation | `DEPLOYED`, **not observed** | PR #115, migration 176. Code live in `30cb992`; three real extraction attempts entered the workflow, **all three rejected**. Extraction runs: 0 accepted. Receipts: 0. Local HTTP tests use a fake workflow/pool; DB proofs bypass HTTP entirely |
| Meeting Receipt — unresolved named owner handling | `PRODUCTION_PROVEN` (narrow) | PR #120. Post-deploy, `extractor_unresolved_label_forbidden` stopped blocking the real specimen; next attempt advanced to evidence-role validation. Does not raise the pipeline's overall rung — no person ID attaches without an exact property-person match |
| Meeting Receipt — prompt evidence invariants | `PRODUCTION_PROVEN` (narrow) | PR #122. Real prompt revision v1 advanced past prior temporal/claim-basis failures, stopped at `extractor_quote_speaker_mismatch`. Still zero accepted extractions, receipts, emails, Ask Spine access, or canonical writes |
| Meeting Receipt — server-owned evidence addressing | `LOCALLY_EXERCISED` | Active, **unmerged** branch. Runtime 80/80, extractor 69/69 per Codex — **not independently re-run by me**. Could not verify against real Postgres today (Docker unavailable to that reviewer). *"Invalid output is rejected by the server, not repaired."* Real Receipt 001 remains the missing proof |
| Person ingress boundary | `LOCALLY_EXERCISED` | Migration 177 **unreleased** |
| Person correction (anti-merge supersession) | `BUILT_BUT_DORMANT` | Retire + point, move nothing |
| External resident identity / crosswalk | `REPORTED` | **Blocks establishing opening truth** |
| **Forward Leasing ledger** | `BROWSER_VERIFIED` | **4 browser proofs survived adversarial review untouched.** Most rigorously proven area |
| Interval tenancy read · leasing cycles · Forward Rent | `BROWSER_VERIFIED` | Migration 178 unreleased |
| Current Rent Roll (operator unit-first) | `HTTP_PROVEN` | Claimed browser-verified; downgraded on review |
| Current Rent Roll (four-bucket classification) | `LOCALLY_EXERCISED` | ⚠ Claimed `PRODUCTION_PROVEN`; **refuted** — single-source, and the API's own banner contradicts the numbers |
| Inventory retirement · grain materialization · bed-grain activation | `BUILT_BUT_DORMANT` | Migrations 179/180 unreleased. *"391 positions against 160 real beds"* |
| Tenancy standing projection | `HTTP_PROVEN` | Registered with Ask Spine |

---

## Teams / Access / Roles — `src/identity/`

**The highest-value gap in the original survey, now covered.** 148 capabilities
surveyed across this and six other areas (wave 2, 2026-08-20) — full detail in
`docs/current-state-build/05_WAVE2_RESULTS.md`. Rows below are the ones that
change what you should believe about the system; everything else is in that file.

| Capability | Rung | Note |
|---|---|---|
| Staff invite creation — `POST /properties/:id/team-invites` | `LOCALLY_EXERCISED` | Double-gated (session + shared key). Correctly derives the granting actor server-side, refuses a client-supplied one (PR #38 rule). **See defect #8** — the app's own button mostly doesn't call this |
| **Team invite UI silently fakes success** | **REPORTED (dead-in-practice)** | **Defect #8.** The real reason invites don't work in practice |
| OTP send — `POST /auth/sms/start` | `LOCALLY_EXERCISED` | One route, two branches (invite-accept / re-login). Honest 503 if SMS transport doesn't confirm send — tested only against a fake pool |
| OTP verify → session mint — `POST /auth/sms/verify` | `REPORTED` | **Zero test files reference this route at all** — not even the fake-pool pattern. The actual moment a session is minted has no automated evidence |
| Team roster read — `GET /properties/:id/team` | `REPORTED` | **Defect #9** — no property-scope check |
| Current-access read — `GET /properties/:id/my-access` | `BUILT_BUT_DORMANT` | Fully implemented, has the property wall its sibling routes lack, **the app never calls it** |
| Assignment edit — `PATCH /property-team-assignments/:id` | `BUILT_BUT_DORMANT` | Implemented, correctly gated, **orphaned — app never calls it** |
| Staff session mint/resolve/revoke | `HTTP_PROVEN` | *"Class 1 permanent product primitive."* The actually solid part of this whole area |
| Property switcher — `GET/POST /operator/properties[/select]` | `HTTP_PROVEN` | **Genuinely proven**, real Postgres + real HTTP, a real second user without access is refused. See the correction above defects #9-10 |
| Super-admin surface — `super_admin.js` (`/admin/*`) | `REPORTED` | Extensively used by the app; **zero automated test evidence at any rung** |
| Org-scoped admin surface — `org_admin.js` (`/org/*`) | `BUILT_BUT_DORMANT` | Fully parallel to super-admin, **entirely unreachable from the app** — nothing calls it |
| Module vocabulary mismatch — `'capital'` vs `'asset_management'` | `REPORTED` | Different grant paths use different names for what's supposed to be the same module; one silently strips the other |
| Demo session bootstrap — `POST /demo/operator-session` | `HTTP_PROVEN` | Correctly fail-closed (403/503 without config). Site map's *"RETIRE-ON-ACTIVATION"* framing **not found anywhere in source** — no such trigger exists, map was wrong on this specific point |
| Team/assignment schema (4 tables) | `DEPLOYED` | `property_team_assignments` is the one authority row; a partial unique index was added defensively in migration 070 after a live-duplicate risk |

## Newly discovered — on nobody's map until this pass

Found by the completeness critics, not by searching for something already
suspected. Full detail in `05_WAVE2_RESULTS.md`.

| What | Note |
|---|---|
| **The Decision Rail** — `src/leasing/decisions.js` | A whole governed money-decision domain (migration 059, its own obligation routing, its own approval-cap authority) sitting in `src/leasing/` where nobody would look for it under "money" |
| **AI leasing operating rules** — `ai_leasing_operating_rules` table (migration 121) | Writes governance rules that constrain **live prospect-facing AI output**, real HTTP routes, actively read on every AI-generated lease response — zero prior visibility |
| **`source_artifacts`** — migration 153 | Cross-cutting primitive, heavily used across Utilities/Compliance/Debt/Equity/onboarding, real and tested — *"exists in the database and in nobody's map"* until now |
| **Outlook/Acuity Microsoft Graph sync** | A complete external integration (OAuth, migration, seven env vars) exists in source — **but its mount file is literally named `outlookAcuityMount.example.js`**, never required by `server.js`. Built, not live |
| **Seven independent property-scoped feature flags** | Each gates a different live capability by property-UUID allowlist. Nothing in either repo enumerates the current set — only readable by checking Render directly alongside seven separate source files |
| **`TWILIO_FROM_NUMBER`** | Documented in `docs/deployment.md` as a settable env var. **Does nothing in code** — *"a mention is not a guard,"* exactly the trap this repo's own doctrine warns about |
| **10 consecutive missing migration numbers** — 141 through 149 | Between `140_post_activation_completion_guard.sql` and `150_canonical_property_creation.sql`. Not previously documented anywhere |
| **No scheduler/cron infrastructure exists in either repo** | Several capabilities (`followup_runner.js` among them) are structurally built to need a periodic trigger. None exists — confirmed absence, not oversight |

---

## NOT YET SURVEYED — do not read absence as absence

Wave 2 (2026-08-20) closed every area listed here as of the prior version of
this file. What's left is depth, not breadth:

| Area | Status |
|---|---|
| Money / pricing (42 capabilities found) | Surveyed at headline grain; full 42-row detail in `05_WAVE2_RESULTS.md`, not yet promoted into this file's index |
| `server.js` inline routes (25 found, 23 flagged) | Confirmed CLAUDE.md's own warning — a `src/`-only search would have missed a legacy Persons CRUD, a "contained not deleted" bare lease writer, and an inline AI rent-roll pipeline. Full detail in `05_WAVE2_RESULTS.md` |
| `tools/` (16 found) | Which have been actually *run* vs. written — detail in `05_WAVE2_RESULTS.md` |
| App repo doors (25 found) | Detail in `05_WAVE2_RESULTS.md` |
| Onboarding/rent-roll intake (12 found) | Detail in `05_WAVE2_RESULTS.md` |
| Management door (11 found) | Detail in `05_WAVE2_RESULTS.md` |

Re-runnable research: `docs/current-state-build/wave1_new_domains.js`,
`docs/current-state-build/wave2_coverage_gaps.js`. Full wave 2 output:
`docs/current-state-build/05_WAVE2_RESULTS.md`.

---

## ⛔ CLOSING A THREAD — DO THIS BEFORE YOU STOP

**This file goes stale the moment a thread ships something and does not say so.**
`docs/CODEBASE_STATE.md` (5 Aug) proved it — stamped one commit, silently wrong
two weeks later. The only thing preventing a repeat is the step below.

Run this before ending any thread that touched `src/`, `migrations/` or `server.js`:

```text
1. WHAT CHANGED?      git diff --stat origin/main...HEAD -- src/ migrations/ server.js
2. FOR EACH ONE:      does a row exist here?
                        yes → update its rung, files and note
                        no  → add a row, at the grain the evidence supports
3. RUNG CHECK:        did the proof rung actually MOVE? Opening a test is the only
                      way to know. A rung is never upgraded because the code looks
                      finished — only because the next rung was OBSERVED.
4. DEFECTS:           did you fix one of the KNOWN LIVE DEFECTS? Remove it.
                      Did you find a new one? Add it.
5. SNAPSHOT:          update STATE SNAPSHOT if you verified against a newer SHA.
                      Leave it alone if you did not — a false stamp is worse
                      than an old one.
6. NOTHING CHANGED?   Say so in the commit. That is a valid outcome.
```

**Paste this at the end of a thread to run the ritual:**

```
Close out this thread: update docs/CURRENT_STATE.md for anything we built,
connected, proved or disproved. Open the tests before changing any proof rung.
If nothing changed, say so rather than editing.
```

**The rule that keeps this honest:** a thread updates rows for what it *did*.
It does not re-survey the whole repo, and it does not upgrade a row it did not
personally verify.

---

## HOW TO ADD A ROW

1. **Open the test.** Do not trust the filename.
2. **Pick the rung the evidence supports**, never the one you hoped for.
3. **Cite a file path**, and a verbatim quote for any blocker.
4. **Update the snapshot** if you verified against a newer SHA.
5. `NOT_FOUND` beats a plausible guess, always.

**No row is upgraded because someone believes the product works that way.
It is upgraded only when the next proof rung has been observed.**

---

*Supporting detail — full capability tables, per-claim adversarial verification
reasoning, and the re-runnable research scripts — is in `docs/current-state-build/`.*
