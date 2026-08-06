# Release 0 — implementation and deployment plan

**Documentation only. Nothing in this plan has been implemented.**
**Gate: the exposed Neon credential must be rotated before implementation
begins** — see [`CREDENTIAL_ROTATION_RUNBOOK.md`](CREDENTIAL_ROTATION_RUNBOOK.md).

Governing rulings: [`ASK_SPINE_BUILD_CONTRACT.md`](ASK_SPINE_BUILD_CONTRACT.md)
§19 Rulings 1 and 2 (frozen), §19c Rulings A–D (frozen).
Factual basis: [`release-0-audit/RECEIPT.md`](release-0-audit/RECEIPT.md),
[`RELEASE_0_COMPLETION_WRITER_MATRIX.md`](RELEASE_0_COMPLETION_WRITER_MATRIX.md).

---

## 0. What the production facts change about this release

The audit makes this release far smaller than it looked, and the plan is sized
to the facts rather than to the fear.

```text
work orders relying on 'unclassified'      0   → no operator-visible flip
proof attachment rows                      0   → no evidence to reclassify
kind='completed' progress rows             0   → canonical writer never ran
status='complete' rows                     0
legacy cutover inventory population        1   one 'closed' row
```

**Consequences that shape every decision below:**

1. **The `unclassified` correction is a no-op on live data.** Zero rows change
   rendered state. The risk in this release is *not* the proof-array change.
2. **The real work is consolidation**, not correction: one canonical meaning of
   completion, one canonical proof path. §19c Rulings B and D.
3. **The legacy cutover inventory will contain exactly one row.** That makes it
   cheap to build and cheap to verify by hand — and it must still be built
   correctly, because it is the mechanism that distinguishes legacy from defect
   forever after, not just at cutover.
4. **Rollback is unusually safe.** With no attachments and no evaluations, there
   is nothing to un-write. The compatibility risk is entirely about response
   *shape*, which is why app-first is still mandatory.

**What has not changed:** §19 Ruling 1 still governs the activation instant. It
is **captured** at the writer's verified-live moment and persisted unchanged.
Nothing in the audit informs it.

---

## 1. Component classification (§18)

| # | Component | Repo | Class | Removal condition |
|---|---|---|---|---|
| 1 | App proof normalizer | app | 1 — permanent | Never. It is the single interpretation point for proof state. |
| 2 | `proof.satisfied` compatibility field | api | **3 — temporary** | Removed in a separate proven cleanup release after a repo-wide consumer search and a mismatch gate confirm nothing reads it. §19 Ruling 2. |
| 3 | `work_order_proof_evaluations` | api | 1 — permanent | Never. |
| 4 | `work_order_proof_evaluation_attachments` | api | 1 — permanent | Never. |
| 5 | `release_0_activation` (single immutable row) | api | 1 — permanent | Never. Correction supersedes visibly; the original stays readable. |
| 6 | `release_0_legacy_cutover_inventory` | api | 1 — permanent | Never. It is the durable basis for legacy-vs-defect forever, not a migration artifact. |
| 7 | Legacy closeout completion path | api | **4 — retired** | Removed once the app no longer calls it and the fail-closed response is browser-proven. |
| 8 | `missing_evaluation_defect` routing | api | 1 — permanent | Never. |

---

## 2. Schema

One migration, `137_release_0_proof_evaluations.sql`. **Not written yet.**

### 2.1 Proof evaluations — append-only

```text
work_order_proof_evaluations
  id                     uuid pk
  work_order_id          uuid not null
  property_id            uuid not null
  state                  text not null check in
                           ('satisfied','not_satisfied')
  evaluated_at           timestamptz not null default now()
  evaluated_by_user_id   uuid references users(id)       -- who
  evaluated_by_service   text not null                   -- or what
  superseded_by_id       uuid references
                           work_order_proof_evaluations(id)
  rule_version           text not null
  constraint fk_wope_work_scope
    foreign key (work_order_id, property_id)
    references work_orders (id, property_id) on delete cascade
```

Notes, each load-bearing:

- **`state` carries only the two computed values.** `legacy_indeterminate` and
  `missing_evaluation_defect` are *derived at read time* from the absence of a
  row plus inventory membership. Storing them would make a derived fact
  writable, and the inventory would stop being the authority.
- **Append-only.** A re-evaluation inserts a new row and sets `superseded_by_id`
  on the prior one. No `UPDATE` of a verdict, ever.
