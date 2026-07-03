// ════════════════════════════════════════════════════════════════════
//  dormant_gate.js — THE FAIL-CLOSED COMMITMENT-WRITE GATE
//
//  "Unwired frontend" is not a dormancy control. A direct HTTP call, an
//  internal integration, an accidental admin action, or a developer
//  troubleshooting can all still reach a mutating route. Property-wall
//  proof shows a correctly-identified operator cannot cross a boundary;
//  it does NOT make the write path impossible while the identity bridge
//  and actor binding remain unresolved.
//
//  So: a server-side gate that makes commitment WRITES impossible while
//  COMMITMENT_LEDGER_MODE=dormant. The contract:
//    · every mutable capture / communicate / countersign / grant /
//      publish route fails closed (deterministic 403);
//    · read-only surfaces (follow-ups, pricing read, offer/incident GET)
//      remain available;
//    · THE GUARD RUNS FIRST — before request-body actor identifiers,
//      before property resolution, before any ledger/DB invocation;
//    · leaving dormant requires an explicit env/config change and a
//      separate release decision. Default is dormant (fail-closed even
//      if the env var is unset or malformed).
//
//  This is the difference between "not surfaced" and "cannot be used."
//
//  Mode resolution (fail-closed):
//    COMMITMENT_LEDGER_MODE === 'enabled'  → writes allowed
//    anything else (unset, 'dormant', typo) → writes blocked
// ════════════════════════════════════════════════════════════════════

function resolveMode() {
  // fail-closed: only the exact string 'enabled' opens writes.
  return process.env.COMMITMENT_LEDGER_MODE === "enabled" ? "enabled" : "dormant";
}

// A guard that blocks a mutating handler when dormant. Mount it as the
// FIRST middleware on every commitment-write route, so nothing downstream
// (body parsing of actor ids, property lookups, service calls) runs.
function dormantWriteGuard(req, res, next) {
  if (resolveMode() === "enabled") return next();
  // deterministic, no side effects, no DB, no actor resolution.
  return res.status(403).json({
    error: "commitment_ledger_dormant",
    code: "LEDGER_DORMANT",
    receipt: "The Commitment Ledger is deployed in DORMANT mode: no offer, concession incident, obligation, grant, pricing publication, or countersign can be created. Enabling requires an explicit COMMITMENT_LEDGER_MODE change and a separate release decision.",
  });
}

module.exports = { resolveMode, dormantWriteGuard };
