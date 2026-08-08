# Release 0 — Steps 2 & 3 implementation candidate

**Branch** `claude/steps-2-3-candidate` · **Base** `b71834973a61ad89b22c642a287869aa05738556`

Built ahead of need so that when evidence ingress closes, the question is
whether to deploy a proven package — not what still needs building.

**Not merged. Not deployed. No production connection was opened.**

---

## Step 2 — migration 137

`migrations/137_release_0_completion_proof.sql` was **derived, not authored.**
Its DDL body is the exact bytes of the artifact the 100k-row scale proof
measured:

```text
tools/scale/137_release_0_payload.sql
sha256 ae4b9b774cd9be8568ea24219d4ee4a98350b2bce3a03baf8de33d0cfcc2ea4d
```

Produced by removing that file's own `begin;`/`commit;` and replacing its
header comment. Nothing else. Retyping it would have made the scale proof a
statement about a different file.

`tests/gate_migration_137_promotion.js` compares the two **statement by
statement** on every run — 85 comparison units, byte-identical — and refuses if
normalisation ever eats enough content to make two files trivially equal.

### Why the transaction wrapper had to come out

`migrations/migrate.js` issues `begin`, runs the file, **inserts the
`schema_migrations` row**, and only then commits. A `commit;` inside the
migration would land the DDL *before* the ledger row, so a crash between them
would leave schema 137 applied with nothing recording it — exactly the
split-brain the ledger exists to prevent. `W1`/`W2` in the gate enforce this.

---

## Step 3 — `claimCompletion`

Already existed and already had four of the eight required facts. This closes
the gap rather than rewriting it.

```text
1  completion claim                    was present
2  proof evaluation                    ADDED  (needs 137)
3  evaluation → attachment links       ADDED  (needs 137)
4  status = 'complete'                 was present
5  kind='completed' progress event     was present
6  obligation closure                  was present — now PROPERTY-SCOPED
7  action/operating receipt            built by the caller, inside the same tx
8  actor attribution                   assertActorMayOperate, read in-transaction
```

All eight land in one transaction. `tenantlink.js` wraps the operations turn in
`begin`/`commit`/`rollback`, so any failure rolls every fact back together.

**The evaluation is written FIRST**, before the status change. A failure there —
a lost supersession race, a corrupt chain, migration 137 absent — rolls the
whole transaction back with the work order still open. A completion that exists
without the evaluation justifying it is the precise state Release 0 forbids, so
everything else is contingent on it.

### Evidence eligibility (Part C)

`completionEligibleEvidenceFor` asks a different question from
`preservedEvidenceFor`, and they are deliberately two functions rather than one
with a flag: a caller wanting the lenient answer and getting the strict one is a
bug that reads as a refusal; the reverse silently completes work on evidence
that does not exist.

```text
storage_state = 'stored'        referenced / fetch_failed are a photo we cannot produce
content    is not null          the bytes are here
byte_size  is not null          and we know how many
sha256     is not null          and can prove they did not change
stored_at  is not null          and when we took custody
mime_type  in the three         verified against what the carrier SERVED
classification in the CORRECTED array — 'unclassified' removed (§3.1, zero rows)
scoped on (work_order_id, property_id) together
```

The legacy `completion_photo` / `completion_note` columns are never consulted.
That column holds a `stub://` string with no bytes, so it can support a claim
about presence and never one about proof.

### The evaluation chain

`src/maintenance/proof_evaluation_service.js` is the one writer. It reads the
head and cites it; it does **not** re-implement the chain rules and gets no
exemption for being canonical. If two turns race, one loses to
`uq_wope_one_successor` and is told so.

Only `satisfied` and `not_satisfied` are ever stored. `legacy_indeterminate`,
`missing_evaluation_defect` and `unavailable` are derived at read time, and the
service refuses them by name — as does the database.

**Fail closed on a missing schema.** If Step 3 ever deployed ahead of Step 2,
`recordEvaluation` refuses with `SCHEMA_MISSING` rather than completing work
without an evaluation.

---

## Part G — completion actor eligibility

**The contract forbids inventing one.** §1.1.2: *"distinguishing who may report
completion, who may provide evidence, who may accept the work… That is a later
product ruling. Do not invent that surface inside Release 0."*

So the frozen rule is the existing one, unchanged, and it is two layers that
**nest rather than conflict**:

```text
service layer   assertActorMayOperate — an active team assignment at the work
                order's property, organization-scoped, read inside the
                transaction, never accepted as an argument
SMS lane        offerableWork additionally requires assigned_user_id === actor
                before the work is even selectable
```

