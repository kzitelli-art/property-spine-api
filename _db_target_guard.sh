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
#  Phase 1 audit (docs/DB_CONNECTION_INVENTORY.md, Appendix G3-A) they
#  were the largest remaining coverage gap: standalone,
#  production-capable, unguardable by construction.
#
#  THE BOUNDARY THIS ENFORCES
#  Production access is permitted only as an explicit, informed, narrowly
#  scoped operational act. A blanket "never touch production" rule would
#  be the wrong control — these scripts are MEANT to run in the Render
#  Shell against Demo Building, which the architecture recognises as a
#  legitimate isolated demo context. The requirement is that they remain
#  constrained demo infrastructure, not an unrestricted production
#  writer.
#
#      recognised production database
#      + exact Demo Building property
#      + explicit per-run acknowledgement
#      → proceed
#
#      unknown/unparseable database
#      or non-Demo property
#      or missing/stale acknowledgement
#      → refuse before operating
#
#  The property is PINNED HERE, not in the calling script, and the
#  caller's property is checked against this pin. Editing `DEMO=` in a
#  script to point at Solo does not get past this file. The property is
#  never taken from an environment variable or a command-line argument.
#
#  The acknowledgement is per-SCRIPT (not one universal
#  ALLOW_PRODUCTION) and per-RUN: it must carry today's UTC date, so a
#  value exported into a shell profile or Render's permanent environment
#  stops working within a day rather than silently persisting.
#
#  CLASS 2 (permanent). No removal condition — the gap it closes is
#  structural, not transitional.
# ════════════════════════════════════════════════════════════════════

# Fail on error and — the point of row 4 in the false-green inventory — on
# ANY failing stage of a pipeline. Without pipefail a `curl … | head`
# reports head's success and the calling script's `set -e` never fires.
# Callers must not pipe a producer into an early-exiting consumer;
# capture and slice instead (see the callers for the pattern).
set -o pipefail

# The ONE property these scripts may operate on. Pinned here deliberately:
# a caller cannot widen it, and no environment variable can reach it.
_PSPINE_DEMO_BUILDING="a50fbdd0-3642-431e-b532-0dcd6ab8a4fe"

_pspine_refuse() {
  { echo; echo "  ════════════════════════════════════════════════════════"
    echo "  REFUSED — $1"
    echo "  ════════════════════════════════════════════════════════"; echo
    shift
    for line in "$@"; do echo "  $line"; done
    echo
    echo "  See docs/DB_CONNECTION_INVENTORY.md (Appendix G3-A)."
    echo
  } >&2
  exit 1
}

# Render host[:port]/database from a connection string WITHOUT the
# password: strip scheme, then credentials, then any query string.
_pspine_db_identity() {
  printf '%s' "${1:-}" | sed -E 's#^[a-zA-Z+]+://##; s#^[^@/]*@##; s#\?.*$##'
}

# pspine_require_db_target <ack-var-name> <property-id> <what-gets-written>
#
# Refuses unless ALL of: a parseable database target, the pinned Demo
# Building property, and a current per-run acknowledgement naming both.
pspine_require_db_target() {
  local ack_var="$1" property="$2" what="$3"

  # ── 1. a target must exist ──────────────────────────────────────────
  if [ -z "${DATABASE_URL:-}" ]; then
    _pspine_refuse "DATABASE_URL is not set." \
      "This script writes ${what} directly through psql." \
      "It has no target and will not guess one."
  fi

  # ── 2. it must parse completely — fail closed, never assume ─────────
  local target host db
  target="$(_pspine_db_identity "$DATABASE_URL")"
  host="${target%%/*}"
  db="${target#*/}"
  if [ -z "$target" ] || [ "$host" = "$target" ] || [ -z "$host" ] || [ -z "$db" ]; then
    _pspine_refuse "the connection target could not be parsed." \
      "parsed: '${target}'" \
      "A target that cannot be identified cannot be acknowledged, so this" \
      "refuses rather than proceeding against an unknown database."
  fi

  # ── 3. the property is pinned — checked BEFORE the acknowledgement, ──
  #       so no acknowledgement can widen it.
  if [ "$property" != "$_PSPINE_DEMO_BUILDING" ]; then
    _pspine_refuse "this script may only operate on Demo Building." \
      "requested: ${property}" \
      "permitted: ${_PSPINE_DEMO_BUILDING}  (Demo Building)" \
      "" \
      "These scripts write business-shaped rows and do not clean up. They" \
      "are demo infrastructure and are not a general production writer." \
      "No acknowledgement overrides this — change the pin in" \
      "_db_target_guard.sh only through review."
  fi

  # ── 4. explicit, per-script, per-run acknowledgement ────────────────
  local today expected actual
  today="$(date -u +%Y-%m-%d)"
  expected="${property}:${today}"
  actual="$(eval "printf '%s' \"\${${ack_var}:-}\"")"

  if [ "$actual" != "$expected" ]; then
    _pspine_refuse "this script writes to a live database." \
      "target:  ${host}/${db}" \
      "property: ${property}  (Demo Building)" \
      "writes:  ${what}" \
      "" \
      "In the Render Shell this target is PRODUCTION. These rows are" \
      "business-shaped and are NOT cleaned up afterwards." \
      "" \
      "If that is what you intend, acknowledge it for THIS run:" \
      "" \
      "    ${ack_var}=\"${expected}\" bash $0" \
      "" \
      "The acknowledgement names the property and carries today's UTC" \
      "date on purpose: it is per-run, and a value exported into a shell" \
      "profile or Render's environment stops working tomorrow."
  fi

  echo "  db target: ${host}/${db}"
  echo "  property:  ${property}  (Demo Building, pinned)"
  echo "  ack:       ${ack_var} accepted for ${today}"
}
