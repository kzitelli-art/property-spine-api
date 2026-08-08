# Release 0 — completion truth, enforced at commit (migration 140)

**⛔ BUILD-AHEAD. Not applied to production.**

**REVISION 2.** Revision 1 enforced a weaker invariant and **four adversarial cases
broke it** (§4). The invariant was wrong, not the callers. What it enforces now:

> **After activation, a work order may be terminal only with a current `satisfied`
> proof evaluation, or as inventoried pre-cutover legacy with no evaluation at all —
> and inventoried legacy may not leave the terminal state.**

Enforced by the database, at commit time.

---

## 1 · First, the real writer count

**"87 scripts open `DATABASE_URL` with no guard, 67 write-capable"** is a true
warning and the **wrong number for this decision**. Write-capable means a script
*could* write something. The question is narrower: *which paths can put a terminal
status on a work order?*

Scanned (`tools/step12/terminal_writers.js`, re-derived every run):

```text
SHIPPED, terminal-capable — 3
  src/technician/lifecycle_service.js:311   UPDATE 'complete'   the CANONICAL writer
  src/maintenance/maintenance.js:564        UPDATE 'closed'     the LEGACY closeout (Step 6)
  src/comms/tenantlink.js:1652              UPDATE $1           PARAMETERIZED

SHIPPED, non-terminal
  src/maintenance/maintenance.js:511        UPDATE 'needs_followup'
  src/maintenance/work_order_service.js:299 INSERT 'open'

PRODUCTION UTILITY / REPAIR SCRIPTS writing a terminal status — ZERO
```

`tenantlink.js` is counted terminal-capable **even though** the route refuses
`complete` and allows only `open`/`scheduled` today. The database sees a bound
parameter; the guard is one edit away from being wrong.

**The conclusion that matters:** no existing production script writes a terminal
status. **The exposure is hand-run SQL and code not yet written** — precisely what a
script audit cannot fix and a database boundary can. `W2` freezes this list, so a
new shipped writer fails a gate instead of arriving unnoticed.

---

## 2 · It protects the state, not the caller

Deliberately **not** *"only `claimCompletion` may write a completion."* Caller
identity is unenforceable at the database and worthless against hand-run SQL. What
*is* enforceable is the shape of the committed row — and that is the thing that
causes harm.

Consequences of choosing the state:

- any writer may complete work, **provided it leaves a legal state**
- a caller nobody has written yet is already covered
- no application flag, no session variable, no service role — none of which
  survives a second process sharing `DATABASE_URL`

---

## 3 · Deferred: only the committed state is judged

A `CONSTRAINT TRIGGER … DEFERRABLE INITIALLY DEFERRED`. It fires at **commit**, so a
transaction may write its facts in any order:

```sql
begin;
  update work_orders set status='complete' ...;   -- terminal FIRST
  insert into work_order_proof_evaluations ...;   -- evidence AFTER
commit;                                           -- LEGAL  (D1)
```

**An immediate trigger would refuse that**, and would pin a database invariant to
the canonical writer's current statement order. §4 happens to write the evaluation
first — but then an innocuous refactor breaks production. Deferring removes the
coupling entirely.

It also means a transaction may pass **through** an illegal state and still commit,
provided it does not **end** there (`D3`).

**It re-reads; it does not trust `NEW`.** `NEW` is the row as queued. By commit time
it may have moved again, so the function reads the current row and uses `NEW` only
for identity. `G10` asserts this.

---

## 4 · What revision 1 got wrong — the four attacks

Revision 1 enforced only *"not the `missing_evaluation_defect` state"*. Four attacks
in `tools/step12/falsify_containment.js` reached a post-activation work order the
system cannot stand behind, **without ever touching that state**.

### A1 · terminal with a *failed* evaluation

Allowed. The reader then reported `status=complete` with
`proof.state=not_satisfied`.

Revision 1's reasoning was *"a judgement was made"*. True, and beside the point:
**Release 0 governs completion, not whether somebody made a judgement.** A failed
proof evaluation is perfectly valid data and is **not** sufficient to justify a
terminal status.

→ *the head must be `satisfied`.*

### A2 · the proof head flipped *after* completion

Appending a superseding `not_satisfied` evaluation to a completed work order touches
**no `work_orders` row**, so a trigger on that table never fired. The invariant is
**cross-table** and one table's trigger cannot hold it.

→ *the same predicate also fires on `work_order_proof_evaluations` insert.*

### A3 · legacy exemption laundering

`closed → open → closed` on an inventoried row was allowed, and the reader still
called the result `legacy_indeterminate`. The inventory is immutable, so membership
was a **permanent, reusable licence** to complete work without proof. Historical
grandfathering had become a future bypass.

→ *an inventoried row may not leave terminal at all.* Reopening pre-cutover work is
"a different, governed act that this slice does not build" — this makes that sentence
true rather than aspirational.

