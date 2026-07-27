# Governed Economic Terms — Phases 1–9

**As of 2026-07-27** · api `1b50091`
**525 assertions green** across seven harnesses.
**Nothing published. No live AI message changed. No concession activated.
No Future Rent Roll total changed. No other property received authority.
No historical person or bridge record deleted.**

---

## 1. Duplicate retirement + migration 104

`8d1ce2a1` retired, not deleted or merged. All 63 person-referencing tables
swept first: attached to **nothing** but its two closed bridge-audit rows.

```
record_status           retired
retired_reason          duplicate_created_in_error
retired_at / by         recorded
superseded_by_person_id c1dedf39   ← auditable resolution reference
name                    "Kameron Zitelli — Staff"  ← restored
created_at              21:45:08   ← preserved
```

My first attempt renamed it `VOID …`, which destroyed what the record *was*.
Retirement now lives in its own fields; a constraint refuses any retirement
without a reason and timestamp. It holds no context, no assignment, no login —
it cannot receive authority.

## 2. Idempotent, concurrency-safe staff creation

Six attempts including **five simultaneous**: all returned `already_exists`
resolving to the same person, **zero rows created**. A direct `INSERT`
bypassing the service is refused by `uq_active_staff_person_email`.

A pre-check alone cannot survive two concurrent callers both reading "none
exists" — so: transaction-scoped advisory lock on the user, with the partial
unique index as the database backstop. A login pointing at a retired person is
refused, not silently re-selected.

## 3. Actor context — Demo only

`c1dedf39` → `asset_manager` on Demo Building. All four verbs derive from
`assignment:asset_manager`. Checked property by property: **zero of the other
27**, including the real 4233 Chestnut. Tenant record `ede3fe95` untouched
with 135 comms / 100 events / 76 obligations intact.

---

## 4. Governed economic-class schema (migration 105)

`property_governed_charges` — there was no charge catalog at all:
`scheduled_charges` is a posting table, `ledger_entries` is empty.

**The class is structural, not a label.** Constraints make the collapses
impossible, and both the service *and* the database refuse them:

| Refused | Prevents |
|---|---|
| `recurring_charge` not monthly | $30/month becoming $30 once |
| `one_time_fee` monthly | a $300 pet fee billed every month |
| `deposit_required` non-refundable | recognising a refundable balance as income |
| `deposit_required` as revenue | a requirement becoming income |
| refundable `one_time_fee` | a deposit mislabelled a fee |
| `base_rent` / `deposit_held` in the catalog | a second asking rent; a fabricated liability |

`base_rent` lives in `pricing_terms`; `deposit_held` lives on the lease. Both
are **deliberately absent** from the catalog.

**An unresolved amount is a first-class state** — `amount NULL` with an
explained reason, never a forced midpoint. Such a row can never be quoted
precisely. Cross-property references are impossible by composite-FK shape.

## 5. Fact-migration preview — all 13, no writes

Each fact carries current wording, class, amount, cadence, applicability,
contradictions, proposed destination, and retirement action. Every proposal is
run through the **real** publication contract, so "safe" is not an opinion.

## 6. Safely migratable: **2 of 13**

| Fact | Destination |
|---|---|
| `pricing_application_fee` | `fee.application` — $50, one_time, required, per applicant |
| `pricing_admin_fee` | `fee.administration` — $99, one_time, new lease + renewal |

**Neither was migrated.** Publication requires a reviewed receipt and is not
part of this block.

## 7. Deliberately left unresolved: **11**

| Fact | Blocked on |
|---|---|
| `pricing_telecom_fee` | `range_determinant_unknown` — nothing says what makes it $75 vs $99 |
| `pricing_amenity_fee` | new-lease vs renewal amount not structured |
| `pet_policy` | fee and monthly rent not separated; per-pet vs per-tenancy unknown |
| `renters_insurance` | required-vs-optional contradiction (coverage required, $15 programme not) |
| `pricing_security_deposit` | underwriting requirement not separated from deposit held |
| `parking_pricing` | availability not modelled — quoting implies a spot exists |
| `utilities` | wifi $40 precise, but electric/water unmetered in the same sentence |
| `unit_transfers`, `entry_access` | three amounts on unstructured conditions; operations, not pricing |
| `move_in_requirements` | **no destination at all** — a charge row would make the duplicate permanent |
| `move_in_credits` | a concession, not a charge; still calendar-dependent |

## 8–10. Recurring charges · one-time fees · deposit requirements

All three classes are modelled, with applicability explicit
(`property`/`unit_type`/`space`/`resident_condition`/`lease_condition`/
`elected_option`), a required charge failing closed without applicability, an
optional charge refused if presented as universal, and a conditional charge
refused without a named condition. One-time fees carry their incurring event
and new-lease/renewal/transfer applicability. `deposit_required` is modelled
**without** activating the Money liability model, and `deposit_held` is not in
the catalog. **No production amounts were populated.**

## 11. Concession compiler — complete

**Both missing primitives resolved.**

`proration_basis`: `actual_days` · `thirty_day_month` · `full_months_only`,
with **no property default**. Proven that the basis changes the answer —
$2,300 (`actual_days`) vs $1,500 (`full_months_only`) on the same period — and
that on a **20-day February** `actual_days` and `thirty_day_month` genuinely
diverge. That is precisely why it cannot default.

