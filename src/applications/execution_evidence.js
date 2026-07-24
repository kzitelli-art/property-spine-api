// ════════════════════════════════════════════════════════════════════
//  execution_evidence.js — THE EXECUTION SEAM (v3 brief §8-C / §10)
//
//  CLASSIFICATION (volunteered, per doctrine):
//    · the resolver INTERFACE — Class 1 permanent primitive. This is the
//      one and only door through which "a governing lease was actually
//      executed" may ever enter the term-confirmation path.
//    · the BODY — as of migration 088, reads executed_lease_records.
//      Path B is implemented. A future e-signature provider feeds that
//      SAME table through executed_lease_service; it does not create a
//      second lease-execution architecture and does not change this
//      resolver's position in the chain.
//
//  THE RULE THIS FILE ENFORCES (unchanged):
//    reviewed proposed terms ≠ signed governing lease.
//    A terms acknowledgment, a packet submission, a satisfied obligation
//    input, a body-supplied object, a browser assertion — NONE of these
//    are execution evidence. Only a verified executed_lease_records row,
//    written by the canonical intake service behind its own activation
//    gate, satisfies this resolver.
//
//  WHY THIS IS STRUCTURALLY SAFE:
//    resolveVerifiedExecution takes (client, applicationId) and NOTHING
//    ELSE. No caller-suppliable argument reaches it. A route cannot pass
//    a document, a flag, or an "already verified" assertion. The only way
//    to make this return non-null is to have recorded a verified row.
//
//  While EXECUTED_LEASE_INTAKE_ENABLED is off, no record can be created,
//  so this returns null and the tail behaves exactly as it did before 088.
// ════════════════════════════════════════════════════════════════════

const { resolveVerifiedExecutionRecord } = require("./executed_lease_service");

module.exports = function executionEvidenceModule() {
  // resolveVerifiedExecution(client, applicationId)
  //   → the live verified execution-evidence record for this application,
  //     or null. Reads inside the caller's transaction.
  async function resolveVerifiedExecution(client, applicationId) {
    return await resolveVerifiedExecutionRecord(client, applicationId);
  }

  return { resolveVerifiedExecution };
};
