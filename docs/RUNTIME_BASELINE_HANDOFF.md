# Runtime baseline handoff

Live runtime proof for Builds 1–6B is blocked because the repository's
migration chain cannot be applied from a clean database. The way past it is a
**baseline**: the real schema and the real migration ledger, exported from a
database that already works, restored into a disposable one.

This kit exists so that handoff is safe and repeatable — so the owner never
shares credentials, and the developer never improvises a command.

```
owner runs export script
  → two database artifacts and a manifest are produced
  → artifacts are transferred outside Git
  → restore script creates a disposable PostgreSQL database
  → verifier checks schema and migration ledger agreement
  → pending Builds 1–5 migrations are identified safely
  → thin golden-path runtime proof can begin
```

---

## What this is, exactly

- **The dump is schema-only except for the migration ledger.** The schema
  artifact carries no table data at all. The ledger is exported separately, as
  its own artifact, containing `public.schema_migrations` rows and nothing
  else.
- **Both artifacts must come from the same database and the same invocation.**
  The export script produces them together and deletes both if either fails.
  Two files from two different moments describe a database that never existed.
- **Artifacts must never be committed.** `runtime-proof-artifacts/` is
  git-ignored. Transfer them out of band. No credential is ever written there,
  or anywhere else on disk.
- **This does not repair migrations 001–087.** The historical chain is
  untouched. The baseline is a way to work *around* it, not a fix for it.
- **This does not make Builds 1–6B live.** Restoring a baseline and applying
  the Build migrations produces a disposable database with the right tables in
  it. Nothing has been exercised through real HTTP and nothing has been
  verified in a browser. Runtime proof starts *after* all of this.

---

## Owner workflow

You need a machine that already has legitimate access to the database. Nobody
else needs credentials at any point.

```bash
# 1. Set the connection string in your shell. Nowhere else.
export DATABASE_URL="<your connection string>"

# 2. Run the export.
./scripts/runtime-proof/export-baseline.sh

# 3. Read the safety warnings it prints.

# 4. Send the three files from runtime-proof-artifacts/ :
#       spine_schema_baseline.sql
#       spine_schema_migrations.sql
#       manifest.txt
#
#    Never send the database URL.
```

**Never send the database URL.** Not in the same message, not separately, not
"just to check something". Nothing downstream of this point needs it — the
developer works entirely from a disposable database of their own.

### What the script will not do

- It will not print the connection string.
- It will not write it into any file it produces — including the manifest.
- It will not accept it as a command-line argument. Passing one is refused,
  because an argument lands in your shell history.
- It will not connect to anything until you run it.

### The connection string never reaches a process argument

`pg_dump` and `psql` are launched through `scripts/runtime-proof/pg-launch.js`,
which parses the connection string and starts the tool with libpq environment
variables — `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD`,
`PGSSLMODE` — and **no URL in its arguments**.

This matters because on Linux `/proc/<pid>/cmdline` is world-readable: a URL
passed as an argument is visible to every user on the machine for as long as
the dump runs, and a schema dump of a real database is not a short command.
`/proc/<pid>/environ` is not world-readable — it is restricted to the process
owner and root.

**The exposure is narrowed, not eliminated.** Root, and other processes running
as you, can still read the environment. What is gone is the world-readable
window.

The launcher also removes `DATABASE_URL` from the tool's own environment, so
the secret exists in one place and one shape. It writes nothing — no `.pgpass`,
no service file, no temporary credential of any kind — so there is nothing to
clean up on success, on failure, or on an interrupt. The scratch files that
capture a tool's error output are removed by a `trap` on `EXIT`, `INT` and
`TERM`.

### About the safety warnings

The script scans both artifacts and warns about:

- UUID-shaped literals inside function or view bodies
- email-shaped literals
- phone-number-shaped literals
- `INSERT` / `COPY` / other table-data statements in the schema dump
- any table other than `schema_migrations` in the ledger artifact

**This is a basic inspection aid. It does not prove the artifacts are free of
sensitive information.** It checks a small set of shapes that have obvious
reasons to be absent from a schema-only dump. It cannot tell you what a column
comment contains, what a default expression encodes, or whether a view's name
is itself revealing.

Warnings never change the dump. You see them, and you decide whether the files
are safe to send. Read the schema file before sending it.

### If the export fails

Both partial artifacts and the manifest are deleted, and the script exits
non-zero. Nothing half-exported is left for you to send by accident.

---

## Developer workflow

