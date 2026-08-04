# MONEY TRUTH — CANONICAL OBJECTS 01

**Status: DESIGN ONLY. No product code, no schema, no migration, no accounting
recognition. Nothing here is implemented.**

Designs only the objects the owner rulings now support. Stops at the confirmed
economic obligation and goes no further.

**Deliberately NOT designed here:** expense recognition entry · payment object
· general ledger posting · chart of accounts · capitalization engine · period
close · T-12 implementation.

Every existing column, constraint and vocabulary cited was read from the live
schema.

---

## The governing shape

```
accepted work  →  vendor claim  →  proposed obligation  →  variance review
               →  confirmed economic obligation  ‖  STOP
```

Two rulings set the spine:

- **D4** — the invoice is **two records**. A vendor authors a claim; staff
  confirm an obligation. Never one record wearing both hats.
- **D3** — **property staff propose, a financially entitled user confirms.**
  Operational acceptance is never the financial confirmation.

---

# 1 — VENDOR IDENTITY

**Purpose.** Replace `money_events.vendor` (free text) with a real referent, so
vendor history, duplicate-invoice detection and vendor-level reporting are
possible at all (S5).

**Canonical identity.** `vendors.id` — **already exists.**
`vendors(id, name, trade, phone, email, preferred, insurance_status, note,
multi_nature, created_at)`.

**Authority.** Vendor records are operational reference data, created by staff.
A vendor is not an actor in the authority system — it authors claims, it does
not operate the product.

**Required lineage.** None upward. Vendors are referenced, not owned by a
property; `vendor_property_categories` already expresses per-property trade
scoping.

**What is missing for money.** Nothing structural. `vendors` is adequate as an
identity today. The gap is that **no money object references it** — the money
layer must use `vendor_id`, never a name string.

**Relationship to operational truth.** `work_orders.vendor_id` already links
work to vendor. That link is the seam the money layer inherits.

**Relationship to future recognition.** A per-vendor accrual T-12 is only
possible through this identity. Free text cannot be grouped, deduplicated, or
reconciled to a statement.

**Correction behaviour.** Vendor *identity* corrections (a renamed company, a
merged duplicate) must never rewrite the vendor referenced by a historical
claim. A superseding vendor record points at the one it replaces; existing
claims keep pointing where they pointed.

---

# 2 — VENDOR MONETARY CLAIM

**Purpose.** Record that **the vendor asserts the property owes an amount.** A
claim, not an obligation. Nothing about this record means the property owes
anything (D4).

**Canonical identity.** A claim id. **Not** the invoice number — invoice
numbers are the vendor's namespace, they collide across vendors, and vendors
reissue them.

**Authority.**

```
claimant     the VENDOR          (vendor_id — the asserting party)
recorded_by  staff user OR integration  (who entered it on the vendor's behalf)
```

**These are two fields and must never be collapsed.** A staff member uploading
an invoice is not the claimant. Without both, "the vendor billed us $1,240" is
indistinguishable from "an employee entered $1,240" — and the $180 error in the
worked example is exactly the case where that distinction decides who was
wrong.

**Required lineage.**

```
vendor_id        (never a name string)
property_id      the property the claim is against
work_order_id    the work claimed for — the operational anchor
unit_id          where applicable
```

