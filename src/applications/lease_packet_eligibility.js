// ════════════════════════════════════════════════════════════════════
//  lease_packet_eligibility.js — MAY A RESIDENT REVIEW PACKET BE CREATED
//  FOR THIS APPLICATION, RIGHT NOW?
//
//  A PRESENT-TENSE WORKFLOW QUESTION. It is NOT:
//    · inventory authority        — a packet reserves no space
//    · historical approval evidence — approved_at being non-null proves an
//                                   application was once approved, not that a
//                                   packet may be created today
//    · future-lease proof         — no lease exists at this point
//    · economic tenancy           — that is three governed steps later
//
//  ── THE RULE WAS PROVEN FROM EXISTING WRITES, NOT INVENTED ───────────
//  generateLeasePacket already enforced exactly this much:
//
//      status in ('lease_ready','tenant_signed','approved')
//      AND (terms_review_obligation_id OR activation_obligation_id)
//      AND proposed_terms_confirmation_id
//      AND no existing packet that forbids another
//
//  That is the real rule and it is preserved byte-for-byte in effect. What was
//  wrong was HOW it was expressed, not what it decided:
//
//   1. A HAND-MAINTAINED PRIVATE STATUS LIST. The same defect class Pass 1
//      corrected everywhere else. It is now DERIVED from the canonical
//      APPROVAL_REACHED group by naming the exclusions and why each one is
//      excluded — so a change to canonical vocabulary reaches here instead of
//      silently diverging from it.
//
//   2. FOUR DISTINCT BLOCKERS COLLAPSED INTO ONE CODE. Everything returned
//      'application_not_approved' with the message "approve it first" — including
//      a WITHDRAWN application, where that sentence is simply false, and a
//      missing terms confirmation, which has nothing to do with approval. Each
//      blocker now has its own reason_code.
//
//   3. NO NAMED PREDICATE. The rule was inline, so nothing else could ask the
//      same question without copying it.
//
//  ── WHY NOT APPROVAL_REACHED WHOLESALE ───────────────────────────────
//  APPROVAL_REACHED is ["approved","lease_ready","tenant_signed",
//  "countersigned","accepted_term_required","active"]. Using it whole would
//  make an ACTIVE tenancy packet-eligible. Historical approval is not present
//  eligibility: an application that reached approval and then moved on, or was
//  withdrawn, expired or declined, must not become packet-eligible because a
//  timestamp survives on the row.
//
//  NO NEW LIFECYCLE LADDER IS AUTHORED HERE. This is one predicate over the
//  canonical vocabulary plus the facts already loaded at the call site.
// ════════════════════════════════════════════════════════════════════

"use strict";

const { APPROVAL_REACHED, TERMINAL } = require("./application_lifecycle");

// ── THE EXCLUSIONS, EACH WITH ITS REASON ─────────────────────────────
//  Derived from APPROVAL_REACHED rather than typed out, so canonical
//  vocabulary changes reach this rule.
const EXCLUDED_FROM_PACKET = Object.freeze({
  // The packet has already been countersigned past. Generating one now would
  // be re-opening a completed step, not preparing a pending one.
  countersigned: "the lease has already been countersigned",
  // The term has been accepted and a lease already exists (confirm-term wrote
  // it). Inventory is committed; a review packet is no longer the open step.
  accepted_term_required: "a lease term has already been accepted",
  // Economic tenancy is active. Three governed steps past a review packet.
  active: "the tenancy is already active",
});

const PACKET_ELIGIBLE_STATUSES = Object.freeze(
  APPROVAL_REACHED.filter((s) => !(s in EXCLUDED_FROM_PACKET))
);

// Existing-packet states that forbid another without an explicit new version.
const PACKET_ISSUED_STATES = Object.freeze(["sent", "in_progress", "tenant_in_progress"]);

const REASON = Object.freeze({
  ELIGIBLE:              "eligible",
  TERMINAL:              "application_terminal",
  STATUS_NOT_ELIGIBLE:   "application_status_not_eligible",
  NO_GATE:               "no_open_terms_or_activation_gate",
  NO_TERMS:              "no_current_proposed_terms_confirmation",
  ALREADY_SUBMITTED:     "packet_already_submitted",
  ALREADY_ISSUED:        "packet_already_issued",
  NOT_AT_PROPERTY:       "not_permitted",
});

/**
 * assessLeasePacketEligibility(application, facts)
 *
 * @param application  the lease_applications row (already locked by the caller)
 * @param facts        { existingPacket, expectedPropertyId, createNewVersion }
 * @returns {
 *   eligible, reason_code, message,
 *   current_status, existing_packet_id, required_fact_missing
 * }
 */
function assessLeasePacketEligibility(application, facts = {}) {
  const { existingPacket = null, expectedPropertyId = null, createNewVersion = false } = facts;
  const status = application ? application.status : null;

  const out = (reason_code, message, extra = {}) => ({
    eligible: reason_code === REASON.ELIGIBLE,
    reason_code,
    message,
    current_status: status,
    existing_packet_id: existingPacket ? existingPacket.id : null,
    required_fact_missing: null,
    ...extra,
  });

  // Property lineage first — an out-of-scope application is not a workflow
  // question at all.
  if (expectedPropertyId && String(application.property_id) !== String(expectedPropertyId)) {
    return out(REASON.NOT_AT_PROPERTY, "This action is not permitted.");
  }

  // TERMINAL BEFORE STATUS. A withdrawn application is not "not yet approved",
  // and telling an operator to approve it first is a false instruction.
  if (TERMINAL.includes(status)) {
    return out(REASON.TERMINAL,
      `This application is ${status} — a resident review packet cannot be created for it.`);
  }

  if (!PACKET_ELIGIBLE_STATUSES.includes(status)) {
    const why = EXCLUDED_FROM_PACKET[status];
    return out(REASON.STATUS_NOT_ELIGIBLE,
      why
        ? `A resident review packet is no longer the open step — ${why}.`
        : "This application has not reached the point where a resident review packet is prepared.");
  }

  // The open gate the packet is prepared against. Present tense: the gate must
  // be open NOW, not have existed once.
  if (!application.terms_review_obligation_id && !application.activation_obligation_id) {
    return out(REASON.NO_GATE,
      "There is no open terms-review or activation commitment on this application to prepare a packet against.",
      { required_fact_missing: "terms_review_obligation_id|activation_obligation_id" });
  }

  if (!application.proposed_terms_confirmation_id) {
    return out(REASON.NO_TERMS,
      "Confirm the proposed terms before generating the resident review packet.",
      { required_fact_missing: "proposed_terms_confirmation_id" });
  }

  // The existing-packet rules are unchanged in effect and keep their operator
  // copy verbatim — that language is about frozen evidence and governed
  // correction, and is worth more than a shorter sentence.
  if (existingPacket && existingPacket.status === "submitted") {
    return out(REASON.ALREADY_SUBMITTED,
      "This packet was acknowledged — it is frozen evidence. Terms changes after "
      + "acknowledgment are a governed correction (Path B), never a regeneration.");
  }
  if (existingPacket && PACKET_ISSUED_STATES.includes(existingPacket.status) && !createNewVersion) {
    return out(REASON.ALREADY_ISSUED,
      "This packet was already issued — it will not be silently regenerated. Create a "
      + "governed new version to issue changed terms; the prior version remains evidence.");
  }

  return out(REASON.ELIGIBLE, "A resident review packet may be prepared.");
}

module.exports = {
  assessLeasePacketEligibility,
  PACKET_ELIGIBLE_STATUSES,
  EXCLUDED_FROM_PACKET,
  PACKET_ISSUED_STATES,
  REASON,
};
