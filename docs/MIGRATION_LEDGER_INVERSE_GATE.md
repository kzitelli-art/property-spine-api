# Migration ledger — the inverse gate

**Status: merged (`6238d48`) and proven. Merge precondition CLEARED — see §6.**
**Not yet production-active: the gate ships in a build that has not been
deployed.**

Base: `main` @ `67442a5` · proved 2026-08-03 on PostgreSQL 16.13.

---

## 1. What was missing

ITEM 5 made a deploy verify the schema instead of migrating it. It checked one
direction:

```text
repo migration file   →   must already be recorded in the ledger
```

It never checked the other:

```text
ledger version        →   must still have its file in this repository
```

A ledger row whose file the repository does not carry is not a runtime hazard —
the schema is a *superset* of what the code expects, so the service runs. It is
a **truth** hazard, and a worse-shaped one:

- the schema **cannot be rebuilt**, because part of it exists in no file;
- that part was **never reviewed**, because it appears in no diff;
- a contributor reading `ls migrations/` sees a free number the ledger has
  **already spent**, and the existing collision guard cannot warn them, because
  it only compares numbers to *files*.

This is exactly what "the migration GAP at 121" was — a migration applied in
production whose file lived only on an unmerged branch. It sat in
`THREAD_HANDOFF.md` as a curiosity for weeks while being the visible symptom of
a deploy silently migrating production. ITEM 5 closed the cause. This closes the
reporting side: the same condition can never again be present without the deploy
saying so.

**A ledger the repository cannot describe is a reconstruction problem, which is
the class of uncertainty this product exists to eliminate.** So it refuses. It
does not warn.

---

## 2. What the gate now names

Five distinct conditions, each with its own message and its own repair. They are
different problems and are never collapsed into one "mismatch":

| Condition | Message | Exit |
|---|---|---|
| A repository file missing from the ledger | `REFUSING TO START — the schema does not match this code` | 1 |
| **A ledger version missing from the repository** | **`LEDGER VERSION MISSING FROM THIS REPOSITORY`** | **1** |
| A genuine version/name conflict | `MIGRATION NUMBER ALREADY SPENT` | 1 |
| A documented legacy naming exception | `! <file> — ledger NNN is mislabelled …` + reason + removal condition | 0 |
| No ledger table at all | `NO MIGRATION LEDGER` | 1 |

Two files sharing a number (`DUPLICATE MIGRATION NUMBER(S)`) is unchanged.

---

## 3. Where the decision lives

`migrations/ledger_verdict.js` — pure: no database, no filesystem, no
`process.exit`, no `console`. `migrate.js` imports it. The harness imports it.

This is deliberate and it is §17. `tests/_engine.js` is the standing
counter-example on this repo: a hand-maintained copy of one rule that drifted in
three places, all permissive, so every harness importing it asserted against an
engine more forgiving than production. A gate that stops production deploys does
not get a second implementation to disagree with.

---

## 4. Exceptions — and why they cannot widen

Two lists, both in `ledger_verdict.js`, both **hardcoded**. There is no pattern,
no range, and no environment variable. A broad ignore mechanism here would hide
precisely the drift the inverse check exists to surface.

Every entry is pinned on **both** the version **and** the exact ledger name it
forgives. If a different migration ever occupies that number, the exception
stops matching and the gate fires. That is the difference between a documented
exception and a hole with a comment over it — and it is proven in both
directions (`legacy 012: pinned on the ledger NAME`, `pinned on the VERSION`,
`documented orphan: pinned on the ledger NAME`).

| List | Contents as shipped | Class (§18) |
|---|---|---|
| `LEGACY_LEDGER_NAMES` | one entry: `012` = `property_noi_goals`, verified applied 2026-07-26 | temporary — removed when the `012` row is corrected to `bank_intake` |
| `DOCUMENTED_LEDGER_ONLY` | **empty** | temporary — each entry removed when its file is merged or its migration retired |

`UNTRACKED_VERSIONS` holds `000` only. That is **symmetry, not an exemption**:
`migrate.js` excludes `000_schema_migrations.sql` from the file scan because the
ledger table is created directly rather than applied, and a `000` ledger row is
the same decision seen from the ledger side. No other version is exempt.

Every exception carries a `reason` and a `removeWhen`, and an assertion enforces
that (`SHIPPED: every exception carries a removal condition (§18)`).

---

## 5. Verification is now genuinely read-only

`migrate.js` previously ran `create table if not exists schema_migrations` on
**every** invocation, including verify. That is DDL, and Postgres checks write
permission **before** it checks existence. Confirmed on 16.13:

```text
begin transaction read only;
create table if not exists schema_migrations (…);
ERROR:  cannot execute CREATE TABLE in a read-only transaction

-- as a SELECT-only role:
ERROR:  permission denied for schema public
```

So the verify path could not be run against a read-only connection — the one way
to inspect production's schema with no possibility of altering it. Ledger
creation is now confined to `--apply`.

A missing ledger in verify mode is therefore its own honest answer
(`NO MIGRATION LEDGER`) rather than being papered over by creating an empty one
and reporting 127 pending migrations.

---

## 6. ⚠ BLOCKING PRECONDITION FOR MERGE

