#!/bin/bash
# Trigger a manual deploy on Render for property-spine-api
set -e

# ── NAME THE COMMIT, OR DO NOT DEPLOY ────────────────────────────────
#  This script used to POST {"clearCache": "do_not_clear"} and nothing
#  else, which deploys WHATEVER THE TRACKED BRANCH HEAD IS at that moment.
#  That cannot express "deploy the reviewed commit", so it cannot produce a
#  release receipt naming what was deployed, and it silently couples a
#  release to whatever landed on the branch since review.
#
#  The commit is now a required argument:
#
#      ./deploy.sh <full-40-char-sha>
#
#  ⚠ THIS DOES NOT DISABLE AUTO-DEPLOY. Render treats those as separate
#  settings: pinning a commit through the API leaves auto-deploy exactly as
#  it was, so the next push to the tracked branch can still replace what
#  you just pinned. Disable auto-deploy in the dashboard BEFORE a pinned
#  release. This script refuses to imply otherwise.
COMMIT="${1:-}"
if [ -z "$COMMIT" ]; then
  echo "Error: no commit given." >&2
  echo "  usage: ./deploy.sh <full-40-char-sha>" >&2
  echo "  A deploy that cannot name its commit cannot be a release." >&2
  exit 2
fi
if ! printf '%s' "$COMMIT" | grep -Eq '^[0-9a-f]{40}$'; then
  echo "Error: '$COMMIT' is not a full 40-character sha." >&2
  echo "  An abbreviated sha is a prefix, not an identity. Use the full one:" >&2
  echo "    git rev-parse <ref>" >&2
  exit 2
fi
#  Prove the commit exists here before asking Render to build it. A typo
#  otherwise becomes a failed remote build minutes later.
if ! git -C "$(dirname "$0")" cat-file -e "${COMMIT}^{commit}" 2>/dev/null; then
  echo "Error: commit $COMMIT does not exist in this checkout." >&2
  echo "  Fetch it first, or check the sha." >&2
  exit 2
fi
echo "Deploying commit: $COMMIT"
git -C "$(dirname "$0")" log -1 --format='  %h  %ad  %s' --date=short "$COMMIT" 2>/dev/null


# Load .env if present
if [ -f "$(dirname "$0")/.env" ]; then
  export $(grep -E '^RENDER_(API_KEY|SERVICE_ID)=' "$(dirname "$0")/.env" | xargs)
fi

if [ -z "$RENDER_API_KEY" ] || [ -z "$RENDER_SERVICE_ID" ]; then
  echo "Error: RENDER_API_KEY and RENDER_SERVICE_ID must be set (in .env or environment)"
  exit 1
fi

# ── SOURCE-GOVERNANCE GATES, BEFORE ANY DEPLOY IS TRIGGERED ──────────
#  These gates existed for months and nothing invoked them; one of them was
#  blind since a directory move and nothing noticed, because nothing ran it.
#  A gate you have to remember to run is documentation. `set -e` above means
#  a non-zero exit here aborts the deploy.
echo "Running source-governance gates before deploy..."
node "$(dirname "$0")/tests/verify_source_governance.js"

echo "Triggering deploy for service $RENDER_SERVICE_ID..."

RESPONSE=$(curl -s -X POST \
  "https://api.render.com/v1/services/${RENDER_SERVICE_ID}/deploys" \
  -H "Authorization: Bearer ${RENDER_API_KEY}" \
  -H "Content-Type: application/json" \
  -d "{\"clearCache\": \"do_not_clear\", \"commitId\": \"${COMMIT}\"}")

DEPLOY_ID=$(echo "$RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])" 2>/dev/null)

if [ -z "$DEPLOY_ID" ]; then
  echo "Error triggering deploy:"
  echo "$RESPONSE"
  exit 1
fi

echo "Deploy triggered: $DEPLOY_ID"
echo "Track at: https://dashboard.render.com/web/${RENDER_SERVICE_ID}/deploys/${DEPLOY_ID}"