Acceptance is **not** required for completion by either layer. No contradiction
between source and contract, so no owner ruling was needed.

---

## Proof

```text
tools/steps23/prove.js       92 / 92   exit 0   twice, from clean baselines, identical
tools/steps23/falsify.js     22 / 22   exit 0   twice, identical
npm run verify (9 gates)     PASS      exit 0
server boot                  OK
```

Concurrency is real: two separate connections, both inside open transactions at
the same time. Two concurrent completions → exactly one closes. Same provider
key delivered twice → one completed event. Completion racing evidence ingestion
→ one completion. Two concurrent supersessions of one head → one wins, no fork.
Two concurrent genesis inserts → one wins.

Falsification covers: unclassified evidence · referenced evidence · removed
actor requirement · dropped evaluation write · bypassed chain service ·
duplicate completed event · cross-property attachment · derived state in the
enum · altered migration bytes · a third completion writer. Each turns its proof
red, sources are compiled in memory and never edited, every mutation asserts its
target was found, and all three source digests are re-checked at the end.

---

## Findings

**1. Migration 137 blocks on concurrent writes to `work_orders`.** It creates
FKs referencing that table, which takes `SHARE ROW EXCLUSIVE`; an ordinary
`INSERT` holds `ROW EXCLUSIVE`. They conflict. Measured, not assumed — the
first version of this check asserted "a concurrent writer still works" and would
have shipped a comfortable claim that is false.

```text
concurrent READER held open across the migration   unaffected
concurrent WRITER held open                        BLOCKS the migration
no competing writer                                24–30 ms
```

**Deployment consequence:** apply 137 against quiet write traffic, **with a
`lock_timeout`**, so it fails fast instead of queueing behind a long transaction
and blocking every writer behind it.

**2. A cross-property attachment is unrepresentable, not merely filtered.**
`fk_wopa_work_scope` is a composite FK into `work_orders(id, property_id)`. The
falsification for this could not be built — the fixture could not be created.
The property scope in the evidence query is defence in depth over a state the
schema already forbids, and saying so is more useful than a control pretending
the query is what prevents it.

**3. Append-only means the harness cannot clean up after itself.**
`no_delete_wope` refuses deletion of evaluations, so `falsify.js` cannot remove
its own fixtures and instead **refuses to run** against a dirty database, naming
the rebuild commands. A harness able to delete them would be proving the
opposite of the invariant.

**4. The obligation closure was not property-scoped.** It matched on
`(related_type, related_id)` alone, trusting work-order ids to be globally
unique — true today, and not a property any of this should depend on. Now
scoped like every other write in the transaction.

**5. The classification array was duplicated.** `lifecycle_service` carried
`["repair_photo","condition","unclassified"]` while §3.1's corrected array drops
`unclassified`. Two copies of a rule is how they come to disagree; it now cites
the one the gate enforces.

---

## Mixed-version model

```text
old API + old schema        unchanged, untouched
old API + schema 137        X1–X5: pre-137 reads and writes all still work,
                            including the legacy closeout path
new writer + schema 137     X6–X7: the old reader sees a coherent completed row
rollback API + schema 137   not trapped — 137 is additive, every object is new
```

**Rollback is behavioural, not destructive.** Rolling Release 0 back means
reverting the *writer*. Migration 137 stays. Dropping it would strand any
evaluation already written and is never the rollback path.

---

## Deployment packet — for when this is authorized

### STEP 2 — migration

```text
preconditions   ledger at 136 · quiet write traffic · lock_timeout set
digest          the gate proves migration == payload ae4b9b77…c2ea4d
ledger          136 → 137, in the same transaction as the DDL
locks           SHARE ROW EXCLUSIVE on work_orders; readers unaffected
expected time   ~25–30 ms with no competing writer
rollback        DO NOT drop 137. It is additive and the old API runs against it.
```

Post-migration invariant read, one line:

```bash
node tools/steps23/verify_137_applied.js
```

### STEP 3 — writer

```text
files           src/technician/lifecycle_service.js
                src/technician/evidence_service.js
                src/maintenance/proof_evaluation_service.js
contract        eight facts, one transaction, evidence gate, chain contract
boot proof      npm run verify (9 gates) + server boot
old reader      proven compatible (X6–X7)
rollback SHA    the merge commit preceding this package
```

Every production command here is one line. Nothing requires pasting a script
into a shell under pressure — the lesson from the transport build.
