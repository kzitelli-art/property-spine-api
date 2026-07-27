// ════════════════════════════════════════════════════════════════════
//  rent_roll_canonical.js — CURRENT RENT ROLL, CANONICAL READ
//
//  One canonical property-position classification serves four reads of the
//  same truth over time: Current Rent Roll (today), Renewals (upcoming
//  expirations), Future Rent Roll (a selected date) and Availability.
//  This module is the FIRST of those reads. It adds only its own operating
//  context and aggregation; it never redefines a shared fact.
//
//  Positions ARE the rows — one per space, from classifyPosition. There is
//  no join. The previous read used imported rows as its spine and treated
//  canonical truth as an overlay, matched by unit_number string equality;
//  that inversion is what this replaces.
//
//  IMPORTS REMAIN. They are provenance, opening truth and reconciliation
//  evidence — never deleted, never silently overwritten, and never the row
//  structure of the operating read.
//
//  ── THE AGGREGATION CONTRACT ────────────────────────────────────────
//  A position contributes to a headline economic total AT MOST ONCE.
//  Every position resolves to exactly one aggregation_state, by precedence:
//
//    contested                     two non-terminal leases overlap. Which
//                                  lease governs is unknown, so the position
//                                  is EXCLUDED from trusted contractual rent
//                                  and its competing claims are returned
//                                  separately with the rent they implicate.
//                                  We never pick one lease silently.
//    down_non_revenue              structurally not earning.
//    occupancy_evidence_disagrees  the contracted occupancy axis and the
//                                  lease evidence do not agree, in either
//                                  direction. NOT confirmed vacant, and NOT
//                                  contractually occupied without a spanning
//                                  lease. It stays in the leasable
//                                  denominator and is reported beside the
//                                  occupancy figure so no clean percentage
//                                  implies it is resolved.
//    economics_unavailable         a spanning lease exists, but no rent. The
//                                  position is occupied; it contributes zero
//                                  to rent rather than a silent zero.
//    contractually_occupied        spanning lease, agreeing axis, real rent.
//                                  The ONLY state that feeds trusted rent.
//    confirmed_vacant              no lease, and the axis agrees it is empty.
//
//  Occupancy numerator = contractually_occupied + economics_unavailable
//  (both genuinely hold a spanning lease). Rent total = contractually_
//  occupied only. That is how one position contributes to occupancy without
//  contributing a phantom dollar.
//
//  WRITES NOTHING.
// ════════════════════════════════════════════════════════════════════

"use strict";

const { spacePosition } = require("../tenancy/space_position");

const NON_REVENUE_OCCUPANCY = new Set(["model", "down"]);

function money(n) { return Math.round(Number(n || 0) * 100) / 100; }

// The imported/contracted occupancy axis, reported verbatim and never
// reinterpreted (the two-axis rule availability.js sets out).
function claimSaysOccupied(claim) { return String(claim || "").toLowerCase() === "occupied"; }
function claimSaysVacant(claim) { return String(claim || "").toLowerCase() === "vacant"; }

function aggregationState(p, isDown) {
  const lease = p.current_lease_position;
  const claim = p._compat_occupancy;

  if (p.conflict_state === "conflicted") return "contested";
  if (isDown || NON_REVENUE_OCCUPANCY.has(String(claim || "").toLowerCase())) return "down_non_revenue";

  // Disagreement in EITHER direction. An imported 'occupied' claim with no
  // spanning lease stays disagreeing until a human resolves it — it is never
  // converted to vacant merely because the lease read is absent.
  if (!lease && claimSaysOccupied(claim)) return "occupancy_evidence_disagrees";
  if (lease && !claimSaysOccupied(claim)) return "occupancy_evidence_disagrees";
  if (!lease && !claimSaysVacant(claim)) return "occupancy_evidence_disagrees"; // 'unknown' is not vacant

  if (lease && (lease.rent == null || Number(lease.rent) === 0)) return "economics_unavailable";
  if (lease) return "contractually_occupied";
  return "confirmed_vacant";
}

