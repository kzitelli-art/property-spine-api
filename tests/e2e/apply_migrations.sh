#!/bin/bash
# ════════════════════════════════════════════════════════════════════
#  Build the e2e schema FROM THE REAL MIGRATION CHAIN.
#
#  Not a shortcut and not a dump: it applies every migration in order, so
#  the schema under test is the one the chain actually produces. That is
#  the point — the first time this was run from empty it FAILED at 012,
#  which is how we learned a from-scratch build had not worked in a long
#  time (001_baseline already creates `vendors`, so 012's
#  `create table if not exists` was a silent no-op and its next statement
#  indexed columns that did not exist). That is fixed in 012 itself.
#
#  IT NEVER EDITS A MIGRATION. Two known structural classes are handled
#  here and nowhere else:
#
#    self-recording migrations  076/077/079/083/084 insert their own row
#      into schema_migrations inside their own transaction. The runner
#      then reports "FAILED — rolled back, nothing applied" while the
#      objects were in fact created. Detected by the duplicate-key error
#      and skipped, because the work DID land.
#
#    data-dependent migrations  a few need rows to exist before they can
#      run (087 internal-QA assignment; 110 governed fee charges). If one
#      stops the chain, seed the rows it needs and re-run — this script is
#      idempotent and resumes from the ledger.
#
#  Usage:  E2E_DATABASE_URL=postgres://... ./tests/e2e/apply_migrations.sh
# ════════════════════════════════════════════════════════════════════
set -u
E="${E2E_DATABASE_URL:-postgres://postgres:spineproof@127.0.0.1:5432/spine_e2e}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT" || exit 1

psql "$E" -q -f migrations/000_schema_migrations.sql >/dev/null 2>&1
FAILED=0
for f in $(ls migrations/*.sql | grep -vE '000_schema_migrations' | sort); do
  v=$(basename "$f" | cut -c1-3)
  if psql "$E" -tAc "select 1 from schema_migrations where version='$v'" 2>/dev/null | grep -q 1; then continue; fi
  if psql "$E" -q -v ON_ERROR_STOP=1 -f "$f" >/tmp/mig.log 2>&1; then
    psql "$E" -q -c "insert into schema_migrations (version,name) values ('$v','$(basename "$f")') on conflict do nothing" >/dev/null 2>&1
  else
    err=$(grep -oE 'ERROR:.*' /tmp/mig.log | head -1 | cut -c1-95)
    if echo "$err" | grep -q "duplicate key value.*schema_migrations_pkey"; then
      echo "  self-recorded (objects DID land)  $(basename "$f")"; continue
    fi
    echo "  STOP  $(basename "$f")"
    echo "        $err"
    echo "        Seed what this migration needs, then re-run — this script resumes."
    FAILED=1; break
  fi
done
echo "ledger ceiling: $(psql "$E" -tAc 'select max(version::int) from schema_migrations')"
exit $FAILED
