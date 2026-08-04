# MONEY TRUTH — MAINTENANCE EXPENSE VERTICAL SLICE

**Status: DESIGN TRACE. No code, no schema, no migration, no accounting logic.**

One real maintenance expense, followed end to end, to find where operational
truth becomes an economic fact. One slice only. This designs no chart of
accounts, no accounts payable, no bank reconciliation, no general ledger, no
financial statements, no budgeting, no investor reporting and no tax treatment.

Every table named below was read from the live schema. Nothing is invented.

---

## 1. One concrete maintenance expense story

**Unit 4B, water heater fails on a Friday afternoon.**

- **Fri 14:10** — resident reports no hot water. A work order is created,
  `is_emergency = true`.
- **Fri 14:40** — the property manager authorizes a vendor call-out and
  records `est_cost` of $900.
- **Fri 18:20** — the plumber replaces the water heater. Not a repair — a
  **replacement**.
- **Fri 18:35** — the technician marks the work complete on their phone and
  attaches two photos.
- **Mon 09:15** — the property manager reviews the photos and **accepts** the
  work.
- **Wed** — the vendor's invoice arrives: **$1,240**, not $900. It itemizes a
  $180 after-hours call-out and a heater one model larger than quoted.
- **Wed** — the manager decides the overage is legitimate and approves it.
- **The following Tuesday** — $1,240 leaves the operating account.
- **Three weeks later** — the vendor issues a **$180 credit**: the after-hours
  fee was charged in error.

Six facts that are frequently conflated and are all different here:

| fact | date | value |
|---|---|---|
| work authorized | Fri | $900 (an estimate) |
| **service performed** | **Fri** | amount not yet known |
| work accepted | Mon | amount still not known |
| amount established | Wed | $1,240 |
| cash paid | following Tue | $1,240 |
| credit issued | +3 weeks | −$180 |

**The expense belongs to Friday. Nobody knew its amount until Wednesday, and
the final amount was not correct until three weeks later.** Every hard question
in this slice descends from that sentence.

## 2. Operational objects already present

Property Spine's maintenance domain is **materially stronger than its leasing
domain** on exactly the axis the receipts audit found weak. This is the best
foundation in the codebase for a money layer.

| object | carries |
|---|---|
| `work_orders` | `property_id`, `unit_id`, `vendor_id`, `est_cost`, `is_emergency`, `tenant_caused`, **`work_nature`**, **`extends_useful_life`**, `urgency_decided_by/_at`, `idempotency_key` |
| `work_completion_claims` | **immutable claim** — `claimed_by_user_id`, `claimed_at`, `outcome`, `proof_photos`, `proof_satisfied`, `proof_shortfall` |
| `work_acceptances` | **immutable acceptance** — `accepted_by_user_id`, `accepted_at`, `commitment_source`, **`supersedes_id` + `supersede_reason`** |
| `work_proof_attachments` | evidence with **`sha256`**, `uploaded_by_user_id`, `byte_size`, `mime_type` |
| `work_reopenings` | the failed-inspection path |
| `work_order_billback_decisions` | **`amount_cents`**, `decision`, `entry_kind`, `actor_user_id`, `actor_person_id`, `supersedes_id`, `source_obligation_id` |
| `vendors` | `trade`, `preferred`, **`insurance_status`** |

Three of these already meet the full standard the receipts audit demanded and
mostly failed to find: **immutable, actor-attributed, object-named, with
supersession lineage and content-hashed evidence.**

Two columns deserve particular attention because they are **capitalization
signals that already exist**: `work_nature` and `extends_useful_life`. A water
heater *replacement* that extends useful life is the textbook capital-versus-
expense question, and the operational layer is already capturing the input.

## 3. Missing economic objects

There is a money layer, and it is **empty and oriented the other way**.

| object | state |
|---|---|
| `money_events` | **0 rows.** Shaped for *spend capture* — `amount`, `vendor` (free text), `spent_by_person_id`, `occurred_on`, `receipt_note`, `proposed_category` / `confirmed_category`, `verified_by_person_id`. A person-spent-money record, not a vendor-invoice record. **`vendor` is text, not `vendor_id`** — no lineage to `vendors`. |
| `money_event_attributions` | allocation with confidence scoring and confirm/reject — genuinely useful, and it attributes by `related_type`/`related_id`, so a work order could be a target |
| `ledger_entries` | **0 rows.** `lease_id`, `label`, `kind`, `amount`, `method`, `occurred_at` — **resident-side**. No property-expense concept. |
| `ledger_claims` | onboarding balance reconciliation. Unrelated. |

**What does not exist at all:**

1. **A vendor invoice / bill.** No object holds "the vendor asserts $1,240 for
   this work, invoice #, dated, terms". `money_events.amount` is one number
   with no line items and no source document identity.
2. **A service period / service date distinct from the spend date.**
   `money_events.occurred_on` is a single date. The slice needs *service
   performed Friday* and *amount established Wednesday* as different facts.
3. **An expense recognition record.** Nothing says "this became an expense of
   this property on this date for this amount, on this evidence".
