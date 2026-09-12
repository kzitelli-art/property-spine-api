# Correct an unsent application offer — local API candidate

September 12, 2026. Base API `6cc9c7f`, isolated branch
`codex/draft-offer-correction-20260912`. No app changes, production access,
deployment, provider calls or real messages. No migration.

## Observed first failure

On the unchanged base, an owned HTTP journey captured a website inquiry,
assigned staff ownership and completed the native tour outcome. The manager
then saved a 1250 offer on the chosen bed: HTTP 200. There were no invitations.
The same manager corrected rent to 1025 with a new request key and explicit
`supersedes_application_offer_id`: HTTP 409,
`One current invitation is required to revise these terms.`

The initial witness had 31 passing checks and one failure. An additional
unchanged-source challenge submitted two unnamed drafts with different keys:
both returned 200, leaving three current offers. That witness had 31 passing
checks and three failures. These are observed failures, not production findings.

## Existing owner and bounded correction

`src/money/application_offer_terms.js` already appends `lease_offers` with
immutable snapshots, server-derived actor identity, request identity and explicit
predecessor lineage. Migration 193 protects the terms and permits one child per
predecessor. Currentness is derived from that lineage; the old row is retained.

The existing staff `POST /operator/leasing/conversions/:conversionId/application-offer`
route now admits an explicit pre-invitation correction only when the predecessor
belongs to the same person, property and exact home, remains an uncommunicated
draft and has no invitation or application. Any invitation/application history
retains the existing revision boundary. Existing invitation, applicant-review,
expiry and packet guards are preserved.

The route locks the conversion, also locked by the existing invitation writers.
The canonical offer owner serializes public preparation checks for the person,
property and exact home. An unnamed new draft refuses when a current offer exists.
An explicit pre-invitation revision requires one current predecessor. Retries
return their original offer before the currentness check; changed terms under
the same key conflict. No old terms are updated or deleted.

Root QB supplied the ruling to allow authorized pre-send correction while
preserving history and one current sendable offer. No further owner ruling is
required for this correction.

## API contract for the app

Use the existing route with complete terms, the same exact `space_id`, a new
`idempotency_key` and the current `supersedes_application_offer_id`.

- Success 200: a new `application_offer_id`, `application_terms`, `idempotent`,
  `draft_revision: true`, `applicant_review_required: false`.
- Receipt: `Application draft corrected. No invitation was created and no message was sent.`
- Unnamed duplicate: 409 `APPLICATION_OFFER_ALREADY_EXISTS`.
- Stale or competing predecessor: 409 `APPLICATION_TERMS_REVIEW_REQUIRED`.
- Unavailable pre-invitation correction: 409 `APPLICATION_DRAFT_REVISION_UNAVAILABLE`.
- Changed payload under one key: 409 `APPLICATION_OFFER_IDEMPOTENCY_CONFLICT`.
- Existing invited revisions retain `applicant_review_required: true` and report
  `draft_revision: false`.

Old Ask Spine confirmations already bind the offer identity and terms hash.
After correction, confirmation refuses with `APPLICATION_TERMS_REVIEW_REQUIRED`;
the operator must review a fresh proposal before sending.

## Verification and limits

`tests/e2e/draft_offer_correction.e2e.js`: **50 passed, zero failed**, real owned
server and PostgreSQL. Covers concurrent first creation and correction, retries,
changed-key payloads, preserved predecessor/actor/time, unauthorized leasing
staff, a real foreign property/home, stale confirmation without dispatch, a
fresh proposal at 1025, one deliberate application send to fake transport, and
the existing post-invitation applicant-review revision path. The synthetic
prospect has explicit positive consent. This does not exercise real website
consent collection or Claude's no-consent lane.

The proof starts from the existing property fixture and establishes staff fixture
identity before actions. It preserves the prior fixture lease rows and cancels
their active statuses before this journey, following the existing journey fixture
practice. After prospect actions begin, database queries observe results; they
do not rescue or manufacture an action result. Every prospect action uses HTTP.

The canonical offer unit test passed. All 56 source-governance gates passed.
Runtime was confined by the canonical proof manifest and nonce marker, loopback
PostgreSQL 55446, HTTP 3347, fake SMS/model preloads and the network fence.

Not claimed: full current-pair CI, staff browser correction, reload/reopen draft
recovery, production acceptance or repair of historical multiple-current-offer
ambiguity. Such ambiguity is refused; this change does not choose or retire one
silently. The one-current check is scoped to person/property/exact home, as the
existing canonical reader is.

Integration follow-up: register this proof in the activated intake phase. The
older staff-assisted journey's assertion that pre-invitation revision returns
409 must be updated consistently with its offer lineage. Neither that file nor
`verify_all.sh` was edited by this lane.

## Reproduction

Use `tests/e2e/proof_boundary.js` to create a nonce-owned loopback database, apply
the real migration chain and `tests/e2e/property_fixture.sql` plus `fixtures.sql`,
and boot the owned API with fake transport/model preloads and the fixture property
in the existing activation/intake/application-intent allowlists. Run:

```sh
node tests/e2e/draft_offer_correction.e2e.js
node tests/unit/application_offer_terms.test.js
node tests/verify_source_governance.js
```

Cleanup verified: `tests/e2e/proof_boundary.js cleanup` dropped this lane's
nonce-owned database; PostgreSQL 55446 stopped and HTTP 3347 has no listener.
The migrated proof schema had 182 applied migrations through boundary 194.
