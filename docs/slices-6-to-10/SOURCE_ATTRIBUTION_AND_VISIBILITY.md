# ACCEPTANCE CLOSEOUT — INBOUND VISIBILITY · SOURCE-ATTRIBUTION CONTRACT

## 1 · INBOUND DECISION VISIBILITY — WHAT IS PROVEN, AND THE SEAM THAT IS NOT

### Proven against the canonical scoped read

The canonical read is `operator_obligations_service.list` (its projection is
reproduced verbatim in the proof from `origin/main`, so the proof measures the
real contract). Its mandatory predicates are `property_id` and `module`.

| requirement | verdict |
|---|---|
| appears in the operator's live scoped queue | **PASS** — module `leasing`, status `open` |
| person context | **PASS** |
| conversation context | **PASS** — `related_type='conversation'` |
| plain-language required decision | **PASS** — *"Choose which opportunity this reply belongs to"* |
| no conversion id / grain / lifecycle terminology | **PASS** |
| explicit `UNASSIGNED` in the coverage read | **PASS** — `owner_eligibility_state='unassigned'`, stated not merely absent |
| due state | **PASS** — `due_at` + `is_overdue` |
| never visible to another property | **PASS** |
| never visible without the leasing module | **PASS** |
| duplicate inbound → ONE decision | **PASS** |
| stays open while unresolved | **PASS** |
| resolved decision leaves the queue | **PASS** |
| underlying reply remains readable | **PASS** |

### THE MISSING READ/ACTION SEAM — reported, not built around

Three required elements **cannot** be served by the current projection:

| missing | exact reason |
|---|---|
| **inbound reply context** | `FIELDS` in `operator_obligations_service.js` omits `dedupe_key` and `source_event_id`. The inbound id lives in `dedupe_key` (because `obligations.source_event_id` FKs `events`, not `comm_events`). The list cannot return it. |
| **candidate opportunities** | No read exists. `listOpportunityCandidates()` is implemented and proven, but nothing exposes it. |
| **canonical resolution action** | **No door exists.** `operator_obligations.js` states it deliberately: *"`satisfy`/`complete` had no product caller. Rebuilding them behind a new URL would preserve attack surface for workflows that do not exist… Add a door when a real workflow needs one."* |
| **blocked reason** | Not a field on the list projection. |

**A real workflow now exists.** The decision can be *seen* but not *opened* or
*resolved*. Per the ruling I did not build a dashboard or a second queue.

Smallest sufficient seam, for a ruling — **not implemented**:

1. add `dedupe_key` (or a comm-event reference) to the obligations projection;
2. one detail read for a `resolve_inbound_opportunity` obligation returning
   `listOpportunityCandidates()` plus the reply body;
3. one action door calling `resolveInboundOpportunityDecision()`;
4. surface `blocked_reason` from a failed resolution.

`src/obligations/` lives on `main` and **not on this branch** — the security
lane merged after this branch point. Any such work must be integrated there.

## 2 · SOURCE-ATTRIBUTION CONTRACT — FROZEN

**Classification: `originating_lead_source` — inherited context with incomplete
opportunity attribution.**

Not "opportunity acquisition source". `lead_source_touches` (migration 038)
records `lead_id · person_id · source_id · source_lead_id · source_listing_id ·
arrived_at · raw_payload` — the arrival of a **lead** from a source. It is
lead-grained, permits several touches per lead, and is **never recorded per
opportunity**. No product contract says every opportunity for a lead shares an
acquisition source, so claiming one would be a confident wrong.

| field | value |
|---|---|
| `basis` | `originating_lead_source` |
| `grain` | `lead` |
| `counted_unit` | `opportunity` |
| `independently_recorded_per_opportunity` | **`false`** |
| `inherited_opportunity_count` | count of opportunities beyond the first on their lead |
| `leads_with_multiple_opportunities` | how many leads that affects |

### Two opportunities on one lead — proven

- both appear under the originating lead source **as context** (denominator 2)
- the disclosure rides **every** source-segmented metric
- the later opportunity is counted as **inherited**, not independently observed
- the segmented metric declares **`partial`**, `rate: null`
- **counts stay exact (1/2)**, with the inheritance named as the reason

No migration, no invented opportunity-source field.

## 3 · A DEFECT IN MY OWN PROOF, CAUGHT AND FIXED

`slice9_evidence_proof.js` uses `ok(message, condition)` — the **reverse** of
every other Slice 9 proof. Six new assertions were written `(condition, message)`
and passed vacuously on a truthy string. They printed `PASS true`. Corrected, and
the whole file audited: every `ok()` now passes its message first.

## 4 · TOTALS

Inbound decision **66/0** · evidence **74/0**. Full suite twice on a clean
database: **923/0** and **923/0**, zero properties before and after.
