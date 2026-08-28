# Standing Economic Obligations — Source Read

**2026-08-11. Read-only. No schema, no code, no design.**
**Against API `main` @ `d726188`.**

## The question this answers

> Of the standing economic obligations we already designed and onboarded, which
> ones are represented durably enough today to generate a **dated accrual
> schedule without re-entry**?

## Why it is being asked

Cash timing and economic recognition timing are different, and the second is the
foundation of accrual → budget → actual-vs-budget → T-12 → NOI → reporting →
owner explanation.

```text
a $120,000 insurance premium paid once in January
  economically belongs ~$10,000 to each month of the coverage period

taxes paid quarterly or semi-annually
  belong across the applicable tax period

debt interest accrues per the instrument
  cash settlement follows the payment schedule

rent is earned on the lease schedule
  not when the ACH lands
```

This is `PHILOSOPHY.md` §39 — *cash and accrual are two readings of one economic
history, not two realities to reconcile.*

## Scope of this read — what was and was not looked at

**Looked at:** all 158 migration files, the whole of `src/`, and `server.js`.
Category absence was verified by **targeted per-term search**, not by skimming a
table list.

**Not looked at:** production, anything over HTTP, the app repo, and any harness
as a run rather than as a file.

---

## THE ANSWER: one of twelve

**Exactly one — base rent — is represented durably enough today to generate a
dated accrual schedule without re-entry. And it is flat-rent-only.**

| standing obligation | governed record | amount / rate | period basis | generable? |
|---|---|---|---|---|
| **Base rent** | `leases` | `rent` | `start_date` / `end_date` | **YES — flat only** |
| Rent escalations / step-ups | — | — | — | no |
| Recurring charges (parking, pet, wifi) | — | — | — | no — *repo self-grades* |
| Free rent / concession amortization | — | — | — | no |
| Senior debt | **none** | — | — | no |
| Mezzanine debt | **none** | — | — | no |
| Preferred equity | **none** | — | — | no |
| Property / RE taxes | **none** | — | — | no |
| Jurisdictional taxes | **none** | — | — | no |
| Insurance (property / liability / umbrella) | **none** | — | — | no |
| Management fees | **none** | — | — | no |
| Payroll allocations | **none** | — | — | no |
| Recurring contracts | **none** | — | — | no |
| Utilities (governed schedule) | **none** | — | — | no |

Per-term search across all 158 migrations, `create table` matches:

```text
loan 0 · debt 0 · note_ 0 · mortgage 0 · amortization 0 · escrow 0
tax 0 · insurance 0 · policy 0 · premium 0
management_fee 0 · payroll 0 · contract 0 · utility 0
```

**Not one table on the liability side.**

---

## The structural reason

**Deal Setup onboards FILES, not TERMS — for everything except the rent roll.**

```text
source_artifacts.artifact_kind      check in ('rent_roll', 'other')

deal_intake_files.source_category   check in ('seller_material',
                                    'buyer_workpaper','third_party_report',
                                    'closing_legal','operating_setup','unknown')

deal_intake_files.detected_document_type   text, default 'unknown', NO vocabulary
classification_basis                       'filename' | 'path' | 'model' | 'human'
```

A loan agreement uploads as `artifact_kind='other'`, `source_category='closing_legal'`.
It is retained — bytes, sha256, scope, all durable. **And nothing is extracted
from it.**

**The rent roll is the only document type in the repo with a field map.**
`src/onboarding/rent_roll_field_map.js` turns headers into canonical fields:

```text
actual_rent · market_rent · lease_from · lease_to · deposit · balance
move_in · move_out · unit_number · space_label · unit_type · name · status · sqft
```

There is no `loan_field_map`, no `tax_bill_field_map`, no `insurance_field_map`.

So `CLAUDE.md` is exactly right, and now measured:

> *"Legal entities, ownership and debt structure are a **later** onboarding stage
> that reads them from org charts, loan documents and operating agreements."*

**That stage has not been built.** The economic calendar's entire liability side
is downstream of an onboarding step that does not exist yet.

---

## What IS generable today, precisely

**Base rent, monthly, flat.** And the accrual primitive is already built.

### `scheduled_charges` (migration 036) already separates economic period from cash timing

```text
period       date NOT NULL   "the month the charge is FOR, as the 1st of that
                              month (2026-06-01 = June 2026). One grain for aging."
due_date     date            when it was / is due
amount       numeric(14,2)
amount_paid  numeric(14,2)   balance = amount - amount_paid
source       lease | rent_roll | import | manual      + source_ref
```

**This is cash-vs-accrual as two readings of one history, already in the schema.**
It does not need inventing on the revenue side.

### It is safely re-runnable

```sql
uq_scheduled_charges_lease_period_type
  unique (lease_id, period, charge_type) where lease_id is not null
```

Generating June rent twice is refused by the database, so a schedule generator
can re-run without double-billing.

### It can already hold a property-level obligation

`property_id` is `NOT NULL`; `unit_id`, `lease_id` and `person_id` are all
nullable. Indexes exist on `(property_id, period)` — built for exactly the
period-based report read.

