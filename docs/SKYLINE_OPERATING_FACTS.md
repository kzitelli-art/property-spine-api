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

Renewal rent equals new-lease rent. Effective for **Spring 2027** and
**2027–28 leasing**.

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

> ### Defect #14 does not fire at Skyline
>
> `pricing_adapter.js:101` takes `terms[0]` when no term is named, which is
> deterministically the **shortest** published term. With three terms published
> that would have quoted the short-term premium to everyone who asked a plain
> price question — the commonest question in leasing, answered with the dearest
> number on the sheet.
>
> Publishing one term removes the ambiguity at its source rather than papering
> over it: with a single row there is no wrong row to pick.
>
> **The defect is still latent.** It bites the first property that publishes two
> terms. It is not fixed, and this decision is not a fix — it is Skyline
> declining to stand in front of it.

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

Plus the three raised above: which terms are "short," the utility rounding rule,
and the 17-vs-16 room count.

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
