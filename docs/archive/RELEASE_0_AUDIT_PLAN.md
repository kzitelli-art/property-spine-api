# Release 0 — production audit plan

**Status: DRAFT, awaiting owner authorization under Open Ruling 4.**
**Nothing in this plan has been run. No production connection has been opened.**

Governing documents: [`ASK_SPINE_BUILD_CONTRACT.md`](ASK_SPINE_BUILD_CONTRACT.md)
§16 (Release 0), §19 Open Rulings 1, 2 and 4 · [`PHILOSOPHY.md`](PHILOSOPHY.md)
§5, §17, §33 · [`MIGRATION_LEDGER_INVERSE_GATE.md`](MIGRATION_LEDGER_INVERSE_GATE.md) §6.

> **Open Ruling 4 is the only thing standing in front of Release 0**
> (charter §19b). Rulings 1 and 2 are frozen. This document is the audit
> definition that ruling requires, written so it can be authorized or refused
> on its contents rather than on its name.

---

## 0. Phase 0 — the state this plan was written against

Fetched from `origin/main` at authoring. **No remembered SHA was used, and no
SHA below was copied from another document.**

```text
API  origin/main   ec9887732748e482deab21d76080a0d5f8c347c2
                   "Merge pull request #42: Open Ruling 2 — canonical proof
                    state contract"   ·  2026-08-05 22:01:13 -0400

APP  origin/main   6220ca5907137aa9036adaee23e8fee78a88a3f0
                   "Merge: Work Orders stays reachable when the obligations
                    read fails."      ·  2026-08-05 21:36:17 +0000

migration ceiling in the build   136   (files 000–136; 125 legitimately absent)
migration ceiling applied        NOT READ — requires a production connection,
                                 which is what this plan asks to authorize
```

### 0.1 Two recorded SHAs were stale, and the difference matters

| Source | Claimed API tip | Actual | Verdict |
|---|---|---|---|
| `ASK_SPINE_BUILD_CONTRACT.md` §"State at authoring" | `a04a1df` | `ec98877` | **stale by 9 commits** — `a04a1df` confirmed an ancestor of `origin/main` |
| `THREAD_HANDOFF.md` header | `a9f51da`+ | `ec98877` | stale; the file documents its own one-commit lag, but the gap is larger than one |

The APP SHA in both documents is **exact** (`6220ca5`), exactly as
`THREAD_HANDOFF.md` predicts — that file does not live in the app repository,
so it carries no self-referential lag.

**Correction to a claim carried forward.** `THREAD_HANDOFF.md` states that
every API commit after `62db770` has been "documentation only." Measured:

```text
git diff --name-only 62db770..origin/main
  docs/    8 files
  tools/   1 file      tools/branch_cleanup.sh
```

The substance of the claim holds — **no product code, no migration, no schema
change** — but "documentation only" is not literally true, and the next session
to lean on it as a precise statement would be leaning on something slightly
wrong. Restate it as *no product code, no migration, no schema change since
`62db770`.*

### 0.2 The proof-classification logic as it exists today

`src/surfaces/work_order_status_read.js:90`, read from `origin/main`:

```js
const PROOF_REQUIRED_CLASSIFICATIONS = ["repair_photo", "condition", "unclassified"];
```

Consumed 49 lines later:

```js
// :138
const preserved = attachments.filter(
  (a) => a.storage_state === "stored"
      && PROOF_REQUIRED_CLASSIFICATIONS.includes(a.proof_classification));
const proof = {
  required: true,
  satisfied: preserved.length > 0,
  …
};
```

and the boolean reaches the operator as an instruction (`:84`):

```js
case "completion_claimed":
  return proof.satisfied ? "Close out the work order"
                         : "Obtain repair photo before completion";
```

**`unclassified` is the schema's default.** Migration `134_technician_lifecycle.sql`
declares `proof_classification text not null default 'unclassified'`. So an
attachment about which *no classification decision has ever been made* currently
satisfies valid proof, and the board tells the operator to close the work order
on the strength of it.

