# Progress-replay savepoint fix — isolated deployment

**One function. No migration. No product doctrine. No Release 0 dependency.**

Extracted from the Steps 2–3 candidate (PR #50) at the owner's direction so that
a live failure gets fixed on its own boundary rather than riding a release.

```text
deployable delta   src/technician/lifecycle_service.js — 33 insertions, 2 deletions
                   inside one function, appendProgress
schema             none. Runs at the ledger production is already at.
product meaning    unchanged. No new refusal, no new status, no new sentence.
```

Everything else in this change is Class 2 test tooling: the isolated-Postgres
baseline builder (which had never been merged to `main`) and one proof file.

---

## What was broken

`appendProgress` caught PostgreSQL `23505` — a duplicate idempotency key, which
is what a carrier redelivery looks like — and then issued a recovery `SELECT` to
return the fact already recorded.

PostgreSQL aborts the **whole** transaction on a failed statement. With no
savepoint between the failing `INSERT` and that `SELECT`, the `SELECT` does not
run. It raises `25P02`, *current transaction is aborted, commands ignored until
end of transaction block*.

**The handler written to make a redelivery harmless was itself the thing that
threw.**

### Why it was silent rather than loud

`tenantlink`'s inbound-SMS wrapper rolls back on any throw, and has one special
case: `if (e.code === "23505")` → *"operations turn already answered — duplicate
suppressed"*, which is correct behaviour for a real duplicate.

The pre-fix error was **not** `23505`. It was `25P02`. So the wrapper fell
through to the generic branch — log the failure, send no reply — and the
technician got nothing back. Not a completion, not a refusal, not a sentence.

`R2` in the proof asserts that error code specifically, because the explanation
of *why* this was silent depends on it.

### The trigger is ordinary

```text
1  technician texts "done" with no usable photo
   → the claim is RECORDED, the work order stays OPEN (correct behaviour)
   → a live idempotency key now sits on an open work order
2  the carrier redelivers that same message
   → 23505 → recovery SELECT on an aborted transaction → 25P02 → silence
```

No exotic timing, no race between two operators. A phone with one bar does this.
`P7`–`P10` walk exactly that sequence.

---

## The fix

A `SAVEPOINT` around the progress insert, rolled back to before the recovery
read. Same discipline as the read-only audit probes: **a probe must not poison
the transaction it is probing.**

Two smaller holes in the same handler closed with it:

```text
before   a 23505 with NO idempotency key was absorbed as a replay — but with
         no key there is nothing to look the prior fact up by, so it returned
         { replayed: true, row: undefined }: a replay that never happened.
before   a keyed 23505 whose lookup found nothing did the same.
after    both rethrow.
```

134's partial index on `idempotency_key` is the only unique index on
`work_order_progress`, so in production a `23505` reaching this handler is
always the redelivery case. The rethrow branch is therefore unreachable in
production — which is exactly why the proof installs a second unique index to
make it observable, asserts it, and drops it. A branch that cannot be observed
is indistinguishable from a comment.

### One behaviour change worth naming

Before the fix, a rethrown error left the transaction **aborted**, so a caller
that swallowed it would have found `commit` silently degrade to `rollback`.
Safety by accident.

After the fix the transaction is **usable** on the rethrow path, so the caller's
rollback is what protects the turn. `Q3` asserts the transaction survives;
`T1` asserts `tenantlink` rolls back on any throw. Both, because the first is
only safe given the second.

---

## Proof

```text
tools/savepoint/prove_progress_replay.js   22 / 22   exit 0   twice, clean baselines
npm run verify (8 gates)                   PASS      exit 0
```

```bash
bash tools/scale/setup_baseline.sh
SAVEPOINT_DATABASE_URL='postgresql://postgres@127.0.0.1:5433/r0scale?sslmode=disable' \
  node tools/savepoint/prove_progress_replay.js
```

The falsification is the load-bearing part. `R1`–`R3` recompile the **pre-fix
source in memory** — savepoint, rollback and release all removed, so it is the
old code and not merely a weaker version of the new one — and reproduce the
abort, the `25P02` code, and the turn recording nothing. `R4` runs the identical
sequence through the real source and it survives.

`Z1` re-checks the source digest at the end. Nothing on disk is edited.

### What this proof does NOT establish

```text
NOT proven   HTTP. Every assertion calls the service function directly.
NOT proven   Twilio. No carrier was contacted; no MMS was fetched.
NOT proven   a browser.
NOT proven   production population. Fixtures are synthetic, single digits.
proven only  the service contract against a real PostgreSQL at ledger 136,
             including the pre-fix source failing the same way production does.
```

Isolated-Postgres evidence does not become a claim about Twilio or production by
being green. The handset check below is what closes that gap.

---

## Post-deploy verification

The fix is about a **redelivered** message, and a carrier redelivery cannot be
summoned on demand. So the check is in two parts: prove normal inbound still
works, then prove the retry path specifically.

```text
1  NORMAL INBOUND, NO REGRESSION
   text a field fact from the technician handset ("on my way")
   expect  the usual reply, one work_order_progress row, one event

2  THE RETRY PATH
   text "done" with no photo
   expect  a reply naming the missing photo; work order still open
   then    text "done" again — the same words, a second message
   expect  a reply again, NOT silence. The claim is not duplicated.
```

Part 2's second message is a *new* provider message, so it exercises the
completion path rather than a true carrier redelivery. The redelivery itself is
covered by `P2`/`P8` against a real database with a real duplicate key; the
handset check confirms the live lane still answers.

**Stop condition:** if either text produces silence, roll back to the SHA below.
Rollback is a revert of one function — no schema to undo.

---

## Boundary

This deployment does **not** include, and must not be read as progress on:

```text
migration 137            still PR #50, not applied
the canonical writer     still PR #50, not deployed
the proof evaluation     no evaluation is written by this change
the four-state reader    untouched
the legacy closeout      untouched
```

After this is deployed and receipted, PR #50 rebases onto `main` and Step 2
proceeds under the quiet-write + `lock_timeout` discipline recorded there.
