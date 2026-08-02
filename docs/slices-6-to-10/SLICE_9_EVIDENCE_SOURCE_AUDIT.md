# Slice 9 — Evidence-Source Audit (first deliverable)

**Date:** 2026-08-01
**Branch:** `claude/slice-9-evidence-audit`
**Base SHA:** `afd1ef1493f7b329ec19997c02ccd37b8fb367f9` (current `main`)

Branched from `main`, **not** from PR #25. Contains no Slice 8 code and does not
depend on it. Audit only — no migrations, no endpoints, no ingestion, no app
changes, `agent.js` untouched.

**Evidence basis:** source and schema read at the base SHA. Live row counts are
carried from the Slice 7 audit (Demo Building, 2026-07-31); this session has no
production credentials, so nothing here claims a fresh production query.

### Files and objects reviewed

```
migrations/001, 002, 033, 038, 039, 047, 054, 061, 062, 063, 092, 094, 101–103
src/money/market_evidence_contract.js      src/money/effective_pricing.js
src/money/pricing_lifecycle.js             src/money/commitmentledger.js
src/money/pricing_rehearsal.js             src/money/pricing_decision_packet.js
src/leasing/leasingleads.js                src/leasing/leasingconversion.js
src/leasing/renewals_read.js               src/shared/property_timezone.js
src/agent/agent.js (read only)             src/agent/pricing_adapter.js
```

---

## Domain classification

Corrected 2026-08-01 on owner review. The first draft of this audit said "four
of six do not exist" while naming only three — an inaccurate headline the rest
of the document does not support. The accurate classification is:

| Classification | Domains |
|---|---|
| **Absent** | Rent Survey · Listings · Market Context |
| **Partial** | Lead Demand · Conversion |
| **Live but timezone-blocked** | Tour Demand |

## Headline findings

1. **Three of the six domains are absent.** Rent Survey, Listings, and Market
   Context have **no table, no route, no integration, no fixture** — not even
   scaffolding. Only a deliberate contract seam exists.
2. **Tour Demand is the strongest evidence source in the product** and is
   already canonical — but it is **blocked by a missing timezone**, so no
   operating-date metric can be defined for any property except one.
3. **Lead Demand is half-real.** Volume and source attribution are canonical
   facts. Unit-type, price-range and date-window interest exist only as
   **free text**, so every demand dimension the spec asks for would be
   *inferred*, not captured.
4. **Only one of the four conversion funnels exists**, and it publishes two
   different numbers under one field name.
5. **The evidence-authority boundary holds.** No evidence source can write
   governed economics. Proven below.

---

## Source / provenance matrix

| Domain | Source system | Live / fixture / seam / absent | Classification | Write authority |
|---|---|---|---|---|
| **Rent Survey** | none | **absent** (seam only) | `contract seam only` | none |
| **Listings** | none | **absent** | `unsupported` | none |
| **Lead Demand — volume & source** | `leasing_leads`, `lead_sources`, `lead_source_touches` | **live** | `canonical internal fact` | intake path |
| **Lead Demand — intent dimensions** | `person_attributes` | **live but untyped** | `operator-entered evidence` | form / AI / human |
| **Tour Demand** | `leasing_tours` + 11 companions | **live** | `canonical internal fact` | booking path |
| **Conversion** | `leasingleads.js` report route | **live, partial** | `derived metric` | read-only |
| **Market Context** | none | **absent** | `unsupported` | none |

### Live-vs-fixture inventory

**No fixture-backed evidence surface exists.** There is nothing to remove. The
three unbuilt domains render honest "Not connected" panels (Slice 7), which is
the correct state and should be preserved until real ingestion exists.

---

## 1. Rent Survey — `contract seam only`

**Nothing stores competitor, address, unit type, bed/bath, square footage,
asking rent, effective rent, concession, availability, observed_at, source, or
confidence.** Schema sweep for `survey`, `comp*`, `competitor` returns no table.
(`work_completion_claims` matches `comp` incidentally and is maintenance.)

The one artefact is `src/money/market_evidence_contract.js`, and it is
deliberately inert. Its own header:

> "CONTRACT ONLY. No Rent Survey, no scraping, no competitor records, no
> storage, no automated pricing change… proves the pricing service can DISPLAY
> such an observation while being structurally unable to CONSUME it."

