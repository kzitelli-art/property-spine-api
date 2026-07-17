// ════════════════════════════════════════════════════════════════════
//  execution_evidence.js — THE EXECUTION SEAM (v3 brief §8-C / §10)
//
//  CLASSIFICATION (volunteered, per doctrine):
//    · the resolver INTERFACE — Class 1 permanent primitive. This is the
//      one and only door through which "a governing lease was actually
//      executed" may ever enter the countersign path.
//    · the current always-null implementation — fail-closed. Replaced by
//      Path B (Executed Lease → Tenancy Anchor) when governed execution
//      evidence exists: e-sign completion or staff intake of an externally
//      executed lease, with immutable document identity, signer identity
//      and capacity, execution timestamps, hash + provenance, and
//      void/correction/supersession behavior. None of that exists today,
//      so this resolver says so.
//
//  THE RULE THIS FILE ENFORCES:
//    reviewed demonstration terms ≠ signed governing lease.
//    A terms acknowledgment, a packet submission, a satisfied obligation
//    input, a body-supplied object, a browser assertion — NONE of these
//    are execution evidence. countersignService calls this resolver as its
//    first substantive requirement; while this returns null, countersign
//    fails closed with 409 executed_lease_required, everywhere, for every
//    caller, with no argument any adapter can pass to change that.
//
//  Path B replaces the BODY of resolveVerifiedExecution — never its
//  position in the chain, never with a caller-suppliable bypass.
// ════════════════════════════════════════════════════════════════════

module.exports = function executionEvidenceModule() {
  // resolveVerifiedExecution(client, applicationId)
  //   → an execution-evidence record when a verified governing-lease
  //     execution exists for this application (Path B), else null.
  //   v3: no execution system exists → always null → countersign refuses.
  //   The signature takes `client` so Path B's implementation can read
  //   inside the caller's transaction; v3 deliberately touches nothing.
  async function resolveVerifiedExecution(client, applicationId) { // eslint-disable-line no-unused-vars
    return null;
  }

  return { resolveVerifiedExecution };
};
