# Property Spine — Release Rehearsal, Run 2 (corrected pin)

Date: 2026-09-14
RT: `<scratchpad>/release-rehearsal-20260914`
RELEASE_TREE: `$S/api-release-fix` @ `<hash>` (PIN)
FIXTURE_TREE: `$S/api-d15c968` (old production build)

This is a re-run of the rehearsal in `REHEARSAL_REPORT.md` (run 1), which stopped
in Phase B because the pinned `tools/release/migration_194_198_predeploy.js`
`REVIEWED_HASHES` for `195_two_step_leasing_authored_offer_basis.sql` did not
match the file's actual sha256 on the pinned tree. On this corrected tree the
`REVIEWED_HASHES["195_two_step_leasing_authored_offer_basis.sql"]` constant
reads `<hash>`, which
now equals the file's on-disk sha256 — confirmed by direct `sha256sum` before
starting. All `run2_*`-prefixed outputs below; run 1's files were left intact.

## Preflight

- `pg_lsclusters`: `16 main 5432 online postgres` — up, no start needed.
- `git -C $RELEASE_TREE status --porcelain --untracked-files=no` → empty.
- `git -C $RELEASE_TREE rev-parse HEAD` → `<hash>` (matches PIN).
- `sha256sum $RELEASE_TREE/migrations/195_two_step_leasing_authored_offer_basis.sql` →
  `<hash>` — matches
  `REVIEWED_HASHES` in `tools/release/migration_194_198_predeploy.js`. Fix confirmed
  before running anything.
- Retained fixtures verified: `<proof-db>` → `182|194`
  (marker `proof_run_identity` present); `<proof-db>`
  → `182|194` (marker table absent, as expected for the stripped clone).
- `spine_proof%` databases at start: `spine_proofs`, `<proof-db>`,
  `<proof-db>` — nothing extra.

## PHASE B — recovery matrix at the corrected pin — **PASS**

Command:
```
cd $RELEASE_TREE && env -u DATABASE_URL -u NODE_OPTIONS \
  HARNESS_DATABASE_URL="postgresql://postgres:<pw>@127.0.0.1:5432/<proof-db>" \
  HARNESS_NONCE=cb1d7ee4aee4f17dd6f093f9ea66597d \
  node tests/proofs/migration_194_198_release_recovery.db.js > $RT/run2_recovery.log 2>&1
```
Exit code: **0**

Final summary line:
```
  52 passed, 0 failed
```
No FAIL lines anywhere in the log (verified — every line is `ok` or a `NOTE`).

Post-run `spine_proof%` listing:
```
spine_proofs
<proof-db>
<proof-db>
```
No database beyond the two retained fixtures and `spine_proofs` — the proof cleaned
up its own clones.

## PHASE C — the exact human command sequence on a fresh clone

