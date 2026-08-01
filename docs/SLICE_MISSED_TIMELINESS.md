# Slice proposal — record the miss durably (ITEM 1)

**Status: PROPOSAL. Nothing built. No migration written.**
Governed by the ITEM 1 ruling in `BLOCKING_DESIGN_ITEMS.md`: lifecycle status
stays `open | in_progress | complete | escalated`; missedness is a separate
timeliness axis; the first missed transition must become durable history.

---

## Part 1 — Audit

### 1.1 Writes of `obligations.status='missed'` — exactly one

`src/leasing/conversion_obligation_closure.js:107-110`. It is the only site in
the codebase. It has never succeeded: `ck_obl_status` permits only
`open | in_progress | complete | escalated`, and the live database holds **zero**
missed rows.

### 1.2 Reads of `obligations.status='missed'` — exactly one, and it is DEAD

`conversion_obligation_closure.js:106`:

```js
if (ob && ob.status !== "complete" && ob.status !== "missed") {
```

The `!== "missed"` half can never be false, because no row can hold that value.
It is a terminal-state guard protecting against a state the schema forbids.

**Nothing else in either repo reads it** — no queue, board, desk, projection,
report or app surface. The blast radius of removing the write is one dead
condition.

The other three `"missed"` references in that file (`:128`, `:200`) write to the
**069 ledger**, whose `resolution_code` check explicitly allows
`completed | released | missed`. Those work today and are unaffected.

### 1.3 The system already has a timeliness axis — computed, never durable

Eight sites derive it at read time, all as `now() > due_at`, mostly named
`overdue`:

| Site | Shape |
|---|---|
| `identity/operator.js:2881` | `when o.due_at < now() then 'overdue'` |
| `leasing/leasing_desk_loader.js:197` | same |
| `surfaces/desks.js:167` | `count(*) filter (where status <> 'complete' and due_at < now())` |
| `surfaces/board.js:99` | same |
| `server.js:752`, `:774` | `is_overdue` |
| `maintenance/unit_triage.js:319` | `overdue: due_at < now` |
| `maintenance/work_acceptance_service.js:559` | derives a `missed_commitment` finding |
| `property-spine-app/index.html:10550-10569` | `missed_window`, with a grace band |

**None is durable.** Every one recomputes from the clock, so historical truth
moves with the clock and nothing records *when the system recognised the miss* —
precisely what the ruling forbids as a sole source.

Note the vocabulary already splits: the API says `overdue`, the app says
`missed_window`, work-acceptance says `missed_commitment`. A named
`on_time | due | missed` axis would give these one word.

### 1.4 For conversion rungs, the miss is ALREADY durable — twice

- `leasing_conversion_obligations.outcome='missed'` + `closed_at`;
- the 069 ledger row: `event_type='resolved'`, `resolution_code='missed'`,
  with `occurred_at`.

So the durable record substantially exists for this one rail. It is rail-local
rather than a property of the obligation, but it is not missing.

### 1.5 Nothing detects a crossed window — the miss is only ever DECLARED

There is no sweeper, no cron, no window job. `resolveRung(result:'missed')` is
reachable only from `POST /leasing/rungs/:obligationId/resolve` and
`operator.js:3011` — both human actions. The harness comment
*"simulating a window sweep result"* describes a sweep that does not exist.

**So a missed window has never been recorded in production by any path** — not
because the write fails, but because nothing ever calls it. That is consistent
with the zero-row measurement and it means the write bug has been masking an
absent capability, not breaking a working one.

### 1.6 Scenario 8's intent, in four parts

```js
await T("8 · crossed window with no action → durable missed proof, no further advance", ...)
```

| # | Intent | Works today? |
|---|---|---|
| 1 | the resolution is recorded as missed (`out.outcome`, `link.outcome`) | **yes** |
| 2 | durable proof persists (`link.closed_at`, 069 ledger) | **yes** |
| 3 | it does NOT advance the rail (no next rung) | **yes** |
| 4 | the obligation leaves the open queue (`ob.status === 'missed'`) | **no — the only failing part** |

