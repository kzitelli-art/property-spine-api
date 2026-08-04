# RECEIPTS STEP F — CONFIRM-PROSPECT RECEIPT AUTHORITY TRACE

**Status: TRACE ONLY. No product code changed, no migration.**

`tour.confirm_prospect` was the one tour verb that survived Step B's block —
it was implemented and proven in the authority packet while reminder and
correct-outcome were withheld. This step asks the separate question: can a
confirmation be **recovered**?

Measured against the five-part standard already established:
**recoverable · payload-bound · property-safe · immutable · actor-attributed.**

---

## The durable write

`confirmProspectTourService` (`src/leasing/leasingleads.js:1889`) writes
exactly one durable row, through `recordTourEvent`:

```
tour_events
  event_type  'confirmed_by_prospect'
  tour_id · lead_id
  actor_type  'prospect' | 'human'
  actor_id    the session user, or NULL when the prospect confirmed
  metadata    { via }
```

Plus the projection: `leasing_tours.status = 'confirmed_by_prospect'`,
`confirmed_at = event_at`.

## Against the five-part standard

| requirement | result |
|---|---|
| **immutable** | **YES** — `tour_events` is append-only |
| **actor-attributed** | **YES, and correctly nuanced.** A staff confirmation names the session user. A prospect confirmation names *no* staff user, which is the honest value: the prospect is not a `users` row. `actor_type` distinguishes them. |
| **stable receipt identity** | **YES** — `tour_events.id` |
| **direct tour lineage** | **YES** — `tour_id` on the event |
| **direct property lineage** | **NO** — `tour_events` has no `property_id`; lineage is a join through `leasing_tours` |
| **queryable operation identity** | **NO** — there is nowhere to put one. The service writes `metadata: { via }` and no operation identity at all |
| **payload binding** | **NO** — no hash, nowhere to store one |
| **exact recovery path** | **NO** — follows from the two above |

## Classification

```
tour.confirm_prospect
  BLOCKED — QUERYABLE OPERATION ID REQUIRES MIGRATION
```

**Identical to the other three tour operations, and for the identical reason.**
Its only home for an operation identity is `tour_events.metadata`, which B1
measured directly: a lookup by `metadata->>'operation_id'` uses the tour index
at small volume and degrades to a **sequential scan of every event row**
(100,068 rows scanned, 2,710 buffers, at 110k events) as the estate grows.

Nothing in this step changes that measurement. Confirm-prospect is not a
different case; it merely *worked* where the other two verbs could not write
at all, which made it look further along than it is.

## What was NOT done

- **No authority manufactured from mutable tour status.**
  `leasing_tours.status = 'confirmed_by_prospect'` plus `confirmed_at` would
  produce something receipt-shaped from a projection that the next lifecycle
  write overwrites. That is precisely the substitution ruled out in Step C.
- **No second event, no receipt table, no index, no column.**
- **No resolver registered.** The `tour.confirm_prospect` namespace stays
  reserved in `operation_receipt_v1` with no resolver, so recovery answers
  `501 recovery_unavailable` and states explicitly that this does not mean the
  operation did not happen.

## Consequence for the tour migration brief

`tour.confirm_prospect` joins the three already listed under **TOUR OPERATION
RECEIPT AUTHORITY** in `TOUR_LEDGER_VERB_SCHEMA_REPAIR.md`. It adds one
requirement the others did not surface:

> **an operation identity must be recordable on an event whose actor may
> legitimately be NULL.** A prospect-confirmed tour has no staff actor, and a
> replay identity must not be conflated with, or derived from, the acting
> user — because sometimes there isn't one.

## Future-money provenance

`tour.confirm_prospect` is **OPERATIONAL ONLY**. A prospect confirming an
appointment carries no economic meaning and is not a candidate source fact for
a financial event. It feeds show-rate, which is a leasing performance measure,
not a ledger input.

No new accounting-provenance gap.
