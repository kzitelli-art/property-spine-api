# TOUR LEDGER VERB SCHEMA REPAIR — BRIEF

**Status: PREPARED, NOT IMPLEMENTED. No migration number assigned. No SQL written.**

This brief exists because two tour-ledger verbs have complete, proven authority
chains and canonical write services that cannot execute. It describes what a
repair would have to establish. It does not perform one, and it must not be
implemented until the conditions in §12 are met.

---

## 1. The two defects

### 1.1 `reminder_sent` is projected into a column that forbids it

`recordTourEvent` (`src/leasing/leasingleads.js`) writes the event, then
projects the event type into `leasing_tours.status` **unconditionally**:

```
const sets = [`status=$1`]; const vals = [type];
```

`reminder_sent` is a permitted `tour_events.event_type` and is **not** a
permitted `leasing_tours.status`. The write dies on
`leasing_tours_status_check`.

**The constraint is right and the projection is wrong.** A scheduled tour that
receives a reminder is still scheduled. "A reminder was sent" is an event about
a tour, not a state of one. Widening the status enum to admit `reminder_sent`
would make the tour board display "reminder_sent" as a tour's condition, which
is not what an operator needs to see and would corrupt every reader that
switches on status.

### 1.2 `outcome_corrected` is not a permitted event type

`correctTourOutcomeService` appends:

```
type: "outcome_corrected"
```

`tour_events_event_type_check` permits only:
`scheduled`, `confirmed_by_prospect`, `reminder_sent`, `checked_in`,
`completed`, `no_show`, `cancelled`, `rescheduled`.

Here the **vocabulary is wrong and the service is right.** A correction lane
that appends rather than overwrites is exactly what §5 requires, and the event
type it appends was never admitted to the enum.

This is the more consequential of the two: `completeTourService` refuses a
re-submit on a settled tour by telling the operator

> "This tour was already saved. To change what was recorded, use Correct
> outcome — the original stays on the record."

and that door has never been able to write.

## 2. Current constraints, exactly

```
leasing_tours_status_check
  status = ANY (ARRAY['requested','scheduled','confirmed_by_prospect',
                      'checked_in','completed','no_show','cancelled',
                      'rescheduled'])

tour_events_event_type_check
  event_type = ANY (ARRAY['scheduled','confirmed_by_prospect','reminder_sent',
                          'checked_in','completed','no_show','cancelled',
                          'rescheduled'])

leasing_tours_origin_known
  origin IS NULL OR origin = ANY (ARRAY['scheduled','walk_in'])
```

Read from the live schema, not from migration files.

## 3. The exact writes

| verb | service | event written | projection attempted |
|---|---|---|---|
| reminder | `recordTourReminderService` | `tour_events.event_type='reminder_sent'`, `actor_type='system'`, `actor_id=null`, `metadata.scheduled_for` | `leasing_tours.status='reminder_sent'`, `reminded_at=event_at` |
| correct outcome | `correctTourOutcomeService` | `tour_events.event_type='outcome_corrected'`, `actor_type='human'`, `actor_id=<session>`, `metadata{corrects_event, reason, prior, revised, corrected_by_user_id, corrected_at}` | `leasing_tours.status='outcome_corrected'` (also forbidden), no timestamp column mapped |

Note the second row: even if the event type were admitted, the same
unconditional status projection would then reject `outcome_corrected` as a
status. **Both defects share one root cause** — the projection treats every
event type as a state transition.

## 4. Two candidate shapes

**A — fix the projection (preferred, no enum widening for these two).**
`TS_COL` already encodes "which timestamp column does this event stamp", and
`scheduled`/`rescheduled` already map to `null`. Add the parallel idea: which
event types are **state transitions** and which are **annotations**. A
non-transition event writes its timestamp column and leaves `status` alone.
`outcome_corrected` then needs adding to `tour_events_event_type_check` only.

**B — widen both enums.** Admit `reminder_sent` and `outcome_corrected` as
statuses. Cheapest to write, worst to live with: every status reader gains two
values that are not conditions, and the board would show a corrected tour as
`outcome_corrected` rather than `completed`.

