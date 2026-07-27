// ════════════════════════════════════════════════════════════════════
//  dated_positions.js — THE CANONICAL DATED PROPERTY-POSITION READ
//
//  One service. Four interpretations:
//
//      canonical dated property positions
//        → Current Rent Roll   (as_of = today)
//        → Renewals            (upcoming expirations)
//        → Future Rent Roll    (as_of = a selected date, facts only)
//        → Availability        (marketability context)
//
//  These are four READS of one truth, not four modules that each compute a
//  position. Every surface may add its own context. None may redefine
//  lease spanning, notice, successor, conflict, availability or proof basis
//  — those come from classifyPosition and arrive here already decided.
//
//  BEGINS FROM CANONICAL SPACES, never from import rows. The import cannot
//  define the row set; it attributes and disputes it. That inversion — the
//  imported document as row spine with canonical truth overlaid by
//  unit_number string equality — is exactly what this replaces.
//
//  CARRIES INDEPENDENT AXES rather than compressing everything into one
//  status. Structural position, canonical lease evidence, imported
//  occupancy claim, proof basis, conflict, availability and successor stay
//  separately readable, because collapsing them is how a disagreement
//  becomes a clean-looking number.
//
//  NO SURFACE CONCEPTS HERE. No urgency bands, no presentation strings, no
//  filters, no HTML. Those belong to the surface that needs them.
//
//  READ-ONLY. Writes nothing, stores nothing. A position at a future date
//  is DERIVED, so facts at a later date replace facts at an earlier one by
//  recomputation — never by stored cleanup.
// ════════════════════════════════════════════════════════════════════

"use strict";

const { spacePosition } = require("./space_position");

// Occupancy-axis values that mean "structurally not earning".
const NON_REVENUE_CLAIMS = new Set(["model", "down"]);

const claim = (v) => String(v || "").toLowerCase();

// ── FOUR INDEPENDENT AXES ────────────────────────────────────────────
//  A position can simultaneously be contractually occupied, have
//  inconclusive opening evidence, and have unavailable economics. Those are
//  THREE DIFFERENT FACTS. Forcing them into one mutually exclusive enum
//  makes the totals balance by destroying the ability to explain a
//  position — which is the opposite of the point.
//
//  Each axis is exclusive WITHIN ITSELF and balances on its own.

// AXIS 1 — TENANCY. What is contractually true about occupation?
//   contested               overlapping non-terminal leases; which governs
//                           is unknown, so no tenancy claim can be made.
//   contractually_occupied  an uncontested spanning lease. This holds even
//                           when the imported claim is 'unknown' — opening
//                           evidence being inconclusive does not un-occupy a
//                           position that has a real lease.
//   unresolved              no spanning lease, but the opening claim says
//                           occupied, or says nothing conclusive. NOT vacant.
//   vacant                  no spanning lease and the opening claim agrees.
function tenancyState(p) {
  if (p.conflict_state === "conflicted") return "contested";
  if (p.current_lease_position) return "contractually_occupied";
  const c = claim(p._compat_occupancy);
  if (c === "vacant") return "vacant";
  return "unresolved";                     // 'occupied' claim, or 'unknown'
}

// AXIS 2 — EVIDENCE. Does opening truth agree with lease evidence?
//   confirmed      the claim and the lease evidence agree.
//   disagrees      they contradict: a claim of occupied with no spanning
//                  lease, or a spanning lease on a position claimed vacant.
//   inconclusive   the claim is 'unknown'. Unknown CONTRADICTS NOTHING —
//                  it is opening truth that never resolved, not a conflict.
function evidenceState(p) {
  const lease = !!p.current_lease_position;
  const c = claim(p._compat_occupancy);
  if (!c || c === "unknown") return "inconclusive";
  if (NON_REVENUE_CLAIMS.has(c)) return "confirmed";       // model/down is a use statement
  if (lease && c === "occupied") return "confirmed";
  if (!lease && c === "vacant") return "confirmed";
  return "disagrees";
}

// AXIS 3 — ECONOMICS COMPLETENESS. Independent of whether it is occupied.
//   available      a spanning lease with populated contractual rent.
//   unavailable    a spanning lease whose rent is missing. The position is
//                  still occupied; the rent is simply not known, and is
//                  never coerced to $0 at the row level.
//   not_applicable no spanning lease, so there is no contractual rent to have.
function economicsState(p) {
  const lease = p.current_lease_position;
  if (!lease) return "not_applicable";
  return (lease.rent == null || Number(lease.rent) === 0) ? "unavailable" : "available";
}

// AXIS 4 — proof_basis, already decided by the classifier.

// TRUSTED RENT ELIGIBILITY — the single rule.
//   Sum the populated contractual rent of every UNCONTESTED spanning lease,
//   regardless of whether opening evidence agrees, disagrees or is
//   inconclusive. Exclude only: contested claims, positions with no spanning
//   lease, and spanning leases whose rent is unavailable.
function contributesTrustedRent(p) {
  return tenancyState(p) === "contractually_occupied" && economicsState(p) === "available";
}

