# Release 0 — §4.2 defect sweep candidate

**⛔ BUILD-AHEAD. Never run against production. No production obligation exists.**

This is the **first writer** in this stretch. Steps 5–8 are candidates that touch
nothing. This one raises obligations against work orders — and an obligation is
an accountability fact about a human.

**Its failure modes are not symmetric.** A missed defect is a gap. A *wrong*
defect tells a named role they failed at something they did not fail at. So the
load-bearing assertions here are the **refusals**, not the writes.

---

## What it does

Finds terminal work orders with no proof evaluation and **no cutover inventory
row** — rows that postdate the cutover, so they are not legacy history — and
raises one obligation each, through the canonical service.

```text
module           maintenance
type             proof_evaluation_missing
assigned_role    property_manager      escalates_to  asset_manager
assigned_user_id NULL — UNASSIGNED
required_inputs  ['proof_evaluation']
related_type     work_order
```

**`UNASSIGNED` is the answer, not a gap.** §4.2 freezes the *role*; it names no
person, and neither does this. Resolving a human here would invent an ownership
ruling nobody made.

---

## It does not own the predicate. The reader does.

§3.2.0 requires the sweep and the reader to agree, *"so neither can consider a
row a defect that the other treats as not-yet-due."*

Sharing a SQL string between them would be a copy that can drift. So the sweep's
query is only a **prefilter** — a cheap way to avoid deriving state for every
work order — and **every candidate is then confirmed through
`deriveProofState`**, the same function the reader calls, re-derived inside its
own transaction.

**The prefilter can be wrong without being unsafe.** It can only ever cost work,
never correctness. `A1` proves the result row-by-row: a work order has an
obligation *if and only if* the reader calls it a defect.

---

## Three refusals before it will write anything

```text
no migration 138       → IDEMPOTENCY_INDEX_MISSING, refuses to start
no cutover activation  → ACTIVATION_ABSENT, refuses to start
dryRun defaults TRUE   → writes only when explicitly told to
```

**The activation refusal is the important one.** Without an inventory there is
nothing separating legacy history from a real defect, and a sweep run then would
raise an obligation against *every* terminal work order in the property. That is
the same failure the reader avoids by reporting `unavailable` — except a sweep
would write it down.

**`dryRun` defaults to true** because a sweep that writes unless told otherwise
is one mis-invocation away from production.

---

## Idempotent by construction, not by checking

Migration 138 adds a partial unique index making a duplicate outstanding
obligation **unrepresentable**:

```sql
create unique index uq_obl_proof_eval_missing_open
  on obligations (property_id, related_id)
  where related_type = 'work_order'
    and type = 'proof_evaluation_missing'
    and status <> 'complete';
```

`status <> 'complete'` rather than `= 'open'`: an obligation in flight —
accepted, in progress — is still outstanding and must not be duplicated. A
**completed** one is deliberately outside the index, because a defect that
resolves and later recurs is a new fact deserving a new obligation.

### The conflict arrives as a raised error, and that needed a savepoint

The obligation engine has no `on conflict` clause and is not going to grow one
for this caller. So the insert runs inside a `SAVEPOINT`.

**This is the same defect found in `appendProgress` this morning**: PostgreSQL
aborts the whole transaction on a failed statement, so without a savepoint the
duplicate-recovery read would be issued on a dead transaction and the handler
written to absorb the conflict would itself be what throws. `I5`/`I6` prove the
service can be called twice in one transaction and the transaction survives.

The savepoint also rolls back the **event** written alongside the obligation, so
a re-run leaves no trail of near-misses (`I4`).

---

## Proof

```text
tools/step9/prove_defect_sweep.js       35 / 35   exit 0   twice, clean baselines
tools/step9/falsify_defect_sweep.js     2 variants, each exit 0, twice
npm run verify (10 gates)               PASS      exit 0
```

