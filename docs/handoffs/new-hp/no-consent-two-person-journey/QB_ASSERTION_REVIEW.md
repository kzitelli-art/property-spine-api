# QB assertion successor — runtime pending

September 12, 2026. Proof-only successor based on `cfdd445ed1ea4216422ff2c7a847a99e1cedbbe1`, isolated branch `codex/no-consent-assertions-20260912`. Only `tests/e2e/no_consent_two_person_journey.e2e.js` and this receipt changed. No product, application UI, migration, package or runner changes.

The original `RECEIPT.md` and its 99/4 witness, 103/0 successor and browser evidence remain historical evidence. **This strengthened journey has not been run.** `node --check` and `git diff --check` passed. No DB, server, provider or production action was taken in this review lane. Root QB owns composition with the separate lock-propagation repair and the owned runtime run.

## What is now required

- Mike has the `property_manager` assignment with Leasing/Management/Maintenance, no role-management override or pricing grant. KZ is the fixture's sole configured signer.
- Valid acknowledged proposed terms submitted by Mike must return **403 `not_authorized_for_terms`**. No alternate actor rescues an unexpected result. Mismatched terms from either Mike or KZ must return **409 `application_terms_conflict`**. Read-only snapshots verify no confirmation, confirmation event, application status, terms pointer or economics projection changes on these refusals.
- KZ must confirm with **200**, `authority_basis: managed_role_override`, one new canonical confirmation/event and the exact application pointer. The confirmation's actor, property, application and corrected offer identities must agree.
- Mike must generate the packet with **200** and issue its two signing links with **200**. Packet identity, application/property/unit, offer/confirmation lineage and canonical generation/issue audit actor must agree. No KZ fallback remains. Reissue must return the same packet with `already_issued` and no new secrets. Model/SMS logs must stay quiet at link issue.
- Existing approval, foreign-property, no-consent, occupied-bed, draft revision, stale terms, invitation regeneration/replay, resident/guarantor controls, company signing and removed-assignment restrictions remain. The approval and company-signing failures now name their actual canonical error contracts.
- Desk **and** conversation queue reads occur after corrected draft, link preparation, email attestation, application submission, approval, acknowledged-terms confirmation, packet generation, link issue, resident/guarantor signatures and company execution. Each must return 200 and the same session property. Once created, the application must remain uniquely identifiable in the desk; its known lease identity must agree after execution. The active conversation queue deliberately excludes advanced/booked conversations, so absence of that row is not incorrectly treated as a failure or a new workflow requirement.
- Both exact-home selector reads must return 200 with an eligible-target list before target presence/absence is asserted. Final Person Card requires the exact person/property/pending bed tenancy and no `read_failed` leasing-standing uncertainty; HTTP 200 alone is insufficient.

The source contracts were reviewed with the independent Claude-journey reviewer: `operator.js` proposed-terms, packet, issue and approval adapters; `proposed_terms_service` authority and persistence; `lease_packets` public/audit identity; leasing desk/queue and Person Card projections. This review establishes expected assertions, not observed runtime success.

## Fixture custody and run notes

The original lead-source insert and occupied C7 unit/space/lease fixture writes happened after business actions. They now precede Mike's governed invite/OTP, which is the first business action. Subsequent direct SQL is read-only; staff-session issuance remains the existing identity service. No new post-action data repair was added.

The pre-existing fixture still cancels nonterminal leases on the chosen fixture Bed B before the journey. This is **not** a twice-on-the-same-database accumulation proof and must not be described as preserving a prior exact-bed execution. Run once on a deliberately owned prepared stack. A second execution would need distinct home/prospect custody and explicit preservation of the first result, outside this edit.

Root's planned runtime is the existing nonce-owned stack (API loopback 3350, PostgreSQL 55449), after the instrument fixture and combined source are ready. Use that stack's actual `E2E_PROOF_MANIFEST` and boundary environment, `E2E_API_BASE`, `E2E_SMS_LOG`, and `E2E_ANTHROPIC_LOG`. The server must retain the fixture property's existing boot-script allowlists, fake transports and `e2e-intake` intake secret. Run `node tests/e2e/no_consent_two_person_journey.e2e.js` once; set `PROOF_OUTPUT_DIR`, `PROOF_EVIDENCE_LABEL` and `PROOF_SERVER_SHA` to record the exact combined source and scrub the resulting receipt before committing it. Do not copy connection strings or tokens into Git. No separate stack was opened by this author.

This fixture remains a Skyline-shaped mechanism rehearsal. It does not accept Greenery configuration, real KZ/Mike permissions or lease forms, real provider delivery, deployed behavior or production launch readiness.