async function currentRentRoll(pool, { property_id, as_of = null } = {}) {
  if (!property_id) throw new Error("currentRentRoll requires property_id");
  const asOf = as_of || new Date().toISOString().slice(0, 10);

  const sp = await spacePosition(pool, { property_id, as_of: asOf });

  // Down flag + the contracted axis live on units; the classifier reports the
  // axis verbatim as _compat_occupancy but does not own is_down.
  const downRows = (await pool.query(
    `select u.id from units u where u.property_id=$1 and coalesce(u.is_down,false)=true`, [property_id]
  )).rows;
  const downUnits = new Set(downRows.map((r) => String(r.id)));

  // OPENING TRUTH — an extensible receipt. A property may have many governed
  // sources over its life; the contract must not collapse that history into
  // "one batch and one document".
  const batches = (await pool.query(
    `select id, source_type, source_file, source_as_of_date, confidence, status,
            leasing_model, loaded_at, notes
       from import_batches where property_id=$1
      order by source_as_of_date desc nulls last, loaded_at desc`, [property_id]
  )).rows;
  const sources = batches.map((b) => ({
    batch_id: b.id, source_type: b.source_type, source_file: b.source_file || null,
    source_as_of_date: b.source_as_of_date ? String(b.source_as_of_date).slice(0, 10) : null,
    confidence: b.confidence || null, status: b.status || null,
    leasing_model: b.leasing_model || null, loaded_at: b.loaded_at, notes: b.notes || null,
  }));
  const opening_truth = {
    sources,
    latest_confirmed_source: sources.find((s) => s.status === "committed" && s.source_type !== "rent_roll_reconciliation") || null,
    latest_reconciliation: sources.find((s) => s.source_type === "rent_roll_reconciliation") || null,
  };

  const rows = sp.positions.map((p) => {
    const isDown = downUnits.has(String(p.unit_id));
    const state = aggregationState(p, isDown);
    const lease = p.current_lease_position;
    const resident = lease && lease.tenants && lease.tenants[0] ? lease.tenants[0] : null;
    return {
      space_id: p.space_id,
      unit_id: p.unit_id,
      unit_number: p.unit_number,
      space_label: p.space_label,
      // by-bed by construction: a unit with several spaces yields several rows
      position_kind: p.space_label ? "bed" : "unit",

      aggregation_state: state,
      imported_occupancy_claim: p._compat_occupancy || null,   // independent axis, verbatim

      resident: resident ? { person_id: resident.person_id, name: resident.name || null } : null,
      current_rent: lease && lease.rent != null ? Number(lease.rent) : null,
      lease: lease ? { lease_id: lease.lease_id, start_date: lease.start_date, end_date: lease.end_date } : null,

      notice_state: p.notice_state,
      successor_state: p.successor.state,
      successor_lease_id: p.successor.lease_id,
      proof_basis: lease ? lease.proof_basis : null,

      conflict_state: p.conflict_state,
      conflicting_lease_ids: p.conflicting_lease_ids,
      availability_state: p.availability_state,
      next_required_action: p.next_required_action,
      reason: p.reason,
    };
  });

  const count = (s) => rows.filter((r) => r.aggregation_state === s).length;
  const occupied = count("contractually_occupied");
  const noEconomics = count("economics_unavailable");
  const disagrees = count("occupancy_evidence_disagrees");
  const contested = count("contested");
  const vacant = count("confirmed_vacant");
  const nonRevenue = count("down_non_revenue");

  // TRUSTED RENT: contractually_occupied only. A contested position never
  // contributes, and never contributes twice.
  const contractual_rent_trusted = money(
    rows.filter((r) => r.aggregation_state === "contractually_occupied")
        .reduce((s, r) => s + Number(r.current_rent || 0), 0));

  // The disputed claims, returned separately with the rent they implicate.
  const contestedSpaceIds = new Set(rows.filter((r) => r.aggregation_state === "contested").map((r) => r.space_id));
  let contested_claims = { spaces: contestedSpaceIds.size, lease_claims: 0, implicated_rent: 0, claims: [] };
  if (contestedSpaceIds.size) {
    const claims = (await pool.query(
      `select l.id as lease_id, l.space_id, l.lease_status, l.start_date, l.end_date, l.rent
         from leases l
        where l.space_id = any($1::uuid[])
          and l.lease_status not in ('cancelled','rescinded','void','superseded','terminated','expired')
        order by l.space_id, l.start_date`, [[...contestedSpaceIds]]
    )).rows;
    contested_claims = {
      spaces: contestedSpaceIds.size,
      lease_claims: claims.length,
      implicated_rent: money(claims.reduce((s, c) => s + Number(c.rent || 0), 0)),
      claims: claims.map((c) => ({
        lease_id: c.lease_id, space_id: c.space_id, lease_status: c.lease_status,
        start_date: c.start_date ? String(c.start_date).slice(0, 10) : null,
        end_date: c.end_date ? String(c.end_date).slice(0, 10) : null,
        rent: c.rent == null ? null : Number(c.rent),
      })),
    };
  }

  const inventory = rows.length;
  const leasable_inventory = inventory - nonRevenue;
  // Positions that genuinely hold a spanning lease.
  const occupancy_numerator = occupied + noEconomics;

  return {
    property_id, as_of: asOf, inventory,
    opening_truth,
    totals: {
      inventory,
      leasable_inventory,
      contractually_occupied: occupied,
      economics_unavailable: noEconomics,
      confirmed_vacant: vacant,
      down_non_revenue: nonRevenue,
      occupancy_evidence_disagrees: disagrees,
      contested,
      // Stated as numerator OF denominator, with the unresolved count beside
      // it. A bare percentage would imply the unresolved positions are settled.
      contractual_occupancy: {
        numerator: occupancy_numerator,
        denominator: leasable_inventory,
        pct: leasable_inventory ? Math.round(occupancy_numerator / leasable_inventory * 10000) / 100 : null,
        unresolved_beside: disagrees + contested,
      },
      contractual_rent_trusted,
      contractual_rent_excluded_contested: contested_claims.implicated_rent,
      proof_split: {
        native_verified: rows.filter((r) => r.proof_basis === "native_verified").length,
        confirmed_opening_import: rows.filter((r) => r.proof_basis === "confirmed_opening_import").length,
        unproven: rows.filter((r) => r.proof_basis === "unproven").length,
      },
    },
    contested_claims,
    exceptions: {
      occupancy_evidence_disagrees: disagrees,
      contested,
      economics_unavailable: noEconomics,
      resident_not_linked: rows.filter((r) => r.lease && !r.resident).length,
    },
    rows,
  };
}

module.exports = { currentRentRoll, aggregationState };