```bash
bash tools/steps23/baseline_136.sh
PROVE_DATABASE_URL='postgresql://postgres@127.0.0.1:5433/r0scale?sslmode=disable' \
  node tools/steps23/apply_137.js
STEP9_DATABASE_URL='...' node tools/step9/prove_defect_sweep.js

for V in raise-legacy no-index; do
  bash tools/steps23/baseline_136.sh
  PROVE_DATABASE_URL='...' node tools/steps23/apply_137.js
  FALSIFY9_DATABASE_URL='...' node tools/step9/falsify_defect_sweep.js --variant $V
done
```

```text
G1–G4   refuses with no index; refuses with no activation; raised nothing
L1–L3   legacy_indeterminate raises NOTHING
D1–D9   a real defect raises exactly one: property-scoped, role-routed,
        UNASSIGNED, linked, and born from an event that says WHY
I1–I6   a second sweep raises nothing; two CONCURRENT sweeps produce exactly
        one; no orphan event from the loser; the service is safe called
        twice in one transaction and the transaction survives
S1–S5   property-scoped sweeps stay in their property; open and evaluated
        work orders never raise one; an unscoped sweep reaches both
P1–P4   the reader still writes nothing; the sweep contains no UPDATE or
        DELETE of any kind — it CREATES ONLY
A1      every work order has an obligation IFF the reader calls it a defect
X1–X3   the per-row confirmation, and an honest note about it (below)
```

### One control recorded rather than claimed

Every run reported `skipped_not_defect = 0`. **That is not the confirmation
failing — it is the prefilter already excluding legacy rows**, so the
confirmation had nothing to reject.

The branch exists for what the prefilter cannot cover: a work order whose state
changes *between* the prefilter's snapshot and its own per-row transaction.
Forcing that race deterministically would mean instrumenting the sweep with a
test-only hook, which is a worse trade than saying this out loud.

So `X1`–`X3` assert the branch at the unit level and its unreachability in a
static population is **recorded**, not dressed up as a passing control. Same
treatment as Step 7's `scope-blind` variant.

### A flaky control was replaced, not re-run

The `no-index` falsification first ran two sweeps through `Promise.all` and
asserted a duplicate appeared. **It is a race, so it did not land**, and the
assertion went red for a reason unrelated to the design under test.

**A control that only fails sometimes is worse than no control** — it teaches
people to re-run until it passes. It is now a deterministic interleave: both
transactions check, both see nothing, both insert. That cannot flake in either
direction, and it shows the point more clearly: **neither transaction did
anything wrong.** That is why the guarantee has to be the database's.

### What this does NOT establish

```text
NOT proven   production. Nothing was run against it; no obligation exists.
NOT proven   the scheduled rail. §4.2 puts this on the followups cadence
             (run_followups.js). WIRING IT IN IS NOT DONE — the sweep is a
             function nothing calls yet.
BUILT LATER   caller (a) and the closure path — see "The rest of the
             lifecycle" at the end of this document. They were not built when
             this section was written; this line is kept rather than rewritten
             so the order of work stays legible.
still true   the SWEEP never closes anything. Closure is the canonical
             services' job, never the sweep's.
NOT proven   HTTP or a browser.
proven       the service and sweep contract against real PostgreSQL at
             schema 137 + 138, including real concurrency.
```

---

## Migration 138 — number allocated

`138` was recorded as free in `PARALLEL_BUILD_SILOS.md` and reserved for
whichever silo needed it first. **Release 0 has taken it.** The text-line silo
should take 139.

The index is additive and constrains a `(type, related_type)` combination
nothing writes yet, so applying it changes no current behaviour.

## Sequencing

```text
Step 7   activation + inventory exist          ← the sweep REFUSES without this
Step 8   the four-state reader                 ← the sweep uses its predicate
§4.2     the sweep                             ← this
then     wire it to the followups rail · caller (a) · the closure path
```

It must not run before Step 7, and the refusal enforces that rather than the
runbook.

## Rollback

The sweep is a function nothing calls, so "rolling back" is not deploying it.

If it had run, the obligations it raised are ordinary obligations and close
through the governed path — but **the sweep cannot close them itself**, by
design (`P3`). A sweep able to close what it raised could erase the very
accountability it exists to create.

---

# The rest of the lifecycle (added after the sweep)

The sweep covered creation. This covers closure, caller (a), and the
migration §4.2 turned out to need.

