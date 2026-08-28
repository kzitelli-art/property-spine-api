# Release 0 — implementation and deployment plan

**Revision 4 — external review applied: closed-row defect visibility corrected,
guards hardened, two pre-deploy proofs added.**
**Documentation only. Nothing in this plan has been implemented.**

Governing rulings: [`ASK_SPINE_BUILD_CONTRACT.md`](ASK_SPINE_BUILD_CONTRACT.md)
§19 Rulings 1 and 2 (frozen), §19c Rulings A–D (frozen), §5.0 below (Option A,
ruled).
Factual basis: [`release-0-audit/RECEIPT.md`](release-0-audit/RECEIPT.md),
[`RELEASE_0_COMPLETION_WRITER_MATRIX.md`](RELEASE_0_COMPLETION_WRITER_MATRIX.md),
[`RELEASE_0_APP_CLOSEOUT_AUDIT.md`](RELEASE_0_APP_CLOSEOUT_AUDIT.md).

> ## ARCHITECTURE FROZEN — 2026-08-06
>
> Accepted and frozen at **`4f25f73408d90376f45ea0cf501ddebc7bbff131`**.
> Gate 1 is CLOSED. **Do not revise the architecture further unless
> implementation reveals a factual contradiction.**
>
> This banner and the gate statuses below are the only things added after the
> freeze. No schema, sequence, rollback or acceptance section changed —
> verify with `git diff 4f25f73..HEAD -- docs/RELEASE_0_IMPLEMENTATION_PLAN.md`.

## Gates before implementation or merge

```text
1  chain-integrity guard reviewed                       CLOSED 2026-08-06
2  the exposed Neon credential rotated                  CLOSED 2026-08-06
3  the old credential proven dead                       CLOSED 2026-08-06
     28P01 refusal of the ACTUAL leaked credential, tested from outside the
     production runtime. Receipt: CREDENTIAL_ROTATION_RUNBOOK.md §4.
4  the SMS technician evidence and completion path
   phone-verified                                       OPEN — release step 4
```

**Gates 1–3 are closed. Implementation may proceed from deployment step 1.**
Gate 4 is a release-step condition: it precedes removal of the legacy
completion control (step 5) and everything after it.

Two additional pre-deploy proofs were added on external review and are NOT
optional (§5.3, §7.6):

```text
·  SMS ingress preflight        before step 2
·  scale and concurrency proof  before migration 137 is applied
```

---

## 0. Revision history

**Revision 2** closed eight design-review findings. **Revision 3** applies the
owner's evidence-source ruling and five final corrections:

| # | Correction | Closed in |
|---|---|---|
| A | Option A ruled — the technician SMS lane is the canonical evidence source | §5.0 |
| 1 | `unavailable` is **not** a fifth `proof.state`; the *read* is unavailable | §3.2.1, §3.3, §3.4 |
| 2 | Supersession is scoped, single-genesis, single-successor, head-only | §2.1, §2.3 |
| 3 | Defect-obligation lifecycle defined end to end | §4.2 |
| 4 | Sequence reordered: activation captured only after the legacy writer is dead | §5.1 |
| 5 | A fresh authorized pre-cutover census supplies the expected set | §6.2 |
| 6 | Insert-time chain guards — rooted, acyclic, no self-supersession | §2.1.1, §2.3.1 |

**Revision 4** applies an external design review:

| # | Correction | Closed in |
|---|---|---|
| 7 | **Non-inventoried `closed` rows escaped defect detection** — a factual contradiction | §3.2.0 |
| 8 | Trigger hardening: schema qualification, `search_path`, owner-role caveat | §2.1.2 |
| 9 | Normalizer: supporting fields are facts, not defaults | app `proof-normalizer.js` |
| 10 | SMS ingress preflight before step 2, splitting the biggest unknown forward | §5.3 |
| 11 | Legacy-writer-death proof before capturing the activation instant | §5.4 |
| 12 | Scale and concurrency proof before migration 137 | §7.6 |
| 13 | Verification binding rules — every proof binds artifact, input and environment | §7.7 |

**Revision 5** applies the owner ruling issued after the step 1 production
acceptance, which established a production baseline fact the earlier revisions
assumed the opposite of:

| # | Correction | Closed in |
|---|---|---|
| 14 | **The legacy operator completion path was ALREADY unreachable before Release 0.** Step 5 was sequenced to prevent a future state that is already the present one. | §1.1, §5.5 |
| 15 | Step 5 redefined: it retires unreachable code and fails the API path closed. It does **not** protect an operator who is already stranded. | §5.1, §5.5 |
| 16 | **New production gate** — no Release 0 production schema or API mutation may begin until SMS transport is configured and real-handset evidence ingress is proven. | §5.6 |
| 17 | Step 1 acceptance contract corrected: the two visibility checks were invalid requirements, not failed behaviour. | app packet §9.15 |

---

## 1.1 ⛔ PRODUCTION BASELINE — THERE IS NO USABLE COMPLETION PATH TODAY

Established by the step 1 production acceptance, 2026-08-06. Recorded plainly
because two later steps were designed around its opposite.

```text
legacy operator completion   ALREADY UNREACHABLE, and unreachable at the
                             step 1 BASE — not caused by Release 0
SMS technician rail          NO CONFIGURED TRANSPORT — no operations line,
                             provider_config null on the only line that exists
                             ─────────────────────────────────────────────
result                       PRODUCTION HAS NO USABLE COMPLETION PATH
```

**The operator is already stranded.** That is the baseline, not a risk to be
managed.

Evidence: `property-spine-app` `docs/RELEASE_0_STEP_1_PACKET.md` §9.14 — the
handlers, `openMaintenanceModule` and the call-site inventory are each
byte-identical to base `6220ca5`, and every route into the legacy closeout is
circular. Transport: `docs/RELEASE_0_SMS_PREREQUISITE.md`.

### 1.1.1 Why the old control is NOT being reconnected

Restoring it would deliberately reconnect a known-invalid writer that:

```text
writes status = closed
does NOT write the canonical completion event
accepts fabricated stub:// evidence
disagrees with the canonical reader
```

**We do not reintroduce a defective completion rail to make an earlier
sequencing assumption appear true.** The containment decision stands: the
technician SMS lane is the canonical evidence and completion source; the
operator app reads and reviews; the operator app does not declare repair
completion.

### 1.1.2 What is NOT ruled here

This is a **Release 0 containment decision, not a permanent product doctrine.**
It does not declare operator completion authority abolished. A future governed
operator or manager acceptance surface may be right for vendor work, SMS
outages, supervisory inspection or higher-risk clearance — distinguishing who
may report completion, who may provide evidence, who may accept the work, who
remains accountable, and who grants final clearance.