- **C.1** — `create database spine_proof_c2_4c93285d template <proof-db>`
  (after `pg_terminate_backend` on the template's other sessions — none found blocking)
  → `CREATE DATABASE`. `drop table if exists proof_run_identity` in the clone →
  `DROP TABLE`. `URL_C = postgresql://postgres:<pw>@127.0.0.1:5432/spine_proof_c2_4c93285d`.

- **C.2 — PASS (refusal as expected).**
  ```
  cd $RELEASE_TREE && env -u MIGRATION_RELEASE DATABASE_URL="$URL_C" node migrations/migrate.js
  ```
  Exit code: **1**. Key lines:
  ```
    ✗ REFUSING TO START — the schema does not match this code.
      4 migration(s) in this build are NOT applied to the target database:
        · 195_two_step_leasing_authored_offer_basis.sql
        · 196_source_home_identity_review.sql
        · 197_inventory_correction_hardening.sql
        · 198_proposed_source_claim_identity.sql
      Ledger ceiling is 194. This code expects those migrations to exist.
    Nothing was applied.
  ```

- **C.3 — PASS.**
  ```
  cd $RELEASE_TREE && env -u MIGRATION_RELEASE -u NODE_OPTIONS DATABASE_URL="$URL_C" \
    EXPECTED_SHA=<hash> \
    node tools/release/migration_194_198_predeploy.js --apply
  ```
  Exit code: **0**. Key lines:
  ```
  COMBINED MIGRATION 194-198 PREDEPLOY: exact 194 accepted (182 ledger rows); full pin, reviewed hashes, and physical fingerprint verified.
  ...
  → 195_two_step_leasing_authored_offer_basis.sql  — applying...
    ✓ applied and recorded.
  → 196_source_home_identity_review.sql  — applying...
    ✓ applied and recorded.
  → 197_inventory_correction_hardening.sql  — applying...
    ✓ applied and recorded.
  → 198_proposed_source_claim_identity.sql  — applying...
    ✓ applied and recorded.

  Done.

  COMBINED MIGRATION 194-198 RELEASE VERIFIED: 186 ledger rows, ceiling 198, all reviewed physical contracts present.
  ```
  Verify: `psql "$URL_C" -Atc "select count(*), max(version::int) from schema_migrations"` →
  **`186|198`** (expected).

- **C.4 — PASS (both checks).**
  Wrapper, no argument:
  ```
  COMBINED MIGRATION 194-198 PREDEPLOY: exact 198 accepted (186 ledger rows); full pin, reviewed hashes, and physical fingerprint verified.
  VERIFY-ONLY: exact 198 verified; no migration was applied.
  ```
  exit 0. `node migrations/migrate.js` verify:
  ```
    ✓ SCHEMA VERIFIED — 186 migrations, all applied. Ledger ceiling 198.
  ```
  exit 0, clean.

- **C.5 — PASS.**
  ```
  cd $RELEASE_TREE && env -u NODE_OPTIONS DATABASE_URL="$URL_C" PORT=3199 OPERATOR_KEY=rehearsal \
    RENDER_GIT_COMMIT=<hash> npm start
  ```
  `/health` responded on the first poll (~1s):
  ```
  {"ok":true,"db_time":"2026-09-14T01:21:27.151Z","build":{"build_identified":true,"commit_short":"03550a8","resolved_from":"render_env","started_at":"2026-09-14T01:21:22.866Z"}}
  ```
  `prestart` output in the log showed `✓ SCHEMA VERIFIED — 186 migrations ... Ledger ceiling 198` before `npm start` proceeded. Process group killed (`kill -TERM` on the group), port 3199 confirmed free afterward.

- **C.6 — PASS (as designed: old build refused, but its bare `server.js` boots anyway).**
  Old-build prestart verifier against the now-198 clone:
  ```
  cd $FIXTURE_TREE && env -u MIGRATION_RELEASE -u NODE_OPTIONS DATABASE_URL="$URL_C" node migrations/migrate.js
  ```
  Exit code: **1**. Key lines:
  ```
    ✗ LEDGER VERSION MISSING FROM THIS REPOSITORY — refusing to start.
      4 migration(s) are recorded as applied to this database, but this build carries no file for them:
      195  the ledger says: two_step_leasing_authored_offer_basis -> migrations/195_*.sql does not exist in this build.
      196  the ledger says: source_home_identity_review -> migrations/196_*.sql does not exist in this build.
      197  the ledger says: inventory_correction_hardening -> migrations/197_*.sql does not exist in this build.
      198  the ledger says: proposed_source_claim_identity -> migrations/198_*.sql does not exist in this build.
    Nothing was applied.
  ```
  Exactly the expected refusal, naming 195–198 as present in the ledger but absent from the old build.

  Old server booted directly (`node server.js`, prestart bypassed), PORT 3198: it
  started and served `/health` on the first poll:
  ```
  {"ok":true,"db_time":"2026-09-14T01:21:58.890Z","build":{"build_identified":false,"commit_short":null,"resolved_from":"unidentified","started_at":"2026-09-14T01:21:55.138Z"}}
  ```
  This confirms the safety net lives in `migrations/migrate.js`'s prestart check, not
  at server runtime — an old `server.js` invoked directly (skipping `npm start`'s
  `prestart`) will serve traffic against a schema it cannot fully describe. Server
  killed; port 3198 confirmed free.

## PHASE D — behaviour on the upgraded clone

- **D.1 — PASS.** Seed via `property_fixture.sql` → `fixtures.sql` → `instrument_fixture.js`,
  all exit 0. Key lines:
  ```
  fixture | properties | opening_positions | spaces
  property fixture |          1 |                 1 |      2
  published version | ... | terms 1
  fixture: retained governing instrument ... - sha256 <hash>
  ```

- **D.2** — Boundary-shaped clone `<proof-db>` created
  `template spine_proof_c2_4c93285d` (template sessions terminated first, none
  blocking), then `proof_run_identity` created with nonce
  `a157408cb55f86d6105850229f289d3f`. `run2_ownership_c.json` and
  `run2_env_c.sh` written as specified (port 3111). Skyline E2E property id read:
  `<id-2>`. `run2_boot_env_c.json` built from
  `$S/run32/boot_env.json` replacing only the repeated uuid
  (`<id-3>`, which appeared 5 times including inside
  the `LEASING_INTAKE_PROPERTY_IDS` list) with the fresh id; the other uuid in
  that same list (`<id-4>`) was left untouched
  (verified by grep count before/after).

- **D.3 — PASS.**
  `node $S/run1/drive.js tests/proofs/current_rent_roll_reconciliation.db.js ...`
  Exit code: **0**. Final summary line:
  ```
  current rent-roll reconciliation: 63 passed, 0 failed
  ```
  No FAIL lines in the log.

- **D.4 — PASS (all three).**
  ```
  node tests/unit/migration_194_198_predeploy_contract.test.js  → 23 passed, 0 failed (exit 0)
  node tests/unit/migration_194_198_reviewed_hashes.test.js     → migration 194-198 reviewed hashes: 4 files match their git blobs and on-disk bytes (exit 0)
  node tests/verify_source_governance.js                        → ✓ PASS — all 56 source-governance gates exited 0 / PARENT EXIT  0
  ```

## PHASE E — cleanup — PASS

- Dropped `spine_proof_c2_4c93285d` (C.1 clone) and `<proof-db>`
  (D.2 boundary-shaped clone), terminating other sessions on each first.
- Final `spine_proof%` listing:
  ```
  spine_proofs
  <proof-db>
  <proof-db>
  ```
  Retained fixtures re-verified at `182|194` after cleanup — unchanged.
- Process cleanup: the C.5 server (group-killed) and C.6 server needed a second,
  explicit kill — `setsid node server.js` forked into a **new session** whose
  actual `node server.js` process (pid 5426) was not in the group I first
  signalled (the `setsid` wrapper pid exits immediately when the caller is
  already a process-group leader, orphaning the real process into its own
  session). Caught this by re-checking `pgrep -af server.js` during Phase E
  cleanup rather than trusting the earlier "port free" checks alone, and
  killed pid 5426 directly (`SIGTERM`, confirmed gone). Final state: `pgrep -af
  server.js` shows nothing; ports 3111, 3198, 3199 all free.

## Databases created and their disposition (this run)

| Database | Created in | Disposition |
|---|---|---|
| `spine_proof_c2_4c93285d` | C.1 | Dropped in Phase E |
| `<proof-db>` | D.2 | Dropped in Phase E |

Retained fixtures `<proof-db>` and
`<proof-db>` untouched (used as templates only).
`spine_proofs` never touched.

## Summary — pass/fail by phase

| Phase | Result |
|---|---|
| Preflight | PASS |
| B (recovery matrix) | **PASS** — 52 passed, 0 failed |
| C.1–C.6 (human release sequence) | **PASS** — refusal→release→re-verify→boot→old-build-refusal all matched expectation |
| D.1–D.4 (behaviour + governance) | **PASS** — 63/0 reconciliation, 23/0 + hash test + 56/0 governance gates |
| E (cleanup) | **PASS** — only the two retained fixtures remain; no stray processes; all three ports free |

**Root cause from Run 1 is confirmed fixed:** the `REVIEWED_HASHES` entry for
migration 195 in `tools/release/migration_194_198_predeploy.js` at pin
`<hash>` now matches the file's actual sha256
(`cbdf311ea966...`), so the predeploy/recovery tooling no longer refuses at that
step. Every phase of the rehearsal that was blocked in run 1 completed cleanly
in run 2 with no deviations from expected output, aside from a self-caught
process-cleanup gap (documented above) that was corrected before finishing.
