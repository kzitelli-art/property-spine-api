# Tenancy standing-projection cost — the two orphaned history walks

**Thread:** `claude/docs-philosophy-review-s5yalc` · **Base:** `7e67f50` (ledger 192), not `main`
**Date:** 2026-08-24 · **Lane:** `src/tenancy/` only

Two reads in `src/tenancy/` were declared `HISTORY_WALK` by
`tests/gate_standing_projection_cost.js` and left unbounded, because that gate's
thread correctly refused to touch another lane. Both said the same thing:
*"src/tenancy/ is in no declared lane; it waits."*

This receipt records what each one turned out to be. **One was bounded. One was
examined and deliberately not bounded**, and that second outcome is the more
useful of the two.

---

## Method

Followed `tests/gate_standing_projection_cost.js` exactly:

- one read per commit
- capture the current result set on a seeded property **first**
- bound it, prove the **output** is identical by deep structural equality
- if output changes, the read is not a history walk — reclassify and say so
- **if a shared loader also serves a detail consumer, do not bound it**
  (§40.6 is standing **plus** detail, never standing instead of detail)

Environment: a disposable local Postgres 16.13 on `127.0.0.1:55434`, built from
the real migration chain via `tests/e2e/apply_migrations.sh` to **ledger ceiling
192, no stops**. No Neon, no Render, no migration numbers assigned. Harness
deletes are scoped to the seven `51ce0001-…` ids the harness creates.

---

## READ 1 — `from import_batches` · `dated_positions.js` `openingTruth()`

### Intent

An entitled person asks Spine where a building stands. `readTenancyStanding`
(contract `tenancy_standing.v1`, registered with Ask Spine) must answer cheaply
enough to be gathered on every question alongside every other entitled domain
(§40.6).

### Existing mechanism

`readTenancyStanding` → `datedPropertyPositions` → `openingTruth(pool, property_id)`:

```sql
select id, source_type, source_file,
       to_char(source_as_of_date, 'YYYY-MM-DD') as source_as_of_date,
       confidence, status, leasing_model, loaded_at, notes
  from import_batches where property_id=$1
 order by source_as_of_date desc nulls last, loaded_at desc
```

Every rent-roll import ever run against the property. It then reads **one field**
of the result — `latest_confirmed_source` — to populate `established_from`
(`tenancy_position_read.js`, the line reading
`const src = dp.opening_truth && dp.opening_truth.latest_confirmed_source;`).

### What I actually ran

Seeded a property with four import batches arranged so the `ORDER BY` has real
work to do, then measured the standing path with a query spy rather than reading
the diff:

| batch | as_of | loaded_at | why it is in the fixture |
|---|---|---|---|
| `old.xlsx` | 2025-01-31 | 2025-02-01 | an older committed source |
| `tie_early.xlsx` | 2026-07-31 | 2026-08-01 09:00 | shares an as_of with the next row |
| `tie_late.xlsx` | 2026-07-31 | 2026-08-01 17:00 | **the correct answer** — `loaded_at` breaks the tie |
| `recon.xlsx` | 2026-08-15 | 2026-08-16 | newest by date, but a reconciliation — must be skipped |
| `no_date.xlsx` | `null` | 2026-08-20 | loaded most recently; `nulls last` must sort it behind everything |

Baseline, before any change:

```
standing truth_state: PARTIALLY_ESTABLISHED
established_from:     {"source_file":"tie_late.xlsx","source_as_of":"2026-07-31","confidence":"confirmed"}
import_batches statements on the standing path: 1 (unbounded: 1)
```

### The observed stop — and the fix that was refused

**The obvious bound is the wrong one.** Putting a `LIMIT` on `openingTruth`
truncates a receipt an operator reads. `opening_truth.sources` has four live
consumers:

```
src/surfaces/rent_roll_unit_view.js:261
src/surfaces/future_rent_roll_facts.js:134
src/surfaces/rent_roll_institutional.js:166
src/surfaces/rent_roll_canonical.js:122
```

and `tests/rent_roll_canonical_proof.js:116-120` asserts the array is non-empty
and that *"every source keeps attribution"*. `openingTruth`'s own header states
the contract: *"Opening truth is an EXTENSIBLE receipt. A property may take many
governed sources over its life; the contract must not collapse that history into
'one batch and one document'."*

That is the same mistake as putting a `LIMIT` on *"the coverages on this
property"* — the one the cost gate's header records learning the hard way.

### The smallest missing piece

`openingTruthStanding()` — two `limit 1` statements reproducing the walk's
ordering **verbatim**, including the `loaded_at` tie-break and `nulls last`.
`openingTruth()` is untouched and remains the detail read.
`datedPropertyPositions` and `intervalPropertyPositions` take
`opening_truth_scope`, **defaulting to `detail`** so a caller that says nothing
keeps the full receipt.

`sources` is `null` in the standing scope, never `[]`. An empty array is a claim
— *"this property has taken no governed source"* — and it would be false on
every property that has taken several (§5; §40.7 separates NOT_ESTABLISHED from
"not read here").

### Result

`tests/opening_truth_standing_bound.db.js` — **8/8**, snapshot byte-identical to
the baseline:

```
established_from: {"source_file":"tie_late.xlsx","source_as_of":"2026-07-31","confidence":"confirmed"}
import_batches statements on the standing path: 2 (unbounded: 0)
```

Falsified three ways, each observed red and then restored green:

| falsification | result |
|---|---|
| baseline (function absent) | 2 failed |
| reconciliation exclusion removed from the bounded read | 3 failed |
| `nulls last` removed | 2 failed |
| restored | **8 passed, 0 failed** |

Post-change, both reachable detail surfaces still receive all 5 seeded sources.
All 48 source-governance gates exit 0.

### Classification

| component | class |
|---|---|
| `openingTruthStanding()` | **1** — permanent product primitive |
| `opening_truth_scope` parameter | **1** — permanent, defaults to the existing behaviour |
| `openingTruth()` (unchanged) | **1** — the detail read §40.6 requires |
| `tests/opening_truth_standing_bound.db.js` | **3** — test infrastructure, no removal condition |

### Honest limits

- The **row set** is bounded; the statement is **not** `O(1)`. There is no index
  on `(property_id, source_as_of_date, loaded_at)`, so Postgres still sorts the
  property's batches to find the top row. An index is a schema change and this
  thread assigned no migration number. SQL for it, unnumbered, is at the bottom.
- The standing path now issues **two** bounded statements where it issued **one**
  unbounded walk. Stated rather than hidden.
- The harness is **not wired into any runner**. Nothing runs it automatically —
  the same condition as the other 68 `.db.js` proofs.

---

## READ 2 — `from spaces s` · `space_position.js` `loadSpaceRows()`

### RECLASSIFIED, NOT FIXED. Do not bound this read.

The cost gate declares it *"structural at the top (spaces × units) but carries
correlated json_agg subqueries pulling EVERY lease and EVERY move-in/move-out
event per space."* That description is accurate. The conclusion that it should
therefore be bounded is not.

### Why a bound changes output

`loadSpaceRows` is the row set for the whole temporal tenancy family. Its
`leases` array is handed to `position_classifier.js`, which consumes it for:

| consumption | needs |
|---|---|
| `leases.find(CURRENT && datesSpan(lease, asOf))` | the lease spanning an **arbitrary** `asOf`, including a past date |
| `leases.find(isFuture(lease, asOf))` | leases starting **after** `asOf` |
| `leases.filter(datesSpan(lease, asOf))` → `>= 2 distinct` | **the double-let contest guard** |
| successor search | *"the earliest non-terminal lease starting at or after it ends"* |
| `classifyPositionForInterval` → `leases.filter(rangesOverlap(requested, l))` | every lease overlapping a **forward window** |

`spacePosition(as_of)` answers at any date, past or future.
`intervalPropertyPositions(start, end)` answers over a forward window. A
recency- or count-bound satisfies neither, and the failure is not symmetric:
dropping a lease that spans the queried date can report an occupied bed as
contractually free. That is the double-let this classifier is explicitly built
to prevent, and it would have been bought to make a cost gate green.

This is the same shape as the gate's own `obligations o` entry, where *"bounding
it by status would have been the obvious fix and would have been WRONG OUTPUT."*

### What could be bounded, and was not

Past leases that ended strictly before `asOf` contribute nothing to
`classifyPosition`'s output — every consumption above is `datesSpan`, `isFuture`,
or a successor starting at/after a governing lease that itself spans `asOf`. So a
date-relevance predicate (`end_date is null or end_date >= $asOf`) is a candidate
that a count-bound is not.

**It was not built, for two reasons and neither is time:**

1. `loadSpaceRows(pool, property_id, baseline_id)` does not receive `asOf` at
   all — the date is applied by the classifier afterward. Threading it in is a
   signature change to the loader the entire temporal family shares, and it must
   be proved against **both** consumers at multiple dates, not one.
2. `possession_events` carries a live question this thread should not answer
   alone: `classifyPosition` takes `ins[ins.length - 1]` — the globally latest
   move-in — and **never filters it by `asOf`**. So a historical as-of read
   already uses a possession event from after the date being asked about. That
   may be a defect or may be deliberate; either way, bounding the array by date
   would silently change that answer, and *"a bound only changes which arbitrary
   row wins"* is the debt-observation precedent for stopping and asking.

**Recorded as the next real cost in tenancy, and blocked on a ruling** — the
same disposition as `debt_balance_observations`, which was built, reverted, and
counted until its conflict verdict exists.

---

## Forbidden second path

A future thread must **not** build:

- a second "latest import batch" read anywhere outside `dated_positions.js`.
  `openingTruthStanding()` is the standing answer and `openingTruth()` is the
  detail answer; a third caller re-deriving "which source established this" is
  how two surfaces start disagreeing about the same building.
- a bounded copy of `loadSpaceRows` for the standing path. Two loaders for the
  temporal tenancy family is two definitions of what a lease spanning a date
  means, and it would diverge silently — the failure `NOT_RETIRED_SQL` is
  imported rather than restated to avoid.
- a `LIMIT` on `openingTruth`. It is the receipt. See READ 1.

---

## Schema this receipt needs and did not apply

**No migration number assigned.** Not applied anywhere. This is the index that
would make READ 1's bounded statement genuinely cheap rather than merely
bounded:

```sql
-- Makes openingTruthStanding()'s two `limit 1` statements an index scan
-- instead of a sort over the property's batches. Read 1 bounds the ROW SET;
-- this is what would bound the WORK.
create index if not exists idx_import_batches_property_recency
  on import_batches (property_id, source_as_of_date desc nulls last, loaded_at desc);
```

Deliberately not numbered, not applied, and not claimed as released.
