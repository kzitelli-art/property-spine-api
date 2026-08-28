# Production activation package — migration 126 (missed recognition)

**Status: PREPARED. NOT EXECUTED. Awaiting explicit production go.**

`50c1836` is on `main`. The feature is **proven on isolated Postgres at the
service layer; not browser verified, not activated in production.**

---

## ⚠ THE FACT THAT SHAPES EVERYTHING BELOW

`package.json` runs `prestart: node migrations/migrate.js`, and `migrate.js`
exits **1** on any failure. npm will not run `start` if `prestart` fails.

> **A failed migration 126 on production does not degrade the service. It stops
> the service from starting at all.**

Therefore:

- **`main` is frozen for production deploys until this package is executed
  deliberately.** The next production deploy of `main` IS the activation. There
  is no such thing as a routine deploy of `main` right now.
- Every schema assumption is verified **before** the deploy (§3), not after.
- The failure-stop procedure (§6) is written for an outage, not a warning.

---

## 1. Read-only production smoke

`tests/scenarios/prod_smoke_missed_readonly.js` — the ONLY harness permitted against
production. Every other `.db.js` harness commits fixtures and is structurally
refused by the `HARNESS_DATABASE_URL` guard.

**The no-write guarantee is structural, not a promise.** Everything runs inside
`begin transaction read only`; Postgres refuses any write with SQLSTATE `25006`.
**§0 proves it** by attempting a write and requiring the failure — if that
self-test does not fail, the smoke aborts before checking anything else.

It reads only `SMOKE_DATABASE_URL`, never `DATABASE_URL` or
`HARNESS_DATABASE_URL`, so aiming it at production is always deliberate.

Verifies: migration 126 recorded exactly once · all three columns exist and are
nullable · both new constraints exist · **`ck_obl_status` still refuses
`missed`** and still permits all four lifecycle values · the shared primitive
loads and exports both functions · the projection returns `overdue` (not
`missed`) for a crossed clock with no recognition · statically, that the
primitive contains no `update obligations set status` · no half-written
recognition rows · no obligation holds a `missed` lifecycle status.

```bash
SMOKE_DATABASE_URL="<production>" node tests/scenarios/prod_smoke_missed_readonly.js
```

---

## 2. Read-only production ledger preflight (BEFORE deploy)

```bash
node -e 'const{Pool}=require("pg");const p=new Pool({connectionString:process.env.PROD_READ_URL});
p.query("select version, name, applied_at from schema_migrations where version >= $$118$$ order by version")
 .then(r=>{r.rows.forEach(x=>console.log(x.version+"  "+x.name+"  "+x.applied_at.toISOString()));return p.end()})
 .catch(e=>{console.error("ERR "+e.message);process.exit(1)})'
```

**GO only if:**

- `126` is **absent**;
- `122 governed_economics_lineage` is present (the expected predecessor);
- nothing above `122` is present that this branch does not know about. If
  `123`/`124`/`125` have landed from the parallel thread, **stop** — re-verify
  that 126 is still free and that their schema changes do not interact.

---

## 3. Expected pre-migration schema checks (BEFORE deploy)

```bash
node -e 'const{Pool}=require("pg");const p=new Pool({connectionString:process.env.PROD_READ_URL});
p.query("begin transaction read only").then(()=>p.query(`
  select
    (select count(*)::int from information_schema.columns
      where table_name=$$obligations$$ and column_name in
        ($$missed_at$$,$$missed_threshold_at$$,$$missed_recognition_key$$)) as new_cols_present,
    (select count(*)::int from pg_constraint where conname in
        ($$ck_oblig_missed_triple$$,$$ck_oblig_missed_after_threshold$$)) as new_cons_present,
    (select pg_get_constraintdef(oid) from pg_constraint where conname=$$ck_obl_status$$) as status_check,
    (select count(*)::int from obligations) as obligations,
    (select count(*)::int from obligations where due_at is not null) as with_due
