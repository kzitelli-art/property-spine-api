# Manual application email — staff app

Website prospects without SMS consent could reach post-tour work but could not open application preparation: the actual board disabled Send at the SMS capability gate. A fresh baseline browser run preserved that stop after 12 earlier checks.

The existing shared exact-home terms reviewer now consumes the API's separate SMS and manual-email capability verdicts. It keeps unconsented text disabled, permits authorized email-link preparation, and shows the recorded destination and prepared link. Copying does not record a send. The operator must separately attest that they emailed the link; the existing invitation `:id/sent` route records that manual fact.

Both the conversation and post-tour entrypoints use this reviewer. Person Card launch reuses the canonical desk row. Named adapters call the existing conversion command with `delivery_method: manual_email`, existing manual-send attestation, and existing lost-token regeneration. No email provider, workflow store, client-owned identity or parallel invitation writer was added.

An exact `APPLICATION_LINK_ALREADY_PREPARED` retry exposes recovery, while other conflicts remain errors. Recovery replaces both invitation and send-child identity from the server response. On page reopen, the reviewer reads only the prepared invitation matching its exact conversion; a token is never recovered from browser storage or a standing read. Canonical `draft_offers` are matched to the selected exact space for pre-invitation correction. Ambiguous drafts remain blocked. The checked requested term takes precedence over dates on an older draft.

## Evidence

- Actual Chrome / full static app / owned HTTP / nonce Postgres: **28 passed, 0 failed**, with API manual-email candidate on 8cf5078 and this app's manual path. This exercised exact Bed B selection, no-consent SMS denial, preparation, simulated lost preparation response, same-key retry, explicit replacement, page-reload recovery, copy/no-send, and synthetic staff email attestation preserving exact bed, actor and channel. No real email or SMS was sent to a customer.
- Existing `shared_application_review.test.js`: pass; SMS preparation/send and asynchronous cancel/Back controls retain their existing contract.
- `manual_application_review.browser.js`: four component scenarios pass for manual preparation/attestation, lost-link replacement, exact canonical draft correction after reopen, and ambiguous draft refusal. These use stub adapters and are not HTTP evidence.
- The 28-check real-browser evidence precedes the final canonical-draft recovery wiring. That wiring has component evidence; the final combined draft/API browser rung belongs to QB integration.

## Two-person review successor

QB review found that the browser tried to author even an unchanged recovered offer. A focused component witness on d6bc86a failed: the operator without offer authority attempted one authoring call and could not prepare the application. The successor reuses the canonical offer only when the exact person/unit/space and every reviewed term match (rent, deposit, both dates, ordered fee codes/labels/amounts/cadences, and explicit no concessions). Governed fee provenance stays on that offer. The server send command remains responsible for authority, exact identity and currentness. Changed terms still call the governed correction route and preserve its authority refusal.

The actual create response is `application_terms`; the reviewer now retains that field after creation, including a response received after Back. Component stubs use the real response shape. Sixteen component scenarios pass, including unchanged terms under the narrower role, eleven changed/unsupported terms or identity cases refused without sending, same-page Back after a correction/preparation failure, and the earlier manual recovery checks. The existing shared post-tour controller test also passes, including asynchronous cancel/Back.

## Final paired browser acceptance

**34 passed / 0 failed** on frozen API `fd8fe0b72f670cb0e0be55b73930d51a81d61747` and app `7ebbd3a0d61325b178709e96f5e03aba90f261d4` (the app product is also integrated as `e5c6d8b`). This supersedes the earlier manager-only browser limit for this bounded application-send slice.

The full staff app runs in Chrome against nonce-owned HTTP/Postgres. Its primary actor has Mike-shaped `property_manager` assignments, Leasing/Management/Maintenance modules, no role override and no pricing grants. A separate synthetic asset manager with a role override establishes and corrects the exact offer through canonical HTTP. The native narrower actor's attempted rent edit returns 403 and makes no send request. After page reload, that actor reviews the authorized successor and prepares the application without another authoring write. Lost preparation response, idempotent retry, explicit regeneration, reload into the prepared invitation, copying and email-send attestation preserve the exact offer/bed/invitation and actor. Unconsented SMS remains disabled throughout.

Preparation and copying do not claim delivery. The final checkbox is a synthetic isolated test-user attestation; no actual external email or customer text was sent. This slice does not exercise applicant submission/signatures, actual Mike's deployed session, production property acceptance, native authorized offer correction, or native tour check-in/outcome (the authoring and outcome preconditions use real HTTP).

**Observed navigation limit:** early clicks immediately after reload can precede the shell's asynchronous restoration of its previous module and be replaced. The accepted proof waits for page hydration and the visible Leasing home, navigating its existing Back/Home controls when needed. It does not claim acceptance of every first-click timing during loading. No product change was made for this observation.

Cleanup verified: canonical nonce cleanup dropped `spine_proof_d78eb2d6b5052de86b3166f4`; dedicated PostgreSQL port 55445 stopped. The helper stopped API 3346, and the browser proof closed its static server on 5174. The integrated app source matches the tested product after normalizing LF/CRLF; the scrubbed receipt retains both actual run-byte hashes and normalized hashes. No shared or production database was changed.

Actual-browser proof source is `tests/e2e/staff_application_send.browser.js` in the paired API. Workspace receipts and visually inspected screenshots are in `handoffs/new-hp/staff-shell-application/`. The same real browser proof's check-in and outcome steps enter canonical HTTP directly; those two staff actions were not clicked in this slice.

This is not actual Mike acceptance, production acceptance, a complete no-consent applicant-to-lease proof, or evidence of email provider delivery. The earlier 28-check actor had a manager override. The final 34-check primary actor has Mike-shaped restricted assignments; a separate authorized fixture actor authors terms over HTTP. Actual deployed accounts remain untested in this slice. No deployment or production mutation occurred.
