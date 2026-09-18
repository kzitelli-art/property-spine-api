# QB acceptance — sibling notice repair, local HTTP

2026-09-09. API HEAD 9f2acff97af311e6ebdcd5e2219f8cf873894748 plus existing working changes. Board and CURRENT_STATE read; complete prior PHILOSOPHY read retained, unchanged SHA256 977B30A4C41B0F8C1511DA3521D030E031AB13B9D1897EEA5970F011F487FC28.

Intention: separate rentable beds may each give notice without cancelling another resident's notice. Same-bed duplicates must refuse; corrections preserve the original tenancy. Existing permanent owner src/tenancy/notice.js and its space resolver survive. No second notice writer or schema is added.

Received and hash-verified Fable exports: core patch c9be1d9e1f375d06, board patch f234d72940d53c80, grain proof e624693675224b18, challenge proof 68f287bf897641bc. Both patches apply in order to the previously untouched notice.js. Result LF-normalized SHA256 def074efd7db468251eca1b834452f35e6d6906f8bd6315f6e67b0c9a32bc3c7 matches Fable custody. CRLF working bytes differ normally.

Root reproduced before applying: owned run 696cb114 rejected bed B while bed A had an open notice. Grain suite reported failing assertions and then its known undefined-event harness error; challenge suite 13/18, five failures. Both ran against the current API, not Fable's container.

Applied both patches locally: give-notice resolves the exact space before its duplicate guard and locks that space; supersede selects the named bed's existing notice; board API returns space labels and prefers canonical identity columns. Cancellation preserves history rather than deleting the old fact. No app source changed.

Successor owned run 71ec8d30: grain 37/37; challenge18/18. Both real HTTP + Postgres, including same-bed burst, sibling independence, exact availability dates, whole-unit behavior, supersession and lease transition. The cross-writer race checks sample concurrent schedules; they are not exhaustive concurrency proof. The challenge file's expected minimum says16 while18 execute; counts above are actual observed assertions.

All54 source-governance gates passed sequentially before the successor, with no active proof or edits. Existing wrapper tests/e2e/onboarding_review_local.ps1 invoked with PROOF_FOCUSED_NAME=notice_qb_review and ONBOARDING_SPACE_PROOF_ONLY=1. New Class3 notice_qb_review driver binds the two unchanged received proofs to the existing owned database/server guard. Full established migration runner applies087/110 using existing precondition fixtures; neither was skipped. Existing pending claim index exercise remains owned-disposable only, unrelated to production migration authority.

Both owned DBs dropped; both cluster data directories removed. No real SMS/model calls, deployment, push, merge or production migration. Private runtime evidence retained outside Git. Unrelated working changes preserved.

Acceptance ceiling: local HTTP service repair and API response legibility, not browser rendering or production readiness. Direct /notices app caller was not found in the inspected app source. Notice routes still use shared-key authentication without staff/property entitlement; this pre-existing authority gap remains OPEN. No claim that an index is required or that all possible writer interleavings are proven. Turnover grain, wrong-bed executed lease DB proof, and SMS Person Card/Ask gaps remain separate QB work.
