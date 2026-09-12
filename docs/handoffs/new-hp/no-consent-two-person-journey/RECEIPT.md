# No-consent, two-person leasing journey — receipt (2026-09-12)

Returned to HP QB. Base: the released pair API
`1320c2c5a6e52caa15de967670ed826ea1d10a84` and app
`4fd0af8f006fd2a926dd422604696e8312501686` on
`codex/hp-release-integration-20260911`. Isolated worktree and branch
`claude/no-consent-journey-20260912`. Owned nonce-verified databases from the
real migration chain (ceiling 194 / 182 rows), owned servers, fake SMS and
model transports. No production read or write, no provider action, no real
message, no deployment, no merge, rebase, reset or force push. No SQL after
a business action. Doctrine read: `CLAUDE.md`, `docs/PHILOSOPHY.md`,
`docs/DB_HARNESS_ISOLATION.md`, relevant `docs/CURRENT_STATE.md` entries.

## Answer

**The chain completes on the real authority shape with SMS consent absent,
and it exposed one released defect in the Leasing desk that this branch
corrects with a three-file, nine-line change.**

- Witness on unmodified `1320c2c`: **99 passed, 4 failed** — the four
  failures are `GET /operator/leasing/desk` returning 503
  `LEASING_DESK_UNAVAILABLE` at every point after an application offer and
  a bound application exist at the property. Everything else in the chain
  passed on the released source.
- Successor on `1320c2c` plus this branch's correction: **103 passed,
  0 failed, 6 observations**, chain complete to one pending lease on Bed B
  at the corrected rent, executed by KZ.
- Existing staff-shell browser proofs on the same released pair, fresh
  owned database, real Chromium: restricted-Mike application slice
  **34/34**, external email **36/36**; the older tour proof stops at 2 with a
  stale expectation (below).

## The journey, as exercised

Actors, exactly as production: **Mike** joins through the governed Team
invite and OTP with the `property_manager` preset (Leasing, Management,
Maintenance; `can_manage_roles=false`; no concession or pricing grant, read
from `concession_authority_grants`). **KZ** is the fixture's configured
company signer with the governed override. Nothing was granted to make a
step pass.

1. **Inquiry, no consent.** Website form with phone and email, no consent
   field, `attempt_sms:false`, `response_channel:"website"`, stable
   `Idempotency-Key`. Captured once; `first_response_sent:false`; zero
   outbound events; no model call; no text; consent stays absent; an exact
   retry replays. Mike's queue shows `needs_you` /
   `website_inquiry_pending_human`; the conversation carries the question.