This is a §5 confident-wrong of the exact shape the product exists to eliminate:
an unknown silently promoted to a yes, with an action recommended on top of it.
It is Release 0 acceptance criterion 1 (`unclassified` does not satisfy valid
proof), and it is the whole reason Release 0 changes live Work Orders behaviour.

**Three further structural facts, read at the same time:**

- There is **no proof-evaluation table anywhere** — no `work_order_proof_evaluations`,
  no `proof_evaluation` column, in `migrations/` or `src/`. Proof is recomputed
  from attachment rows on every read. Release 0 introduces the first durable
  evaluation record; it does not modify an existing one.
- `proof.state` does not exist. The API emits only the boolean `proof.satisfied`.
- The list shape (`readPropertyWorkOrderStatuses`, `:325`) returns the narrower
  `proof: { required, satisfied, not_preserved_count }`, confirming the concern
  raised-but-not-ruled in §19 Ruling 2: **the board renders from a subset that
  carries no `state` field**, so both shapes must carry it or the two surfaces
  will disagree on precisely the states Ruling 2 exists to distinguish.
- **The composite `(work_order_id, property_id)` scoping §16 requires is already
  established**, not new work: migration 134 creates `uq_work_orders_id_property`
  and attaches composite FKs to both `work_order_progress` and
  `work_order_proof_attachments`. Release 0's evaluation table follows a
  precedent rather than inventing one. *(This corrects a first-pass reading of
  134 that stopped at the attachment column list and missed the table-level
  constraint below it — see §4 D for what that changed in the query set.)*

---

## 1. What this document asks for

Authorization to run **one read-only audit against the production database**,
producing counts and identifiers only, to supply the production-derived facts
§16 requires before Release 0's migration and API change can be designed.

It asks for nothing else. It does not ask to write, to backfill, to correct, to
deploy, or to run any existing script whose name contains "audit" or "proof."

---

## 2. Open Ruling 4's five conditions, answered

> *"The audit must be explicitly authorized, structurally read-only, run outside
> the unsafe harness paths, output only the counts and identifiers needed for
> review, and perform no mutation. No production audit script may run merely
> because it is named 'audit' or 'proof.'"*

### 2.1 Explicitly authorized

This document is the authorization request. It is not self-authorizing. The
audit runs only after the owner records approval of **this file at a named
commit** — approval of a plan that was later edited is not approval.

### 2.2 Structurally read-only

Not "read-only by inspection of the SQL." **Structurally**, in the proven
pattern already shipping at `tools/ledger_reconcile.js:76-98`:

```js
await client.query("begin transaction read only");
await client.query("savepoint write_probe");
let writable = false;
try   { await client.query("create temporary table __probe (x int)"); writable = true; }
catch { /* expected */ }
await client.query("rollback to savepoint write_probe");
if (writable) { /* REFUSE — nothing has been read */ process.exit(2); }
```

Three properties this pattern already carries, and the reasons each exists:

1. **The probe runs before any read.** If the connection accepts a write, the
   tool exits having read nothing. It cannot produce a partial result from a
   connection whose safety it failed to establish.
2. **The savepoint is what makes the probe survivable.** A failed statement
   aborts the whole transaction block; without the savepoint every subsequent
   read dies with *"current transaction is aborted"* and the tool reports
   nothing while appearing to have run. That is a documented incident on this
   repository, not a hypothetical.
3. **`begin transaction read only` is enforced by Postgres**, not by the
   script's own discipline.

The audit additionally **should** connect as a `SELECT`-only role. The probe
does not depend on that being configured correctly — that is the point of
having both.

### 2.3 Outside the unsafe harness paths

`docs/DB_HARNESS_ISOLATION.md` is unambiguous: **every `.db.js` harness**
connects to `process.env.DATABASE_URL` with no override and no guard, and each
`tx()` helper ends in `commit`. Those paths permanently write synthetic rows to
production.

Therefore, binding:

- The audit lives at **`tools/release0_proof_audit.js`**.
- It is **not** placed in `tests/`, is **not** named `*.db.js`, and is **not**
  reachable from `run_harnesses.sh`.
