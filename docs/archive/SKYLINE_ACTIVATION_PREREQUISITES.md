# Skyline activation — what must be true before the first real lease

**Nothing in this document is a Skyline value.** No price, no fee, no
lease term, no entity name. Every number and every legal fact here is
deliberately absent, because inventing one would be worse than not having
it. What this document does is name — precisely, with the code path and
the exact refusal — *what the system will demand* when someone with
business authority does have those facts.

Written by reading the running system, not the source. Where a claim came
from executing something, the response is quoted.

---

## The finding that reorders this lane

The blocker on Skyline pricing is **not** that we lack numbers.

`GET /operator/pricing/authority`, asked on a live server:

```json
"inventory": {
  "by_assignment": [],
  "by_grant": [],
  "summary": { "properties_total": 2, "properties_with_publish_authority": 0, "grants_total": 0 },
  "rule": "Authority is explicit. A property with no row here has NO ONE who may
           publish pricing, and the publication service fails closed for every
           person on it."
}
```

**Zero.** Not "zero for Skyline" — zero for every property. Handed the
real Skyline rent sheet this afternoon, there is currently no person on
earth who could publish it, and the system would refuse in the same
sentence for all of them.

That is the honest-blank rule working exactly as designed. It also means
the pricing gate has two independent halves, and only one of them is a
business-numbers problem.

---

## A · The identity half — a session must resolve to a *person*

Same call, for the seeded operator:

```json
"mine": { "person_id": null, "may_prepare_pricing": false, "may_review_pricing": false,
          "may_publish_pricing": false, "denied_reason": "session_identity_not_linked_to_a_person" }
```

`pricingAuthority` (`src/money/pricing_authority.js`) resolves the session
to a **person**, then reads authority for that person. A `users` row is
not enough. Without the link every verb denies before any grant is even
considered, and the reason is stated rather than guessed at.

**Required:** Mike's sign-in identity resolves to a `persons` row on
Skyline. This is a prerequisite of the activation milestone already on
the board ("Mike signs in as Mike → server gives him Skyline"), and it
gates pricing too — which was not previously obvious.

## B · The authority half — someone must explicitly hold the verb

`src/money/pricing_authority.js` confers pricing authority two ways, and
no others:

| basis | source | confers |
|---|---|---|
| `assignment:<role>` | an active `assignments` row whose role is **`owner`** or **`asset_manager`** | all four verbs |
| `grant:<id>` | a time-bounded `concession_authority_grants` row, per-verb flags | only the flags set |

The comment in that file is explicit that this is deliberate: *"a
property_manager or a leasing agent gets nothing from their role alone."*

**Required, and it is a business decision, not an engineering one:** who
holds `owner` or `asset_manager` on Skyline, or who receives an explicit
grant and for how long.

### The consequence nobody has ruled on yet

`publishVersion` (`src/money/pricing_lifecycle.js`) refuses:

```
self_review_without_ownership — "A grant holder cannot both review and publish the same sheet."
```

The exemption is `auth.basis.may_publish_pricing.startsWith("assignment:")`.
So:

- authority by **assignment** (owner / asset_manager) → one person can
  prepare, review and publish the sheet alone;
- authority by **grant** → **two people are required**, because the
  reviewer of a sheet may not be the one who publishes it.

**This is an open ruling, and it is adjacent to R2 (who may bind the
company) without being the same question.** Whoever decides Skyline's
authority model is also deciding whether publishing a rent sheet is a
one-person or a two-person act. Do not resolve it by choosing the basis
that is convenient to test.

---

## C · The pricing lifecycle, as it actually runs

Three governed doors, all `requireOperator`, all taking `property_id` and
`user_id` **from the session and never from the body**:

```
POST /operator/pricing/draft     → saveDraft      (may_prepare_pricing)
POST /operator/pricing/review    → submitReview   (may_review_pricing, decision ∈ approved|rejected|changes_requested)
POST /operator/pricing/publish   → publishVersion (may_publish_pricing) — dry_run defaults TRUE
```

`publishVersion` additionally requires a `review_receipt_id` whose
decision is `approved`, and pins the sheet by digest:

```
proposal_changed_since_review — "This sheet is not the one that was reviewed."
```

So a sheet cannot be approved, quietly edited, then published wearing the
old approval. Publication is also pre-checked against
`previewPublication`, and refuses with `publication_refused` naming the
blocker codes rather than partially publishing.

### The entry point for exactly our case

`GET /operator/pricing/version-one-worksheet` exists and answers, for a
property with no pricing at all:

```json
"disposition": "read_only_worksheet_no_draft_populated",
"types": [ { "code": "3BR", "label": "3 Bed / 3 Bath",
             "offered_status": { "value": null, "decided": false, "options": ["offered","not_offered","pricing_unavailable"] },
             "new_lease_rent":  { "value": null, "decided": false } } ]
```

Every field `decided: false`, every value `null`. It enumerates the
decisions Skyline must make without pretending to have made any of them —
and it populates no draft, so reading it commits nothing. **This is the
right sheet to put in front of whoever sets Skyline's rents.**

---

## D · A gap in our own proofs, found while establishing the above

The e2e pricing fixture (`tests/e2e/fixtures.sql`) does not use any of
those doors. It inserts `pricing_terms` directly and then:

```sql
update property_pricing_versions v set status='published', published_at=now()
```

Every leasing proof we have therefore runs *downstream* of published
pricing, and **the act of publishing has never been exercised over HTTP by
any proof in this repository.** Production holds `pricing_terms = 0`, so
the one step standing between the frozen leasing rail and a real Skyline
lease is the step with no coverage.

That is a proof gap, not a defect — the doors read correctly and refuse
correctly. But "the resolver refuses because no pricing is published" has
been proven many times, while "a person with authority can publish
pricing, and then it resolves" has been proven zero times.

Closing it needs section B settled first: a publication proof needs a
person holding a real basis, and inventing that basis in a fixture would
prove the fixture, not the door.

---

## Still unfabricated, still required from the business

Unchanged by this document, and none of it may be guessed:

1. **Skyline governed pricing** — the actual rents, terms and offered
   statuses, published through the doors in section C.
2. **Six Skyline lease configuration values** — `properties.lease_config`
   (migration 186): landlord entity, application fee, amenity fee,
   utility responsibility, late fee, notice requirement. Absent, packet
   generation fails closed naming the missing keys.
3. **R3 — the Skyline lease form of record**, with the exact body bytes
   whose SHA-256 the signatures are on.
4. **R1 — electronic-signature legal sufficiency.**
5. **R2 — who may bind the company**, plus the pricing-authority ruling
   in section B, which is a separate question with the same shape.
