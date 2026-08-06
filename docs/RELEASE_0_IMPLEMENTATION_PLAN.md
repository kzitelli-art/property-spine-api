# Release 0 — implementation and deployment plan

**Revision 2 — corrected against the design review of 2026-08-06.**
**Documentation only. Nothing in this plan has been implemented.**

Governing rulings: [`ASK_SPINE_BUILD_CONTRACT.md`](ASK_SPINE_BUILD_CONTRACT.md)
§19 Rulings 1 and 2 (frozen), §19c Rulings A–D (frozen).
Factual basis: [`release-0-audit/RECEIPT.md`](release-0-audit/RECEIPT.md),
[`RELEASE_0_COMPLETION_WRITER_MATRIX.md`](RELEASE_0_COMPLETION_WRITER_MATRIX.md),
[`RELEASE_0_APP_CLOSEOUT_AUDIT.md`](RELEASE_0_APP_CLOSEOUT_AUDIT.md).

## Gates before implementation begins

```text
1  credential rotation                CREDENTIAL_ROTATION_RUNBOOK.md
2  this plan reviewed and accepted    revision 2
3  the evidence-source decision       §5.0 — owner decision, not engineering
```

**All three. Rotation alone is not sufficient.**

---

## 0. What revision 1 got wrong

Eight findings from the review. Each is closed below and named where it is
closed, so a reviewer can check the fix rather than take its word.

| # | Finding | Closed in |
|---|---|---|
| 1 | Evaluations were not genuinely immutable — `superseded_by_id` was `UPDATE`d | §2.1 |
| 2 | Evaluation→attachment links were not work-order or property scoped | §2.2 |
| 3 | `ON DELETE CASCADE` let permanent history be deleted | §2.5 |
| 4 | Activation model was self-contradictory — a singleton that could be superseded | §2.3 |
| 5 | The reader shipped before activation and inventory existed | §5 |
| 6 | Activation verified a *count*, not the exact population | §6.2 |
| 7 | Defect routing made canonical reads side-effecting | §4.2 |
| 8 | The app closeout call sites were unaudited | `RELEASE_0_APP_CLOSEOUT_AUDIT.md` |

Findings 5 and 8 are the two that would have caused visible operator harm.
Finding 5 would have rendered **every** terminal work order as
`missing_evaluation_defect` for the whole gap between two deploys. Finding 8
would have left the operator with **no way to complete a work order at all**.

---

## 1. What the production facts change

```text
work orders relying on 'unclassified'      0   → no operator-visible flip
proof attachment rows                      0   → no evidence to reclassify
kind='completed' progress rows             0   → canonical writer never ran
status='complete' rows                     0
legacy cutover inventory population        1   one 'closed' row
```

1. **The `unclassified` correction is a no-op on live data.** The risk in this
   release is not the proof-array change.
2. **The real work is consolidation** — one canonical meaning of completion, one
   canonical proof path. §19c Rulings B and D.
3. **The cutover inventory will contain exactly one row**, which makes it cheap
   to verify by hand and no less important to build correctly: it is the
   mechanism that separates legacy from defect forever, not just at cutover.
4. **Rollback is unusually safe.** With no attachments and no evaluations there
   is nothing to un-write.

§19 Ruling 1 still governs the activation instant: **captured** at the writer's
verified-live moment, persisted unchanged, never derived from production data.

---

## 2. Schema

One additive migration, `137_release_0_proof_evaluations.sql`. **Not written.**

### 2.1 Proof evaluations — immutable and append-only *(finding 1)*

Revision 1 stored `superseded_by_id` and `UPDATE`d it on the prior row when a
re-evaluation arrived. **An append-only table whose rows are updated is not
append-only.** Supersession is now derived from insertion order; no row is ever
written twice.

```text
work_order_proof_evaluations
  id                     uuid primary key default gen_random_uuid()
  evaluation_seq         bigint generated always as identity   -- monotonic
  work_order_id          uuid not null
  property_id            uuid not null
  state                  text not null check (state in ('satisfied','not_satisfied'))
  evaluated_at           timestamptz not null default now()
  evaluated_by_user_id   uuid references users(id)
  evaluated_by_service   text not null
  rule_version           text not null
  supersedes_id          uuid references work_order_proof_evaluations(id)
  created_at             timestamptz not null default now()

  unique (id, work_order_id, property_id)          -- for §2.2's composite FK
  constraint fk_wope_work_scope
    foreign key (work_order_id, property_id)
    references work_orders (id, property_id) on delete restrict
```

