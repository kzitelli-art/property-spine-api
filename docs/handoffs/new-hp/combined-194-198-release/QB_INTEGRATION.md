# QB combined release review — September 13

This is a candidate review. Production remains API `d15c968` / app `336c82f`, with 182 migration rows through 194. No source acceptance or production migration is recorded here.

The integrated API combines the accepted two-step leasing, source-home review, inventory correction, institutional rent reader, bed-kind mapping, numbered source-index migration 198 and historical-witness repair. It carries Claude's current-rent-roll delivery `d35a359` (product `be9ae71`, independently verified CI 519 at `e067069`). The additional QB corrections are recorded in the adjacent current-rent-roll reconciliation `QB_REVIEW.md`.

## Final product review

The delivered rent-roll mechanism needed three bounded corrections before acceptance: recognizing a resident must not select one of multiple competing rights; a dated source must not be linked as support for contradictory contractual terms; and a current dateless observation must not attach to a future-only pending lease. The final product at `980048958f3164a0c72dcbaa9f8024de359f9b10` preserves those distinctions. The owned PostgreSQL 18.6 and fenced HTTP proof passed **63/0**, including unchanged canonical rent and both dates. Initial witnesses were **60/1** for competing rights and **61/2** for the two further cases. No customer/provider call or production action was part of these runs.

Counts of 160 total, 122 occupied, 12 pending, zero open and 26 review are exact test-fixture assertions. They are not Skyline's production occupancy. The proof also checks the actual availability contract and all unresolved-home membership, instead of a nonexistent field or a tautological count assertion.

## Release and recovery evidence

The release tooling is carried without product changes from `50c4275c19c60347787b86dd8c8d37de216252bb`. The canonical migration runner remains unchanged. Reviewed migrations 195–198 have explicit LF checkout attributes so a fresh Windows checkout preserves their pinned hashes; a checksum refusal must never be bypassed by weakening that comparison.

| Evidence | Exact scope | Result |
|---|---|---|
| PostgreSQL 17 recovery | Exact 194 fixture, real held locks at each migration, explicit resume, wrong-state refusals and two API health starts | 52/0 |
| Independent PostgreSQL 18.6 recovery | Same complete recovery proof at `58bde6dd25b912dcb70b38ea068e86e1102bad15`, same release code as `50c4275` | 52/0 |
| Release contract | Registered pure command/ledger/definition contract on the integrated tree | 23/0 |
| Current rent roll | Existing real upload, review, source and establishment owners on the integrated PostgreSQL 18.6 runtime | 63/0 |
| Cached client | Actual Chromium app `336c82f` against owned API `3d23cb8`, schema 198; obsolete source body refuses with no operating writes | 19/0 |
| Current app integration | App `265db5d` combines Claude's picker/candidate fixes with a fail-closed bulk-new guard | 70 harnesses, 2402/0; final context guard and coupled browser acceptance remain app-lane work |

The PostgreSQL 18.6 receipt and raw output are preserved beside this file. Earlier setup-only failures were database nonce naming, exact migration-file line endings, a duplicated fixture marker and missing child dependencies. They are not product failures. All independent recovery clones, clusters and temporary worktrees were cleaned up; root's separate reconciliation runtime remains owned until final combined verification and cleanup.

The cached-client proof is separately preserved at tests-only commit `c9dc5e5869c9010890e8762ec58d8bb4b65fb82e`. It did not exercise the old client's unknown Execute action; do not add that claim to its 19 checks. Claude's app browser result is predecessor evidence, not a run of the final combined app.

## Remaining release and operating decisions

Full exact-commit combined CI, the final app successor, final owned pin verification, actual release operations and runtime receipts follow this candidate review. The reviewable operation is maintained in the workstation handoff `COMBINED_194_198_RELEASE_OPERATION_20260913.md` so final deployment IDs and commit pins do not require changing an already accepted product commit.

Production source acceptance remains separate: the retained Skyline tracker has 148 signed claims among 160 rows, two conflicting physical room labels and six historical person/home ambiguities. No mapping is approved by these tests. Twelve blank rows do not establish vacancies, a signed flag does not activate a lease, and reported rent does not amend contractual economics. Greenery custody, inventory and actual staff acceptance are still open. Releasing this mechanism alone does not certify either property's launch.
