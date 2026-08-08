# Release 0 — completion truth, enforced at commit (migration 140)

**⛔ BUILD-AHEAD. Not applied to production.**
**🔒 FROZEN at revision 4** — digests pinned in `docs/release0/FROZEN_ARTIFACTS.json`,
enforced by `tests/gate_release0_frozen.js`. Changing any frozen artifact requires
re-running the falsification package and updating the digest in the same commit.

**REVISION 4.** Every revision was broken by measurement, not opinion.

| | enforced | broken by |
|---|---|---|
| rev 1 | "not the `missing_evaluation_defect` state" | 4 attacks (`falsify_containment.js`) |
| rev 2 | a current `satisfied` head | 3 more (`falsify_activation_boundary.js`, `falsify_proof_trust.js`) |
| rev 3 | a *grounded* satisfied head, re-checked on every write | evidence could still be **replaced** rather than invalidated |
| rev 4 | below | — so far |

> **After the cutover a work order is legal only if it is not terminal, or it is
> `complete` with a current `satisfied` evaluation that CITES qualifying preserved
> evidence — and an inventoried legacy row's status is frozen at exactly what the
> census recorded. `closed` is historical vocabulary and is refused outright.**

Enforced by the database, at commit time.

---

## 0 · What revisions 2 and 3 got wrong

### B1 · the activation boundary was answerable from a stale snapshot

A4 closed the case of a writer already holding a `work_orders` lock across the
activation. **That is not the hard case.** A transaction that opens at
`REPEATABLE READ`, fixes its snapshot on *anything unrelated*, waits for the
activation to commit, and touches `work_orders` only afterwards never contends
for that lock at all. At its commit the deferred guard asked *"is there an
activation?"* through its own pre-activation snapshot, got **no**, and returned.

**Measured, on all three shapes** — terminal UPDATE, terminal INSERT, and a
superseding evaluation on an already-terminal row. The first ran before the fix
and committed `status=complete`, which the canonical reader then classified
`missing_evaluation_defect`.

No `SELECT` escapes its own snapshot, so no different query could fix this. A
**row-locking** read can: in `REPEATABLE READ`, `FOR SHARE` against a row whose
latest version committed after your snapshot raises `40001` instead of quietly
answering from the past. The stale writer is **refused**, not exempted.

Which is why the epoch is a **pre-existing singleton row that the activation
UPDATEs**, created by this migration and stamped by a trigger on
`release_0_activation_history` — not by the service, so hand-run SQL cannot
activate without moving it. Had it been *inserted*, an old snapshot would simply
not see it and there would be nothing to serialize against.

`FOR SHARE`, not `FOR UPDATE`: many completions commit concurrently and must not
serialize against each other. Shared locks coexist; the only conflict is with the
one transaction that moves the epoch.

### C1 · `satisfied` was just a word

Nothing in the schema ties an evaluation to evidence — no NOT NULL, no FK, no
check. Raw SQL could insert a row whose `state` column reads `'satisfied'` with
**zero** links and then terminalize the work order. That does not defeat the guard
so much as **move the status bypass one table over**.

We spent this release learning not to trust `work_orders.status`. A column in a
different table that happens to read `satisfied` has earned no more trust than
that one had.

So a satisfied head must **cite** at least one attachment qualifying under the
canonical writer's own evidence gate — facts about the stored bytes, not a
carrier's claim. The writer links exactly the rows that gate returned, so a
genuine completion always passes; only a manufactured one does not.

Five forgeries, and which layer refused each:

```text
zero attachment links                        migration 140  (R0004)
linked to 'unclassified'                     migration 140  (R0004)
linked to evidence never STORED              migration 140  (R0004)
linked to a disallowed MIME                  SCHEMA — not even representable
linked to another work order's photo         SCHEMA — composite foreign key
── control ────────────────────────────────────────────────────────────
the same hand-written shape, real evidence   COMMITS
```

That last line matters: **140 does not require the caller to be
`claimCompletion`. It requires the state to be true.** Raw SQL that establishes
real evidence and cites it is not an attack.

### C2 · the evidence could rot underneath — and revision 3's fix was not enough

Once evidence is part of the invariant, the attachment row is part of the
invariant — and it can be changed without touching `work_orders` **or** the
evaluation:

```sql
update work_order_proof_attachments set proof_classification='unclassified' …
update work_order_proof_attachments set storage_state='not_preserved', content=null …
```

**Both succeeded**, and the reader went on reporting `satisfied`. Revision 3
closed that by **recomputing**: an attachment UPDATE fired the deferred guard,
which re-checked whether the completion still stood.

