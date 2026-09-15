# PROPERTY ONBOARDING — THE FACTS THE SYSTEM NEEDS

**Reusable for every property.** The sections below are not a wish list; each one
maps to a table or a controlled vocabulary the software actually enforces. Where
this document offers a fixed list of choices, that list is the software's — an
answer outside it cannot be recorded.

**Instance:** Skyline Apartments · 1417 N 15th St, Philadelphia PA 19121
**Prepared:** 2026-08-20 · **For confirmation by:** Grivener

| Mark | Meaning |
|---|---|
| ✅ | Found in a source document. **Confirm only.** |
| ⚠️ | Inferred from data, or partially known. **Confirm and complete.** |
| ❓ | Not found anywhere. **Needs an answer.** |
| ⛔ | Known to happen in practice but absent from the paperwork. **Needs a decision.** |

---

## A · PROPERTY IDENTITY

| # | Question | Skyline | |
|---|---|---|---|
| A1 | Legal/display name | Skyline Apartments | ✅ |
| A2 | Street address, city, state, ZIP | 1417 North 15th Street, Philadelphia, PA 19121 | ✅ |
| A3 | Operating timezone | America/New_York | ⚠️ |
| A4 | Total rentable positions | 160 beds across 72 units | ✅ |
| A5 | **Leasing basis — `unit`, `bed`, or `unknown`** | `bed` | ✅ |

> **A5 is the most consequential answer in this document.** It decides whether a
> lease attaches to an apartment or to a bed inside one, and therefore how rent,
> deposits and occupancy are counted everywhere downstream. It cannot be changed
> casually later.

---

## B · AUTHORITY — WHO CAN DO WHAT

| # | Question | Skyline | |
|---|---|---|---|
| B1 | Which legal entity is named as **Landlord on the lease**? | **Carlisle Street Partners, LP** | ✅ |
| B2 | Is that the same entity that owns the property? | No — ownership sits in Skyline Apartments GP LLC / Majority / Minority / Note Owner. Carlisle is the lease party and the borrower. | ⚠️ |
| B3 | **Who signs a lease on the company's behalf?** Name the person and their authority to bind. | Kameron Zitelli countersigns in practice. Is that the only authorised signer? | ⚠️ |
| B4 | Who may **approve and publish pricing** (distinct from signing a lease)? | ❓ | ❓ |
| B5 | Who may **waive a fee**, and is it the same person? | ❓ | ❓ |
| B6 | Which **lease form** is used? | Skyline's own "Skyline Apartments LEASE AGREEMENT" (46 sections + Philadelphia Partners for Good Housing appendices) — **not** the NAA form used at 4233 Chestnut | ✅ |
| B7 | Which **e-signature platform**, and is its audit trail retained? | Dropbox Sign. Full trail: document hash, IPs, view and sign timestamps, completion. | ✅ |
| B8 | Who sends leases out for signature? | mike@templeskyline.com | ✅ |

---

## C · INVENTORY SHAPE

| # | Question | Skyline | |
|---|---|---|---|
| C1 | List every **unit type**: short code, resident-facing label, display order | `2BR` 2 Bedroom · `3BR-1BA` 3 Bedroom / 1 Bath · `3BR-1.5BA` 3 Bedroom / 1.5 Bath | ✅ |
| C2 | How many units of each type? | 12 × 3BR-1BA, 4 × 3BR-1.5BA, balance 2BR — **needs a full count** | ⚠️ |
| C3 | Beds per unit, by type | ⚠️ derivable from the rent roll, not yet stated | ⚠️ |
| C4 | What **physically distinguishes** each type? | Bath count. **The rent roll is silent on it** — the distinction rests on owner statement, not on any source document. | ⚠️ |
| C5 | Are there **floor plans** within a type that price differently? | Owner says yes. Not yet enumerated. | ⛔ |
| C6 | Any non-residential space (retail, office, storage)? | ❓ | ❓ |
| C7 | Are vendor codes in use that residents should never see? | Yes — Yardi `STU00015/16/17`. Retained as source provenance only, never shown. | ✅ |

---

## D · LEASE TERMS OFFERED

The system prices **per unit type per term length**. Every term you offer needs its
own row; a term with no row cannot be quoted.

| # | Question | Skyline | |
|---|---|---|---|
| D1 | Which **term lengths** are offered? | Full year (~12mo) · **Fall only (~5mo)** · Academic to May (~10mo) · Spring (~7mo) — all four appear in the live book | ✅ |
| D2 | Standard **start and end dates** for each | Full year: Aug 3 → Jul 26. Fall: Aug 3 → ~Dec 28. May-ending: Aug 3 → May 31. Spring: **Jan ? → Jul 26** | ⚠️ |
| D3 | Is there a **standard term** to quote when a prospect doesn't name one? | ❓ — **the software currently guesses, and guesses the shortest.** See the note under §E. | ❓ |
| D4 | **Renewal deadline** — by when must a resident return a signed renewal? | Nov 30 for the following August (from a 2025-26 lease) | ✅ |
| D5 | Is there a notice-to-vacate requirement? | **No.** The lease auto-terminates at expiry; the renewal deadline is the only date that matters. | ✅ |
| D6 | Month-to-month or holdover after expiry? | Holdover rent applies if keys aren't returned by 11am on the end date | ✅ |