It contains **zero** write statements (verified). The direction it enforces —
`market evidence → management judgment → published pricing` — is the correct
spine for Slice 9 and should be built onto, not replaced.

**There is no "survey screen".** Not live, not fixture-backed, not scaffolding.

**Classification:** `contract seam only`. Requires **external integration**.

---

## 2. Listings — `unsupported`

No table, route, service, integration, or fixture. Sweeps for `listing`,
`syndicat`, and channel tables return nothing.
(`property_channel_capabilities` (094) is **SMS/communication** channels — its
`channel` column is documented as "'sms' today" — not listing syndication.)

**Property Spine currently cannot distinguish any of the seven required listing
states:** configured, submission attempted, accepted by channel, confirmed
live, rejected, stale, unverified. It cannot express even the first.

The only listing-adjacent fields are `leasing_leads.source_listing_id` and
`source_lead_id` — free-text identifiers **received from an inbound ILS lead**.
They are evidence that a listing existed somewhere, not evidence Property Spine
published one, and they must never be read as listing state.

**The trap to legislate now:** an attempted publication must never be recorded
as a confirmed live listing. Since nothing exists, this is cheap to get right —
model the state machine first and let "confirmed live" require channel
acknowledgement.

**Classification:** `unsupported`. Requires **external integration**.

---

## 3. Lead Demand — split classification

### Genuinely captured today (`canonical internal fact`)

`leasing_leads` (038): `person_id`, `property_id`, `unit_id`, `source_id`,
`source_lead_id`, `source_listing_id`, `status`, `received_at`,
`first_response_at`, `tour_scheduled_at`, `human_takeover_at`, `raw_payload`.

`lead_sources`: `name`, `source_type` (`ils|website|paid_ad|organic|manual`),
`monthly_cost`, `is_active`.

`lead_source_touches` (038:100): every external touch — **attribution lives
here**, and a returning prospect adds a touch rather than a duplicate
opportunity. This is a well-designed dedup boundary and should be the
denominator authority for Slice 9.

So **new leads**, **lead source**, and **date window** (via `received_at`) are
real, typed, timestamped facts.

### Would be inferred, not captured (`operator-entered evidence`)

**Unit-type interest** and **price-range interest** exist only in
`person_attributes` (061), whose `attr_key` vocabulary is
`move_month | budget | unit_type | occupants | pets | reason` — but whose value
column is:

```sql
attr_value text not null,   -- short human-readable value, verbatim-ish
```

It is **free text**, sourced `form | ai_conversation | human`, one active row
per key with history retired rather than overwritten. Excellent provenance;
useless for aggregation without parsing.

**Consequence:** any "demand by unit type" or "demand by price band" metric
would require interpreting free text such as *"2 bed maybe 3"* or *"around
$1,800 ish"*. That is **inference presented as measurement** and is exactly
what §5 forbids.

**The spec's own rule applies and is currently satisfiable only in the negative:
message volume alone is not lead demand.** Today, volume plus source is all
that can be honestly reported.

---

## 4. Tour Demand — `canonical internal fact`, blocked by timezone

### Support is genuinely strong

`leasing_tours` status vocabulary (widened by 039, verified against the live
CHECK constraint):

```
requested · scheduled · confirmed_by_prospect · checked_in
completed · no_show · cancelled · rescheduled
```

Plus `no_show_at`, `cancelled_at`, and **`rescheduled_from uuid references
leasing_tours(id)`** — a real reschedule chain, not a flag. Eleven companion
tables exist including `tour_events`, `tour_outcome_prompts`,
`tour_units_shown`, `scheduled_tour_revisions`, `tour_booking_links`.

039's doctrine is already the right one: *"A scheduled tour is a CLAIM. A
completed tour is PROOF. A no_show is EXPOSURE."*

So **scheduled, completed, canceled, no-show, rescheduled, and outcome capture
are all canonically supported.** Application attribution is supported through
`leasing_leads.id` (the opportunity key Slice 8 and the AI strategy rail also
use).

### The blocker: there is no property timezone

**`properties` has no timezone column.** Verified: zero `timezone` references
across all migrations.