**That is a later product ruling. Do not invent that surface inside Release 0.**
Complete the one canonical technician rail first.

---

## 1. What the production facts change

```text
work orders relying on 'unclassified'      0   → no operator-visible flip
proof attachment rows                      0   → no evidence to reclassify
kind='completed' progress rows             0   → canonical writer never ran
status='complete' rows                     0
terminal rows without an evaluation        1   as of the 2026-08-06 audit
```

1. **The `unclassified` correction is a no-op on live data.** The risk is not
   the proof-array change.
2. **The real work is consolidation** — one canonical meaning of completion, one
   canonical proof path.
3. **Rollback is unusually safe.** Nothing to un-write.
4. **The August 6 figures are historical evidence, not the deployment-time
   expected set.** §6.2.

§19 Ruling 1 still governs the activation instant: **captured**, persisted
unchanged, never derived from production data.

---

## 2. Schema

One additive migration, `137_release_0_proof_evaluations.sql`. **Not written.**

### 2.1 Proof evaluations — append-only, scoped, single linear chain

```text
work_order_proof_evaluations
  id                     uuid primary key default gen_random_uuid()
  work_order_id          uuid not null
  property_id            uuid not null
  state                  text not null check (state in ('satisfied','not_satisfied'))
  evaluated_at           timestamptz not null default now()
  evaluated_by_user_id   uuid references users(id)
  evaluated_by_service   text not null
  rule_version           text not null
  supersedes_id          uuid
  created_at             timestamptz not null default now()

  unique (id, work_order_id, property_id)

  constraint fk_wope_work_scope
    foreign key (work_order_id, property_id)
    references work_orders (id, property_id) on delete restrict

  --  COMPOSITE SELF-FK: a chain may never cross work orders or properties.
  constraint fk_wope_supersedes_scope
    foreign key (supersedes_id, work_order_id, property_id)
    references work_order_proof_evaluations (id, work_order_id, property_id)
    on delete restrict
```

Three indexes carry the chain discipline. **None of them is advisory.**

```sql
-- ONE GENESIS per work order/property.
create unique index uq_wope_genesis
  on work_order_proof_evaluations (work_order_id, property_id)
  where supersedes_id is null;

-- AT MOST ONE SUCCESSOR per evaluation. No forks.
create unique index uq_wope_one_successor
  on work_order_proof_evaluations (supersedes_id)
  where supersedes_id is not null;

create index idx_wope_scope on work_order_proof_evaluations (work_order_id, property_id);
```

**How "must supersede the current head" is enforced.** It falls out of
`uq_wope_one_successor` rather than needing its own rule: any row that is not
the head already *has* a successor, so an attempt to supersede it violates that
index.

#### 2.1.1 The indexes alone are not sufficient — the insert guard *(correction 6)*

The three indexes prove *at most* one genesis, *at most* one successor, and no
cross-scope link. **They do not prove that every component is a rooted acyclic
chain with exactly one head.** Four states survive them:

```text
a  a row supersedes itself         A.supersedes_id = A.id
b  a two-cycle                     A → B and B → A
c  a component with NO genesis     every cycle has none
d  a component with NO head        every cycle has none
```

`uq_wope_genesis` permits *at most* one genesis — **zero is also permitted**, so
a pure cycle satisfies it. In a two-cycle each row is superseded exactly once,
so `uq_wope_one_successor` is satisfied. The composite self-FK is satisfied
because both rows share a scope. Self-supersession survives because a
self-referencing FK is checked once the row has landed.

A `BEFORE INSERT` guard closes all four.

```sql
create or replace function wope_chain_guard() returns trigger as $$
declare
  pred  work_order_proof_evaluations%rowtype;
  walk  uuid;
  hops  int := 0;
begin
  -- 1. NO SELF-SUPERSESSION
  if NEW.supersedes_id is not null and NEW.supersedes_id = NEW.id then
    raise exception 'evaluation % may not supersede itself', NEW.id;
  end if;

  -- 2. GENESIS — permitted only when the scope is empty
  if NEW.supersedes_id is null then
    perform 1 from work_order_proof_evaluations
      where work_order_id = NEW.work_order_id
        and property_id   = NEW.property_id
      limit 1;
    if found then
      raise exception 'genesis refused: evaluations already exist for (%, %)',
        NEW.work_order_id, NEW.property_id;
    end if;
    return NEW;
  end if;

  -- 3. SUPERSEDING INSERTION
  --    LOCK the predecessor FIRST, so two concurrent successors serialize
  --    here rather than racing to the unique index.
  select * into pred
    from work_order_proof_evaluations
   where id = NEW.supersedes_id
     for update;

  if not found then
    raise exception 'predecessor % does not exist', NEW.supersedes_id;
  end if;

  if pred.work_order_id <> NEW.work_order_id
     or pred.property_id <> NEW.property_id then
    raise exception 'cross-scope supersession refused';
  end if;

  perform 1 from work_order_proof_evaluations
    where supersedes_id = pred.id limit 1;
  if found then
    raise exception 'predecessor % is not the head', pred.id;
  end if;

  -- 4. CYCLE REJECTION — walk back from the predecessor to a genesis.
  --    The walk must terminate at supersedes_id IS NULL and must never
  --    encounter NEW.id.
  walk := pred.id;
  loop
    if walk = NEW.id then
      raise exception 'cycle refused: % is its own ancestor', NEW.id;
    end if;
    select supersedes_id into walk
      from work_order_proof_evaluations where id = walk;
    exit when walk is null;
    hops := hops + 1;
    if hops > 10000 then
      raise exception 'chain walk exceeded bound — chain is corrupt';
    end if;
  end loop;

  return NEW;
end $$ language plpgsql;

create trigger chain_guard_wope
  before insert on work_order_proof_evaluations
  for each row execute function wope_chain_guard();
```

**Why the backward walk is the whole proof.** It establishes that the
predecessor's component is *already* rooted and acyclic before the new row
attaches. Attaching a fresh row to the head of a rooted acyclic chain yields a
rooted acyclic chain. Since `UPDATE` and `DELETE` are refused by the §2.1
triggers, **`INSERT` is the only operation that can change the graph** — so the
invariant is inductive and holds for all time. The hop bound is the
belt-and-braces case: if a chain were somehow already corrupt, the walk fails
loudly rather than spinning.

#### 2.1.2 Implementation requirements for both guards *(external review)*

Binding on `wope_chain_guard` and `r0ah_chain_guard` alike:

```text
·  SCHEMA-QUALIFY every table and function reference. PostgreSQL resolves
   unqualified names through search_path, so an unqualified trigger body can
   be pointed at a different table by whoever controls that setting.
·  SET a controlled search_path on each function
     ALTER FUNCTION … SET search_path = public, pg_temp;
·  Partial unique indexes stay NON-DEFERRABLE. A deferred race check that
   fires at commit is not a race check.
·  Keep the REAL concurrent-insert tests (§7.1). Two sessions, actual
   contention — not two sequential inserts pretending to be concurrent.
·  Run migration tests at the SAME isolation level production uses.
```