- **`supersedes_id` points backwards**, from the new row to the one it replaces.
  The older row is never touched. Revision 1's forward `superseded_by_id`
  required mutating history to record that history had moved on.
- **The live evaluation is the highest `evaluation_seq`** for a work order:
  `order by evaluation_seq desc limit 1`. No column marks it, so nothing has to
  be updated to keep the marking true.
- **`state` carries only the two computed values.** `legacy_indeterminate` and
  `missing_evaluation_defect` are derived at read time (§3.2). Storing them
  would make a derived fact writable and the inventory would stop being the
  authority.
- **`rule_version`** so a preserved verdict states the rule in force when it was
  made — the discipline `work_completion_claims.proof_satisfied` already follows.

Immutability is enforced by the database, not by convention:

```sql
create or replace function forbid_mutation() returns trigger as $$
begin
  raise exception '% is append-only: % is not permitted', TG_TABLE_NAME, TG_OP;
end $$ language plpgsql;

create trigger no_update_wope before update on work_order_proof_evaluations
  for each row execute function forbid_mutation();
create trigger no_delete_wope before delete on work_order_proof_evaluations
  for each row execute function forbid_mutation();
```

A trigger rather than a `REVOKE`, because a `REVOKE` does not bind the owner
role — and the production audit established that the application connects as
`neondb_owner`.

### 2.2 Evaluation → attachment links — fully scoped *(finding 2)*

Revision 1 keyed on `(evaluation_id, attachment_id)` alone, which permitted
linking an attachment belonging to a **different work order or property** as
proof. Both sides now carry the scope and both FKs are composite.

```text
work_order_proof_evaluation_attachments
  evaluation_id   uuid not null
  attachment_id   uuid not null
  work_order_id   uuid not null
  property_id     uuid not null
  created_at      timestamptz not null default now()
  primary key (evaluation_id, attachment_id)

  constraint fk_wopea_eval_scope
    foreign key (evaluation_id, work_order_id, property_id)
    references work_order_proof_evaluations (id, work_order_id, property_id)
    on delete restrict

  constraint fk_wopea_attach_scope
    foreign key (attachment_id, work_order_id, property_id)
    references work_order_proof_attachments (id, work_order_id, property_id)
    on delete restrict
```

Requires one added unique constraint on the attachment table so it can be
referenced that way — additive, no data change:

```sql
alter table work_order_proof_attachments
  add constraint uq_wopa_id_scope unique (id, work_order_id, property_id);
```

**A cross-work-order or cross-property link is now unrepresentable**, in the
manner migration 136 made a duplicate resident update unrepresentable. Not
discouraged — impossible.

Same append-only triggers as §2.1.

### 2.3 Activation history and current head *(finding 4)*

Revision 1 declared `id boolean primary key check (id)` — one row, forever —
**and** a `superseded_by_id` column, which presumes more than one. The two
cannot both be true. Ruling 1 requires that a correction "supersede visibly and
leave the original readable", which a singleton cannot do.

Two objects, with a clean division: **history is append-only; the head is
derived.**

```text
release_0_activation_history
  id                 uuid primary key default gen_random_uuid()
  assertion_seq      bigint generated always as identity
  activated_at       timestamptz not null    -- the CAPTURED instant (§6.1)
  captured_at_step   text not null           -- 'writer_verified_live'
  captured_by        text not null
  supersedes_id      uuid references release_0_activation_history(id)
  reason             text                    -- required when superseding
  recorded_at        timestamptz not null default now()

  constraint ck_r0ah_supersede_has_reason
    check (supersedes_id is null or reason is not null)
```

```sql
create view release_0_activation_current as
  select * from release_0_activation_history
   order by assertion_seq desc limit 1;
```

- **The head is a view**, so nothing is updated to change it. A correction is a
  new row citing the one it supersedes, with a reason. The original stays
  readable, permanently.
