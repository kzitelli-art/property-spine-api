# SKYLINE — GOVERNING OPERATING FACTS

**Confirmed by ownership 2026-08-20.** This supersedes the Skyline column of
`PROPERTY_ONBOARDING_QUESTIONNAIRE.md` wherever the two conflict. The
questionnaire remains the reusable framework; this is the answer sheet.

**Property:** Skyline Apartments · 1417 N 15th Street, Philadelphia PA 19121
**Confirming authority:** Kameron Zitelli, with physical inspection by Mike Grivna

---

## INVENTORY

72 units · 160 beds · leasing basis **`bed`**

| Type | Units | Beds/unit | Beds |
|---|---:|---:|---:|
| 2BR / 1BA | 56 | 2 | 112 |
| 3BR / 1BA | 14 | 3 | 42 |
| 3BR / 1.5BA | 2 | 3 | 6 |
| | **72** | | **160** |

Arithmetic checks against both stated totals.

**The only 3BR / 1.5BA units are 116 and 416.**

There is no pricing difference between layouts within a physical unit type.

> ### THE YARDI CODE IS NOT A BATH COUNT — NOW ENCODED CORRECTLY
>
> `tools/apply_unit_type_mapping.js` asserted `STU00017 → 3BR-1.5BA`. That was
> **wrong**, and applying it would have given three units a bathroom they do not
> have, then published pricing against it.
>
> `STU00017` covers **four** units in the committed July batch. Only **two** of
> them — 116 and 416 — are 1.5 bath. So the code now maps to `3BR-1BA` like
> `STU00015`, and 116 and 416 are lifted **by name** from the physical
> inspection. A named override that matches no unit aborts the whole run and
> writes nothing, because a typo there would silently leave a unit typed by a
> code known not to describe it.
>
> The first receipt recorded the source as **silent** on the bath distinction.
> It is now known to **contradict** it, which is stronger: a silence invites a
> careful inference, a contradiction forbids one. Yardi codes remain source
> provenance only — never resident-facing type truth.
>
> **The arithmetic closes exactly.** 12 × `STU00015` plus the 2 `STU00017` units
> that are not overridden gives 14 × 3BR-1BA; the 2 named units give 3BR-1.5BA;
> 56 × `STU00016` gives 2BR. 72 units, 160 beds, matching the confirmed mix with
> nothing left over. Proven by `skyline_unit_type_mapping.e2e.js`, 12/12, which
> now carries the real unit numbers so the override path is actually exercised.

---

## PRICING — PER BED PER MONTH

**Only the 12-month term is published.** Confirmed 2026-08-20.

| Type | Published rent (12 months) |
|---|---:|
| 2BR / 1BA | **$850** |
| 3BR / 1BA | **$750** |
| 3BR / 1.5BA | **$775** |

Renewal rent equals new-lease rent. These are the rents for **Spring 2027**
and **2027–28 leasing**.

> **The sheet is in force from the day it is published — not from the lease
> start date.** `property_pricing_versions.effective_from` decides when the
> agent may quote these numbers; `effectivePropertyPricing` selects
> `effective_from <= today`. Dating it 2027-01-01 because the spring lease
> begins then would silence the agent for four months, through the very
> pre-leasing season the rents were set for. The lease's own start date is a
> separate field on the lease.

### Short terms are a negotiation, not a published price

7-month and 5-month leases are **short**. They carry **+$150/bed**, and they are
**deliberately not published**: they are not preferred inventory, they are taken
when leasing is slow, and the premium is upsold by a person.

**What that makes the system do, which is exactly right:**

- Asked a price with no term named, the agent quotes **$850 / $750 / $775** —
  the only published term, so nothing is being guessed.
- Asked about a 5- or 7-month lease, the adapter finds no published row for that
  term and returns `term_not_published` — an honest handoff, not a number. The
  conversation reaches a human, which is where an upsell belongs.
- **No AI surface can quote the +$150.** It exists in this document and in the
  leasing team's heads, and nowhere the software can reach. That is the correct
  containment for a discretionary price.

> ### Defect #14 is fixed
>
> One published term still quotes directly. Two or more published terms now
> return the term menu and ask the prospect to choose; no path takes `terms[0]`
> as an unstated decision. This is deployed and production-proven at Skyline for
> the one-term case. Skyline's unpublished 5- and 7-month negotiation remains a
> human handoff.
>
> Evidence: `tests/e2e/agent_pricing_wall.e2e.js` 22/22 and production draft
> `a0059ea8-aacd-4a5c-892a-6728afcb00bb`.

## FEES

| Charge | Amount | Notes |
|---|---|---|
| Application fee | **$0 / none** | resolves a blocking config key |
| Amenity fee | **$0 / none** | resolves a blocking config key |
| Parking | **$150/month**, assigned | space count unknown |
| Utility fee | **$500 per 12 months** | landlord pays gas, electric, water/sewer, internet |
| Late fee | $50 after the 3rd business day, then $5/day | from the lease |

