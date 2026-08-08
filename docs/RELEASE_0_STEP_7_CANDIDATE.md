# Release 0 — Step 7 candidate: cutover census, inventory, activation

**⛔ BUILD-AHEAD. NOTHING HERE HAS BEEN RUN AGAINST PRODUCTION.**

No census was taken. No activation exists. No inventory row was written. This is
the tooling and the canonical transaction, proven and falsified in isolation, so
that when Steps 4–6 clear the gate the cutover is a reviewed act rather than an
authored one.

**Step 7 runs ONCE and cannot be undone by re-running it.** That is the whole
reason it is built this far ahead of needing it.

---

## What Step 7 records

Two facts, once, together:

```text
1  WHEN Release 0's proof rail became authoritative
2  WHICH terminal work orders predate it and carry no evaluation
```

Fact 2 is only meaningful relative to fact 1, and fact 1 is only safe if fact 2
was taken against the population that actually existed. **So they are ONE
transaction.** A partial cutover — an instant with no inventory, or an inventory
attributed to no instant — is worse than none, because the reader would then
class real history as a defect the system caused itself.

---

## The instant is CAPTURED, never derived

§19 Ruling 1, which §6.1 calls *"the single most important line in the
release"*: the boundary is the instant captured at **step 6** — after the legacy
writer can no longer create `closed` rows and the canonical writer is verified
live.

`now()` at insertion time is **not** that instant. Between step 6 and step 7 a
`closed` row could be written by a draining instance; a boundary taken at
insertion would place that row *before* the cutover and render it
`legacy_indeterminate` — hiding a defect the release itself caused.

So `activated_at` is a required argument and the service never reads a clock.

### A second, independent guard — found by falsifying, not by design

`PostgreSQL`'s `now()` is the **transaction start time**, not statement time. The
service compares the supplied instant against it, which asks *"did this instant
precede the cutover transaction"* — stricter than "is it in the future", and
exactly the ordering the ruling wants.

That turns out to refuse a derived instant **even with the required-argument
check removed**, because a `new Date()` taken inside the transaction is always
after its start. The first version of the falsification removed only one guard,
was refused by the other, and reported a proof defect that did not exist.

Recorded as a happy accident, **not relied on**: `falsify_step7.js` must remove
both to demonstrate the failure mode.

---

## Both directions, or it proves nothing

§6.2 requires comparing the census set against the live population **both** ways,
inside the transaction:

```text
unexpected = live \ expected     appeared since the census
missing    = expected \ live     disappeared since the census
```

**A COUNT IS NEVER SUFFICIENT.** One row completed and one deleted between census
and activation produce a *matching count over an entirely different population*,
and the activation would commit a silently wrong inventory. `D4`/`D5` construct
exactly that case — matching count, different rows — and prove it still aborts.

Both lists are reported. The first difference does not stop the comparison,
because an operator deciding whether to re-census needs the whole shape of the
drift.

---

## The census is authorized, or it does not run

§6.2 step 1 requires a **specific owner authorization** for one read-only census
against production, and says plainly that *being named "census" is not
authorization*.

`tools/step7/census.js` refuses without `R0_CENSUS_AUTHORIZATION` naming who
authorized it and when, and prints that string into the receipt. A tool that
authorizes itself by existing is the thing the rule forbids.

```text
reads       the terminal-without-evaluation set, via the SAME statement the
            activation transaction runs — imported from the service, not
            restated, because two copies of "what counts as legacy" is how the
            expected set and the live set come to disagree for a reason that
            is not drift at all
proves      read-only BEFORE it reads, via the shared probe
emits       work_order_id, property_id, status, and two booleans about the
            legacy columns. NEVER a phone, a media URL, attachment bytes, or
            the contents of a note
digests     the SET only, in the query's deterministic order — not the
            timestamp, not the authorization — so an unchanged population
            gives the same digest and a changed one cannot
```

An empty set is a legitimate result, and the tool says so rather than looking
like a failed run. The activation still records the instant.

---

## Proof

```text
tools/step7/prove_step7_activation.js            37 / 37   exit 0   twice
tools/step7/falsify_step7.js --variant …          3 variants, each exit 0, twice
npm run verify (10 gates)                        PASS      exit 0
```

```bash
bash tools/steps23/baseline_136.sh
PROVE_DATABASE_URL='postgresql://postgres@127.0.0.1:5433/r0scale?sslmode=disable' \
  node tools/steps23/apply_137.js
STEP7_DATABASE_URL='postgresql://postgres@127.0.0.1:5433/r0scale?sslmode=disable' \
  node tools/step7/prove_step7_activation.js

# each variant needs its OWN fresh baseline — see below
for V in derived-instant one-direction scope-blind; do
  bash tools/steps23/baseline_136.sh
  PROVE_DATABASE_URL='...' node tools/steps23/apply_137.js
  FALSIFY7_DATABASE_URL='...' node tools/step7/falsify_step7.js --variant $V
done
```

