// Canonical unit-level adapter for maintenance workflows that need a proven
// future move-in. It consumes dated positions, where execution, move-in funds,
// terminal leases, and conflicts have already been classified.

"use strict";

const { datedPropertyPositions } = require("../tenancy/dated_positions");

const ymd = (d) => {
  if (!d) return null;
  if (d instanceof Date) return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
  return String(d).slice(0, 10);
};

async function readNextCommittedMoveIn(db, { unit_id, property_id = null, as_of = null } = {}) {
  if (!unit_id) throw new Error("readNextCommittedMoveIn requires unit_id");

  let propertyId = property_id;
  if (!propertyId) {
    const unit = (await db.query("select property_id from units where id=$1", [unit_id])).rows[0];
    if (!unit) return null;
    propertyId = unit.property_id;
  }

  const asOf = as_of || new Date().toISOString().slice(0, 10);
  const positions = await datedPropertyPositions(db, { property_id: propertyId, as_of: asOf });
  const unitPositions = positions.positions.filter((p) => String(p.unit_id) === String(unit_id));

  // A conflict means no lease may be selected as governing truth.
  if (unitPositions.some((p) => p.conflict_state === "conflicted")) return null;

  const candidates = unitPositions
    .map((p) => ({
      space_id: p.space_id,
      space_label: p.space_label,
      commitment: p.future_commitment,
    }))
    .filter((p) => p.commitment && p.commitment.state === "locked")
    .map((p) => ({ ...p, start_date: ymd(p.commitment.start_date) }))
    .filter((p) => p.start_date && p.start_date > asOf)
    .sort((a, b) => a.start_date.localeCompare(b.start_date));

  if (!candidates.length) return null;
  const next = candidates[0];
  return {
    lease_id: next.commitment.lease_id,
    space_id: next.space_id,
    space_label: next.space_label,
    move_in_date: next.start_date,
    days_remaining: Math.round(
      (Date.parse(next.start_date + "T00:00:00Z") - Date.parse(asOf + "T00:00:00Z")) / 86400000
    ),
    commitment_state: "locked",
    proof_basis: next.commitment.proof_basis,
  };
}

module.exports = { readNextCommittedMoveIn };
