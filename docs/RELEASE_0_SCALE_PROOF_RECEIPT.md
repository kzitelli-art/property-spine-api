# Release 0 — isolated scale, correctness, concurrency and operability proof

**Disposition: SCALE PROOF PASSED.**

```text
production connection opened            NO
production mutation performed           NO
migration file created under migrations/ NO
provider configuration changed          NO
```

Two complete clean runs, each from an empty cluster. 63 proof assertions and
20 falsification assertions per run, all green, both exit 0.

---

## 1. Artifact identity

```text
API head                    e794f03 (+ this commit)
candidate                   tools/scale/137_release_0_candidate.sql
candidate sha256            630ac967a27bb623b0ebc48b340fda3f0e13d9c3fcb150a306618ce7f7530354

fixture_pre_migration.sql   cb7a1cae6d42aa5c7de54485791a02488a7c0315d3b816d772264fe8588c715a
fixture_post_migration.sql  512d975026d25f32901b1f1e2e998a824b57cef2be7e043a2d1dc6ac609b2258
setup_baseline.sh           4f242898e70a10dea385f6a2adb1ad5c0f67e60dbbe1c46b4e45a12ed14d7823
run_scale_proof.js          0833e7f43b2117781f0f2a56d8c98f68e7eeef8c40185f0895c5e10bf53c7569
falsify.js                  51db997deb3ed81cee99648db6a9e38596c824b5031e948db1989e4ef5e989df
seed_a_vendors.sql          0f1c814d85a98dc31da9096fc3ce18d16777187b639eb3c27cf308a5c2017916
seed_b_qa_identity.sql      cbce2073174513cbdc7d3dd426f44384cb5b2e12c9564758ad7ea8ec14bd94a3
seed_c_governed_charges.sql 78e3f536f3c7dc69ea4ad7ef58c5af651230667cd9446d1e0b70bb8686385a99

PostgreSQL                  16.13 (Ubuntu 16.13-0ubuntu0.24.04.1)
database                    r0scale @ 127.0.0.1:5433, created and destroyed per run
ledger before / after       136 / 136   (the candidate records NO ledger row —
                                         it is not a migration)
```

### 1.1 Promotion rule

Production migration 137 must be created **from these exact candidate bytes**.
Comments and the filename wrapper may differ. **DDL, functions, indexes,
constraints, triggers, views and transaction boundaries may not.** Any
substantive difference invalidates this proof and requires re-running it.

Falsification case 8 demonstrates that a single added comment changes the
digest — which is why promotion is a reviewed, re-digested step and never a
silent edit after measurement.

## 2. Isolation

The candidate refuses **before any DDL** unless all five hold:

```text
current_database() = 'r0scale'
the sentinel table release_0_scale_harness_guard exists
its purpose is EXACTLY 'ISOLATED RELEASE 0 SCALE HARNESS — NEVER PRODUCTION'
the ledger ceiling is exactly 136
migration 137 is absent from the ledger AND its tables do not exist
```

**Keyed to identity, not location.** A path can be copied and a port can be
forwarded; neither is checked. Every connection the harness opens — including
the lock observer, the four control probes and both race connections —
re-verifies the sentinel before running anything.

## 3. Fixture — deterministic, 100,000 work orders

Every id is `md5(seed_text)::uuid` and every bucket is `i % 100`. Nothing uses
`random()`. Two clean runs produced identical ids and identical cardinalities.

```text
work orders                     100,000     across 5 properties
  open                           15,000     non-terminal
  scheduled                      10,000     non-terminal
  in_progress                    10,000     non-terminal
  needs_followup                  5,000     non-terminal
  complete                       45,000     terminal
  closed                         15,000     terminal

proof attachments               42,855     4 storage states, 5 classifications
  stored + repair_photo|condition 25,713    what the reader counts as preserved

evaluations                     29,630     every one inserted through the guard
evaluation heads                28,000
evaluation→attachment links      7,143
legacy cutover inventory        25,000
chain depths                     1 · 2 · 10 · 100 · 1000
```

**No real names, phone numbers, resident data or production records.** Persons
are omitted entirely rather than invented. The hardcoded ids migrations 087 and
110 require remain labelled synthetic scaffolding in `tools/scale/seed_*.sql`.

### 3.1 Four-state distribution — all four populated, plus the not-due lane

```text
satisfied                       20,000
not_satisfied                    8,000
legacy_indeterminate            25,000     terminal, no evaluation, INVENTORIED
missing_evaluation_defect        7,000     terminal, no evaluation, NOT inventoried
  ├─ complete                    4,000
  └─ closed                      3,000     ← the correction-7 hole
not_due                         40,000     non-terminal; never a defect
```