- **`activated_at` and `recorded_at` are different facts.** `activated_at` is
  the instant captured at deployment step 4; `recorded_at` is when the row was
  inserted. The gap between them is exactly what Ruling 1 exists to close.
- Append-only triggers as §2.1.

A guard so a correction is deliberate rather than accidental — the first row may
supersede nothing, and every later row must supersede something:

```sql
create unique index uq_r0ah_genesis
  on release_0_activation_history ((supersedes_id is null))
  where supersedes_id is null;
```

### 2.4 Legacy cutover inventory — immutable

```text
release_0_legacy_cutover_inventory
  work_order_id      uuid not null
  property_id        uuid not null
  status_at_cutover  text not null check (status_at_cutover in ('complete','closed'))
  had_column_photo   boolean not null
  had_column_note    boolean not null
  activation_id      uuid not null references release_0_activation_history(id)
  captured_at        timestamptz not null default now()
  primary key (work_order_id, property_id)

  constraint fk_r0lci_work_scope
    foreign key (work_order_id, property_id)
    references work_orders (id, property_id) on delete restrict
```

Populated once, in the activation transaction, **from the live table** — never
from a hand-written list and never from the audit receipt. `activation_id` ties
each row to the activation that captured it, so a superseding activation is
traceable rather than ambiguous.

`had_column_photo` / `had_column_note` record **presence only**, never contents
— and per `RELEASE_0_APP_CLOSEOUT_AUDIT.md` §3, the app's only writer of that
column emits a `stub://` string, so presence is all the column can honestly
support.

Append-only triggers as §2.1.

### 2.5 Nothing permanent may be deleted *(finding 3)*

Revision 1 used `on delete cascade` from `work_orders` on every new table.
Deleting a work order would then delete its evaluation history and its cutover
inventory row — **silently destroying the Class-1 records that make legacy
distinguishable from defect.**

```text
work_order_proof_evaluations               on delete RESTRICT
work_order_proof_evaluation_attachments    on delete RESTRICT  (both FKs)
release_0_legacy_cutover_inventory         on delete RESTRICT
```

Plus the `before delete` triggers of §2.1 on all four tables. The FK protects
against deletion of the *parent*; the trigger protects against deletion of the
row itself. **Both, because they fail differently.**

Consequence, stated plainly: **a work order that carries a proof evaluation or a
cutover-inventory row can no longer be deleted.** That is the intended
behaviour. Existing `cascade` relationships on `work_order_progress` and
`work_order_proof_attachments` are **not changed by this migration** — altering
them is a separate decision with its own blast radius.

---

## 3. Read model

One canonical derivation, in `work_order_status_read.js`.

### 3.1 The corrected classification array

```js
// was: ["repair_photo", "condition", "unclassified"]
const PROOF_REQUIRED_CLASSIFICATIONS = ["repair_photo", "condition"];
```

Production impact: **zero rows** (audit B2 = 0).

### 3.2 Deriving `proof.state`

```text
activation head absent
  → state = unavailable                    ← NOT defect. See §3.2.1.

live evaluation row exists
  → state = that row's state               (satisfied | not_satisfied)

no live evaluation
  AND (work_order_id, property_id) IS in the cutover inventory
  → legacy_indeterminate

no live evaluation
  AND NOT in the inventory
  AND terminal
  → missing_evaluation_defect

not terminal
  → proof not yet due; reflects current evidence, never a defect
```

**Terminal** = `status = 'complete'`, or `status = 'closed'` for an inventoried
row (§19c Ruling B). No other status is terminal.

**No timestamp comparison appears anywhere.** Inventory membership is the
discriminator, which is what closes the missing-`completed_at` gap without a
fifth state.

#### 3.2.1 The absent-activation case *(finding 5, read side)*

If the activation head does not exist, the reader **cannot** distinguish legacy
from defect — the inventory that separates them has not been written. It
therefore reports `unavailable`, exactly as a contract failure does.

It must not fall back to `missing_evaluation_defect`. Doing so would raise a
writer-defect on every terminal work order in the database the moment the reader
shipped, which is what revision 1's sequence would have caused for the whole gap
between two deploys.

This makes the reader safe to deploy in any order — but §5 still sequences it
after activation, because "renders unavailable" is a safety net, not a plan.

