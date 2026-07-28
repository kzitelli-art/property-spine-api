#!/usr/bin/env bash
# ════════════════════════════════════════════════════════════════════
#  apply-pending-build-migrations.sh — the LAST step before a thin
#  golden-path proof, and the one with a real consequence.
#
#    TARGET_DATABASE_URL="<disposable db>" \
#    ./scripts/runtime-proof/apply-pending-build-migrations.sh --apply
#
#  ── WHAT IT DOES ────────────────────────────────────────────────────
#    1. runs verify-baseline.js and REFUSES on any disagreement
#    2. shows exactly which migration files would run, by name
#    3. refuses if anything outside Builds 1-5 is also pending
#    4. refuses without --apply
#    5. hands off to the repository's own migration runner
#
#  ── WHAT IT DOES NOT DO ─────────────────────────────────────────────
#  It does not execute SQL. `node migrations/migrate.js` is the only thing in
#  this repository that applies a migration, and it carries guards this script
#  must not duplicate or weaken — a second runner would be a second opinion
#  about what "applied" means.
#
#  It does not edit, renumber or move a migration file. If a number collides,
#  it stops and says so. Renumbering a migration is a decision about the
#  ledger's memory, not a formatting fix.
# ════════════════════════════════════════════════════════════════════
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"

TARGET="${TARGET_DATABASE_URL:-}"
APPLY=0

say()  { printf '%s\n' "$*"; }
fail() { printf '\n  ✗ %s\n' "$*" >&2; }

usage() {
  cat <<'USAGE'
  Usage:
      TARGET_DATABASE_URL="<disposable database url>" \
      ./scripts/runtime-proof/apply-pending-build-migrations.sh --apply

  Options:
      --apply           required. Without it this is a dry run.
      --target-url URL  target database (prefer TARGET_DATABASE_URL instead)
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --apply) APPLY=1; shift ;;
    --target-url) [ $# -ge 2 ] || { fail "--target-url needs a url"; exit 2; }; TARGET="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) fail "Unknown argument: $1"; usage; exit 2 ;;
  esac
done

if [ -z "$TARGET" ]; then
  fail "No target database."
  say  "    Set TARGET_DATABASE_URL, or pass --target-url."
  exit 2
fi
command -v node >/dev/null 2>&1 || { fail "node is not on PATH."; exit 2; }

REPORT="$(mktemp "${TMPDIR:-/tmp}/baseline-report.XXXXXX.json")"
cleanup() { rm -f "$REPORT" 2>/dev/null || true; }
trap cleanup EXIT

# ── 1. VERIFY FIRST, ALWAYS ─────────────────────────────────────────
say ""
say "  ── STEP 1: VERIFY THE BASELINE ───────────────────────────────"
if ! TARGET_DATABASE_URL="$TARGET" node "$HERE/verify-baseline.js" --json "$REPORT"; then
  fail "The baseline verifier did not pass. Nothing will be applied."
  say  ""
  say  "    A mismatch between the ledger and the objects is exactly the state"
  say  "    where running migrations does the most damage: the runner keys on the"
  say  "    number alone, so it will either skip a migration forever or try to"
  say  "    recreate objects that already exist."
  say  ""
  say  "    Resolve it, restore a fresh disposable database, and run again."
  say  ""
  exit 1
fi

# ── 2. WHAT WOULD RUN ───────────────────────────────────────────────
say ""
say "  ── STEP 2: WHAT WOULD BE APPLIED ─────────────────────────────"

SAFE="$(node -e '
  const r = require(process.argv[1]);
  process.stdout.write(String(r.pending_application.safe_to_run));' "$REPORT")"
PENDING_BUILD="$(node -e '
  const r = require(process.argv[1]);
  process.stdout.write(r.pending_application.pending_build.join("\n"));' "$REPORT")"
PENDING_OTHER="$(node -e '
  const r = require(process.argv[1]);
  process.stdout.write(r.pending_application.pending_other.join("\n"));' "$REPORT")"
REASON="$(node -e '
  const r = require(process.argv[1]);
  process.stdout.write(r.pending_application.reason);' "$REPORT")"
COLLISIONS="$(node -e '
  const r = require(process.argv[1]);
  process.stdout.write(String(r.collisions.build_collisions.length));' "$REPORT")"

if [ -n "$PENDING_BUILD" ]; then
  say "     These Build 1-5 migrations would run, in this order:"
  say ""
  printf '       → %s\n' $PENDING_BUILD
else
  say "     No Build 1-5 migration is pending."
fi
if [ -n "$PENDING_OTHER" ]; then
  say ""
  say "     These are ALSO pending and are NOT Build 1-5 migrations:"
  say ""
  printf '       ! %s\n' $PENDING_OTHER
fi
say ""
say "     $REASON"

# ── 3. COLLISIONS STOP EVERYTHING ───────────────────────────────────
if [ "$COLLISIONS" != "0" ]; then
  fail "A migration number needed by Builds 1-5 is already spent."
  say  ""
  say  "    Renumbering is NOT done automatically. The ledger is how this system"
  say  "    remembers what it did, and rewriting a number to make a script happy"
  say  "    changes that memory."
  say  ""
  say  "    See the collision detail in the verifier output above."
  say  ""
  exit 1
fi

if [ "$SAFE" != "true" ]; then
  fail "Refusing to run the migration runner."
  say  ""
  say  "    $REASON"
  say  ""
  say  "    The repository's runner applies EVERY pending migration in the folder."
  say  "    There is no supported way to ask it for a subset, and this kit does not"
  say  "    add one — a second runner would be a second opinion about what"
  say  "    'applied' means."
  say  ""
  exit 1
fi

# ── 4. THE CONFIRMATION FLAG ────────────────────────────────────────
if [ "$APPLY" -ne 1 ]; then
  say ""
  say "  ── DRY RUN ───────────────────────────────────────────────────"
  say "     Nothing was applied."
  say "     Re-run with --apply to hand off to the repository's migration runner."
  say ""
  exit 0
fi

# ── 5. HAND OFF TO THE REPOSITORY'S OWN RUNNER ──────────────────────
say ""
say "  ── STEP 3: THE REPOSITORY'S MIGRATION RUNNER ─────────────────"
say "     node migrations/migrate.js"
say "     (this script executes no SQL of its own)"
say ""

if ! DATABASE_URL="$TARGET" node "$REPO_ROOT/migrations/migrate.js"; then
  fail "The migration runner stopped. Read its output above."
  say  ""
  say  "    It rolls back the failing migration, so nothing from that file was"
  say  "    half-applied. Everything before it did run and is recorded."
  say  ""
  exit 1
fi

say ""
say "  ── RE-VERIFYING ──────────────────────────────────────────────"
if ! TARGET_DATABASE_URL="$TARGET" node "$HERE/verify-baseline.js"; then
  fail "The runner finished but the baseline no longer verifies. Read the output above."
  exit 1
fi

say ""
say "  ── DONE ──────────────────────────────────────────────────────"
say "     The Build 1-5 migrations are applied to the disposable database and"
say "     recorded in its ledger."
say ""
say "     This is NOT runtime proof. Nothing has been exercised through real"
say "     HTTP and nothing has been verified in a browser. The thin golden-path"
say "     proof starts here; it has not started yet."
say ""
exit 0