**Utility fee is prorated monthly**, at $500 ÷ 12, and the resident may elect to
pay monthly. Shorter leases use the same proration — **not** a flat $500.

> **⚠ $500 ÷ 12 = $41.6666… and money columns store two decimals.** A rounding
> rule is needed, because the obvious ones disagree:
> - `$41.67 × 12 = $500.04` — overcharges four cents
> - `$41.67 × 11 + $41.63 = $500.00` — exact, needs a designated stub month
>
> Four cents is not the point; an unstated rule is. Two systems rounding
> differently is how a resident ledger and an owner statement stop agreeing.

---

## SECURITY DEPOSIT

- **Standard: 1 month's rent.**
- **No available guarantor → 2 months.**
- Skyline does use guarantors.
- Legacy flat $500 deposits are historical and are **not** the current rule.

> **The governing condition is "no available guarantor," not "international
> student."** Those correlate in the existing book and do not mean the same
> thing. Encoding the second would make a protected characteristic the trigger
> for a higher charge, when the actual business rule is about credit support.
> Recorded this way deliberately.

---

## POLICIES

| | |
|---|---|
| Pets | **None.** |
| Assistance animals | ESA accepted with doctor documentation **and** vaccine records. Not pet inventory, not pet pricing — a separate accommodation path. |
| Smoking | Not permitted. |

---

## FURNISHED

Apartments are furnished: **bed · desk · wardrobe · armchair · coffee table ·
kitchen table · stools.**

## AMENITIES

Roof deck · cardio room · laundry · assigned parking · on-site management office
· package storage · 24-hour emergency maintenance

---

## TOUR SCHEDULING

**Owner ruling 2026-08-21:** Property Spine is the booking authority. Do not
activate Acuity or another third-party scheduler as a second source of truth.

The existing native chain is the target:

`tour_availability` → agent offers exact slot IDs → prospect confirms an
offered slot → `leasing_tours` records the booking → the same conversation
recognizes that the prospect is already booked.

**Owner-confirmed operating policy, 2026-08-21:**

- Monday-Friday: `9:00 AM-5:00 PM`
- Saturday: `10:00 AM-3:00 PM`
- Sunday: closed
- Tours reserve one 60-minute block even when the visit ends earlier. Ending
  early does not make that block available again.
- Prospects need at least two hours' notice and may book up to 45 days ahead.
- Federal holidays are closed. The native calendar closes both the legal
  holiday date and the OPM-observed weekday when they differ; this matters
  because Saturday is otherwise open.
- Mike Grivna is the default scheduled host. Another active Skyline staff user
  with leasing access may be selected as replacement coverage.
- Each published time has capacity one.

The staff publication side uses the same native chain. One current weekly
policy materializes real `tour_availability` rows; those rows, not the policy
alone, are what prospects may be offered. A signed-in leasing staff user can
publish the next 45 days, add or block one time, close all remaining open times
on a day, or reassign a day's remaining open times. Property and recorder come
from the staff session, and every command retains an attributable receipt.

Booked tours never disappear during a staff callout. Closing or reassigning a
day changes open times only and reports the number of booked tours still
scheduled so staff can make an explicit coverage decision.

The same canonical schedule standing is registered with Ask Spine. The app and
staff SMS can ask what times are actually open, who the default host is, and
which booked tours still need coverage. Ask Spine reads the materialized rows;
it does not expand weekly hours into invented availability.

The complete native path is proven on a disposable production clone: exact-slot
service 23/23, weekly-policy/callout service 25/25, real session + HTTP 20/20,
canonical booking 33/33, and cross-turn agent offer/confirm 12/12. Ask Spine's
schedule contract is 8/8, staff SMS routing is 30/30, and the existing real-HTTP
Skyline-shaped lead-to-lease path is green through all 21 steps. All 43 API
source-governance gates and all 1,466 app assertions pass.

**Deployed 2026-08-21:** API `3b72469`, app `567d15f`, and migrations 188-189 are
live. The production ledger is verified at 189, all three native scheduler
tables exist, and the deployed API health receipt identifies `3b72469`.
Skyline's operating timezone was set through the governed command to
`America/New_York`; change receipt `289f0937-e1d5-4d67-81d0-cf44ec1f588c`.

Skyline is not active yet. One canonical Leasing invite is linked to the Mike
Grivna person in production and the live Team receipt records `sms_sent`. It
superseded both stale invites. Mike has not verified it yet, so no linked user,
active staff context, Skyline assignment, or eligible tour host exists yet. No
schedule policy or availability row has been published, and Skyline is not in
the agent-booking allowlist.

