# Release runbook — API `03550a8` (corrected pin over `e808199`) + app `1a5f257`, migrations 195–198 (2026-09-14)

**Status: prepared, not executed. The API pin is NOT `e808199` as reviewed: `e808199` cannot be released on a Linux host (see "Blocker found in rehearsal"). The corrected candidate is `03550a8f1cf0ca674839ff51e959c8fbf015730a` on `claude/release-hash-pin-20260914`, one commit over `e808199` that changes only the wrapper's pinned hashes and adds a CI test. Kameron or QB decides whether that commit becomes the pin or Terra re-pins on the codex lane.** Production remains API
`d15c96816570704228a0a604a7d1673216e61b4a` / app
`336c82f4b9ccb000a2cec4b4d886bf9ad3df03` at 182 ledger rows, ceiling 194.
This runbook is Claude's reconstruction for Kameron while the QB workstation
handoff (`COMBINED_194_198_RELEASE_OPERATION_20260913.md`, not in the repo) is
unavailable. It changes nothing on its own. Every step below that touches
Render, Neon or a customer is a human act at the console; Claude holds no
credentials for any of them.

## What is being released

| piece | commit | evidence |
|---|---|---|
| API | `03550a8f1cf0ca674839ff51e959c8fbf015730a` (`claude/release-hash-pin-20260914`, product identical to `e808199` except `tools/release/migration_194_198_predeploy.js` pins and one new unit test) | `e808199`: full CI run 522 green; reconciliation proof 63/0; governance 56/0; release contract 23/0. `03550a8`: full CI run 525 green with the new hash-pin step executed (`── migration 194-198 reviewed hashes are the git blobs PASS`), release contract PASS, reconciliation 63/0 — https://github.com/kzitelli-art/property-spine-api/actions/runs/34795509220; PG16 rehearsal below |
| schema | migrations 195, 196, 197, 198 (reviewed hashes pinned inside the wrapper) | recovery matrix 52/0 on PostgreSQL 17 and 18.6 (`RECEIPT.md`, `PG18_RECEIPT.md`); PG16 rehearsal below |
| app | `1a5f257b703919c4e4caf23dee2fe38002b69591` (`codex/combined-current-rent-roll-app-20260913`) | 71 harnesses 2,422/0; coupled browser acceptance 14/14 against `e808199` (`../current-rent-roll-reconciliation/COUPLED_BROWSER_ACCEPTANCE_20260914.md`) |

Not released by this: any Skyline source acceptance, Greenery adoption,
access grants or content. The mechanism ships; the data decisions stay open.

## The shape, and why

Migrations 195–198 are **restart-incompatible with the old build**: once
they are in the ledger, `d15c968`'s prestart verifier refuses to start
because the ledger names files it does not carry. The running old process
keeps serving (the guard is at startup), and it keeps *writing* correctly —
`d15c968` already uses the `import_source_row_id` conflict target that 198
preserves — but it cannot be restarted or rolled back to. The 182→187
ceremony met exactly this and ruled: **collapse schema and code into one
deploy through a pre-deploy gate**, so there is no borrowed-time window.

The gate for this release is the reviewed wrapper
`tools/release/migration_194_198_predeploy.js --apply`. From exact 194 it
applies 195–198 through the unchanged canonical runner with a pinned build,
positive lock and statement timeouts, and refuses on any ledger, hash,
tracked-file or physical drift. On exit 0 the new build starts against the
ledger it just moved; on any other exit the deploy aborts, the old process
keeps serving, and whatever committed stays committed (recovery is
forward-only: `--resume195/196/197` per the receipt).

## Blocker found in rehearsal (2026-09-14), and its correction

The wrapper refuses a migration whose bytes differ from the SHA-256 it was
reviewed against. At `e808199` the pins for 195, 196 and 197 are the hashes
of a **CRLF Windows checkout**; only 198's pin is the LF git blob (the PG18
receipt records restoring exactly that blob). `.gitattributes` holds all
four files at LF, so on any Linux host — Render, GitHub CI, this container
— the wrapper stops at 195:

```
COMBINED MIGRATION 194-198 PREDEPLOY REFUSED: migrations/195_two_step_leasing_authored_offer_basis.sql differs from the reviewed source.
expected e5c8f9bd…   actual cbdf311e…
```