**A caveat that must be documented rather than assumed away.** The application
connects as the table-owning role, and **a table owner can disable or drop its
own triggers.** So "immutable" here means *enforced against normal DML*, not
*unalterable by the runtime role*. That does not block Release 0 — nothing in
the application disables triggers — but the guarantee should not be overstated
in any receipt.

A later database-security slice, explicitly **out of Release 0 scope**, should
separate:

```text
migration / ownership role
runtime application role
read-only audit role
```

Until then, immutability is a property of the application's behaviour plus the
triggers, not of the role model.

#### 2.1.3 On the backward walk

External review notes the walk is more defensive than strictly necessary once
the predecessor must exist, self-supersession is refused, rows cannot be
updated, and only the head may be superseded — under those conditions a new row
can only point backward into an existing chain.

**It stays.** It costs one indexed walk per supersession on a chain that is
almost always length one, and it is the only check that would detect an
already-corrupt chain rather than extending it. It is corruption detection, not
insertion logic.

**The trigger and the indexes do different jobs, and neither replaces the
other:**

```text
trigger    proves valid rooted, acyclic insertion
indexes    prevent concurrent genesis and successor races
```

Two transactions inserting a genesis for the same scope both pass the trigger's
emptiness check before either commits; `uq_wope_genesis` refuses the second.
Two transactions superseding the same head serialize on the `FOR UPDATE` lock —
the second then sees a successor and refuses — with `uq_wope_one_successor` as
the backstop if that lock is ever bypassed.

**The head is the one unsuperseded row**, not the highest sequence number.
Revision 2 read "highest `evaluation_seq`", which is only equivalent to the head
if the chain is guaranteed linear — and revision 2 did not guarantee it. The
sequence column is dropped; ordering is no longer load-bearing.

```sql
create view work_order_proof_evaluation_head as
  select e.* from work_order_proof_evaluations e
   where not exists (
     select 1 from work_order_proof_evaluations s
      where s.supersedes_id = e.id);
```

- **`supersedes_id` points backwards**, so the older row is never touched.
- **`state` carries only the two computed values.** `legacy_indeterminate` and
  `missing_evaluation_defect` are derived at read time (§3.2). Storing them
  would make a derived fact writable and the inventory would stop being the
  authority.

Immutability enforced by the database, not by convention:

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

A trigger rather than a `REVOKE`, because `REVOKE` does not bind the owner role
and the production audit established the application connects as `neondb_owner`.

### 2.2 Evaluation → attachment links — fully scoped

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

Requires one additive unique constraint so the attachment table can be
referenced that way:

```sql
alter table work_order_proof_attachments
  add constraint uq_wopa_id_scope unique (id, work_order_id, property_id);
```

**A cross-work-order or cross-property link is unrepresentable.** Same
append-only triggers as §2.1.

### 2.3 Activation history — one genesis, no forks, head-only correction

```text
release_0_activation_history
  id                 uuid primary key default gen_random_uuid()
  activated_at       timestamptz not null    -- the CAPTURED instant (§6.1)
  captured_at_step   text not null           -- 'legacy_writer_dead_and_canonical_live'
  captured_by        text not null
  supersedes_id      uuid references release_0_activation_history(id)
  reason             text
  recorded_at        timestamptz not null default now()

  constraint ck_r0ah_supersede_has_reason
    check (supersedes_id is null or reason is not null)
```

```sql
-- ONE genesis activation, ever.
create unique index uq_r0ah_genesis
  on release_0_activation_history ((true))
  where supersedes_id is null;

-- AT MOST ONE successor. No forks. A correction must supersede the head.
create unique index uq_r0ah_one_successor
  on release_0_activation_history (supersedes_id)
  where supersedes_id is not null;

create view release_0_activation_current as
  select a.* from release_0_activation_history a
   where not exists (
     select 1 from release_0_activation_history s
      where s.supersedes_id = a.id);
```

Same discipline as §2.1, same reason: the head is **derived from the chain**,
never marked by a mutable column and never inferred from ordering. A correction
is a new row citing the head, with a required reason; the original stays
readable permanently. Append-only triggers as §2.1.

#### 2.3.1 Activation insert guard *(correction 6)*

The same four holes exist here and are closed the same way. The scope is the
whole table rather than a work order, so "genesis is permitted only when the
table is empty" replaces the per-scope emptiness check.

```sql
create or replace function r0ah_chain_guard() returns trigger as $$
declare
  head  release_0_activation_history%rowtype;
  walk  uuid;
  hops  int := 0;
begin
  -- 1. NO SELF-SUPERSESSION
  if NEW.supersedes_id is not null and NEW.supersedes_id = NEW.id then
    raise exception 'activation % may not supersede itself', NEW.id;
  end if;

  -- 2. GENESIS — permitted only when activation history is EMPTY
  if NEW.supersedes_id is null then
    perform 1 from release_0_activation_history limit 1;
    if found then
      raise exception 'genesis refused: activation history is not empty';
    end if;
    return NEW;
  end if;

  -- 5. A CORRECTION REQUIRES A NON-EMPTY REASON
  --    (the CHECK constraint forbids NULL; this forbids whitespace too)
  if NEW.reason is null or btrim(NEW.reason) = '' then
    raise exception 'a superseding activation requires a non-empty reason';
  end if;

  -- 3 + 4. IT MUST CITE THE CURRENTLY VISIBLE HEAD, AND THE HEAD IS LOCKED
  select * into head
    from release_0_activation_history
   where id = NEW.supersedes_id
     for update;

  if not found then
    raise exception 'cited activation % does not exist', NEW.supersedes_id;
  end if;

  perform 1 from release_0_activation_history
    where supersedes_id = head.id limit 1;
  if found then
    raise exception 'activation % is not the current head', head.id;
  end if;

  -- 6. CYCLE REJECTION
  walk := head.id;
  loop
    if walk = NEW.id then
      raise exception 'cycle refused: % is its own ancestor', NEW.id;
    end if;
    select supersedes_id into walk
      from release_0_activation_history where id = walk;
    exit when walk is null;
    hops := hops + 1;
    if hops > 10000 then
      raise exception 'chain walk exceeded bound — chain is corrupt';
    end if;
  end loop;

  return NEW;
end $$ language plpgsql;

create trigger chain_guard_r0ah
  before insert on release_0_activation_history
  for each row execute function r0ah_chain_guard();
```

`uq_r0ah_genesis` and `uq_r0ah_one_successor` are retained as **concurrency
backstops**, exactly as in §2.1.1 — the trigger proves the shape, the indexes
win the race.

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
from a hand-written list and never from a stored receipt.