### What is NOT generable, on the revenue side

- **Escalations.** `leases.rent` is one scalar. No rent schedule table. A
  3%-annual bump cannot be expressed.
- **Recurring charges.** `src/money/economic_classes.js` grades this itself:
  `representable_today: false`, `honest_answer_today: "recurring_charge_model_not_built"`,
  because `pricing_terms.fee_terms` is a blob with no cadence — so *"$30/month
  there would be indistinguishable from a $30 one-time fee."* **The repo already
  reached this answer and wrote down why.**
- **Concession amortization.** `concession_treatment` (upfront|amortized) and
  `concession_of_months` existed on the migration-002 `scheduled_charges`, which
  **migration 036 dropped and rebuilt** (verified empty first). Those columns did
  not carry forward.

---

## What is reusable, so the next slice is not from scratch

**1. The accrual grain exists.** `period` vs `due_date`, with period-scoped
indexes already built for the report read.

**2. `governed_charges` (105) is a real governed-economic-term precedent** —
carrying amount, cadence, currency, effective dates, refundable and
applicability, and made **immutable once active** by migrations 108 / 110, which
list currency among the material economic terms that may not change. Paired with
`MONEY_OBLIGATION_CONTRACT` in `economic_classes.js`:

```text
economic_class · amount (a resolved number, OR an explicit unresolved reason)
cadence · applicability · required · refundable · effective_from
authority (who approved it, on what basis) · canonical_owner
```

…the vocabulary for "a governed standing obligation" is already written.

**3. Deal Setup's activation machine is document-agnostic in shape.**

```text
retained artifact → loadLedgerSnapshot → import_batches / import_source_rows
                  → proposed_records → human confirm → canonical records
                  → produced_*_id written back onto the evidence row
```

**Only the field map is rent-roll-specific.** That is the machine a loan document
or tax bill would ride — evidence, proposal, human confirmation, lineage — and it
already works.

---

## Flags

1. **`period` is a month stamp, not a period range.** A $120k premium covering
   Jan–Dec is twelve $10k rows. Workable, but anything on a non-monthly basis — a
   tax period, debt interest on actual/360 — needs either a different grain or a
   start/end range. Design question, not a blocker.

2. **`scheduled_charges` is an AR / income claim ledger, not a general accrual
   schedule.** `charge_type` defaults to `'rent'`; `status` is
   `claimed | partially_paid | paid | written_off | disputed`; `source` is
   `lease | rent_roll | import | manual`. All tenant-receivable-shaped. Putting an
   insurance accrual in it would force an AR primitive to hold an expense accrual.
   Reads as a **sibling, not a reuse** — flagged, not decided.

3. **Two `create table scheduled_charges` statements exist** (002 and 036). 036
   drops the 002 table first, so the live shape is unambiguous — but a grep finds
   two definitions and the older one has fields that no longer exist.

4. **`vendors` and `vendor_property_categories` exist** — vendor identity, with no
   contract terms attached. "Recurring contracts" has a counterparty model and no
   obligation model.

---

## Where this points

The runway is **the second onboarding stage** — the one `CLAUDE.md` already names
and nobody has built: reading standing economic terms out of the documents Deal
Setup is already retaining.

The narrowest vertically-complete slice with a real reporting consequence is
**one instrument type, end to end** — source document → extracted governed terms →
dated schedule → a read — rather than a generic "standing obligations" model
covering twelve categories at once.

Debt and insurance are the two strongest candidates: both are large, both are
contractual rather than estimated, and both make the cash-vs-accrual split
visible immediately.

**That scoping decision is the owner's and has not been made.**

---

## Parked, not discarded

The Economic Consequence V1 design work (operating fact → economic meaning) is
**frozen, not abandoned.** What it established and should be read before
restarting it:

- `work_order_progress` is a durable observation hook with actor, verbatim words,
  source message and property scope — one writer, append-only.
- Supersession must be scoped to a **claim**, so that correction
  (`$1,840 → $2,250`) and later fact (`did not occur`) cannot become the same
  mechanism. History accumulates; it does not advance.
- `events` was inspected as a cross-domain causal hook and **rejected**: `type` is
  free text with a default, written by 74 call sites; there is **no actor column**;
  `property_id` is nullable with `ON DELETE CASCADE`; and standing facts (a lease
  earning rent, a note accruing interest) have no operating event by construction.
- The canonical actor for economic confirmation is **`users.id`**, reached to a
  person only through the audited `users.person_id` bridge via
  `staff_identity_resolver.js` — `unbridged` is a live state, so requiring a
  person would fail closed on legitimate operators.
- **There is no governed currency context anywhere in the repo.** No currency on
  properties, orgs, deals or portfolios; no `country`, `jurisdiction` or `locale`
  column on `properties`. The only currency is `governed_charges.currency`, which
  is per-charge with `default 'USD'`. Any economic schedule work inherits this
  gap and must resolve currency explicitly or refuse.

The operating-consequence layer sits **alongside** the governed baseline, not
underneath it:

```text
normal governed expectation  +  unexpected operating consequence
    =  the actual economic story of the property
```