// Opening truth is an EXTENSIBLE receipt. A property may take many governed
// sources over its life; the contract must not collapse that history into
// "one batch and one document".
async function openingTruth(pool, property_id) {
  const rows = (await pool.query(
    `select id, source_type, source_file, source_as_of_date, confidence, status,
            leasing_model, loaded_at, notes
       from import_batches where property_id=$1
      order by source_as_of_date desc nulls last, loaded_at desc`, [property_id]
  )).rows;
  const sources = rows.map((b) => ({
    batch_id: b.id,
    source_type: b.source_type,
    source_file: b.source_file || null,
    source_as_of_date: b.source_as_of_date ? String(b.source_as_of_date).slice(0, 10) : null,
    confidence: b.confidence || null,
    status: b.status || null,
    leasing_model: b.leasing_model || null,
    attribution: { loaded_at: b.loaded_at, notes: b.notes || null },
  }));
  return {
    sources,
    latest_confirmed_source: sources.find((s) => s.status === "committed" && s.source_type !== "rent_roll_reconciliation") || null,
    latest_reconciliation: sources.find((s) => s.source_type === "rent_roll_reconciliation") || null,
  };
}

async function datedPropertyPositions(pool, { property_id, as_of = null } = {}) {
  if (!property_id) throw new Error("datedPropertyPositions requires property_id");
  const asOf = as_of || new Date().toISOString().slice(0, 10);

  const sp = await spacePosition(pool, { property_id, as_of: asOf });

  // is_down lives on units and is not owned by the classifier. Loaded here so
  // every consumer sees the same physical-service fact.
  const down = new Set((await pool.query(
    `select id from units where property_id=$1 and coalesce(is_down,false)=true`, [property_id]
  )).rows.map((r) => String(r.id)));

  // STRUCTURAL ATTRIBUTES — square footage and the GOVERNED classification
  // (migration 100). Loaded here rather than in space_position so that the
  // classifier's output stays byte-identical to its characterization baseline.
  // unit_type resolves through property_unit_types: a source code is
  // provenance, never a type, so an unmapped unit reports null and every
  // surface renders it as not configured.
  const attrs = new Map((await pool.query(
    `select s.id as space_id, u.square_feet, s.use_type, s.position_kind,
            put.code as unit_type_code, put.label as unit_type_label
       from spaces s
       join units u on u.id = s.unit_id
       left join property_unit_types put on put.id = u.unit_type_id
      where u.property_id = $1`, [property_id]
  )).rows.map((r) => [String(r.space_id), r]));

  const positions = sp.positions.map((p) => {
    const withDown = { ...p, is_down: down.has(String(p.unit_id)) };
    const lease = p.current_lease_position;
    const resident = lease && lease.tenants && lease.tenants[0] ? lease.tenants[0] : null;
    return {
      // durable identity — never unit_number
      space_id: p.space_id,
      unit_id: p.unit_id,
      unit_number: p.unit_number,        // display only
      space_label: p.space_label,
      // GOVERNED first, derived only as a fallback: once position_kind is
      // populated it is the answer; until then the shape of the data is.
      // A single-space unit is labelled '(whole unit)' in the source — that
      // sentinel is truthy but it is NOT a bed label, and treating it as one
      // made every position on a by-unit property report as a bed.
      position_kind: (attrs.get(String(p.space_id)) || {}).position_kind
        || (p.space_label && !/whole\s*unit/i.test(p.space_label) ? "bed" : "unit"),
      square_feet: (attrs.get(String(p.space_id)) || {}).square_feet ?? null,
      // null until a reviewed mapping receipt creates the governed row.
      unit_type: (attrs.get(String(p.space_id)) || {}).unit_type_label || null,
      unit_type_code: (attrs.get(String(p.space_id)) || {}).unit_type_code || null,
      use_type: (attrs.get(String(p.space_id)) || {}).use_type || null,

      // FOUR INDEPENDENT AXES. Each balances within itself. A position may be
      // occupied AND inconclusive AND missing economics — three facts, three
      // fields, never collapsed into one status.
      tenancy_state: tenancyState(withDown),
      evidence_state: evidenceState(withDown),
      economics_state: economicsState(withDown),
      contributes_trusted_rent: contributesTrustedRent(withDown),

      imported_occupancy_claim: p._compat_occupancy || null,
      lease: lease ? {
        lease_id: lease.lease_id,
        start_date: lease.start_date,
        end_date: lease.end_date,
        rent: lease.rent == null ? null : Number(lease.rent),
      } : null,
      resident: resident ? { person_id: resident.person_id, name: resident.name || null } : null,
      current_rent: lease && lease.rent != null ? Number(lease.rent) : null,
      proof_basis: lease ? lease.proof_basis : null,
      notice_state: p.notice_state,
      successor: p.successor,
      conflict_state: p.conflict_state,
      conflicting_lease_ids: p.conflicting_lease_ids,

      // canonical physical / configuration facts
      is_down: withDown.is_down,
      physical_readiness: p.physical_readiness,
      possession_state: p.possession_state,
      current_possession: p.current_possession,
      availability_state: p.availability_state,
      available_from: p.available_from,

      next_required_action: p.next_required_action,
      reason: p.reason,
    };
  });

  return {
    property_id,
    as_of: asOf,
    count: positions.length,
    opening_truth: await openingTruth(pool, property_id),
    positions,
  };
}

module.exports = {
  datedPropertyPositions, openingTruth,
  tenancyState, evidenceState, economicsState, contributesTrustedRent,
};
