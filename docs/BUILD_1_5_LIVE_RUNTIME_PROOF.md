# Build 1–5 Live Runtime Proof — INCOMPLETE

> ## ⛔ NO LAYER REACHED LIVE. BUILDS 1–5 REMAIN **BUILT BUT DORMANT**.
>
> Migrations **112–117 were never applied**. The migration chain cannot reach them
> from a clean database. No HTTP call, no canonical write, and no browser scenario
> was executed. Nothing in this document may be read as live proof.

---

## What was genuinely achieved

**Real PostgreSQL 16.13** — installed locally, not Docker (daemon unreachable). Isolated
cluster on port **55432**, data dir `/var/lib/postgresql/build6`, database
`build6_proof`. Self-signed SSL enabled so `migrations/migrate.js` ran **completely
unmodified** (it requires SSL for Neon).

No production credentials were requested or used. No connection to any production
database was attempted.

**The real migration runner ran the real chain.** `package.json` `prestart` is
`node migrations/migrate.js`; that exact command was used.

**Ledger high-water reached: 086 of 117.**

---

## Runtime defects discovered — ALL PRE-EXISTING, ALL OUTSIDE THE BUILD 1–5 BOUNDARY

None of these were introduced by Builds 1–5. All four block a clean-database chain.

### 1. Two `migrate.js` files; the root one finds nothing

`migrate.js` (root) sets `MIGRATIONS_DIR = __dirname`, which contains no `.sql` files, so
it reports **"No migration files found. Nothing to do."** and exits successfully. The real
runner is `migrations/migrate.js`. A green exit from the root runner means nothing was
migrated — a silent success that could mask a failed deploy.

### 2. `012_bank_intake.sql` — `create table if not exists` over a different table

`001_baseline.sql` creates `vendors`. `012` re-declares `vendors` with a fuller definition
(`yardi_code`, `canonical_name`, …). Because the table already exists, `create table if
not exists` is a **no-op**, and `012` then indexes columns that were never added:

```
column "yardi_code" does not exist
column "canonical_name" does not exist
```

The two definitions have diverged by more than one column. **012 can never apply on top of
001 from clean.**

### 3. `084_application_intent_prepare_send.sql` — self-records into the ledger

Line 142 of the file inserts into `schema_migrations` itself. The runner then inserts the
same version, producing:

```
duplicate key value violates unique constraint "schema_migrations_pkey"
```

The whole file rolls back. **084 can never apply cleanly through the standard runner.**

### 4. `087_internal_qa_leasing_coverage.sql` — a data-dependent guard migration

```
087 refused: expected exactly one active leasing assignment for the canonical
internal-QA operator on the QA property; found 0
```

This migration asserts on **environment data**, not schema. A clean database has no such
data, so the migration refuses by design. **This is the hard structural blocker**: the
chain cannot be applied to a fresh database at all without pre-seeded QA state.

---

## Why Builds 1–5 could not be proven

Live proof requires the schema Builds 1–5 depend on. Getting there needs the chain to
reach 117. It stops at 087.

`schema.sql` was evaluated as a substitute base and **rejected** — it is missing
`property_team_assignments`, `staff_sessions` and `unit_events`, which are exactly the
authentication, authority and possession foundations Builds 1–5 build on. Loading it would
have produced a database that looks plausible and cannot authenticate anyone.

Two QA-only workarounds were applied to the ephemeral database and **not committed**:
`alter table vendors add column yardi_code`, then `drop table vendors cascade` so 012's own
definition could apply. These moved the chain from 11 → 83 applied. They are recorded here
for honesty; they are not fixes and no repo file was changed.

---

## What was NOT done — every one of these remains unproven

- Migrations 112–117 applied
- QA property, units 304/305, three staff identities with real assignments
- Any authenticated HTTP request
- Any canonical service write
- All ten required end-to-end scenarios
- Every browser scenario
- Duplicate-confirmation, authority-refusal and availability-guard runtime tests

---

## Proof level per layer — UNCHANGED

| Layer | Level |
|---|---|
| Build 1 — triage | Built but dormant |
| Build 2 — turn scope | Built but dormant |
| Build 3 — acceptance & proof | Built but dormant |
| Build 4 — readiness certification | Built but dormant |
| Build 5 — staff agent | Built but dormant |

549 pure assertions across five harnesses still pass, and **source-level assertions are not
live proof** — that is the distinction this document exists to preserve.

---

## What has to happen before Build 6 can succeed

The blocker is not Builds 1–5. It is that **the migration chain is not runnable from
clean**, which is a pre-existing condition of this repository and outside the boundary I
was given. One of these must be decided:

1. **Repair the chain** (012, 084, 087) — real work, explicitly outside the Build 1–5
   boundary, and it changes files the economic-plumbing thread may also touch.
2. **Produce a trustworthy baseline dump** from the live database, complete with
   `property_team_assignments`, `staff_sessions` and `unit_events`, and run 112–117 on top
   of it. This is the smallest honest path, and it needs a schema-only dump of production —
   which requires a credential decision I was told not to make.
3. **Make 087 skippable** for clean environments, since a guard migration that asserts on
   seed data cannot apply to an empty database by construction.

Until one is chosen, Builds 1–5 cannot be exercised against real Postgres, and no layer
may be called live.