### A4 · a transaction straddling activation

At `REPEATABLE READ`, a transaction that began before the activation committed
afterwards, because **the deferred check reads through the transaction's own frozen
snapshot** and never saw the activation row. No `SELECT` escapes its own snapshot, so
this is **not fixable in the trigger**.

→ *closed on the other side:* the activation transaction takes
`SHARE ROW EXCLUSIVE` on `work_orders` (`lock_timeout` 5s), which conflicts with any
in-flight DML. If a writer is mid-transaction the activation **refuses** with
`WRITERS_IN_FLIGHT` rather than opening the window underneath it.
`READ COMMITTED` was already refused correctly.

**One predicate, three entry points.** `release_0_assert_completion_truth(uuid)` is
the whole rule; the triggers are thin wrappers that name the work order. Two copies
of a rule that must never differ is the drift this release exists to end.

---

## 5 · Activation-aware — and the activation now depends on it

With no activation the reader reports `unavailable`, never a proof verdict, and
pre-cutover terminal rows are exactly what the census inventories. So the trigger
returns immediately and the migration is safe to apply at any time.

**It must be applied BEFORE the activation** — the window opens when that transaction
commits, and the activation cannot be undone.

So the dependency is enforced rather than documented. `recordActivation` calls
`assertContainmentGuardPresent` and **refuses to activate** unless:

- `release_0_assert_completion_truth` exists, and its body still contains every
  clause the invariant needs (`release_0_activation_current`,
  `release_0_legacy_cutover_inventory`, `work_order_proof_evaluation_head`,
  `'satisfied'`, `R0002`) — `GUARD_STALE` otherwise, **not** just a name check;
- all three constraint triggers exist **and are still `DEFERRABLE INITIALLY
  DEFERRED`** — a trigger silently recreated as immediate is a different control.

Failure is `GUARD_ABSENT` / `GUARD_STALE`, and the activation does not happen
(`A7`). Detecting a missing guard *after* an irreversible act is useless.