`had_column_photo` / `had_column_note` record **presence only**. Per
`RELEASE_0_APP_CLOSEOUT_AUDIT.md` §3 the app's only writer of that column emits
a `stub://` string with no bytes, so presence is all the column can honestly
support. Append-only triggers as §2.1.

### 2.5 Nothing permanent may be deleted

```text
work_order_proof_evaluations               on delete RESTRICT
work_order_proof_evaluation_attachments    on delete RESTRICT  (both FKs)
release_0_legacy_cutover_inventory         on delete RESTRICT
```

Plus `before delete` triggers on all four tables. The FK protects the parent;
the trigger protects the row. **Both, because they fail differently.**

A work order carrying an evaluation or an inventory row can no longer be
deleted. That is intended. Existing `cascade` relationships on
`work_order_progress` and `work_order_proof_attachments` are **not changed by
this migration.**

---

## 3. Read model

One canonical derivation, in `work_order_status_read.js`. **The reader writes
nothing, ever** (§4.2).

### 3.1 The corrected classification array

```js
// was: ["repair_photo", "condition", "unclassified"]
const PROOF_REQUIRED_CLASSIFICATIONS = ["repair_photo", "condition"];
```

Production impact: **zero rows** (audit B2 = 0).

### 3.2 Deriving `proof.state`

```text
live evaluation head exists
  → state = that row's state           (satisfied | not_satisfied)

no evaluation head
  AND terminal
  AND (work_order_id, property_id) IS in the cutover inventory
  → legacy_indeterminate

no evaluation head
  AND terminal
  AND NOT in the inventory
  → missing_evaluation_defect

not terminal
  → proof is not yet due; reflects current evidence, never a defect
```

#### 3.2.0 Terminality and legitimacy are two different questions *(correction 7)*

**TERMINAL, for defect detection:**

```sql
status in ('complete', 'closed')
```

**LEGITIMATE HISTORICAL CLOSED:**

```sql
status = 'closed' AND present in the cutover inventory
```

Revision 3 defined terminal as *"`complete`, or `closed` **for an inventoried
row**"*, and that was a factual contradiction with §19c Ruling B. It left a hole:

```text
status   = 'closed'
NOT in the inventory
no evaluation
  → not "terminal" under the old definition
  → escapes missing_evaluation_defect
  → escapes the defect sweep
  → falls back toward the same scheduled/unstarted rendering that
    caused Release 0 in the first place
```

That is precisely the row a surviving legacy writer or an in-flight request
would create after activation — the case the release exists to catch, silently
exempted by the definition meant to catch it.

**Inventory membership decides whether a `closed` row is legitimate legacy
history. It does not decide whether a `closed` row is visible to defect
detection.** Every `closed` row is terminal; only inventoried ones are legacy.

```text
closed + inventoried     + no evaluation → legacy_indeterminate
closed + NOT inventoried + no evaluation → missing_evaluation_defect
```

The same predicate governs the §4.2 defect sweep, so the reader and the sweep
cannot disagree about which rows are visible.

**No timestamp comparison appears anywhere.** Inventory membership is the
legitimacy discriminator, which closes the missing-`completed_at` gap without a
fifth state.

### 3.2.1 An unavailable activation authority makes the READ unavailable, not the state

**`unavailable` is not a `proof.state`.** Revision 2 emitted
`proof.state = "unavailable"`, which would have opened the four-state contract
to a fifth value and forced every consumer to handle it as a proof condition.
It is not a proof condition — it is the read failing.

When the activation authority is absent, the derivation **cannot run**: the
inventory that separates legacy from defect has not been written. The reader
reports that the proof read did not complete, and **omits `state` entirely**:

```text
proof: { required: true, read_status: "unavailable", reason_code: "activation_absent" }
        — no `state` key, no `satisfied` key
```

```text
read_status = "ok"           → `state` present, one of the four values
read_status = "unavailable"  → `state` and `satisfied` ABSENT
```

`proof.state`, **when present, is limited to exactly four values**:

```text
satisfied · not_satisfied · legacy_indeterminate · missing_evaluation_defect
```

It must not fall back to `missing_evaluation_defect`. That would raise a
writer-defect on every terminal work order the moment the reader shipped.
§5.1 sequences the reader after activation so the case does not arise; this is
the safety net, not the plan.

### 3.3 Both shapes carry `state`

§19 Ruling 2 requires it: the board renders from the list subset, so if only the
detail carried `state` the two surfaces would disagree on precisely the states
the ruling exists to distinguish.

```text
detail   proof: { required, read_status, state?, satisfied?, preserved_count,
                  not_preserved_count, attachments[],
                  legacy_evidence: { column_photo_present, column_note_present } }
list     proof: { required, read_status, state?, satisfied?, not_preserved_count,
                  legacy_evidence: { column_photo_present, column_note_present } }
```

`legacy_evidence` carries **presence booleans only** (§19c Ruling C).

### 3.4 Compatibility mapping — frozen, four states only

```text
read_status = "ok"
  satisfied                  → satisfied = true
  not_satisfied              → satisfied = false
  legacy_indeterminate       → satisfied = null
  missing_evaluation_defect  → satisfied = null

read_status = "unavailable"
  state and satisfied are BOTH ABSENT
```

`null` is deliberate. Legacy and writer-defect **may not be collapsed into
"proof failed."**

**App normalizer contract:**

```text
read_status = "unavailable"        → render "proof state unavailable"
                                     EXPECTED condition, not an error
state present but not one of four  → CONTRACT FAILURE → also renders
                                     unavailable, but logged as a defect
state absent while read_status="ok"→ CONTRACT FAILURE
state/satisfied mismatch           → CONTRACT FAILURE
```

A contract failure and a legitimate unavailability render the same to the
operator and are **distinguished in the log**, because one is a bug and the
other is a known state.

---

## 4. Canonical completion writer

`claimCompletion` is the one completion service (§19c Ruling D). In **one
transaction**:

```text
1  the completion claim
2  evaluate preserved evidence against the corrected classification array
3  insert the proof evaluation
     · genesis if none exists; otherwise supersedes_id = the current head
     · a non-head supersession is refused by uq_wope_one_successor
4  insert evaluation → attachment links, fully scoped (§2.2)
5  status = 'complete'
6  append the distinct `completed` progress event
7  close the owning obligation
8  write the action receipt
```

All eight or none.

### 4.1 Retiring the legacy closeout done-path

**The route survives; its done-path does not.** `closeoutNotDone` shares the
route and is not a completion (`RELEASE_0_APP_CLOSEOUT_AUDIT.md` §1) — retiring
the route wholesale would take the follow-up lane with it.