- It imports **nothing** from `tests/`. `tests/_engine.js` is the standing
  counter-example on this repository — a hand-maintained copy of a rule that
  drifted permissive in three places.
- It opens its own client and never uses a harness `tx()` helper.

### 2.4 Counts and identifiers only

Enumerated in §4. Every output is an integer, a UUID, a timestamp, an enum
value, or a Postgres catalog name. §5 states what may never be selected.

### 2.5 No mutation

Guaranteed by 2.2 structurally, and by 2.3 for the surrounding path. The audit
also ends in `rollback`, never `commit` — belt and braces, and the rollback is
not the safety mechanism.

---

## 3. What the audit must determine, and why

Every query below traces to a Release 0 acceptance criterion (§16) or a frozen
ruling (§19). **A query that does not is not in this plan.**

| # | Question | Traces to |
|---|---|---|
| A | Is the full ledger reconcilable, including below version 109? | §19b sequencing — Release 0 adds migration 137+ |
| B | How many work orders flip `satisfied → not_satisfied` on the `unclassified` correction? | §16 acceptance 1, 6; rollback plan |
| C | Does every completed work order have a completion timestamp to compare against the activation boundary? | §19 Ruling 1 classification predicate |
| D | Does production actually carry the composite-scoping constraints migration 134 declares? | §16 "scoped by the composite foreign key" |
| E | How does the completed population split across the compatibility mapping, and how much of it cannot be classified at all? | §19 Ruling 2 compatibility mapping |

**Query F was removed.** An earlier draft asked whether the 100-row list cap in
`readPropertyWorkOrderStatuses` is already hiding work orders in production.
That is a real defect and it is squarely §6's — the **candidate population
contract**, which is an Ask Spine **Build 1** concern. It is not proof
correction, it does not gate the Release 0 migration, and nothing in the
Release 0 acceptance list depends on the answer. Carrying it here would have
widened a production audit with a question belonging to a different release,
which is the exact drift Ruling 4's "only the counts and identifiers needed"
guards against. It belongs in the Build 1 candidate-predicate work.

### 3.1 Why A is first, and why it is a Release 0 blocker in its own right

`MIGRATION_LEDGER_INVERSE_GATE.md` §6 records the ledger as reconciled for
versions **109–130 only**, with the section *"Still open: the ledger below
version 109"* explicitly unresolved. The inverse gate evaluates the **entire**
ledger and **refuses to boot** on a ledger row whose file the repository does
not carry.

Release 0 introduces a new migration. If a single orphan row exists anywhere
below 109, **the Release 0 deploy does not start** — and it fails at boot,
inside the deployment window, after the app-first compatibility release has
already shipped. That is the worst possible moment to discover it.

`tools/ledger_reconcile.js` already exists, is already structurally read-only,
and already imports the same `classifyLedger` that `migrate.js` runs at boot,
so it cannot disagree with what the deploy will decide. **Query A is therefore
not new code — it is running an existing, already-proven tool unchanged.**

### 3.2 Why C is the finding that may reshape Ruling 1

Open Ruling 1 is frozen, and its classification predicate is:

```text
no evaluation row AND completed_at <  activation timestamp   → legacy determination
no evaluation row AND completed_at >= activation timestamp   → missing-evaluation defect
```

**`work_orders` has no `completed_at` column.** Verified against every migration
from `001_baseline.sql` forward: the table carries `created_at`, `updated_at`
and `status text default 'open'  -- open|scheduled|complete`, and no migration
ever adds `completed_at`.

The value the API emits as `completed_at` is derived at
`work_order_status_read.js:247` from a `work_order_progress` row of
`kind = 'completed'` — a lane introduced by **migration 134**, which is recent.

So there is a third population the frozen ruling does not name:

```text
status = 'complete'  AND  no 'completed' progress row
  → no completion timestamp exists
  → classifiable as NEITHER legacy NOR defect
```