- **Composite FK** follows the precedent migration 134 already established and
  the audit confirmed present (`fk_wop_work_scope`, `fk_wopa_work_scope`,
  `uq_work_orders_id_property`).
- **`rule_version`** so a preserved verdict states the rule in force when it was
  made — the same discipline `work_completion_claims.proof_satisfied` already
  follows.

Partial unique index so at most one live evaluation exists per work order:

```sql
create unique index uq_wope_live
  on work_order_proof_evaluations (work_order_id, property_id)
  where superseded_by_id is null;
```

### 2.2 Evaluation → attachment links

FK-backed rows, **not an ID array** (§16):

```text
work_order_proof_evaluation_attachments
  evaluation_id   uuid not null references work_order_proof_evaluations(id)
  attachment_id   uuid not null references work_order_proof_attachments(id)
  primary key (evaluation_id, attachment_id)
```

### 2.3 Activation boundary — one row, immutably

```text
release_0_activation
  id                  boolean primary key default true check (id)   -- one row
  activated_at        timestamptz not null   -- the CAPTURED instant
  captured_at_step    text not null          -- 'writer_verified_live'
  recorded_at         timestamptz not null default now()
  superseded_by_id    uuid                   -- visible correction only
```

`id boolean primary key check (id)` makes a second row **unrepresentable**, in
the manner of migration 136 — §19 Ruling 1 requires a schema obligation, not a
convention. `activated_at` is the instant captured at step 3 of the release
order; `recorded_at` is when the row was inserted. **They are different facts
and the gap between them is exactly what Ruling 1 exists to close.**

### 2.4 Legacy cutover inventory — immutable

```text
release_0_legacy_cutover_inventory
  work_order_id    uuid not null
  property_id      uuid not null
  status_at_cutover text not null            -- 'closed' | 'complete'
  had_column_photo  boolean not null
  had_column_note   boolean not null
  captured_at       timestamptz not null default now()
  primary key (work_order_id, property_id)
  constraint fk_r0lci_work_scope
    foreign key (work_order_id, property_id)
    references work_orders (id, property_id) on delete cascade
```

**Populated once, in the activation transaction, from the live table** — not
from a hand-written list and not from the audit receipt. The audit says it
should contain exactly one row; **the activation asserts that count rather than
assuming it**, and aborts on mismatch (§6.2).

`had_column_photo` / `had_column_note` record **presence only**, never contents
— the same distinction the audit's §5 enforced.

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
live evaluation row exists
  → state = that row's state           (satisfied | not_satisfied)

no live evaluation row
  AND (work_order_id, property_id) IS in the legacy cutover inventory
  → legacy_indeterminate

no live evaluation row
  AND NOT in the inventory
  AND the work order is terminal
  → missing_evaluation_defect

not terminal
  → proof is not yet due; state reflects current evidence, not a defect
```

**Terminal** means `status = 'complete'`, or `status = 'closed'` for an
inventoried row (§19c Ruling B). No other status is terminal.

**No timestamp comparison appears anywhere in this derivation.** Inventory
membership is the discriminator. That is what closes the `completed_at` gap
without inventing a fifth state.

### 3.3 Both shapes carry `state`

§19 Ruling 2 raised this and it is binding: `readPropertyWorkOrderStatuses`
returns a subset, and the board renders from it. Both carry `state`:

```text
detail   proof: { required, state, satisfied, preserved_count,
                  not_preserved_count, attachments[],
                  legacy_evidence: { column_photo_present,
                                     column_note_present } }
list     proof: { required, state, satisfied, not_preserved_count,
                  legacy_evidence: { column_photo_present,
                                     column_note_present } }
```

`legacy_evidence` carries **presence booleans only** (§19c Ruling C) — never
the column contents, and never promoted to `satisfied`.

### 3.4 Compatibility mapping — frozen

```text
satisfied                  → satisfied = true
not_satisfied              → satisfied = false
legacy_indeterminate       → satisfied = null
missing_evaluation_defect  → satisfied = null
```

`null` is deliberate. Legacy and writer-defect **may not be collapsed into
"proof failed."**

---

## 4. Canonical completion writer

`claimCompletion` becomes the one completion service (§19c Ruling D). In **one
transaction**:

```text
1  the completion claim
2  evaluate preserved evidence against the corrected classification array
3  insert the proof evaluation  (+ supersede any prior live row)
4  insert evaluation → attachment links
5  status = 'complete'
6  append the distinct `completed` progress event
7  close the owning obligation
8  write the action receipt
```

All eight or none. A partial write is the confident-wrong this release exists
to remove.

### 4.1 Retiring the legacy closeout route

Order is binding — **app first**:

```text
1  App stops calling PATCH /work-orders/:id/closeout for completion.
2  Prove in the browser that no completion path reaches it.
3  API done-path fails closed:
     409, naming the canonical path, writing nothing.