Proof of cause: the git blobs' SHA-256 after LF→CRLF conversion equal the
three pinned values exactly; 198's does not, because its pin is already LF.
The migration files themselves are byte-identical on the release lane
(`50c4275`), every integration commit and `e808199`; no migration content
is in question. CI could not see it: `verify_all.sh` applies migrations
with raw psql, the "release contract" unit test does not hash files, and
the recovery matrix is not in CI. The Windows runs passed because their
checkouts carried CRLF.

Correction (`03550a8`): pin 195–197 to the LF git blob hashes, and add
`tests/unit/migration_194_198_reviewed_hashes.test.js` (registered in
`verify_all.sh`), which recomputes every pin from the tracked file and the
HEAD blob and fails on drift in either direction — it fails on the old pins
and passes on the new ones. No migration file, no runner, no product
behaviour changed.

## Before touching anything (read-only)

1. **Render dashboard, API service:** confirm auto-deploy is **off**, the
   plan supports a pre-deploy command, and note the currently live commit
   (`d15c968`). Do the same for the app static site (auto-deploy off,
   live commit `336c82f`).
2. **Ledger read against production** (Neon, read-only session). Do not
   type the ceiling from memory:
   ```sql
   select count(*) as rows, max(version::int) as ceiling from schema_migrations;
   select version from schema_migrations where version in ('195','196','197','198');
   ```
   Expected: `182 | 194` and no rows for 195–198. Anything else: stop.
   (`docs/release/ledger_read_before_release.sql` is stale — its build list
   ends at 167 — so do not use it for this release.)
3. **Data preflight, the one thing no rehearsal can prove.** The wrapper
   verifies physical shape; it does not know production's rows. 198 drops
   and recreates `uq_proposed_natural` as a partial unique index over
   `(activation_id, target_type, natural_key) where natural_key is not null
   and import_source_row_id is null`. Run, read-only:
   ```sql
   select activation_id, target_type, natural_key, count(*)
     from proposed_records
    where natural_key is not null and import_source_row_id is null
    group by 1,2,3 having count(*) > 1;
   ```
   Must return **no rows**. 196 adds nullable columns, checks and FKs on
   `proposed_records`; the receipt records the coordinator already found no
   incompatible pre-196 identity rows on 18.6 — re-run that read if more
   than a day has passed. 195 widens checks (adds values), 197 adds a ledger
   table and triggers; neither can be refused by existing rows.
4. **Local:** a clean checkout at exactly the pinned commit
   (`git status --porcelain --untracked-files=no` prints nothing) with
   `node tests/verify_source_governance.js` exiting 0. `deploy.sh` runs the
   gates again before it posts.

## The release (one deploy)

5. In the Render API service, set the **pre-deploy command** to:
   ```
   EXPECTED_SHA=<the full 40-character sha of the pinned commit> node tools/release/migration_194_198_predeploy.js --apply
   ```
   `DATABASE_URL` is already in the service environment. Do **not** set
   `MIGRATION_RELEASE` anywhere — the wrapper refuses if the caller holds
   it; only its child runner receives release authority. Timeouts default
   to 10s lock / 30s statement and may be raised with
   `MIGRATION_PREFLIGHT_*` / `MIGRATION_APPLY_*` if Neon is slow; they must
   stay positive.
6. Trigger the pinned deploy from the clean checkout:
   ```
   ./deploy.sh <the same full sha>   # 03550a8f1cf0ca674839ff51e959c8fbf015730a if that pin is accepted
   ```
   Watch the deploy log for two lines, in this order:
   `COMBINED MIGRATION 194-198 PREDEPLOY: exact 194 accepted (182 ledger rows)…`
   then `COMBINED MIGRATION 194-198 RELEASE VERIFIED: 186 ledger rows, ceiling 198…`,
   followed by prestart's clean verify and `Property Spine API listening`.
7. **If the pre-deploy exits non-zero:** the deploy aborts and the old
   process keeps serving. Read the ledger again. At 194: nothing applied,
   fix the cause, re-run step 6. At 195/196/197: change the pre-deploy
   command's argument to the matching `--resume195` / `--resume196` /
   `--resume197` and deploy again; never delete ledger rows or drop the new
   objects. At 198 with a failed start: the schema is done; the remaining
   problem is the build, and the only recovery artifact is a build that
   understands 198.
