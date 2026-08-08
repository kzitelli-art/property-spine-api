#!/usr/bin/env bash
# ════════════════════════════════════════════════════════════════════
#  One clean HTTP-acceptance run: fresh baseline → 137 → the proof.
#
#  The proof REFUSES to run against a database that already carries an
#  activation, because a stale inventory would silently change which
#  rows are legacy and which are defects. So the baseline is rebuilt
#  every time rather than reused — this script exists so that is one
#  command and nobody is tempted to skip it.
#
#  usage:  bash tools/step10/run.sh [proof-file ...]
# ════════════════════════════════════════════════════════════════════
set -euo pipefail
API_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$API_DIR"

DB="postgresql://postgres@127.0.0.1:${PGPORT:-5433}/r0scale?sslmode=disable"

bash tools/steps23/baseline_136.sh >/dev/null
PROVE_DATABASE_URL="$DB" node tools/steps23/apply_137.js >/dev/null
echo "  baseline rebuilt, 137 applied"

for f in "${@:-tools/step10/prove_http_acceptance.js}"; do
  echo
  STEP10_DATABASE_URL="$DB" node "$f"
done
