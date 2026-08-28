# Release 0 — Steps 2 & 3 implementation candidate

**Branch** `claude/steps-2-3-candidate` · **Base** `b71834973a61ad89b22c642a287869aa05738556`

Built ahead of need so that when evidence ingress closes, the question is
whether to deploy a proven package — not what still needs building.

**Not merged. Not deployed. No production connection was opened.**

**A critical pass over this package after it was first written found a live
production bug (Finding 6), a name collision the prose had glossed over
(Finding 7), an invariant enforced by the caller rather than the service
(Finding 8), and a stored state with no production writer (Finding 9). Read the
Findings before the Proof.** The proof counts went 92 → 98 because six of the
new assertions were red when written.

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

`tests/gates/gate_migration_137_promotion.js` compares the two **statement by
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
7  action/operating receipt            built by the CALLER, inside the same tx
                                      — see Finding 8. The service does not
                                      enforce it; the writer gate pins the
                                      caller list instead.
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
service refuses them by name — as does the database. `not_satisfied` is
*writable* but has no production writer yet (Finding 9).

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
tools/steps23/prove.js                      98 / 98   exit 0   twice, clean baselines
tools/steps23/falsify.js                    25 / 25   exit 0   twice, identical
tools/steps23/prove_migration_lock_timeout  11 / 11   exit 0   twice, identical
npm run verify (10 gates)                   PASS      exit 0
server boot                                 OK
```

Concurrency is real: two separate connections, both inside open transactions at
the same time. Two concurrent completions → exactly one closes. Same provider
key delivered twice → one completed event. Completion racing evidence ingestion
→ one completion. Two concurrent supersessions of one head → one wins, no fork.
Two concurrent genesis inserts → one wins.

Falsification covers: unclassified evidence · referenced evidence · removed
actor requirement · dropped evaluation write · bypassed chain service ·
duplicate completed event · cross-property attachment · derived state in the
enum · altered migration bytes · a third completion writer · **the removed
savepoint**. Each turns its proof red, sources are compiled in memory and never
edited, every mutation asserts its target was found, and all three source
digests are re-checked at the end.

### What this proof does NOT establish

A count is not a scope. Read as a claim about coverage, 98/98 is worth less than
it looks, and the honest boundary is:

```text
NOT proven   any HTTP path. Every assertion calls the service function
             directly. The Twilio webhook, tenantlink's transaction wrapper
             and the receipt write are exercised by governance gates and by
             reading the source — not by a request.
NOT proven   any browser. Per §33 that alone means this is not "done" for an
             operator workflow; it is PROVEN, one rung below.
NOT proven   production data. Every fixture is synthetic and built by the
             harness. Nothing here has met a real work order, a real photo
             from a real handset, or Neon.
NOT proven   Twilio media fetch. `fetchMedia` is injected; no carrier was
             contacted.
NOT proven   scale. Fixture counts are single digits. The lock finding is a
             correctness statement about lock modes, not a timing forecast
             on a production-sized `work_orders`.
NOT proven   the migration against production ROW COUNTS. 32 ms on an empty
             table forecasts nothing about a full one.
proven only  the service contract against a real PostgreSQL at schema 137,
             including real overlapping transactions.
```

`prove.js` also runs against a database this build created. It has never been
run against one it did not.

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

**6. A LIVE PRODUCTION BUG: the duplicate-key handler could not run.**
Found by the critical pass, not by the build. `appendProgress` caught PostgreSQL
`23505` and then issued a recovery `SELECT` — but PostgreSQL aborts the *whole*
transaction on a failed statement, and with no savepoint between them that
`SELECT` does not run. It raises `current transaction is aborted, commands
ignored until end of transaction block`. **The handler written to make a carrier
redelivery harmless was itself the thing that threw**, taking the entire
operations turn down with it.

```text
introduced   NOT by this build. Pre-existing in 134's lifecycle service and
             live in production today.
trigger      an ordinary repair sequence, no exotic timing: a claim arrives
             with no usable photo (recorded, work order stays open) → the
             technician sends the photo → the carrier redelivers the same
             message. A phone with one bar does this.
symptom      the turn throws and rolls back. The technician gets nothing —
             not a completion, not a refusal, not a sentence.
fix          SAVEPOINT around the progress insert; roll back to it before the
             recovery read. Same discipline as the read-only audit probes: a
             probe must not poison the transaction it is probing.