4  Route removed in a later cleanup release once step 3 is proven.
```

**A non-empty `completion_photo` string may never be converted into valid
proof** — not by the route, not by a shim, not by a migration.

### 4.2 `missing_evaluation_defect` destination

§19 Ruling 2 requires this decided before the state can be emitted. **It raises
an obligation** through the existing canonical obligation engine:

```text
module         maintenance
type           proof_evaluation_missing
owner          property_manager
severity       normal
related_type   work_order
related_id     the work order
```

An obligation, not an alert, because the obligation rail is the accountability
primitive this codebase already has, it appears on surfaces operators already
read, and it closes through a governed service. **A fault with no route to
whoever can fix it renders forever and nobody acts.** Expected production
volume at activation: zero.

---

## 5. Cross-repo deployment sequence

**App-first is mandatory** (§19 Ruling 2). The new API *requires* the
compatibility app; the new app runs against either API shape.

```text
STEP 1   APP — compatibility release
         · one proof normalizer, no surface interprets the response itself
         · accepts BOTH the current boolean-only shape and the new
           state-plus-boolean shape
         · unknown state, missing field, or state/boolean mismatch
           → CONTRACT FAILURE → renders "proof state unavailable"
             NEVER not_satisfied, never legacy, never empty
         · stops calling the legacy closeout completion path
         DEPLOY. VERIFY IN PRODUCTION AGAINST THE OLD API.

STEP 2   API — schema only
         · migration 137: evaluations, links, activation table,
           cutover inventory
         · NO reader change, NO writer change yet
         · ledger verify gate must pass (EXPECTED_LEDGER_CEILING=136)
         DEPLOY. Ledger ceiling becomes 137.

STEP 3   API — writer and reader
         · claimCompletion writes the evaluation transactionally
         · reader emits proof.state on BOTH shapes
         · legacy closeout done-path fails closed
         DEPLOY. VERIFY THE WRITER IS LIVE.
         ⚠ CAPTURE THE VERIFIED-LIVE INSTANT HERE. This exact timestamp
           is the activation boundary.

STEP 4   API — activation transaction
         · persist the captured instant from step 3 (NOT now())
         · populate the legacy cutover inventory from the live table
         · both in ONE transaction
         RUN ONCE.

STEP 5   Browser verification — §17 acceptance list.

STEP 6   APP — consumer proof release
         · prove every consumer uses the shared normalizer

STEP 7   Separate cleanup release
         · remove proof.satisfied after a repo-wide consumer search
           and a mismatch gate
         · remove the legacy closeout route
```

**Steps 3 and 4 are separate deploys and the gap between them is the hazard
Ruling 1 names.** Step 4 persists the instant captured at step 3, never
`now()`, so a completion landing in the gap cannot be absorbed into legacy.

### 5.1 SHA pair requirements

The release packet names the compatible pair explicitly:

```text
APP  <compatibility release SHA>   REQUIRED by the step-3 API
API  <step-3 SHA>                  REQUIRES the compatibility app
```

**Rolling the app back behind the compatibility release requires rolling the
API back as well.**

---

## 6. Activation transaction

```sql
begin;

insert into release_0_activation (activated_at, captured_at_step)
values ($1, 'writer_verified_live');     -- $1 CAPTURED at step 3

insert into release_0_legacy_cutover_inventory
  (work_order_id, property_id, status_at_cutover,
   had_column_photo, had_column_note)
select w.id, w.property_id, w.status,
       (w.completion_photo is not null),
       (w.completion_note  is not null)
  from work_orders w
  left join work_order_proof_evaluations e
    on e.work_order_id = w.id
   and e.property_id   = w.property_id
   and e.superseded_by_id is null
 where w.status in ('complete','closed')
   and e.id is null;

