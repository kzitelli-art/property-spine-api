# SLICE 9 — FUNNEL 2 OPPORTUNITY RE-GRAIN

Read-side evidence work. Not a dashboard, not tour analytics, not a leaderboard,
not calendar reporting, not a CRM activity funnel, not a generalized metrics
framework, not a renderer.

---

## 1 · SOURCE AUDIT, BEFORE ANY EDIT

### Identity

| | |
|---|---|
| API `main` | `f85f70b` |
| working branch | `claude/slice-9-demand-evidence-mcxvav` @ `b4ab228` |
| ahead / behind `main` | 41 ahead, 0 behind |
| scratch branch | `63ea8f2` (insurance, untouched) |
| `claude/ask-spine-slice-1` | `17c5a68` — **7 commits ahead of main, NOT landed** |
| `claude/ask-spine-source-audit` | `d2f14c5` — 0 ahead, **landed** |

Ask Spine named-file overlap with this cut: **none.** Its non-doc source is
`server.js`, `src/agent/ask_spine.js`, `src/agent/ask_spine_service.js`, three
`ask_spine_*` tests and one seed tool. This cut touches no file on that list.

### Where Funnel 2 lives today

| | |
|---|---|
| implementation | `src/evidence/conversion.js:150–167` |
| registration | `src/evidence/metric_contract.js:88–94` — `s9.conversion.completed_tour_to_submitted_application.v1` |
| proof | `tests/slice9_evidence_proof.js` §E, §F, §G |
| consumer | `src/evidence/evidence_projection.js:58` → `src/identity/operator.js:1704` (`marketEvidenceProjection`) |

**One route consumer.** No other caller anywhere in `src/`, `server.js` or `tools/`.

### The grain defect, exactly

```js
const f2cohort = journeys.filter(j => j.final_status === "completed" && within(j.completed_at));
for (const j of f2cohort) {
  const linked = (appsByLead.get(String(j.lead_id)) || []).filter(...);
  if (linked.length) { f2num += 1; }
}
```

- **denominator grain: appointment CHAIN** (`root leasing_tours.id`)
- **numerator grain: LEAD** (`lease_applications.leasing_lead_id`)

The two do not agree. Two completed chains for one lead plus one application
produce **two conversions from one application**. `leasing_conversions` — the
durable opportunity — is **never read by Funnel 2 at all**.

### Every non-opportunity key Funnel 2 currently depends on

| use | line | grain |
|---|---|---|
| `tours … lead_id` | 84 | lead |
| `journeys[].lead_id = legs[0].lead_id` | 105 | lead, first-row-win |
| `appsByLead` on `leasing_lead_id` | 152–158 | lead |
| `journeyFinalStatus(legs)` via `tour_demand.resolveChains` | 107 | chain, from `leasing_tours.status` |
| `completedByLead` | 118 | lead (Funnel 1; unchanged by this cut) |

Flattened conversion fields (`tour_outcome`, `origin_tour_id`,
`actual_tour_host_user_id`) are **not** read by Funnel 2 today. That is the one
thing currently right, and it stays right.

### Current pending / unknown / terminal rules

- **pending: none.** Funnel 2 passes no `pending` count at all.
- **unknown: none.**
- **untrackable:** `counts.untrackable = uncorrelatedApps` — applications with a
  null `leasing_lead_id`. That is an *application-coverage* number reported in an
  *appointment-evidence* slot. A category error, not merely incomplete.
- **terminal: none.** No terminal opportunity concept exists here.

Consequence: a completed-tour cohort with unresolved appointment evidence still
publishes a **complete-looking rate**. Nothing is suppressed and nothing is
declared partial.

### SQL snapshot and property scoping

`conversionFunnels` issues five property-scoped queries (`leasing_tours`,
`lease_applications`, `executed_lease_records`, `leasing_leads`,
`lead_source_touches`), all keyed on `window.property_id`, which is
server-derived through `resolveOperatingWindow`. Bounded; no N+1. **That
property must be preserved.**

**Blocker found:** `appointmentJourney()` — the required evidence authority — is
per-opportunity and additionally issues one `scheduled_tour_revisions` query
**per external row inside a loop**. Calling it once per opportunity would be an
N+1 on top of an N+1, which the ruling forbids.

---

## 2 · OLD GRAIN → NEW GRAIN

| | old | new |
|---|---|---|
| row | appointment chain | **durable opportunity** (`leasing_conversions.id`) |
| numerator credit | lead has any submitted application | the opportunity's own application evidence |
| dedup key | `root leasing_tours.id` | `leasing_conversions.id` |
| attribution model | `origin_cohort` (chain) | `deduplicated_opportunity` |
| appointment evidence | `leasing_tours.status` via `journeyFinalStatus` | canonical appointment-journey projection |

Because the denominator, the stage definition, the attribution model **and** the
deduplication key all change, the metric contract requires a **new code**, not a
bumped version of the old one. The v1 code is retired from the response rather
than silently redefined — a chart that switched between them would be comparing
two different populations under one name.

---

## 3 · HOW THE N+1 BLOCKER WAS RESOLVED WITHOUT A SECOND IMPLEMENTATION

Rejected: re-deriving appointment classification inside the funnel. That would
put two copies of "what counts as attended" in the codebase, which is exactly
the drift the appointment authority exists to prevent.

Taken instead: `appointment_journey.js` was split into **material loading** and
**pure projection**, with one projection function and two loaders.

```
projectOpportunity(material, …)      ← THE ONLY classification implementation
   ├── appointmentJourney(q, {opportunity_id})   scoped loader   (unchanged API)
   └── appointmentJourneySnapshot(q, {property_id})  bounded loader, 5 queries
```