Migration 189 closes the old onboarding split. The signed-in Team form now asks
for one canonical job, name, and phone. If that phone matches an existing person,
the manager must confirm the record before the system writes or sends anything.
When the invitee verifies, one transaction establishes login, the audited
user-to-person bridge, Skyline staff context, person-keyed work eligibility, and
property-team access. This was proven 50/50 through real HTTP and Postgres on a
disposable production clone, with the identity bridge regression green 44/44.
Production has now exercised the path through invite creation and provider
acceptance. The acceptance transaction remains unexercised until Mike verifies.

Staff SMS uses the same Ask Spine answer service as the dashboard, but a separate
governed transport. It deliberately enters through an organization-owned
`operations` number limited to staff and replies, while Skyline's property-facing
number remains limited to residents and prospects. Skyline currently has no
`organization_id`, so it cannot resolve an operations line. Production's one
active operations line belongs to `Demo ORG` and has historic real provider
traffic. Do not silently attach Skyline to that demo identity: first name the
real operating organization, then explicitly retain/rebind/provision its staff
number.

### Activation sequence

1. **Complete.** Deploy migrations 188-189 and the API/app changes through the
   normal release gate.
2. **Partial.** Skyline's operating timezone is `America/New_York`; one canonical
   Mike Grivna Leasing invite is active and provider-accepted. Mike must verify
   it; that one acceptance should establish the bridge, staff context, Skyline
   leasing assignment, and property access together. Re-read all four.
3. Publish the owner-confirmed weekly policy and its first 45 days of times;
   verify the session-scoped read returns the same slots and event receipts.
4. Add Skyline's property ID to the governed agent-booking allowlist and deploy
   that configuration.
5. Run a controlled prospect conversation with outbound delivery suppressed:
   ask for times, confirm one offered choice in a later turn, and verify the
   slot, tour, lead state, offer receipt, and event attribution.
6. Only after that proof, exercise one owner-approved real SMS booking. No
   external calendar or scheduler becomes an authority anywhere in the path.
7. Before the first staff SMS proof, establish Skyline's real organization and
   its reply-only operations line. Then have Mike ask the same supported question
   in the dashboard and by text and compare the governed answer receipts.

---

## AUTHORITY

| | |
|---|---|
| Approve pricing changes | **Kameron Zitelli · Mike Grivna** |
| Approve fee waivers | **Kameron Zitelli · Mike Grivna** |
| Sign leases for Carlisle Street Partners, LP | **Kameron Zitelli** |

The name is **Mike Grivna**. Not "Griffin" — an earlier draft had it wrong.

> **⚠ Mike Grivna cannot hold pricing authority in the system until he exists as
> a person with a staff context.** Authority is granted through
> `resolveAuthority()`, which requires a classified staff person, an entitling
> staff context at this property, and a named reviewer — a four-step sequence
> (classify → link → confirm entitlement → assign) with no shortcut. All of it
> is a production write and needs explicit approval. Naming him here does not
> grant it.

---

## LEASE CONFIG — ALL SIX KEYS NOW RESOLVED

| Key | Value |
|---|---|
| `landlord_entity` | Carlisle Street Partners, LP |
| `utility_responsibility` | Landlord pays gas, water/sewer, electric, internet |
| `late_fee` | $50 after 3rd business day + $5/day |
| `notice_requirement` | None — lease expires at end of term |
| `application_fee` | $0 / none |
| `amenity_fee` | $0 / none |

**Lease generation is no longer blocked on configuration.** Entering these is a
production write and still needs approval.

---

## STILL UNRESOLVED — DO NOT INVENT

1. Exact standard Spring lease start date
2. Exact security-deposit due date after signing
3. Total rentable parking spaces
4. Current renters-insurance rule
5. Whether any concessions are currently active
6. Pricing reason code — schema requires one of `lease_up`, `market_adjustment`,
   `seasonal`, `renewal_strategy`, `concession_change`, `correction`, `other`
7. Whether anyone besides Kameron may legally sign leases
8. Whether any separately rentable retail / office / storage space exists
Plus the two raised above: the utility rounding rule and the 17-vs-16 room count.

---

## PAPERWORK THAT NOW CONTRADICTS OPERATIONS

The lease and application predate these answers. Flagged for cleanup, not fixed:

| Area | The paperwork says | Operations say |
|---|---|---|
| Utility fee | a single `$500` figure, no schedule | $500/12 prorated, monthly election available, short leases prorate |
| Deposit | one blank amount, "within 5 days of signing" | 1 month standard, 2 months without a guarantor; due date unconfirmed |
| Guarantor | a co-signer clause with no trigger | absence of a guarantor is what sets the deposit |
| Animals | "no pets or animals excluding seeing-eye dogs" | ESA accepted with documentation and vaccine records |
| Furnished | nothing at all; unit accepted "AS IS" | furnished, seven itemised pieces |
| Parking | §29 disclaims liability only | $150/month, assigned |

Each is a case where the signed instrument does not describe the deal. Not
blocking pricing; all real exposure.
