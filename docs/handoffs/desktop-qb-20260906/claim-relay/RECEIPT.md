# Retained opening claims — QB repair

Inspected base: API `6a2d46f719b6aadd606e7484b13dac1f9fef20df`, paired app
`8baf7401aa2a4ae527417e83035bc724270312eb`. QB reread CURRENT_STATE and the
complete PHILOSOPHY before building. Candidate branch: `codex/claim-relay-20260907`.

The operator's question is which retained source claims still need reconciliation.
The canonical owner is `datedPropertyPositions`, projected into the unit Rent Roll
and tenancy standing used by Ask fact gathering. Fable's last green candidate
already carries this relay. Its first red cases were reproduced on an owned DB:
two agreeing eligible claims left one falsely unattached; retiring the only unit
left one retained claim in Rent Roll but none in Ask; a 51-row total with a 50-row
list lost its truncation flag downstream. All three positive defect witnesses
passed before product edits (four assertions).

The smallest repair preserves references to every agreeing eligible proposal,
carries retained claims through the standing reader's zero-inventory return,
and relays `unattached_source_rows_truncated`. Candidate selection, identity
eligibility, conflict handling and inventory are unchanged. These are repairs to
existing readers, not a new storage or workflow path. A second identity matcher,
stored reconciliation counter or invented current position is forbidden.

## Executable boundaries

- Philosophy §§6–8, 29, 40: two agreeing eligible keys remain one vacant position
  and produce zero unattached rows. Disagreement still produces unreconciled
  evidence with both proposals attached. Reads preserve the proposal history.
- §§4–6, 12, 39–40: retired-only inventory returns zero current positions and
  null standing position, while retaining its source claim in Rent Roll and Ask
  fact gathering. Retained claims do not establish current occupancy.
- §§3, 33, 40: all 51 unmatched rows are counted; only 50 are returned; the list's
  truncation flag reaches both consumers. A partial list cannot imply completion.
- §§17–23, 40.8: the HTTP proof exercises session property scope and live module
  entitlement. Ask checks use the existing fact gatherer, not a model answer.

Proof: `tests/proofs/opening_claim_relay_edges.db.js`. It runs by default in the
owned Windows successor wrapper and in `verify_all.sh` at the DB rung. The
Windows wrapper adds HTTP checks after proving ownership of its API server;
CI's pre-server DB invocation does not claim HTTP coverage.

## Observations

The first successor passed 11 DB assertions, the existing historical reader and
space availability successor checks, and the pending-index negative/positive
controls. The owned database was dropped, cluster stopped and data removed.
Targeted occupancy-basis unit tests: 4 passed. The expanded successor then passed
20 relay assertions including HTTP counts, explicit truncation, session scope,
management-only refusal and live leasing entitlement removal. Identity: 17 passed;
existing unattached-claim proof: 14 passed; readiness: 13 passed. Historical reader,
space availability and both index controls also passed. The owned database was
dropped, cluster stopped, data absent; SMS, model and egress logs were zero bytes.
See [parent aggregates](parent.json) and [successor aggregates](successor.json).

One intermediate HTTP attempt failed because QB's fixture granted management
but the existing Rent Roll route requires leasing. The route correctly returned
403. The fixture was corrected, with that refusal retained as an explicit negative
control. Product authorization was not changed. The independent cheaper reviewer
found no product defect in this seam and identified the missing explicit
NOT_ESTABLISHED assertion, which was added for both standing and Ask before the
final run. This is bounded review, not whole-product acceptance.

Commands: `node --test tests/unit/availability_occupancy_basis.test.js`;
`git diff --check`; and `tests/e2e/onboarding_review_local.ps1` with retained private
July/Skyline inputs and the existing PG/Chrome executables. Environment:
`ONBOARDING_PARENT_ROOT` points to the unchanged retirement parent;
`ONBOARDING_SPACE_PROOF_ONLY=1`, `PROOF_SPACE_EXPECT_DEFECT=0`,
`PROOF_SPACE_BROWSER=0`, `PROOF_HISTORICAL_READER_CHALLENGE=successor`.
The final wrapper exited zero. Exact private run paths/custody stay in the local
QB operating board, outside Git. The product source was frozen during the run;
this receipt and aggregate evidence were added afterward.

The cheap task initially wrote its proof into the old desktop candidate and
expected an older parent behavior. QB caught the custody error, froze that task,
moved only its new proof into this candidate, and corrected expectations before
the parent witness. Its initial receipt was not accepted as evidence. The separate
read-only reviewer verified this candidate's branch/HEAD and reread the philosophy.

## Scope remaining

This slice repairs API readers. The app has no new retained-claim panel; HTTP
field availability is not browser display proof. Ask fact gathering is not Ask
HTTP, a generated answer, or cross-domain authorization acceptance. The full
July/Skyline browser/restart run was green at the base pair, not yet repeated on
this successor. No production deployment, migration or actual-source confirmation.

Fable's independent lane covers absent versus null lineage, retirement reversal
and replacement, named whole-unit placeholders, and readiness meaning across
marketing/touring/application/delivery. QB owns integration judgment; those
questions remain open. The generic August adapter remains behind the bounded
July/Skyline milestone.
