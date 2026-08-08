# Release 0 — post-activation completion guard (migration 140)

**⛔ BUILD-AHEAD. Not applied to production.**

After the cutover, a work order may not become terminal unless a proof evaluation
justifies it. **Enforced by the database**, so it holds for every writer: application
code, a utility script, a `psql` session, a route nobody has written yet.

---

## The risk this closes

Step 6 closes the one legacy done-path we know about. It cannot close the ones we
do not. This repository still carries **87 scripts that build a connection from
`DATABASE_URL` with no guard, 67 of them write-capable** (`gate_harness_isolation.js`).

Before activation, a stray `closed` row is untidy. **After activation it is
terminal, absent from the immutable inventory, and therefore
`missing_evaluation_defect`** — an obligation raised against a named role for
something the *system* did. And the activation is not reversible: the inventory
tables are append-only with `forbid_mutation` triggers.

**A repo-wide cleanup of 67 scripts cannot produce a guarantee**, because it says
nothing about the 68th. One boundary every write must pass through can.

---

## Why a trigger and not the alternatives

| candidate | why not |
|---|---|
| `CHECK` constraint | cannot reference other tables; the rule needs three of them |
| revoke `UPDATE` on `work_orders` | breaks every legitimate non-completion write |
| a service-layer guard | is exactly what the 67 scripts bypass |
| patch the 67 scripts | says nothing about the 68th, and never finishes |
| `RULE` / view indirection | rewrites the statement — a **silent** change, which the brief forbids |

A `BEFORE INSERT OR UPDATE` row trigger is the narrowest thing that sees every
write and can refuse one explicitly.

---

## What it does

```text
1  not entering a terminal status        → pass
2  already terminal (an ordinary update) → pass
3  no activation exists                  → pass    (INERT before the cutover)
4  the row is in the cutover inventory   → pass    (legitimate legacy history)
5  the row has a proof evaluation head   → pass    (a governed completion)
6  otherwise                             → RAISE, errcode R0001
```

### It is inert until activation, on purpose

With no activation row the trigger returns immediately. That is not a weakness —
before the cutover, legacy terminal rows are exactly what the inventory exists to
record, and blocking them would break the census this release depends on.

**So this migration is safe to apply at any time.** It changes no behaviour until
Step 7 runs, then arms itself. It needs no deployment window of its own — and it
**must not be sequenced after activation**, because the window it protects opens
the instant the activation commits.

### The canonical writer passes with no change to it

`claimCompletion` writes the proof evaluation **before** it sets the status,
deliberately (§4: *"written first and the rest is contingent on it"*). By the time
the trigger runs, in the same transaction, the evaluation head already exists.

**The guard required zero changes to the writer.** That is the strongest evidence
available that it is drawn at the right boundary.

### No bypass

There is deliberately no session flag, no GUC, no service-role exemption. **A
bypass a utility script can set is not a guarantee; it is a comment.** Removing the
guard requires `DROP TRIGGER` — a deliberate, auditable DDL act. `G8` asserts no
`current_setting()` escape has appeared.

---

## Proof — every negative case is a real bypass attempt

"No path" is not provable by reading source; that is what the 67 scripts already
demonstrate. So each refusal below is raw SQL **on its own pooled connection** —
the same driver, the same kind of connection a utility script uses.

```text
tools/step12/prove_completion_guard.js   33 / 33   exit 0
```

```text
I1–I2   before activation a raw close SUCCEEDS — required, not a hole
C1–C4   claimCompletion still completes, and still refuses with no evidence
B1–B4   a raw UPDATE to 'complete' is refused with errcode R0001, naming what
        is missing and what to use instead, and the row is UNCHANGED
B5      'closed' is refused the same way
B6–B7   a SET-BASED close over a whole property is refused, and NOT ONE row
        moved — a partial close is worse than a refused one, because some
        rows would be defects and nobody would know which
B8–B9   a direct INSERT of a completed work order is refused; no row created
B10     a preserved PHOTO alone does not satisfy it — the evaluation is the
        governed judgement, the photo is only its input
L1–L7   non-terminal statuses, ordinary column updates, inventoried legacy
        rows and already-complete rows all still work
A1–A2   the guard's terminal set IS the reader's, checked in source
A·×2    …and behaviourally: every status the reader calls terminal, the
        guard refuses
X1–X5   THE LOAD-BEARING CONTROL
D1      after every attempt, ZERO manufactured defects exist
```

### X is the control that matters

Every refusal above is worthless if something *else* was refusing. So the guard is
**dropped**, the identical bypass is retried, and it **succeeds** — manufacturing
exactly the defect this release exists to prevent. Then it is restored and refuses
again.

Without `X2`, the whole section proves only that *something* said no.

---

## ⚠ What this means for the §4.2 sweep

The census inventories **every** terminal-and-unevaluated row. So immediately after
activation the defect population is **empty by construction** — and if migration 140
is live at that moment, nothing can add to it.

**The sweep stops being routine cleanup and becomes an audit that the guard held.**

That is a better job for it, and it resolves the standing concern about there being
no scheduler: there should be nothing to sweep. **A non-empty sweep result is now a
signal that the guard was dropped, was deployed late, or has a gap** — which is
worth investigating rather than worth automating.

It also means the guard should be deployed **before or with** Step 7, never after.
The runbook now says so.

---

## Residual gaps, named rather than folded in

**`status` has no CHECK constraint on `work_orders`.** A writer could invent
`'Complete'` or `'COMPLETED'`, which neither this guard nor the reader treats as
terminal. That row would be **invisible** rather than a manufactured defect — a
different and smaller problem, but a real one. Constraining the vocabulary is a
broader change touching existing data, and it is not folded in here.

**The guard is scoped to `work_orders`.** It says nothing about other tables, and
nothing about a script that deletes rows.

**It cannot stop a privileged operator dropping it.** That is by design — the
alternative is a guard nobody can remove when it is wrong — but it means the
control is *auditable*, not *absolute*. `where_are_we.js` should report whether the
trigger is installed; that is the next small piece.

---

## Migration ledger

`138` and `139` are Release 0's. **This is also Release 0's, so it takes `140`** —
which moves the text-line silo's next number to `141`. Flagged because the earlier
rule said "the next unrelated migration starts at 140", and this one is not
unrelated.