4. **A vendor payment.** No object links a bank outflow to a bill.
5. **A credit / reversal.** `supersedes_id` exists on billback decisions and
   acceptances, but there is no economic credit note.
6. **Vendor lineage into money.** `money_events.vendor` being text is a real
   gap: a T-12 by vendor cannot be built from free text.

## 4. Proposed sequence of claims and confirmations

Following the product's own grammar — **a claim is asserted, a confirmation is
governed** — and reusing the receipts vocabulary.

| # | stage | nature | who | evidence | exists today? |
|---|---|---|---|---|---|
| 1 | work identified | **claim** | resident or staff | report | ✅ `work_orders` |
| 2 | work authorized | **commitment** | PM | `est_cost`, urgency decision | ✅ `work_orders` |
| 3 | work performed | **claim** | technician/vendor | photos (sha256) | ✅ `work_completion_claims` |
| 4 | work accepted | **confirmation** | PM | proof reviewed | ✅ `work_acceptances` |
| 5 | cost claimed | **claim** | vendor | **invoice document** | ❌ |
| 6 | service date established | **confirmation** | derived from #3, confirmed | acceptance | ⚠️ partial |
| 7 | economic obligation confirmed | **confirmation** | PM | invoice + acceptance | ❌ |
| 8 | expense recognized | **accrual** | system, from #7 | — | ❌ |
| 9 | cash payment matched | **payment** | bank feed + confirm | bank txn | ❌ |
| 10 | credit / reversal | **correction** | vendor claim → PM confirm | credit note | ❌ |
| 11 | T-12 | **projection** | read-only | — | ❌ |

Stages 1–4 exist and are strong. **Everything from stage 5 is missing.** The
boundary is exactly where the vendor's assertion enters — which is also
exactly where an outside party's claim first touches the record.

## 5. The exact recognition decision point

**Recognition occurs at stage 7 — economic obligation confirmed — and not
before.**

Why not earlier:

- **Not at authorization (2).** $900 was an estimate. Recognizing an estimate
  puts a number in the record nobody asserted. Honest blank beats confident
  wrong.
- **Not at completion claim (3).** The work happened, but the amount is
  unknown. Recognizing "some expense" is not recognizing an expense.
- **Not at acceptance (4).** This is the tempting one and it is wrong. On
  Monday the work is confirmed done and the amount is *still* unknown —
  Wednesday's invoice is $340 higher than the estimate. Acceptance confirms
  **performance**, not **amount**.
- **Not at invoice receipt (5).** The vendor's claim is a claim. $180 of it was
  wrong. An unconfirmed claim is not an obligation.
- **Not at payment (9).** That is cash movement, a different question.

Stage 7 is the first moment when both halves are true and governed:
**a confirmed performance fact (4) AND a confirmed amount (7).**

Recognition needs both, and the recognition record must name both.

## 6. Cash-date versus accrual-date treatment

| | date | amount |
|---|---|---|
| **accrual** | **service date — Friday** (from `work_completion_claims.claimed_at`, confirmed by acceptance) | $1,240, then −$180 |
| **cash** | **payment date — following Tuesday** | $1,240, then −$180 on the credit's own date |

The two dates can land in **different months**, and in this story they nearly
do. That is the entire reason `occurred_at` / `recorded_at` / `effective_at`
were kept as three distinct fields in `operation_receipt_v1`.

The mapping for this slice:

```
occurred_at   the service date          — when the world changed
recorded_at   when Property Spine learned — never a period date
effective_at  the accrual service period — for an expense, derived from
                                           occurred_at, NOT from the invoice
```

**The invoice date is not the expense date.** It is the date a claim was made.
This is the single most common error in small-portfolio bookkeeping and the
one this design must structurally prevent.

## 7. Evidence and approval requirements

| stage | evidence | approval |
|---|---|---|
| authorize | urgency basis; `est_cost` | PM; existing `urgency_decided_by` |
| completion claim | photos, `sha256` via `work_proof_attachments` | technician's own claim |
| acceptance | proof reviewed; `proof_satisfied` / `proof_shortfall` | **PM ≠ claimant** |
| **cost claim** | **the invoice document itself, content-hashed** | vendor |
| **obligation confirm** | invoice + acceptance + variance vs `est_cost` | **PM, and a second authority above a variance threshold** |
| payment | bank transaction | matched, then confirmed |
| credit | credit note, hashed | PM |

Two rules the slice makes concrete:

1. **The acceptor must not be the claimant.** `work_completion_claims` and
   `work_acceptances` are already separate tables with separate actor
   columns — the separation exists and should be enforced at the money boundary.
2. **A document hash is required for any outside claim.** `executed_lease_records`
   already proves the pattern with `document_sha256`. An invoice without a
   hashed document is an unverifiable assertion; the $180 error is exactly what
   a later reader needs the original document to adjudicate.

## 8. Correction, credit and reversal flow

**Never mutate the recognized expense.** The $1,240 recognition on Friday's
service date stays. The credit is its own economic event with its own dates,
pointing at what it corrects.