8. After the API is live: `curl https://property-spine-api.onrender.com/health`
   must report the deployed sha of the pinned commit. Then **remove the pre-deploy
   command** (a second run would only re-verify and exit 0, but a deploy
   step that silently migrates is not the standing arrangement).
9. **App:** in the Render static site, deploy the specific commit
   `1a5f257b703919c4e4caf23dee2fe38002b69591` (never "latest"). Then verify
   the served files match the git blobs byte-for-byte, as on 11 September:
   fetch `index.html` and each first-party script from
   `https://property-spine-app.onrender.com/` and compare SHA-256 against
   `git show 1a5f257:<file>`; record the table beside this file. The app
   keeps working against the old API for the seconds between the two
   deploys: its unknown `execute_lease` and review-token requests are
   refused before any operating write (receipt, "cached client").
10. **Smoke, signed in as staff, no customer effect:** open the app, choose
    a property, open Deal Setup, upload nothing — confirm the source-home
    review heading renders and the Rent Roll reads. Do not accept any
    Skyline mapping during the smoke.

## Rollback limits, stated plainly

- Code-only rollback after 198 is **not** to `d15c968` (it refuses to start).
  The nearest code-only recovery candidate is any later build that carries
  195–198 and a wrapper that can run on Linux; today that is `03550a8` alone.
- The ledger is never edited by hand and the new constraints, function,
  triggers and indexes are never dropped by hand.
- The app can be rolled back independently to `336c82f` at any time; it is
  a static site.

## Rehearsal on this container (PostgreSQL 16, owned databases)

Reports and scrubbed logs: `rehearsal-20260914/`. Fixture: exact-194 built
from `d15c968`'s real migration chain (`182 | 194`), cloned per phase; every
clone dropped afterwards, the fixture retained for one more day.

**Run 1 at `e808199` — first red.** Recovery matrix stopped at 3/52 and the
release command refused before applying anything:
`PREDEPLOY REFUSED: migrations/195_… differs from the reviewed source`.
Ledger untouched at 194. (`REHEARSAL_REPORT_RUN1_first_red.md`.)

**Run 2 at `03550a8` — every phase green.**

| step | result (verbatim from the logs) |
|---|---|
| recovery matrix `migration_194_198_release_recovery.db.js` | `52 passed, 0 failed` |
| prestart of the new build against 194 (before release) | `✗ REFUSING TO START — the schema does not match this code.` naming 195…198 — the documented deploy-refusal, not an error |
| `EXPECTED_SHA=03550a8… node tools/release/migration_194_198_predeploy.js --apply` | `PREDEPLOY: exact 194 accepted (182 ledger rows); full pin, reviewed hashes, and physical fingerprint verified.` → 195, 196, 197, 198 each `✓ applied and recorded.` → `RELEASE VERIFIED: 186 ledger rows, ceiling 198, all reviewed physical contracts present.` Ledger `186 | 198` |
| wrapper with no argument · `node migrations/migrate.js` | `VERIFY-ONLY: exact 198 verified; no migration was applied.` · `✓ SCHEMA VERIFIED — 186 migrations, all applied. Ledger ceiling 198.` |
| `npm start` (prestart then server) on the upgraded database, `RENDER_GIT_COMMIT` pinned | `/health` → `"ok":true`, `"build":{"build_identified":true,"commit_short":"03550a8"…}` |
| old build `d15c968` prestart against the upgraded database | `✗ LEDGER VERSION MISSING FROM THIS REPOSITORY — refusing to start.` naming 195 — the restart-incompatibility this runbook's shape rests on, witnessed |
| old build `server.js` booted directly (bypassing prestart) | serves `/health` — the guard is at startup, not per request; an already-running old process keeps serving |
| reconciliation proof on the upgraded schema | `current rent-roll reconciliation: 63 passed, 0 failed` |
| release contract · reviewed-hash test · source governance | `23 passed, 0 failed` · 4 files match · `all 56 source-governance gates exited 0`, `PARENT EXIT 0` |

What this still does not prove: production's rows (step 3 above) and the
Neon/PostgreSQL 18.6 catalog, which QB's separate 18.6 run covers for the
same migration bytes.
