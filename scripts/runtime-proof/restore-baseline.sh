#!/usr/bin/env bash
# ════════════════════════════════════════════════════════════════════
#  restore-baseline.sh — DEVELOPER-SIDE. Loads two artifacts into a
#  DISPOSABLE database. Never near production, never near anything with data.
#
#    ./scripts/runtime-proof/restore-baseline.sh \
#        --schema runtime-proof-artifacts/spine_schema_baseline.sql \
#        --ledger runtime-proof-artifacts/spine_schema_migrations.sql \
#        --disposable-database
#
#  The target comes from TARGET_DATABASE_URL in the environment (preferred) or
#  from --target-url. Preferred, because an argument lands in shell history.
#
#  ── THREE REFUSALS ──────────────────────────────────────────────────
#    1. no --disposable-database flag        → refuse
#    2. the target already has non-system tables → refuse
#    3. the target's name looks like production   → refuse
#
#  ── THE TARGET URL IS NEVER IN A PROCESS ARGUMENT ───────────────────
#  psql is launched through pg-launch.js, which translates the connection
#  string into libpq environment variables and starts psql with no URL in its
#  arguments. /proc/<pid>/cmdline is world-readable on Linux; /proc/<pid>/environ
#  is not. Nothing is written to hold the credential, so there is no temporary
#  credential material to clean up.
#
#  ── AND ONE THING IT WILL NEVER DO ──────────────────────────────────
#  It does not drop, truncate or recreate anything. If the target is not
#  empty, that is the operator's problem to resolve deliberately — a restore
#  script that clears the way for itself is one typo from being the worst tool
#  in the repository.
# ════════════════════════════════════════════════════════════════════
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
#  Every psql call goes through the launcher, so no connection string ever
#  reaches a process argument. TARGET is exported once, under the name the
#  launcher reads, and the launcher removes it from psql's own environment.
PG() { node "$HERE/pg-launch.js" --url-env RESTORE_TARGET_URL psql "$@"; }

SCHEMA=""
LEDGER=""
TARGET="${TARGET_DATABASE_URL:-}"
CONFIRMED=0

say()  { printf '%s\n' "$*"; }
fail() { printf '\n  ✗ %s\n' "$*" >&2; }

usage() {
  cat <<'USAGE'
  Usage:
      TARGET_DATABASE_URL="<disposable database url>" \
      ./scripts/runtime-proof/restore-baseline.sh \
          --schema <schema baseline .sql> \
          --ledger <migration ledger .sql> \
          --disposable-database

  Options:
      --schema FILE              schema-only baseline produced by export-baseline.sh
      --ledger FILE              migration-ledger artifact from the same invocation
      --disposable-database      required. Affirms the target is throwaway.
      --target-url URL           target database (prefer TARGET_DATABASE_URL instead)
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --schema) [ $# -ge 2 ] || { fail "--schema needs a file"; exit 2; }; SCHEMA="$2"; shift 2 ;;
    --ledger) [ $# -ge 2 ] || { fail "--ledger needs a file"; exit 2; }; LEDGER="$2"; shift 2 ;;
    --target-url) [ $# -ge 2 ] || { fail "--target-url needs a url"; exit 2; }; TARGET="$2"; shift 2 ;;
    --disposable-database) CONFIRMED=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) fail "Unknown argument: $1"; usage; exit 2 ;;
  esac
done

# ── REFUSAL 1: THE FLAG ─────────────────────────────────────────────
if [ "$CONFIRMED" -ne 1 ]; then
  fail "Refusing to run without --disposable-database."
  say  ""
  say  "    This script writes a whole schema into whatever it is pointed at."
  say  "    The flag is the point where you affirm the target is throwaway."
  say  "    It is not a formality and it is not defaulted."
  say  ""
  exit 2
fi

[ -n "$SCHEMA" ] || { fail "--schema is required."; usage; exit 2; }
[ -n "$LEDGER" ] || { fail "--ledger is required."; usage; exit 2; }
[ -f "$SCHEMA" ] || { fail "Schema file not found: $SCHEMA"; exit 2; }
[ -f "$LEDGER" ] || { fail "Ledger file not found: $LEDGER"; exit 2; }

if [ -z "$TARGET" ]; then
  fail "No target database."
  say  "    Set TARGET_DATABASE_URL, or pass --target-url."
  exit 2
fi

command -v psql >/dev/null 2>&1 || { fail "psql is not on PATH. Install the PostgreSQL client tools."; exit 2; }
command -v node >/dev/null 2>&1 || { fail "node is not on PATH. It launches psql without putting credentials in the process list."; exit 2; }

export RESTORE_TARGET_URL="$TARGET"

redact() {
  local url="${TARGET:-}"
  sed -e "s|${url//|/\\|}|<target url redacted>|g" \
      -e 's|[a-zA-Z][a-zA-Z0-9+.-]*://[^ "'"'"']*|<connection string redacted>|g' \
      -e 's|password=[^ ]*|password=<redacted>|gI'
}