```
expense recognition  $1,240  service date Fri     supersedes: null
credit               −$180   its own service date corrects: <recognition id>
```

`work_acceptances.supersedes_id` + `supersede_reason` and
`work_order_billback_decisions.supersedes_id` show the product already models
supersession this way on the operational side. The economic side must follow
the same grammar rather than inventing a second one.

Three distinct corrections must not be collapsed:

- **vendor credit** — the vendor agrees they overcharged (this story)
- **our error** — we recognized against the wrong property or period
- **reversal** — the work was undone or the invoice withdrawn

Only the first is a new economic event dated in its own period. The second is a
correction to a prior period and is the one that makes a closed-period policy
necessary — a question for the owner, not for this document.

## 9. Cash T-12

```
month of PAYMENT (following Tuesday)
  Repairs & Maintenance — Plumbing        1,240.00

month the CREDIT clears
  Repairs & Maintenance — Plumbing         (180.00)
```

Cash T-12 needs only: payment date, amount, property, category. It does **not**
need the service date. It is the simpler report and the more misleading one —
it will show a $1,240 spike in a month where nothing broke.

## 10. Accrual T-12

```
month of SERVICE (Friday)
  Repairs & Maintenance — Plumbing        1,240.00

month the CREDIT is recognized
  Repairs & Maintenance — Plumbing         (180.00)
```

The accrual T-12 places the cost in the month the water heater failed, which is
the number an investor or lender is actually asking for.

**The unresolved question this slice surfaces and does not answer:**
the water heater was a **replacement** that **extends useful life**
(`extends_useful_life` already on the row). Under accrual treatment that may
be a **capital item, not a repair** — in which case it does not belong in R&M
on the accrual T-12 at all, and instead depreciates. Cash T-12 is unaffected.

**This is an owner decision, not a system inference** (§13).

## 11. Reusable foundations

| foundation | reuse |
|---|---|
| `operation_receipt_v1` | the envelope already carries `occurred_at` / `recorded_at` / `effective_at` separately, plus `evidence_ids`, `targets` and `canonical_destination` — built for this |
| `executed_lease_records` | **the reference pattern**: immutable, actor-attributed, object-named, `payload_hash`, separate signed/effective dates, `supersedes_record_id`. An invoice and a recognition record want this exact shape |
| `work_completion_claims` / `work_acceptances` | claim-then-confirm, already separated, already actor-attributed |
| `work_proof_attachments` | content-hashed evidence, already built |
| authority hardening | server-derived actor and property on every staff write; the refusal rule; module entitlement |
| `money_event_attributions` | allocation with explicit confirm/reject and confidence — reusable for splitting one invoice across units |
| obligation engine | "an invoice awaits confirmation" is owed work, and the engine already models owed work |

## 12. Schema gaps that would block implementation

1. **No vendor invoice object** — no source document, no line items, no invoice
   number, no terms, no hash.
2. **No service period distinct from spend date** — `money_events.occurred_on`
   is one date.
3. **No expense recognition record** — nothing to point a T-12 at.
4. **`money_events.vendor` is free text** — no `vendor_id`. A per-vendor T-12
   cannot be built from it.
5. **No vendor payment object** and no bank-transaction linkage.
6. **No credit / reversal object** on the economic side.
7. **Work-order → money lineage** exists only through
   `money_event_attributions.related_type/related_id`, which is generic and
   unproven for this path.
8. **All of it waits on migration 129**, exactly like the four receipts
   dependencies.

## 13. Open owner decisions — no rulings invented here

1. **Capital versus expense.** Does a water-heater replacement with
   `extends_useful_life = true` become a capital item on the accrual T-12? If
   so, who decides — the PM at acceptance, or a later financial review? The
   operational signal exists; the policy does not.
2. **Which T-12 is the default** for the monthly reporting package — cash,
   accrual, or both side by side?
3. **Recognition without an invoice.** If the vendor never invoices, is there
   ever an accrual? At what age does an accepted, uninvoiced work order become
   an estimated accrual — or does it never?
4. **Variance threshold.** $900 authorized, $1,240 invoiced. At what variance
   does confirmation require a second authority?
5. **Closed-period policy.** If the credit arrives after the month is reported,
   does it correct the original period or land in the current one?
6. **Tenant-caused work.** `tenant_caused` and `work_order_billback_decisions`
   already exist. Is billback a **reduction of expense** or **income**? They
   report very differently.
7. **Who may confirm an economic obligation** — any PM, or a separate financial
   entitlement? The module system supports either.
8. **Invoice as an outside claim.** A vendor invoice is the first object in
   this product asserted by a party who is not a resident and not staff. Does
   it get its own actor class, or is it always mediated by the confirming
   employee?

---

## The one-line finding

**Property Spine already records maintenance work with the exact rigour a money
layer needs — immutable claims, separate confirmations, hashed evidence,
supersession lineage — and then stops precisely where an outside party's
monetary claim enters.** The gap is not operational discipline. It is that no
object yet exists to hold a vendor's assertion about money, or to record the
moment that assertion became an obligation of the property.