## 4. Migration and index measurements

```text
total candidate duration        47-58 ms      one transaction
index build (empty tables)      uq_wope_genesis        2.15 ms
                                uq_wope_one_successor  1.26 ms
                                idx_wope_scope         0.95 ms
db size before → after          71 MB → 74 MB
work_orders size                37 MB
attachments at the ALTER        42,855
```

The new tables are empty at creation, so their index builds are trivial. **The
cost is not there.**

### 4.1 ⚠ THE ONE BLOCKING STEP, AND IT WAS MEASURED RATHER THAN ASSUMED

The candidate creates new tables — which takes no lock on anything in use — but
it **ALTERs `work_order_proof_attachments`** to add `uq_wopa_id_scope`, and that
takes a lock on a live table and builds a unique index over every row in it.

Observed in `pg_locks` from an independent connection during the migration:

```text
work_order_proof_attachments  ShareLock          ← blocks WRITES, allows reads
work_orders                   AccessShareLock    ← readers only, no contention
<new tables>                  AccessExclusiveLock ← not yet visible to anyone
```

Confirmed by the control workload, which probed the locked table directly:

| Probe | run 1 | run 2 | Max latency |
|---|---|---|---|
| ordinary reads | 113 | 100 | 4.2 / 7.1 ms |
| `work_orders` inserts | 84 | 43 | 17.0 / 15.6 ms |
| **`work_order_proof_attachments` writes** | **4** | **2** | **54.7 / 60.2 ms** |

**Reads never blocked. Attachment writes did** — two to four completed while a
hundred reads went through, and the slowest took approximately the whole
migration duration. Nothing failed; writers waited.

**This is a real operational property and it scales with attachment count**, not
with work-order count.

### 4.2 A correction to the first cut of this measurement

The first control workload ran four probes sequentially on one connection with
a 2 ms sleep. Against a ~47 ms migration that produced **one iteration of each**,
and `M2 the control workload never failed` rested on a single sample. It also
never touched `work_order_proof_attachments` — the one table the migration
actually locks.

**It would have passed.** It is recorded because a green check drawn from one
sample of the wrong table is exactly the kind of evidence this proof exists not
to produce. Each probe now runs flat out on its own connection, and `M2b`
fails the run if fewer than five iterations complete.

## 5. Correctness invariants — 17 assertions, all green

```text
I1   every evaluation shares its work order's property           0 violations
I2   every link is in its evaluation's scope                     0 violations
I3   at most one genesis per scope                               0 violations
I4   at most one successor per predecessor                       0 violations
I5   exactly one head per non-empty chain                        0 violations
I6   activation history has exactly one head                     0 violations
I17  one head and one genesis after EVERY one of 5 appends       re-checked
     after each accepted append, not only at the end
```

Every refusal was checked **for its named reason**, not merely for failing:

```text
I7   self-supersession        evaluation <uuid> may not supersede itself
I8   second genesis           genesis refused: evaluations already exist for (…)
I9   missing predecessor      predecessor <uuid> does not exist
I10  successor to a non-head  predecessor <uuid> is not the head
I11  cross-scope predecessor  cross-scope supersession refused
I12  UPDATE                   work_order_proof_evaluations is append-only
I13  DELETE                   work_order_proof_evaluations is append-only
I14  inventory DELETE         release_0_legacy_cutover_inventory is append-only
I15  second activation        genesis refused: activation history is not empty
I16  blank correction reason  a superseding activation requires a non-empty reason
```

## 6. Concurrency — overlap proven, not assumed

Independent connections, both inside open transactions, with overlap
established by observing the second session **actually waiting on a lock** in
`pg_stat_activity`. Every race below recorded `wait_event = transactionid`.

```text
genesis vs genesis              exactly one won   overlap PROVEN   1 row survives
successor vs successor          exactly one won   overlap PROVEN   1 successor,
                                                                   1 visible head
activation genesis race         exactly one won   overlap PROVEN   1 row survives
activation correction race      exactly one won   overlap PROVEN   1 current head
inventory duplicate race        exactly one won   overlap PROVEN   1 row survives
append vs reader                head during uncommitted append = 0
                                head after commit               = 1
```

Falsification case 6 runs the same shape **without** real overlap: two promises,
no open transactions. It still reports "exactly one winner" and observes **zero**
lock waits. That is why the overlap assertion is separate from the outcome
assertion — the outcome alone cannot distinguish a race that was won from a race
that never happened.

## 7. Reader, sweep and activation