**CLEARED 2026-08-03 for versions 109–130.** The production ledger was read
read-only and reconciled against `migrations/`:

```text
applied:                 120, 121, 122, 123, 124, 126, 127, 128
unused historical gap:   125  (absent from the ledger AND from migrations/)
```

Every listed ledger row has its file, and no repository file in range lacks a
row. **No `DOCUMENTED_LEDGER_ONLY` entry was required, and the list ships
empty.** A parallel thread independently reconciled 109–128. Combined confirmed
coverage is therefore **109–130**.

**125 never ran anywhere.** It is staged at
`docs/slices-6-to-10/deployment_b/125_application_lifecycle_enforcement.sql`,
outside the runner (`SLICE_9_DEPLOYMENT_RECEIPT.md` §41, §49), and it is absent
from the production ledger. The earlier claim in `THREAD_HANDOFF.md` that
production carried "120–128 unbroken" was wrong: there is a real, benign hole at
125.

### Still open: the ledger below version 109

The gate evaluates the **entire** ledger, not a range. Nobody has reconciled
below 109. Use `tools/ledger_reconcile.js` — read-only, and it imports the same
`classifyLedger` the deploy gate uses, so it cannot disagree with what the boot
will decide:

```bash
DATABASE_URL="<prod>" node tools/ledger_reconcile.js
```

Per row it reports as missing from the repository:

- **the file exists on an unmerged branch** → merge it, as `121` was;
- **it was applied by hand** → commit the file that ran;
- **it is genuinely historical** → add one entry to `DOCUMENTED_LEDGER_ONLY`
  with its version, exact ledger name, reason, and removal condition.

Full activation runbook: `docs/PROPERTY_LINE_ACTIVATION.md`.

The same read settles the next free migration number, which the property-line
slice needs. **Do not claim a number from `ls migrations/` — that is the reading
that produced this defect.**

---

## 7. Proof

Base `67442a5`. PostgreSQL **16.13**, isolated local cluster, TLS enabled so
`migrations/migrate.js` runs **unmodified** (it hardcodes `ssl`). No production
contact; `HARNESS_DATABASE_URL` only, no fallback.

| Harness | Result | Exit |
|---|---|---|
| `tests/unit/migration_ledger_verdict.test.js` (decision logic, DB-free) | **40 run · 40 passed · 0 failed** | 0 |
| `tests/proofs/migration_ledger_inverse_gate.db.js` (real Postgres, read-only role) | **24 run · 24 passed · 0 failed** | 0 |

Regression — unchanged by this work:

| Harness | Result | Exit |
|---|---|---|
| `tests/unit/migration_release_gate.test.js` (ITEM 5) | 11 passed · 0 failed | 0 |
| `tests/unit/obligation_engine_one_implementation.test.js` | 14 passed · 0 failed | 0 |
| `tests/unit/obligation_engine_import_smoke.test.js` | pass | 0 |
| `tests/gates/gate_closure_boundary.js` | PASS | 0 |
| `tests/gates/gate_no_raw_bridge_joins.js` | PASS | 0 |

The real-database harness runs `migrate.js` as a child process through a role
created with `default_transaction_read_only = on` and no write grants, and
proves that role cannot `CREATE TABLE` or `INSERT` before trusting any result
from it.

### Sanitized output — ledger agrees, read-only connection

```text
  Connected to the database.  (verify-only)

  ✓ SCHEMA VERIFIED — 127 migrations, all applied. Ledger ceiling 128.
    (verify-only; applying requires an explicit release)
    (both directions checked: every file is in the ledger, and every
     ledger version has its file)

EXIT=0
```

### Sanitized output — the 125 shape

```text
  Connected to the database.  (verify-only)

  ✗ LEDGER VERSION MISSING FROM THIS REPOSITORY — refusing to start.

    1 migration(s) are recorded as applied to this
    database, but this build carries no file for them:

      125  the ledger says: application_lifecycle_enforcement
           -> migrations/125_*.sql does not exist in this build.

    The database contains changes this codebase cannot describe, so the
    schema cannot be rebuilt or reviewed, and the number is spent without
    being visible to anyone allocating the next one.

    Resolve it, do not silence it:
      · the file exists on an unmerged branch  -> merge it, as 121 was;
      · the migration was applied by hand      -> commit the file it ran;
      · it is genuinely historical             -> add a documented entry to
        DOCUMENTED_LEDGER_ONLY in migrations/ledger_verdict.js, naming the
        reason and what removes it.

    Nothing was applied.

EXIT=1
```

---

## 8. What this slice deliberately does NOT do

**Rebuild-from-empty is not included.** PR #33 reproduced, against a real empty
Postgres 16.13, that the migration chain cannot rebuild from scratch:
`012_bank_intake.sql` fails on `yardi_code` because `create table if not exists
vendors` silently discards every column when the table already exists — 1
genuine defect, 6 real cascades, 8 artifacts of per-file application. Its
conclusion is that production's `vendors.yardi_code` arrived by a path not
represented in `migrations/` — the same class of fact as the 121 gap, found
independently.

That is real and it is adjacent, but it is broader than this correction and it
does not need to delay the property-line work. It stays in PR #33 with its
owner.

**§33 rung: Proven** — real Postgres, real verify path, read-only connection.
Not browser verified, and it has no browser surface to verify.