commit;
```

### 6.1 `$1` is captured, never `now()`

Under §19 Ruling 1 the boundary is the instant the writer was **verified live**
at step 3. Using the insertion time would reopen the exact gap the ruling
closes. **This is the single most important line in the release.**

### 6.2 The activation asserts rather than assumes

Before commit, the transaction asserts the inventory count against the expected
figure and **aborts on mismatch**:

```text
expected inventory rows   1     (production audit, receipt §5.4)
```

If production has moved since the audit, that is a fact worth stopping for, not
worth absorbing silently. The expected count is supplied explicitly at run time
— in the manner of `EXPECTED_LEDGER_CEILING`, which already refuses to run for
someone who has not looked.

### 6.3 Idempotency

`release_0_activation`'s single-row constraint makes a second activation fail at
the database. The inventory's primary key makes a re-run insert nothing new.
**Re-running the activation is safe and provably a no-op.**

---

## 7. Acceptance

### 7.1 Real Postgres

```text
unclassified alone                  → not_satisfied      (was satisfied)
repair_photo stored                 → satisfied
condition stored                    → satisfied
unclassified + repair_photo         → satisfied
referenced, never stored            → not_satisfied
terminal, no evaluation, inventoried→ legacy_indeterminate
terminal, no evaluation, NOT invtd  → missing_evaluation_defect
non-terminal, no evaluation         → NEITHER legacy NOR defect
re-evaluation                       → new row; prior gets superseded_by_id
                                      uq_wope_live still satisfied
second activation row               → REFUSED by the database
activation re-run                   → no-op, exit clean
inventory count mismatch            → activation ABORTS
claimCompletion partial failure     → whole transaction rolls back;
                                      no orphan evaluation, no status change
```

Isolated Postgres only — never a `.db.js` harness against production
(`DB_HARNESS_ISOLATION.md`).

### 7.2 Real HTTP

```text
detail response carries proof.state
list   response carries proof.state
state/boolean mapping matches the frozen table on BOTH shapes
legacy closeout done-path returns 409 and writes nothing
```

### 7.3 Browser — §17, the operator's own path

```text
sign in → Property Home → Work Orders → open a job → read the proof state
```

Required cases:

```text
legacy_indeterminate renders AS legacy, with column evidence as context
  and NOT as satisfied
missing_evaluation_defect renders VISUALLY DISTINCT from ordinary
  missing proof, and raises its obligation
unclassified does not satisfy proof
contract failure renders "unavailable", never not_satisfied
list and detail AGREE on state for the same work order
completion through the canonical path writes all eight facts
the legacy closeout path is unreachable from the UI
```

**Presence is not visibility.** Assertions measure
`getComputedStyle().display` and a bounding box, not `querySelector` — the
lanes-hidden defect proved that the hard way.

**The proof enters the way the operator enters.** No test may call a module
function directly to reach the surface under test.

### 7.4 The regression the acceptance list was missing

§19a records it: `valid_empty` proves the empty case; the dangerous case is the
**non-empty** one. A genuine match placed deliberately outside the old recency
window must be found. Carried here so it is not lost, though the candidate
predicate itself is Build 1.

---

## 8. Rollback

| Step | Rollback | Data risk |
|---|---|---|
| 1 app | Redeploy prior app | None — reads both shapes |
| 2 api schema | Leave tables in place; unread | **None — additive only** |
| 3 api writer/reader | Redeploy step-2 API | Evaluations written meanwhile remain; append-only, so nothing is lost |
| 4 activation | **Not rolled back.** Correct by visible supersession | The row is immutable by design |
| 5+ | Standard | — |

**Migration 137 is additive.** No column is dropped, no data rewritten, no
proof evaluation backfilled. That is what makes rollback cheap, and it is a
deliberate constraint on the migration, not a happy accident.

**The audit makes rollback safer still:** zero attachments and zero evaluations
exist, so a step-3 rollback has essentially nothing to strand.

---

## 9. What this release does NOT do

```text
NO backfill of proof evaluations from any source
NO attachment rows manufactured from completion_photo
NO inference of completion time from created_at, updated_at,
   migration applied_at, commit time, or deploy time
NO fifth proof state
NO new writer emitting status='closed'
NO Ask Spine work — Build 1 does not start
NO /version endpoint, NO connectionTimeoutMillis   (out of scope by instruction)
```

---

## 10. Open items to close during implementation

1. **`rule_version` value.** A stable identifier for the corrected
   classification array, referenced by preserved verdicts.
2. **Does the app currently call the legacy closeout path?** The writer matrix
   established the API side. The app side needs the same treatment before
   step 1 can be scoped.
3. **Obligation `type` string** for `proof_evaluation_missing` must be added to
   whatever closed vocabulary the obligation engine enforces.

None blocks the plan's shape. All three are answerable by source reading, and
none requires a production connection.

---

## 11. Classification (§18)

| Component | Class | Removal condition |
|---|---|---|
| This plan | 1 — permanent record | Never removed. It is the reviewed design the implementation is measured against. |