> ⚠️ **Blocking issue for multi-term pricing.** When a prospect asks a price without
> naming a term, the quoting code silently picks the **shortest published term** —
> which is the most expensive. Publishing fall + spring + full-year would have the
> agent quote the fall rate to someone asking about a year. **D3 is the ruling that
> unblocks this.**

---

## E · PRICING

Per **unit type × term length**:

| # | Question | Skyline | |
|---|---|---|---|
| E1 | **New-lease rent** for each type × term | Owner states $850 (2BR) / $750 (3BR-1BA) / $775 (3BR-1.5BA) per bed — **term not specified** | ⚠️ |
| E2 | **Renewal rent** — same or different? | Same as new lease | ✅ |
| E3 | Is a **short term priced higher**? | The 2026-27 book suggests fall-only runs ~$900 vs $725–$815 full-year. Inferred from deposits, not stated. | ⚠️ |
| E4 | Any type **not currently offered**? Must be said explicitly — silence blocks publication. | ❓ | ❓ |
| E5 | **Effective date** of this pricing | ❓ Spring 2027 and 2027-28 pre-lease | ❓ |
| E6 | Reason for the change — `lease_up`, `market_adjustment`, `seasonal`, `renewal_strategy`, `concession_change`, `correction`, `other` | ❓ | ❓ |
| E7 | Is rent quoted **per bed or per unit**? | Per bed. Owner: *"I'll never refer by unit."* | ✅ |

---

## F · CHARGES AND FEES — **ASK ALL TWELVE, FOR EVERY FEE**

This is where onboarding usually under-specifies. An amount alone is not enough to
quote a fee to a prospect or put it on a lease. For **each** charge:

| Ask | Allowed answers |
|---|---|
| 1. Short code and resident-facing label | free text |
| 2. **Economic class** | `one_time_fee` · `recurring_charge` · `deposit_required` |
| 3. **Cadence** | `monthly` · `one_time` · `one_time_per_term` · `conditional` · `none` |
| 4. **Amount** — or the reason it can't be stated | number, or a written reason |
| 5. **Obligation** | `required` · `conditional` · `optional` |
| 6. **Who it's assessed per** | `applicant` · `unit` |
| 7. **Scope** | `property` · `unit_type` · `space` · `resident_condition` · `lease_condition` · `elected_option` |
| 8. Applies to **new leases**? | yes/no |
| 9. Applies to **renewals**? | yes/no |
| 10. Applies to **transfers**? | yes/no |
| 11. **Refundable?** | yes/no |
| 12. **Waivable — and by whom?** | yes/no + the role that may waive |

### Skyline charges found in the lease

| Charge | Amount | Status |
|---|---|---|
| Utilities Fee | $500 | ✅ named on the lease cover page |
| Late payment premium | $50 after the 3rd business day, **plus $5/day** | ✅ |
| Returned check | $35 | ✅ |
| Untransferred utility account | $150/month | ✅ (vestigial — landlord pays all utilities) |
| Noise / pet violation | $100 first, $200 second, eviction third | ✅ |
| Trash | $35/bag, up to $350 for large items | ✅ |
| Key replacement | FOB $50 · traditional & mailbox $25 | ✅ |
| **Application fee** | **not in the lease, not found anywhere** | ❓ |
| **Amenity fee** | **does not exist in the lease** | ❓ |
| **Parking** | Owner says it's charged. **The lease has no parking rent** — §29 only disclaims liability for vehicles. | ⛔ |

> **F-Q1:** Can the $500 utilities fee be **paid monthly instead of up front**? The
> owner says yes; the lease doesn't mention it. If it's a real option, is it an
> `elected_option` the resident chooses, and at what monthly amount?

---

## G · DEPOSITS

| # | Question | Skyline | |
|---|---|---|---|
| G1 | Standard security deposit | 1× monthly rent | ⚠️ |
| G2 | Any **higher tier**, and what triggers it? | 2× rent — international students without a guarantor | ✅ owner-stated, and visible in the book |
| G3 | Is a **flat** deposit still offered? | $500 appears throughout, but clusters on 2022–24 move-ins. **Retired, or still live?** | ⚠️ |
| G4 | When is it due? | Within 5 days of signing | ✅ |
| G5 | First and last month's rent up front? | Both due prior to move-in | ✅ |
| G6 | Is a **guarantor / co-signer** accepted, and when required? | Lease has a co-signer clause (§43). Trigger conditions not written down. | ⚠️ |

