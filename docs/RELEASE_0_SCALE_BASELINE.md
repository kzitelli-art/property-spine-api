# Release 0 — scale proof baseline

**Start state for plan §7.6, the isolated 100k-row scale and concurrency
proof.** Established 2026-08-06.

**No production connection was opened. No production mutation occurred.** This
is a local Postgres 16.13 cluster on `127.0.0.1:5433`, created for this proof and
discarded with the container.

---

## 1. The baseline is real, and it took three repairs to get

```text
ledger ceiling        136          the production ceiling
migrations applied    135          125 does not exist in the repo
Release 0 tables      11 / 11      all present
engine                PostgreSQL 16.13
```

Every table the proof measures is present:

```text
work_orders · work_order_progress · work_order_proof_attachments
obligations · events · properties · units · persons · users
communication_lines · comm_events
```

## 2. ⚠ THE LEDGER DOES NOT REPLAY FROM EMPTY — THREE BLOCKERS, NOT ONE

Plan §7.6 records **one**: migration 012's `yardi_code`. There are **three**,
and two of them are a different *kind* of problem.

| # | Migration | Kind | Refusal |
|---|---|---|---|
| 1 | `012_bank_intake` | **structural** | `column "yardi_code" does not exist`, then `canonical_name` |
| 2 | `087_internal_qa_leasing_coverage` | **data-dependent** | `expected exactly one active leasing assignment for the canonical internal-QA operator on the QA property; found 0` |
| 3 | `110_governed_charge_assessed_per` | **data-dependent** | `expected exactly 1 fee.application row to backfill, updated 0` |

### 2.1 Blocker 1 — two different tables share one name

`001_baseline.sql` creates `vendors` as the **maintenance vendor** table:

```text
id · name · trade · phone · email · preferred · insurance_status · note
```

`012_bank_intake.sql` creates `vendors` as the **payee** table:

```text
id · canonical_name · yardi_code · vendor_type
```

with `create table if not exists`, which is a **no-op** once 001 has run. The
columns never arrive, and 012's index on `yardi_code` fails.

**How production resolved this is not known here, and is not guessed.** The
harness adds the missing columns so the ledger can proceed. `vendors` is not a
Release 0 table, so the divergence does not affect anything the scale proof
measures — but a `vendors` shape read off this harness would be wrong, and that
is why it is written down.

### 2.2 Blockers 2 and 3 — migrations that require pre-existing production data

These are the more interesting ones, because they are not schema drift.

`087` updates exactly one `property_team_assignments` row and raises unless
`row_count = 1`. The ids are **hardcoded in the migration**:

```text
user      e9a7659f-ee1a-4bde-9e0c-02c6632ff066
property  a50fbdd0-3642-431e-b532-0dcd6ab8a4fe
```

That property id is the same one production serves as **Solo on Chestnut**.

`110` backfills `assessed_per` and raises unless it updates exactly one
`fee.application` row **and** exactly one `fee.administration` row.

**Consequence worth stating plainly: this repo cannot stand up a fresh
environment from its own migrations.** A new QA database, a new region, a
disaster-recovery rebuild, or any second property installation would hit all
three. That is a real operational fact, discovered by doing rather than by
reading, and it is **out of Release 0's scope** — recorded here, not repaired.

### 2.3 What the harness does about it

`tools/scale/baseline_seed.sql` — three sections, applied between refusals. Each
statement exists because a named migration refused without it, and the file says
which. Nothing else is seeded.

**The migrations themselves are unchanged.** Plan §7.6 is explicit that 012 does
not need repairing inside Release 0, and repairing history to make a harness
convenient would rewrite the record of what production actually did.

### 2.4 One method note

The seed's column values are not guesses. The first three attempts failed
against `ck_gc_amount_or_reason`, `ck_gc_economic_class` and
`ck_gc_required_has_applicability` in turn — because the values were written
from expectation rather than from the constraints. They were then read directly
out of `pg_constraint` and the seed succeeded first try.

Same error class as the stale `kind` column and the placeholder password:
**assert against the thing that governs the behaviour, not against a
recollection of it.**

---

## 3. What has NOT been done yet

```text
fixture generation      NOT STARTED — 100,000 work orders, mixed states,
                        multiple properties, chains several supersessions deep
migration 137 draft     DOES NOT EXIST. Required to measure migration and
                        index-build duration. It must be authored OUTSIDE
                        migrations/ so migrate.js cannot pick it up and it
                        cannot reach production.
measurements            NONE
```

**Nothing in §7.6's MEASURE list has been run.** No timing, no plan, no lock
observation is claimed anywhere in this document.

## 4. Scope confirmation

```text
production migration          NOT RUN
production API deploy         NOT PERFORMED
provider configuration        NOT PERFORMED
production connection         NOT OPENED
```

The new production gate (plan §5.6) permits exactly this work — an isolated
scale proof — and blocks migration 137, the canonical writer deploy, legacy-path
retirement and activation until SMS transport is configured and real-handset
ingress is proven.

## 5. Reproducing the baseline

```bash
initdb -D "$PGDATA" -U postgres --auth=trust
pg_ctl -D "$PGDATA" -o "-h 127.0.0.1 -p 5433 -c fsync=off \
  -c synchronous_commit=off -c full_page_writes=off" start
createdb -h 127.0.0.1 -p 5433 -U postgres r0scale

export DATABASE_URL="postgresql://postgres@127.0.0.1:5433/r0scale?sslmode=disable"
# then: migrate → refuse at 012 → seed A → migrate → refuse at 087 → seed B
#       → migrate → refuse at 110 → seed C → migrate → ceiling 136
```

`EXPECTED_LEDGER_CEILING` must be the ledger's **current** max on each
invocation, not the target. The runner compares it against what the database
says and refuses on mismatch — correctly, since a surprise there means something
applied migrations while you were looking.

## 6. Classification (§18)

| Component | Class | Removal condition |
|---|---|---|
| This record | 1 — permanent | Never. It is the evidence of what the baseline was and why it needed repair. |
| `tools/scale/baseline_seed.sql` | 3 — temporary harness scaffold | Removed when the ledger replays from empty unaided, or when a sanitized schema snapshot replaces the replay. Not before — deleting it re-hides three blockers. |
| The local cluster | 4 — ephemeral | Discarded with the container. Nothing depends on it surviving. |