**A recompute only catches mutations that BREAK the completion.** Two do not:

| | attack | why a recompute is blind to it |
|---|---|---|
| **R1** | swap `content` + `sha256` together for another qualifying photo | still computes as grounded — but the 10:00 completion now rests on a 14:00 photo. Nothing was invalidated; the evidence was **replaced** |
| **R2** | reopen → rewrite the evidence → complete again | every intermediate state is legal; there is no completion to invalidate at the moment of the rewrite |

So revision 4 stops recomputing and makes the doctrine structural:

> **Proof used to justify a completion becomes historical evidence. Correct it by
> adding new truth — a superseding evaluation, a reopen — never by rewriting the
> evidence that justified the old decision.**

Truth is not protected merely because the decision was valid when it was made.
The evidence that justified it has to remain intact, or the decision's basis is
whatever somebody last edited.

**The whole row, not a column list** — an enumerated list is what goes stale the
day a column is added. Once an attachment is **cited** by any evaluation it is
frozen entirely (`R0005`, immediate, on UPDATE and DELETE).

**The freeze begins at citation, not creation.** Every shipped mutation of that
table is the ingress pipeline (`referenced → stored / fetch_failed`), which runs
strictly before any evaluation can cite the row — inventoried and re-derived every
run by `tests/gate_evidence_immutability.js`, so a new writer cannot arrive
silently and start failing with `R0005` in production.

Every mutation that could touch a live completion, and what stops it:

```text
re-classify the cited attachment       migration 140   R0005  frozen
un-store it (all four fields)          migration 140   R0005  frozen
SWAP the bytes for another good photo  migration 140   R0005  frozen  ← rev 4
rewrite it while NOT terminal          migration 140   R0005  frozen  ← rev 4
delete the cited attachment            migration 140   R0005  (FK also RESTRICTs)
delete the evaluation→attachment link  SCHEMA — append-only trigger
re-point the link                      SCHEMA — append-only trigger
edit the evaluation state in place     SCHEMA — append-only trigger
delete the evaluation                  SCHEMA — append-only trigger
supersede with ungrounded not_satisfied  migration 140 R0001
── and the control ────────────────────────────────────────────────────
mutate an UNCITED attachment           ALLOWED — ingress must work
```

### C3 · three implementations of one definition

Revision 3 left the evidence rule in three places: the JS evidence gate, the
activation's population check, and the guard. A source gate comparing the
classification and MIME arrays is **not enough** — the conditions can drift while
the arrays stay identical. Three implementations of a load-bearing definition of
truth is where divergence eventually becomes a production incident.

The database now answers one question in one place:

```text
release_0_evidence_qualifies(attachment)      → is this photo proof?
release_0_completion_proof_status(wo, prop)   → grounded | ungrounded
                                                 | not_satisfied | none
```

**Three callers, one definition:** the deferred guard, the activation's population
validation, and `release_0_completion_invariant_violations`. None of them restates
the evidence columns; the equivalence proof asserts that, not just that they agree
today.

`evidence_service.js` keeps the **different** job it actually performs — SELECTING
which attachments a completion may be built on, before the writer creates the
evaluation. **JS selects, DB validates.** Their equivalence is proven over every
row shape the schema permits — a 60-shape cross product generated from the
schema's own CHECK constraints, not a hand-picked list — in
`tools/step12/prove_evidence_equivalence.js`. Falsified by drifting the JS array:
E1 goes red.

Disagreement is a defect in both directions, and they are not symmetric:

- **JS yes / DB no** — the canonical writer builds a completion the database then
  refuses. An outage in the completion path.
- **DB yes / JS no** — work that cannot be completed through the product, only by
  hand.

One finding worth recording: **MIME does not discriminate.** The CHECK constraint
already narrows `mime_type` to exactly the three qualifying values, so the guard's
MIME list is defence in depth over a column that cannot hold anything else. Stated
rather than quietly carried.

### D1 · `closed` was still available as a completion vocabulary

Revision 2 asked only *"is the proof good?"*, so a post-cutover `open → closed`
**with** a satisfied evaluation was legal — a second, permanently valid way to
complete work, contradicting the frozen Step 6 ruling that future completion
writes `complete`. Now refused outright (`R0003`), proof or no proof.

And an inventoried legacy row only had to stay *some* terminal value, so
`closed → complete` with no evaluation relabelled history as a governed
completion. Its status is now pinned to `status_at_cutover`. Grandfathering
preserves historical truth; it is not a standing exemption.

