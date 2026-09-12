# External inquiry email — native staff composer

Email-only website prospects had no native reply-recording action: the existing composer stopped at “No phone is recorded for texting.” The focused component witness on app `915d6b607c51930e9882ebe009dbc2ebecd49134` failed with zero recording actions where one was required.

App `5b14fe628a5c0ad24d862d3519ecf79c36c78b8a` adds **Email already sent** to the existing Person Card Communication composer. The recipient comes from the canonical Person read and is read-only. Staff enter the actual sent time, body (up to 1500 characters), optional reference and an explicit already-sent attestation. The existing sealed `sendConversationReply` adapter calls the existing scoped `/reply` command with its explicit email contract. No mailbox provider, second thread, invitation action or communications store was added.

Recording requires the current human owner. The original text composer remains the default for phone-bearing contacts; email-only contacts can reach the recording form. An uncertain response retains the identical recording key, recipient, body, time and reference for server-owned replay. A body-matching text or older email is never used as confirmation. Definite server refusals permit correction. A confirmed record followed by a failed refresh remains reported as recorded, with a refresh warning. A response for a closed Person Card cannot overwrite another Person Card.

The thread labels the returned server metadata **Email recorded by staff · delivery unverified**. The actor sees “You” when the retained actor ID matches their scoped session; canonical Person history also retains the asserted event. Human ownership remains in place. A later inquiry again requires an answer from that same owner.

## Evidence

- **36 passed / 0 failed** in real Chrome, the full static app and owned HTTP/Postgres on API `f179ad2fd6c08b09a26dfbcb14a1df59fa27dd66` paired with app `5b14fe628a5c0ad24d862d3519ecf79c36c78b8a`.
- Both email-only and phone-without-consent website inquiries: no phantom outbound on capture, visible original question, native takeover, read-only recipient, explicit sent attestation, exact event/actor/work, truthful delivery state, full-page reload into the same thread record, canonical Person parity, and later inbound returning unanswered work to the same owner.
- The email-only shape commits the first reply then loses its browser response. Identical retry returns the same event and leaves one email record. The phone-bearing shape also verifies the original text composer remains the default.
- **10 focused component scenarios** pass: valid recording, exact lost-response retry despite same-body SMS, foreign ownership, future time, missing email, correction after a definite rejection, refresh failure after confirmed recording, closed relationship, response after switching people, and manual provenance versus existing text-delivery labels. The component viewport is 390px; no horizontal overflow or body-as-HTML rendering was observed.
- A synthetic returning-staff OTP established the fake transport observation before the cases. Capture, recording, reload and later inbound changed neither the fake SMS log nor the fake model log. Browser egress was confined to the local app and owned API.

This is bounded local staff-reply evidence. The already-sent checkbox is a synthetic test-user assertion; no actual external email was sent. It is not full-app acceptance, an inbox integration, verified delivery, a complete lease journey, or actual Mike/production-property acceptance. No deployment, production mutation or provider action occurred. The separate application-invitation email path is unchanged.

Proof source: paired API `tests/e2e/external_email_reply.browser.js`. Workspace receipt and visually inspected screenshots: `handoffs/new-hp/external-inquiry-email/`.

Cleanup verified: canonical cleanup dropped nonce database `spine_proof_2fa64ea2fd56abbeb213c3d3`; dedicated PostgreSQL 55445 stopped. The helper stopped API 3346 and the proof closed static app 5174. Shared and production databases were untouched.
