# Property Spine — Release Rehearsal Report

Date: 2026-09-14
RT: `<scratchpad>/release-rehearsal-20260914`
Full log: `$RT/run.log`

## PHASE 0 — local prerequisites — PASS

- `pg_lsclusters`: `16 main 5432 online postgres ...` — Postgres up.
- `sudo -u postgres psql -c "alter role postgres password 'spineproof'"` → `ALTER ROLE`, exit 0.
- `psql "<db-url>" -Atc "select 1"` → `1`, exit 0.
- `ls $FIXTURE_TREE/migrations/*.sql | wc -l` → `183`. Last two files: `193_application_offer_lineage.sql`, `194_required_work_target.sql`.
- `git -C $RELEASE_TREE status --porcelain --untracked-files=no` → empty, exit 0.
- `git -C $RELEASE_TREE rev-parse HEAD` → `<hash>` (matches pin).

## PHASE A — build the exact-194 fixture — PASS

- `node $S/run1/own.js $RT/ownership_194.json` → `owned: <proof-db>`, exit 0.
- A.2: `E2E_DISPOSABLE_POSTGRES=1 E2E_PROOF_MANIFEST=... ./tests/e2e/apply_migrations.sh` (env vars unset first) → exit 0. Log tail: `ledger ceiling: 194`.
- Verify: `select count(*), max(version::int) from schema_migrations` → **`182|194`** (expected).
- A.3: NONCE = `cb1d7ee4aee4f17dd6f093f9ea66597d`. No other sessions on the fixture db.
  `create database <proof-db> template <proof-db>` → `CREATE DATABASE`.
  `drop table if exists proof_run_identity` in the clone → `DROP TABLE`.
  Verify on clone → **`182|194`** (expected).

Databases at end of Phase A: `<proof-db>` (fixture), `<proof-db>` (32-hex clone).

## PHASE B — registered recovery matrix at release pin — **FAIL**

Command:
```
cd $RELEASE_TREE && env -u DATABASE_URL -u NODE_OPTIONS \
  HARNESS_DATABASE_URL="postgresql://postgres:<pw>@127.0.0.1:5432/spine_proof_$NONCE" \
  HARNESS_NONCE=$NONCE node tests/proofs/migration_194_198_release_recovery.db.js
```
Exit code: **1**

Output (full, 18 lines):
```
COMBINED MIGRATION 194-198 RELEASE/RECOVERY — owned <proof-db>

  ok    input fixture is exact 194
  ok    input carries the old source-claim index and no 195-197 objects
  ok    canonical child connection mechanism installs a positive statement_timeout
AssertionError [ERR_ASSERTION]: 195_two_step_leasing_authored_offer_basis.sql actual held lock fails the canonical migration: exit=1

COMBINED MIGRATION 194-198 PREDEPLOY REFUSED: migrations/195_two_step_leasing_authored_offer_basis.sql differs from the reviewed source.
expected <hash>
actual   <hash>
```

No literal "FAIL" string appears; the failure is the `AssertionError` and the `PREDEPLOY REFUSED` block above. Only 3 of the expected 52 assertions ran (`ok` x3) before the hash-mismatch assertion aborted the run — **the recovery matrix did not complete**.

Post-run db listing (`select datname from pg_database where datname like 'spine_proof%'`):
```
spine_proofs
<proof-db>
<proof-db>
```
Matches expectation exactly — the fixture, the 32-hex source clone, and `spine_proofs` — no extras, nothing dropped that wasn't ours.

**Root cause observed:** `migrations/195_two_step_leasing_authored_offer_basis.sql` in `$RELEASE_TREE` (pinned at `<hash>`) does not hash to the value the recovery/predeploy tooling has recorded as "reviewed source." This is a content mismatch between the pinned migration file and what the release tooling expects, not an environment or harness problem.

## PHASE C — human command sequence on a fresh clone

