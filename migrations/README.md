# Migrations — what this folder is, in plain terms

You asked for migrations because the repo and the live database had **drifted
apart**: the live Neon database had tables and rules (the ingest tables, a
CHECK constraint, a unique constraint) that the code repo didn't know about.
That drift is dangerous — it means no test database can be trusted to behave
like production, because you can't rebuild production from the repo.

This folder fixes that. From now on, **the database only changes through
files in this folder.** No more hand-typing changes into the Neon editor.

---

## The one rule

> The database is changed **only** by adding a numbered migration file here
> and running the apply script. Never by hand in Neon again.

That rule is the entire point. Follow it and drift can't happen again.

---

## What's in this folder

- **`000_schema_migrations.sql`** — creates the little "ledger" table that
  remembers which migrations have already run. You don't run this yourself;
  the apply script handles it.

- **`001_baseline.sql`** — the big one. This is your **entire current database
  written down as code**. It was built from your repo schema plus a live
  inspection of Neon, so it matches production exactly — no guesses. Applying
  it to your real database is harmless (everything already exists, so it just
  confirms). ⚠ **Applying it to a fresh empty database does NOT build the whole
  thing** — measured 2026-08-20, the chain halts at
  `083_terms_review_and_packet_versioning.sql`. The documented from-scratch
  rebuild path does not currently work. Recorded as defect #22 in
  `docs/CURRENT_STATE.md`.

- **`migrate.js`** — ⚠ **NOT an apply script by default. It VERIFIES.**
  This description was written at migration 001 and was wrong for years.
  With no flags it compares the ledger against the files in BOTH directions
  and **refuses to start the service** on any mismatch — it applies nothing.
  `prestart` runs it in exactly this mode on every deploy, so shipping a
  migration and hitting deploy produces a *failed deploy*, not a migration.
  Releasing schema is a separate, deliberate act:

  ```
  MIGRATION_RELEASE=1 EXPECTED_LEDGER_CEILING=<read from the ledger> \
    EXPECTED_SHA=<deployed sha> node migrations/migrate.js --apply
  ```

  `EXPECTED_LEDGER_CEILING` exists so a release cannot be run by someone who
  has not read the ledger.

- **`neon_introspection_round2.sql`** — the next set of "inspect the database"
  queries, for building migration `002` (see below). Not urgent.

---

## How migrations actually run

`prestart` runs `migrate.js` in **verify-only** mode on every boot — including
every deploy. It applies nothing; it refuses to start the service if the
ledger and the files disagree. **Deploying does not migrate.** Shipping a
migration file and hitting deploy produces a *failed deploy*, not a migration.

Releasing schema is a separate, deliberate act:

```
MIGRATION_RELEASE=1 EXPECTED_LEDGER_CEILING=<what you just read from the ledger> \
  EXPECTED_SHA=<deployed sha> node migrations/migrate.js --apply
```

`EXPECTED_LEDGER_CEILING` exists so a release cannot be run by someone who has
not read the ledger. `--apply` refuses on a dirty tree and refuses if the
ledger is not in the state you said you saw. This is the same command the
release gate documents in `docs/deployment.md`.

**A from-scratch build (`--apply` on an empty database) does not currently
work** — see the ⚠ on `001_baseline.sql` above and defect #22. The working
from-scratch path is `tests/e2e/apply_migrations.sh`, which handles the
self-recording and data-dependent migrations via its precondition fixtures.

> Everything below the "About migration 002" heading is migration-001-era
> planning prose, kept only as history. It predates the release gate, the
> ledger ceiling, and migrations 002–187; do not follow it.

---

## Historical sections (migration-001 era — do not follow)

1. **Baseline `001`** ✅ — done, this folder.
2. **Test database** — make a separate Neon branch, get its connection string,
   and run `migrate.js` against it. That proves `001` can build the schema from
   nothing. From then on, tests run against the test DB, not production.
3. **Rollback test** — prove the promote step rolls back cleanly on failure.
4. **Then the next real feature** (the management dashboard).

---

## About migration `002` (not yet — when you're ready)

`001` deliberately covers only what's **confirmed**. Two more things drifted
into production through separate session SQL files and should be captured the
same careful way before they go into a migration:

- `scheduled_charges` (the revenue schedule table), and
- any extra columns on `leases`, plus the maintenance session tables.

When you want to build `002`, run the queries in
**`neon_introspection_round2.sql`** in Neon (same paste-and-run as before) and
hand back the results. Then `002` gets built to match production exactly —
zero guesses, just like `001`.

There's no rush. `001` plus the test database is the foundation; `002` is
tidying up the last drifted corners.
