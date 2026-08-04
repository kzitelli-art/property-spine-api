# MONEY TRUTH — OWNER RULINGS 01

**Status: DESIGN DOCUMENT ONLY. No product code, no schema, no migration, no
accounting logic. Nothing here is implemented.**

Eight decisions the developer must not answer alone. Recommendations are
labelled as recommendations and never as rulings.

Every column, constraint and vocabulary cited was read from the live schema.

---

## Status vocabulary used throughout

| label | meaning |
|---|---|
| **SETTLED** | ruled by the owner; not reopened here |
| **PROVISIONAL DIRECTION** | a stated leaning that still needs confirmation |
| **OPEN OWNER DECISION** | genuinely undecided; the developer must not pick |
| **ACCOUNTING-POLICY DEPENDENCY** | needs an accountant, not a product owner |

---

# PART I — SETTLED RULINGS

These are recorded so they are not asked again.

## S1 — Reporting basis · SETTLED

```
accrual T-12   primary institutional view
cash T-12      alternate view over the SAME economic history
```

**Not two truths.** One set of economic records, read through different date
and status treatment. A design that produces a cash number the accrual view
cannot reconcile to is wrong by construction.

## S2 — Operational acceptance · SETTLED

```
work accepted  ≠  amount confirmed
               ≠  expense recognized
               ≠  cash paid
```

Acceptance proves **performance occurred**. It does not establish final
amount, vendor liability, expense classification, recognition date, or
payment.

## S3 — Corrections · SETTLED

```
original economic event REMAINS
credit / reversal / correction is a NEW event
the new event POINTS AT what it corrects
```

A recognized expense is never mutated into its corrected value. This is the
grammar `work_acceptances.supersedes_id` + `supersede_reason` and
`work_order_billback_decisions.supersedes_id` already use operationally.

## S4 — Time model · SETTLED

`occurred_at` · `recorded_at` · `effective_at` · service period · payment date
are **five separate facts**.

Invoice date is never a substitute for service date. Payment date is never a
substitute for recognition date.

## S5 — `money_events` is not the answer · SETTLED

`money_events` (0 rows) is **spend capture**, not vendor accounting authority.
Its `vendor` is free text with no `vendor_id`, which cannot support vendor
history, duplicate-invoice detection, vendor-level T-12, payments, credits or
statement reconciliation. **Not to be expanded opportunistically.**

`ledger_entries` (0 rows) is **resident-side** (`lease_id`, `kind`, `method`)
and is not the vendor-expense ledger.

## S6 — The centerline · SETTLED

The money layer does not begin at the bank transaction or the invoice upload.
It begins at a **confirmed economic obligation** that explicitly connects
performance · amount · vendor claim · property · work order · dates ·
authority.

---

# PART II — THE EIGHT DECISIONS

## Decision 1 — Capital versus expense

**Question.** When maintenance work replaces rather than repairs, who decides
whether it is an operating expense or a capital item, and when?

**Why it matters.** It is the largest single swing in the accrual T-12. A
$1,240 capitalized water heater removes $1,240 from R&M and introduces
depreciation instead. It changes NOI. Lenders and investors read that number.

### Operational signals that already exist

| signal | state |
|---|---|
| `work_orders.work_nature` | **EXISTS.** `CHECK (work_nature IS NULL OR work_nature = ANY (ARRAY['repair','replacement']))` |
| `work_orders.extends_useful_life` | **EXISTS** (boolean) |
| `work_orders.est_cost` | **EXISTS** |
| `work_orders.unit_id` / `property_id` | **EXISTS** — unit vs building scope |
| improves_capacity | **DOES NOT EXIST** |
| restores_original_condition | **DOES NOT EXIST** |
| expected useful life (years) | **DOES NOT EXIST** |
| final amount | **DOES NOT EXIST** (only the estimate) |

**Explicitly not ruled here: `extends_useful_life = true` does NOT
automatically mean capital.** A $90 door closer may extend useful life and be
trivially an expense. Capitalization turns on amount thresholds, unit-of-
account and policy — none of which the operational layer knows.

### Options

| | approach | effect |
|---|---|---|
| **A** | PM classifies at work acceptance | Fastest. Wrong actor: the PM does not know the final amount on acceptance day (S2), and classification is an accounting judgment, not an operational one. |
| **B** | PM supplies operational facts; a financial reviewer classifies | Separates what happened from how it is treated. Adds a second step and a second role. |
| **C** | Policy engine proposes from the facts; an authorized reviewer confirms | Scales; keeps the human decision. Requires a policy to exist first — which is Decision 1 itself. |