2. **Ownership and the email Mike sent outside Spine.** Recording before
   takeover is 409. Mike takes over; KZ cannot take it away (409) or record
   on his behalf (409). Mike records the email (`already_sent:true`,
   recipient must match the person's email, timestamp not in the future):
   `recorded`, `dispatched:false`, `provider_delivery:"not_verified"`,
   nothing sent. Same key replays; same key with a different claim 409;
   wrong recipient 409; `already_sent:false` 400. One `recorded_external`
   email event exists. The queue then waits on the prospect with
   `last_delivered_outbound_at` null. A second website question lands on
   the same conversation with no model or text, becomes unanswered again and
   stays Mike's. Ask Spine returns both questions.
3. **Native tour.** Slot published for Mike (after the operating timezone
   fixture, below), booked from the conversation, replay returns the same
   tour, check-in, outcome recorded as ready to apply, conversion opened.
4. **Exact home and terms.** Bed B is offerable as an exact choice. Mike
   cannot author terms (403 `NO_APPLICATION_OFFER_AUTHORITY`). KZ cannot
   offer a bed another resident holds (409 `not_offerable`). KZ authors the
   offer, Mike cannot correct it (403), KZ corrects the unsent draft before
   any invitation (`draft_revision:true`, no message), a second correction
   of the superseded draft is refused.
5. **Preparation, retries, corrections.** A text delivery is refused
   without consent (403 `person_has_not_consented`), nothing texted. The
   superseded offer cannot be prepared (409). A bed another resident holds
   cannot be prepared. KZ's session at another property is 403. Mike
   prepares the link for email: `prepared:true`, `sent:false`, nothing sent,
   no model. Lost-response retry: 409 `APPLICATION_LINK_ALREADY_PREPARED`
   naming the invitation, `link:null`. Retry with a changed expiry: 409
   `APPLICATION_PREPARATION_CONFLICT`. Reload: conversation detail names the
   prepared invitation and exposes no token. Regeneration issues a
   replacement; the replaced link's invitation is `revoked`
   (`superseded_lost_token`), its context reads `state:"revoked"` and it
   cannot submit.
6. **Attestation and application.** Mike attests the email send
   (`/application-invitations/:id/sent`, channel email): the invitation is
   `manually_sent` / `manual` / `email`, never provider dispatched; a second
   attestation is an idempotent replay with one sent invitation. No text
   ever reached the prospect. The applicant opens the emailed link, sees the
   corrected rent, cannot submit against the superseded hash, submits with a
   guarantor, and a repeat submission is idempotent.
7. **Approval to execution.** Mike cannot approve (the approval obligation
   is `leasing_manager`'s; no override). KZ's foreign-property session
   cannot approve. KZ approves. Unacknowledged terms cannot be confirmed
   (409). **Terms confirmation required KZ** (Mike refused); packet and
   signing links were Mike's. A prepared packet blocks a further offer
   change. Guarantor signs only guarantor controls; company blocked until
   the resident signs; resident signs; Mike is not the company signer (403
   `company_signer_not_authorized`); KZ executes; a second execution creates
   no second tenancy. One pending lease on Bed B at 1100; no economic
   activation; no possession; the bed leaves the selector; Application
   Review and Person Card read the same tenancy; no text was ever sent to
   the prospect or the guarantor.
8. **Removed authority.** KZ deactivates Mike's assignment: Mike's live
   session is 401 and cannot prepare a link. Restored afterwards.

## The released defect and its correction

**First failing request:** `GET /operator/leasing/desk` as Mike, after a
submitted application is bound to an application offer at the property:
**503 `LEASING_DESK_UNAVAILABLE`**. Server log: `cannot execute SELECT FOR
UPDATE in a read-only transaction` at `readApplicationOffer`
(`src/money/application_offer_terms.js`). The desk loader opens a
`repeatable read read only` transaction, loads application rows through
`applicationReview.buildReviewDetail`, which calls
`readBoundApplicationOffer` → `readApplicationOffer`, whose select carries
`for update`. Postgres refuses the lock in a read-only transaction and the
whole desk fails for the property. On a database holding earlier bound
applications, the desk fails at every point of the journey, including
before the new prospect's offer exists: one bound application anywhere at
the property takes the Leasing desk down for every staff member. The
locking read entered the review path in `ec9e774` (2026-09-09) and is in
every released pair since, including `24f4482`, `b4a494c` and `1320c2c`.
It was not caught because no registered proof reads the desk after a
submission; the restricted-Mike browser slice stops before submitting.
QB's day-one browser slice run on a database that already held a submitted
application would have seen it (it did here, on the reused database).

**Correction (three files, product):**
- `src/money/application_offer_terms.js` `readApplicationOffer` takes
  `lock` (default `true`, unchanged for every writer) and omits
  `for update` when `false`.
- `src/applications/proposed_terms_service.js` `readBoundApplicationOffer`
  and `readPendingApplicationOffer` pass `lock` through; default unchanged.
- `src/applications/application_review.js` the review projection reads
  with `{ allowHistorical: true, lock: false }`; it never binds, confirms or
  supersedes the offer.

Every writer that goes on to bind, confirm or supersede an offer still
locks. Regressions: `tests/unit/application_offer_terms.test.js` asserts
the SQL takes no lock under `lock:false` and still locks by default;
`tests/unit/application_review_offer.test.js` pins the projection's
options; the journey proof reads the desk at four points. Focused units
(offer terms, review offer, review action contract, desk identity) and all
56 source-governance gates pass on the corrected tree.

## Recorded, not changed

- **Terms confirmation needs KZ.** `proposed-terms` refused Mike; the
  runbook must have KZ confirm terms as well as author, approve and sign.
  Mike's steps: inquiry, email record, tour, preparation, attestation,
  packet, links.
- **Operating timezone is a hard prerequisite** for publishing tour times
  (422 `property_operating_timezone_not_configured` without it). Set as a
  labelled fixture here; an owner input in production, as QB's day-one board
  already says.
- **The replaced link still opens** with `state:"revoked"` and a receipt;
  it cannot submit. That is the tenant page's honest state read, not a
  defect.
- **The older tour browser proof is stale against app `4fd0af8`.** It
  expects "No phone is recorded for texting." and no composer; the app now
  renders the text / email-already-sent composer that the 36/36 external
  email browser proof verifies. Test debt in QB's lane, not product.
- **Harness note.** This container has no IPv6; the proof boundary's port
  probe binds `::`. The browser proofs ran with a harness-only preload that
  maps that host to `127.0.0.1`. Not committed, not product.
- The staff operator shell for the full chain was not driven end to end;
  the three existing browser slices cover inquiry-to-tour, the restricted
  application preparation and the external email. Preconditions for those
  slices (timezone, line, offer authoring) are HTTP.

## Proof and commands

`tests/e2e/no_consent_two_person_journey.e2e.js`, registered in
`tests/e2e/verify_all.sh` in the prospect-activated server block after the
Skyline staff-assisted journey. Evidence: `evidence.witness.json`
(unmodified source, 99/4), `evidence.successor.json` (corrected, 103/0),
`browser_slices.json`; identifiers, phones, emails, tokens and codes
scrubbed.

```
node tests/e2e/proof_boundary.js create && ./tests/e2e/apply_migrations.sh
psql "$E2E_DATABASE_URL" -f tests/e2e/property_fixture.sql
psql "$E2E_DATABASE_URL" -f tests/e2e/fixtures.sql
node tests/e2e/instrument_fixture.js
# owned server booted like tests/e2e/boot.sh with the fixture property in every allowlist, then:
node tests/e2e/no_consent_two_person_journey.e2e.js        # unmodified 1320c2c: 99/4 (desk 503) · corrected: 103/0
E2E_APP_ROOT=<app 4fd0af8> node tests/e2e/staff_application_send.browser.js   # 34/34
E2E_APP_ROOT=<app 4fd0af8> node tests/e2e/external_email_reply.browser.js     # 36/36
node --test tests/unit/application_offer_terms.test.js tests/unit/application_review_offer.test.js
node tests/verify_source_governance.js                     # 56/56
node tests/e2e/proof_boundary.js cleanup
```

Cleanup: both owned databases were dropped and verified; `spine_proofs`
untouched. No production connection string was used.