Anything completed before 134, or completed by any path that does not write a
progress row, lands here. Ruling 1 is frozen against a fact the schema does not
store, and **the size of that population decides whether Release 0 needs a
fourth classification, a defined fallback, or nothing at all.** Query C is the
only way to find out, and guessing it wrong means either inventing a legacy
determination for work whose completion time is unknown — a §5 violation — or
raising a writer-defect alert for work completed years before the writer
existed.

**This does not reopen Ruling 1.** The ruling's *principle* — an explicit
durable activation timestamp, never inferred — is untouched and correct. What
the audit surfaces is that its *predicate* references a column that does not
exist. That is an implementation gap to close before Release 0 emits states,
and §19's own "residual gap to close during implementation" language anticipates
exactly this kind of correction.

### 3.3 The activation timestamp is captured, not chosen

**This audit is not an input to the activation boundary, and no output of it
may be used to set one.** Open Ruling 1 is frozen on this point and the
distinction is the whole reason the ruling exists.

```text
CAPTURED   the exact instant the proof-evaluation writer is verified live
           (release step 3), persisted unchanged at step 4

NOT        inferred from migration applied_at · commit time · documentation
           date · hosting deploy time · the range of completion timestamps
           already in production · any number this audit reports
```

An earlier draft of query C2 described the completion-time range as informing
how the boundary is "chosen against data rather than an assumption." That
wording is wrong twice over: the boundary is not chosen at all, and production
data is precisely the class of evidence Ruling 1 forbids as its source. The
ruling's reasoning is explicit — the proof boundary is **prospective**, it
governs a cutover we control, so the real fact can be *recorded* rather than
inferred, and inferring it would be choosing a worse source on purpose.

What the completion-time range is legitimately for: understanding how far back
recorded completion history reaches, so the size of the pre-writer population is
known before the cutover instead of discovered after it. That is context for
review. It is not a boundary input, and §4 C2 now says so in the query itself.

---

## 4. The queries

All read-only. All counts, identifiers, enum values, timestamps, catalog names.

### A — full ledger reconciliation

```bash
DATABASE_URL="<production, read-only role>" node tools/ledger_reconcile.js
```

Existing tool, run unchanged, no flags. **Exit 0 is a precondition for
numbering the Release 0 migration.** Non-zero output names which of the five
conditions fired and is itself the finding.

### B — the `unclassified` blast radius

```sql
-- B1  population map. What evidence actually exists, by state and class.
select storage_state, proof_classification, count(*) as n
  from work_order_proof_attachments
 group by 1, 2
 order by 1, 2;

-- B2  THE NUMBER THAT SIZES THE RELEASE.
--     Work orders whose proof is satisfied TODAY only because an
--     unclassified attachment is counted. These flip satisfied ->
--     not_satisfied the moment Release 0 lands, and each one changes what
--     the operator is told to do.
with stored as (
  select work_order_id, proof_classification
    from work_order_proof_attachments
   where storage_state = 'stored'
)
select count(*) as flipping_work_orders
  from (
    select work_order_id
      from stored
     group by work_order_id
    having bool_or(proof_classification = 'unclassified')
       and not bool_or(proof_classification in ('repair_photo', 'condition'))
  ) t;

-- B3  the identifiers, for review. IDs ONLY — no title, no description,
--     no note, no resident.
with stored as (
  select work_order_id, property_id, proof_classification
    from work_order_proof_attachments
   where storage_state = 'stored'
)
select work_order_id, property_id
  from stored
 group by work_order_id, property_id
having bool_or(proof_classification = 'unclassified')
   and not bool_or(proof_classification in ('repair_photo', 'condition'))
 order by property_id, work_order_id;
```

### C — completion-timestamp coverage

