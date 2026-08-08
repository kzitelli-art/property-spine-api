# Release 0 — the forbidden committed state (migration 140)

**⛔ BUILD-AHEAD. Not applied to production.**

> **No non-inventoried work order may commit in a terminal state that the canonical
> reader would classify as `missing_evaluation_defect`.**

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

It also means a transaction may pass **through** the forbidden state and still
commit, provided it does not **end** there (`D3`).

**It re-reads; it does not trust `NEW`.** `NEW` is the row as queued. By commit time
it may have moved again, so the function reads the current row and uses `NEW` only
for identity. `G10` asserts this.

---

## 4 · One forbidden state, not a second reader

`proof_state.js` derives four states. This enforces the negation of **one** and
knows nothing about the other three:

```text
an evaluation head exists            → satisfied / not_satisfied
not terminal                         → not yet due
terminal + inventoried               → legacy_indeterminate
terminal + NOT inventoried + no head → *** FORBIDDEN ***
```

**It accepts any head, including `not_satisfied`.** A work order evaluated and
*failed* is not a defect — it is a judgement that was made. Requiring `satisfied`
would enforce more than the forbidden state and block a legitimate outcome (`E2`,
`G11`).

Interpretation still belongs to the reader and the sweep.

---

## 5 · Activation-aware, and safe to apply now

With no activation the reader reports `unavailable`, never `defect` — so there is no
forbidden state and the trigger returns immediately. Pre-cutover terminal rows are
exactly what the census inventories.

**So it can be applied at any time, and it must NOT be applied after the
activation** — the window opens when that transaction commits.

---

## 6 · Proof — every negative case is direct SQL

Proving this through the application services would prove something about the
services. The threat is the path that avoids them.

```text
tools/step12/prove_completion_guard.js   47 / 47   exit 0
```

```text
W1–W3   the frozen writer inventory: 3 shipped, 0 production utilities
I1–I2   before activation, a direct close SUCCEEDS — required, not a hole
D1–D2   terminal FIRST, evaluation AFTER → commits
D3–D4   passing THROUGH the forbidden state and leaving it → commits
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

### The three that carry the most weight

**`X2`** — every refusal above is worthless if something *else* was refusing. So the
guard is dropped, the identical bypass is retried, and it **succeeds**. `X3` then
has the **canonical reader** classify the result as `missing_evaluation_defect` —
confirming the forbidden state by the reader's own verdict, not this file's opinion.

**`B7`** — a set-based close moves *nothing*. A partial close is worse than a
refused one: some rows would be defects and nobody would know which.

**`Z2`** — the verdict is not "47 assertions passed". It counts the forbidden
population in SQL, then reads **every** work order through the canonical reader and
requires zero defects.

---

## 7 · What can still defeat it, measured

```text
SET CONSTRAINTS ALL IMMEDIATE     does NOT bypass — it moves the check
                                  EARLIER. Proven (V1), because a reader of
                                  this trigger might reasonably fear otherwise.

session_replication_role=replica  DOES disable constraint triggers —
                                  but setting it is SUPERUSER-ONLY. A
                                  non-superuser role is refused with
                                  "permission denied to set parameter" (V2).

DROP TRIGGER                      by the table owner. Deliberate, auditable
                                  DDL. No flag, by design.
```

**Everything holding `DATABASE_URL` is covered.** The application role on Neon is
not a superuser, so the one runtime bypass is unavailable to every script, route and
`psql` session in the threat model. The remaining defeats are DDL — auditable acts,
not accidents.

**This is a control that is auditable, not absolute**, and that is the honest
description. `where_are_we.js` reads whether the trigger is installed rather than
assuming it.

---

## 8 · What it means for the §4.2 sweep

The census inventories **every** terminal-and-unevaluated row, so the defect
population is **empty by construction** at activation — and with the guard live,
nothing can add to it.

**The sweep becomes an audit that the guard held, not routine cleanup.** That
resolves the standing "no scheduler" concern: there should be nothing to sweep, and
**a non-empty result is a signal to investigate** — the guard was dropped, deployed
late, or has a gap.

---

## 9 · Residual gaps, named rather than folded in

**A pre-existing forbidden row blocks writes to itself.** If one exists (guard
deployed late, or dropped), any update touching it fails until it is resolved. The
two resolutions are the governed ones — record an evaluation, or take it out of
terminal — and both work (`E1`, `E3`). A broad `update … where property_id=X` will
fail while any such row exists in that property. **Correct, and worth knowing.**

**`status` has no CHECK constraint.** A writer could invent `'Complete'`, which
neither the guard nor the reader treats as terminal. That row is **invisible** rather
than a manufactured defect — a different and smaller problem. Constraining the
vocabulary touches existing data and is not folded in here.

**Scope is `work_orders`.** Nothing about other tables, and nothing about deletes.

---

## 10 · Ledger

`138`/`139` are Release 0's; so is this, so it takes **`140`**, moving the text-line
silo to `141`. Flagged because the earlier rule said "the next unrelated migration
starts at 140" — this one is not unrelated.
