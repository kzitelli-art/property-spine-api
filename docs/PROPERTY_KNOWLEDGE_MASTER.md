# Property Knowledge Master — fill-in worklist

**Three properties. One vocabulary. One place the answers go.**

This is a standalone working document. You do not need the codebase to use it. Hand it
to an assistant with access to the OneDrive / SharePoint library and it will tell that
assistant exactly what to look for, what to record, what to refuse, and how to hand
the answers back.

```text
Solo on Chestnut    4233 Chestnut St, Philadelphia PA 19104 (University City)
Skyline             1417 N 15th St, Philadelphia (Temple)
Greenery            1325 N 15th St, Philadelphia (Temple)
```

| | Solo | Skyline | Greenery |
|---|---|---|---|
| Curated facts loaded | 18 (on the demo property) | 5 of 10 shelves | 0 of 10 shelves |
| Approved lease master | not established here | established, pinned by digest | **none — see §5** |
| Known unresolved conflicts | 3 | 3 | 5 |

**Why this exists.** Solo was made agent-ready by discovery — an interview, five
defect cases, and a live prospect quoted **$2,700** on a 2-bedroom that the pricing
sheet put at $2,600 gross / $2,384 net, with the free month never mentioned. The
number he actually cared about was **$316/month better than what he was told**, and he
went cold partly on value. Nothing about that carried forward. This document is what
carries it forward.

---

## 1. Instructions for the assistant doing the scrub

Read this section before opening a single file.

### What you are producing

For every row in §6, one of three outcomes. Never a fourth.

```text
FOUND        a plain-language answer + the source path + effective date
CONFLICTING  TWO OR MORE answers, each with its own source path — and NO choice made
MISSING      nothing in the library establishes it
```

`MISSING` is a successful outcome. It makes the assistant say *"let me check with the
office"* instead of guessing. A wrong answer reaches a prospect; a missing one does
not.

### Ten rules

1. **Never blend two sources.** If a tour label says 700 sq ft and the website says
   more than 715, the answer is not 707 and it is not "about 710." It is
   `CONFLICTING`, with both claims and both paths.
2. **Never carry a number between properties.** Solo's $300 pet fee tells you nothing
   about Skyline's.
3. **A range is not an answer.** `$75–99` or `15–20% premium` gets recorded as a range
   and marked unresolved. Do not average it. A range once became "$75, 99" in a live
   message and made a real fee unreadable.
4. **Check that each document's content matches its filename.** A file named as one
   property's lease template turned out to be a different property's lease, for
   another address and term. Report any mismatch you find as a finding in its own
   right.
5. **Record a digest for every source you rely on** — SHA256 if you can compute it,
   otherwise file size + last-modified. A filename and a date are not identity.
6. **Prefer the dated and current-titled document.** A file titled "Current Pricing &
   Specials July 2026" outranks an undated one. Say which you used and why.
7. **Do not use anything in §4.** If you find something on that list, note that you
   found it and moved on — do not silently skip it, because a rejection nobody records
   gets re-ingested by the next person.
8. **Website text is a candidate, never an authority,** for money, availability,
   specials, camera counts, safety, or blanket claims ("every unit has a balcony").
9. **Never answer anything in §9.** Those are not gaps to fill.
10. **Mark what a number establishes**, not just its value: `exact`,
    `approximate`, or `marketing_range`. A Matterport *labelled* 590 sq ft is a label,
    not a measurement of any specific apartment.

### Return format — one row per finding

```text
property        Solo | Skyline | Greenery
fact_key        from §6, exactly as written — do not invent a key
category        from §3
status          FOUND | CONFLICTING | MISSING
answer          plain words, as a person would say it. Not a sentence for a bot.
amount          the number alone, if this is a money row
amount_basis    one_time | monthly | per_unit | per_occupant | percent
precision       exact | approximate | marketing_range
source_path     full path in the library
source_class    from §3
source_digest   SHA256, or size + last-modified
effective_date  the date the document speaks as of
page_or_section where in it
notes           anything the next reader needs, including a filename mismatch
```

For `CONFLICTING`, return **one row per claim**, same `fact_key`, each with its own
source. Do not add a row that resolves them.

### Also report these, separately from the worklist

The worklist is what we know to ask for. These are what a scrub is uniquely good at
finding, and none of them fit a row:

1. **A fact worth having that has no row in §6.** Return it with a proposed
   `fact_key` and say it is new. Do not force it into an existing key.
2. **Anything that contradicts a row already marked ✓.** An established fact being
   wrong is more urgent than a missing one, because it is already being said to
   prospects.