`src/shared/property_timezone.js` resolves it from a **hardcoded allowlist of a
single property UUID** (Demo Building → `America/New_York`) plus a
`PROPERTY_OPERATING_TZ_JSON` env map for QA rigs. Every other property returns
**null**, and the module is explicit that callers must refuse on null:

> "An UNCONFIGURED property gets an HONEST NULL — never an invented day, never a
> silent default. Callers must refuse."

**Consequence for Slice 9:** an *operating-date* definition — "tours completed
today", "no-shows this week" — is **undefinable for every property except Demo
Building**. Any daily/weekly tour-demand metric built now would either be
UTC-bucketed (wrong near midnight, wrong for every property) or would have to
report honestly unavailable almost everywhere.

**This is the single highest-value unblock in Slice 9 and it is small:** a real
`properties.operating_timezone` column with the resolver reading it, allowlist
retained only as fallback. It is a prerequisite, not part of evidence ingestion.

### Reschedule deduplication

`rescheduled_from` makes the chain traversable, but **no canonical rule exists**
for whether a rescheduled tour counts as one demand event or two. Slice 9 must
author it. Recommendation: count the **chain**, not the rows, keyed on the root
tour; report reschedule count separately as an operational signal.

### Missing-outcome treatment

`tour_outcome_prompts` exists (and Slice 4 built capture around it), so a
missing outcome is *detectable*. Slice 9 must decide whether a completed tour
with no captured outcome is excluded from conversion denominators or counted as
an explicit unknown. **Recommendation: explicit unknown, never silently
dropped** — dropping flatters the funnel.

---

## 5. Conversion — one funnel of four, with two definitions under one name

### What exists

Exactly one route computes conversion:
`GET /properties/:propertyId/leasing/report` (`leasingleads.js:1291`).

It publishes `lead_to_tour_pct` twice, from two deliberately different
populations — the code says so:

```js
// by_source = RAW touches (marketing view, cost-per-tour);
// totals    = DEDUPED humans through the funnel (conversion truth). Both true.
```

| | `by_source` | `totals` |
|---|---|---|
| Numerator | `count(distinct lt.lead_id)` | `count(lt.lead_id)` |
| Denominator | `count(distinct t.lead_id)` over `lead_source_touches` | `count(*)` over `leasing_leads` |
| Population | leads **with** a source touch | **all** leads for the property |

Both are defensible. **The defect is that they share a field name.** By-source
rows therefore do not sum to the total whenever a lead has no source
attribution, and a reader has no way to know which definition they hold.

The tour filter is `status in ('scheduled','confirmed_by_prospect','checked_in',
'completed')` — valid against the 039 vocabulary (checked), and notably it
counts a *claim* (`scheduled`) as a tour, which disagrees with 039's own
doctrine that only `completed` is proof.

### What does not exist

**No metric anywhere computes tour → application, application → approved, or
approved → executed.** The underlying facts exist —
`lease_applications.status` is
`draft|submitted|approved|lease_ready|tenant_signed|countersigned|active|declined|withdrawn`,
and `executed_lease_records` (088) is canonical — but nothing joins them into a
funnel.

### Metric specification status

For the one metric that exists:

| Required field | Present? |
|---|---|
| numerator | implicit in SQL, undocumented |
| denominator | **two competing**, same name |
| window | **none — all-time, unbounded** |
| `as_of` | **absent** |
| population exclusions | none stated |
| deduplication key | `lead_id` (by_source) / none (totals) |
| definition owner | **absent** |
| definition version | **absent** |

**Every conversion metric in Slice 9 must carry all eight.** None does today.

---

## 6. Market Context — `unsupported`

No source for new supply, seasonality, university calendar, major-employer
events, regulatory events, or competitor openings. Sweeps return nothing.
(`supply_requests` (002) is maintenance supplies — `item`, `work_order_id`.)

**The classification hazard here is the sharpest of the six.** Market context is
where objective sourced fact and subjective operator commentary are easiest to
blend. A university's published academic calendar is an objective external
fact with a citable source. "This block is getting nicer" is commentary, and if
stored beside the calendar in one `market_context` table it acquires unearned
authority.

**Recommendation:** if built, keep two separate stores with different
classifications, and never let commentary satisfy a provenance requirement.

