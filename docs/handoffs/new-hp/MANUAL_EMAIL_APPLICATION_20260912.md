# Manual email application preparation — local candidate

September 12, 2026. API base `8cf5078752e62785d239f5721e735fcadb64ec37`, isolated branch `codex/manual-email-20260912`. No migration, provider call, production write or deployment.

## First red and correction

The installed staff browser baseline reached a real website inquiry, tour and outcome but could not send an application for the prospect without text consent. The focused owned HTTP reproduction called the existing conversion command with `delivery_method: "manual_email"` and received HTTP 403 `person_has_not_consented` before this correction. The retired dispatch endpoint is not used.

The same `POST /operator/leasing/conversions/:conversionId/send-application` command now accepts explicit `manual_email`; omitted delivery method retains SMS. Manual preparation still uses server-owned application intent, exact offer and space, the existing prepare commitment and invitation service. It commits those records and returns the once-returned applicant URL, without invoking dispatch. The existing scoped capability owner evaluates enabled/allowlisted property, known person, recorded email and email revocation independently of text consent. Desk and conversation detail read that same verdict. The desk labels the available action **Prepare email** when text sending is refused.

Manual success is HTTP 200 with `prepared: true`, `sent: false`, `dispatched: false`, `delivery_method: "manual_email"`, `conversion_id`, `invitation_id`, `send_obligation_id`, `prepare_obligation_id`, exact target fields, `link`, and recorded email in `recipient_snapshot`/`email`. These are preparation facts, not email delivery evidence.

## Retry and human completion

The existing conversion transaction lock serializes concurrent requests. Once an invitation exists, matching target/offer/date returns HTTP 409 `APPLICATION_LINK_ALREADY_PREPARED`, the existing invitation/send-child IDs and `link: null`. A prepared invitation additionally returns `prepared: true`, `sent: false`, `dispatched: false`, recorded email and `recovery_action: "regenerate"`. A changed supplied home, offer or move-in date returns `APPLICATION_PREPARATION_CONFLICT`. This does not establish a new request ledger; a new request key cannot silently mint another invitation. An existing terminal invitation directs staff to review it. Explicit expiry changes are not fingerprinted by this recovery receipt.

Conversation detail and desk manual capability expose `prepared_invitations`, scoped by property/person and carrying each `conversion_id`. The UI must match its exact conversion rather than select the newest invitation for a person. Reads never expose a token. The existing regenerate command explicitly replaces the prepared invitation and send obligation, so callers must retain its **new** IDs. The existing `POST /operator/leasing/application-invitations/:id/sent` with `channel: "email"` records the human's explicit external-send attestation. Preparation, retry and regeneration do not attest or send anything. Recorded email can change before attestation; it is not represented as an immutable preparation-time recipient claim.

Uninvited draft-offer reload recovery is a separate canonical owner contribution being reviewed by QB. This candidate does not introduce another offer-currentness query.

## Local evidence

`tests/proofs/manual_email_application.db.js` passes **19 checks** through the real authenticated HTTP API and canonical owned Postgres schema. It uses actual intake, tour booking/check-in/outcome and exact Bed B offer, then proves unsupported method refusal, absent/revoked email refusal before invitation birth, default SMS refusal without consent, independent read verdicts, concurrent preparation exactly once, truthful preparation, matching retry, conflicting target refusal, no duplicate invitation, reload recovery, explicit regeneration and separate email attestation. A returning-staff OTP positive control first establishes that the owned server writes the fake SMS log; preparation, retry, regeneration and attestation leave that log unchanged. No lease is created.

Four existing focused unit files passed: application send command (9), capability contract (21), admission eligibility (19), leasing desk identity (8). All 56 source-governance gates also exited 0. The optional capability database layer was explicitly skipped by clearing `DATABASE_URL`; owned HTTP evidence above is separate. Browser and combined CI evidence are recorded by their owning lanes, not inferred from these checks.

The staff browser owner subsequently reported **28/28** on this frozen API candidate and its paired app: exact-bed terms, SMS refusal, manual preparation, lost-response retry, replacement link, full-page recovery, copy without send and explicit synthetic email attestation. Its separate browser file/receipt remain that lane's evidence and commit custody. This is local browser evidence, not actual email delivery or property acceptance.

Windows local execution used the canonical proof boundary through the outer task helper `tmp/staff-shell-runtime.js`, pointed at the isolated API/app siblings. Owned PG was `127.0.0.1:55445`, API `127.0.0.1:3346`; init applied the real migration/precondition chain to a unique manifest database, run supplied fake providers and ended its server. Command: `node tmp/staff-shell-runtime.js run tests/proofs/manual_email_application.db.js` from the outer workspace. The proof itself is portable and requires `E2E_API_BASE`, canonical owned manifest environment and `E2E_SMS_LOG`. Runtime custody was then explicitly returned to the staff browser agent; cleanup belongs to that final consumer.