`appointmentJourney()` keeps its exact prior contract and its 52/0 proof, which
is what demonstrates the split introduced no drift. The snapshot loader also
**fixes the pre-existing per-row revisions N+1** by batching it.

Snapshot query count is **constant in the number of opportunities**: conversions,
tours, tour_events, scheduled_tours, scheduled_tour_revisions, plus at most one
bounded lookup for reschedule parents outside the property.

---

## 4 · THE OPPORTUNITY-STATE CONTRACT

Eight appointment-evidence states, kept separate because collapsing any two
loses a fact an operator acts on differently:

| state | meaning |
|---|---|
| `conflict` | competing or contradictory attribution — never resolved to a winner |
| `observed_visit` | at least one RECORDED attendance |
| `no_show` | an EXPLICIT recorded no-show |
| `untrackable` | evidence exists but cannot be resolved (cycle, parent outside) |
| `scheduled_future` | scheduled, still ahead of `as_of` |
| `past_unobserved` | scheduled, past, nothing recorded — **never** promoted to no-show |
| `cancelled` | occurrences exist and every one was cancelled |
| `no_appointment` | nothing recorded at all |

Precedence is stated in source, in that order. Because precedence necessarily
hides co-occurring truths, each row also carries independent flags —
`observed_visit`, `future_scheduled_remains`, `past_evidence_unresolved`,
`explicit_no_show` — so "attended once AND has more work booked" stays readable.

`RESOLVED = {observed_visit, no_show, cancelled, no_appointment}`. Only resolved
rows may participate in a complete rate.

### Per-row fields

`opportunity_id` · `property_id` · `context{lead_id, person_id}` (context, never
grain) · `appointment_evidence_state` · the four flags ·
`first_observed_visit_at` · `evidence_sources{chain_count, occurrence_count,
chains[{chain_root_id, source_type, occurrence_count, attribution_basis,
occurrence_ids}]}` · `attribution_coverage{attributed, total, rate}` ·
`conflict_reasons[]` · `untrackable_reasons[]` · `application_link` ·
`submitted_application_ids[]` · `as_of_utc` · `metric_eligible` ·
`ineligibility_reason`.

## 5 · INVARIANTS

**Row.** One row per `leasing_conversions.id`. No occurrence is claimed by two
rows. Every row is walled to the requested property. Attendance is only ever a
recorded observation.

**Aggregate.** The eight population buckets **sum exactly to the row count**
(`reconciles: true`, asserted and independently recomputed in the proof).
Conflict and untrackable rows are counted, never discarded. The rate is `null`
and the state is `partial` whenever unresolved evidence could move the numerator
or the denominator — **and every count survives the suppression**.

Two ways a cohort becomes partial, both counted:
1. a cohort row whose credit is ambiguous, or **whose appointment evidence is
   itself unresolved** — a conflicted opportunity can carry an observed visit and
   still not be settled, because the conflict may resolve elsewhere;
2. a non-cohort row that could still enter it.

## 6 · NUMERATOR LINKAGE

`lease_applications.conversion_id` (FK to `leasing_conversions.id`, migration
051) is the **only** accepted link. `leasing_lead_id` is never used to award a
conversion — only to recognise that an unlinked application *might* belong,
which marks the row `unlinked_application_may_belong` and suppresses the rate.

This is the substantive behaviour change: an application carrying only
`leasing_lead_id` no longer converts anything. That is the defect being removed,
not a regression — crediting by lead handed one application to every chain the
lead ever had.

## 7 · PROOF TOTALS

| suite | result |
|---|---|
| **opportunity funnel (new)** | **69 / 0** |
| evidence projection | 57 / 0 |
| appointment journey | 52 / 0 |
| attribution writers | 29 / 0 |
| attribution backfill | 23 / 0 |
| Slice 9 A–I regression (10 suites) | 526 / 0 |
| **TOTAL** | **756 / 0** |

Bounded snapshot verified: the whole property projects in **6 queries across 6
opportunities** — constant, not per-opportunity.

Two defects were found by this proof and fixed in **source**, not in the
assertions:
1. a conflicted opportunity holding an observed visit entered the denominator as
   though settled, so conflict never made the cohort partial;
2. the complete-rate check passed vacuously on a zero denominator — a clean
   fully-resolved opportunity is now constructed so a real rate (1) is asserted,
   and adding one conflicted row is proven to suppress it again.

## 8 · GAPS ASSIGNED TO THE `lead_events` PHASE

Declared in source as `MISSING_CANONICAL_FACTS`, exposed rather than solved:

1. **terminal opportunity truth** — an opportunity with no visit and no future
   appointment cannot be split between "still live, nothing booked" and "over,
   never toured". Forbidden workaround: reading `leasing_leads.status`.
2. **pending opportunity truth** — without it a young opportunity and a dead one
   are the same row. Forbidden workaround: elapsed time since `opened_at`.
3. **application→opportunity link coverage** — `conversion_id` is nullable and
   historically sparse; unlinked applications suppress the rate rather than being
   guessed onto an opportunity.

## 9 · CONFIRMATIONS

No renderer, no new route, no new mount, no new migration, no deployment, no
Slice 10 work. `server.js`, `src/agent/` and every Ask Spine file untouched.
Ask Spine re-fetched at write time: `ask-spine-slice-1` @ `17c5a68` still 7 ahead
and **not landed**; `ask-spine-source-audit` @ `d2f14c5` landed. Zero named-file
overlap, zero migration overlap. Migration 125 untouched; migration ceiling
remains 127.
