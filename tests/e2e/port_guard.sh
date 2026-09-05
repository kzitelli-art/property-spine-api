# ════════════════════════════════════════════════════════════════════
#  ONE definition of "is the test port free", sourced by boot.sh and by
#  every caller that boots a server.
#
#  WHY IT IS SHARED AND WHY IT IS CHECKED BEFORE LAUNCH. The first
#  version of this guard lived only in boot.sh, and the callers merely
#  polled /health afterwards. That loses a race it cannot win: a stale
#  server on the same port answers /health INSTANTLY, so the caller sees
#  200 on its first attempt and adopts a server it did not start, running
#  the entire suite against a database it knows nothing about. Observed,
#  not theorised — a full suite ran that way, and one proof PASSED.
#
#  A liveness check on the child is not enough either: the child may not
#  be reaped yet when the impostor's 200 arrives. The only deterministic
#  answer is to refuse BEFORE launching. Hence: callers ask first.
#
#  ss is not present on every machine this runs on (it is absent from
#  some minimal images and from some PATHs), so a /health probe is the
#  fallback and neither is trusted alone.
# ════════════════════════════════════════════════════════════════════
port_busy () {  # $1 = port
  local p="${1:-3000}"
  node "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/proof_boundary.js" port-free "$p" >/dev/null 2>&1 && return 1
  return 0
}

port_busy_message () {  # $1 = port
  local p="${1:-3000}"
  echo "  Something is already listening on port $p."
  echo "  A test server must be the one WE started, or a green proves"
  echo "  nothing about the database under test. Identify its owner first;"
  echo "  this runner will not kill or adopt that process."
}
