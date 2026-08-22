#!/bin/bash
#  The database is a PARAMETER, so the same script boots the e2e schema and
#  a release-rehearsal schema. Two copies of this file would drift, and the
#  rehearsal's whole purpose is that it runs the SAME thing.
export E="${E2E_DATABASE_URL:-postgres://postgres:spineproof@127.0.0.1:5432/spine_e2e}"
PORT="${PORT:-3000}"

#  ── REFUSE TO SHARE THE PORT ────────────────────────────────────────
#  See tests/e2e/port_guard.sh for why this exists and why callers must
#  ask BEFORE launching rather than polling afterwards.
. "$(cd "$(dirname "$0")" && pwd)/port_guard.sh"
if port_busy "$PORT"; then
  { echo "boot.sh: REFUSING to start."; port_busy_message "$PORT"; } >&2
  exit 1
fi
PROP=$(psql "$E" -tAX -c "select id from properties where name='Skyline E2E' order by created_at desc limit 1" | head -1 | tr -d '[:space:]')
cd "$(cd "$(dirname "$0")/../.." && pwd)" || exit 1
DATABASE_URL="$E" OPERATOR_KEY="e2e-key" OPERATOR_APP_ORIGIN="http://localhost:5173" APP_BASE_URL="http://localhost:3000" \
  PUBLIC_APPLY_BASE_URL="http://localhost:3000" \
  SMS_SEND_MODE=customer_care \
  EXECUTED_LEASE_INTAKE_ENABLED=true EXECUTED_LEASE_PROPERTY_IDS="$PROP" \
  COMMITMENT_LEDGER_MODE=enabled ACTIVATION_PROPERTY_IDS="$PROP" \
  APPLICATION_INTENT_PREPARE_ENABLED=true APPLICATION_INTENT_PROPERTY_IDS="$PROP" \
  LEASING_INTAKE_SECRET="e2e-intake" LEASING_INTAKE_PROPERTY_IDS="$PROP" \
  PORT="$PORT" exec node server.js