```text
four-state reader           131-156 ms   Aggregate, 4,294 shared hits, 0 reads
defect sweep                 63-72 ms    Hash Join
defect sweep, second run     51-64 ms    IDENTICAL SET
list page (50 rows)          15-20 ms    Limit
detail (single work order)     0.05 ms   Nested Loop
inventory lookup               0.25 ms   Index Scan
activation transaction         2.2 ms
```

**Exact-set reconciliation, both directions, not counts:**

```text
sweep set        7,000 ids
reader set       7,000 ids
only in sweep        0
only in reader       0
```

The reader and the sweep share **one** predicate expression, so they cannot
drift apart by construction. Running the sweep twice returned the identical set.

## 8. Chain depth

```text
deepest chain                1,000 rows
append at depth 1,000         5.8 ms     the guard walks the entire chain
head read at depth 1,000      1.4 ms
```

The backward walk is O(depth) per supersession. At depth 1,000 it costs under
6 ms; at the depth real chains will have — one or two — it is not measurable.

### 8.1 The corrupt-chain control, and which guard actually caught it

A two-cycle was built by **disabling both the chain guard and the append-only
trigger**, in an explicitly separated block that rolls back. It is impossible
through normal DML, which is the point.

Extending it was refused. **The refusal came from the head check —
`predecessor <uuid> is not the head` — not from the cycle walk**, because in a
two-cycle every row already has a successor, so the head check fires first.

Stated plainly because the alternative would be to imply the cycle detector was
what caught it. It was not. The cycle walk remains justified as the check that
would notice a corrupt chain the head check happens to admit, and its hop bound
is the belt-and-braces case.

## 9. Falsification — 20 assertions, all green

Each case breaks one thing, proves the corresponding check goes red **for the
intended reason**, restores it, and proves it goes green again.

```text
1  defect predicate loses its closed branch  7,000 → 4,000. Exactly the 3,000
                                             closed non-inventoried rows vanish.
2  reader defaults missing → not_due          defects reported: ZERO.
                                             32,000 terminal unevaluated rows
                                             buried in not_due.
3  uq_wope_one_successor dropped              the TRIGGER still refuses a
                                             SEQUENTIAL fork — proving the index
                                             is the CONCURRENCY backstop, not
                                             the sequential rule
4  self-supersession guard removed            the named refusal disappears
5  cross-scope check removed                  the composite FK still refuses,
                                             but unnamed — diagnosis is lost
6  fake concurrency (no overlap)              still reports "one winner",
                                             observes ZERO lock waits
7  expected fixture count changed             the cardinality assertion goes red
8  candidate digest changed                   one added comment changes the sha
```

### 9.1 A false pass found while building the falsifier

The first `refuses()` helper issued `SAVEPOINT` unconditionally. Outside a
transaction that fails with *"SAVEPOINT can only be used in transaction blocks"*,
and the helper returned **that** as the refusal message — so a check asserting
"this was refused" went green without the statement ever running. Case 5 passed
on it.

Same error class as the placeholder-password false pass earlier in this release:
**a convincing refusal that proves nothing.** Fixed to open its own transaction
and always return the message the statement itself produced.

## 10. Repeatability — two clean runs

Each run destroys the cluster, replays the ledger, re-seeds, regenerates the
fixture, applies the candidate and runs both suites.

```text
IDENTICAL   candidate sha256
IDENTICAL   census totals and status distribution
IDENTICAL   fixture cardinalities
IDENTICAL   chain depth distribution
IDENTICAL   four-state distribution
IDENTICAL   exact-set reconciliation (0 / 0 both directions)
IDENTICAL   invariant counts
IDENTICAL   refusal reasons          (with per-run UUIDs normalized — see below)
IDENTICAL   concurrency winners and overlap-proven flags
IDENTICAL   corrupt-chain refusal
IDENTICAL   63 passed / 0 failed · 20 passed / 0 failed
```

**Raw refusal strings differ between runs and that is correct.** The trigger
interpolates the row's id into its message, and those ids are
`crypto.randomUUID()` minted per run. Normalizing uuids, every reason is
byte-identical. The comparison was refined rather than the difference excused —
comparing values that are random by design would have been a meaningless check
in either direction.

Timing varied as expected: candidate 47–58 ms, reader 114–156 ms, sweep 62–72 ms.

## 11. Operational interpretation

Thresholds are **not** invented after seeing the numbers. Each measurement is
classified against the database it will actually run on.