---

## 7. Fair-housing review

**Schema is clean.** No demographic, protected-class, neighborhood-quality,
desirability, or familial-status column exists in any migration. (Sweep hits on
`race` are the phrase "race condition" in concurrency comments.)

**One live guard exists**, in `agent.js` — pre- and post-generation risk
routing, described as "conservative risk-routing control (v1)". It hard-blocks
subjective area characterisation:

```
/\b(good|bad|safe|dangerous|rough|sketchy|nice|great)
  (neighborhood|area|part of town|block|side of town)\b/  → fairhousing:neighborhood_character
```

and hard-routes legal/discrimination language to a human. The system prompt
carries an explicit FAIR HOUSING section forbidding claims that an area is
"ideal for a type of person."

**Must remain excluded in Slice 9:** demographic desirability, protected-class
segmentation, neighborhood quality rankings, family-status targeting,
protected-class proxy scoring.

**The proxy risk is the real one.** Slice 9's domains create new proxy
opportunities that do not exist today: school-quality scores, "family-friendly"
tags, university-proximity weighting that becomes age segmentation, and
employer-based targeting. A Rent Survey that stores a competitor's
"neighborhood grade" imports a protected-class proxy wearing a market label.

**Recommendation:** any market-context or survey field must pass an explicit
allowlist, not a denylist. Objective location facts (distance, transit line,
school *district boundary* as a fact, not a *rating*) may be retained with
provenance and stated operational relevance.

---

## 8. Evidence-authority boundary — **PROVEN: no evidence source can write economics**

Complete set of writers to governed economics tables
(`property_pricing_versions`, `pricing_terms`, `concession_policies`):

```
src/money/commitmentledger.js    — the Tier-1 ledger service
src/money/pricing_lifecycle.js   — saveDraft / submitReview / publishVersion
src/money/pricing_rehearsal.js   — rehearsal, rolled back
```

No other module writes them. `market_evidence_contract.js` contains **zero**
write statements.

| Can an evidence source… | Today |
|---|---|
| publish pricing | **no** |
| approve pricing | **no** |
| modify a concession | **no** |
| change an application term | **no** |
| change a renewal offer | **no** |

The expected answer is confirmed in every case. Slice 9 must not weaken this:
evidence informs a governed decision; it never becomes economic authority.

---

## 9. Competing metric definitions

| Metric | Where | Conflict |
|---|---|---|
| `lead_to_tour_pct` | `leasingleads.js:1335` vs `:1351` | Same name, two populations (raw touches vs deduped leads). Intentional and documented, but indistinguishable to a consumer. |
| "a tour" | `leasingleads.js:1296` vs `039_tour_scheduling.sql:9` | Report counts `scheduled` as a tour; 039 doctrine says only `completed` is proof. |
| "a lead" | `lead_source_touches` vs `leasing_leads` | Touch-level vs opportunity-level. Both legitimate, neither named. |

No conflict was found between API and app or reports — because **no other
surface computes conversion at all**. That is the reason for the absence, not
evidence of discipline, and it will stop being true the moment Slice 9 ships a
second consumer.

## 10. Missing canonical correlations

- **Tour → application.** No FK from `lease_applications` to `leasing_tours` or
  to the tour's `leasing_lead_id`. Attribution can be reached only through
  `leasing_leads.id`, and only when the application carries it.
- **Listing → lead.** `source_listing_id` is external free text with no
  internal listing to join to.
- **Evidence → decision.** No table records that a pricing decision *considered*
  a piece of evidence. Ruling 5 of Slice 8 (snapshot on commitment) is the
  pattern to reuse.
- **Operating date → anything.** Absent a property timezone, no event can be
  assigned to a business day.

---

## What can be built from existing truth, today

1. **Tour demand counts by status** — scheduled / completed / no-show /
   cancelled, with the reschedule chain collapsed. Canonical and honest.
   *Caveat:* period bucketing needs the timezone first.
2. **Lead volume and source mix**, including cost-per-tour, from
   `lead_source_touches` + `lead_sources.monthly_cost`.
3. **All four conversion funnels** — the facts exist end to end
   (`leasing_leads` → `leasing_tours` → `lease_applications` →
   `executed_lease_records`). Only the definitions and the joins are missing.
