# Executed premises — bounded Fable F1 repair

2026-09-09. API inspected HEAD 9f2acff97af311e6ebdcd5e2219f8cf873894748 plus working changes; app HEAD c05ae68f6f8bc49ca4b5bd752adc928e1f4e0d88 remains unchanged by this repair. CURRENT_STATE read first; governing PHILOSOPHY unchanged SHA256 977B30A4C41B0F8C1511DA3521D030E031AB13B9D1897EEA5970F011F487FC28 (previous complete read retained).

Intention: an application naming bed B cannot silently activate a recorded lease naming sibling bed A. The signed instrument remains recordable even when it disagrees with the application. Preserve both facts; refuse activation until corrected.

Existing permanent owner: executed_lease_service.verifyExecutedLease and computeAdmissionBlockers. History 41cbc2b establishes the executed instrument path; the current service explicitly separates recording from admission. confirm-term calls the evaluator afresh. No new owner, workflow, schema or browser authority is introduced.

First red: extending the existing real-service/stub-query evidence test produced three failures: missing sibling conflict, admitted sibling mismatch, missing application space in comparison evidence. Matching-space control passed. The test stub also required current lifecycle fields and obligation reads; after repairing those stale test responses, 76/79 passed and only the three premises failures remained.

Smallest repair: compare application.space_id wherever present at both existing premises boundaries, retain the existing unit mismatch wall too, and expose application_space_id in conflict and comparison evidence. Legacy unit-only applications retain their prior unit check; no bed is inferred. Forbidden second path: UI-only validation or a new admission writer.

Assertions map to philosophy §§6–8,12,29,33: conflicting evidence remains recorded; exact-bed activation is blocked; matching and legacy premises remain valid; changed application premises are caught by fresh evaluation; correction clears the disagreement; cross-property, economics, overlap, supersession and activation gates retain their existing checks.

Validation:
- node tests/unit/executed_lease_evidence.test.js: first red 76/79, successor 81/81 (includes two fresh-evaluation controls added after the initial green).
- node tests/unit/executed_lease_overlap_contract.test.js: 8/8.
- node tests/verify_source_governance.js: all 54 gates pass, run sequentially without source edits or active server proof. The last two test-only assertions were added afterward and the evidence test rerun.

Proof rung: locally exercised real service with a stub query client; source-governance and overlap contract checks. NOT real Postgres, HTTP, browser, deployment or live tenant proof. No product migration, push or deployment. Source files: src/applications/executed_lease_service.js and tests/unit/executed_lease_evidence.test.js. Unrelated dirty changes preserved.

Remaining: owned Postgres/HTTP verify-to-confirm refusal; exact-bed picker default in app; Fable sibling-turn/notice and alternate move-out authority findings. Fable's missing-prospect-data claim is contradicted by existing person-fact capture. Its snapshot predates the live contributor repair. Full phone-only application handoff remains open.