The brief recommends **A**. It is the smaller schema change and the honest
model. It is also the one that needs a careful reader inventory (§5).

## 5. Existing readers of both vocabularies — MUST BE INVENTORIED BEFORE SQL

Not yet enumerated. The repair cannot begin without this list, because shape A
changes what `status` means for two event types and shape B adds values every
reader must tolerate. At minimum, enumerate readers of:

- `leasing_tours.status` — the tour board, `tourStatusLabel`/`tourTone`/
  `tourButtons` in the app, the operator tours-today read, any funnel or
  show-rate projection, the AI leasing strategy reads
- `tour_events.event_type` — the tour history/detail read, conversion
  projections, `capture_receipt`, `tour_chips`, `appointment_journey`,
  `followup_ladder`, the agent's tour tools

For each: does it switch exhaustively, does it have a default branch, and does
an unknown value render as blank, as raw text, or as a crash?

## 6. Backfill

**Expected: none.** Both writes have never succeeded, so no `reminder_sent`
status rows and no `outcome_corrected` event rows exist anywhere. This must be
**verified against production**, not assumed — count both before writing SQL.
If shape A is chosen, also confirm no existing row has a `status` that would
change meaning under the new projection rule.

## 7. Migration ordering dependency on 129

**Blocking.** `docs/THREAD_HANDOFF.md` records migration 129 as in the build
and in no ledger, with the verify gate refusing, and migration 125 staged
outside the runner and unresolved. Introducing a new migration into a contested
ledger creates a second misleading migration story — the exact failure the
handoff warns about.

**No number may be assigned until the ledger is verified and the next governed
position is established by the migration-129 owner.**

## 8. Fresh-database proof

Migrate a new database from zero. Both constraints must admit exactly the
intended values, and no other. Assert the enum contents directly from
`pg_constraint`, not from the migration text.

## 9. Upgraded-database proof

Take a database at the pre-repair ceiling, apply the migration, and assert:
constraints changed as intended; the counts from §6 are unchanged; no existing
row was rewritten; every reader in §5 still renders.

## 10. Legacy-door proof

`POST /leasing/tours/:tourId/reminder` and `.../correct-outcome` behind the
shared key must return 200 and write. `tests/legacy_tour_verb_baseline_probe.js`
already reproduces today's failure and is the before-image: the same file must
flip to green, with `confirm-prospect` still green as its control.

## 11. Operator-door proof

Delete the `WITHHELD_TOUR_VERBS` guard in `src/identity/operator.js` (a Class 3
component whose removal condition is exactly this repair), then flip
`write_authority_hardening_proof.js` sections M20–M21 and M30–M34 from
asserting the typed refusal to asserting the durable write:

- reminder — the durable sender is still `system`, the tour's `status` is
  **unchanged**, `reminded_at` is stamped
- correct outcome — the durable corrector is the session user, the ORIGINAL
  `completed` event is untouched, `corrects_event` and `prior` are populated,
  and the conversion projection reflects the revised disposition

Authority assertions M13–M19 and M23–M29 must stay exactly as they are and stay
green. The app's `WITHHELD_TOUR_CAPABILITY` map and section E of
`ps_user_id_powerless_proof.test.js` are removed in the same change.

## 12. Rollback implications

A CHECK-constraint widening is trivially reversible **only while no row uses a
new value.** Once a `reminder_sent`/`outcome_corrected` row exists, the down
migration cannot restore the old constraint without deleting durable history —
which this product must never do. Treat the repair as **forward-only** and say
so in the migration's own header. Shape A carries the same warning for any row
written under the new projection rule.

## 13. Preconditions before any SQL

1. Migration 129 released or formally resolved
2. Migration ledger verified
3. Next migration number governed and assigned by its owner
4. §5 reader inventory complete
5. §6 counts taken against production

Until all five hold, this document is the deliverable and nothing else is
written.

---

# TOUR OPERATION RECEIPT AUTHORITY — a SECOND, SEPARATE dependency

