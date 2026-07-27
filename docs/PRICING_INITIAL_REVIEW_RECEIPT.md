# Pricing & Concessions — Initial Review Receipt

**Property:** Demo Building (`a50fbdd0…a4fe`) · **As of:** 2026-07-27
**Status:** nothing published. This is the receipt to be reviewed *before* the
first governed version exists.

Read against live Neon. Every count below is a query result, not an estimate.

---

## 1. What exists today

| Store | Rows | Reaches a prospect? |
|---|---|---|
| `property_pricing_versions` | **0** | no |
| `pricing_terms` | **0** | no |
| `concession_policies` | **0** | no |
| `units.market_rent` | **283 of 283 populated** | **YES — the AI quotes it** |
| `agent_facts` carrying money | **13 active** | **YES — the AI quotes them** |
| `leases.rent` (in-place) | 214 trusted positions, **$362,045.83/mo** | no (reporting only) |

The governed tables are empty. **Everything a prospect is actually told today
comes from the two rows in bold** — a legacy per-unit column and a free-text
fact set. Neither is authored pricing.

---

## 2. Every pricing-shaped value, with claim strength

### 2a. `units.market_rent` — the value the AI quotes today

| Governed type | Units | Marketable | market_rent min–max |
|---|---:|---:|---|
| Studio | 108 | 107 | $1,045 – $1,687 |
| Furnished Studio | 28 | 28 | $1,600 flat |
| 1 Bed | 102 | 100 | $1,200 – $2,200 |
| Furnished 1 Bed | 16 | 15 | $1,800 – $2,275 |
| 1 Bed + Den | 6 | 6 | $2,150 flat |
| 2 Bed / 2 Bath | 14 | 13 | $2,700 – $2,900 |
| 3 Bed / 2 Bath | 6 | 6 | $3,900 flat |
| 3 Bed / 3 Bath | 1 | 1 | $3,990 |
| Commercial Space | 1 | 1 | **$0** |

- **Source:** unknown. No author, no date, no approval. It arrived with the
  opening import.
- **Property scope:** per unit, not per type — so a Studio has **643 dollars of
  spread** with no stated reason. That is not a price, it is 108 opinions.
- **New-lease vs renewal:** does not distinguish. One column serves both.
- **Effective date:** none. It cannot expire and cannot be superseded.
- **Runtime consumer:** `src/agent/agent.js:294` — quoted to real prospects.
- **Claim strength:** *unproven*.
- **Safe to propose as pricing?* **No.** This is the column that told a real
  prospect a number $237 away from the sheet on unit 530.

Note the commercial space carries **$0**, which the current path would quote as
a price. The governed read handles this by requiring an explicit
`not_offered` / `pricing_unavailable` rather than letting a zero speak.

### 2b. `leases.rent` — in-place contractual rent

- **Source:** executed leases. Highest claim strength in the system.
- **Claim strength:** *Proven* (this is the Current Rent Roll spine).
- **Safe to propose as pricing?** **No** — and this is the important one.
  In-place rent is what *was agreed*, sometimes years ago. Promoting it to
  asking rent would publish the past as the offer. It is legitimate **evidence
  for** the judgment, never the judgment.

### 2c. The client-side store

`window.__pricingStore` in `app/index.html` — a browser-held object. No server
row, no author, no audit. **Claim strength: none.** Explicitly refused by both
`effective_pricing.js` and `pricing_publication_contract.js`
(`client_store_promotion`), and asserted in the harness.

---

## 3. Fee ownership and migration map

**The five keys I had listed as "the approved fee source" are not the whole
quotable surface.** Thirteen active facts carry a dollar figure. Eight of them
are outside the list — and four of those are **recurring monthly charges**, not
fees at all.

| Fact key | Money | Shape | Owner after migration |
|---|---|---|---|
| `pricing_application_fee` | $50 | one-time | **Pricing & Concessions** |
| `pricing_admin_fee` | $99 (move-in + renewal) | one-time ×2 | **Pricing & Concessions** |
| `pricing_amenity_fee` | $300 ($250 renewal) | one-time | **Pricing & Concessions** |
| `pricing_telecom_fee` | **$75–99 (a range)** | one-time | **Pricing & Concessions** |
| `pricing_security_deposit` | **$1,000 – one month's rent** | conditional | Risk/underwriting, *not* pricing |
| `parking_pricing` | **$300/month** | **recurring** | Recurring charges (does not exist) |
| `pet_policy` | $300 once + **$30/month** | one-time + **recurring** | split: fee + recurring |
| `utilities` | wifi **$40/month** | **recurring** | Recurring charges (does not exist) |
| `renters_insurance` | **$15/month** | **recurring** | Recurring charges (does not exist) |
| `unit_transfers` | $750 / $1,000 | one-time, conditional | Leasing policy, not pricing |
| `entry_access` | $75 / $25 / $25 | incidental | Operations, not pricing |
| `move_in_requirements` | restates 4 fees above | **derivative** | delete on migration — it is a second copy |
| `move_in_credits` | $500 / $500 / $300 | **concession** | **Concessions** (see §4) |