# ── CONNECT AND LOOK BEFORE WRITING ─────────────────────────────────
PROBE_ERR="$(mktemp "${TMPDIR:-/tmp}/restore-probe.XXXXXX")"
DB_NAME="$(PG -X -t -A -c "select current_database()" 2>"$PROBE_ERR" | tr -d '[:space:]')"
if [ -z "$DB_NAME" ]; then
  redact < "$PROBE_ERR" >&2; rm -f "$PROBE_ERR"
  fail "Could not connect to the target database."
  exit 1
fi

# ── REFUSAL 2: A PRODUCTION-SHAPED NAME ─────────────────────────────
#  Only the database NAME is examined and only the NAME is ever printed. The
#  URL is not searched, because searching it means handling it as text and
#  printing a match means leaking part of it.
case "$(printf '%s' "$DB_NAME" | tr '[:upper:]' '[:lower:]')" in
  prod|production|live|main|*[-_]prod|*[-_]production|*[-_]live|prod[-_]*|production[-_]*|live[-_]*|*spine_prod*|*spine-prod*)
    rm -f "$PROBE_ERR"
    fail "Refusing to restore into a database named \"$DB_NAME\"."
    say  ""
    say  "    That name reads like production. This script only ever targets a"
    say  "    disposable database. If the name is a coincidence, rename the"
    say  "    target — do not weaken the check."
    say  ""
    exit 2 ;;
esac

# ── REFUSAL 3: A TARGET THAT ALREADY HAS TABLES ─────────────────────
EXISTING="$(PG -X -t -A -c "
  select count(*) from information_schema.tables
   where table_schema not in ('pg_catalog','information_schema')
     and table_type = 'BASE TABLE'" 2>"$PROBE_ERR" | tr -d '[:space:]')"
if [ -z "$EXISTING" ]; then
  redact < "$PROBE_ERR" >&2; rm -f "$PROBE_ERR"
  fail "Could not inspect the target database."
  exit 1
fi
rm -f "$PROBE_ERR"

if [ "$EXISTING" != "0" ]; then
  fail "Refusing to restore into \"$DB_NAME\": it already contains $EXISTING table(s)."
  say  ""
  say  "    This script does not drop, truncate or recreate anything, and it will"
  say  "    not layer a baseline on top of an existing schema — the result would"
  say  "    be neither the baseline nor what was there before."
  say  ""
  say  "    Create a fresh empty database and point TARGET_DATABASE_URL at it."
  say  ""
  exit 2
fi

say ""
say "  ── RESTORING BASELINE ────────────────────────────────────────"
say "     target database : $DB_NAME  (empty, confirmed disposable)"
say "     schema          : $SCHEMA"
say "     ledger          : $LEDGER"
say ""

RUN_ERR="$(mktemp "${TMPDIR:-/tmp}/restore-run.XXXXXX")"

# ── ORDER MATTERS: SCHEMA, THEN LEDGER ──────────────────────────────
#  The ledger is a table the schema dump creates. Loading its rows first would
#  fail on a table that does not exist yet.
say "  → schema…"
if ! PG -X -v ON_ERROR_STOP=1 -q -f "$SCHEMA" >/dev/null 2>"$RUN_ERR"; then
  say ""
  fail "The schema restore failed. The target is left exactly as psql left it —"
  say  "    nothing was rolled back or cleaned up, because guessing which half to"
  say  "    remove is worse than leaving a state you can inspect."
  say  ""
  say  "    psql said:"
  redact < "$RUN_ERR" | sed 's/^/      /' >&2
  rm -f "$RUN_ERR"
  exit 1
fi
say "    ✓ schema restored"

say "  → migration ledger…"
if ! PG -X -v ON_ERROR_STOP=1 -q -f "$LEDGER" >/dev/null 2>"$RUN_ERR"; then
  say ""
  fail "The ledger restore failed. The schema IS loaded and the ledger is NOT."
  say  "    Do not run migrations against this database — the runner would treat"
  say  "    every migration as unapplied and try to recreate objects that exist."
  say  ""
  say  "    psql said:"
  redact < "$RUN_ERR" | sed 's/^/      /' >&2
  rm -f "$RUN_ERR"
  exit 1
fi
say "    ✓ ledger restored"
rm -f "$RUN_ERR"

LEDGER_ROWS="$(PG -X -t -A -c "select count(*) from public.schema_migrations" 2>/dev/null | tr -d '[:space:]')"
say ""
say "  ── DONE ──────────────────────────────────────────────────────"
say "     $DB_NAME now carries the baseline schema and ${LEDGER_ROWS:-?} ledger row(s)."
say ""
say "     Next, and before anything is applied:"
say ""
say "         TARGET_DATABASE_URL=\"…\" node scripts/runtime-proof/verify-baseline.js"
say ""
exit 0