```bash
# 1. Verify the checksums against manifest.txt before anything else.
shasum -a 256 runtime-proof-artifacts/spine_schema_baseline.sql
shasum -a 256 runtime-proof-artifacts/spine_schema_migrations.sql
#    They must match schema_sha256 and ledger_sha256 in the manifest.
#    Also confirm both were produced by the same invocation — the manifest
#    records one export timestamp for both.

# 2. Create a DISPOSABLE PostgreSQL database. A local one is fine.
createdb spine_baseline_scratch
export TARGET_DATABASE_URL="postgresql://localhost/spine_baseline_scratch"

# 3. Restore. Schema first, then the ledger — the script enforces the order.
./scripts/runtime-proof/restore-baseline.sh \
    --schema runtime-proof-artifacts/spine_schema_baseline.sql \
    --ledger runtime-proof-artifacts/spine_schema_migrations.sql \
    --disposable-database

# 4. Verify before applying anything.
node scripts/runtime-proof/verify-baseline.js
#    …or with a machine-readable report:
node scripts/runtime-proof/verify-baseline.js --json /tmp/baseline-report.json

# 5. Resolve any mismatch or collision by hand. Nothing is repaired for you.

# 6. Apply the pending Build migrations. Dry run first.
./scripts/runtime-proof/apply-pending-build-migrations.sh
./scripts/runtime-proof/apply-pending-build-migrations.sh --apply

# 7. The thin golden-path runtime proof starts here. It has not started yet.
```

### What the restore script refuses

- **No `--disposable-database` flag.** It writes a whole schema into whatever
  it is pointed at; the flag is where you affirm the target is throwaway. It
  is not defaulted.
- **A target that already contains tables.** It does not drop, truncate or
  recreate anything, and it will not layer a baseline over an existing schema
  — the result would be neither the baseline nor what was there before.
- **A target whose database name reads like production** (`prod`,
  `production`, `live`, and similar). Only the database *name* is examined and
  only the name is ever printed.

### What the verifier reports

Read-only. It opens a `read only` transaction and issues no `CREATE`, `ALTER`,
`INSERT`, `UPDATE` or `DELETE` anywhere.

1. **The migration ledger** — every identifier, the highest, duplicates, gaps,
   and whether 112–118 are recorded. A gap is reported, not judged: a
   migration withdrawn before it ever ran leaves one legitimately.
2. **Required foundations** — the tables and columns migrations 112–118
   reference directly (`properties`, `units`, `spaces`, `leases`, `users`,
   `persons`, `property_team_assignments`, `staff_sessions`, `unit_events`,
   `events`, `obligations`, `turnovers`, `schema_migrations`), plus
   `gen_random_uuid()`.
3. **Ledger-to-object agreement for 112–118**, one verdict each:

   | verdict | meaning |
   |---|---|
   | `applied_and_recorded` | the ledger says it ran and its objects are there |
   | `pending` | neither — it simply has not run yet |
   | `recorded_without_objects` | the ledger says it ran and its objects are absent. **The runner would skip it forever.** |
   | `objects_without_ledger` | its objects exist and the ledger does not say so. **The runner would try it again.** |

   **118 is provisional.** The unit-turn closure slice writes
   `118_work_proof_attachments.sql` on the product branch, and that number is
   correct only if the live ledger's ceiling really is 117. A collision at 118
   is reported like any other and must be resolved by renumbering the product
   branch — never by working around it here.

   Both mismatches are silent failures in opposite directions. **Neither is
   repaired automatically.** Which side is wrong is a fact about the source
   database, and a human decides it.
4. **Migration-number collisions** — two files sharing a number, or a number
   the ledger already spent on a different migration. Either makes a migration
   never run and never complain.

Exit codes: `0` everything agreed · `1` a disagreement a human must resolve ·
`2` could not run.

### What the pending runner refuses

- Any verifier failure.
- Any collision touching 112–118. **Renumbering is never automatic** — the
  ledger is how this system remembers what it did.
- Anything pending outside Builds 1–5. The repository's runner applies *every*
  pending migration in the folder; there is no supported way to ask it for a
  subset, and this kit does not add one. If a historical migration is also
  pending, the run is refused rather than allowed to reach into the chain this
  kit does not repair.
- The absence of `--apply`. Without it, it is a dry run.

It executes no SQL of its own. `node migrations/migrate.js` is the only thing
in this repository that applies a migration, and it carries duplicate-number
and spent-number guards that must not be duplicated or weakened by a second
runner.

---

## Files

| Path | What it is |
|---|---|
| `scripts/runtime-proof/export-baseline.sh` | owner-side export, safety scan, manifest |
| `scripts/runtime-proof/restore-baseline.sh` | restore into a disposable database |
| `scripts/runtime-proof/verify-baseline.js` | read-only verifier, console + JSON |
| `scripts/runtime-proof/apply-pending-build-migrations.sh` | verify, then hand off to the repo's runner |
| `scripts/runtime-proof/pg-launch.js` | runs pg_dump/psql with libpq env vars, never a URL in argv |
| `scripts/runtime-proof/inspect-artifacts.js` | checksums and safety scan, standalone |
| `scripts/runtime-proof/baseline_scan.js` | pure scanner — the shapes it looks for |
| `scripts/runtime-proof/baseline_analysis.js` | pure analysis — the verdicts, testable |
| `runtime-proof-artifacts/` | where artifacts land. **git-ignored.** |
| `tests/runtime_baseline_kit_proof.js` | the kit's proof harness |

`.gitignore` ignores exactly `runtime-proof-artifacts/`. It does **not** ignore
`*.sql` broadly — migrations are `.sql` and must stay tracked.

---

## Remaining action, and who owns it

Everything in this kit is dormant until the owner runs the export. No artifact
exists, no baseline has been restored, and no migration has been applied
anywhere.
