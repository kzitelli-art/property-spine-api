# Recover the current unsent draft — local API read candidate

September 12, 2026. Follow-up to correction commit
`491ccc69b36c55d24bed88042b1711a8568842d1`. The original
[50-check correction receipt](RECEIPT.md) remains the evidence for that commit.
This adds an owner read for staff surfaces; it does not itself wire an app surface.

## Existing mechanism and read contract

Person Card and leasing standing expose application-bound terms after an
application exists. They did not return a pre-invitation draft's identity and
terms. Consequently an app reopened after saving could not identify the draft
to correct it through the existing route.

`src/money/application_offer_terms.js` now exports:

```js
readCurrentApplicationDrafts(q, { property_id, person_ids })
// Map(personId, {
//   draft_offers: [{ id, space_id, terms }],
//   ambiguous_space_ids: []
// })
```

The batch read requires the caller's server-derived property. It shares the
existing current-application-offer predicate and retained-terms hash validator
with preparation and conversational review. It acquires no row lock and makes
no write. Expired or superseded offers are not current. A returned draft is
uncommunicated and has no invitation or application. Competing current offers
on one exact home yield an ambiguous space ID and no selected draft for that
home. A corrupt retained terms snapshot fails the read; it never becomes a quiet
empty result. The helper reports retained facts and grants no action authority.
The correction/send routes still decide authority and current eligibility.

Composition belongs in the existing
`src/identity/capability.js:evaluateManualEmailPreparationBatch` and its single
person wrapper, which already feed conversation detail and leasing desk rows.
Expose `draft_offers` and `ambiguous_space_ids` within `manual_email_preparation`.
The app must match the chosen exact `space_id`, require exactly one draft, and
refuse to choose on ambiguity. Neither that capability file nor the app is
changed in this commit; root QB coordinates that composition with their owners.

## Evidence

`tests/e2e/draft_offer_correction.e2e.js`: **54 passed, zero failed**, including
the previous correction controls and four added recovery assertions. Before a
draft the read is quiet; after save it returns the exact 1250 draft; after a
governed correction it returns only the exact 1025 successor; after an actual
invitation it returns no uninvited draft. Each recovery call runs in PostgreSQL
`REPEATABLE READ READ ONLY` against the real owned server's database. Business
actions still use HTTP with fake transport and no SQL rescue.

`tests/proofs/application_draft_recovery.db.js`: **4 passed, zero failed** in
`REPEATABLE READ READ ONLY`. Historical fixture rows challenge duplicate current
offers, a quiet person, another established property and a corrupt hash. Those
rows are explicitly created before the reads to test historical-state handling;
they are not claimed as results of the current writer, which refuses duplicate
creation. This proof tests a canonical read primitive, not an onboarding path.

The canonical offer unit test and all 56 source-governance gates pass. Full
current-pair CI, capability composition, browser recovery and production
acceptance are not claimed by this receipt.

## Runtime and reproduction

Use the same canonical nonce-owned harness, real migration chain, fixtures,
allowlists and fake preloads recorded in the original correction receipt, then:

```sh
node tests/e2e/draft_offer_correction.e2e.js
node tests/proofs/application_draft_recovery.db.js
node tests/unit/application_offer_terms.test.js
node tests/verify_source_governance.js
```

This follow-up used a new nonce-owned database on dedicated loopback PostgreSQL
55446 and HTTP 3347, with the canonical manifest and egress fence. Cleanup
verified: the nonce-owned database was dropped, the dedicated PostgreSQL cluster
was stopped, and both ports have no listener. No shared database, production,
provider or real message action occurred.
