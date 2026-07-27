// ════════════════════════════════════════════════════════════════════
//  future_rent_roll_facts.js — FUTURE RENT ROLL, CONTRACTUAL FACTS ONLY
//
//  The same canonical dated positions, read at a SELECTED FUTURE DATE.
//  Current Rent Roll and Future Rent Roll are not two models; they are one
//  derivation at two dates. Facts at a later date replace facts at an
//  earlier one by RECOMPUTATION — never by stored cleanup.
//
//  FACTS ONLY. This service deliberately cannot express a projection:
//   · a successor is locked ONLY under the governed executed-and-funded
//     rule. A 'pending' lease_status never closes an economic position.
//   · pending successors contribute ZERO locked rent and ZERO projected rent.
//   · open and contested positions contribute ZERO locked rent.
//   · no pricing assumption fills an uncovered position.
//   · no renewal rate, no occupancy goal, no "need to 95%", and nothing
//     spreadsheet-derived survives anywhere in this read.
//
//  The Expected Future Rent Roll — locked facts PLUS governed pricing PLUS
//  approved assumptions — is a later, separate calculation that will consume
//  these same position rows. It is not this file, and adding assumptions
//  here would recreate the exact split this convergence removed.
//
//  WRITES NOTHING.
// ════════════════════════════════════════════════════════════════════

"use strict";

const { datedPropertyPositions } = require("../tenancy/dated_positions");

const money = (n) => Math.round(Number(n || 0) * 100) / 100;

const FACTS_ONLY_NOTE =
  "Contractual facts only. Expected projections are unavailable until governed pricing and assumptions are published.";

// A position's FUTURE state on the selected date. Exactly one, by precedence.
//   contested            overlapping non-terminal leases — governs unknown
//   evidence_unavailable the position exists but its occupancy evidence
//                        disagrees, or its economics are missing
//   locked               a lease governs the date AND it is executed+funded,
//                        or its successor is
//   successor_pending    a next lease exists but is not executed+funded
//   open                 nothing covers the date
// CONTRACTUAL COVERAGE ONLY — leases decide this, never the imported claim.
// The imported occupancy claim is DATED EVIDENCE about the import's own as-of
// date. It says nothing about an arbitrary future date, so letting it classify
// a future position manufactures "unresolved" for positions that are simply
// uncovered later. It is still reported per row, as evidence, beside the state.
function futureState(p) {
  if (p.conflict_state === "conflicted") return "contested";

  const lease = p.lease;              // lease spanning the SELECTED date
  if (lease) {
    if (p.proof_basis === "native_verified") return "locked";
    if (p.economics_state === "unavailable") return "covered_economics_unknown";
    return "covered_not_locked";      // a lease governs, but proof is opening-import or unproven
  }
  if (p.successor && p.successor.state === "locked") return "locked";
  if (p.successor && p.successor.state === "pending") return "successor_pending";
  return "open";                      // uncovered on this date. Not "unknown".
}

async function futureRentRollFacts(pool, { property_id, as_of = null } = {}) {
  const dp = await datedPropertyPositions(pool, { property_id, as_of });
  const rows = dp.positions.map((p) => {
    const state = futureState(p);
    return {
      space_id: p.space_id,
      unit_id: p.unit_id,
      unit_number: p.unit_number,
      space_label: p.space_label,
      position_kind: p.position_kind,

      future_state: state,
      lease_id: p.lease ? p.lease.lease_id : null,
      lease_end: p.lease ? p.lease.end_date : null,
      successor_state: p.successor.state,
      successor_lease_id: p.successor.lease_id,
      successor_proof_basis: p.successor.proof_basis,
      proof_basis: p.proof_basis,
      conflict_state: p.conflict_state,
      // evidence, reported beside the state — never classifying it
      imported_occupancy_claim: p.imported_occupancy_claim,
      evidence_state: p.evidence_state,

      // LOCKED RENT: only a position whose governing lease is executed AND
      // funded contributes. Everything else contributes zero — explicitly,
      // as a number, so the reader can see the zero was decided not missed.
      locked_rent: state === "locked" && p.lease && p.lease.rent != null ? Number(p.lease.rent) : 0,
      // The rent a position WOULD carry if its evidence resolved. Reported
      // separately and never added to a locked total.
      unlocked_rent_claim: state !== "locked" && p.lease && p.lease.rent != null ? Number(p.lease.rent) : 0,
    };
  });

  const inState = (s) => rows.filter((r) => r.future_state === s);
  const locked = inState("locked");
  const coveredNotLocked = inState("covered_not_locked");
  const pending = inState("successor_pending");
  const open = inState("open");
  const contested = inState("contested");
  const unavailable = inState("evidence_unavailable"); // retained: zero by construction now
  // A lease governs the date but its contractual rent is unknown. Covered, and
  // separately incomplete — never folded into locked, never coerced to $0.
  const economicsUnknown = inState("covered_economics_unknown");

  return {
    property_id: dp.property_id,
    as_of: dp.as_of,
    basis: "contractual_facts_only",
    note: FACTS_ONLY_NOTE,
    opening_truth: dp.opening_truth,

    totals: {
      positions: rows.length,
      locked: locked.length,
      covered_not_locked: coveredNotLocked.length,
      successor_pending: pending.length,
      open: open.length,
      contested: contested.length,
      evidence_unavailable: unavailable.length,
      covered_economics_unknown: economicsUnknown.length,

      // The only economic total this service may produce.
      locked_rent: money(locked.reduce((s, r) => s + r.locked_rent, 0)),

      // Everything that is NOT locked, shown as exposure rather than revenue.
      unlocked_rent_claims: {
        covered_not_locked: money(coveredNotLocked.reduce((s, r) => s + r.unlocked_rent_claim, 0)),
        successor_pending: 0,     // a pending successor carries no rent, by rule
        contested: money(contested.reduce((s, r) => s + r.unlocked_rent_claim, 0)),
        evidence_unavailable: money(unavailable.reduce((s, r) => s + r.unlocked_rent_claim, 0)),
      },

      proof_split: {
        native_verified: rows.filter((r) => r.proof_basis === "native_verified").length,
        confirmed_opening_import: rows.filter((r) => r.proof_basis === "confirmed_opening_import").length,
        unproven: rows.filter((r) => r.proof_basis === "unproven").length,
        no_lease: rows.filter((r) => !r.proof_basis).length,
      },
    },

    // Deliberately absent and named so their absence is a decision, not an
    // oversight: projected_occupancy, assumed_renewals, assumed_new_leasing,
    // assumption_revenue, occupancy_goal.
    projections_unavailable: {
      reason: "no_governed_pricing_or_assumptions",
      requires: ["published property pricing version", "approved assumption set", "lease origin classification"],
    },

    rows,
  };
}

module.exports = { futureRentRollFacts, futureState, FACTS_ONLY_NOTE };