`schedule_source`: `explicit_lines` | `governed_reference`. A total cannot
imply a schedule — $900 does not say whether that is 3×300 or 9×100, nor which
months.

**All eight profiles implemented**, each producing dated lines, effective rent
**derived** from them:

| Profile | Example output |
|---|---|
| `one_time_fee_waiver` | 1 line, $50, rent unchanged |
| `flat_dated_credit` | 1 line inside the term |
| `fixed_monthly_discount` | 3 lines × $100 → eff. $1,475 |
| `free_rent_period` | 2 lines: $800 (16/30 days) + $1,500 |
| `first/third/final_full_month` | 1 line, whole month's rent |
| `monthly_scheduled_credit` | 3 lines × $300 from explicit lines |

Refused: no basis, no schedule source, a line outside the lease, a waiver over
an unresolved fee. Deterministic; `free_months` never appears as truth.

## 12. Economic Terms operator surface — **NOT BUILT**

The API reads exist (`/operator/economics/charges`,
`/fact-migration-preview`, `/adapter-preview`) but the six-section operator
surface is **not built and not browser-proven**. Recorded as outstanding
rather than claimed. The existing Decision Room is unchanged and still shows
the honest no-version state.

## 13. Dark economic adapter — **shadow extension NOT BUILT**

The adapter is complete and proven: every class separately represented, seven
declared states, quotability derived from state, commercial `not_applicable`,
failed read → `unavailable`, no `market_rent` value anywhere.

**It never manufactures a total.** No combined monthly or move-in figure
unless *every* component is governed, applicable and separately disclosed —
otherwise the parts are given and the total withheld with its reason.

**Partial answers are answers.** Proven with a real charge published inside a
rollback: a `known_and_quotable` $50 fee sits beside an unresolved base rent,
the answer stays answerable, and the total is still withheld.

**Zero consumers.** `agent.js` does not reference it.

The extended shadow comparison across all 18 named scenarios is **not built**.
The existing rent/fee shadow simulator is unchanged and still sends nothing.

## 14. Future Rent Roll economic integration

```
base contractual rent + recurring contractual charges − dated concession lines
= scheduled recurring economics
```

Proven: 0 locked positions repriced · 0 positions given projected revenue ·
recurring charges `included_in_projection: 0` because optional charges are
never assumed and conditional ones need a governed true condition ·
concessions reduce economics **only** through dated lines · one-time fees
never annualized · `deposit_required` and `deposit_held` contribute **zero
revenue** · `scheduled_recurring_economics: null` without approved
assumptions. **No live total changed.**

---

## 15. Ownership rulings still required before economic publication

1. **Telecom determinant** — what decides $75 vs $99?
2. **Amenity** — confirm $300 new-lease / $250 renewal as two governed rows.
3. **Pet economics** — split into fee + rent, and decide **per-pet or
   per-tenancy**.
4. **Insurance** — is the $15 programme optional (recommended) or required?
5. **Security deposit** — confirm it leaves pricing for underwriting.
6. **Parking** — is availability quotable at all without an inventory model?
7. **Utilities** — quote wifi alone, or withhold until electric/water are modelled?
8. **`move_in_requirements`** — approve rewriting it to reference, or deleting it.
9. **Move-in credits** — keep quoting from prose, or stop?
10. **Proration basis** for Demo Building's first concession.
11. **The eight version-one rents** — still unmade.

## 16. Safe migration and live-AI cutover sequence

1. Publish the **two** clean fees as governed charges (reviewed receipt).
2. **Shadow** governed vs live on real conversations, sending nothing.
3. Retire each `agent_facts` row **in the same commit** that publishes its
   governed replacement — two quotable copies must never coexist.
4. Resolve the four blocked fees, then migrate them one at a time.
5. Delete `move_in_requirements`.
6. Publish pricing version one (after §15.11).
7. Cut rent quoting over at zero shadow disagreement.
8. Recurring charges last, once availability and conditionality are modelled.
9. Concessions after a declared proration basis.

## 17. Contradictions and missing primitives discovered

| # | Finding | Status |
|---|---|---|
| 1 | **No governed charge catalog existed** | fixed (105) |
| 2 | `proration_basis` undeclared | **resolved** |
| 3 | `schedule_source` undeclared | **resolved** |
| 4 | `governedCharges` passed an unused SQL param → the whole read **threw**, and every class reported "unavailable" — a failure that looked like honest absence | **fixed** |
| 5 | `String(Date)` → `"Wed Jan 01"` compares above any ISO date; every charge would report not-yet-effective **forever** | **fixed** |
| 6 | The contract demanded an explicit `applies_to_*` while the column defaults true | **fixed** |
| 7 | The generic `value` guard refused profiles that forgive rent | **fixed** |
| 8 | `persons` had no retirement mechanism | fixed (104) |
| 9 | Approved assumption set still absent | open — blocks all projection |
| 10 | Parking availability not modelled | open |
| 11 | Electric/water unmetered | open |
| 12 | Economic Terms surface + shadow extension | **not built** |

## 18. Confirmation

- ✅ No pricing published — `property_pricing_versions` = 0
- ✅ No governed charge published — catalog exists, **0 rows**
- ✅ No live AI message changed — adapter dark, `agent.js` clean
- ✅ No real concession activated — `concession_policies` active = 0
- ✅ No Future Rent Roll total changed — 0 positions projected
- ✅ No other property received authority — 1 of 28
- ✅ No historical person or bridge record deleted — 902 persons, audit intact