4. **Response-time metrics** from `first_response_at` (already computed).

## What requires new ingestion (internal)

- `properties.operating_timezone` — prerequisite for every dated metric.
- A typed prospect-intent store, or a governed normalisation of
  `person_attributes` free text into structured unit-type and price-band values
  with the original text retained.
- Tour-outcome completeness classification (`captured` / `explicit unknown`).
- An evidence-consideration record, if evidence is to be shown as having
  informed a decision.

## What requires an external integration

- **Rent Survey** — competitor observations. No internal source can produce it.
- **Listings** — channel publication state. Requires acknowledgement from each
  channel; without that, "confirmed live" is unprovable.
- **Market Context** — university calendars, employer announcements, regulatory
  and permit/new-supply data.

## What should remain unsupported

- Neighborhood quality, desirability, or "area grade" in any form.
- Demand *modeling* or forecasting. Slice 9's mandate is evidence, not
  prediction; a forecast presented beside canonical counts will be read as one.
- Any automated path from an observation to a price.

---

## OWNER RULINGS — settled 2026-08-01

All eight are decided. These govern; the "recommendations" below are the
superseded audit proposals, retained for provenance only.

### 1. Property timezone — approved

Add `properties.operating_timezone`. Nullable · valid IANA only · **no universal
default**. Backfill Demo Building to `America/New_York` only, because that fact
is already explicitly encoded. **Do not guess for any other property.**

Final resolver order:
```
properties.operating_timezone → explicit QA/test override (non-production) → null
```
**After the Demo backfill, remove the hardcoded property-UUID mapping.** Hidden
production configuration is not preserved indefinitely as a fallback.

Every dated metric returns `operating_timezone`, `window_start`, `window_end`,
`as_of`. No configured timezone ⇒ `state: unavailable`,
`reason: property_operating_timezone_not_configured`.

### 2. A scheduled tour is a claim; a completed tour is proof

```
scheduled / confirmed / checked-in → appointment demand and operating pipeline
completed                          → conversion proof
no-show                            → exposure
cancelled                          → lost appointment
rescheduled                        → continuation of the same appointment journey
```
**Lead-to-tour conversion uses completed tours only.** Scheduled tours remain an
important demand metric but must never be called completed conversion.

### 3. Rename both lead-to-tour metrics

`lead_to_tour_pct` is retired. Two distinct codes:

- `attributed_opportunity_to_completed_tour_rate` — denominator: distinct
  opportunities attributed to that source; numerator: those reaching a
  **completed** tour.
- `all_opportunity_to_completed_tour_rate` — denominator: all deduplicated
  opportunities; numerator: those reaching a **completed** tour.

One opportunity may carry multiple source touches, so **source rows may overlap
and must not be presented as additive.** Every response discloses the
attribution model.

### 4. Reschedules count by chain

One root chain = one appointment journey. Return separately:
`appointment_journeys`, `booking_attempts`, `reschedule_count`, `final_status`.
A chain that eventually completes counts as **one** completed journey, not
several tours. A broken, cyclic, or ambiguous chain is reported **untrackable**,
never silently counted.

### 5. Missing tour outcomes are explicit unknowns

A completed tour without post-tour capture **stays in the completed-tour
denominator**, is never silently excluded, carries `outcome_state: "unknown"`,
and feeds a separate capture-completeness metric. Excluding them would
artificially improve conversion reporting.

### 6. Do not parse prospect-intent free text into metrics

Slice 9 Lead Demand is **lead volume · source · received date/window · response
time** only. Free-text `budget` and `unit_type` values are **not aggregated**.
The original text may remain visible as qualitative evidence, but no NLP or
keyword parser may turn *"around $1,800"* or *"2 bed maybe 3"* into a claimed
structured measurement. Typed prospect intent is a separate future design and
migration.

### 7. Slice 9 is internal evidence only

Build **Tour Demand · Lead Demand · Conversion**. Leave **Rent Survey ·
Listings · Market Context** as honest *Not connected*. **No empty future
tables, no sample competitors, no fake listing statuses, no placeholder
integrations.** Those three require separately authorised external
integrations.

### 8. Correlation rule