**Amount fields.** Claim total; line items (description, amount, and each
item's own service period where the vendor states one). Line items matter
because the $180 after-hours call-out was a *line*, and the credit reversed
that line, not the invoice.

**Date fields.**

```
invoice_date              the vendor's document date — NEVER the expense date
service_period_asserted   what the VENDOR says the work covers
submitted_at              when the claim reached us
recorded_at              when Property Spine wrote it down
```

`invoice_date` and `service_period_asserted` are **the vendor's assertions**,
and may disagree with the operational record. Preserving both is what makes
the disagreement visible instead of silently resolved.

**Evidence.** The invoice document, **content-hashed**. The pattern already
exists twice — `work_proof_attachments.sha256` and
`executed_lease_records.document_sha256`. An outside party's monetary claim
without a hashed document is an unverifiable assertion.

**Status lifecycle.**

```
received  →  proposed  →  confirmed
                      →  disputed
                      →  withdrawn (by the vendor)
                      →  superseded (by a corrected claim)
```

Terminal only via confirmed / withdrawn / superseded. **`disputed` is not
terminal** — a dispute resolves somewhere.

**Immutable history.** The claim is **write-once**. A vendor who reissues
submits a *new* claim that supersedes the first. We do not edit what a vendor
said.

**Correction behaviour.** `supersedes_claim_id` + reason — the same grammar as
`work_acceptances.supersedes_id` / `supersede_reason` and
`work_order_billback_decisions.supersedes_id`. Three cases stay distinct:
vendor reissues · vendor credits (a **new claim with a negative amount**, not
an edit) · we recorded it wrong (a correction attributed to staff, not to the
vendor).

**Relationship to operational truth.** It points at the work order. It asserts
nothing about whether the work was performed — `work_completion_claims` and
`work_acceptances` already hold that, and the confirmation step is where the
two meet.

**Relationship to future recognition.** A claim is **never** recognizable on
its own. Recognition needs the confirmation (§3), and whether it may precede a
claim at all is D2 — still an open accounting-policy dependency.

---

# 3 — CONFIRMED ECONOMIC OBLIGATION

**Purpose.** The centerline (S6). The record that says **the property owes this
amount, to this vendor, for this work, for this service period, confirmed by
this authority.**

**This is where the money layer begins.** Not the bank transaction, not the
invoice upload.

**Canonical identity.** An obligation id — durable, immutable, and the natural
`receipt_id` under `operation_receipt_v1`.

**Authority (D3).**

```
proposed_by_user_id   property staff — captured, connected, explained
confirmed_by_user_id  a FINANCIALLY ENTITLED user
```

Distinct from the two operational actors that already exist:

```
work_completion_claims.claimed_by_user_id    performed the work
work_acceptances.accepted_by_user_id         confirmed performance
[this]     confirmed_by_user_id              confirmed the obligation
[later]    payment authorization             released the money
```

**Four potentially different people.** The product already separates the first
two; this adds the third and reserves the fourth. Operational acceptance is
never the financial confirmation.

**Required lineage.**

```
vendor_claim_id     the accepted claim (§2)
work_order_id       the work
work_acceptance_id  the PERFORMANCE proof — the other half of recognition
property_id · unit_id
```

Naming the acceptance explicitly is what makes the record self-proving: it
holds **confirmed performance** and **confirmed amount** together, which §5 of
the vertical slice identified as the two halves recognition requires.

**Amount fields.**

```
confirmed_amount        may DIFFER from the claim
authorized_estimate     from work_orders.est_cost
variance_absolute       confirmed − authorized
variance_percent
variance_reason         required when a threshold is crossed
```

Storing the variance rather than recomputing it preserves what the confirmer
actually saw. A later change to `est_cost` must not silently rewrite history.

**Date fields.**

```
service_period_confirmed  the ACCRUAL date — derived from the operational
                          record, not from invoice_date
confirmed_at              when the authority confirmed
recorded_at               when written
```

**The invoice date is not the expense date** (S4). The service period is
confirmed from `work_completion_claims.claimed_at` and the acceptance, and the
vendor's asserted period is retained on the claim for comparison.

**Evidence.** The vendor claim's hashed document, the acceptance, and
`work_proof_attachments` for the work itself. Plus a payload hash over the
material confirmed facts — the `executed_lease_records.payload_hash` pattern,
which makes a replayed confirmation provably the same confirmation.

**Status lifecycle.**

```
proposed  →  awaiting_variance_authority  →  confirmed
                                          →  rejected
          →  confirmed  (no threshold crossed)
                        →  superseded (corrected)
                        →  reversed  (credit / reversal)
```

**Classification status.** Held here as a **separate, nullable, later-set
field** (D1):

```
classification            unclassified | operating_expense | capital
classified_by_user_id     a financial reviewer, NOT the accepting PM
classified_at
classification_basis      the policy applied
```

`unclassified` is the honest initial value. **`extends_useful_life = true` sets
no classification automatically.** The operational facts live on
`work_orders` (`work_nature ∈ {repair, replacement}`, `extends_useful_life`,
scope) and are never rewritten by a classification change — so a later policy
revision reclassifies without altering what physically happened.

**Immutable history.** Write-once. Confirmation is not edited.

**Correction behaviour.** `supersedes_obligation_id` + `correction_reason`, plus
the correcting actor and evidence (D6). The original recognized obligation
remains. A credit is a **new economic event pointing at what it corrects**,
carrying its own occurred / recorded / effective dates.

The source must support **both** reporting treatments — current-period
correction with a prior-period reference, and formal prior-period restatement —
without either being baked in. Which applies is materiality and accounting
policy, still open.

**Relationship to future recognition.** This object is the **input** to
recognition, not recognition itself. Whether and when a recognition entry is
created from it is D2, unruled. The object must be designable and storable
before that question is answered — which is precisely why the packet stops here.

---

# 4 — WORK-ORDER-TO-MONEY LINEAGE

**Purpose.** The join a T-12 reads, and the chain an auditor follows.

```
work_order
  → work_completion_claims        performance claimed        EXISTS
  → work_acceptances              performance confirmed      EXISTS
  → work_proof_attachments        hashed evidence            EXISTS
  → vendor_monetary_claim         amount claimed             NEW (§2)
  → confirmed_economic_obligation amount confirmed           NEW (§3)
  ‖ STOP — recognition, payment and reporting are not designed
```

**Direction matters.** Each money object **points at** the work order; the work
order does not point forward. Operational truth must not acquire a dependency
on a money layer that does not exist yet, and a work order with no money is a
perfectly valid work order.

**Cardinality — the cases the design must survive.**

| case | shape |
|---|---|
| one work order, one invoice | 1 → 1 |
| one invoice, several work orders | 1 claim → many work orders, allocated |
| one work order, several invoices | many claims → 1 work order (deposit + balance) |
| invoice with no work order | claim with no operational anchor — **must be refusable or explicitly flagged** |

`money_event_attributions` already models allocation with
`allocated_amount_cents`, confidence scoring and explicit confirm/reject. That
pattern is reusable for the many-to-many case and should not be reinvented.

The fourth row is a real governance question, not an edge case: an invoice with
no work order is an assertion with no operational corroboration.

**Not designed here.** Allocation *policy* across multiple work orders.

---

# 5 — ECONOMIC AUTHORITY MODEL

**Purpose.** Express D3 without inventing new authority machinery.

**Reuse, do not rebuild.** The existing module entitlement system already
carries per-property `allowed_modules`, and the authority-hardening packet
already derives actor and property from the session and refuses body-supplied
authority. A `financial` entitlement is expressible today.

**The four authorities, and what each may do.**

| authority | may |
|---|---|
| operational (existing leasing/maintenance) | create work orders, claim completion, accept work, capture invoices, **propose** obligations, explain variance |
| **financial** (new entitlement) | **confirm** economic obligations, classify capital vs operating |
| **variance** (D5) | confirm obligations above a governed threshold |
| **payment** (reserved) | authorize release of funds — **not designed here** |

**Ruled out.** Operational acceptance is never automatically financial
confirmation. Auto-proposal from a matched claim + acceptance is permitted;
**auto-confirmation is not** (D3, option D).

**Left open.** Limited property-level financial authority below governed
thresholds — the owner reserved this for a later design and it is not built in.

**Relationship to operational truth.** The financial confirmer reads the
operational record; they do not amend it. If the work was not accepted, that is
a fact to confront, not a field to fix.

---

# 6 — VARIANCE AND CONFIRMATION STATE

**Purpose.** Make the gap between what was authorized and what is claimed
**explicit and routed** (D5), without inventing thresholds.

**The worked case.**

```
authorized estimate  $  900     work_orders.est_cost
vendor claim         $1,240     vendor_monetary_claim
variance             $  340  /  37.8%
```

**What the object holds.** Absolute variance, percentage variance, the
threshold rule that was evaluated, the outcome, and — when a threshold is
crossed — a required reason and the escalated authority.

**What it does not hold.** The thresholds themselves. Those are **governed
policy** (D5), configurable by property, portfolio, work category, and
operating-versus-capital treatment. Until they are supplied, **variance routing
is a policy dependency, not executable logic** — the system records and
displays the variance and routes nothing automatically.

**Recording the rule that ran.** When thresholds exist, the obligation stores
*which rule was applied at confirmation time*, not merely its result. A later
threshold change must not make a historical confirmation look wrongly approved.
This is the same principle as
`leasing_conversion_obligation_events.identity_resolution_basis`: capture the
basis as it stood, never as it reads today.

**Emergency context.** `work_orders.is_emergency` already exists and an
after-hours premium is a *predictable* variance source. Whether emergencies get
a wider threshold is part of D5, unruled.

---

# 7 — CORRECTION AND SUPERSESSION RELATIONSHIPS

**Purpose.** One grammar across every money object, matching the operational
grammar already in use (S3).

**The existing precedents.**

```
work_acceptances                supersedes_id + supersede_reason
work_order_billback_decisions   supersedes_id, entry_kind ∈
                                {decision, correction, dispute}
executed_lease_records          supersedes_record_id
```

`work_order_billback_decisions` is the strongest model in the codebase for this
and should be followed rather than paraphrased. Its `dispute` path requires
`actor_person_id` rather than `actor_user_id` — **a resident dispute is
authored by the resident, not by staff.** That same distinction is exactly what
D4 requires for vendors: an external party authors its own assertion.

**The rules.**

1. **Never mutate.** The original claim or obligation stays exactly as
   recorded.
2. **Always point.** A correction names what it corrects.
3. **Always attribute.** Correcting actor, reason, evidence, and its own
   occurred / recorded / effective dates.
4. **Keep the kinds distinct** — do not collapse:
   - **vendor credit** — the vendor agrees they overcharged (a new claim with a
     negative amount)
   - **vendor reissue** — a corrected invoice supersedes the original
   - **our error** — we recorded or confirmed wrongly (attributed to staff)
   - **reversal** — the work was undone or the claim withdrawn

Only the first is a new economic event dated in its own period. The others have
different reporting consequences, and collapsing them into "correction" loses
the distinction a period-close policy will need.

---

# 8 — THE WATER HEATER, END TO END

Stops at the confirmed economic obligation.

| # | stage | object | actor | key facts |
|---|---|---|---|---|
| 1 | work authorized | `work_orders` ✅ | PM | est_cost $900 · is_emergency · vendor_id |
| 2 | work performed | `work_completion_claims` ✅ | technician | claimed_at **Fri 18:35** · photos |
| 3 | evidence | `work_proof_attachments` ✅ | technician | 2 photos, sha256 |
| 4 | **work accepted** | `work_acceptances` ✅ | **PM** | accepted_at **Mon 09:15** · proof_satisfied |
| 5 | **vendor claim** | **§2 NEW** | **claimant: vendor** / recorded_by: PM | $1,240 · invoice date **Wed** · line items incl. $180 after-hours · hashed PDF |
| 6 | **proposed obligation** | **§3 NEW** | proposed_by: PM | links claim + acceptance + work order |
| 7 | **variance review** | **§6 NEW** | routed by policy | $340 / 37.8% · reason required |
| 8 | **confirmed obligation** | **§3 NEW** | **confirmed_by: financial authority** | confirmed $1,240 · **service period FRIDAY** · confirmed_at Wed · classification `unclassified` |

**‖ STOP.**

Everything after — expense recognition, the payment, the $180 credit's economic
event, and both T-12 views — is deliberately not designed.

Three things the walk-through makes concrete:

- **Row 4 to row 8 is four steps and two authorities.** Acceptance is Monday;
  confirmation is Wednesday; they are different people and different facts (S2).
- **Row 8 carries Friday.** Confirmed Wednesday, effective Friday. That single
  divergence is the reason `occurred_at` / `recorded_at` / `effective_at` were
  kept apart in `operation_receipt_v1` (S4).
- **Row 8's classification is `unclassified`.** The water heater is a
  `replacement` that `extends_useful_life` — and the system says so plainly
  without concluding anything, because D1's thresholds do not exist yet.

---

# 9 — REUSE, AND WHAT REMAINS BLOCKED

**Reusable without change**

| foundation | reuse |
|---|---|
| `operation_receipt_v1` | three date fields, `evidence_ids`, `targets`, `canonical_destination` — built for exactly this |
| `executed_lease_records` | the reference shape: immutable, actor-attributed, object-named, `payload_hash`, separate dates, supersession |
| `work_completion_claims` / `work_acceptances` | claim-then-confirm, already separated and attributed |
| `work_proof_attachments` | hashed evidence |
| `vendors` / `vendor_property_categories` | vendor identity and per-property trade scoping |
| `money_event_attributions` | allocation with confidence and explicit confirm/reject |
| module entitlement + authority hardening | the financial entitlement, and server-derived actor and property |
| obligation engine | "an invoice awaits confirmation" is owed work |

**Blocked**

Every object in §§2, 3, 4, 6 requires new tables. All wait on **migration
129**, as a **fifth dependency family** alongside the four in
`RECEIPTS_PACKET_FROZEN.md` — and must not be merged into them. A vendor claim
object is not a tour access-path fix.

**Still open, and not to become software defaults**

```
estimated-accrual policy (D2)   capitalization threshold and unit of account (D1)
variance thresholds (D5)        restatement materiality (D6)
billback presentation and netting (D7)   period-close and reopening rules (D6)
```

---

**No product code. No migration. No accounting recognition implementation.
No Slice 10 changes.**
