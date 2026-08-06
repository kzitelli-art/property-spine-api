#!/usr/bin/env bash
# ════════════════════════════════════════════════════════════════════
#  RELEASE 0 SCALE HARNESS — BASELINE SETUP
#
#  ⚠ ISOLATED POSTGRES ONLY. Creates a throwaway cluster, replays the
#    migration ledger to ceiling 136, and installs the harness sentinel.
#
#  Idempotent from nothing: it destroys and recreates the cluster every
#  time, which is what makes the two clean runs of phase 9 comparable.
#
#  usage:  bash tools/scale/setup_baseline.sh
#  env:    PGPORT   (default 5433)   R0_ROOT (default /var/tmp/r0scale)
# ════════════════════════════════════════════════════════════════════
set -euo pipefail

PGPORT="${PGPORT:-5433}"
R0_ROOT="${R0_ROOT:-/var/tmp/r0scale}"
PGDATA="$R0_ROOT/pg"
DB="r0scale"
API_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
export PATH="/usr/lib/postgresql/16/bin:$PATH"

say() { printf '  %s\n' "$*"; }

# ── 1. a clean cluster, every time ──────────────────────────────────
if [ -d "$PGDATA" ]; then
  su postgres -c "PATH=/usr/lib/postgresql/16/bin:\$PATH pg_ctl -D $PGDATA -m immediate stop" >/dev/null 2>&1 || true
fi
rm -rf "$R0_ROOT"
mkdir -p "$PGDATA"
chown -R postgres:postgres "$R0_ROOT"
chmod 700 "$PGDATA"

su postgres -c "PATH=/usr/lib/postgresql/16/bin:\$PATH initdb -D $PGDATA -U postgres --auth=trust" >/dev/null 2>&1
say "initdb ok"

#  fsync off is a HARNESS choice, and it is declared rather than hidden:
#  it makes absolute write timings optimistic. Relative timings, lock
#  behaviour, correctness and concurrency outcomes are unaffected, and
#  those are what this proof measures.
su postgres -c "PATH=/usr/lib/postgresql/16/bin:\$PATH pg_ctl -D $PGDATA \
  -o '-h 127.0.0.1 -p $PGPORT -c fsync=off -c synchronous_commit=off \
      -c full_page_writes=off -c max_connections=100 \
      -c shared_buffers=256MB -c work_mem=32MB \
      -c track_io_timing=on -c log_lock_waits=on -c deadlock_timeout=200ms' \
  -l $PGDATA/log start" >/dev/null 2>&1

for i in $(seq 1 30); do
  pg_isready -h 127.0.0.1 -p "$PGPORT" -q && break
  sleep 1
done
pg_isready -h 127.0.0.1 -p "$PGPORT" -q || { echo "postgres did not start"; tail -20 "$PGDATA/log"; exit 1; }
say "postgres up on 127.0.0.1:$PGPORT"

createdb -h 127.0.0.1 -p "$PGPORT" -U postgres "$DB"
export DATABASE_URL="postgresql://postgres@127.0.0.1:$PGPORT/$DB?sslmode=disable"

# ── 2. replay the ledger, seeding between refusals ───────────────────
#  Three blockers, documented in docs/RELEASE_0_SCALE_BASELINE.md.
#  EXPECTED_LEDGER_CEILING must be the CURRENT max on each call, not the
#  target — the runner compares it to what the database says and refuses
#  on mismatch, which is correct behaviour.
ceiling() { psql "$DATABASE_URL" -tAc "select coalesce(max(version),'000') from schema_migrations;" 2>/dev/null | tr -d ' ' || echo 000; }

run_migrate() {
  MIGRATION_RELEASE=1 EXPECTED_LEDGER_CEILING="$(ceiling)" \
    node "$API_DIR/migrations/migrate.js" --apply 2>&1 || true
}

seeded_a=0; seeded_b=0; seeded_c=0
for _ in $(seq 1 40); do
  before="$(ceiling)"
  out="$(run_migrate)"
  after="$(ceiling)"
  if ! echo "$out" | grep -q "Stopped"; then break; fi
  if [ "$before" = "$after" ]; then
    # no progress — apply the seed section this refusal calls for
    if   echo "$out" | grep -q "012_bank_intake"                  && [ $seeded_a = 0 ]; then
      psql "$DATABASE_URL" -q -v ON_ERROR_STOP=1 -f "$API_DIR/tools/scale/seed_a_vendors.sql"; seeded_a=1; say "seed A applied (012)"
    elif echo "$out" | grep -q "087_internal_qa"                  && [ $seeded_b = 0 ]; then
      psql "$DATABASE_URL" -q -v ON_ERROR_STOP=1 -f "$API_DIR/tools/scale/seed_b_qa_identity.sql"; seeded_b=1; say "seed B applied (087)"
    elif echo "$out" | grep -q "110_governed_charge"              && [ $seeded_c = 0 ]; then
      psql "$DATABASE_URL" -q -v ON_ERROR_STOP=1 -f "$API_DIR/tools/scale/seed_c_governed_charges.sql"; seeded_c=1; say "seed C applied (110)"
    else
      echo "UNRESOLVED MIGRATION REFUSAL:"; echo "$out" | grep -A2 "FAILED" | tail -4; exit 1
    fi
  fi
done

CEIL="$(ceiling)"
[ "$CEIL" = "136" ] || { echo "ledger ceiling is $CEIL, expected 136"; exit 1; }
say "ledger ceiling $CEIL"

# ── 3. THE HARNESS SENTINEL ─────────────────────────────────────────
#  Identity, not location. The candidate refuses unless THIS row exists
#  with THIS exact purpose. A directory path protects nothing — a file
#  can be copied. Ports protect nothing — they are operational details.
psql "$DATABASE_URL" -q -v ON_ERROR_STOP=1 <<'SQL'
create table if not exists release_0_scale_harness_guard (
  id         boolean primary key default true check (id),
  created_at timestamptz not null default now(),
  purpose    text not null
);
insert into release_0_scale_harness_guard (id, purpose)
values (true, 'ISOLATED RELEASE 0 SCALE HARNESS — NEVER PRODUCTION')
on conflict (id) do nothing;
SQL
say "harness sentinel installed"

echo
echo "BASELINE READY"
echo "  DATABASE_URL=$DATABASE_URL"