No conversion attribution via person-name, timing, unit similarity, or browser
heuristics. For tour → application: direct canonical correlation ⇒ countable;
missing correlation ⇒ **untrackable**. Return `correlated_count`,
`uncorrelated_count`, `correlation_rate`. An uncorrelated application stays
visible but is never assigned to a tour funnel by inference.

---

## Required metric contract

Every metric uses one shared server contract:

```
metric_code · definition_version · state
property_id · operating_timezone
window_start · window_end · as_of
cohort_basis
numerator · denominator · rate
deduplication_key · exclusions · unknown_count · untrackable_count
source_tables · provenance
```

**A metric with no valid denominator returns `rate: null`. Never `0%`.**

## Authorised build sequence

```
1. Property operating timezone
2. Shared metric-definition contract
3. Tour Demand projection
4. Lead Demand projection
5. Four conversion funnels
6. Market & Pricing evidence renderer
7. Stop
```

The four funnels:
```
opportunity        → completed tour
completed tour     → submitted application
submitted application → approved application
approved application  → executed lease
```
Each carries its own explicit cohort definition. **The four rates may not be
multiplied or directly compared unless their cohort bases match.**

## UI boundary

Inside Market & Pricing, a `Demand` section containing Lead Demand, Tour
Demand, Conversion. Each metric shows value, numerator/denominator, window,
as-of date, and definition. **Do not add these analytics to the Leasing home
during Slice 9.**

## Fair-housing boundary — allowlist accepted

Permitted: lead count, source, response time, tour status, application status,
execution status, dates and durations.
Prohibited: neighborhood grades, school-quality ratings, family-friendly
classifications, demographic desirability, protected-class segmentation, proxy
scoring.

---

## Superseded audit recommendations (provenance only)

### Owner rulings required before implementation

1. **Property timezone.** Approve adding `properties.operating_timezone` as a
   Slice 9 prerequisite. Without it, no dated evidence metric is definable
   outside Demo Building. *Recommend: yes, first.*
2. **"A tour" — claim or proof?** Does a conversion denominator count
   `scheduled`, or only `completed`? 039's doctrine says completed. The live
   report says scheduled. One must yield. *Recommend: completed is the tour;
   scheduled is demand, reported separately.*
3. **The two `lead_to_tour_pct` values.** Rename both and version them, or
   retire one? *Recommend: rename to `touch_to_tour_pct` and
   `opportunity_to_tour_pct`, and require every metric to carry
   definition_version.*
4. **Reschedule counting.** One demand event per chain, or per booking?
   *Recommend: per chain, with reschedule count reported separately.*
5. **Missing tour outcome.** Excluded from denominators, or counted as explicit
   unknown? *Recommend: explicit unknown — exclusion flatters the funnel.*
6. **Prospect intent.** Do we normalise `person_attributes` free text into
   typed dimensions, or report demand by source and volume only until a typed
   capture exists? *Recommend: report volume and source only; do not parse free
   text into a metric.*
7. **Scope.** Rent Survey, Listings, and Market Context are all external
   integrations. Does Slice 9 include any of them, or does it deliver the
   internal-evidence half (tour/lead/conversion) and leave the three external
   domains as honest "Not connected" until an integration is authorised?
   *Recommend: internal half only.*

---

## Recommended Slice 9 build sequence

Each step independently provable, none touching `agent.js` or governed pricing:

1. **`properties.operating_timezone`** + resolver reads it. Unblocks everything
   dated. Allowlist retained as fallback only.
2. **Metric definition contract** — a shape carrying numerator, denominator,
   window, `as_of`, exclusions, dedup key, owner, and `definition_version`.
   Nothing ships a number without it.
3. **Tour demand read** on that contract — the strongest existing source.
4. **Lead demand read** — volume and source only, per ruling 6.
5. **The four conversion funnels** on the same contract, retiring or renaming
   the current duplicate `lead_to_tour_pct`.
6. **Evidence display seam** in Market & Pricing — render evidence beside
   pricing while remaining structurally unable to consume it, extending
   `market_evidence_contract.js` rather than replacing it.
7. **Stop.** Rent Survey / Listings / Market Context stay "Not connected" until
   an external integration is separately authorised.

**Do not implement from this audit without acceptance.**
