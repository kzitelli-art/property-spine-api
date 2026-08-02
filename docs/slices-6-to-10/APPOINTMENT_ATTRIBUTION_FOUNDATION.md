# SLICE 9 — APPOINTMENT ATTRIBUTION AND OBSERVATION FOUNDATION

**Phase 1 of the smallest implementation sequence: identities, writer matrix,
frozen contract.** No migration written, no writer cut over, no backfill, no
projection, no route. Those are phases 4–8.

---

## 1 · IDENTITIES

| | |
|---|---|
| API main | `f85f70b` |
| API branch | `claude/slice-9-demand-evidence-mcxvav` @ `2748fcf` · 39/0 |
| App main / branch | `30e550b` / `340bbc8` · 2/0 |
| Ask Spine | `claude/ask-spine-slice-1` @ `17c5a68` · **not landed**, 0 `ask_spine` files on main |

### Migration evidence

| Question | Answer |
|---|---|
| Reservations across **every** branch (not `ls migrations/`) | …118, 119, 120, **121** (parked), 122, 123, 124, **126** |
| Staged outside the runner | `docs/slices-6-to-10/deployment_b/125_application_lifecycle_enforcement.sql` |
| Local ledger max applied | **126** |
| `127` claimed on any branch | **no** |
| **Next free number** | **127** |
| Ask Spine migration overlap | **zero files** under `migrations/` — no overlap |

> **EVIDENCE LIMITATION.** The **Neon production ledger was not queried** —
> the standing constraint forbids production credentials in this environment.
> `127` rests on the all-branch reservation scan plus the local ledger. It must
> be re-confirmed against Neon before the migration is applied anywhere real.

125 untouched: blob `7c3f011b`, 0 lines changed.

---

## 2 · APPOINTMENT WRITER MATRIX

### 2.1 · `leasing_tours` (native operational tour)

| Act | Writer | Notes |
|---|---|---|
| create (intake) | `leasingleads.js:1177,1200` `intakeProspect` | status `requested` |
| create (booking) | `leasingleads.js:1510` `bookTourIntoSlot` | status `scheduled`, `booking_idempotency_key` |
| create (offer accept) | `leasingleads.js:1756,1763` `attachOutboundToOffer` | status `scheduled` |
| create (walk-in) | `operator.js:2815` | `origin='walk_in'`, `checked_in_at` = arrival |
| **all lifecycle transitions** | `leasingleads.js:1418` **`recordTourEvent`** | **the one door** |
| complete / outcome | `leasingleads.js:2433,2466,2476` `completeTourService` | via `recordTourEvent` |
| correction | `POST /leasing/tours/:tourId/correct-outcome` (`:2280`) | **never mutates the original** |

### 2.2 · `scheduled_tours` (external scheduling truth)

| Act | Writer |
|---|---|
| create / upsert | `leasingscheduling.js:222,239,246,260` |
| shadow import | `leasingShadowImport.js:298,311` |
| lifecycle | `leasing_lifecycle_service.js:195` |
| revision history | `leasingscheduling.js:301` → `scheduled_tour_revisions` |

### 2.3 · The event log is already the source of truth

`recordTourEvent` is explicit in source: **"event row FIRST (source of truth)"**,
then **"projection SECOND — status + the matching timestamp column"**.
`tour_events` is immutable and typed; `leasing_tours.status` /
`completed_at` / `no_show_at` / `checked_in_at` are its projection.

---

## 3 · RULING ITEM 5 — HOST AND OUTCOME ALREADY EXIST PER APPOINTMENT

Inspected before proposing anything. `tour_events.metadata`, written by
`completeTourService`, **already carries**:

| Required fact | Present as |
|---|---|
| appointment identity | `tour_events.tour_id` (column) |
| actual host | `actual_tour_host_user_id` **and** `actual_tour_host_name_claim` — a roster-verified staff id or free text, never a dereferenced arbitrary id |
| outcome | `tour_outcome`, `disposition`, `objection`, `next_move`, `tour_notes` |
| recorder | `recorded_by_user_id`, `feedback_recorded_by_user_id` — **server-derived from the session**, body value cannot override |
| occurred time | `tour_events.event_at` (column) |
| correction / reopen lineage | `/correct-outcome` lane, original preserved; replay guarded by `capture_idempotency_key` |

> ### STOP CONDITION 2 — CHECKED AND **NOT TRIGGERED**
> Actual host and outcome are already appointment-specific, recorded by the
> canonical completion service with a correction lane. **The service is reused,
> not replaced, and no second completion writer is created.**

---

## 4 · THE ACTUAL DEFECT — ATTRIBUTION BY FORBIDDEN INFERENCE

`completeTourService`, `leasingleads.js:1910`:

```js
// the relationship this tour belongs to — found by PERSON, not by
// origin_tour_id, because a second tour reuses the first tour's
// conversion and origin_tour_id would miss it entirely.
select id … from leasing_conversions
 where person_id=$1 and property_id=$2 and status='active' limit 1
```