> **⚠ Corrected after the completion-writer audit.** Every query in this
> section originally filtered `where w.status = 'complete'`. That predicate
> excludes an entire live completion lane — see
> [`RELEASE_0_COMPLETION_WRITER_MATRIX.md`](RELEASE_0_COMPLETION_WRITER_MATRIX.md).
> `PATCH /work-orders/:id/closeout` (`maintenance.js:553`, mounted at
> `server.js:2985`) writes **`status='closed'`**, stores proof in the
> `completion_photo` column, and writes no progress row at all. An audit
> carrying the old filter would have reported a completed-work census missing
> a whole lane, and reported it as clean.
>
> **C0 therefore censuses the status vocabulary instead of assuming it.**
> `001_baseline.sql` comments the column as `open|scheduled|complete`; the code
> writes at least `needs_followup` and `closed` beyond that. The comment is not
> an enumeration and the audit must not treat it as one.

```sql
-- C0  THE STATUS CENSUS. Run before anything that filters on status.
--     Counts only — this is what stops a filter from silently defining the
--     question, per charter §6.
select status, count(*) as n
  from work_orders
 group by status
 order by status;
```

**Every join below is scoped on `(work_order_id, property_id)`, never on
`work_order_id` alone.** `work_order_progress` carries `property_id` as its own
column and `fk_wop_work_scope` binds the pair; joining on the id alone would be
a second, weaker scoping rule than the schema's, and §21 makes property the
scope of every read. A single-column join is also how a cross-property row
would silently satisfy a check that is supposed to be property-scoped.

```sql
-- C1  THE RULING 1 GAP, MEASURED — split by status, so the two live
--     completion lanes are never summed into one number.
select w.status,
       (p.work_order_id is not null) as has_completed_progress_row,
       count(*) as n
  from work_orders w
  left join (select distinct work_order_id, property_id
               from work_order_progress
              where kind = 'completed') p
    on p.work_order_id = w.id
   and p.property_id  = w.property_id
 where w.status in ('complete', 'closed')
 group by 1, 2
 order by 1, 2;

-- C2  the recorded completion-time range.
--
--     THIS DOES NOT CHOOSE THE ACTIVATION BOUNDARY. Under Open Ruling 1 the
--     boundary is CAPTURED at the instant the proof-evaluation writer is
--     verified live (release step 3) and persisted unchanged (step 4). It is
--     never derived from production data, a migration applied_at, a commit
--     time, a documentation date, or a deploy time — and this audit is all
--     four of those things at once, so it must not be read as an input to it.
--
--     What this range IS for: knowing how far back recorded completion
--     history reaches, so the size of the pre-writer population is
--     understood before the cutover, not after it.
select count(*) as completed_progress_rows,
       min(occurred_at) as earliest,
       max(occurred_at) as latest
  from work_order_progress
 where kind = 'completed';

-- C3  identifiers for the population with NO completion timestamp, if C1
--     shows any. These are the rows Ruling 1's predicate cannot evaluate.
select w.id as work_order_id, w.property_id, w.status,
       (w.completion_photo is not null) as has_column_photo,
       w.created_at, w.updated_at
  from work_orders w
  left join (select distinct work_order_id, property_id
               from work_order_progress
              where kind = 'completed') p
    on p.work_order_id = w.id
   and p.property_id  = w.property_id
 where w.status in ('complete', 'closed') and p.work_order_id is null
 order by w.property_id, w.status, w.created_at;

-- C5  the third proof model, counted. Writer 2 stores evidence in the
--     completion_photo COLUMN, which the attachment-based proof reader
--     cannot see. This is a boolean presence check on a column whose
--     contents are never selected — see §5.
select w.status,
       (w.completion_photo is not null) as has_column_photo,
       (w.completion_note  is not null) as has_column_note,
       count(*) as n
  from work_orders w
 where w.status in ('complete', 'closed')
 group by 1, 2, 3
 order by 1, 2, 3;

-- C4  cross-property scoping check. A progress row whose property_id does not
--     match its work order's would mean the composite FK is not doing what
--     the schema says. Expected zero; cheap; and if it is ever non-zero the
--     property-scoped joins above are the reason we would find out.
select count(*) as cross_property_progress_rows
  from work_order_progress p
  join work_orders w on w.id = p.work_order_id
 where w.property_id <> p.property_id;
```