**A non-empty `completion_photo` string may never be converted into valid
proof** — not by the route, not by a shim, not by a migration. Per the app
audit that string is a `stub://` URI with no bytes behind it.

Sequence in §5.1 steps 5–6.

### 4.2 `missing_evaluation_defect` — complete obligation lifecycle

**The reader is pure.** It computes and returns. It writes nothing, ever.
Revision 2's reader-side creation would have made every board render a write,
duplicated on refresh, and turned a GET into something that fails on a
read-only replica.

#### Canonical creation service

One service, `raiseProofEvaluationDefect(client, { work_order_id, property_id })`,
in the maintenance domain, writing through the existing
`spawnObligationFromEvent` engine. **No caller inserts the obligation directly.**

```text
module           maintenance
type             proof_evaluation_missing
owner_type       human
assigned_role    property_manager
escalates_to     asset_manager
status           open
priority         normal
severity         normal
related_type     work_order
related_id       the work order
required_inputs  ['proof_evaluation']
```

#### Invocation — exactly two callers

```text
a  claimCompletion, when it observes a terminal work order it did not just
   evaluate and which is absent from the cutover inventory;

b  a scheduled sweep on the existing followups rail — the same cadence
   run_followups.js already uses. It scans work orders with
   status in ('complete','closed') that have no evaluation head and no
   cutover-inventory row, and calls the same service.

   THE SWEEP AND THE READER SHARE ONE PREDICATE (§3.2.0). A closed row
   outside the inventory is terminal for both, so neither can consider a
   row a defect that the other treats as not-yet-due.
```

#### Database idempotency

```sql
create unique index uq_obl_proof_eval_missing_open
  on obligations (property_id, related_id)
  where related_type = 'work_order'
    and type = 'proof_evaluation_missing'
    and status <> 'complete';
```

**A duplicate open defect obligation is unrepresentable**, not merely avoided by
a check-then-insert race. The service inserts with `on conflict do nothing` and
treats a conflict as success.

#### Retry behaviour

The sweep is **idempotent by construction**, so retry is safe and needs no
bookkeeping. A failed sweep run is not compensated or replayed — the next
scheduled run re-derives the same population from the database and converges. A
partial run leaves correct rows and re-attempts the rest.

**The sweep never updates or closes an obligation.** It only creates.

#### Accountable owner

`property_manager`, escalating to `asset_manager`. The obligation appears on the
maintenance desk surfaces operators already read. It is an obligation rather
than an alert because that is the accountability rail this codebase has, and it
closes through a governed service.

#### Closure — only on genuine resolution

```text
CLOSES when, and only when:
  · a valid proof evaluation head exists for the work order  → resolution_code
    'satisfied'; or
  · the work order is no longer terminal                     → resolution_code
    'no_longer_applicable'

closure is performed BY the canonical services:
  · claimCompletion, when it writes the evaluation
  · the lifecycle service, if the work order leaves the terminal state

NO MANUAL CLOSURE. The obligation has no operator-facing "dismiss".
There is no path that closes it while the underlying defect persists.
```

The required input `proof_evaluation` cannot be satisfied by typing. If an
operator closes it any other way, the sweep re-creates it on the next run —
which is the correct behaviour and is why the sweep only creates.

Expected production volume at activation: **zero**.

---

## 5. Deployment

### 5.0 Evidence source — OPTION A, RULED

**The technician SMS lane is the canonical completion-evidence source for
Release 0.** No operator-app upload pipeline is built in this release.

The app's current "photo" is a synthetic `stub://` string with no bytes, no
storage state, no classification and no durable evidence. **It must never enter
a proof evaluation.**

Release 0's operating meaning:

```text
· the technician reports completion conversationally;
· genuine classified evidence is preserved from the technician exchange;
· claimCompletion performs the canonical completion transaction;
· the operator app READS the result, reviews proof, and may request
  missing proof;
· the operator app does NOT independently declare the repair complete;
· closeoutNotDone remains available and unchanged.
```

**The SMS technician lane must be phone-verified before the legacy app
completion control is removed** — deployment step 4, gating step 5.

*What this removes from revision 2.* Revision 2 posited an app
"canonical completion surface" at step 1b and claimed it could be
browser-verified against the old API. **That is withdrawn.** Under this ruling
completion belongs to the technician conversation; there is no new app upload
flow to verify, and no such claim is made.

### 5.1 The executable order

```text
STEP 1   APP — proof-shape compatibility, against the OLD API
         · ONE proof normalizer; no surface interprets the response itself
         · accepts BOTH the boolean-only and the state-plus-boolean shape
         · handles read_status = "unavailable" as an EXPECTED condition
         · unknown state / missing field / mismatch → CONTRACT FAILURE
           → renders unavailable, NEVER not_satisfied, never legacy, never empty
         · "Mark done — close" STILL PRESENT and unchanged at this step
         DEPLOY. VERIFY IN PRODUCTION AGAINST THE OLD API.

STEP 2   API — additive schema
         · migration 137; no reader change, no writer change
         · ledger verify gate passes (EXPECTED_LEDGER_CEILING=136)
         DEPLOY. Ledger ceiling becomes 137.

STEP 3   API — canonical completion writer
         · claimCompletion writes the evaluation transactionally
         · OLD READER STILL ACTIVE — no proof.state emitted yet
         · LEGACY APP DONE-PATH TEMPORARILY UNCHANGED
         DEPLOY.

STEP 4   ⚠ PHONE-VERIFY the technician SMS completion and evidence rail
         · a real handset, a real inbound photo, a real preserved attachment
         · claimCompletion completes a real work order end to end
         · ACTIVATION_SMS_WORK_ORDER_HANDOFF.md Part B; its stop conditions
           are binding
         GATE. Step 5 does not begin until this passes.

STEP 5   APP+API — retire the UNREACHABLE legacy completion path
         ⚠ REDEFINED IN REVISION 5. This step no longer protects an operator
           from becoming stranded — see §1.1. It removes dead code and closes
           a writer that is already unreachable from the UI.
         · "Mark done — close" removed
         · attachStubPhoto and woStubPhotos removed
         · the legacy API done-path fails closed
         · closeoutNotDone REMAINS, unchanged and still working
         STILL GATED ON STEP 4. Unreachable code and API paths must not be
         retired until the replacement rail is REAL — unreachable is not the
         same as absent, and an un-retired path is recoverable.
         DEPLOY. BROWSER-VERIFY that no app path completes a work order and
         that the not-done path still does.

STEP 6   API — legacy done-path fails closed
         · 409, naming the canonical path, writing nothing
         · the not-done path is untouched
         DEPLOY. VERIFY the canonical writer is live.
         ⚠ CAPTURE THE ACTIVATION INSTANT HERE — and only here, because
           only now can the legacy writer no longer create new 'closed' rows.

STEP 7   API — activation and cutover inventory
         · a specifically authorized read-only census immediately before (§6.2)
         · persist the instant captured at step 6 (NEVER now())
         · exact-set comparison, both directions, inside the transaction
         · ONE transaction
         RUN ONCE.

STEP 8   API — four-state proof reader
         · emits proof.state on BOTH shapes
         · deployed ONLY after activation and inventory exist
         DEPLOY.

STEP 9   Verification and cleanup
         · HTTP acceptance (§7.2)
         · browser acceptance (§7.3)
         · APP consumer-proof release — every consumer uses the normalizer
         · separate cleanup release: remove proof.satisfied after a repo-wide
           consumer search and a mismatch gate; remove the legacy done-path
           branch
```

