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
  confirms). Applying it to a fresh empty database builds the whole thing.

- **`migrate.js`** — the apply script. It looks at the files here, checks the
  ledger, and runs whatever hasn't run yet. Safe to run as many times as you
  want; it never runs the same migration twice.

- **`neon_introspection_round2.sql`** — the next set of "inspect the database"
  queries, for building migration `002` (see below). Not urgent.

---

## How to run a migration

Open a terminal in this folder and run **one** of these:

**Against your TEST database (the normal, safe case):**
```
DATABASE_URL="<your test connection string>" node migrate.js
```

**Against PRODUCTION (only when you mean it):**
```
DATABASE_URL="<your Neon production connection string>" node migrate.js
```

The connection string is the same kind of string already used by the API
(`DATABASE_URL` in Render). The script prints exactly what it did. If anything
goes wrong, it undoes that migration and stops — nothing is left half-applied.

> You need Node installed and the `pg` package available — both are already
> true wherever the API runs, so the simplest path is to run this from the
> same project where `server.js` lives.

---

## The recommended order (from the handoff)

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