| Measurement | Value | Classification |
|---|---|---|
| candidate total | 47–58 ms @ 100k | **acceptable for the current six-row production database** |
| attachment-table write block | 55–60 ms @ 42,855 attachments | **acceptable with operational caution** — see below |
| four-state reader | 131–156 ms @ 100k full scan | **acceptable with operational caution** — it is an aggregate over the whole table; the per-work-order read is 0.05 ms |
| defect sweep | 63–72 ms @ 100k | **acceptable for the current production database** |
| list page (50) | 15–20 ms | **acceptable** |
| detail read | 0.05 ms | **acceptable** |
| inventory lookup | 0.25 ms | **acceptable** |
| activation transaction | 2.2 ms | **acceptable** — but see §11.1 |
| append at chain depth 1,000 | 5.8 ms | **acceptable** |

**Operational caution on the attachment ALTER:** production currently holds far
fewer than 42,855 attachments, so the real block will be shorter than measured.
It is flagged anyway because the block is on *writes to the attachment table*,
which is the table the SMS evidence-ingress rail writes to. **Do not run
migration 137 while a technician is mid-upload.** The mitigation is a quiet
window, not a code change.

### 11.1 What this proof did NOT measure

```text
the real activation transaction   Timed here as a read-back of an
                                  already-populated inventory, NOT as the
                                  one-shot insert-25,000-rows-and-compare
                                  transaction §6 describes. The 2.2 ms figure
                                  is NOT an activation-cost estimate.
migration 137 against a table with production's index and bloat profile
the canonical writer service — not built, and out of scope
```

### 11.2 Engineering inference at larger cardinalities — NOT a benchmark claim

Labelled as inference. Nothing below was measured.

```text
AT 100,000 work orders   (measured)
  reader full-scan aggregate is ~150 ms; per-row reads unaffected
  defect sweep ~70 ms
  the attachment ALTER is the only blocking step

AT 1,000,000 work orders   (inferred)
  the four-state aggregate is a sequential scan and should grow roughly
  linearly → ~1.5 s. It is a reporting-shaped query, not an operator-path
  query, so this is probably tolerable — but it becomes the first thing
  worth an index or a materialized projection.
  the defect sweep likewise → ~0.7 s.
  per-work-order detail reads stay flat; they are index lookups.
  the ALTER scales with ATTACHMENTS, not work orders.

AT 10,000,000 work orders   (inferred, lower confidence)
  a full-scan aggregate at ~15 s stops being acceptable on any interactive
  path and the defect sweep at ~7 s wants to become an incremental job.
  uq_wope_genesis and idx_wope_scope stay effective — they are selective
  lookups, not scans.
  the ALTER remains attachment-bound. If attachments reach the tens of
  millions, adding uq_wopa_id_scope becomes a genuine outage-class
  operation and would need CREATE UNIQUE INDEX CONCURRENTLY plus a
  separate ADD CONSTRAINT ... USING INDEX, which is NOT what this
  candidate does.
```

**That last point is the one to carry forward.** The candidate's `ALTER TABLE
… ADD CONSTRAINT … UNIQUE` is correct and fast at today's volume and would be
the wrong shape at very large attachment counts. It is recorded here rather
than pre-emptively changed, because changing the candidate now would invalidate
this proof for a volume production is nowhere near.

## 12. Stop conditions — none hit

```text
candidate could not be made identical to the plan          NO
harness required changing a production migration           NO
candidate discoverable by migrate.js                       NO — outside migrations/
isolation guard passable outside the harness database      NO — five identity checks
migration lost or rewrote fixture rows                     NO — census reconciled
reader and sweep populations disagreed                     NO — 0/0 both directions
a concurrency test produced two accepted rows              NO — one winner every time
a corrupt chain could be extended                          NO — refused
candidate changed after its digest                         NO
a test passed without proving overlap                      NO — asserted separately
second clean run differed on correctness                   NO
```

## 13. Classification (§18)

| Component | Class | Removal condition |
|---|---|---|
| This receipt | 1 — permanent | Never. It is the evidence migration 137 was promoted against. |
| `137_release_0_candidate.sql` | 3 — temporary | Removed when production migration 137 is created from its exact bytes and this receipt records the promotion. |
| `run_scale_proof.js`, `falsify.js`, fixtures, `setup_baseline.sh`, `run_all.sh` | 3 — temporary harness | Removed when Release 0 completes and the schema is no longer changing. Kept until then: re-proving a changed candidate requires them. |
| `seed_a/b/c` | 3 — temporary scaffold | Removed when the ledger replays from empty unaided. Deleting them re-hides three blockers. |

---

**SCALE PROOF PASSED.**

Stopping at the production gate. Step 2 is **not** started. The next owner
decision is SMS transport activation; only after real-handset ingress passes may
the proven candidate be promoted and production Step 2 begin.