### 3.3 Both shapes carry `state`

§19 Ruling 2 requires it: the board renders from the list subset, so if only the
detail carried `state` the two surfaces would disagree on precisely the states
the ruling exists to distinguish.

```text
detail   proof: { required, state, satisfied, preserved_count,
                  not_preserved_count, attachments[],
                  legacy_evidence: { column_photo_present, column_note_present } }
list     proof: { required, state, satisfied, not_preserved_count,
                  legacy_evidence: { column_photo_present, column_note_present } }
```

`legacy_evidence` carries **presence booleans only** (§19c Ruling C).

### 3.4 Compatibility mapping — frozen

```text
satisfied                  → satisfied = true
not_satisfied              → satisfied = false
legacy_indeterminate       → satisfied = null
missing_evaluation_defect  → satisfied = null
unavailable                → satisfied = null
```

`null` is deliberate. Legacy, defect and unavailable **may not be collapsed into
"proof failed."**

---

## 4. Canonical completion writer

`claimCompletion` becomes the one completion service (§19c Ruling D). In **one
transaction**:

```text
1  the completion claim
2  evaluate preserved evidence against the corrected classification array
3  insert the proof evaluation  (supersedes_id → prior live row, if any)
4  insert evaluation → attachment links, fully scoped (§2.2)
5  status = 'complete'
6  append the distinct `completed` progress event
7  close the owning obligation
8  write the action receipt
```

All eight or none.

### 4.1 Retiring the legacy closeout route

**The route survives; its done-path does not.** `closeoutNotDone` shares the
route and is not a completion (`RELEASE_0_APP_CLOSEOUT_AUDIT.md` §1) — retiring
the route wholesale would take the follow-up lane with it.

```text
1  App stops calling the done-path for completion, and gains a canonical
   completion surface in the same release (§5 step 1b).
2  Prove in the browser that no completion path reaches the legacy done-path
   and that the not-done path still works.
3  API done-path fails closed: 409, naming the canonical path, writing nothing.
   The not-done path is untouched.
4  Done-path branch removed in a later cleanup release.
```

**A non-empty `completion_photo` string may never be converted into valid
proof** — not by the route, not by a shim, not by a migration. Per the app
audit, that string is a `stub://` URI with no bytes behind it.

### 4.2 `missing_evaluation_defect` routing — write-side and idempotent *(finding 7)*

Revision 1 had the reader raise an obligation. **A canonical read that writes is
not a read**, and it would have made every board render a write, duplicated
obligations on every refresh, and turned a GET into something that can fail on a
read-only replica.

**The reader is pure.** It computes the state and returns it. It writes nothing,
ever.

Routing is a separate governed write, invoked from exactly two places:

```text
a  claimCompletion, when it observes a terminal work order it did not
   just evaluate and which is absent from the inventory;
b  a scheduled sweep — the same rail followups already run on.
```

Idempotency is enforced by the database, in the manner of migration 136:

```sql
create unique index uq_obl_proof_eval_missing_open
  on obligations (property_id, related_id)
  where related_type = 'work_order'
    and type = 'proof_evaluation_missing'
    and status <> 'complete';
```

A second sweep inserts nothing. **A duplicate open defect obligation is
unrepresentable**, not merely avoided by a check-then-insert race.

```text
module         maintenance
type           proof_evaluation_missing
owner          property_manager
severity       normal
related_type   work_order
related_id     the work order
```

An obligation rather than an alert: it is the accountability rail this codebase
already has, it appears on surfaces operators already read, and it closes
through a governed service. Expected production volume at activation: **zero**.

---

## 5. Cross-repo deployment sequence

### 5.0 ⚠ Blocking decision before this can be scheduled

Per `RELEASE_0_APP_CLOSEOUT_AUDIT.md` §4.2: `claimCompletion` evaluates
**preserved attachments**, attachments come from the **technician SMS lane**,
that lane is deployed but **not phone-verified**, and the app has **no upload
pipeline** — its "photo" is a stub string.

So the operator-facing completion path depends on an evidence source that does
not yet demonstrably work. **Owner decision, three options:**

```text
a  phone-verify the SMS technician lane; the operator completes from
   evidence the technician texted in;
b  build a real upload pipeline in the app;
c  ship schema + writer + reader now, and defer the operator completion
   surface to a named later slice — during which NO completion occurs
   through any path.
```

