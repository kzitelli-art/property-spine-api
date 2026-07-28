// ════════════════════════════════════════════════════════════════════
//  application_fee_decision.js — ONE DECISION, NOT A CONFIGURATION PAGE
//
//  Everything ownership needs to answer one question:
//    "Should Property Spine govern the application fee as $50 per applicant
//     for new-lease applications?"
//
//  ── THE SHAPE IS THE POINT ───────────────────────────────────────────
//  The primary block carries the amount, what it applies to, what the AI says
//  now, and what it will say after. Digests, source ids, authority receipts
//  and proposal hashes are real and necessary — and they live under `audit`,
//  because an operator deciding a price should not have to read a schema to
//  find the number.
//
//  ── THE STATE MACHINE IS SERVER-SIDE ─────────────────────────────────
//  draft → approved → published → cutover_ready → live → (rejected)
//  The browser renders the state; it never computes it. A UI that decided
//  "this looks publishable" would be a second opinion about publishability.
//
//  READ-ONLY. Approval and publication are separate explicit actions.
// ════════════════════════════════════════════════════════════════════

"use strict";

const { resolveActorContext } = require("../identity/actor_context");
const { governedCharges } = require("./governed_charges");

const CHARGE_CODE = "fee.application";
const LEGACY_FACT = "pricing_application_fee";

const STATES = ["draft", "approved", "published", "cutover_ready", "live", "rejected", "unavailable"];

async function applicationFeeDecision(pool, { property_id, user_id = null } = {}) {
  if (!property_id) throw new Error("applicationFeeDecision requires property_id");

  let charges, legacy, actor;
  try {
    charges = await governedCharges(pool, { property_id, include_drafts: true });
    legacy = (await pool.query(
      `select fact_key, rendered_text, status, source_type, confirmed_at
         from agent_facts where property_id=$1 and fact_key=$2`, [property_id, LEGACY_FACT])).rows[0] || null;
    actor = user_id ? await resolveActorContext(pool, { user_id, property_id }) : null;
  } catch (e) {
    // A failed read is UNAVAILABLE. It must never render as "no fee" or as a
    // sample value — an operator would approve a number that does not exist.
    return { state: "unavailable", question: null,
             detail: "The current economic terms could not be read, so this decision cannot be shown.",
             error_is_not_absence: true };
  }

  const governed = [...(charges.one_time_fees || [])].find((c) => c.charge_code === CHARGE_CODE) || null;
  const legacyLive = !!(legacy && legacy.status === "active");

  // ── the state, decided here and only here ─────────────────────────
  let state = "draft";
  if (!governed) state = "unavailable";
  else if (governed.record_state === "retired") state = "rejected";
  else if (governed.record_state === "active" && !legacyLive) state = "live";
  else if (governed.record_state === "active" && legacyLive) state = "cutover_ready";
  else if (governed.approved_at) state = "approved";

  const mayApprove = !!(actor && actor.ok && actor.capabilities.may_publish_pricing);

  return {
    // ── THE DECISION ────────────────────────────────────────────────
    question: "Should Property Spine govern the application fee as $50 per applicant " +
              "for new-lease applications?",
    state,
    amount: governed ? governed.amount : 50,
    amount_display: "$50",
    economic_class: "one-time fee",
    applies_to: "New-lease application",
    basis: "Per applicant",
    effective_date: governed ? governed.effective_from : null,

    // ── WHAT CHANGES, IN PLAIN LANGUAGE ─────────────────────────────
    // Once the term is LIVE the before/after is history, not a proposal.
    // Leaving it as "after you approve" would ask an operator to approve
    // something already in use.
    today: {
      label: state === "live" ? "The assistant said before" : "The assistant says today",
      source: "Legacy property fact" + (legacyLive ? "" : " (retired)"),
      the_ai_says: legacy ? legacy.rendered_text : null,
      is_live: legacyLive,
    },
    after_cutover: {
      label: state === "live" ? "The assistant says now" : "After you approve",
      source: "Governed application fee",
      the_ai_will_say: "The application fee is $50 per applicant.",
      legacy_retires: legacyLive,
      legacy_retires_when: "In the same release that the assistant switches over — never before, " +
                           "never after.",
    },

    // ── WHAT IS NOT CHANGING ────────────────────────────────────────
    unchanged: [
      "Rent — no pricing version is published",
      "Administration fee — still awaiting its own decision",
      "Recurring charges — parking, pet rent, wifi, insurance",
      "Deposit requirements",
      "Concessions — none active",
    ],

    unresolved_issues: governed && governed.amount == null
      ? [governed.amount_unresolved_reason] : [],

    // ── THE ACTION ──────────────────────────────────────────────────
    actions: {
      // A LIVE term is not awaiting a decision. Offering approve/reject on
      // something already in use invites re-deciding a settled thing.
      may_approve: mayApprove && state !== "live",
      may_modify: mayApprove && state !== "live",
      may_reject: mayApprove && state !== "live",
      // Operator-facing copy. The machine reason is real and stays in `audit`;
      // a person told "session_identity_not_linked_to_a_person" learns nothing
      // and cannot tell whether to ask for access or ask someone else.
      denied_reason: (mayApprove && state === "live")
        ? "This is live and governed. Changing it means superseding it with a new decision."
        : mayApprove ? null : (
        !actor ? "Sign in to decide this."
        : actor.reconciliation_required
          ? "Your sign-in isn’t linked to a staff record yet. That’s an account setup step — ask an administrator to link it, then this decision becomes available."
          : "You don’t have pricing authority for this property. Someone with an owner or asset-manager role here can decide it."),
      denied_code: mayApprove ? null : (actor && actor.failure_reason) || "no_session",
      approve_label: "Approve — govern this fee at $50",
      modify_label: "Modify — return to preview",
      reject_label: "Reject — keep the current source",
    },

    // ── EVERYTHING ELSE, BEHIND A DISCLOSURE ────────────────────────
    audit: {
      governed_charge_id: governed ? governed.charge_id : null,
      charge_code: CHARGE_CODE,
      record_state: governed ? governed.record_state : null,
      source_provenance: governed ? governed.source_provenance : null,
      legacy_fact_key: LEGACY_FACT,
      legacy_status: legacy ? legacy.status : null,
      legacy_source_type: legacy ? legacy.source_type : null,
      obligation: governed ? governed.obligation : null,
      cadence: governed ? governed.cadence : null,
      refundable: governed ? governed.refundable : null,
      applicability_basis: governed ? governed.applicability_basis : null,
      incurred_on_event: governed ? governed.incurred_on_event : null,
      quotable_precisely: governed ? governed.quotable_precisely : false,
      not_quotable_reason: governed ? governed.not_quotable_reason : null,
      acting_user: actor && actor.user ? actor.user.display_name : null,
      acting_person: actor && actor.person ? actor.person.display_name : null,
      authority_basis: actor && actor.basis ? actor.basis.may_publish_pricing : null,
      property_id,
      denied_code: (actor && !actor.capabilities.may_publish_pricing) ? actor.failure_reason : null,
    },

    proof: {
      state_decided_server_side: true,
      publishes_nothing_on_read: true,
      other_classes_untouched: true,
    },
  };
}

module.exports = { applicationFeeDecision, CHARGE_CODE, LEGACY_FACT, STATES };
