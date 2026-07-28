#!/usr/bin/env bash
# ════════════════════════════════════════════════════════════════════
#  export-baseline.sh — OWNER-SIDE. Run this on a machine that already has
#  legitimate database access. Nobody else needs credentials.
#
#  Produces three files in runtime-proof-artifacts/ :
#
#      spine_schema_baseline.sql     schema only, no data
#      spine_schema_migrations.sql   the migration ledger's rows, and nothing else
#      manifest.txt                  what was exported, when, and its checksums
#
#  ── WHAT THIS SCRIPT WILL NOT DO ────────────────────────────────────
#    · it will not print the connection string
#    · it will not write the connection string to any file it produces
#    · it will not accept a connection string as a command-line argument
#    · it will not connect to anything until you run it
#
#  ── ONE RESIDUAL EXPOSURE, STATED PLAINLY ───────────────────────────
#  pg_dump takes the connection string as an argument, so on a shared machine
#  it is briefly visible in the process list to anyone who can read it. That
#  is a property of pg_dump, not something this script can hide. On a personal
#  machine it does not matter. On a shared one, export from somewhere else.
#  It is stated here rather than left for you to discover.
#
#  ── ATOMICITY ───────────────────────────────────────────────────────
#  Both dumps come from ONE invocation. If either fails, BOTH partial outputs
#  and the manifest are deleted and the script exits non-zero. Two artifacts
#  from two different moments would be a baseline that never existed.
# ════════════════════════════════════════════════════════════════════
set -uo pipefail

KIT_VERSION="baseline-intake-kit/1"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
OUT_DIR="$REPO_ROOT/runtime-proof-artifacts"

SCHEMA_FILE=""
LEDGER_FILE=""
MANIFEST_FILE=""

say()  { printf '%s\n' "$*"; }
warn() { printf '  ! %s\n' "$*" >&2; }
fail() { printf '\n  ✗ %s\n\n' "$*" >&2; }