**Step 1b below cannot be written until this is chosen.** Steps 2–5 are
independent of it and can proceed.

### 5.1 The sequence

App-first remains mandatory (§19 Ruling 2). The new API *requires* the
compatibility app; the new app runs against either API shape.

```text
STEP 1a  APP — compatibility release
         · ONE proof normalizer; no surface interprets the response itself
         · accepts BOTH the boolean-only and the state-plus-boolean shape
         · unknown state, missing field, or state/boolean mismatch
           → CONTRACT FAILURE → "proof state unavailable"
             NEVER not_satisfied, never legacy, never empty
         · handles the `unavailable` state (§3.2.1)
         DEPLOY. VERIFY IN PRODUCTION AGAINST THE OLD API.

STEP 1b  APP — canonical completion surface
         · shape determined by the §5.0 decision
         · legacy done-path no longer called for completion
         · closeoutNotDone UNCHANGED and still working
         DEPLOY. BROWSER-VERIFY both, against the OLD API.

STEP 2   API — schema only
         · migration 137; no reader change, no writer change
         · ledger verify gate passes (EXPECTED_LEDGER_CEILING=136)
         DEPLOY. Ledger ceiling becomes 137.

STEP 3   API — canonical writer only
         · claimCompletion writes the evaluation transactionally
         · legacy done-path fails closed (409)
         · READER STILL EMITS THE OLD SHAPE — no proof.state yet
         DEPLOY. VERIFY THE WRITER IS LIVE.
         ⚠ CAPTURE THE VERIFIED-LIVE INSTANT HERE.

STEP 4   API — activation transaction
         · persist the instant captured at step 3 (NEVER now())
         · populate the cutover inventory from the live table
         · verify the exact population (§6.2)
         · ONE transaction
         RUN ONCE.

STEP 5   API — proof-state reader                    ← finding 5
         · emits proof.state on BOTH shapes
         · deployed ONLY after activation and inventory exist
         DEPLOY.

STEP 6   Browser verification — §7.3.

STEP 7   APP — consumer-proof release
         · prove every consumer uses the shared normalizer

STEP 8   Separate cleanup release
         · remove proof.satisfied after a repo-wide consumer search
           and a mismatch gate
         · remove the legacy done-path branch
         · remove attachStubPhoto
```

**Steps 3, 4 and 5 are three deploys, in that order.** Revision 1 combined
writer and reader in one step ahead of activation, which would have rendered
every terminal work order as `missing_evaluation_defect` for the entire gap.
§3.2.1 now makes that failure impossible; the sequence makes it not arise.

**Steps 3 and 4 remain separate**, and the gap between them is the hazard
Ruling 1 names. Step 4 persists the instant captured at step 3, never `now()`.

### 5.2 SHA pair requirements

```text
APP  <step 1a SHA>  compatibility        REQUIRED by the step-5 API
APP  <step 1b SHA>  canonical completion REQUIRED by the step-3 API
API  <step 3 SHA>   writer               REQUIRES app 1b
API  <step 5 SHA>   reader               REQUIRES app 1a
```

**Rolling the app back behind step 1a requires rolling the API back behind
step 5. Rolling back behind step 1b requires rolling back behind step 3.**
The release packet names all four SHAs.

---

## 6. Activation transaction

```sql
begin;

insert into release_0_activation_history
  (activated_at, captured_at_step, captured_by)
values ($1, 'writer_verified_live', $2)          -- $1 CAPTURED at step 3
returning id into v_activation_id;

insert into release_0_legacy_cutover_inventory
  (work_order_id, property_id, status_at_cutover,
   had_column_photo, had_column_note, activation_id)
select w.id, w.property_id, w.status,
       (w.completion_photo is not null),
       (w.completion_note  is not null),
       v_activation_id
  from work_orders w
 where w.status in ('complete','closed')
   and not exists (
     select 1 from work_order_proof_evaluations e
      where e.work_order_id = w.id
        and e.property_id   = w.property_id);

-- §6.2 exact-population verification runs here, before commit.

commit;
```

### 6.1 `$1` is captured, never `now()`