## ⚠ §4.2 SPECIFIES A RESOLUTION CODE THE SCHEMA FORBIDS

§4.2 closes the obligation two ways: `'satisfied'`, and
`'no_longer_applicable'` when the work order leaves the terminal state.

**`no_longer_applicable` is not in the frozen vocabulary.** Migration 084 froze
`resolution_code` to five values — `satisfied · superseded · revoked ·
dispatch_refused · expired` — and `ck_oblig_resolution_code` refuses anything
else. The frozen plan and the live schema disagree.

Reusing an existing code was considered and rejected, because none is true:

```text
satisfied         the defect was NOT resolved by proof arriving
superseded        nothing replaced this obligation
revoked           implies a human withdrew it; nobody did
dispatch_refused  unrelated — a transport outcome
expired           implies time passed; the CONDITION changed
```

Picking the nearest wrong word is how a resolution vocabulary stops meaning
anything — and this one is read by reporting. So **migration 139 widens the
vocabulary by exactly one value**, additively, and says so loudly in its own
header. `R2` proves the vocabulary is still closed afterwards: an invented code
is still refused.

**This is the one place today where implementing the frozen plan required
changing a schema the plan calls frozen.** A reviewer who disagrees can reject
`139` alone; the rest of the release still stands, with the
`no_longer_applicable` closure simply unavailable.

## Closure derives its own resolution — the caller's word is not evidence

`resolveProofEvaluationDefect` **takes no resolution code.** It reads the two
facts §4.2 names and refuses when neither holds.

A service that accepted a code from its caller would make *"closes only on
genuine resolution"* a comment rather than a rule: any caller could say
`satisfied` and the obligation would close over a defect still sitting there.
`M1` asserts the absence of that argument.

When it refuses, nothing happens — and the sweep re-creates the obligation on
its next run anyway. That is the designed behaviour, and it is why the sweep
only ever creates.

## Caller (a): the writer reports, and still refuses

`claimCompletion` on an already-complete work order now checks whether that row
is a `missing_evaluation_defect` — through the reader's predicate, never a copy —
and raises the obligation **while still refusing the field fact**.

**Reported, not repaired.** A refusal that quietly fixed things would be a second
completion path by another name. It is also deliberately best-effort: a
defect-detection failure must never turn a technician's ordinary refusal into a
thrown turn, and the sweep converges on the same population anyway.

## Proof

```text
tools/step9/prove_defect_lifecycle.js   25 / 25   exit 0   twice, clean baselines
tools/step9/prove_defect_sweep.js       35 / 35   exit 0   (unchanged, re-run)
tools/step8/prove_step8_reader.js       41 / 41   exit 0   (regression)
tools/steps23/prove.js                  98 / 98   exit 0   (regression)
npm run verify (10 gates)               PASS      exit 0
```

```text
R1–R2   139 permits the new code, and the vocabulary stays closed
C1–C8   refuses while the defect persists; closes 'satisfied' on an
        evaluation; closes 'no_longer_applicable' when no longer terminal;
        a second close is a no-op; every closure writes an event saying WHY
M1–M3   no resolution_code argument; the resolution is derived; the required
        input is proof_evaluation and cannot be typed away
A1–A6   the writer notices, raises, reports on the refusal, attributes it to
        claimCompletion, and does not raise twice
E1–E6   raise → real completion → the obligation CLOSES IN THE SAME
        TRANSACTION that resolved it, and an ordinary completion with no
        defect reports `nothing_open` rather than an error
```

### Still NOT built

```text
NOT built    the scheduled rail wiring. §4.2 puts the sweep on the followups
             cadence; it is still a function nothing calls.
NOT built    any un-terminal path. 'no_longer_applicable' is provable and has
             NO production caller — nothing in the codebase moves a work order
             out of a terminal status today, and lifecycle_service says
             reopening is "a different, governed act that this slice does not
             build". Recorded so the closure is not mistaken for a live path.
NOT proven   HTTP, browser, production.
```

## Migration numbers

`138` and now `139` are **both allocated to Release 0**. The text-line silo
should take `140`.