**Recommended product default (recommendation, not a ruling): B, built so C
can be added later.** The system should capture `work_nature`,
`extends_useful_life`, scope and final amount as **operational facts**, and
hold the accounting classification as a **separate, later, actor-attributed
record**. A policy change must never rewrite what physically happened.

### Water heater under each option

- **A** — PM marks "capital" on Monday, knowing only $900. Wednesday's $1,240
  may cross a threshold the PM never saw. Classification made on a number that
  turned out wrong.
- **B** — PM records: replacement, extends useful life, unit-scoped. Reviewer
  classifies after the $1,240 is confirmed. **The facts and the treatment are
  two records.**
- **C** — engine proposes "capital: replacement + extends_useful_life +
  $1,240 > threshold"; reviewer confirms or overrides with a reason.

**Status: OPEN OWNER DECISION** (product shape) **+ ACCOUNTING-POLICY
DEPENDENCY** (the threshold and unit-of-account rules).

---

## Decision 2 — Recognition before an invoice

**Question.** May an expense be recognized before the vendor's invoice arrives?

**Why it matters.** Month-end. Work performed on the 28th, invoiced on the
5th. Without a rule, the accrual T-12 is simply the cash T-12 with extra steps.

### The six scenarios

| # | scenario | what is known |
|---|---|---|
| 1 | completed, amount known (fixed-price PO) | performance + amount |
| 2 | completed, amount reasonably estimable | performance + estimate |
| 3 | completed, amount unknown | performance only |
| 4 | vendor never invoices | performance only, indefinitely |
| 5 | invoice arrives after period close | both, too late |
| 6 | invoice materially differs from estimate | both, and they disagree |

### Options and effects

| option | 1 | 2 | 3 | 4 | 5 | 6 |
|---|---|---|---|---|---|---|
| **no recognition until invoice** | defer | defer | defer | **never recognized** | prior period misstated | no variance issue |
| **estimated accrual at period close** | recognize | recognize | recognize at estimate | accrual ages forever | true-up next period | variance becomes a true-up |
| **recognition only after financial confirmation** | recognize | reviewer's call | reviewer's call | reviewer decides | reviewer decides | reviewer decides |
| **automatic aging threshold** | recognize | recognize | accrue at N days | forced accrual at N days | true-up | true-up |

Scenario 4 is the one that exposes the choice. Under "no recognition until
invoice", **an expense that genuinely occurred is never recognized at all** —
the accrual view silently understates. Under estimated accrual it is
recognized and may never be trued up, so the accrual view overstates against
cash that never moved.

**No recommendation offered.** Choosing between "possible understatement" and
"possible overstatement" is an accounting judgment.

**Status: ACCOUNTING-POLICY DEPENDENCY.** Do not choose a GAAP or tax
treatment without an explicit accounting ruling.

---

## Decision 3 — Economic-obligation authority

**Question.** Who may confirm that the property owes a vendor a specific
amount?

**Why it matters.** This is the moment a claim becomes a liability. It is also
the natural fraud surface: whoever can both accept work and confirm the
obligation can direct money.

### Three actors that may be three different people

```
confirmed work was completed   -> work_acceptances.accepted_by_user_id  EXISTS
confirmed the monetary obligation                                       MISSING
approved payment                                                        MISSING
```

Only the first exists today. The product already separates the **claimant**
from the **acceptor** (`work_completion_claims.claimed_by_user_id` vs
`work_acceptances.accepted_by_user_id`) — the pattern is established and
should extend, not be reinvented.

### Options

| | approach | effect |
|---|---|---|
| **A** | any PM may confirm | Fast. One person can accept work and confirm the amount. |
| **B** | PM proposes; financial reviewer confirms | Separation of duties. Slower on every invoice. |
| **C** | amount threshold determines authority | Proportionate. Requires Decision 5's threshold. |
| **D** | accepted work + matching invoice **auto-proposes**, never auto-confirms | Removes typing, keeps the human decision. Composes with B or C. |

**Recommended default (recommendation): D combined with C.** The system
proposes; a human confirms; the required authority scales with the amount.
**D alone is not sufficient** — auto-proposal is not approval.

The module system already supports a distinct entitlement, so "financial
reviewer" is expressible without new authority machinery.

**Status: OPEN OWNER DECISION.**

---

## Decision 4 — Vendor as an external claimant

**Question.** Is a vendor invoice modelled as a claim authored by the vendor,
or as a staff record about a vendor?

**Why it matters.** The invoice is **the first object in this product asserted
by a party who is neither a resident nor staff.** If a staff member's upload
is recorded as the assertion, the record cannot later distinguish "the vendor
billed us $1,240" from "an employee entered $1,240".

### Recommendation (stated as a recommendation)

**Two records, not one.**

