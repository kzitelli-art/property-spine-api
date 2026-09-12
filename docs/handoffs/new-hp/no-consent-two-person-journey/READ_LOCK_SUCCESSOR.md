# Acknowledged offer plus pending revision — September 12 QB successor

Base: Claude `cfdd445`. The original correction passed `lock:false` from application review, but `readBoundApplicationOffer` dropped that option when an acknowledged offer also had a pending invitation. Its unbound-pending branch already passed it correctly.

First red: `tests/unit/proposed_terms_read_lock.test.js` calls the actual offer reader, observes its SQL, and fails only the acknowledged-plus-successor nonlocking branch. Both unbound modes passed. PostgreSQL independently reproduced SQLSTATE `25006`, `cannot execute SELECT FOR UPDATE in a read-only transaction`, through that same historical branch. The unchanged line was restored temporarily for the witness, then the corrected source restored before further work.

The smallest correction passes `{lock}` to the historical pending read. Default writer calls still lock. A second owned witness called the existing `readLeasingStanding` projection in READ ONLY: it returned `read_failed` for application_offer and subsequent aborted-transaction reads. That projection now explicitly requests `lock:false`; its error handling and legitimate unknowns are unchanged. No authority, acknowledgement, submission, packet or confirmation writer changed.

## Successor evidence

- Unit query test: four branch/mode combinations, 16 assertions. Unbound pending and acknowledged-plus-pending reads produce no FOR UPDATE when requested; default mode locks every offer read.
- Existing `application_offer_terms.test.js` and `application_review_offer.test.js` pass.
- `tests/proofs/proposed_terms_read_lock.db.js`: six checks pass on owned real PostgreSQL plus HTTP. Historical acknowledged rent 1200 and pending 1350 remain distinct; standing has no swallowed read failures; the actual Leasing desk returns 200; application acknowledgement pointer/hash remain unchanged.

The DB fixture is explicitly retained historical state assembled before reads, not a public writer journey. Its first setup attempt correctly failed `ck_offer_live_needs_evidence`; the fixture was completed with explicit historical communication evidence before further reads. Legitimate standing uncertainties (unwired next-action dependency in this direct helper call, no selected asking term) remain visible. No claim that Person Card HTTP 200 alone proves completeness.

## Reproduction and isolation

Run the unit with `node tests/unit/proposed_terms_read_lock.test.js`. Run the DB proof through an existing nonce-fenced server with `E2E_API_BASE`, `E2E_PROOF_MANIFEST` and canonical fixtures, followed by canonical cleanup. Register both in the combined runner; this portable slice does not edit the separate journey worker's file.

Windows owned run: PostgreSQL 17 at loopback 55449, API 3350; `tmp/proposed-terms-runtime.js` adapts the previously verified launcher, calls `proof_boundary create/assertDatabase/serverEnvironment`, applies real migration SQL and matching preconditions, then canonical property fixtures. Fresh schema: 182 applied, ceiling 194. Database `spine_proof_85f867e1903ad1ab090dd927`; manifest `tmp/proposed-terms-manifest.json`; separate data directory `tmp/proposed-terms-pg-20260912`. API exits after each proof. No production connection, provider transport or other worker cluster used. Final cleanup/custody is reported to QB separately because the same owned runtime may host QB's combined successor journey.

## Fresh combined-runtime preparation

All 56 source-governance gates exited 0. The initial database named above was canonically dropped and its manifest preserved as `tmp/proposed-terms-manifest.completed.json`. No business rows were selectively removed or rekeyed. A fresh nonce `spine_proof_d0f13826c88afe4821417626` on the same owned cluster was migrated to 182/194 and initialized with canonical `instrument_fixture.js` before reads. The historical regression now creates its own synthetic unit/space instead of using the full journey's standard Bed B. It passed 6/0 again on this fresh runtime; output is retained in `tmp/proposed-terms-historical-successor.log`. This is a new database identity, not preservation of the former DB. QB will record the separate combined-journey result and final cleanup.