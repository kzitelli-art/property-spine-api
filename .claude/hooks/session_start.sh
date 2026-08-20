#!/usr/bin/env bash
#  Fires at the start of every Claude Code thread in this repo.
#  Its whole job: make a thread read CURRENT_STATE.md before it builds, and
#  tell it whether that file can still be trusted.
set -uo pipefail
cd "$(git rev-parse --show-toplevel 2>/dev/null || echo .)" 2>/dev/null || true
ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
STATE="$ROOT/docs/CURRENT_STATE.md"

echo "═══════════════════════════════════════════════════════════════"
echo " PROPERTY SPINE — READ BEFORE YOU BUILD"
echo "═══════════════════════════════════════════════════════════════"

if [ ! -f "$STATE" ]; then
  echo " docs/CURRENT_STATE.md is MISSING. Do not infer current state from"
  echo " docs/THREAD_HANDOFF.md — it is history and carries stale present-tense claims."
  exit 0
fi

SHA="$(grep -oE 'API verified against[[:space:]]+[0-9a-f]{7,40}' "$STATE" | grep -oE '[0-9a-f]{7,40}$' | head -1)"

echo " 1. docs/CURRENT_STATE.md   what exists, at what proof level  ← SEARCH THIS FIRST"
echo " 2. docs/PHILOSOPHY.md      what the product must mean"
echo " 3. docs/THREAD_HANDOFF.md  HISTORY ONLY — not current-state authority"
echo
echo " Threads keep rebuilding things that already exist. Before building X:"
echo "     grep -in \"X\" docs/CURRENT_STATE.md"
echo " If it is there, extend or connect it. Do not write it again."
echo " Absence is NOT proof of absence — only ~60% is surveyed. Search source too."
echo

BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null)"
echo " branch: ${BRANCH}"
if [ -n "${SHA:-}" ] && git cat-file -e "${SHA}^{commit}" 2>/dev/null; then
  CHANGED="$(git diff --name-only "${SHA}..HEAD" -- src/ migrations/ server.js 2>/dev/null | wc -l | tr -d ' ')"
  if [ "$CHANGED" = "0" ]; then
    echo " FRESHNESS: current. No surveyed path has moved since ${SHA}."
  else
    echo " ⚠ FRESHNESS: ${CHANGED} surveyed file(s) differ from the surveyed commit ${SHA}."
    echo "   This means EITHER new work landed since the survey, OR this branch is"
    echo "   behind main. Check which before trusting or updating a row:"
    echo "     git diff --name-only ${SHA}..HEAD -- src/ migrations/ server.js"
    echo "     git log --oneline HEAD..origin/main | head"
  fi
else
  echo " ⚠ FRESHNESS: could not resolve the verified SHA in CURRENT_STATE.md."
fi

echo
echo " BEFORE YOU END THIS THREAD: update docs/CURRENT_STATE.md for anything you"
echo " built, connected, proved or disproved. That is what keeps it from going stale."
echo "═══════════════════════════════════════════════════════════════"
