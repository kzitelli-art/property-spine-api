# Critical review of the desktop checkpoint

September 6, 2026. Read-only source/evidence review after final laptop cleanup. Product refs remain API `122872154dd58224e80665ddbc10d6dc8cc32d01` and app `a8b9241a106289c77e2dd2d42a2f501c504a50d2`. No product edits, database run, deployment or provider action occurred in this review.

## Judgment

The candidate has meaningful executed repairs and passing API CI. It is **not yet a completed second-property rehearsal or a release candidate that has cleared review**. The latest failure is explained by the proof's contracts; that does not establish that later stages will pass. The largest product concern is whether each operating reader preserves room identity after actual decisions, rather than merely preserving every imported row.

## 1. The proof repair must cover stage and restart

**VERIFIED FACT:** `activation_service.js:377` returns initialized counters including `conflicted:0` plus a `vacant` subtotal. At1062 the activation read instead builds a sparse histogram of actual proposal statuses. In the app proof, `exactCounts` at310 uses `Number(actual[key])`; at434/450 it compares the write counters directly against that histogram. Missing `conflicted` therefore fails. `vacant` is a different dimension, not a status.

The same write object is persisted as `status_counts` at481 and compared again during restart at509. Fixing only the first failing call leaves the restart trap in place. A blanket missing-value-to-zero rule would still compare the nonzero vacancy subtotal to an absent status and could conceal unrelated missing fields if applied globally.

A pure synthetic calculation executed during this review confirmed: the original comparison fails on `conflicted`; a blanket zero default then fails on `vacant`; comparing the explicit status vocabulary passes the matching histogram and still rejects an altered staged count. This is an arithmetic/contract check, **not browser acceptance**.

Next correction: separate status counts from vacancy statistics in the proof's stage receipt, saved state and restart comparison. Normalize absence only within the known status vocabulary; preserve fixed workbook totals and compare vacancy independently to canonical claims if asserted. Check all uses before paying for another full migration/browser run.

## 2. A retained bed is not necessarily a correctly read bed

**VERIFIED FACT:** `src/shared/snapshot_loader.js:1390` groups positions by `unit_number`; the subsequent overlay chooses `bearing[0]` and attaches its canonical space/lease to each matching unit row, recording only an `additional_spaces` count. The same `bearing[0]` line was verified in unchanged d55 and e09 source as well as the current candidate.

**STRONG INFERENCE:** two room rows in one unit can receive the same first room's canonical association. The additional-spaces annotation does not establish which room owns each row. This could mislead Mike about a resident, rent, possession or person-linked action even when the import retained all105 Greenery positions.

**UNKNOWN:** no new DB/HTTP reproduction of that precise two-room consumer case was executed in this review. Do not label it a newly proven production incident. Before actual-source confirmation/release, build two rooms with distinct residents and rents, then require fail-on-d55 and pass-on-successor evidence for the real reader and relevant app/Ask Spine consumer. This need not block completing the current review-only milestone.

## 3. Passing CI includes schema assistance that production does not yet have

**VERIFIED FACT:** the candidate proof explicitly applies `migrations/pending/proposed_source_claim_identity.sql` to its owned disposable DB. That file drops and recreates `uq_proposed_natural`, narrowing the old key rule for source-backed claims. It is not an allocated production migration.

The candidate's repeated current/future bed claims depend on this schema difference. Green CI cannot certify deployment against the unchanged production index. Release planning must assess existing data, migration ordering, index-lock impact and recovery; none was executed here. **OWNER DECISION:** eventual production migration/release approval. Keep it separate from authorized local rehearsal work.

## 4. Publication protection has a deliberate historical exception

**VERIFIED FACT:** `publishedSourceBatchSql` in `dated_positions.js:60` accepts a batch with no referencing activation, or one tied to an established opening position. It does not check whether an unbound batch literally predates the lifecycle. The code comment's historical language describes the intended compatibility class, not a temporal invariant enforced by that SQL.

Do not generalize this repair into “all retained evidence requires explicit establishment.” Unbound history retains earlier semantics. The exact remaining reachability of every unbound writer is **UNKNOWN** from this review; no unauthorized writer is newly alleged. Inventory those consumers before broader publication claims. Shared helpers improve consistency for their callers, but do not prove every application or Ask Spine reader uses them.

## 5. Concurrency and lifecycle coverage must remain honestly named

**VERIFIED FACT:** the lifecycle proof establishes first, then awaits confirm/reject calls sequentially. It proves post-establishment refusal and stored counts. It does not execute a simultaneous establish-versus-confirm race.

Activation-first locking is a sensible source-level defense, but concurrency confidence requires two connections, controlled overlap, visibility assertions and cleanup. Before consequential use, cover confirm/establish and identity-resolution/establish interleavings. Do not confuse the previously executed deposit concurrency proof with onboarding lifecycle concurrency coverage.

## 6. My own execution process needs correction

We spent multiple full Windows runs discovering response-field assumptions that a small contract check could have caught. The app's1576 static assertions and green API CI did not detect these integration-proof mistakes. The large cc896dcd commit spans18 files and several concerns; passing selected suites does not make its integration risk small.

The better next sequence is: inspect all proof contracts once, exercise a tiny synthetic response/UI case including sparse counts and restart serialization, then run the expensive private-workbook proof once. Do not delete or weaken independent assertions to obtain green. Also do not repeat every historical audit merely because this integration proof failed.

## 7. Desktop transfer is code-complete, not environment-complete

**VERIFIED FACT:** code, instructions and curated recovery patches are pushed. Private originals and raw diagnostics are intentionally excluded. Original access/hashes must be checked on the desktop. The local orchestration hard-codes the Git Bash executable path and assumes Windows tooling; installed dependency directories are not portable.

Observed normal-failure cleanup succeeded. The JS wrapper kills direct children and the PowerShell wrapper stops its owned cluster, but abrupt power loss and every descendant-process cancellation path were not exercised. A failed-run browser receipt and process check also do not replace the final provider-sentinel assertions, which appear after the successful browser stages and were not reached on the failed run. Existing interception evidence supports containment; do not overstate it as every final assertion having executed.

## Recommended order and owner boundaries

1. Finish the status/subtotal proof contract across stage, saved state and restart; retain negative count checks.
2. Complete July and Skyline review, immutable retained-byte checks, restart, independent lineage/no-real-confirmation checks, and synthetic mixed Add All on the exact pair.
3. Begin the generic August rehearsal. Separately falsify the unit-to-room reader concern before actual operating publication; the entire historical backlog need not be exhausted first.
4. Assess schema rollout and lifecycle races before release. Existing partial-payment cash-proof and notice sibling-guard risks also remain; they were not re-proven in this review.

Kameron need not reauthorize these bounded local checks. Missing private-source access may require his help; actual identity/source decisions and production consequences require his authority. No merge or deploy recommendation is issued by this review.