```
VENDOR MONETARY CLAIM          — authored by the vendor
  vendor identity (vendor_id, NOT free text)
  invoice identity (number)
  invoice date
  service period
  amount · line items
  property · work-order lineage
  supporting document (content-hashed, as executed_lease_records already does)
  submitted_at
  recorded_by  <- the staff user who entered it on the vendor's behalf

STAFF-CONFIRMED ECONOMIC OBLIGATION — authored by staff
  points at the claim
  confirmed_by_user_id · confirmed_at
  confirmed amount (may differ from claimed)
  variance vs authorization
```

**Do not collapse the claimant and the confirming employee.** When staff
upload an invoice, both facts survive: `claimant: vendor`,
`recorded_by: staff user`.

This also gives duplicate-invoice detection a real key (`vendor_id` +
invoice number), which `money_events.vendor` as free text cannot support (S5).

**Status: PROVISIONAL DIRECTION** — the shape follows from S6 and from
existing patterns, but the owner should confirm the two-record split before
anything is designed against it.

---

## Decision 5 — Variance authority

**The concrete case.**

```
authorized estimate   $  900
vendor claim          $1,240
variance              $  340   /   37.8%
```

**Why it matters.** Without a threshold, either every invoice needs a second
approval, or none does.

### Control options

| basis | below threshold | above threshold | weakness |
|---|---|---|---|
| absolute dollars | PM confirms | second authority | $340 on $900 is serious; $340 on $40,000 is noise |
| percentage | PM confirms | second authority | 40% of $50 is nothing |
| **either** | PM confirms | second authority | catches both shapes; two numbers to maintain |
| property-specific | per property | per property | reflects real portfolio variety; more config |
| work-category | per trade | per trade | plumbing emergencies vary more than filter changes |
| capital vs operating | per treatment | per treatment | depends on Decision 1 |

**No threshold is invented here.** For illustration only, under a hypothetical
"either $250 or 20%", the water heater exceeds **both** and would require a
second authority. Under "$500 absolute only", it would not.

The emergency after-hours context matters: `work_orders.is_emergency` is
already recorded, and an emergency call-out premium is a *predictable* source
of variance. Whether emergencies get a wider threshold is part of this ruling.

**Status: OPEN OWNER DECISION.**

---

## Decision 6 — Closed-period corrections

**Question.** The $180 credit arrives three weeks later, after the month was
reported. Which period does it belong to?

### Options and effects

| option | historical T-12 | current T-12 | audit trail | sign-off | lender reporting |
|---|---|---|---|---|---|
| **reopen and restate** | changes | unchanged | intact if append-only | **invalidated** | a number already sent changes |
| **current period + prior reference** | unchanged | carries the credit | intact | preserved | stable; current month slightly distorted |
| **threshold-based** | changes only if material | " | intact | preserved for immaterial | materiality must be defined |
| **never reopen after sign-off** | never changes | always carries it | intact | absolute | maximum stability, least accuracy |

**The tension.** Restating is more *accurate*; not restating is more
*trustworthy*. A lender who receives a package and later sees different
numbers for the same month loses confidence in every package.

Property Spine's own doctrine leans toward option 2 or 4: the monthly
reporting package is generated **after a human presses GENERATE**, which makes
it an issued artifact, and issued artifacts are not silently revised.

**Recommended default (recommendation): current period with an explicit
prior-period reference**, so both the correction and its origin are visible.

**Do not implement period close yet.** This ruling defines what close must
later mean; it does not build it.

**Status: OPEN OWNER DECISION + ACCOUNTING-POLICY DEPENDENCY** (materiality).

---

## Decision 7 — Tenant-caused billback

**Question.** The resident broke it. We paid the vendor and charge the
resident. How does that appear?

**Why it matters.** Three presentations produce three different NOIs from
identical facts.

### Two economic events that must stay distinct

```
vendor expense      property owes the vendor
resident obligation resident owes the property
```

**The operational system must not net these before the reporting policy is
chosen.** Netting is a reporting decision made at read time, not a recording
decision made at write time.

### Presentation options

| presentation | effect on the accrual T-12 |
|---|---|
| **other income** | R&M shows the full $1,240; income line grows. Both gross figures visible. Overstates R&M as an operating cost. |
| **expense recovery** | a separate recovery line offsets R&M. Both visible, adjacent. |
| **contra-expense** | R&M nets to $0 for a fully recovered item. Cleanest NOI; hides that work occurred and was paid for. |

### What already exists

`work_orders.tenant_caused` (boolean) and `work_order_billback_decisions`
with `decision ∈ {bill_back, do_not_bill_back}`, `amount_cents`,
`actor_user_id`, `supersedes_id`, and `entry_kind ∈ {decision, correction,
dispute}` — **including a resident dispute path** (`entry_kind='dispute'`
requires `actor_person_id`, not a user).