Added after Receipts Step B. This shares a ledger and a migration sequence
with the verb repair above; it does **not** share its domain semantics. The
two are stated apart on purpose, and a repair that conflates them would
produce a migration nobody can review.

- **The verb repair (§1–13)** is about *what a tour event is allowed to say*
  — a vocabulary problem.
- **This section** is about *whether a completed tour operation can be found
  again* — an access-path problem.

They are evaluated together only because both touch `tour_events` and the
same migration position.

## What was measured

`tests/receipts_b1_m1_queryability_probe.js` — EXPLAIN (ANALYZE, BUFFERS)
against the actual proposed recovery lookup, two volumes, with
neighbouring-property noise:

| | scale 2000 | scale 20000 |
|---|---|---|
| selected-property events | 2,001 | 22,002 |
| neighbouring-property events | 58,066 | 88,066 |
| total `tour_events` | 60,067 | 110,068 |
| scan on `tour_events` | Bitmap Index (`tour_events_tour_idx`) | **Seq Scan, 100,068 rows** |
| buffers hit | 35 | 2,710 |
| execution | 0.429 ms | 33.31 ms |

The planner uses the tour index at small volume and abandons it as the estate
grows. **The finding is the shape, not the latency.** 33 ms is tolerable; work
that grows with total events across all properties is not, on the one surface
whose job is to answer "did my write land".

Three facts drive it:

1. `tour_events` has **no `property_id`** — property lineage runs
   `tour_events.tour_id → leasing_tours.property_id`, so every property-scoped
   lookup is a JOIN, not a column filter.
2. **No index touches `metadata`.** The only existing replay identity,
   `capture_idempotency_key`, lives in JSONB and is written by
   `completeTourService` alone.
3. A property predicate narrows what is **returned**. It does not stop the
   planner reading every event row to find it.

## Requirements a repair must satisfy

Stated as requirements. **No SQL, no migration number, no index.**

- **queryable operation identity for `tour_events`** — resolvable without a
  scan that grows with total events
- **property-resolvable lookup** — the property must participate in the access
  path, not only in the filter
- **operation namespace** — recovery resolves inside exactly one namespace;
  `tour.check_in` and `tour.complete` must not collide
- **payload hash or equivalent material binding** — so a reused identity
  recovers the original and cannot change the recorded outcome
- **unique replay authority** — at most one durable event per
  (property, operation, operation_id)
- **immutable receipt identity** — a `tour_events.id`, never a tour id, a
  timestamp, an operation_id or a mutable row version
- **bounded recovery read** — cost governed by the operation looked up, not by
  estate size
- **no-outcome walk-in event, or another immutable capture record** — a walk-in
  captured without an outcome writes `leasing_tours` only and no event at all,
  so that variant has no durable receipt identity and no immutable record that
  a named human captured a walk-in at a named moment
- **property-scoped walk-in idempotency uniqueness** —
  `leasing_tours_booking_idem_key` is `UNIQUE (booking_idempotency_key)` with
  no property in the key. The cross-property **read** leak is already closed;
  property-scoped **replay** is not expressible without a composite key

## Operations blocked on this

```
tour.check_in         BLOCKED — QUERYABLE OPERATION ID REQUIRES MIGRATION
tour.complete         BLOCKED — QUERYABLE OPERATION ID REQUIRES MIGRATION
post_tour_capture     BLOCKED — QUERYABLE OPERATION ID REQUIRES MIGRATION
tour.walk_in_capture  BLOCKED — COMPOSITE IDEMPOTENCY SCOPE REQUIRES MIGRATION
                      no-outcome variant additionally
                      BLOCKED — NO DURABLE RECEIPT IDENTITY
```

Their namespaces stay reserved in `operation_receipt_v1` with **no resolver
registered**, so the recovery read answers `501 recovery_unavailable` and says
explicitly that this does not mean the operation did not happen. No fake
resolver was registered to make the registry look complete.

Same preconditions as §13 above: 129 released or resolved, ledger verified,
next number governed.
