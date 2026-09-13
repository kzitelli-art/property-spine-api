# Source index compatibility witness — 2026-09-13

This successor repairs the CI parent-onboarding witness around migration 198.
The normal candidate schema is 198, while the pinned historical onboarding
business sources at `e09c5411e2c072c3452e48b434a9f8a8250ce1bb` were written
against the pre-198 natural-key index. Running those sources directly on the
198 index produced the recorded first red: `42P10` at
`activation_service.js:351` / `canonical_onboarding_source.db:59`, because the
old `ON CONFLICT (activation_id,target_type,natural_key)` no longer matched the
partial 198 index.

`tests/e2e/verify_all.sh` now verifies the exact 198 ledger row and full
`pg_get_indexdef` predicate, atomically reconstructs the exact 197 ledger and
old natural-key index for all three parent witnesses, then restores 198 through
the real numbered `migrations/migrate.js --apply` runner with an explicit
197-ceiling expectation and verifies the restored ledger and full index
definition. No candidate migration is applied by hidden SQL.

Owned local targeted run on the disposable 55453 database:

- parent source defects: **7/7**;
- parent lifecycle defect: **7/7**;
- parent snapshot defects: **15/15**;
- numbered runner restored migration 198 and the exact source-row predicate;
- no production/provider/shared database was used.

The test-only compatibility setup does not alter the historical parent source,
does not claim those parent defects are fixed, and leaves the normal candidate
at exact 198 for subsequent proofs.