**Every proof harness that activates therefore installs migration 140** — and any
harness that must *exhibit* a forbidden state (the reader's four states, the sweep's
defect population, Step 4's hollow completion) builds it inside an explicit
`guardWindow.withGuardOff(db, why, …)` window that requires a written reason and
restores by re-applying the migration. Reading those call sites is the shortest
honest summary of what migration 140 actually prevents.

---

## 6 · Proof — every negative case is direct SQL

Proving this through the application services would prove something about the
services. The threat is the path that avoids them.

```text
tools/step12/prove_completion_guard.js   47 / 47   exit 0
tools/step12/falsify_containment.js      18 / 18   exit 0
```

```text
W1–W3   the frozen writer inventory: 3 shipped, 0 production utilities
I1–I2   before activation, a direct close SUCCEEDS — required, not a hole
D1–D2   terminal FIRST, evaluation AFTER → commits
D3–D4   passing THROUGH an illegal state and leaving it → commits
D5–D7   the offending STATEMENT succeeds; the COMMIT refuses; nothing remains
C1–C4   claimCompletion passes unchanged, and still refuses with no evidence
B1–B5   direct UPDATE to complete/closed refused, errcode R0001, row unchanged
B6–B7   a SET-BASED close over a whole property refused, NOT ONE row moved
B8–B9   a direct INSERT of a completed work order refused; no row created
B10     a preserved photo without an evaluation does not satisfy it
B11–B12 a terminal write rolled back to a SAVEPOINT commits cleanly
E1–E6   the two legitimate ways out, and every ordinary write, still work
K1–K3   a transaction cannot borrow an UNCOMMITTED evaluation
V1–V3   the bypass surface, measured
X1–X5   drop the guard and the identical bypass SUCCEEDS
Z1–Z2   independent census: zero forbidden rows, confirmed by the READER
```

`falsify_containment.js` records its **prediction before its result** for each attack,
so a wrong model is visible as a wrong prediction rather than edited away afterwards:

```text
A1  terminal + not_satisfied              REFUSED   (R0001)
A2  head flipped after completion         REFUSED   (R0001, from the eval table)
A3  legacy laundering closed→open→closed  REFUSED   (R0002)
A4  straddling transaction                the ACTIVATION refuses: WRITERS_IN_FLIGHT
A5  who can actually drop the guard       measured, not assumed — see §7
A6  an unknown status                     not refused; where the work goes — see §9
A7  activation without the guard          REFUSED   (GUARD_ABSENT / GUARD_STALE)
Z1  every row through the canonical reader — none completed without satisfied proof
```

### The three that carry the most weight

**`X2`** — every refusal above is worthless if something *else* was refusing. So the
guard is dropped, the identical bypass is retried, and it **succeeds**. `X3` then
has the **canonical reader** classify the result as `missing_evaluation_defect` —
confirming the forbidden state by the reader's own verdict, not this file's opinion.

**`B7`** — a set-based close moves *nothing*. A partial close is worse than a
refused one: some rows would be defects and nobody would know which.

**`Z1`/`Z2`** — the verdict is not "47 assertions passed". It counts the forbidden
population in SQL, then reads **every** work order through the canonical reader and
requires zero rows that read as completed without a `satisfied` proof.

---

## 7 · What can still defeat it, measured

```text
ordinary DML (anything holding DATABASE_URL)  COVERED

SET CONSTRAINTS ALL IMMEDIATE     does NOT bypass — it moves the check
                                  EARLIER. Proven (V1), because a reader of
                                  this trigger might reasonably fear otherwise.

session_replication_role=replica  DOES disable constraint triggers —
                                  but setting it is SUPERUSER-ONLY. A
                                  non-superuser role is refused with
                                  "permission denied to set parameter" (V2).

DROP TRIGGER by the TABLE OWNER   *** POSSIBLE ***  measured in A5: a
                                  NON-SUPERUSER that owns work_orders CAN
                                  drop these triggers.
```

**The honest claim, and the only one this file makes:**

> **Accidental DML bypass is prevented. Privileged DDL remains an auditable escape.**

An earlier draft said *"everything holding `DATABASE_URL` is covered"* and treated the
DDL escape as theoretical. `A5` measured it instead. The first version of that test
targeted a **stale trigger name**, the `DROP` failed with `42704` (does not exist),
and it reported "the owner cannot drop it" — a false reassurance produced by a
misaddressed test. `A5.2` exists to catch exactly that, and once the names were
corrected the drop **succeeded**.

That escape is not closed here, and the mitigation is stated rather than implied:
§5's activation precondition re-reads the trigger definitions, so a dropped or
altered guard **fails the one irreversible act**. `where_are_we.js` reads whether the
trigger is installed rather than assuming it.

**This is a control that is auditable, not absolute.**

---

## 8 · What it means for the §4.2 sweep

The census inventories every terminal-and-unevaluated row at the cutover, and with
the guard live nothing can add to that population through ordinary DML.

**But "empty by construction" is a claim about the guard, not a fact about the
data**, and this file no longer makes it. The population can be non-empty if the
guard was deployed late, dropped by an owner (§7), or if a row was written through a
path this model has not anticipated. **That is what the sweep is for.**

**The sweep is an audit that the guard held, not routine cleanup.** There should be
nothing to sweep, and **a non-empty result is a signal to investigate** rather than a
queue to work through.

---

## 9 · Residual gaps, named rather than folded in

**A pre-existing forbidden row blocks writes to itself.** If one exists (guard
deployed late, or dropped), any update touching it fails until it is resolved. The
two resolutions are the governed ones — record a `satisfied` evaluation, or take it
out of terminal — and both work (`E1`, `E3`). A broad `update … where property_id=X`
will fail while any such row exists in that property. **Correct, and worth knowing.**

**`status` still has no CHECK constraint** — measured, not assumed: on the isolated
ledger-137 baseline `work_orders.status` is `text not null default 'open'` with no
check. A writer could invent `'Complete'`, which neither the guard nor the reader
treats as terminal.

`A6` asked where that work actually goes, rather than assuming. The row is **not**
lost from the operator surface — it still appears on the list read — and it is not a
manufactured defect either. It is simply **not governed by Release 0**: nothing
renders it as completed, and nothing bills anyone for it.

The vocabulary is pinned in **source** instead, by
`tests/gate_work_order_status_vocabulary.js` on the standard `npm run verify` path:
every status shipped source writes is frozen and classified terminal / non-terminal
with its writer named, variable writes must be narrowed by their own file's
allow-list, and the terminal subset must equal both the reader's `TERMINAL_STATUSES`
and migration 140's SQL.

```text
open            not terminal   work_order_service.js · tenantlink.js
scheduled       not terminal   tenantlink.js (route allow-list)
needs_followup  not terminal   maintenance.js — the source says it STAYS OPEN
closed          TERMINAL       maintenance.js — the legacy closeout
complete        TERMINAL       technician/lifecycle_service.js — canonical
```

A database `CHECK` was **considered and deferred**. `NOT VALID` still refuses future
writes, and this vocabulary is derived from *shipped source*, not from production
data — which this session must not read. If production carries a status this list
does not know about, the constraint would start refusing ordinary writes on rows
nobody was completing. *A gate that fails the fix is worse than no gate.* Reading the
live vocabulary is a production step, named in the activation runbook; the `CHECK`
becomes the right move after that, not before it.

**Scope is `work_orders` and `work_order_proof_evaluations`.** Nothing about other
tables, and nothing about deletes.

---

## 10 · Ledger

`138`/`139` are Release 0's; so is this, so it takes **`140`**, moving the text-line
silo to `141`. Flagged because the earlier rule said "the next unrelated migration
starts at 140" — this one is not unrelated.