### D — composite-scoping constraints, confirmed present

**The precedent Release 0 needs already exists.** Migration 134 establishes the
whole pattern, and Release 0's evaluation table copies it rather than inventing
it:

```sql
-- migrations/134_technician_lifecycle.sql:47
create unique index if not exists uq_work_orders_id_property
  on work_orders (id, property_id);

-- :87   work_order_progress
constraint fk_wop_work_scope
  foreign key (work_order_id, property_id)
  references work_orders (id, property_id) on delete cascade

-- :147  work_order_proof_attachments
constraint fk_wopa_work_scope
  foreign key (work_order_id, property_id)
  references work_orders (id, property_id) on delete cascade
```

**Consequence for the audit: the orphan-row queries drafted here were dropped.**
`fk_wopa_work_scope` makes an orphan attachment *unrepresentable*, so a query
counting them can only ever return zero. Running it would produce a clean line
in a receipt that proves nothing the schema did not already guarantee — the
kind of reassuring noise Ruling 4's "only the counts and identifiers needed"
exists to exclude.

What remains is worth one catalog read, because it checks a different thing:
that production's schema actually matches what 134 declares.

```sql
-- D1  confirm the composite-scoping constraints are present in production
--     as written. This verifies 134 applied fully, independently of the
--     ledger saying it did.
select conname, pg_get_constraintdef(oid) as definition
  from pg_constraint
 where conrelid in ('work_order_progress'::regclass,
                    'work_order_proof_attachments'::regclass)
   and contype = 'f'
 order by conrelid::regclass::text, conname;

select indexname, indexdef
  from pg_indexes
 where tablename = 'work_orders'
   and indexname = 'uq_work_orders_id_property';
```

If either returns nothing, the schema and the ledger disagree, and that is a
finding that stops Release 0 before its migration is written.

### E — completed population, split by whether Ruling 1 can classify it

**An earlier draft of this section claimed every completed work order will emit
`proof.satisfied = null`. That claim was withdrawn, and the reason is the whole
point of query C.**

The reasoning that produced it was: no evaluation table exists → every completed
work order lacks an evaluation row → each resolves to `legacy_indeterminate` or
`missing_evaluation_defect` → both map to `null`. Every step is sound *except*
that it assumes Ruling 1's predicate can be evaluated for every row. It cannot.
The predicate reads `completed_at`, and for a completed work order with no
`kind='completed'` progress row **there is no completion timestamp at all** —
so neither branch applies, the row resolves to none of the four published
states, and what it emits is undetermined.

Asserting `null` for that population would be inventing the answer to a ruling
that has not been made. It is the same error as the line-90 defect this release
exists to correct: taking an unknown and promoting it to a definite value
because the definite value is convenient.

```sql
-- E1  the finished-work population, split by lane AND by whether Ruling 1
--     can evaluate it. Property-scoped join, as in C.
select w.status,
       case when p.work_order_id is not null
              then 'has_completion_timestamp'
              else 'no_completion_timestamp'
       end as ruling_1_evaluable,
       count(*) as n
  from work_orders w
  left join (select distinct work_order_id, property_id
               from work_order_progress
              where kind = 'completed') p
    on p.work_order_id = w.id
   and p.property_id  = w.property_id
 where w.status in ('complete', 'closed')
 group by 1, 2
 order by 1, 2;
```

**What may be concluded from E1, and what may not:**

```text
status='complete'            Ruling 1's predicate is evaluable. No evaluation
  + has_completion_timestamp row exists for any of these (no evaluation table
                             exists), and every recorded completion necessarily
                             predates an activation instant captured at a future
                             release step — so these resolve to
                             legacy_indeterminate, which maps to
                             proof.satisfied = null.

status='complete'            NO CLASSIFICATION CLAIM IS MADE.
  + no_completion_timestamp  Ruling 1's predicate cannot be evaluated. This
                             population resolves to none of the four published
                             proof states, and this audit does not assert what
                             it emits, whether it is legacy, whether it is a
                             defect, or whether it is null.

status='closed'              NO CLASSIFICATION CLAIM IS MADE, AND A PRIOR
  (any timestamp state)      QUESTION IS OPEN. These rows do not reach the
                             classification at all — lifecycleStateOf tests
                             status = 'complete' and nothing else, so they are
                             not "completed" to the reader that Release 0
                             modifies. Whether they are completed work for
                             Release 0's purposes is an unmade ruling, recorded
                             in RELEASE_0_COMPLETION_WRITER_MATRIX.md §3.
```

