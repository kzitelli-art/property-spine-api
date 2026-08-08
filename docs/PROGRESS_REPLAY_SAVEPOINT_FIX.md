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
being green.

---

## Status — DEPLOYED AND PROVEN, SMS VERIFICATION OWED

**Deployed** `524cf90`, 2026-08-08. **Not** verified over live SMS, so by §33
this sits at PROVEN and must not be described as done.

The debt is carried at the top of `THREAD_HANDOFF.md` so it closes deliberately
rather than expiring by age.

### The check owed, when the text line is confirmed alive

From the technician handset — a `users` row, role maintenance, active
`property_team_assignments` at the property owning WO 1006; the same phone used
for Gate 8:

```text
text        a plain field fact — "on my way"
expect      the normal reply, ONE new work_order_progress row, ONE new event
proves      the savepoint and release statements run on EVERY progress write,
            happy path included. If they broke the transaction assumptions,
            this is what breaks — over real HTTP, real Twilio, real Neon.
stop        silence → revert 524cf90. One function, no schema to undo.
```

### ⚠ Three verifications that look reasonable and are not

The first draft of this section specified all three. Recorded because the
reasoning is the useful part.

**A reply arriving at the handset is not a valid success signal.**
`RELEASE_0_EVIDENCE_INGRESS_RECEIPT.md`, written the same day, records `handset
delivery NOT CLAIMED — no delivery receipt`. A check whose pass condition is a
received text is built on the one thing that receipt says cannot be confirmed.
The ONE new progress row is the signal; the reply is a bonus.

**Two "done" texts cannot exercise this fix at all.** They are two provider
messages with two different `MessageSid`s, therefore two different idempotency
keys, therefore no `23505` and no savepoint branch. A true carrier redelivery
happens only when the webhook times out or 5xx's — it **cannot be summoned**, and
must not be induced in production. That path is covered by `P2`/`P8` against a
real database with a real duplicate key, and that is where it stays.

**A "done" text would close work order 1006.** Gate 8 stored a durable photo on
it, and `main`'s `preservedEvidenceFor` accepts any `storage_state='stored'`
attachment. So "done" there satisfies the completion gate and closes the work
order through the LEGACY writer with no proof evaluation, since 137 has not run.
That would consume the proof fixture and write a completion outside the release
boundary.

### ⚠ Possibly unrelated and more urgent: is the text line up?

Real-handset ingress **passed** on 2026-08-08. The Twilio auth token was then
rotated, having been exposed in a screenshot. If Render's `TWILIO_AUTH_TOKEN`
never received the new value, inbound signature validation fails and the text
line is down — nothing to do with this fix. **Not measured.** Check it first.

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
