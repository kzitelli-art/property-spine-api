# Release 0 — completion-writer matrix

**Source audit. No database was read. No production connection was opened.**
Derived by reading `src/` at API `main` `ec98877`, the SHA recorded in
[`RELEASE_0_AUDIT_PLAN.md`](RELEASE_0_AUDIT_PLAN.md) §0.

Purpose: Open Ruling 1 classifies a completed work order by comparing its
completion timestamp to the activation boundary. This document establishes,
from source, **which code paths complete a work order and which of them record
a completion timestamp at all.**

---

## 1. The matrix

| # | Writer | Sets `work_orders.status` to | Writes `work_order_progress` `kind='completed'`? | Where its proof lives |
|---|---|---|---|---|
| 1 | `src/technician/lifecycle_service.js:178` | `'complete'` | **YES** — `:192` via `appendProgress` | `work_order_proof_attachments` rows |
| 2 | `src/maintenance/maintenance.js:553` | **`'closed'`** | **NO** | `work_orders.completion_photo` (text column) |
| 3 | `src/maintenance/maintenance.js:500` | `'needs_followup'` | NO | n/a — not a completion |
| 4 | `src/comms/tenantlink.js:1652` | caller-supplied, **whitelisted** | n/a | n/a — cannot complete |
| 5 | `src/maintenance/work_order_service.js:588`, `:634` | does not write `status` | n/a | n/a — urgency fields only |
| 6 | `src/maintenance/readiness_service.js:313` | writes `obligations`, not `work_orders` | n/a | n/a — not a work-order writer |

`work_order_progress` has exactly **one** insert site in the entire repository —
`appendProgress` at `lifecycle_service.js:78` — and it is reached for
`kind='completed'` from exactly one caller, `:192`. That is verified by grep
across `src/` and `server.js`, not assumed from the comment that claims it.

### 1.1 Writer 4 is correctly guarded — noted so nobody re-audits it

`tenantlink.js` accepts a caller-supplied status, which reads alarming. It is
fine, and the guard is explicit two ways (`:1618-1624`):

```js
if (status === "complete") {
  return res.status(409).json({ /* "Completion has its own gate." */ });
}
if (status && !["open", "scheduled"].includes(status)) {
  return res.status(400).json({ /* … */ });
}
```

It cannot produce a completion. **It can produce neither `'complete'` nor
`'closed'`.**

---

## 2. ⚠ The finding: there are two live completion lanes, and they disagree

Writer 1 and Writer 2 are both **live**. `maintenanceModule` is mounted at
`server.js:2985`, so `PATCH /work-orders/:id/closeout` is a reachable route
today, not dead code.

They do not agree on anything that matters:

```text
                      Writer 1 (technician)      Writer 2 (closeout route)
status written        'complete'                 'closed'
completion timestamp  work_order_progress row    NONE — no progress row
proof model           attachment rows, classified   completion_photo text column
proof gate            classification-based        both columns non-empty
recognised as done
  by lifecycleStateOf YES                        NO
```

`lifecycleStateOf` (`work_order_status_read.js:47`) tests exactly one value:

```js
if (workOrder.status === "complete") return "completed";
```

### 2.1 What a Writer 2 work order renders as today

Walk `lifecycleStateOf` for a work order closed through the closeout route —
`status='closed'`, `completion_photo` set, no progress rows, no attachment rows:

```text
status === 'complete'?          no   — it is 'closed'
completion_claimed progress?    no   — Writer 2 writes no progress at all
no_access / blocked / en_route? no
acceptance.accepted_at?         only if an obligation was accepted
                                → otherwise falls through
RESULT                          "scheduled"
```

and `proof.satisfied` is computed from `work_order_proof_attachments`, which
has no rows for this work order, so it is **`false`**.

**A work order that was closed, with a photo, through the route whose own
comment calls itself "THE PROOF GATE", renders to the operator as `scheduled`
with proof unsatisfied — and `nextActionFor` tells them "Assign or accept the
work."** Work that is finished and evidenced is displayed as work not yet
started.

This is a live §5 confident-wrong on the current board and it is **independent
of Release 0**. It is not caused by the line-90 defect and is not fixed by
correcting it.

### 2.2 Why this lands inside the Release 0 audit

Not because Release 0 should fix it — that is a separate ruling and a separate
slice. Because **it invalidates the audit's own filter.**

Every draft query in `RELEASE_0_AUDIT_PLAN.md` §4 selected
`where w.status = 'complete'`. That predicate silently excludes the entire
Writer 2 population. An audit that ran with it would report a completed-work
census that is missing a whole lane, and would report it as a clean, fully
receipted answer — the exact failure §6 of the charter describes, arriving
through a different door.

The plan's queries are corrected to census **all** status values rather than
assume the vocabulary. `001_baseline.sql` comments the column as
`open|scheduled|complete`; the code writes at least `needs_followup` and
`closed` beyond that, so the comment is not a reliable enumeration and the
audit must not treat it as one.

---

## 3. What this does NOT decide

**Three questions are raised here and none is answered.** Each is a ruling, and
§19 reserves rulings to the owner or to named engineering decisions.

1. **Does a Writer 2 work order count as completed for Release 0?** It has real
   proof, in a form the new proof reader cannot see. `legacy_indeterminate` is
   worded closely enough to be tempting — *"Completed under the prior proof
   model. No historical evaluation was recorded."* — but these rows are not
   `status='complete'`, so they never reach the classification at all.
2. **Do the four published proof states of Open Ruling 2 cover the real data?**
   Column-stored photo proof is a third proof model, and no published state
   describes it.
3. **Should the closeout route keep writing `'closed'`?** Changing it is a
   product-behaviour change and is explicitly out of scope for this branch.

**This document asserts none of the three.** It records what the source does,
so the ruling is made against facts rather than against an assumption about
what "completed" means.

---

## 4. Consequence for the build sequence

The Release 0 proof-state writer must not be built until questions 1 and 2
above are ruled. Building it now would mean implementing a four-state contract
whose coverage of the real completion population has not been established —
and the audit exists precisely to establish that.

Work stops at the audit tooling. **No migration, no writer, no contract change.**

---

## 5. Classification (§18)

| Component | Class | Removal condition |
|---|---|---|
| This document | 1 — permanent record | Never removed. It is the source-derived basis for a ruling about what "completed" means. |
