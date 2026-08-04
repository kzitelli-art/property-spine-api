# MONEY TRUTH — ACCOUNTING QUESTIONS (ARCHIVE)

> ## ⚠ EXPLORATORY — ARCHIVED, NOT A PACKET
>
> ```
> EXPLORATORY DESIGN
> NOT AN OWNER RULING
> NOT AN ACCOUNTING POLICY
> NOT AN IMPLEMENTATION CONTRACT
> NOT TO BE SENT TO AN ACCOUNTANT IN THIS FORM
> ```
>
> **Provenance, stated plainly.** This began as a formal accountant decision
> packet, written 2026-08-05 and **stood down before it was ever committed**,
> because issuing it would have implied the product model was settled and only
> accounting treatment remained open. It is not settled.
>
> It is restored here **only so the thinking is not lost**. It is reconstructed
> from the original draft and is not a byte-identical recovery — the first
> version was deleted before any commit, so no exact copy exists in git.
>
> **Read it as a list of things that will eventually need asking, not as a set
> of questions we are ready to ask.** The product-boundary questions in
> `MONEY_INTEGRATION_DISCOVERY_QUESTIONS.md` come first and may change or
> eliminate several of these entirely.

---

## Why it was stood down

The packet was structured as *"the product model is decided; only accounting
treatment is open."* That framing was wrong. We had not yet decided:

- what role Property Spine should play in accounting at all
- whether vendor invoices originate inside or outside the system
- whether payments happen inside Spine
- whether an outside accounting platform stays authoritative
- how institutional customers actually close their books today

Asking an accountant to rule on capitalization thresholds before knowing
whether the system even holds a monetary amount would have produced answers to
the wrong questions — and worse, would have made those answers feel binding.

**The sequence matters more than the content.** Product boundary first,
accounting policy second.

---

## The working example these questions were built around

**Unit 4B water heater, replaced on an emergency call-out.**

| | |
|---|---|
| Fri 14:10 | resident reports no hot water; work order created, `is_emergency = true` |
| Fri 14:40 | PM authorizes; `est_cost` **$900** |
| **Fri 18:20** | **plumber replaces the water heater — a replacement, not a repair** |
| Fri 18:35 | technician claims completion, two photos attached |
| Mon 09:15 | PM **accepts** the work |
| **Wed** | **vendor invoices $1,240** — includes a **$180 after-hours call-out** and a heater one size larger than quoted |
| following Tue | **$1,240 leaves the operating account** |
| +3 weeks | **vendor issues a $180 credit** — the after-hours fee was charged in error |

Assume Friday and the following Tuesday fall in **different calendar months**.
That is the ordinary month-end case, and it is where every question below
bites.

---

## The seven question areas, preserved

Each is recorded as *an area that will need a ruling if the product ever takes
on that responsibility* — not as a question we are ready to ask.

### A — Recognition before an invoice

**The situation.** At month end: performance is proven (immutable completion
claim, immutable acceptance, hashed photos). The amount is not known. In the
general case it may never be known, because some vendors never invoice.

**Treatments that would need choosing between:** no recognition until an
invoice exists · estimated accrual at period close · recognition only on
financial review · age-triggered accrual at N days after acceptance.

**The observation worth keeping.** Under *no recognition until invoice*, work
that genuinely occurred and was never invoiced is **never recognized at all** —
the accrual view understates, and does so invisibly. The alternative
overstates. Choosing between a possible understatement and a possible
overstatement is an accounting judgment, and no recommendation was offered.

**Cash view is unaffected by any option here** — the payment lands in the
following Tuesday's month regardless. That is the cleanest illustration that
two views can read the same records and differ only in date and status
treatment.

### B — Estimated accruals and reversals

Applies only if A permits accrual at all.

**The observation worth keeping.** The estimate was **27.4% low** — because
emergency call-out premiums are systematically excluded from estimates. If
estimated accruals are ever used, the estimating basis for
`is_emergency = true` work is a distinct question: the premium is predictable
*in kind* and unpredictable *in amount*.

**Treatments that would need choosing between:** reverse in full and
re-recognize · recognize only the difference · policy-adjusted estimate ·
accrue only where *reasonably estimable*, judged per case.

### C — Capitalization threshold and unit of account

**What the operational layer already knows** — read from the live schema:

| fact | source | value here |
|---|---|---|
| repair or replacement | `work_orders.work_nature` — `CHECK (repair \| replacement)` | **replacement** |
| extends useful life | `work_orders.extends_useful_life` | **true** |
| scope | `work_orders.unit_id` / `property_id` | **unit-level** |
| description | `work_orders.description` | free text |