- C.1: Created `spine_proof_c_cb1d7ee4aee4f17dd6f093f9ea66597d` as `template <proof-db>`, dropped `proof_run_identity` in it. Both succeeded (exit 0).
- C.2 — **PASS (refusal as expected)**:
  ```
  cd $RELEASE_TREE && env -u MIGRATION_RELEASE DATABASE_URL="$URL_C" node migrations/migrate.js
  ```
  Exit code: **1**. Output:
  ```
    Connected to the database.  (verify-only)
    ✗ REFUSING TO START — the schema does not match this code.
      4 migration(s) in this build are NOT applied to the target database:
        · 195_two_step_leasing_authored_offer_basis.sql
        · 196_source_home_identity_review.sql
        · 197_inventory_correction_hardening.sql
        · 198_proposed_source_claim_identity.sql
      Ledger ceiling is 194. This code expects those migrations to exist.
      ...
    Nothing was applied.
  ```
  Names 195–198 exactly as expected.

- C.3 — **FAIL** (same defect as Phase B):
  ```
  cd $RELEASE_TREE && env -u MIGRATION_RELEASE -u NODE_OPTIONS DATABASE_URL="$URL_C" \
    EXPECTED_SHA=<hash> node tools/release/migration_194_198_predeploy.js --apply
  ```
  Exit code: **1**. Full output:
  ```
  COMBINED MIGRATION 194-198 PREDEPLOY REFUSED: migrations/195_two_step_leasing_authored_offer_basis.sql differs from the reviewed source.
  expected <hash>
  actual   <hash>
  ```
  Expected "PREDEPLOY: exact 194 accepted..." / "RELEASE VERIFIED: 186 ledger rows, ceiling 198" did **not** appear. The release was refused; nothing was applied.

- **C.4 and C.5 SKIPPED.** Per the task's hard rule ("if a step fails, stop that phase, capture the exact output... do not improvise fixes"), C.4 (idempotent verify-only after a release) and C.5 (boot API on the "upgraded" database) both presuppose a release that C.3 shows never happened. Running them against an unreleased, still-194 database would not exercise what those steps are meant to prove, so they were not attempted.

## C.6 old build against 198 (added mid-task, run after C.5/before cleanup)

Per a mid-task instruction, `spine_proof_c_$NONCE` (dropped in an earlier interim cleanup) was recreated from the fixture and the C.3 predeploy wrapper was re-applied to it before running C.6. The re-applied wrapper **refused again with the identical hash mismatch**:

```
COMBINED MIGRATION 194-198 PREDEPLOY REFUSED: migrations/195_two_step_leasing_authored_offer_basis.sql differs from the reviewed source.
expected <hash>
actual   <hash>
```
Exit code: 1. The clone was confirmed still at `182|194` (never upgraded) before proceeding.

Because the schema was never actually upgraded to 198, the two C.6 checks ran against a still-at-194 database rather than the "upgraded clone" the instruction assumed. Both are reported honestly as observed, not as hypothesized:

**Old-build prestart verifier**, run from `$S/api-d15c968` against `$URL_C`:
```
cd $S/api-d15c968 && env -u MIGRATION_RELEASE -u NODE_OPTIONS DATABASE_URL="$URL_C" node migrations/migrate.js
```
Exit code: **0** (not the expected non-zero). Output:
```
  Connected to the database.  (verify-only)
  ✓ SCHEMA VERIFIED — 182 migrations, all applied. Ledger ceiling 194.
    (verify-only; applying requires an explicit release)
    (both directions checked: every file is in the ledger, and every
     ledger version has its file)
```
It did **not** name 195–198 as "in the ledger but not in this build," because they were never added to the ledger — the release never applied. This is a direct, expected consequence of the Phase C.3/B failure, not a new/different defect.

**Old build server booted directly** (prestart bypassed), from `$S/api-d15c968`:
```
env -u NODE_OPTIONS DATABASE_URL="$URL_C" PORT=3198 OPERATOR_KEY=rehearsal node server.js
```
It started immediately and `/health` responded on the first poll (~1s):
```
{"ok":true,"db_time":"2026-09-14T01:14:51.040Z","build":{"build_identified":false,"commit_short":null,"resolved_from":"unidentified","started_at":"2026-09-14T01:14:42.599Z"}}
```
The old server serves `/health` fine here — but again, this is the old build talking to a schema that is still exactly its own (194), not the 198 schema the check was designed to probe, because the release never landed. Server was killed (`kill -TERM`) and confirmed gone; port 3198 confirmed free afterward. `spine_proof_c_$NONCE` was dropped again as final cleanup for this addendum.