# ── ARGUMENTS ───────────────────────────────────────────────────────
#  A connection string must never arrive here. Refusing anything that even
#  looks like one is deliberate: the failure mode being prevented is a URL
#  with a password in it landing in shell history.
usage() {
  cat <<'USAGE'
  Usage:
      DATABASE_URL="<your connection string>" ./scripts/runtime-proof/export-baseline.sh [--out-dir DIR]

  The connection string is read from the DATABASE_URL environment variable and
  from nowhere else. It is never printed, never written to a file, and never
  accepted as an argument.
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --out-dir)
      [ $# -ge 2 ] || { fail "--out-dir needs a directory."; exit 2; }
      OUT_DIR="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *)
      case "$1" in
        *://*|*password*|*PASSWORD*)
          fail "Refusing to accept a connection string as an argument."
          say  "    Set DATABASE_URL in the environment instead — an argument would be"
          say  "    written to your shell history."
          exit 2 ;;
      esac
      fail "Unknown argument: $1"; usage; exit 2 ;;
  esac
done

# ── PRECONDITIONS ───────────────────────────────────────────────────
if [ -z "${DATABASE_URL:-}" ]; then
  fail "DATABASE_URL is not set."
  say  "    This script reads the connection string from the environment only."
  say  "    Set it in this shell and run again:"
  say  ""
  say  "        export DATABASE_URL=\"<your connection string>\""
  say  "        ./scripts/runtime-proof/export-baseline.sh"
  say  ""
  exit 2
fi

command -v pg_dump >/dev/null 2>&1 || { fail "pg_dump is not on PATH. Install the PostgreSQL client tools."; exit 2; }
command -v node    >/dev/null 2>&1 || { fail "node is not on PATH. It is needed to checksum and inspect the artifacts."; exit 2; }

mkdir -p "$OUT_DIR" || { fail "Could not create $OUT_DIR"; exit 2; }

SCHEMA_FILE="$OUT_DIR/spine_schema_baseline.sql"
LEDGER_FILE="$OUT_DIR/spine_schema_migrations.sql"
MANIFEST_FILE="$OUT_DIR/manifest.txt"
STDERR_LOG="$(mktemp "${TMPDIR:-/tmp}/export-baseline.XXXXXX")"

# ── REDACTION ───────────────────────────────────────────────────────
#  pg_dump errors quote the connection string back at you. Everything it
#  writes to stderr goes through here before a human sees it.
redact() {
  local url="${DATABASE_URL:-}"
  sed -e "s|${url//|/\\|}|<DATABASE_URL redacted>|g" \
      -e 's|[a-zA-Z][a-zA-Z0-9+.-]*://[^ "'"'"']*|<connection string redacted>|g' \
      -e 's|password=[^ ]*|password=<redacted>|gI'
}

cleanup_partial() {
  rm -f "$SCHEMA_FILE" "$LEDGER_FILE" "$MANIFEST_FILE" 2>/dev/null || true
  rm -f "$STDERR_LOG" 2>/dev/null || true
}

abort() {
  fail "$1"
  say  "    Both partial artifacts and the manifest have been deleted. Nothing"
  say  "    half-exported is left behind: two files from two different moments"
  say  "    would be a baseline that never existed."
  say  ""
  cleanup_partial
  exit 1
}

say ""
say "  ── EXPORTING BASELINE ────────────────────────────────────────"
say "     out dir : $OUT_DIR"
say "     kit     : $KIT_VERSION"
say "     source  : the database DATABASE_URL points at (not printed)"
say ""

# ── 1. SCHEMA ONLY ──────────────────────────────────────────────────
say "  → schema (schema-only, no owner, no privileges)…"
if ! pg_dump --schema-only --no-owner --no-privileges --no-acl \
      "$DATABASE_URL" > "$SCHEMA_FILE" 2>"$STDERR_LOG"; then
  redact < "$STDERR_LOG" >&2
  abort "The schema export failed."
fi
[ -s "$SCHEMA_FILE" ] || abort "The schema export produced an empty file."
say "    ✓ $(basename "$SCHEMA_FILE")"

# ── 2. THE MIGRATION LEDGER, AND NOTHING ELSE ───────────────────────
say "  → migration ledger (public.schema_migrations rows only)…"
if ! pg_dump --data-only --table=public.schema_migrations --column-inserts \
      --no-owner --no-privileges --no-acl \
      "$DATABASE_URL" > "$LEDGER_FILE" 2>"$STDERR_LOG"; then
  redact < "$STDERR_LOG" >&2
  abort "The migration-ledger export failed."
fi
[ -s "$LEDGER_FILE" ] || abort "The migration-ledger export produced an empty file."
say "    ✓ $(basename "$LEDGER_FILE")"

# ── 3. FACTS ABOUT WHAT WAS PRODUCED ────────────────────────────────
#  Checksums and ledger counts are read from the FILES, not from a second
#  query. The manifest must describe the artifacts that will be transferred.
INSPECT_ERR="$(mktemp "${TMPDIR:-/tmp}/export-inspect.XXXXXX")"
if ! INSPECT_OUT="$(node "$HERE/inspect-artifacts.js" --schema "$SCHEMA_FILE" --ledger "$LEDGER_FILE" --format sh 2>"$INSPECT_ERR")"; then
  cat "$INSPECT_ERR" >&2; rm -f "$INSPECT_ERR"
  abort "Could not inspect the artifacts that were just written."
fi
# shellcheck disable=SC2046
eval "$INSPECT_OUT"

# Server version and database name, asked of the server rather than parsed out
# of the URL, so no part of the connection string is ever handled as text.
SERVER_VERSION="unavailable (psql not on PATH)"
DATABASE_NAME="unavailable (psql not on PATH)"
if command -v psql >/dev/null 2>&1; then
  SERVER_VERSION="$(psql -X -t -A -c "show server_version" "$DATABASE_URL" 2>/dev/null | tr -d '[:space:]')"
  [ -n "$SERVER_VERSION" ] || SERVER_VERSION="unavailable"
  DATABASE_NAME="$(psql -X -t -A -c "select current_database()" "$DATABASE_URL" 2>/dev/null | tr -d '[:space:]')"
  [ -n "$DATABASE_NAME" ] || DATABASE_NAME="unavailable"
fi

SCRIPT_SHA="unknown (not a git checkout)"
if command -v git >/dev/null 2>&1 && git -C "$REPO_ROOT" rev-parse HEAD >/dev/null 2>&1; then
  SCRIPT_SHA="$(git -C "$REPO_ROOT" rev-parse HEAD)"
  if [ -n "$(git -C "$REPO_ROOT" status --porcelain -- "$HERE" 2>/dev/null)" ]; then
    SCRIPT_SHA="$SCRIPT_SHA (working tree modified)"
  fi
fi

cat > "$MANIFEST_FILE" <<MANIFEST
Property Spine — runtime baseline manifest
==========================================

exported_at_utc      $(date -u +"%Y-%m-%dT%H:%M:%SZ")
kit_version          $KIT_VERSION
script_git_sha       $SCRIPT_SHA

server_version       $SERVER_VERSION
database_name        $DATABASE_NAME

schema_file          $(basename "$SCHEMA_FILE")
schema_bytes         $SCHEMA_BYTES
schema_sha256        $SCHEMA_SHA256

ledger_file          $(basename "$LEDGER_FILE")
ledger_bytes         $LEDGER_BYTES
ledger_sha256        $LEDGER_SHA256
ledger_rows          $LEDGER_ROWS
ledger_highest       $LEDGER_HIGHEST
ledger_duplicates    $LEDGER_DUPLICATES

inspection_warnings  $WARNING_COUNT

Notes
-----
Both files were produced by a single invocation of export-baseline.sh, from
one database, at the time above. They are only meaningful together.

The schema file contains no table data. The ledger file contains rows from
public.schema_migrations and no other table.

No connection string appears in this manifest or in either artifact.

The inspection is a BASIC AID. A warning count of zero means none of a small
set of known shapes were found. It does not prove the artifacts are free of
sensitive information — read the schema file before sending it.
MANIFEST

# ── 4. SAFETY SCAN, SHOWN TO THE OWNER ──────────────────────────────
say ""
say "  ── BASIC INSPECTION ──────────────────────────────────────────"
if [ "${WARNING_COUNT:-0}" = "0" ]; then
  say "     No warnings from the shapes this script knows how to look for."
else
  say "     $WARNING_COUNT warning(s). NOTHING HAS BEEN CHANGED in the artifacts."
  say ""
  node "$HERE/inspect-artifacts.js" --schema "$SCHEMA_FILE" --ledger "$LEDGER_FILE" --format sh >/dev/null
  say ""
  say "     Read each one and decide whether these files are safe to transfer."
fi
say ""
say "     This is an inspection aid, not a guarantee. It checks for a small set"
say "     of shapes with obvious reasons to be absent from a schema-only dump."
say "     It cannot tell you what a comment or a default expression contains."
say ""

rm -f "$STDERR_LOG" "$INSPECT_ERR" 2>/dev/null || true

say "  ── DONE ──────────────────────────────────────────────────────"
say "     $SCHEMA_FILE"
say "     $LEDGER_FILE"
say "     $MANIFEST_FILE"
say ""
say "     Send those three files. DO NOT send DATABASE_URL."
say "     DO NOT commit them — runtime-proof-artifacts/ is git-ignored."
say ""
exit 0