**What it does not know.** Expected useful life in years · original component
basis · any threshold · any unit-of-account rule. `improves_capacity` and
`restores_original_condition` **do not exist as fields**.

**The observation worth keeping.** Under a **building-level unit of account**,
replacing one water heater is maintaining the building, not creating an asset
— and `extends_useful_life = true` (true of the *heater*) becomes irrelevant to
the treatment. That is the answer that most often surprises, and it is why
`extends_useful_life = true` was never allowed to imply capital.

**Impact if it ever matters:** expensed → $1,240 in R&M in Friday's month.
Capitalized → $0 in R&M, an asset, depreciation. **Cash view identical either
way** — capitalization is invisible to cash.

### D — Variance thresholds and escalation

```
authorized estimate  $  900
vendor claim         $1,240
variance             $  340  /  37.8%
```

**The observation worth keeping.** The $340 decomposes into a **$180
after-hours premium** (a rate premium, a known category) and **$160 of larger
equipment** (a scope change). Those are different kinds of overage and might
warrant different escalation. The invoice line items make the decomposition
available — *if* the system ever captures line items.

Variance authority is a **control, not a measurement**: it changes who
approves, not what is reported. Which is why it is cheap to rule and expensive
to leave unruled.

**No thresholds were invented.** For orientation only: under a hypothetical
"$250 or 20%", this crosses both. Under "$500 absolute", it crosses neither.

### E — Closed-period corrections and restatement materiality

**The observation worth keeping.** $180 on a $1,240 item is **14.5% of the
transaction** — and likely immaterial against a month's total R&M. The
transaction-level and period-level materiality tests **give different answers**,
which is itself part of any eventual ruling.

The fact that changes the answer is whether Friday's month was **issued to a
lender**. Property Spine happens to know this: a reporting package is generated
only after a human presses GENERATE, so "issued" is a real recorded state
rather than an inference.

**The tension worth keeping.** Restating is more *accurate*. Not restating is
more *trustworthy*. A lender who receives a package and later sees different
numbers for the same month loses confidence in every package.

**Cash view has no periods to reopen** — only dates.

### F — Billback presentation and permitted netting

**What already exists, and it is the strongest model in the codebase:**
`work_orders.tenant_caused` · `work_order_billback_decisions` with
`decision ∈ {bill_back, do_not_bill_back}`, `amount_cents`, `actor_user_id`,
`supersedes_id`, and `entry_kind ∈ {decision, correction, dispute}` — **the
dispute path requiring `actor_person_id`, so a resident dispute is authored by
the resident, not by staff.**

**What does not exist.** The chain `billback decision → resident charge →
collection`. So the system currently cannot distinguish *recovered* from
*merely billed*.

**The observation worth keeping.** Three presentations — other income, expense
recovery, contra-expense — produce the **same NOI** and three different R&M
figures. Contra-expense is cleanest and hides that a $1,240 repair occurred,
which matters when R&M per unit is the metric being judged. And under
contra-expense, an **uncollected** billback would net to zero an expense the
property actually bore.

### G — Monthly-package inclusion rules

Questions that would eventually need answering: whether uninvoiced accruals get
their own line · whether unpaid recognized obligations are disclosed · whether
capital items appear on the operating statement at all · whether late invoices
and corrections are flagged or silently included · whether the cash-to-accrual
variance is required or optional · gross or net billbacks · **and whether a
zero must be shown explicitly.**

**The observation worth keeping.** That last one is a product-doctrine question
as much as an accounting one: an omitted section and a genuinely-zero section
look identical to a reader, and this product's doctrine is that **honest blank
beats confident wrong**.

---

## The dependency map, preserved as a sketch

Useful as a picture of where the transitions sit. **Every label below is a
candidate, not a status** — the whole map is downstream of the product-boundary
question.

```
vendor monetary claim
  ▼
confirmed economic obligation        ← candidate: where recognition input sits
  ▼
accounting classification            ← candidate: separate, later, own reviewer
  ▼
expense recognition                  ← not designed; policy-dependent
  ▼
payment                              ← not designed
  ▼
correction                           ← candidate: append-only, four kinds
  ▼
T-12 reads                           ← not designed; policy-dependent
```

## The one structural observation worth carrying forward

**Recording and treatment are separable.**

Every candidate object in the exploratory work records a *fact* and attributes
it — who claimed, who confirmed, when, against what, with what evidence. None
of them assigns an accounting *treatment*.

That separation is why the exploratory objects survived the accounting exercise
without contradiction, and it is probably the most durable thing in all of this
work — it would hold under almost any answer to the product-boundary question,
including "Spine is not the accounting system."

Whether the specific objects are right remains entirely open.