also fixed   the handler absorbed 23505 even with no idempotency key, and
             returned `replayed: true` with `row: undefined` when the lookup
             found nothing — inventing a replay that never happened. It now
             rethrows in both cases. The partial unique index on
             `idempotency_key` (134) is the only unique index on the table, so
             a keyless 23505 is always something else.
proven       prove.js J14–J19, which did not exist before this pass and were
             RED when written. falsify.js F11 restores the pre-fix code
             exactly — no savepoint, no rollback — and reproduces the abort.
```

This is the strongest argument in the packet for the owner's *"deploy slowly,
with hard stop conditions"* instinct. Six new assertions on a path nobody had
described found a defect that eleven months of green tests did not. The
completion path is not more trustworthy for having been counted; it is more
trustworthy for having been attacked from an angle nobody had tried.

**7. `claimCompletion` is not a unique name in this codebase.**
`src/maintenance/work_acceptance_service.js` exports a function with the same
name, reached from the staff agent and the work-acceptance route. It is a
different domain — unit-turn work items — and it never touches `work_orders`;
it writes `work_completion_claims`, obligations, events and
`unit_triage_required_work`.

It is therefore **not** a third work-order completion writer. But "the canonical
completion writer is `claimCompletion`" was unqualified prose in this document,
and a future caller could import the wrong one and pass review on the name
alone. `gate_completion_writers.js` now asserts the distinction rather than
trusting it: `C1` fails if the unit-turn function ever writes `work_orders`.

**8. Fact 7 — the action receipt — is enforced by the CALLER, not the service.**
`claimCompletion` does not write the receipt; `conversation.js` does, inside the
same transaction. The eight facts are atomic *as composed at the call site*, which
means a second caller could produce a governed completion with no receipt and
nothing in the service would object. Rather than move the receipt (a larger
change than Step 3 authorizes), `C2` in the writer gate pins the caller list to
exactly `src/technician/conversation.js` and fails on any addition, naming the
obligation the new caller inherits.

**9. `not_satisfied` is writable but no production path writes it.**
The service accepts both stored states and the schema allows both, but every
call site reaching `recordEvaluation` today is the completion path, which writes
`satisfied`. `not_satisfied` exists in the chain contract for supersession —
`prove.js` J7–J9 exercise it by writing one directly — and gains a production
writer in a later step. Stating it here so the enum is not mistaken for evidence
that the negative case is exercised in production. It is not.

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
preconditions   ledger at 136 · quiet write traffic
digest          the gate proves migration == payload ae4b9b77…c2ea4d
ledger          136 → 137, in the same transaction as the DDL
locks           SHARE ROW EXCLUSIVE on work_orders; readers unaffected
expected time   ~30 ms with no competing writer, on an EMPTY table. This does
                not forecast a production-sized work_orders — see "What this
                proof does NOT establish".
rollback        DO NOT drop 137. It is additive and the old API runs against it.
```

**The `lock_timeout` is now in `migrate.js`, not in the runbook.**
`prestart` runs migrations on every Render deploy while the previous instance is
still serving writes, and the migration wants a lock that traffic holds. With no
timeout the deploy waits forever — and because PostgreSQL queues lock waiters,
every writer arriving behind it stalls too. A quiet-traffic *instruction* is not
a control; the operator cannot see the traffic from the deploy button.

```text
default         10s, per migration transaction (set local)
override        MIGRATION_LOCK_TIMEOUT — validated at startup, and a malformed
                value EXITS rather than being silently ignored (a bad interval
                would otherwise mean no timeout at all)
on contention   the deploy FAILS. No retry loop — retrying into live write
                traffic is how a fail-fast guard becomes a slow-motion outage.
proven          prove_migration_lock_timeout.js, 11/11, by MEASUREMENT in both
                directions: refused in ~2.1 s with a writer holding the lock,
                ledger still 136, no objects created, the live writer's own
                transaction unharmed; clean apply with no competitor.
```

A guard never observed to fire is indistinguishable from no guard, which is why
the negative case is measured rather than reasoned about.

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
boot proof      npm run verify (10 gates) + server boot
old reader      proven compatible (X6–X7)
rollback SHA    the merge commit preceding this package
```

**One change in this package is independent of Release 0 and fixes a live bug:**
the savepoint in `appendProgress` (Finding 6). It is not gated on migration 137,
it changes no product meaning, and reverting the writer would restore the defect.
If the owner wants the smallest possible first deployment, that fix is separable
and stands on its own.

Every production command here is one line. Nothing requires pasting a script
into a shell under pressure — the lesson from the transport build.
