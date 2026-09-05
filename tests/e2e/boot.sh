#!/bin/bash
#  The database is a PARAMETER, so the same script boots the e2e schema and
#  a release-rehearsal schema. Two copies of this file would drift, and the
#  rehearsal's whole purpose is that it runs the SAME thing.
set -eu
export E="${E2E_DATABASE_URL:?owned proof database required}"
PORT="${PORT:-3000}"
SMS_LOG="${E2E_SMS_LOG:-/tmp/property_spine_e2e_sms.log}"
PRELOAD="$(cd "$(dirname "$0")" && pwd)/fake_sms_preload.js"
ANTHROPIC_LOG="${E2E_ANTHROPIC_LOG:-/tmp/property_spine_e2e_anthropic.log}"
ANTHROPIC_PRELOAD="$(cd "$(dirname "$0")" && pwd)/fake_anthropic_preload.js"
BOUNDARY="$(cd "$(dirname "$0")" && pwd)/proof_boundary.js"
FENCE="$(cd "$(dirname "$0")" && pwd)/proof_fence_preload.js"
node "$BOUNDARY" check

#  This launcher is proof infrastructure, never an operating server. Force
#  every outbound SMS through the local append-only fake transport even if
#  the caller's shell happens to contain real carrier credentials.
: > "$SMS_LOG"
: > "$ANTHROPIC_LOG"

#  ── REFUSE TO SHARE THE PORT ────────────────────────────────────────
#  See tests/e2e/port_guard.sh for why this exists and why callers must
#  ask BEFORE launching rather than polling afterwards.
. "$(cd "$(dirname "$0")" && pwd)/port_guard.sh"
if port_busy "$PORT"; then
  { echo "boot.sh: REFUSING to start."; port_busy_message "$PORT"; } >&2
  exit 1
fi
PROP=$(psql "$E" -tAX -c "select id from properties where name='Skyline E2E' order by created_at desc limit 1" | head -1 | tr -d '[:space:]')
SERVER_ROOT="${E2E_SERVER_ROOT:-$(cd "$(dirname "$0")/../.." && pwd)}"
PROOF_OPERATOR_KEY="e2e-key"
if [ "${E2E_WITHOUT_OPERATOR_KEY:-0}" = "1" ]; then PROOF_OPERATOR_KEY=""; fi
cd "$SERVER_ROOT" || exit 1
exec env -i PATH="$PATH" HOME="$HOME" \
  E2E_PROOF_MANIFEST="$E2E_PROOF_MANIFEST" E2E_DATABASE_URL="$E" E2E_EGRESS_LOG="$E2E_EGRESS_LOG" \
  E2E_SESSION_LOG="$E2E_SESSION_LOG" \
  E2E_SERVER_APPLICATION_NAME="$E2E_SERVER_APPLICATION_NAME" \
  E2E_SERVER_ROOT="$SERVER_ROOT" RENDER_GIT_COMMIT="${E2E_EXPECT_SERVER_COMMIT:-}" \
  DATABASE_URL="$E" OPERATOR_KEY="$PROOF_OPERATOR_KEY" OPERATOR_APP_ORIGIN="http://localhost:5173" APP_BASE_URL="http://localhost:3000" \
  PUBLIC_APPLY_BASE_URL="http://localhost:3000" \
  SMS_SEND_MODE=customer_care \
  EXECUTED_LEASE_INTAKE_ENABLED=true EXECUTED_LEASE_PROPERTY_IDS="$PROP" \
  COMMITMENT_LEDGER_MODE=enabled ACTIVATION_PROPERTY_IDS="$PROP" \
  APPLICATION_INTENT_PREPARE_ENABLED=true APPLICATION_INTENT_PROPERTY_IDS="$PROP" \
  CONVERSATIONAL_ACTION_TTL_SECONDS=5 \
  READ_AI_CONNECTION_ID="11111111-2222-4333-8444-555555555555" \
  LEASING_INTAKE_SECRET="e2e-intake" LEASING_INTAKE_PROPERTY_IDS="$PROP" \
  E2E_SMS_LOG="$SMS_LOG" E2E_ANTHROPIC_LOG="$ANTHROPIC_LOG" PORT="$PORT" \
  node --require "$FENCE" --require "$PRELOAD" --require "$ANTHROPIC_PRELOAD" server.js