**Why the activation instant moved to step 6.** Revision 2 captured it at
writer-verified-live while the legacy done-path was still able to write. A
`closed` row created in that window would have been terminal, absent from the
inventory, and therefore rendered `missing_evaluation_defect` — a defect the
system caused itself. Capturing only once the legacy writer is dead closes that
window by construction.

### 5.3 SMS ingress preflight — BEFORE step 2 *(correction 10)*

**The biggest unknown in this release sits in the middle of the sequence.**
Option A makes the technician SMS lane the only source of valid completion
evidence, and that lane has never run against a real handset — production holds
zero attachment rows. If it fails at step 4, the schema and writer are already
shipped and there is no way to produce evidence.

**The formal step-4 proof does not move.** It must exercise the canonical
writer and all eight transactional facts, which do not exist until step 3.
Instead the risk is split, and the load-bearing half moves to the front.

```text
PREFLIGHT — before step 2, on a controlled real work order

  real handset
  → real inbound image
  → correct conversation / work-order association
  → attachment row created
  → storage_state = 'stored'
  → mime_type present
  → byte_size present
  → sha256 digest present

  DO NOT send the completion command. This proves EVIDENCE INGRESS only.
```

If the preflight fails, **no migration has shipped and nothing needs
unwinding.** That is the entire point of moving it.

### 5.4 Proving the legacy writer is actually dead — BEFORE capturing the activation instant *(correction 11)*

Step 6 must not treat *"the new API is deployed"* as equivalent to *"the old
writer is impossible."* A draining instance or an in-flight request can commit a
`closed` row after the writer is nominally dead.

Before `$1` is captured:

```text
1  app step 5 is live                    (no completion control in the app)
2  the new API rollout is COMPLETE       (not "started")
3  old API instances terminated/drained
4  no in-flight legacy closeout request can still commit
5  legacy done-path returns 409
6  the NOT-done path still works         ← paired control: proves the 409 is
                                           a rejection, not a dead service
7  the canonical writer is live
8  WAIT at least the bounded maximum request/transaction duration
```

Only then capture the instant.

**The §3.2.0 correction is a second safety net, not a substitute.** A late
`closed` row now renders `missing_evaluation_defect` and raises an obligation
rather than vanishing — but a release that relies on its own error handling to
cover a sequencing gap has not closed the gap.

### 5.5 Step 5's justification changed; its gate did not

```text
WAS   legacy operator completion remains available
      → SMS rail becomes proven
      → legacy control removed at step 5, so nobody is stranded

IS    legacy operator completion ALREADY unreachable
      + SMS rail has no configured transport
      = production has no usable completion path RIGHT NOW
```

Step 5 is therefore **cleanup of an already-dead path**, not the removal of a
live one. It still waits on step 4, for a different and still-good reason:
**unreachable code is recoverable; retired code is not.** Until a real
replacement rail exists, keep the option.

### 5.6 ⛔ NEW PRODUCTION GATE — transport before any production mutation

**No Release 0 production schema or API mutation may begin until SMS transport
is configured and real-handset evidence ingress is proven.**

```text
MAY PROCEED NOW
  isolated scale and concurrency proof (§7.6)
  documentation and runbook preparation
  the SMS activation packet itself

BLOCKED
  production migration 137
  canonical writer production deploy
  legacy-path retirement
  activation
```

#### 5.6.1 The narrower transport proof, owed BEFORE migration 137

The formal completion phone test (§7.4, step 4) still belongs **after** the
canonical writer is deployed, because it must prove the eight atomic completion
facts. This is a **different, narrower** proof, owed earlier, and it proves only
that evidence can arrive:

```text
operations line exists
provider configured
inbound webhook authenticated
technician fixture valid
real handset image received
correct EXISTING work order resolved
attachment durably stored
MIME type present
byte size present
digest present
NO completion command sent
```

The last line is load-bearing. This proof establishes **ingress**, not
completion. Sending a completion command here would prove the wrong thing and
write a real operating fact.

### 5.2 SHA pair requirements

```text
APP  <step 1 SHA>  proof-shape compatibility   REQUIRED by the step-8 API
APP  <step 5 SHA>  legacy control removed      REQUIRED by the step-6 API
API  <step 3 SHA>  canonical writer
API  <step 6 SHA>  legacy done-path closed     REQUIRES app step 5
API  <step 8 SHA>  four-state reader           REQUIRES app step 1
```

**Rolling the app back behind step 1 requires rolling the API back behind
step 8. Rolling back behind step 5 requires rolling the API back behind
step 6.** The release packet names all five SHAs.

---

## 6. Activation transaction

```sql
begin;

insert into release_0_activation_history
  (activated_at, captured_at_step, captured_by)
values ($1, 'legacy_writer_dead_and_canonical_live', $2)   -- $1 CAPTURED at step 6
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

-- §6.2 exact-set comparison runs here, before commit.

commit;
```

### 6.1 `$1` is captured, never `now()`

Under §19 Ruling 1 the boundary is the instant captured at step 6 — after the
legacy writer can no longer create `closed` rows and the canonical writer is
verified live. Using the insertion time reopens the gap the ruling closes.
**This is the single most important line in the release.**

### 6.2 The expected set comes from a fresh authorized census

**The August 6 audit is historical evidence. It is not the deployment-time
expected set**, and it may not be used as one — production can move between the
audit and the cutover, and revision 2 treated a months-old identifier list as
current.

Procedure, in order:

```text
1  IMMEDIATELY BEFORE STEP 7, obtain a specific owner authorization for one
   read-only census. Same discipline as Open Ruling 4: structurally read-only,
   outside the unsafe harness paths, counts and identifiers only, no mutation.
   Being named "census" is not authorization.

2  Run the census. It returns the exact terminal-without-evaluation set:

     select w.id as work_order_id, w.property_id, w.status,
            (w.completion_photo is not null) as had_column_photo,
            (w.completion_note  is not null) as had_column_note
       from work_orders w
      where w.status in ('complete','closed')
        and not exists (select 1 from work_order_proof_evaluations e
                         where e.work_order_id = w.id
                           and e.property_id   = w.property_id)
      order by w.property_id, w.id;

3  Preserve the census output and its digest as the cutover receipt.

4  Supply that exact set to the activation transaction as the expected set.

5  Inside the transaction, compare BOTH directions against the live
   population:

     unexpected  = live \ expected     -- appeared since the census
     missing     = expected \ live     -- disappeared since the census

   ABORT if either is non-empty. Report BOTH — do not stop at the first.
```

