# SLICE 9 — AVAILABILITY CONSUMER CENSUS (Pass 2A, Commit 1)

**Repos searched:** `property-spine-api`, `property-spine-app` · **Date:** 2026-08-02

> **Method note.** A first pass searched `property-spine-app/src` and returned
> zero consumers for every term. That was a false zero: the app is a **flat
> repository with no `src/` directory**, so the path did not exist. Re-run
> against the repo root. Recorded because a false zero here would have retired
> a live route.

---

## Headline

**The legacy `GET /availability` route has no browser consumer. Its module does
have two internal API consumers.**

The app requests exactly one availability path:

```
index.html:7458   '/operator/leasing/availability-canonical'
index.html:7362   '/operator/leasing/leaseable-units'
```

There is **no request anywhere in the app for bare `/availability`** — verified
by extracting every availability-shaped path literal in the repo, not by
grepping for a substring that `availability-canonical` would also match.

So retirement is available **once the two internal callers are cut over**, which
is Commit 2. That ordering is mandatory: retiring first would break them.

---

## API-side consumers

| Consumer | File | Uses | Decision or display | Action |
|---|---|---|---|---|
| legacy route mount | `server.js:3174` | mounts `tenancy/availability` | serves `GET /availability` | **retire after Commit 2** |
| `unitOfferableState` | `operator.js:3202` | `require("../tenancy/availability")({pool})` | **decision** — offerability | **Commit 2: cut to `availabilityRead`** |
| leaseable-units route | `operator.js:3674` | `require("../tenancy/availability")({pool})` | **decision** — which units are offerable | **Commit 2: cut to `availabilityRead`** |
| `availability-canonical` | `operator.js:1243` | `availabilityRead` | the app's route, session-scoped | already canonical — no change |
| pricing decision packet | `money/pricing_decision_packet.js:30` | `availabilityRead` | display + pricing input | already canonical |
| readiness | `maintenance/readiness.js:21` | `availabilityRead` | display | already canonical |
| unit-turn read | `surfaces/unit_turn_read.js:348` | `availabilityRead` | display | already canonical |

**Both remaining legacy consumers are internal operating decisions**, not
display. Neither is reachable from the browser except through the two operator
routes above.

## App-side consumers

| File | Field / path | Grain | Use | Compatibility requirement |
|---|---|---|---|---|
| `index.html:7458` | `GET /operator/leasing/availability-canonical` | space | primary availability surface | **canonical — none** |
| `index.html:7362` | `GET /operator/leasing/leaseable-units` | **unit** | offerability list | **Commit 2 must keep this route working; response grain gains `space_id`** |
| `index.html:19253` | `marketing_state` ∈ `successor_pending`, `successor_locked`, `activation_pending` | — | row match / filter | **all three already exist; Pass 2A does not rename them** |
| `index.html:10930–10937` | `availability_state`, `available_from`, `future_commitments[]` | — | display | reads a plural `future_commitments` array, distinct from the canonical singular `future_commitment` object — **no collision** |
| `index.html:5160`, `8322` | `availability_state` | — | display | unchanged |
| `readiness-door.js` | `marketing_state` | — | display | unchanged |
| `solo-rent-roll-data.js` | `availability_state`, `future_commitment` | — | fixture/seed data | not a live route consumer |
| `index.html:18665–18667` | `demand_tier_key === 'applicant_demand'` | — | **turn/vacancy demand tier badge** | **NOT the availability `commitment_tier`.** Different surface, different field name (`demand_tier_key`). Removing `applicant_demand` from the legacy availability module does not touch it. |

### Fields with zero consumers anywhere

`commitment_tier` · `projected_ready_date` · `date_confidence` ·
`tourable_in_person` — **no reference in either repository.**

That is the strongest possible result for the legacy adapter question: the
fields the legacy module invents to fill its own enum are read by nobody.

---

## Conclusions

1. **`GET /availability` can be retired** — no browser consumer, no API consumer
   of the *route*. Only the *module* is consumed, by two internal callers.
2. **Order is forced:** Commit 2 (cut `unitOfferableState` and leaseable-units
   over to `availabilityRead`) must land before Commit 3 retires the route.
3. **No app contract change is required by Commit 1.** The frozen canonical
   objects (`future_commitment`, `activation_pending`, `current_lease`) are
   additive; the flattened `commitment_*` fields removed in this commit had no
   consumer in either repo.
4. **`leaseable-units` must keep working.** It is a live app route. Commit 2
   changes what backs it, and adds `space_id` to the response grain — additive.
5. **`applicant_demand` is safe to delete** from the legacy module. The app's
   only `applicant_demand` reference is a different field (`demand_tier_key`) on
   a different surface.

## Open item, not in scope for this pass

`GET /availability` is mounted without an operator gate at `server.js:3174` and
takes a caller-supplied `property_id`. If it is retired in Commit 3 this closes
itself. If retirement is deferred, it must be recorded as an open
security/retirement issue — a public, client-property-scoped availability read.
Not broadened into an auth redesign here.