---

## H · WHAT'S INCLUDED

| # | Question | Skyline | |
|---|---|---|---|
| H1 | Which utilities does the **landlord** pay? | Gas, water & sewer, electricity, **internet** — all landlord | ✅ §8 |
| H2 | Which does the **resident** pay? | None | ✅ |
| H3 | **Is the unit furnished?** If so, what's included? | Owner says fully furnished. **The lease has no furniture clause** — the resident accepts the unit "AS IS." | ⛔ |
| H4 | Laundry — in-unit, on-site, coin-op, included? | Lease has a Laundry Facilities section (§18); terms not extracted | ⚠️ |
| H5 | Amenities a prospect would ask about | ❓ | ❓ |

---

## I · POLICIES

| # | Question | Skyline | |
|---|---|---|---|
| I1 | **Pets** — permitted? Fee? Deposit? Restrictions? | **Not permitted.** Service animals excepted with written notice. | ✅ §13 |
| I2 | **Parking** — available? How many spaces? Rate? Assigned? | Available; owner says charged. Amount and basis unknown. | ⛔ |
| I3 | Smoking | ❓ | ❓ |
| I4 | Guest / occupancy limits | Lease has Occupants (§9) and Guests (§10) | ⚠️ |
| I5 | Subletting | Requires written landlord consent **and** all current leaseholders' consent | ✅ §11 |
| I6 | Renters insurance — required or recommended? | Recommended, not required (§34) | ⚠️ |
| I7 | Firearms | Prohibited | ✅ §33 |

---

## J · LEASE CONFIGURATION — **BLOCKS LEASE GENERATION**

Six keys. The system **refuses to produce a lease packet** while any is blank, by
design. This is the shortest path from "onboarded" to "can actually sign someone."

| Key | Skyline | |
|---|---|---|
| `landlord_entity` | Carlisle Street Partners, LP | ✅ |
| `utility_responsibility` | Landlord pays gas, water/sewer, electric, internet | ✅ |
| `late_fee` | $50 after 3rd business day + $5/day | ✅ |
| `notice_requirement` | None — lease auto-terminates at expiry | ✅ |
| `application_fee` | | ❓ |
| `amenity_fee` | | ❓ |

**Two answers away from being able to generate a lease.**

---

## K · CONCESSIONS

Only ask once there's something to offer. Recorded per concession:

- **Type** — `free_rent` · `fixed_rent_credit` · `fee_waiver` · `one_time_fee_waiver`
- **Applies to** — `new` or `renewal`
- **Scope** — `property` · `unit_type` · `unit` · `bed_type`
- **Earned by** — `application_submitted` or `lease_signed`
- **Timing** — `first_full_month` · `third_full_month` · `final_full_month` ·
  `monthly_scheduled_credit` · `free_rent_period` · `flat_dated_credit` ·
  `fixed_monthly_discount` · `one_time_fee_waiver`
- **Stacking** — `exclusive` or `stackable`
- **Reason** — `lease_up` · `market_adjustment` · `seasonal` · `renewal_strategy` ·
  `competitive_response` · `correction` · `other`

**Skyline:** none currently published. ❓ Are any being offered informally?

---

## THE SHORT LIST

If Grivener answers nothing else, these unblock the most:

1. **Application fee** and **amenity fee** — the last two config keys (§J)
2. **Which term** the quoted rents apply to, and whether short terms price higher (§E1, §E3)
3. **Parking**: rate and basis — per space, per month, assigned? (§I2)
4. **Furnished**: what's included, and should it be on the lease? (§H3)
5. **Standard term to quote** when a prospect doesn't name one (§D3)
6. **Is the $500 flat deposit retired?** (§G3)
7. **Pricing effective date** and reason code (§E5, §E6)

---

## THREE THINGS DONE IN PRACTICE THAT THE PAPERWORK DOESN'T COVER

Not blockers for pricing — but each is a real exposure, and the pattern repeats at
every property, so it belongs in the framework:

1. **Furnished.** Fully furnished units, no furniture clause and no inventory
   schedule. Nothing establishes what was supplied or its condition at move-out.
2. **Parking.** Charged, but the lease grants no parking right and sets no rate.
3. **Fee amortization.** The $500 can be paid monthly, but the lease names only a
   single figure with no schedule.

---

## USING THIS FOR THE NEXT PROPERTY

Copy the file, clear the Skyline column, keep the questions and the allowed-answer
lists. Then, in order:

**A → B → C → J → D → E → F → G → H → I → K**

Identity before authority; authority before inventory; the six config keys early,
because they're cheap and they block lease generation; pricing only once terms and
types exist; concessions last.

**Two answers govern everything after them:** `leasing_basis` (A5) and who binds
the company (B3). Get those wrong and the rework reaches every table.