`)).then(r=>{console.log(r.rows[0]);return p.query("rollback")}).then(()=>p.end())
 .catch(e=>{console.error("ERR "+e.message);process.exit(1)})'
```

**GO only if:**

- `new_cols_present = 0` — the migration has genuinely not run;
- `new_cons_present = 0`;
- `status_check` permits exactly `open, in_progress, complete, escalated` and
  **does not** contain `missed`;
- `obligations` returns a plausible production count.

If any column or constraint already exists, **stop**: something applied part of
this migration by another path and the state must be understood before a deploy
that would try again.

---

## 4. Post-deploy verification

1. **Migration applied exactly once** — the deploy log must show
   `→ 126_obligation_missed_recognition.sql — applying... ✓ applied and recorded`,
   and §1's smoke asserts exactly one ledger row. More than one row, or a second
   "applying" line on a later deploy, is a defect.
2. **The service started.** Confirm the health endpoint responds — `prestart`
   success is necessary but the point is that `start` ran.
3. **Run the read-only smoke (§1). All checks must pass.**
4. Confirm no rows changed: `recognised_missed` should be **0** immediately after
   the migration. The migration creates no recognitions.

---

## 5. Controlled QA-record plan — ONE human-triggered recognition

**Governed vehicle:** the production demo property
**"Property Spine Demo Building"** (`a50fbdd0-3642-431e-b532-0dcd6ab8a4fe`, the
timezone allowlist's own identifier). Demo data may exist; demo *paths* may not —
this uses the ordinary human path against a governed demo record, which is what
that property is for.

**Never** the Solo property `9e2bb96e-08e2-41db-81c2-91055ceb50a3`.

### 5a. Find a candidate — READ ONLY, before touching anything

```sql
-- run inside `begin transaction read only`
select o.id, o.type, o.status, o.due_at, o.missed_at,
       lco.id as link_id, lco.rung, lco.outcome
  from obligations o
  join leasing_conversion_obligations lco on lco.obligation_id = o.id
 where o.property_id = 'a50fbdd0-3642-431e-b532-0dcd6ab8a4fe'
   and o.status in ('open','in_progress')
   and o.missed_at is null
   and lco.outcome is null
   and o.due_at is not null
   and o.due_at < now()
 order by o.due_at asc
 limit 5;
```

A candidate must be: on the Demo Building · lifecycle `open` or `in_progress` ·
never recognised · rung window still unclosed · **already past its own deadline**
(the service refuses otherwise, and backdating a production `due_at` to
manufacture a candidate is exactly what must not happen).

### 5b. IF NO ROW RETURNS — THAT IS THE BLOCKER. STOP.

Do **not** manufacture a candidate, do not backdate a `due_at`, and do not
repurpose a real operating obligation. Report "no governed QA obligation exists"
and let the activation stand at §4 — migration applied and smoke green — with the
human-path check deferred until a legitimate demo record exists.

An activation receipt that says *"human path unverified — no governed QA record
available"* is honest. One that says *"verified"* against a manufactured record
is not.

### 5c. The check itself — the ordinary human path

`POST /leasing/rungs/:obligationId/resolve` with `result: "missed"`, as an
authenticated operator. Not a direct call to the primitive: the point is that the
path a human actually uses now records the miss.

### 5d. Verify, read-only, immediately after

```sql
select status, due_at, missed_at, missed_threshold_at, missed_recognition_key
  from obligations where id = '<candidate>';

select outcome, resolution, closed_at
  from leasing_conversion_obligations where obligation_id = '<candidate>';

select count(*)::int from events
 where type = 'obligation_missed' and note like '%<candidate>%';
```

**Must hold:**

- `status` is **unchanged** from 5a — this is the ruling's whole point;
- `missed_at` and `missed_threshold_at` are both set;
- `missed_threshold_at` **equals the `due_at` recorded in 5a** — the threshold
  came from the obligation, not the request;
- `missed_recognition_key` is set;
- the event count is exactly **1**;
- the rung link reads `outcome = 'missed'` with `closed_at` set;
- the obligation is **still actionable** — not `complete`, not hidden.

---

## 6. Rollback and failure-stop

### If the migration fails during `prestart`

**The service will not start.** This is an outage, and it is the scenario to
rehearse.

1. **Roll back the deploy in Render immediately** to the previous successful
   deploy (which predates 126). The service starts again because that image's
   migration set is already satisfied.
2. Capture the failing `migrate.js` output before anything else — it names the
   statement that failed.
3. Do **not** retry the deploy to "see if it works." A migration that failed
   partway has left a state that must be read before it is written to again.
4. Diagnose against §3's pre-checks. The most likely causes are a constraint name
   already taken, or a `123`/`124`/`125` from the parallel thread having changed
   `obligations` in a way this migration did not expect.

### If the migration succeeded but something is wrong

Migration 126 is **purely additive** — three nullable columns and two check
constraints. Nothing existing was altered, so **no code on `main` before this
merge reads or writes these columns**. Reverting is low-risk:

```sql
alter table obligations drop constraint if exists ck_oblig_missed_triple;
alter table obligations drop constraint if exists ck_oblig_missed_after_threshold;
alter table obligations drop column if exists missed_recognition_key;
alter table obligations drop column if exists missed_threshold_at;
alter table obligations drop column if exists missed_at;
delete from schema_migrations where version = '126';
```

**Two warnings that make this a considered act, not a routine one:**

- **Dropping the columns destroys any recognitions already recorded.** Check
  `select count(*) from obligations where missed_at is not null` first. If it is
  non-zero, those are durable institutional facts and this script erases them —
  export them before running it.
- The deployed code expects the columns. Revert the **code** to before `50c1836`
  in the same window, or the missed path throws again — which is the original
  defect, not a new one.

### If the human-path check fails

Stop. Do not retry against another record. One failed controlled check tells us
more than three; report the exact discrepancy.

---

## 7. Sanitized activation receipt template

Fill and keep. **No connection strings, hosts, usernames or passwords** — the
isolated-branch receipt had to be redacted for exactly this reason.

```
PRODUCTION ACTIVATION — migration 126, durable missed recognition
Date (UTC):            ____
Commit deployed:       ____                    Branch: main
Ledger before:         ceiling ____ , 126 absent: yes/no
Pre-migration checks:  new_cols_present=0  new_cons_present=0
                       ck_obl_status excludes 'missed': yes/no
Migration applied:     "✓ applied and recorded" seen exactly once: yes/no
Service started:       yes/no
Read-only smoke:       ____ checks · ____ passed · ____ failed · exit ____
recognised_missed after migration: ____   (expected 0)

HUMAN-PATH CHECK
Governed QA record available:  yes / NO — BLOCKER
Property:                      Demo Building (a50fbdd0-…)
Obligation id:                 ____
Lifecycle before / after:      ____ / ____        (must be identical)
missed_at written:             yes/no
missed_threshold_at == due_at recorded before:   yes/no
obligation_missed events:      ____               (must be exactly 1)
Rung link outcome:             ____               (expected 'missed')
Still actionable:              yes/no

CLAIM AFTER THIS ACTIVATION
[ ] Proven on isolated Postgres        [ ] Migration applied in production
[ ] Read-only production smoke green   [ ] Human path verified on a governed record
[ ] Browser verified                   ← still NO; this slice adds no operator surface

Notes / anything refused or deferred: ____
```

---

## Explicitly still excluded

No sweeper · no automatic missed detection · no consolidation of the eight
clock-based reads · no `conversation_owner_user_id` change (ITEM 2) · no
communication-line work · no production-fixture cleanup (still read-only
inventory in `DB_HARNESS_ISOLATION.md`, pending separate approval) · the
resident-SMS slice stays on its own branch.