**A count is never sufficient.** One row completed and one deleted between
census and activation produce a matching count over an entirely different
population, and the activation would commit a silently wrong inventory.

The window between census and activation should be minutes, and step 6 has
already stopped the legacy writer — so a non-empty difference is a genuine
surprise and worth stopping for.

### 6.3 Idempotency

The inventory's primary key makes a re-run insert nothing new.
`uq_r0ah_genesis` refuses a second genesis activation, so an accidental re-run
is rejected by the database. A deliberate correction is a new row citing the
head with a reason (§2.3), and `uq_r0ah_one_successor` prevents a forked
correction.

---

## 7. Acceptance

### 7.1 Real Postgres

```text
PROOF CLASSIFICATION
  unclassified alone                      → not_satisfied   (was satisfied)
  repair_photo stored                     → satisfied
  condition stored                        → satisfied
  unclassified + repair_photo             → satisfied
  referenced, never stored                → not_satisfied

STATE DERIVATION                                                  ← four only
  complete, no evaluation, inventoried    → legacy_indeterminate
  complete, no evaluation, NOT inventoried→ missing_evaluation_defect
  closed,   no evaluation, inventoried    → legacy_indeterminate      ← corr. 7
  closed,   no evaluation, NOT inventoried→ missing_evaluation_defect ← corr. 7
                                            NOT scheduled, NOT not-yet-due
  open/scheduled/needs_followup           → NEITHER legacy NOR defect
  activation head absent                  → read_status "unavailable",
                                            `state` key ABSENT, and NOT defect
  proof.state is never a fifth value      → assert the emitted set is exactly
                                            the four

SWEEP AND READER AGREE                                            ← corr. 7
  closed + NOT inventoried                → the sweep RAISES an obligation
                                            AND the reader renders defect
  closed + inventoried                    → sweep raises NOTHING
                                            AND the reader renders legacy
  every row: sweep visibility == reader terminality

CHAIN DISCIPLINE                                                  ← correction 2
  second genesis for the same work order      → REFUSED (uq_wope_genesis)
  two evaluations superseding the same row    → REFUSED (uq_wope_one_successor)
  supersede a non-head historical row         → REFUSED (it has a successor)
  supersedes_id from another work order       → REFUSED (composite self-FK)
  supersedes_id from another property         → REFUSED (composite self-FK)
  UPDATE / DELETE any evaluation              → REFUSED by trigger
  prior row after supersession                → BYTE-IDENTICAL
  DELETE a work order carrying an evaluation  → REFUSED by FK restrict

CHAIN INTEGRITY — rooted and acyclic                              ← correction 6
  evaluation supersedes itself                → REFUSED
  activation supersedes itself                → REFUSED
  evaluation cycle A → B → A                  → REFUSED
  activation cycle A → B → A                  → REFUSED
  superseding a nonexistent predecessor       → REFUSED
  second genesis (evaluations)                → REFUSED
  second genesis (activation, non-empty)      → REFUSED
  activation correction NOT citing the head   → REFUSED
  activation correction with a blank reason   → REFUSED
  two CONCURRENT successors, same head        → one accepted, one refused
  two CONCURRENT genesis inserts, same scope  → one accepted, one refused
  accepted chain after EVERY insert           → exactly one genesis and
                                                exactly one head
  head view after multiple valid supersessions→ exactly one row
  corrupt chain (fixture-injected cycle)      → walk fails loudly at the
                                                hop bound, never spins

SCOPE
  link an attachment from another work order  → REFUSED
  link an attachment from another property    → REFUSED

ACTIVATION
  second genesis activation                   → REFUSED
  forked correction                           → REFUSED
  correction without a reason                 → REFUSED by check
  correction citing the head, with reason     → accepted; original readable
  current view                                → the one unsuperseded row
  live set differs from census set            → ABORTS, reports both directions
  count matches but identity differs          → ABORTS                ← corr. 5

WRITER
  claimCompletion partial failure             → whole transaction rolls back;
                                                no orphan evaluation, no status
                                                change

DEFECT OBLIGATION                                                 ← correction 3
  reader run twice                            → ZERO writes observed
  sweep run twice                             → one obligation, not two
  sweep after a failed partial run            → converges, no duplicates
  obligation closes on a valid evaluation     → resolution 'satisfied'
  obligation closes when no longer terminal   → 'no_longer_applicable'
  no manual-close path exists                 → assert absence
  manual close attempt then sweep             → obligation re-created
```

Isolated Postgres only — never a `.db.js` harness against production
(`DB_HARNESS_ISOLATION.md`).

### 7.2 Real HTTP

```text
detail and list both carry read_status, and state when read_status = ok
state/satisfied mapping matches §3.4 on BOTH shapes
proof.state never emits a fifth value
read_status "unavailable" omits state and satisfied entirely
legacy done-path returns 409 and writes nothing
legacy NOT-done path still works and still creates its follow-up
GET endpoints perform ZERO writes — asserted against the statement log
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
list and detail AGREE for the same work order
completion performed through the TECHNICIAN lane writes all eight facts and
  appears on the operator surface without the operator declaring it
NO app control completes a work order                             ← step 5
closeoutNotDone is still reachable and still works
```

**Presence is not visibility.** Assertions measure `getComputedStyle().display`
and a bounding box, not `querySelector`.

**The proof enters the way the operator enters.** No test may call a module
function directly to reach the surface under test.

### 7.4 Phone verification — step 4 gate

```text
a real handset · a real inbound photo · a real preserved attachment with a
storage state, a MIME type and a digest · claimCompletion completes a real
work order · the operator surface reflects it without operator action
```

`ACTIVATION_SMS_WORK_ORDER_HANDOFF.md` Part B; its stop conditions are binding.
**This is the release's load-bearing proof**, because under Option A it is the
only way genuine evidence ever reaches a proof evaluation.

### 7.5 The regression the acceptance list was missing

§19a records it: `valid_empty` proves the empty case; the dangerous case is the
**non-empty** one. A genuine match placed deliberately outside the old recency
window must be found. Carried here so it is not lost, though the candidate
predicate is Build 1.

---

### 7.6 Scale and concurrency proof — BEFORE migration 137 is applied *(correction 12)*