3. **Any document whose content does not match its filename** (see rule 4). This is
   how the mislabeled lease was caught.
4. **Any document that looks authoritative and is not dated.** Undated pricing,
   undated policy, undated FAQ — note it, because the next reviewer will trust it.
5. **Documents you expected and could not find.** "No current move-in procedure
   exists for Skyline in the retained set" is a finding, not a blank.
6. **Duplicate or near-duplicate documents** with different contents — two versions
   of the same handbook, two pricing sheets for the same month.

---

## 2. The two halves — what belongs here and what does not

This line is load-bearing. Getting it wrong is how a chatbot ends up quoting a stale
rent.

```text
BELONGS HERE — curated, stable, human-confirmed
  descriptions · layouts · amenities · dimensions · media · neighborhood
  policies · process · fee AMOUNTS that are governed and confirmed
  move-in guidance · package handling · positioning

STAYS GOVERNED ELSEWHERE — read live, never curated
  exact availability        which apartments are open, right now
  asking rent per unit      read from the live system
  readiness / turn status
  screening decisions
  executed lease terms
  legal and accommodation decisions
```

**Never curate availability.** If you find a document that says "availability as of
[date]", that is a snapshot, not a fact — record it as a `MISSING` for availability
with a note. One already exists in the Solo library ("reflects the property's May 31,
2026 operating report") and it is months stale.

---

## 3. Vocabularies — use these exact words

**`category`** — one of seven:

```text
identity · money · policy · process · property · media · positioning
```

**`source_class`** — where the evidence came from:

```text
management_policy   handbook, field guide, community policies, SOPs
pricing_sheet       dated marketing pricing and specials
crm_faq             CRM-maintained answers
lease_document      the executed lease, a blank master, or an addendum
operator_assertion  a staff member stated it; name them and the date
regulatory          a jurisdictional requirement
website             public page — candidate only, never authority for money
```

**`precision`** — what the number establishes: `exact` · `approximate` ·
`marketing_range`.

---

## 4. Do NOT use as current leasing truth

Recorded so nobody re-ingests them. If you encounter one, note the encounter.

| Source | Why |
|---|---|
| 2023 investor-update occupancy, average-rent and demographic statements | Stale, and demographics are never a leasing fact |
| The offline May 2026 app snapshot | Stale occupancy and resident data |
| The file named as the Greenery lease template | It is a **Tower Place** lease, for another address and term |
| Any "Repaired" copy of the Skyline lease | Different fee fields; must not supersede the pinned master by filename or date |
| Website dollar amounts, rent specials, stale leasing seasons | Candidates only |
| COVID-era rules in any FAQ | Superseded |
| Website camera counts, safety claims, "every unit has a balcony" | Unverifiable or contradicted by the property's own pages |
| Historical executed leases | Prove property identity only, not current terms |
| The retained REO workbook | Confirms addresses only. Financial values are **not** a leasing source |
| Any exact-home photo, plan, dimension or tour association not mapped to canonical inventory | Cannot be attached to a real apartment |

---

## 5. Where to look

### Solo — SharePoint "4233 Chestnut (SOLO)"

```text
01. Training & Resources / 2026 Field Guide.pdf
01. Training & Resources / 02. Leasing Process / SOPs        lead mgmt; application & screening
00. All Templates / 03. Move-Ins / 03. SOLO Move-In Guide.pdf
00. All Templates / 07. Resident Resources / Community Policies.pdf
00. All Templates / 02. Letter Templates / Welcome Letter     per-unit PDFs — standardized fields only
03. Leasing & Marketing / Current Pricing & Specials July 2026.pdf
```

### Skyline

```text
The original lease template is the governing master.
  Retained SHA256 begins 6efa35f and ends 36a635.
  A newer "Repaired" file has different fee fields and must NOT supersede it.
  → Confirm the original is still the approved master; capture its effective date
    and approver.
Public pages: home · amenities · two-bedroom · three-bedroom · apartment gallery ·
  neighborhood · international-student and arrival · FAQ · contact
Matterports: M7Lgne1gA72 · 3bM9GESQ7o2   (one labelled 590 sq ft)
```

### Greenery

```text
NO approved blank master is established. This is the top priority for this property.
  → Find the current approved blank lease + addenda, with effective date and signer.
  → The file named "Greenery Lease Template" is NOT it (see §4).
Public pages: home · amenities · studio · one-bedroom · two-bedroom · neighborhood ·
  international-student and arrival · FAQ
Matterports: H8eLkJVRrQT · D3SQQ8uqFix   (junior 1BR, and 2BR/2BA)
```

### Cross-property

```text
OneDrive lease-source review, 8 September 2026    preserves the Skyline master,
                                                  rejects the mislabeled Greenery file
Recorded operator interview, 15 September 2026    source_class = operator_assertion
```

---

## 6. The worklist

`✓` established · `⚠` established but flawed, see §7 · `—` missing

### 6.1 Tier 1 — the property cannot talk to a prospect without these

| `fact_key` | What to find | Solo | Sky | Green |
|---|---|---|---|---|
| `building_identity` | Legal/marketing name, full street address, ZIP, neighborhood | ✓ | ✓ | ✓ |
| `office_contact` | Leasing email, phone, office hours + timezone | ✓ | — | — |
| `communication_line` | The number a prospect texts; monitored after hours or not | ⚠ | — | — |
| `pricing_authority` | **Which source wins when the pricing sheet and the live system disagree** | — | — | — |
| `process_tour` | Where tours start, what they cover, how booked, hours, notice required | ✓ | — | — |
| `process_screening` | Credit / income / background criteria, income or guarantor standard, decision window | ✓ | — | — |
| `process_required_documents` | Exact document list + accepted alternates + international path | ✓ | — | — |
| `process_lease_terms` | Every term offered; whether 12 months exists; short-term premium **as one number** | ⚠ | — | — |
| `fee_application` | Amount, refundable or not, per applicant or per unit | ✓ | — | — |
| `fee_admin` | Amount, when charged, at renewal too or not | ✓ | — | — |
| `fee_amenity` | Amount at move-in, amount at renewal | ⚠ | — | — |
| `fee_security_deposit` | Amount or formula, and the guarantor effect on it | ⚠ | ⚠ | — |
| `policy_pets` | Fee, monthly rent, **weight limit, breed restrictions**, where they may go | ⚠ | ⚠ | ⚠ |
| `policy_utilities` | Included vs billed, who bills, enrollment sequence | ✓ | ⚠ | ⚠ |
| `policy_renters_insurance` | Required or not, minimum liability, who must be named | ✓ | — | — |

### 6.2 Tier 2 — asked constantly

| `fact_key` | What to find | Solo | Sky | Green |
|---|---|---|---|---|
| `policy_parking` | Assigned or not, waitlist, guest parking, street reality | ✓ | — | — |
| `fee_parking_monthly` | Amount | ✓ | ⚠ | — |
| `concession_current` | The special, the terms it applies to, **and the date it ends** | ⚠ | — | ⚠ |
| `policy_rent_payment` | Due date, grace period, late fee and how calculated, how to pay | ✓ | — | — |
| `process_move_in` | Hours, check-in point, what must be paid and when, what releases keys, unloading, elevators, after-hours and who authorizes | ✓ | — | — |
| `amenities` | What exists and where — by floor if that is how it reads — hours, guest and reservation rules, access | ✓ | ⚠ | ⚠ |
| `unit_features` | **Appliances, laundry, HVAC — what is inside the apartment** | — | ✓ | ✓ |
| `policy_noise` | Posted quiet hours | ✓ | — | — |
| `policy_guests` | Limits in units and amenity spaces, escort rules, maximum stays | ✓ | — | — |
| `policy_smoking_and_restrictions` | Smoke-free or not, prohibited items, fire-safety list | ✓ | — | — |
| `furnished_options` | Which homes, exactly what is included, price difference | ⚠ | ✓ | ⚠ |
| `fee_telecom` | Provider, speed, monthly charge, optional or bundled | ✓ | ⚠ | ⚠ |
| `fee_access_replacement` | Fob, key, lockout charges, office-hours help | ✓ | — | — |
| `package_handling` | Who receives, where, notification, after-hours, third-party couriers, loss and escalation wording, packages sent before move-in | — | ⚠ | ⚠ |

### 6.3 Descriptive shelves

| `fact_key` | What to find | Solo | Sky | Green |
|---|---|---|---|---|
| `positioning` | The one-sentence pitch, the **three strongest reasons** a prospect chooses it, the **honest tradeoffs** they should understand before touring | — | ✓ | ⚠ |
| `layouts` | Every marketing layout name, bed and bath count, how many apartments in each, mapped to the canonical unit type | — | ⚠ | ⚠ |
| `dimensions` | Verified square footage and bedroom dimensions per layout — or leave unknown. Name the measured plan, drawing or apartment behind each figure | — | ⚠ | ⚠ |
| `media` | Every approved photo set and diagram mapped to layout and canonical type; each marked photograph / rendering / measured plan / diagram; each marked exact-home or representative; outdated assets identified | — | ⚠ | ⚠ |
| `virtual_tours` | Which layout each tour actually shows; whether a tour exists for every layout; the disclosure that must accompany each link | ⚠ | ⚠ | ⚠ |
| `neighborhood` | Five places staff **actually** recommend and why; walking and transit facts; most-asked campus destinations. Approximate is fine and must be said | — | ✓ | ⚠ |
| `policy_unit_transfers` | Transfers allowed, fee, timing; subletting allowed, approval path, fee | ⚠ | — | — |

### 6.4 Student market — all three properties are campus-adjacent

| Question | What to find | Solo | Sky | Green |
|---|---|---|---|---|
| Lease a bedroom or the whole apartment? | Per-bed or per-unit | — | — | — |
| One lease or separate? | Joint or several liability; is each roommate screened | — | — | — |
| Do you match roommates? | Yes/no, how, **and the fair-housing review on the matching questions** | — | — | — |
| Academic-year leases? | Terms aligned to a school year, if any | — | ⚠ | — |
| No credit / international? | Guarantor policy, international path, what substitutes for credit | ✓ | — | — |
| Parents cosigning? | Cosigner process, what they supply | — | — | — |
| Paying with financial aid? | Whether aid timing is accommodated; who rent is paid to | ✓ | — | — |
| How far is campus? Shuttle? | Distance and transit facts you can stand behind | — | ✓ | ⚠ |

### 6.5 Legal weight — per property, from someone who knows the jurisdiction

**Never infer these, never quote a statute, never carry one property's answer to
another.** Each needs `source_class = regulatory` or `lease_document`.

| Question | Solo | Sky | Green |
|---|---|---|---|
| Do you accept housing vouchers / source-of-income? | — | — | — |
| Maximum occupancy per unit? | — | — | — |
| Deposit return timing and any cap? | — | — | — |
| Notice period to vacate? | — | — | — |
| Late fee — amount and any regulated ceiling? | ⚠ | — | — |
| Accommodation request process? | — | — | — |
| Assistance animals (service + ESA) — documented process | ✓ | — | — |

Solo states a 10% late fee after a grace period through the 5th, sourced as management
policy. **Whether that is lawful in Philadelphia is a jurisdiction question**, and the
answer should be re-sourced as `regulatory` or `lease_document`.

### 6.6 Service, escalation and routing

| Item | Solo | Sky | Green |
|---|---|---|---|
| Emergency-maintenance definition | — | — | — |
| Routine-service expectation, and peak-turn exceptions | — | — | — |
| 24/7 contact method | — | — | — |
| Trash and recycling locations and instructions | — | — | — |
| Who receives new leads | — | — | — |
| Who covers after-hours inquiries | — | — | — |
| Which phone and email a prospect should see | ✓ | — | — |
| Definitions of pending / needs review / occupied / available / ready, and the authoritative system for each | — | — | — |

---

## 7. Known conflicts — carry these forward, do not resolve them

Each of these is already investigated. **Do not re-resolve from memory, do not publish
a blended number, do not quietly pick one.** Return both claims; an owner rules.

### Solo

| Conflict | The two claims |
|---|---|
| **Pricing sheet vs the live system** — the single most important open ruling | Sheet: studio $1,450–1,600, 2BR $2,600 gross / $2,384 net. Live: studio 530 quoted **$1,687** (matches nothing on the sheet — 5th floor odd-numbered permits only +$50, so $1,500 or $1,650), 2BR quoted **$2,700** |
| Deposit, amenity fee and pet fee | Disagree across **three** sources: the agent fact seed, the legacy seed file, and the property's own CRM FAQ. Until an owner designates the authority, fee answers must defer |
| Concession has no end date | The text says one month free on a one-year lease expiring July 2027, and separately that "concessions change month to month." No expiry is recorded, so it never stops being quotable |

### Skyline

| Conflict | The two claims |
|---|---|
| 3BR model 16 bath count | Official three-bedroom page: **two** bathrooms. Operator interview: **1.5**. Approve neither until reconciled |
| Saturday and package hours | FAQ, contact page and interview disagree. Removed from the live answer. Use the current operating schedule, not a website guess |
| Dimensions | One representative 2BR/1BA Matterport is **labelled** 590 sq ft. That label is not a measurement of any specific apartment |

### Greenery

| Conflict | The two claims |
|---|---|
| Junior 1BR size | Matterport label **700** sq ft vs website **more than 715** |
| 2BR/2BA size | Matterport label **1,032** sq ft vs website **more than 1,050** |
| Balconies | Studio page says one studio has a balcony and one does not. Another page claims a balcony for **every** unit |
| 02/16 bedroom count | The page conflicts with itself |
| Utility back-bill fee | Interview says **$25** in one place and **$35** in another |

---

## 8. Money and lease source review

Confirm each from the current approved pricing sheet, lease, addendum or written
policy. **Do not approve a dollar amount from memory.** Live offers and availability
keep coming from the governed records, not from here.

| Item | Solo | Skyline candidate | Greenery candidate |
|---|---|---|---|
| Application fee | $50 | unknown | unknown |
| Admin fee | $99 per unit, move-in and renewal | none reported | unknown |
| Amenity fee | $250, $150 at renewal | — | unknown |
| Deposit | $1,000 or up to one month, "subject to conditions" ⚠ | one month with guarantor / two without | unknown |
| Utility charge and billing | Conservice, split among roommates | $500 per bedroom, one-time or spread | $200 studio / $250 1BR / $300 2BR monthly |
| Utility back-bill fee | — | unknown | **conflict: $25 vs $35** |
| Internet | Flume, 1GB, $40/mo | bundled, provider unknown | "already set up", provider and charge unknown |
| Parking | $300/mo assigned, waitlist may apply | $150/mo, availability unknown | assigned garage, charge unknown |
| Furnishing charge | all-inclusive packages exist | furnished; separate charge not established | optional; package and charge unknown |
| Pet fee / pet rent | $300 + $30/mo, **no weight or breed limit recorded** | $30 reference unclear | website and interview conflict |
| Short-term premium | 15–20% **range** ⚠ | +$50 | unknown |
| Current concession | 1 month free, one-year lease expiring July 2027, **no expiry recorded** | interview says none — verify published pricing | website specials stale, not authoritative |
| Lease lengths | ~12 months on a late-July cycle | semester / full-year candidates | unknown |
| Rent due, grace, late fee | 1st, grace through 5th, 10% | use current lease | use current lease |
| Renter's insurance | $100k liability, "4233 Chestnut LLC" named, $15/mo option | use current lease | use current lease |

---

## 9. Never answer these — they are not gaps

As important as everything above.

| Asked as | Why it is not a fact | Say instead |
|---|---|---|
| "What kind of people live here?" · "Is it mostly students?" · "What's the crowd like?" | **Resident characterization.** Already ruled: *"a nice, comfortable crowd"* is unsendable; *"it rarely feels packed"* is fine. How full a room is, is an observation. What the people in it are like, is not | Describe the building |
| "Are kids okay?" · anything touching race, religion, national origin, disability, familial status | Protected class. A counter-question reads as hedging, and **hedging on a protected class is the failure** | Affirm first — the word "okay" gets answered before anything else — then help |
| "Is the neighborhood safe?" · "Is there crime?" | No fact answers it honestly and a reassurance is a liability | What the building has: fob access, staffed hours, cameras **only if they are verified** |
| "Roughly how much is electric?" | Who bills it is a fact. What it will cost is not | Who bills it, and that usage varies |
| Any fee not in the confirmed set | An unrecorded fee is a defer. Never estimate it, never infer it from a similar fee, never carry it from another building | "I want to give you the exact number — let me confirm with the office," then keep going |
| "Which exact apartment is in this photo/tour?" | Unless the asset is mapped to canonical inventory, it shows a **layout** | "Same floor plan — not the specific apartment" |

---

## 10. Sign-off — per property, not per packet

An approval covers only what is marked found or corrected. Unknowns stay unknown.

```text
Property
Reviewed by                     name, date
Final accountable approver      name, role, date
Knowledge steward               name and role — who keeps this current
Next review date
Review cadence
Governing lease master          filename + digest + effective date + approver
```

**Every fact needs a steward, not just an approver.** Approver answers *who said this
is right*; steward answers *who keeps it true*. A fact with no steward is an unowned
claim being made to prospects.

Two dates, and they are different:

```text
effective_until   the date this stops being true       (a concession has one)
next_review_at    the date somebody must look again    (an amenity list has one)
```

**Replace or retire an old claim. Never silently edit it.**

---

## 11. After the scrub comes back

```text
1.  Load every FOUND row against its fact_key. Nothing goes live on insertion —
    a fact becomes quotable only when a human confirms it.
2.  Load every CONFLICTING row as BOTH claims, marked conflicting. The agent stays
    silent on it, and the investigation is not lost.
3.  Leave every MISSING row missing. That is what makes the agent defer.
4.  Freeze the vocabulary against all three properties at once — a vocabulary
    derived from one property is a guess.
5.  No property goes live until its Tier 1 rows (§6.1) are all found or
    deliberately ruled as deferrable.
```

Nothing in §6.1 marked `—` may be guessed to get a property live sooner. The Solo
overquote is what that costs.
