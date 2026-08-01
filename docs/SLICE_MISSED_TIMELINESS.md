# Slice proposal — record the miss durably (ITEM 1)

**Status: REVISED PROPOSAL (rev 2, 2026-08-01). Nothing built. No migration
written.** Awaiting approval of the contract in Part 5 before any code.

Governed by the ITEM 1 ruling in `BLOCKING_DESIGN_ITEMS.md`: lifecycle status
stays `open | in_progress | complete | escalated`; missedness is a separate
timeliness axis; the first missed transition must become durable history.

Rev 2 applies the lifecycle ruling (Part 3), replaces the two-state projection
with three states (Part 4 — my rev-1 clock fallback was a conflation and is
withdrawn), names the claim honestly as a manual recognition primitive rather
than automatic detection (Part 2), and adds the service contract (Part 5).

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

## Part 2 — What this slice IS (name the claim honestly)

**This is NOT automated missed-window detection.** No sweeper exists (§1.5) and
this slice does not build one.

**This is the durable missed-RECOGNITION primitive** — one canonical service that
a future sweeper and the existing human paths can both call. It delivers:

- a canonical `recognizeObligationMissed` service;
- a manual / human-triggered path that calls it;
- durable columns and immutable event history;
- coherent projections;
- idempotency and stale-state protection.

Automatic recognition is a **later slice**, involving cadence, ownership,
retries, locking and recovery behaviour. Nothing here may be described as
automatic detection.

---

## Part 3 — Lifecycle ruling (2026-08-01)

**A missed obligation retains its existing lifecycle status.**

| Was | Stays |
|---|---|
| `open` | `open` |
| `in_progress` | `in_progress` |

It does **not** become `complete`. It does **not** become `escalated` merely to
make it leave a queue. It stays visible **because the underlying work still has
not happened.**

The conversion rung's local window and the operating obligation are different
truths:

```
rung window          →  closed as missed
operating obligation →  still open and actionable
```

That is not a contradiction. **The window ended; the work did not disappear.**

If the lead or workflow later becomes genuinely terminal, a separate governed
closure path may resolve the obligation. **Missing a deadline alone cannot close
it.**

This aligns with the operating doctrine: a missed commitment should move the
signal and remain actionable rather than disappear cosmetically.

---

## Part 4 — Timeliness model (three states, not two)

My earlier proposal read `missed` from the durable fact **first and the clock as
fallback**. That was wrong, and the ruling corrects it: a clock fallback keeps
conflating a live calculation with a durable institutional fact. With no sweeper,
it would have meant an obligation became "missed" merely because somebody opened
a page after the deadline — inventing an institutional recognition that never
occurred.

```
before threshold                                  →  on_time / due
clock crossed threshold, NO durable recognition   →  overdue
missed_at exists                                  →  missed
```

- **`overdue`** is a clock-derived *operating condition*. It moves with the clock,
  and that is correct for what it is.
- **`missed`** is a durable *institutional fact*: the recovery window was
  recognised as missed, by someone or something, at a recorded time.

`missed` is **never** derived from the clock. Until something writes `missed_at`,
the honest answer is `overdue`.

---

## Part 5 — The service contract

### `recognizeObligationMissed(client, spec)`

**Required inputs** — the service refuses without them:

| Input | Why |
|---|---|
| `obligation_id` | the subject |
| `expected_status` | stale-state protection — a concurrent resolution loses rather than double-applies |
| `threshold_at` | the deadline being recognised as crossed, stated by the caller |
| `recognized_by_user_id` **or** `system_actor` | who recognised it; never anonymous |
| `reason` / `source` | why, and by which path |
| `idempotency_key` | a repeat recognises nothing new |

**Guarantees:**

1. **Atomic.** `missed_at`, `missed_threshold_at` and the immutable
   `obligation_missed` event are written in ONE transaction, or none of them are.
2. **Threshold actually crossed.** Refuses if the obligation has not in fact
   passed `threshold_at`. A recognition cannot be asserted into existence.
3. **Stale state fails closed.** If the obligation no longer matches
   `expected_status`, refuse — same discipline as `transitionObligation`.
4. **Write-once.** `missed_at` is stamped only when null. A later call cannot
   rewrite *when* the miss happened.
5. **Idempotent.** A repeat with the same key writes nothing and creates no
   second event.
6. **Lifecycle untouched.** The service never writes `obligations.status`.
7. **Never rewrites `due_at`**, and never erases later completion history. An
   obligation completed *after* being missed keeps both facts.

### Migration (not written)

Adds to `obligations`, nullable, write-once by service discipline:

- `missed_at timestamptz` — when the miss was recognised;
- `missed_threshold_at timestamptz` — the deadline that was crossed.

**No enum widened. No constraint touched.** `ck_obl_status` is left exactly as it
is — that is the whole point of the ruling.

**Migration number: query `schema_migrations` and cross-check unmerged
branches.** The isolated branch measured ceiling **122**
(`governed_economics_lineage`) on 2026-08-01, and a parallel thread holds
unmerged numbers. Do not assume 123.

---

## Part 6 — Scenario 8, rewritten

It must no longer expect `status='missed'`, and must no longer expect the
obligation to leave the queue. It proves:

1. the conversion link records `outcome='missed'`;
2. the rail ledger (069) records the missed resolution and its time;
3. **the obligation retains its prior lifecycle status**;
4. `missed_at` and `missed_threshold_at` are durable;
5. exactly **one** immutable `obligation_missed` event exists;
6. the obligation **remains visible** for recovery;
7. repeating the recognition is **idempotent** — no second event.

---

## Part 7 — Explicitly OUT of this slice

- **The sweeper.** Automatic detection: cadence, ownership, retries, locking,
  recovery behaviour. Its own slice.
- **Consolidating the eight clock-derived reads.** Audited and documented in §1.3,
  deliberately not normalised here — normalising eight surfaces while introducing
  the primitive would broaden the build. A follow-on projection slice can unify
  `overdue`, `missed_window` and `missed_commitment` into one canonical timeliness
  read **after** the durable primitive is proven.

---

## Part 8 — Process lesson (recorded, 2026-08-01)

**Never force-push or reuse a shared branch without comparing it to origin
first.**

This proposal was first committed onto `claude/getting-up-to-speed-nyf4ww`, after
resetting it to `origin/main`. The push was rejected as non-fast-forward. That
branch held **19 unmerged commits** — the entire resident-SMS slice. A `--force`
would have destroyed them.

The rejection was luck, not process. The rule:

```
git fetch origin <branch>
git log --oneline origin/main..origin/<branch>     # what would be lost
```

before any reset, rebase or force-push of a branch that is not exclusively yours.
Unrelated work gets its own branch — as this proposal now has.
