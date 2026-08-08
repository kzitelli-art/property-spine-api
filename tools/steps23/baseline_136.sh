#!/usr/bin/env bash
# ════════════════════════════════════════════════════════════════════
#  STEPS 2–3 — ISOLATED BASELINE AT LEDGER 136
#
#  The Step 2 candidate must be applied as a MEASURED step against the
#  ledger state production is actually at. So the baseline is built to
#  136 with migration 137 held back, and prove.js applies it afterwards
#  with timing and lock observation.
#
#  Holding it back by MOVING THE FILE, not by teaching migrate.js a
#  stop-at flag: a runner that can be told to skip a migration is a
#  runner that can skip one by accident. The file is restored on exit,
#  including on failure, via trap.
#
#  usage:  bash tools/steps23/baseline_136.sh
# ════════════════════════════════════════════════════════════════════
set -euo pipefail

API_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$API_DIR"

#  Hold back EVERY migration above 136, not just 137 by name.
#
#  This script named 137 explicitly and broke the moment migration 138 was
#  authored: 138 applied on top of 136, the ledger reached 138 instead of
#  136, the ceiling check failed, and the harness sentinel was never
#  installed — so every proof downstream reported "not the isolated
#  baseline" and looked like a database problem rather than a held-back
#  file problem. A baseline that has to be edited each time a migration is
#  added is a baseline that will be wrong at least once.
HELD_DIR="/var/tmp/r0_held_above_136"
rm -rf "$HELD_DIR"; mkdir -p "$HELD_DIR"

restore() {
  if [ -d "$HELD_DIR" ]; then
    for f in "$HELD_DIR"/*.sql; do
      [ -e "$f" ] || continue
      mv "$f" "migrations/$(basename "$f")"
    done
    rmdir "$HELD_DIR" 2>/dev/null || true
    echo "  migrations above 136 restored to migrations/"
  fi
}
trap restore EXIT

held=0
for f in migrations/*.sql; do
  n="$(basename "$f" | cut -c1-3)"
  case "$n" in
    ''|*[!0-9]*) continue ;;                 # not a numbered migration
  esac
  if [ "$n" -gt 136 ] 2>/dev/null; then
    mv "$f" "$HELD_DIR/"; held=$((held+1))
  fi
done
if [ "$held" -eq 0 ]; then
  echo "REFUSED: no migration above 136 found. Author one before proving it."
  exit 1
fi
echo "  $held migration(s) above 136 held back — baseline builds to 136"

bash tools/scale/setup_baseline.sh

#  The trap restores 137. Verify the ledger really stopped at 136 so a
#  later 'we applied 137' claim is about a real transition.
export DATABASE_URL="postgresql://postgres@127.0.0.1:${PGPORT:-5433}/r0scale?sslmode=disable"
CEIL=$(psql "$DATABASE_URL" -tAc "select max(version) from schema_migrations" | tr -d ' ')
if [ "$CEIL" != "136" ]; then
  echo "REFUSED: baseline is at $CEIL, not 136."
  exit 1
fi
echo
echo "BASELINE AT 136 — ready for the measured 137 application"
echo "  DATABASE_URL=$DATABASE_URL"
