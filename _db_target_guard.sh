#!/usr/bin/env bash
# ════════════════════════════════════════════════════════════════════
#  _db_target_guard.sh — shared production-write guard for the root QA
#  setup scripts. SOURCE it; do not execute it.
#
#  WHY THIS EXISTS
#  The root QA setup scripts write business-shaped rows (persons,
#  person_property_classifications, lease_applications) through
#  `psql "$DATABASE_URL"`. In the Render Shell that variable IS
#  production. The JS harnesses are guarded by
#  tests/_run_receipt.js → harnessConnectionString(); these scripts never
#  enter a Node process, so that guard could not reach them. Per the
#  Phase 1 audit (docs/DB_CONNECTION_INVENTORY.md, Section A and
#  Appendix G3-A) they were the largest remaining coverage gap:
#  standalone, production-capable, unguardable by construction.
#
#  WHAT THIS DOES — AND DELIBERATELY DOES NOT DO
#  It does NOT forbid production. These scripts are MEANT to run in the
#  Render Shell against Demo Building; refusing the production target
#  would remove their purpose, not their risk. What it forbids is
#  reaching production WITHOUT SAYING SO. The operator must name the
#  target by acknowledging it, and the resolved target is echoed first so
#  the acknowledgement is informed rather than reflexive.
#
#  This is the shell counterpart of harnessConnectionString()'s refusal,
#  adapted to a script whose correct target IS the live database. It
#  follows the PSPINE_ALLOW_NON_TTY precedent in
#  tools/issue_operator_invite.js: an explicit, named, dangerous-by-
#  default opt-in rather than a comment asking people to be careful.
#
#  CLASS 2 (permanent). No removal condition — the gap it closes is
#  structural, not transitional.
# ════════════════════════════════════════════════════════════════════

# Fail on error, on unset-variable misuse in the guard, and — the point of
# row 4 in the false-green inventory — on ANY failing stage of a pipeline.
# Without pipefail a `curl … | head` reports head's success and the
# calling script's `set -e` never fires. Callers must not pipe a producer
# into an early-exiting consumer; capture and slice instead (see the
# callers for the pattern).
set -o pipefail

# Render host:port/database from a connection string WITHOUT the password.
# Strips scheme, then credentials, then any query string.
_pspine_db_identity() {
  printf '%s' "${1:-}" | sed -E 's#^[a-zA-Z+]+://##; s#^[^@/]*@##; s#\?.*$##'
}

# pspine_require_db_target <human-readable description of what will be written>
pspine_require_db_target() {
  local what="${1:-QA fixture rows}"

  if [ -z "${DATABASE_URL:-}" ]; then
    {
      echo
      echo "  REFUSED: DATABASE_URL is not set."
      echo
      echo "  This script writes ${what} directly through psql."
      echo "  It has no target and will not guess one."
      echo
    } >&2
    exit 1
  fi

  local target
  target="$(_pspine_db_identity "$DATABASE_URL")"

  if [ "${PSPINE_QA_WRITES_OK:-}" != "1" ]; then
    {
      echo
      echo "  ════════════════════════════════════════════════════════"
      echo "  REFUSED: this script writes to a live database."
      echo "  ════════════════════════════════════════════════════════"
      echo
      echo "  target:  ${target}"
      echo "  writes:  ${what}"
      echo
      echo "  In the Render Shell this target is PRODUCTION. These rows"
      echo "  are business-shaped and are NOT cleaned up afterwards."
      echo
      echo "  If that is what you intend, say so explicitly:"
      echo
      echo "      PSPINE_QA_WRITES_OK=1 bash $0"
      echo
      echo "  See docs/DB_CONNECTION_INVENTORY.md (Appendix G3-A)."
      echo
    } >&2
    exit 1
  fi

  echo "  db target: ${target}  · acknowledged via PSPINE_QA_WRITES_OK=1"
}