Production holds **six** work orders. That cannot establish migration or query
behaviour at real cardinality. Isolated real Postgres, production-shaped schema,
synthetic data — **never production**.

```text
FIXTURE
  100,000 work orders
  mixed complete / closed / open / scheduled / needs_followup
  terminal rows WITH and WITHOUT evaluations
  multiple properties
  multiple evaluation chains, some several supersessions deep
  concurrent completion claims
  concurrent chain successors on the same head
  a large exact-set census

MEASURE
  migration duration
  index build duration
  activation transaction duration
  locks held, and for how long
  defect sweep duration, run TWICE
  reader query count and plans, list and detail
  exact-set mismatch reporting on a deliberately mismatched set
  rollback behaviour before the one-way door
```

Migration 012's un-replayability (`yardi_code`) does **not** need repairing
inside Release 0. Use a sanitized current-schema baseline or a schema snapshot.

### 7.7 Verification binding rules *(correction 13)*

Three false passes occurred during this release's own preparation. All three
share one shape: **the check proved an outcome without proving it acted on the
intended subject.**

```text
·  a credential test that "REFUSED" a placeholder password nobody had ever set
·  a row-count assertion that guessed SQL shape by regex and guessed wrong
·  a comment stripper that flagged a file's own prose
```

Every release proof must therefore bind:

```text
artifact identity        which exact commit or digest was exercised
input identity           which exact subject was fed to it
execution environment    where it ran
positive control         a case that must PASS
negative control         a case that must FAIL
observed consequence     what actually changed or was rejected
```

Applied:

```text
·  a deploy receipt records the exact deployed commit, not "deploy succeeded"
·  a credential test proves the supplied secret WAS the leaked secret,
   without recording it
·  a browser proof inspects rendered visibility, not DOM presence
·  a database audit records the exact tool commit or digest used
·  a census receipt preserves exact identifiers, not counts
·  an API rejection is paired with a neighbouring ALLOWED path, so a dead
   service cannot masquerade as a safe fail-closed
```

## 8. Rollback

| Step | Rollback | Data risk |
|---|---|---|
| 1 app compatibility | Redeploy prior app | None — reads both shapes |
| 2 api schema | Leave tables; unread | **None — additive only** |
| 3 api writer | Redeploy step-2 API | Evaluations written meanwhile remain; append-only, nothing lost |
| 4 phone verification | n/a — a gate, not a deploy | — |
| 5 app control removal | Redeploy step-1 app | Restores the legacy control; **it can create `closed` rows again**, so step 6 must not have run |
| 6 api done-path closed | Redeploy step-3 API | None; but see the ordering constraint below |
| 7 activation | **Not rolled back.** Correct by visible supersession (§2.3) | History is immutable by design |
| 8 api reader | Redeploy step-6 API | None — the reader is pure |

**Ordering constraint on rollback.** Steps 5 and 6 must roll back together and
in reverse order (6 then 5). Rolling back step 6 alone while the app control is
gone leaves no completion path at all; rolling back step 5 alone while the API
rejects the done-path leaves a visible control that always fails.

**Step 7 is the one-way door.** Everything before it is reversible by redeploy;
everything after inherits an activation that can only be corrected forward. This
is why the census (§6.2) aborts rather than proceeds on a surprise.

**Migration 137 is additive.** No column dropped, no data rewritten, no proof
evaluation backfilled — a deliberate constraint, not an accident.

---

## 9. What this release does NOT do

```text
NO operator-app upload pipeline                              ← Option A
NO app control that declares a repair complete               ← Option A
NO fifth proof.state — `unavailable` is a READ status        ← correction 1
NO backfill of proof evaluations from any source
NO attachment rows manufactured from completion_photo
NO inference of completion time from created_at, updated_at,
   migration applied_at, commit time, or deploy time
NO new writer emitting status='closed'
NO change to existing cascade behaviour on progress or attachment tables
NO manual closure path for the defect obligation
NO use of the August 6 audit as the deployment-time expected set
NO Ask Spine work — Build 1 does not start
NO /version endpoint, NO connectionTimeoutMillis   (out of scope by instruction)
```

---

## 9.1 PARKED — a separate read-surface defect, not Release 0

Observed during the step 1 acceptance and recorded so it is not discovered
twice.

```text
Maintenance desk, WORK ORDERS tile   "Work-order status unavailable."
the Work Orders door beside it       renders the record successfully
```

**Not a §5 truth violation.** It says *unavailable*, not "0" — an honest blank
rather than a false zero, which is the behaviour the doctrine asks for when a
read fails.

It is a separate desk-summary read defect. **Do not pull it into Release 0**
unless it blocks a named Release 0 acceptance step.

---

## 10. Open items to close during implementation

1. **`rule_version` value** — a stable identifier for the corrected
   classification array, cited by preserved verdicts.
2. **Obligation `type` vocabulary.** `proof_evaluation_missing` must be added to
   whatever closed set the obligation engine enforces, along with
   `required_inputs: ['proof_evaluation']`.
3. **Sweep cadence** on the existing followups rail, and its receipt.
4. **The step-7 census authorization** must be requested when step 7 is
   scheduled, not pre-granted.

None blocks the plan's shape. All are answerable by source reading; only item 4
requires a production connection, and only at step 7.

---

## 11. Classification (§18)

| # | Component | Class | Removal condition |
|---|---|---|---|
| 1 | App proof normalizer | 1 — permanent | Never. Single interpretation point for proof state. |
| 2 | `proof.satisfied` compatibility field | **3 — temporary** | Removed in a separate proven cleanup release after a repo-wide consumer search and a mismatch gate. §19 Ruling 2. |
| 3 | `work_order_proof_evaluations` | 1 — permanent | Never. |
| 4 | `work_order_proof_evaluation_attachments` | 1 — permanent | Never. |
| 5 | `release_0_activation_history` + current view | 1 — permanent | Never. Corrections supersede forward. |
| 6 | `release_0_legacy_cutover_inventory` | 1 — permanent | Never. Durable basis for legacy-vs-defect. |
| 7 | Legacy closeout **done-path** | **4 — retired** | Removed once the app no longer calls it and the 409 is browser-proven. The not-done path is Class 1 and stays. |
| 8 | `attachStubPhoto` / `woStubPhotos` (app) | **4 — retired** | Removed at deployment step 5. Must never feed a proof evaluation. |
| 9 | App "Mark done — close" control | **4 — retired** | Removed at deployment step 5, after phone verification. |
| 10 | `raiseProofEvaluationDefect` + sweep | 1 — permanent | Never. |
| 10a | `wope_chain_guard` / `r0ah_chain_guard` triggers | 1 — permanent | Never. They are what make the chain invariant inductive. |
| 11 | This plan | 1 — permanent record | Never. It is the reviewed design implementation is measured against. |
