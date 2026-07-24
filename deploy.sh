#!/bin/bash
# Trigger a manual deploy on Render for property-spine-api
set -e

# Load .env if present
if [ -f "$(dirname "$0")/.env" ]; then
  export $(grep -E '^RENDER_(API_KEY|SERVICE_ID)=' "$(dirname "$0")/.env" | xargs)
fi

if [ -z "$RENDER_API_KEY" ] || [ -z "$RENDER_SERVICE_ID" ]; then
  echo "Error: RENDER_API_KEY and RENDER_SERVICE_ID must be set (in .env or environment)"
  exit 1
fi

echo "Triggering deploy for service $RENDER_SERVICE_ID..."

RESPONSE=$(curl -s -X POST \
  "https://api.render.com/v1/services/${RENDER_SERVICE_ID}/deploys" \
  -H "Authorization: Bearer ${RENDER_API_KEY}" \
  -H "Content-Type: application/json" \
  -d '{"clearCache": "do_not_clear"}')

DEPLOY_ID=$(echo "$RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])" 2>/dev/null)

if [ -z "$DEPLOY_ID" ]; then
  echo "Error triggering deploy:"
  echo "$RESPONSE"
  exit 1
fi

echo "Deploy triggered: $DEPLOY_ID"
echo "Track at: https://dashboard.render.com/web/${RENDER_SERVICE_ID}/deploys/${DEPLOY_ID}"
