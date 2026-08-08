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

M137="migrations/137_release_0_completion_proof.sql"
HELD="/var/tmp/held_137.sql"

restore() {
  if [ -f "$HELD" ]; then
    mv "$HELD" "$M137"
    echo "  migration 137 restored to migrations/"
  fi
}
trap restore EXIT

if [ ! -f "$M137" ]; then
  echo "REFUSED: $M137 not found. Author it before proving it."
  exit 1
fi

mv "$M137" "$HELD"
echo "  migration 137 held back — baseline builds to 136"

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