Three findings worth a decision:

1. **Four recurring charges are quoted to prospects and appear in no rent
   roll.** Parking $300, pet rent $30, wifi $40, insurance $15. A resident with
   parking and a pet pays $330/month that the Current Rent Roll cannot see.
   There is no recurring-charge model. This is a real gap, not a pricing gap —
   flagging it, not solving it here.
2. **`move_in_requirements` restates the application, deposit, amenity and
   telecom fees in prose.** That is a second quotable copy of four values. It
   is exactly the duplication the single-source rule exists to prevent, and it
   is live today. It must be rewritten to reference rather than restate.
3. **Two of the five are not single values.** The telecom fee is a $24 range
   and the deposit is a conditional band. A governed sheet cannot publish a
   range as a price — each needs a resolved value or an explicit
   "quoted by the office."

`pricing_terms.fee_terms` exists in schema and is **deliberately not read** by
`effective_pricing.js`. Two independently quotable fee values must never
coexist; the publication contract refuses it (`two_fee_sources`).

---

## 4. Concession timing-profile inventory

Vocabulary declared in migration 062:

| Timing profile | Implemented? | Why |
|---|---|---|
| `first_full_month` | **no** | needs dated schedule lines |
| `third_full_month` | **no** | needs dated schedule lines |
| `final_full_month` | **no** | needs dated schedule lines |
| `monthly_scheduled_credit` | **no** | needs dated schedule lines |

`IMPLEMENTED_TIMING_PROFILES = []`. The blocker is a single function:
`computeScheduleLines` at `src/money/commitmentledger.js:1039` is a throw-only
stub raising `CALENDAR_CONTRACT_MISSING`. **No concession that places dated
lines can be advertised**, because its economic consequence cannot be computed
— and a concession that cannot be computed is a promise with no number behind
it.

**One exception, and it is useful.** A `fee_waiver` is one-time and
month-agnostic: it needs no calendar. It is the one concession shape
publishable today, and the harness proves the contract accepts it while
refusing the other three.

**Move-in credits are concessions.** `$500` first responders, `$500` military
and veterans, `$300` Penn Dental/Vet — currently a free-text fact quoted by the
AI, applied "as a one-time credit after lease execution." As a
`fixed_rent_credit` they are calendar-dependent and **cannot be published
today**. They are being quoted today anyway, through the fact set.

---

## 5. What the foundation now refuses (52/52 proven)

- `pricing_terms` keyed to `property_unit_types.id`, never text.
- Cross-property references impossible by **key shape** — composite FKs carry
  `property_id`, so the database refuses them without a runtime check.
- A published version cannot **silently** omit a marketable type; omission
  requires an explicit `not_offered` / `pricing_unavailable`.
- Overlapping effective periods refused — a property cannot have two asking
  rents on one day.
- Publisher authority required; no receipt, no publication.
- `units.market_rent` and the client store cannot be promoted.
- The AI adapter is **dark**, reads only a published version, resolves the type
  from the real rentable position, and hands off honestly otherwise.

---

## 6. Decisions required before the first version is published

These are the owner's, not mine.

1. **Studio spread.** One Studio price, or a documented tier? 108 units
   currently span $1,045–$1,687 with no stated reason.
2. **Which types are offered at all?** Eight types have marketable inventory
   and owe a decision. Commercial Space carries $0 and almost certainly means
   `pricing_unavailable`.
3. **Renewal pricing.** Explicit renewal rent per type, or explicit
   "unavailable"? Silence is refused by the contract.
4. **Lease terms.** Which terms are published — 12 only, or a set?
5. **Telecom fee.** Resolve $75–99 to one number, or mark it office-quoted.
6. **Security deposit.** Confirm it leaves pricing for underwriting, and that
   the AI stops quoting a band as if it were a price.
7. **`move_in_requirements`.** Approve rewriting it to stop restating four fee
   values it does not own.
8. **Move-in credits.** Accept that they cannot be published until the schedule
   engine exists — and decide whether the AI keeps quoting them from the fact
   set in the meantime, or stops.
9. **Recurring charges** (parking, pet rent, wifi, insurance). Confirm this is
   a separate build and not smuggled into pricing.
10. **Publisher.** Who holds publish authority on this property.

Until these are answered, the honest state is the one the system now reports:
*no governed pricing version has been published.*