**Bottom line on C.6:** the specific scenario it was designed to catch (old code running unprotected against a newer 195–198 schema) could not be exercised in this rehearsal, because Phase C's release step never got past the migration-195 hash-mismatch refusal. Re-running C.6 meaningfully requires first resolving that hash discrepancy so the release can actually apply.

## PHASE D — reconciliation proof against the upgraded database — **SKIPPED (blocked by Phase C failure)**

Phase D is explicitly scoped against "the UPGRADED database" produced by Phase C.3. Since C.3 was refused and no upgrade to 198 occurred, there is no upgraded database to run D.1–D.4 against. Attempting D against the still-at-194 `URL_C` would not be a rehearsal of the documented release path and was not attempted, per the instruction to stop the affected phase rather than improvise a variant.

## PHASE E — cleanup — PASS

- `pgrep -af server.js`: only the rehearsal's own bash wrapper process lines matched (containing the literal string "server.js" inside the echoed script text) — no actual `node server.js` process was ever started, since Phase C.5/Phase D (the only steps that would start one) were skipped.
- Ports 3111 and 3199: confirmed free (`ss -ltnp` — no listeners).
- Dropped `spine_proof_c_cb1d7ee4aee4f17dd6f093f9ea66597d` (the Phase C clone; not needed further). Exit 0.
- No D.2 boundary-shaped clone was ever created (Phase D skipped), so nothing to drop there.
- No recovery-proof leftover clones existed beyond the 3 confirmed in Phase B's post-run listing.
- Kept (per instructions, "for one more day"): `<proof-db>` (exact-194 fixture) and `<proof-db>` (its 32-hex source clone).

Final `spine_proof%` database listing:
```
<proof-db>
<proof-db>
spine_proofs
```
`spine_proofs` was never touched (not created by this task, not dropped).

## Databases created and their disposition

| Database | Created in | Disposition |
|---|---|---|
| `<proof-db>` | A.1 (own.js) | Kept (exact-194 fixture, per instructions) |
| `<proof-db>` | A.3 (template clone) | Kept (32-hex source clone, per instructions) |
| `spine_proof_c_cb1d7ee4aee4f17dd6f093f9ea66597d` | C.1 (fresh human-sequence clone) | Dropped in E.1, recreated for the added C.6 step, dropped again afterward |

## Deviations from expectation

1. **Phase B did not reach 52 assertions.** It aborted after 3 `ok` lines on a hash-mismatch `AssertionError` for migration 195. Expected a full pass/fail summary across 52 assertions; got an early abort instead.
2. **Phase C.3 did not produce "PREDEPLOY: exact 194 accepted..." / "RELEASE VERIFIED: 186 ledger rows, ceiling 198."** It was refused outright with the same 195-hash-mismatch reason as Phase B.
3. **Phases C.4, C.5, and all of D were not run**, as they depend on a successful release that did not occur in this rehearsal.
4. **C.6 (added mid-task)** could not exercise its intended scenario (old code vs. a newer 195–198 schema) because the schema was never upgraded; the old-build verifier passed clean (exit 0, not the expected refusal) and the old server served `/health` normally — both because the database was still exactly at 194, not because anything about the mismatch protection failed.
5. Root defect (same in B and C.3): the release tree's `migrations/195_two_step_leasing_authored_offer_basis.sql` (at pinned SHA `<hash>`) hashes to `<hash>`, but the release/recovery tooling expects `<hash>`. This is a content discrepancy in the pinned migration file relative to what the predeploy/recovery tooling was built against — worth investigating before this pin is used for an actual release. No product code, migration, or tooling was modified to work around it, per the task's hard rules.
