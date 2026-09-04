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
//
//   contested                    overlapping non-terminal leases — which
//                                governs is unknown.
//   contractually_locked         a governed contractual fact spans the date.
//                                Under the opening-truth doctrine that is
//                                EITHER proof basis: native_verified (executed
//                                and funded through Spine) OR
//                                confirmed_opening_import (accepted as the
//                                property's opening contractual truth). These
//                                are different PROOFS of the same contractual
//                                state, not different states — so zero
//                                native-verified must never read as zero
//                                contractual truth.
//   covered_unproven             a lease spans the date but its proof basis is
//                                neither. It cannot be called locked. Zero on
//                                Demo today; retained so it can never be
//                                silently promoted.
//   successor_pending_not_locked a next lease exists but is merely pending. It
//                                must satisfy the governed execution-and-
//                                funding rule (or a future governed import
//                                equivalent proving an EXECUTED contract) to
//                                count. A pending record never locks.
//   open_or_uncovered            nothing covers the date.
//
//  ECONOMICS IS NOT A POSITION BUCKET. A position can be contractually locked
//  while its rent is unavailable. That is reported as a split WITHIN locked.
//
//  CONTRACTUAL COVERAGE ONLY — leases decide this, never the imported
//  occupancy claim, which is dated evidence about the import's own as-of date
//  and says nothing about an arbitrary future date.
const LOCKING_PROOFS = new Set(["native_verified", "confirmed_opening_import"]);

function futureState(p) {
  if (p.conflict_state === "conflicted") return "contested";

  const lease = p.lease;              // lease spanning the SELECTED date
  if (lease) {
    return LOCKING_PROOFS.has(p.proof_basis) ? "contractually_locked" : "covered_unproven";
  }
  //  A lease that has COMMENCED but whose economic tenancy is not yet active
  //  has no `current` lease on the position, so it read as open. It is the
  //  opposite of open: signed, started, awaiting move-in funds. Same case
  //  availability_read treats as activation_pending.
  const pend = p.activation_pending_lease_position;
  if (pend) {
    return LOCKING_PROOFS.has(pend.proof_basis || p.proof_basis) ? "contractually_locked" : "covered_unproven";
  }
  if (p.successor && p.successor.state === "locked") return "contractually_locked";
  if (p.successor && p.successor.state === "pending") return "successor_pending_not_locked";
  return "open_or_uncovered";
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

      // ECONOMICS IS A SEPARATE AXIS. A locked position with unavailable rent
      // stays locked; its rent simply is not known and is never coerced to $0.
      economics_state: p.economics_state,
      contractual_rent: p.lease && p.lease.rent != null ? Number(p.lease.rent) : null,

      // Only a contractually locked position with KNOWN rent contributes.
      locked_rent_known: state === "contractually_locked" && p.economics_state === "available" && p.lease
        ? Number(p.lease.rent) : 0,
      // Rent claimed by a position that is NOT locked. Exposure, never revenue.
      unlocked_rent_claim: state !== "contractually_locked" && p.economics_state === "available" && p.lease
        ? Number(p.lease.rent) : 0,
    };
  });

  const inState = (s) => rows.filter((r) => r.future_state === s);
  const locked = inState("contractually_locked");
  const coveredUnproven = inState("covered_unproven");
  const pending = inState("successor_pending_not_locked");
  const open = inState("open_or_uncovered");
  const contested = inState("contested");
  // Economics splits WITHIN locked — it is not a position bucket.
  // Split by the ECONOMICS AXIS, not by null-ness: a rent of 0 is unavailable,
  // not a known zero, and must never read as a position priced at nothing.
  const lockedKnown = locked.filter((r) => r.economics_state === "available");
  const lockedUnknown = locked.filter((r) => r.economics_state !== "available");

  return {
    property_id: dp.property_id,
    as_of: dp.as_of,
    basis: "contractual_facts_only",
    note: FACTS_ONLY_NOTE,
    opening_truth: dp.opening_truth,

    totals: {
      positions: rows.length,

      // POSITION BUCKETS — exactly one per position.
      contractually_locked: locked.length,
      covered_unproven: coveredUnproven.length,
      successor_pending_not_locked: pending.length,
      open_or_uncovered: open.length,
      contested: contested.length,

      // ECONOMICS SPLIT WITHIN LOCKED — not a bucket of its own.
      locked_with_known_economics: lockedKnown.length,
      locked_economics_unavailable: lockedUnknown.length,

      // The only economic total this service may produce.
      monthly_contractual_rent_known: money(locked.reduce((s, r) => s + r.locked_rent_known, 0)),

      // PROOF SPLIT OF THE LOCKED POSITIONS — different proofs of the same
      // contractual state, shown separately and never collapsed.
      locked_proof_split: {
        native_verified: locked.filter((r) => r.proof_basis === "native_verified").length,
        confirmed_opening_import: locked.filter((r) => r.proof_basis === "confirmed_opening_import").length,
      },

      // Everything NOT locked, shown as exposure rather than revenue.
      unlocked_rent_claims: {
        covered_unproven: money(coveredUnproven.reduce((s, r) => s + r.unlocked_rent_claim, 0)),
        successor_pending: 0,     // a pending successor carries no rent, by rule
        contested: money(contested.reduce((s, r) => s + r.unlocked_rent_claim, 0)),
      },

      proof_split_all_positions: {
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