Under §19 Ruling 1 the boundary is the instant the writer was **verified live**
at step 3. Using the insertion time reopens the gap the ruling closes. **This is
the single most important line in the release.**

### 6.2 Verify the exact population, not a count *(finding 6)*

Revision 1 asserted `count = 1`. **A count can match while the identity
differs** — one row completed since the audit and one row deleted would produce
a matching count over an entirely different population, and the activation would
commit a silently wrong inventory.

The exact expected set is supplied at run time and compared **both ways**:

```text
expected set, from the production audit of 2026-08-06 (receipt §5.4):

  work_order_id  fa8acda9-7852-47b6-ac2b-4e50fe414d21
  property_id    971c51ab-be96-4e5f-81df-0e59804c879b
```

```sql
-- unexpected: in the live population, absent from the expected set
-- missing:    in the expected set, absent from the live population
-- ABORT if either is non-empty; report both, do not stop at the first.
```

The expected set is passed explicitly, in the manner of
`EXPECTED_LEDGER_CEILING`, which already refuses to run for someone who has not
looked. **If production has moved since the audit, that is a fact worth stopping
for**, and the operator re-derives the set from a fresh read-only audit under a
fresh authorization.

### 6.3 Idempotency

The inventory's primary key makes a re-run insert nothing new. A second
activation row is permitted **only** as a visible correction citing
`supersedes_id` with a reason (§2.3), and `uq_r0ah_genesis` prevents a second
genesis row. **An accidental re-run inserts a duplicate genesis activation and
is refused by the database.**

---

## 7. Acceptance

### 7.1 Real Postgres

```text
PROOF CLASSIFICATION
  unclassified alone                  → not_satisfied      (was satisfied)
  repair_photo stored                 → satisfied
  condition stored                    → satisfied
  unclassified + repair_photo         → satisfied
  referenced, never stored            → not_satisfied

STATE DERIVATION
  terminal, no evaluation, inventoried    → legacy_indeterminate
  terminal, no evaluation, NOT inventoried→ missing_evaluation_defect
  non-terminal, no evaluation             → NEITHER legacy NOR defect
  activation head absent                  → unavailable, NOT defect   ← f.5

IMMUTABILITY                                                          ← f.1,3
  UPDATE any evaluation row               → REFUSED by trigger
  DELETE any evaluation row               → REFUSED by trigger
  DELETE a work order carrying one        → REFUSED by FK restrict
  DELETE a cutover inventory row          → REFUSED
  re-evaluation                           → new row, supersedes_id set,
                                            prior row BYTE-IDENTICAL after

SCOPE                                                                 ← f.2
  link an attachment from another work order → REFUSED by composite FK
  link an attachment from another property   → REFUSED by composite FK

ACTIVATION                                                            ← f.4,6
  second genesis activation row           → REFUSED
  correction without a reason             → REFUSED by check
  correction with supersedes_id + reason  → accepted; original readable
  current head view                       → returns the newest row
  activation re-run                       → refused, nothing inserted
  population differs from expected set    → ABORTS, reports both directions

WRITER
  claimCompletion partial failure         → whole transaction rolls back;
                                            no orphan evaluation, no status change

DEFECT ROUTING                                                        ← f.7
  reader run twice                        → ZERO writes observed
  sweep run twice                         → one obligation, not two
  sweep after manual close                → no new obligation while closed
```

Isolated Postgres only — never a `.db.js` harness against production
(`DB_HARNESS_ISOLATION.md`).

### 7.2 Real HTTP

```text
detail and list both carry proof.state
state/boolean mapping matches §3.4 on BOTH shapes
legacy done-path returns 409 and writes nothing
legacy NOT-done path still works and still creates its follow-up
GET endpoints perform zero writes (assert against the statement log)
```

### 7.3 Browser — §17, the operator's own path

```text
sign in → Property Home → Work Orders → open a job → read the proof state
```

```text
legacy_indeterminate renders AS legacy, with column evidence as context,
  and NOT as satisfied
missing_evaluation_defect renders VISUALLY DISTINCT from ordinary missing
  proof, and its obligation appears on the surface that owns it
unavailable renders as unavailable, never as not_satisfied
unclassified does not satisfy proof
list and detail AGREE on state for the same work order
completion through the canonical path writes all eight facts
the legacy done-path is unreachable from the UI
the legacy NOT-done path is still reachable and still works
```