```text
S1–S4   the set is the legacy population and only that: open work orders and
        terminal-with-evaluation rows are excluded; it carries the legacy
        column FACTS, not their contents
I1–I6   a missing, unparseable, or post-transaction instant is refused; an
        unattributed cutover is refused; a missing expected set is refused;
        every refusal wrote nothing
D1–D7   appeared, disappeared, and the compensating matching-count case all
        abort, both directions reported, nothing written
A1–A8   one transaction; the persisted instant is EXACTLY the captured one and
        differs from recorded_at; every census row is inventoried, attributed
        to this activation, scoped across two properties
O1–O7   a second genesis is refused BY THE DATABASE; a correction needs a
        reason and must cite the head; a forked correction is refused; the
        inventory PK makes a re-run a no-op
N1–N3   the cutover record is append-only — DELETE and UPDATE both refused
```

### Why the falsification is a separate tool, one variant per run

The cutover record is **append-only** and permits **one genesis, ever**. So a
falsification cannot reset state between variants — and a harness that *could*
would be proving the opposite of the invariant. Each variant runs against a
virgin baseline and refuses against a dirty one, rather than improvising a
cleanup the schema deliberately forbids.

The same discipline the Step 3 falsifier already needed, for the same reason.

### One control that could NOT be built, and is recorded as such

`scope-blind` mutates the comparison to ignore `property_id`. It **cannot**
demonstrate a caught defect, because a work order cannot change property — the
composite FK forbids it, so the drift the variant admits is unrepresentable.

Recorded as **defence in depth**, not dressed up as a caught bug. Saying so
beats a green tick implying the comparison is what prevents a cross-property
inventory.

### Two invariants learned by tripping over them

Both were discovered when the harness failed, which is the honest way to learn a
constraint is real rather than declared:

```text
A8   an inventoried work order CANNOT be deleted (on delete restrict). The
     cutover receipt cannot lose its referent.
N1   DELETE on the inventory is refused outright. A record that could be
     emptied would let a row be moved across the boundary after the fact.
```

### And one harness defect worth recording

`D3` originally built its expected set as `[...census2, census[1]]`, assuming
index 1 was a particular work order. **The census is ordered by
`(property_id, id)`, so it was not** — it was a row still live, which made the
expected set a superset of live with nothing missing, and the activation
succeeded. The test then reported a service defect that did not exist, and the
committed inventory made the cleanup fail against the FK above.

**A positional index into a sorted set is not an identity.** The assertion now
names the row, and `D3a` first proves the fixture actually removed it so `D3`
cannot pass vacuously.

### What this does NOT establish

```text
NOT proven   anything about production. No census was taken, no activation
             exists, no inventory row was written.
NOT proven   the expected set. It is taken fresh at cutover time, by
             authorization, and cannot be known now.
NOT proven   HTTP or a browser. The activation is a service transaction with
             no route, by design — it is run once, deliberately, not exposed.
proven       the transaction contract against a real PostgreSQL at schema 137,
             including the refusals the DATABASE owns rather than the service.
```

---

## The preconditions this does NOT satisfy

§5.4 lists what must be true before the instant is even captured, let alone
persisted. **None of it is done, and none of it is in scope here:**

```text
1  app step 5 is live                    (PR #37 — built, not merged)
2  the new API rollout is COMPLETE       (not "started")
3  old API instances terminated/drained
4  no in-flight legacy closeout request can still commit
5  legacy done-path returns 409          (PR #57 — built, not merged)
6  the NOT-done path still works         ← paired control
7  the canonical writer is live          (merged; deploy NOT verified)
8  WAIT at least the bounded maximum request/transaction duration
```

Step 7 is gated behind all of it, and behind Step 4 before that.

## When it runs, in order

```text
0  steps 4, 5 and 6 complete, and §5.4's eight preconditions all true
1  CAPTURE the instant at step 6 — write it down; it is an input, not a lookup
2  obtain a specific owner authorization for one read-only census
3  R0_CENSUS_AUTHORIZATION='…' node tools/step7/census.js --json > census.json
4  preserve the census output and its digest as the cutover receipt
5  run the activation with that exact set and the captured instant
6  verify: one activation, inventory count equals census count, the persisted
   activated_at equals the captured instant
```

**If more than a few minutes pass between 3 and 5, re-census.** A stale census is
the whole reason the census tool exists, and the transaction will abort on drift
rather than accept it.

## Rollback

There is none, and that is the design. The activation history is append-only and
permits one genesis; a mistake is corrected by a **superseding** row that cites
the head and carries a reason, which `O3`/`O4`/`O6` prove. The inventory cannot
be deleted or updated at all.

So the protection is not undo — it is the refusal to commit a wrong cutover in
the first place.