---

## 0a · Correcting completed work is a REOPEN, never a silence

The guard refuses a superseding `not_satisfied` evaluation on a work order that
stays terminal. Read carelessly that is *a database invariant keeping `satisfied`
true by denying the system permission to record that it was wrong* — which would
be the worst possible outcome for a product whose north star is recording truth.

It is not that. What is refused is **ending the transaction terminal without
proof**. A correction that also reopens the work, in the same transaction, is
legal and is proven (`falsify_proof_trust` P9).

**The Release 0 rule:** changing the proof state of completed work is a reopen.
The evidence is always recordable; what is refused is claiming completion while
saying the proof failed.

The inventory that makes this safe to state: **exactly one shipped caller writes
evaluations** — `technician/lifecycle_service.claimCompletion` — and it only ever
writes `satisfied`. No shipped path supersedes an evaluation on an already-terminal
work order, so this rule breaks nothing that exists. A future governed correction
path must be built against this shape.

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
tools/step12/prove_completion_guard.js        47 / 47
tools/step12/prove_evidence_equivalence.js    22 / 22   JS selects ≡ DB validates
tools/step12/falsify_containment.js           18 / 18   rev-1 attacks
tools/step12/falsify_activation_boundary.js   12 / 12   × 3 shapes — B1
tools/step12/falsify_proof_trust.js           29 / 29   C1 · C2 · R1 · R2 · D1
tools/step12/falsify_activation_refusals.js    4 / 4    × 11 variants
```

Each adversarial file records its **prediction before its result**, so a wrong
model shows up as a wrong prediction rather than being edited away afterwards.

```text
A1  terminal + not_satisfied              REFUSED   R0001
A2  head flipped after completion         REFUSED   R0001, from the eval table
A3  legacy laundering                     REFUSED   R0002
A4  in-flight writer straddles activation the ACTIVATION refuses  WRITERS_IN_FLIGHT
B1  STALE SNAPSHOT, three shapes          REFUSED   40001, by the epoch's locking read
C1  forged `satisfied`, five shapes       REFUSED   R0004 / schema
C2  evidence invalidated afterwards       REFUSED   R0004 / schema
D1  post-cutover `closed`, WITH proof     REFUSED   R0003
D2  inventoried `closed → complete`       REFUSED   R0002
R1  SWAP the bytes for another good photo REFUSED   R0005 — a recompute is blind to it
R2  rewrite cited evidence while NOT terminal  REFUSED  R0005
R3  mutate an UNCITED attachment          ALLOWED — ingress must keep working
P9  correction that REOPENS               ALLOWED — the line that must not be crossed
```

### The activation's own refusals, all eleven measured

```text
guard-absent · trigger-dropped · epoch-missing · epoch-not-stamped   GUARD_ABSENT
trigger-disabled · not-deferred · permissive-body                    GUARD_STALE
population-not-satisfied · population-ungrounded
population-closed-evaluated                          POPULATION_NOT_EXPLAINABLE
population-clean                                     ACTIVATES  ← the control
```

`trigger-disabled` is the one worth naming: `ALTER TABLE … DISABLE TRIGGER` leaves
the row in `pg_trigger` with the right name, the right timing and the right
definition, and it simply does not fire. A presence check passes.

`population-*` exists because **the census only sees terminal rows with NO
evaluation.** A terminal row with a `not_satisfied` head, or a `satisfied` head
citing nothing, is invisible to it — so it would exist on day one, permanently,
legal purely because no trigger fired at the instant the cutover was recorded.
The activation now scans for that **inside its own transaction** and refuses.

### The three that carry the most weight

**`X2`** — every refusal above is worthless if something *else* was refusing. So
the guard is dropped, the identical bypass is retried, and it **succeeds**. `X3`
then has the **canonical reader** classify the result as
`missing_evaluation_defect`.

**`C6`** — the control that keeps C1–C5 from passing vacuously: the same
hand-written shape with real evidence **commits**. A guard that refuses everything
proves nothing about evidence.

**`Z1`/`Z2`** — the verdict is not an assertion count. It counts the forbidden
population in SQL, then reads **every** work order through the canonical reader
and requires zero that read as completed without a satisfied proof.

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

DROP / DISABLE TRIGGER            *** POSSIBLE ***  measured in A5: a
  by the TABLE OWNER              NON-SUPERUSER that owns work_orders CAN
                                  drop them — and DISABLE is worse, because
                                  the trigger stays in pg_trigger looking
                                  correct. Both fail the activation's
                                  precondition, and `where_are_we` reports
                                  PRESENT BUT NOT PROTECTING rather than
                                  "installed".
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

## 7a · One audit query, from the same definition

```sql
select * from release_0_completion_invariant_violations;
```

> Show me every post-cutover work order whose **committed** terminal state
> violates the completion invariant.

Derived from `release_0_completion_proof_status` — the same function the deferred
guard and the activation call. Not a fourth handwritten interpretation that agrees
today and drifts next month. `where_are_we` reads it as a **stop condition**, and
the composed proof asserts it holds exactly the one violation that harness
deliberately manufactures, cross-checked against the canonical reader by **set**,
not by count.

**Empty is the expected answer.** A row means the guard was dropped, deployed
late, or bypassed by privileged DDL.

### The sweep ruling — settled

**Do not point the §4.2 sweep at all four violation classes.** Keep its frozen
semantics narrow.

> **Do not turn system-integrity failures into new human accountability
> categories.**

The audit view reports four ways the invariant can be violated. That does not mean
the sweep should create four kinds of employee obligation. After migration 140,
three of those states are **structurally unreachable through ordinary governed
operation**. If one appears, it is evidence that the system boundary failed, was
bypassed, or was administratively altered — a guard failure, a privileged bypass,
a bad deployment, another architecture defect. That must hard-red the integrity
audit and trigger investigation. It must not quietly become somebody's task.

| | job | consumer |
|---|---|---|
| `release_0_completion_invariant_violations` | integrity / audit truth · **any non-empty result is a hard red** | release + runtime instrumentation, investigate the boundary |
| §4.2 sweep | **only** `terminal_without_evaluation`, the defect class it was designed for | raises one obligation, against a named role |

Release 0 does not invent three new accountability categories. The two are
cross-checked — `prove_release0_composed` P11 asserts the view and the canonical
reader name the same rows — and deliberately not merged.

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

### ⚠ WHAT MIGRATION 140 DOES *NOT* GUARANTEE — say it exactly

> **Migration 140 prevents terminal-state/proof divergence. The canonical service
> still owns the full eight-fact completion transaction.**

A deliberate SQL writer that establishes **real** evidence and cites it can commit
a work order that is proof-true and structurally hollow: no `completion_claimed`
progress row, no distinct `completed` row, the owning obligation still open, no
action receipt. Measured (`falsify_proof_trust` H1–H4): it commits, the reader
correctly calls its proof `satisfied`, and the **Step 4 fact set** refuses it —
`F1 · F6 · F7 · F8` go red, the proof facts stay green.

That is an acceptable Release 0 threat boundary, and it is stated rather than
allowed to drift into a bigger claim. **No release receipt may say the trigger
makes arbitrary SQL equivalent to `claimCompletion`.**

The two controls are complementary and neither is redundant: the guard stops the
state from diverging even when the fact set is not run; the fact set catches
structural hollowness even when the guard has been dropped (§7). Step 4's
falsification variants therefore run **with the guard deliberately off** — the
case where that fact set matters most is precisely the one where the guard is
absent.

**Scope is `work_orders`, `work_order_proof_evaluations` and
`work_order_proof_attachments`.** Nothing about other tables, and nothing about
deletes — those are covered by `ON DELETE RESTRICT` and the append-only triggers,
which is a different mechanism and is enumerated in §0 C2.

---

## 10 · Ledger

`138`/`139` are Release 0's; so is this, so it takes **`140`**, moving the text-line
silo to `141`. Flagged because the earlier rule said "the next unrelated migration
starts at 140" — this one is not unrelated.


---

## 11 · Parked, deliberately — not solved here

**Retention, privacy and storage lifecycle.** The whole-row freeze on cited
evidence is correct for Release 0: proof that justified a governed decision must
remain intact. It also means a `repair_photo` cited by a completion **cannot be
deleted or redacted** by ordinary means, and the bytes live in
`work_order_proof_attachments.content`.

That is a real future concern — retention windows, a deletion request, storage
growth, moving bytes out of the row — and it is **parked, not overlooked**. It is
not solved inside Release 0 because a retention mechanism that can erase evidence
is exactly the mechanism this migration exists to prevent, and designing both at
once would produce a compromise of each.

When it is taken up, the shape it has to respect: **redaction is new truth, not a
rewrite.** Whatever replaces the bytes must leave the historical record saying that
evidence existed, what it was, and that it was deliberately removed — the same
doctrine, applied to a different verb.
