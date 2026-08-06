#!/usr/bin/env bash
# ════════════════════════════════════════════════════════════════════
#  RELEASE 0 SCALE PROOF — THE WHOLE THING, FROM NOTHING
#
#  baseline replay + scaffold → fixture → candidate + measurements →
#  correctness → concurrency → reader/sweep → falsification
#
#  Every run destroys and rebuilds the cluster, which is what makes the
#  two runs of phase 9 comparable rather than merely consecutive.
#
#  usage:  bash tools/scale/run_all.sh <run-label>
# ════════════════════════════════════════════════════════════════════
set -euo pipefail

LABEL="${1:-run1}"
API_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
#  RECEIPTS LIVE OUTSIDE THE CLUSTER ROOT.
#  setup_baseline.sh does `rm -rf $R0_ROOT` to guarantee a clean cluster, so
#  a receipt written under it is destroyed by the NEXT run's setup — which
#  silently deleted run 1's evidence while run 2 was proving repeatability.
OUT="/var/tmp/r0receipts/${LABEL}"
export PATH="/usr/lib/postgresql/16/bin:$PATH"

echo "════════════════════════════════════════════════════════════════"
echo "  RELEASE 0 SCALE PROOF — ${LABEL}"
echo "════════════════════════════════════════════════════════════════"

bash "$API_DIR/tools/scale/setup_baseline.sh"
mkdir -p "$OUT"

export DATABASE_URL="postgresql://postgres@127.0.0.1:5433/r0scale?sslmode=disable"
export SCALE_DATABASE_URL="$DATABASE_URL"

echo
echo "── phase 1: fixture ────────────────────────────────────────────"
psql "$DATABASE_URL" -q -v ON_ERROR_STOP=1 \
  -f "$API_DIR/tools/scale/fixture_pre_migration.sql" | tail -12

echo
node "$API_DIR/tools/scale/run_scale_proof.js" --json "$OUT/proof.json"
PROOF=$?

echo
node "$API_DIR/tools/scale/falsify.js" --json "$OUT/falsify.json"
FALS=$?

echo
echo "════════════════════════════════════════════════════════════════"
echo "  ${LABEL}: proof exit ${PROOF} · falsification exit ${FALS}"
echo "  receipts in ${OUT}"
echo "════════════════════════════════════════════════════════════════"
exit $(( PROOF + FALS ))