**Presence is not visibility.** Assertions measure `getComputedStyle().display`
and a bounding box, not `querySelector` — the hidden-lanes defect proved that
the hard way.

**The proof enters the way the operator enters.** No test may call a module
function directly to reach the surface under test.

### 7.4 The regression the acceptance list was missing

§19a records it: `valid_empty` proves the empty case; the dangerous case is the
**non-empty** one. A genuine match placed deliberately outside the old recency
window must be found. Carried here so it is not lost, though the candidate
predicate is Build 1.

---

## 8. Rollback

| Step | Rollback | Data risk |
|---|---|---|
| 1a app | Redeploy prior app | None — reads both shapes |
| 1b app | Redeploy 1a | **Completion capability is lost** until re-deployed; no data risk |
| 2 api schema | Leave tables; unread | **None — additive only** |
| 3 api writer | Redeploy step-2 API | Evaluations written meanwhile remain; append-only, nothing lost |
| 4 activation | **Not rolled back.** Correct by visible supersession (§2.3) | History is immutable by design |
| 5 api reader | Redeploy step-3 API | None — reader is pure (§4.2) |
| 6+ | Standard | — |

**Migration 137 is additive.** No column dropped, no data rewritten, no proof
evaluation backfilled. That is a deliberate constraint, not an accident.

**Step 4 is the one-way door.** Everything before it is reversible by redeploy;
everything after it inherits an activation that can only be corrected forward.
This is why steps 3 and 4 are separate, and why §6.2 aborts rather than
proceeds on a surprise.

**The audit makes rollback safer still:** zero attachments and zero evaluations
exist, so a step-3 rollback has essentially nothing to strand.

---

## 9. What this release does NOT do

```text
NO backfill of proof evaluations from any source
NO attachment rows manufactured from completion_photo
NO inference of completion time from created_at, updated_at,
   migration applied_at, commit time, or deploy time
NO fifth proof state         (unavailable is a rendering outcome, not a
                              stored proof state — §2.1 stores two values)
NO new writer emitting status='closed'
NO change to existing cascade behaviour on progress or attachment tables
NO Ask Spine work — Build 1 does not start
NO /version endpoint, NO connectionTimeoutMillis   (out of scope by instruction)
```

---

## 10. Open items to close during implementation

1. **The §5.0 evidence-source decision.** Owner, not engineering. Blocks step 1b
   only.
2. **`rule_version` value** — a stable identifier for the corrected
   classification array, cited by preserved verdicts.
3. **Obligation `type` vocabulary.** `proof_evaluation_missing` must be added to
   whatever closed set the obligation engine enforces.
4. **Sweep cadence and owner** for §4.2(b).

Only item 1 blocks scheduling. Items 2–4 are answerable by source reading and
none requires a production connection.

---

## 11. Classification (§18)

| # | Component | Class | Removal condition |
|---|---|---|---|
| 1 | App proof normalizer | 1 — permanent | Never. Single interpretation point for proof state. |
| 2 | `proof.satisfied` compatibility field | **3 — temporary** | Removed in a separate proven cleanup release after a repo-wide consumer search and a mismatch gate. §19 Ruling 2. |
| 3 | `work_order_proof_evaluations` | 1 — permanent | Never. |
| 4 | `work_order_proof_evaluation_attachments` | 1 — permanent | Never. |
| 5 | `release_0_activation_history` + current view | 1 — permanent | Never. Corrections supersede forward. |
| 6 | `release_0_legacy_cutover_inventory` | 1 — permanent | Never. Durable basis for legacy-vs-defect, not a migration artifact. |
| 7 | Legacy closeout **done-path** | **4 — retired** | Removed once the app no longer calls it and the 409 is browser-proven. The not-done path is Class 1 and stays. |
| 8 | `attachStubPhoto` / `woStubPhotos` (app) | **4 — retired** | Removed when a genuine evidence path exists. Must never feed a proof evaluation. |
| 9 | Defect-routing sweep | 1 — permanent | Never. |
| 10 | This plan | 1 — permanent record | Never. It is the reviewed design implementation is measured against. |