The counts of the second and third groups are the finding. **They are numbers,
handed to the owner, with no interpretation attached** — because deciding what
those populations mean is a ruling, and §19 reserves rulings to the owner and to
named engineering decisions, not to an audit.

This is also why the Release 0 build stops short of the proof-state contract:
if that count is non-zero, the four published states of Ruling 2 do not cover
the real data, and **the contract itself may need to change before anything
emits it.** Building the writer first would mean building against a contract
whose completeness has not been established.

---

## 5. What the audit must never select

Binding, and the reason is not squeamishness — it is that a review artifact
containing resident data becomes a thing that must itself be governed.

```text
NEVER   comm_events.body            technician words, resident messages
NEVER   work_order_progress.note    verbatim field reports
NEVER   work_orders.description · title · completion_note · completion_photo
NEVER   persons.*                   resident identity of any kind
NEVER   any phone number, email address, or provider media URL
NEVER   users.name                  actor UUIDs are sufficient for review
```

**Presence is not contents, and the distinction is load-bearing here.** Query C5
needs to know whether `completion_photo` and `completion_note` are populated,
because that is the third proof model's only visible signal. It reads them as
`IS NOT NULL` and emits a boolean:

```sql
(w.completion_photo is not null) as has_column_photo    -- PERMITTED
w.completion_photo                                      -- FORBIDDEN
```

Permitted: UUIDs · counts · timestamps · enum values (`storage_state`,
`proof_classification`, `status`, `kind`) · Postgres catalog names.

**The `solo_4233_seed.json` lesson applies in reverse.** That file *claimed* to
contain resident data and was synthetic. This audit touches tables that make no
such claim and may hold the real thing. Neither the label nor its absence
decides it — the column list does, and the column list above is the control.

---

## 6. Output, receipt, and stop condition

One receipt at `docs/release-0-audit/RECEIPT.md`, recording:

```text
API main SHA at run time          the audit's own connection identity
                                    (current_database, current_user)
read-only probe result            "attempted and refused" — verbatim
each query letter                 the SQL as run, and its result
ledger_reconcile exit code        and its full categorized output
run timestamp                     and the operator who authorized it
```

Findings are stated as counts. **The audit draws no conclusion about what
Release 0 should do** — it supplies the facts that let that be decided in
review.

### 6.1 This plan does NOT authorize

- any write, backfill, correction, or migration;
- deploying anything;
- running any other script in `tools/`, `tests/`, or elsewhere, whatever it is
  named;
- reading any column in §5;
- widening the query set once approved. **A new question is a new
  authorization** — one round trip is cheaper than one unreviewed query against
  production.

### 6.2 Stop condition

Work stops at this document. `tools/release0_proof_audit.js` **has not been
written**, and will not be until this plan is authorized at a named commit.

On authorization the sequence is: write the tool → prove the write-probe
refuses on a writable connection (falsification, not just a green run) → run A
first and stop if it is non-zero → run B–E → preserve the receipt → return for
the Release 0 design review with facts instead of assumptions.

---

## 7. Classification (§18)

| Component | Class | Removal condition |
|---|---|---|
| `tools/release0_proof_audit.js` | 3 — temporary instrument | Removed when Release 0 ships and its receipt is preserved. It answers a cutover question and has no standing purpose. |
| `docs/release-0-audit/RECEIPT.md` | 1 — permanent record | Never removed. It is the evidence the cutover was designed against real data. |
| This plan | 1 — permanent record | Never removed. It is the authorization artifact Open Ruling 4 requires. |