That is **same person + same property + current active conversion + `limit 1`** —
four items from the forbidden list in one query. It appears in **3 places**.

The resolved `conversion_id` is then written into `tour_events.metadata`. So an
attribution value exists, but it was **derived by inference at write time**, is
only present for *completed* tours, and lives in JSON rather than a durable
referenced column. **It is not lineage.**

**This is the whole gap.** Not host, not outcome, not observation, not
correction — those are sound. Only the opportunity link.

---

## 5 · FROZEN CONTRACT

### 5.1 · Grain

```
leasing opportunity  (leasing_conversions.id — the durable UUID)
  └─ appointment chain      (reschedule chain, root-identified)
       └─ appointment occurrence   (leasing_tours.id | scheduled_tours.id)
```

A reschedule chain is one continuous attempt. A separately booked tour is
**another chain inside the same opportunity**.

### 5.2 · Public entry — opportunity ID only

```
appointmentJourney(q, { property_id, opportunity_id, as_of })
```

**No `opportunity_id | lead_id` union.** `lead_id` is not historically unique to
one opportunity. A server-side resolver may accept a lead **only** when it
yields exactly one governed opportunity; otherwise `untrackable` or a controlled
refusal.

### 5.3 · Models stay distinct

`scheduled_tours` = planned scheduling truth. `leasing_tours` = operational tour
and its observed lifecycle. Composed with explicit `source_type` +
`source_id`. **No third generic appointment table.**

### 5.4 · External scheduling is never attendance

A past `scheduled_tours.scheduled_start` proves nothing about attendance,
no-show, cancellation, host or outcome. Observed state stays `unknown` until an
exact canonical observation exists. **No elapsed-time inference.**

### 5.5 · Flattened conversion fields — classified

| Field | Class | Removal / demotion condition |
|---|---|---|
| `origin_tour_id` | **exact historical pointer** — trustworthy for the *first* chain only | demoted to one attribution basis among several once the durable link exists |
| `scheduled_tour_id` | **exact historical pointer** to one external appointment | same |
| `actual_tour_host_user_id` | **defective flattened authority** — opportunity-grained, unattributable with several appointments | demoted to compatibility projection once read from `tour_events.metadata` per occurrence |
| `tour_outcome` | **defective flattened authority** — same | same |

All four remain readable for compatibility. **None may be the canonical source
for a multi-appointment journey.**

### 5.6 · Attribution basis vocabulary — every attributed appointment states one

`explicit_link` · `origin_tour_pointer` · `scheduled_tour_pointer` ·
`chain_inheritance` (root attributed, members agree) · `unattributed` ·
`conflict` · `untrackable`.

**Never**: nearest timestamp, same person, same lead alone, same property,
conversation proximity, current active conversion, first/latest tour, unit
preference, browser state.

### 5.7 · Proposed bridge — shape NOT frozen

Smallest direct durable bridge: a **nullable `conversion_id`** on
`leasing_tours` and `scheduled_tours`, FK to `leasing_conversions`, indexed.
No polymorphic journey table — direct references have not been shown incapable.

**Deliberately not frozen yet**, per the ruling: every appointment writer and
reschedule writer is inventoried in §2 but the *reschedule* writers
(`recordTourEvent` rescheduled branch, `rescheduled_from` chain creation,
`scheduled_tour_revisions`) need line-level inspection before the column shape
is fixed. That is phase 3's remaining work.

---

## 6 · STOP CONDITIONS — STATUS

| # | Condition | Status |
|---|---|---|
| 1 | attribution requires replacing an appointment model | **not triggered** — a nullable FK is additive |
| 2 | host/outcome need a replacement completion service | **NOT TRIGGERED** — already appointment-specific; reused |
| 3 | migration number conflicts with another lane | **not triggered** — 127 free, Ask Spine has zero migrations |
| 4 | backfill requires lead/person/time inference | **open** — measured in phase 6; partial backfill accepted |
| 5 | reschedule cannot preserve occurrences + chain | **open** — pending reschedule-writer inspection |
| 6 | design turning into generalized scheduling/CRM | not triggered |
| 7 | Funnel 2 change needed first | not triggered |
| 8 | Ask Spine substantive overlap | **not triggered** — `server.js` junction only, zero migrations |

---

## 7 · PHASE STATE

Complete: 1 (identities/migration evidence) · 2 (writer matrix) · 3 (contract,
except the bridge column shape).

Remaining: 3-finish (reschedule-writer inspection) · 4 (migration 127) ·
5 (writer cutover) · 6 (exact-link backfill only) · 7 (pure projection) ·
8 (untrackable/unknown/conflict returns).

No migration written. No writer cut over. No backfill. No projection. No route.
`server.js` and `src/agent/` untouched.
