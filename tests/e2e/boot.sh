#!/bin/bash
export E="postgres://postgres:spineproof@127.0.0.1:5432/spine_e2e"
PROP=$(psql "$E" -tAX -c "select id from properties where name='Skyline E2E' order by created_at desc limit 1" | head -1 | tr -d '[:space:]')
cd /workspace/kzitelli-art/property-spine-api
DATABASE_URL="$E" OPERATOR_KEY="e2e-key" OPERATOR_APP_ORIGIN="http://localhost:5173" APP_BASE_URL="http://localhost:3000" \
  EXECUTED_LEASE_INTAKE_ENABLED=true EXECUTED_LEASE_PROPERTY_IDS="$PROP" \
  COMMITMENT_LEDGER_MODE=enabled ACTIVATION_PROPERTY_IDS="$PROP" \
  APPLICATION_INTENT_PREPARE_ENABLED=true APPLICATION_INTENT_PROPERTY_IDS="$PROP" \
  LEASING_INTAKE_SECRET="e2e-intake" LEASING_INTAKE_PROPERTY_IDS="$PROP" \
  PORT=3000 exec node server.js