Parts 1–3 pass. Only part 4 needs the lifecycle write, and part 4's assertion
encodes the model the ruling rejects.

---

## Part 2 — The smallest design

### 2.1 What it does

1. **Delete the `status='missed'` write** and the dead `!== "missed"` half of the
   guard. Lifecycle is left exactly as it was.
2. **One migration**, adding to `obligations` (no enum widened, no constraint
   touched):
   - `missed_at timestamptz` — when the system recognised the miss;
   - `missed_threshold_at timestamptz` — the `due_at` that was crossed.
   Both nullable, both **write-once** (stamped only when `missed_at is null`), so
   a later touch cannot rewrite when the miss happened.
3. **An immutable `obligation_missed` event** in the existing `events` table,
   carrying `{obligation_id, threshold_at, missed_at, declared_by, source}`.
   The event is the history; the two columns are a read accelerator whose truth
   is the event.
4. **A named timeliness projection**, derived in this order:
   - `missed_at is not null` → **`missed`** (durable — does not move with the clock);
   - else `due_at < now()` → **`due`**;
   - else → **`on_time`**.
   The current-state read stays derived, as the ruling permits; the first
   transition is durable, as the ruling requires.
5. **Escalation and reassignment continue through the canonical engine.** This
   slice adds no new routing.

### 2.2 What it deliberately does NOT do

- **No sweeper.** Nothing detects crossings today (§1.5). Building one is a real
  capability with its own ownership, cadence and idempotency questions. This
  slice makes the miss durable *at the point it is already declared*; the sweeper
  is the natural follow-on and should be judged on its own.
- **No re-pointing of the eight clock-derived reads.** They are current-state
  reads, which the ruling permits to stay derived. Unifying their vocabulary is a
  separate cleanup.
- **No change to `leasing_conversion_obligations.outcome`** or the 069 ledger.
  Both already record the miss correctly.

### 2.3 THE OPEN QUESTION — needs a ruling before implementation

**What lifecycle does a rail-closed missed rung hold?**

The rail declares the *window* closed; the *work* was never done. Scenario 8
asserts the obligation leaves the open queue, while the ruling says lifecycle
stays intact. Those pull in opposite directions, and this is the one genuine
decision left.

| | Lifecycle | Consequence |
|---|---|---|
| **A (recommended)** | stays `open` | Honest: the work genuinely was not done. It remains visible, now flagged `missed` with durable history. Queue reads segregate by *timeliness*, not by lifecycle. **Changes queue behaviour** — these rungs stop disappearing. |
| B | `escalated` | Legal value today, and "escalated because it was missed" is the ruling's own phrasing. But nothing currently escalates it *to* anyone, so it would be a label without a recipient. |
| C | `complete` | Leaves the queue cleanly, but asserts work was done that was not. §5 violation. **Reject.** |

I recommend **A**, with the caveat stated plainly: it means missed follow-ups
stay on the board instead of vanishing. That is arguably the point — a missed
resident follow-up disappearing is how the loop got lost in the first place — but
it is a visible operator-facing change and belongs to you, not to me.

### 2.4 Scenario 8 must be rewritten as part of this slice

Its part-4 assertion (`ob.status === "missed"`) encodes the rejected model. Under
this design it becomes: lifecycle unchanged, `missed_at` and
`missed_threshold_at` stamped, an `obligation_missed` event present with the
crossed threshold, the timeliness projection reading `missed`, and — unchanged —
no next rung spawned and the link still carrying `outcome='missed'` with
`closed_at`.

### 2.5 Migration number

**Do not assume.** The isolated branch measured ceiling **122**
(`governed_economics_lineage`) on 2026-08-01, and a parallel thread holds
unmerged numbers. Query `schema_migrations` and cross-check open branches before
claiming one.