The operational half is genuinely well modelled. What is missing is the link
onward:

```
work order -> vendor expense -> billback decision -> resident charge -> collection
              MISSING                                MISSING           MISSING
```

**Status: OPEN OWNER DECISION** (presentation) **+ ACCOUNTING-POLICY
DEPENDENCY** (whether recovery may be netted).

---

## Decision 8 — Monthly-package presentation

**Question.** What does the operator see, given S1?

### Proposed read — described, not built

```
Accrual T-12                     primary
Cash T-12                        alternate, same records
Variance between them            the reconciliation, not a third truth
Unpaid recognized obligations    recognized, not yet paid
Uninvoiced accruals              performed + accepted, no invoice (Decision 2)
Late invoices and corrections    arrived after their service period
Capital items                    excluded or presented separately (Decision 1)
```

The **variance panel is the honest centre**: it explains why the two views
differ instead of leaving the operator to wonder which number is real.

### The water heater at every stage, both views

| stage | date | accrual T-12 | cash T-12 |
|---|---|---|---|
| work authorized | Fri | — | — |
| **service performed** | **Fri** | pending recognition | — |
| work accepted | Mon | pending recognition | — |
| invoice received | Wed | pending confirmation | — |
| **obligation confirmed** | Wed | **$1,240 in Friday's month** | — |
| cash paid | next Tue | unchanged | **$1,240 in Tuesday's month** |
| credit issued | +3 wks | **−$180** (Decision 6 sets the period) | — |
| credit clears | later | unchanged | **−$180** in that month |

Two rows deserve emphasis:

- Recognition on **Wednesday** lands in **Friday's month**. Recorded and
  effective are different dates (S4), and this is the whole reason.
- The cash view shows a $1,240 spike in a month where nothing broke.

If Decision 1 rules **capital**, the accrual row moves out of R&M entirely and
the cash row does not change.

**Do not design the complete financial statement package.**

**Status: PROVISIONAL DIRECTION** — the panel list follows from S1; the
content of each panel depends on Decisions 1, 2 and 6.

---

# PART III — SUMMARY

## Recommended sequence for owner rulings

Ordered by what unblocks the most.

| order | decision | why first |
|---|---|---|
| **1** | **D4 — vendor as external claimant** | Every other decision needs an object to attach to. Nothing can be designed until the claim/confirmation split is ruled. |
| **2** | **D3 — economic-obligation authority** | Defines the recognition moment's actor. S6 names this as the centerline. |
| **3** | **D2 — recognition before invoice** | Determines whether the accrual view is real or is cash with extra steps. Needs an accountant. |
| **4** | **D1 — capital versus expense** | Largest T-12 swing. Needs D2's recognition point to exist first. |
| **5** | **D5 — variance authority** | Refines D3. Cannot precede it. |
| **6** | **D7 — billback presentation** | Independent of 1–5; can run in parallel. |
| **7** | **D6 — closed-period corrections** | Needs recognition (D2) to exist before "late" has meaning. |
| **8** | **D8 — package presentation** | Reads everything above. Last by necessity. |

## Designable after D4 + D3

```
vendor monetary claim object     vendor_id, invoice identity, service period,
                                 amount, line items, hashed document,
                                 work-order lineage, submitted_at, recorded_by
confirmed economic obligation    points at the claim, confirmed_by, confirmed
                                 amount, variance, supersession lineage
work-order-to-money lineage      the join the T-12 needs
vendor identity in money         replacing free-text vendor (S5)
```

## Must remain undefined until their rulings land

```
expense recognition record       shape depends on D2 and D1
capital classification record    D1
payment object                   D3's third actor
credit / reversal object         D6's period rule
billback presentation            D7
period close                     D6
T-12 projections                 D8
chart of accounts                not in scope at all
```

## Accounting-policy dependencies — an accountant, not a product owner

```
D2  recognition timing and estimated accruals (GAAP / tax)
D1  capitalization thresholds and unit-of-account
D6  materiality for restatement
D7  whether expense recovery may be netted
```

## Cross-references

Everything here waits behind the same wall as the receipts work. The four
schema dependencies in `RECEIPTS_PACKET_FROZEN.md` and every object above are
blocked by **migration 129**. The money objects add a fifth family and must
not be merged into the other four — a vendor claim object is not an
access-path fix.

`operation_receipt_v1` already carries `occurred_at` / `recorded_at` /
`effective_at` separately, plus `evidence_ids` and `canonical_destination`. It
was built for exactly this and is reusable without change.

---

**No product code. No schema. No migration. No accounting logic.
The next conversation is an owner decision conversation, not a build packet.**
