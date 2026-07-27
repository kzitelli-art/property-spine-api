// ════════════════════════════════════════════════════════════════════
//  rent_roll_institutional.js — THE FORMAL AS-OF RENT ROLL
//
//  The second presentation of ONE canonical read. Operating Rent Roll and
//  Institutional Rent Roll are not two systems and not two calculations:
//  both call currentRentRoll(), and this module only reshapes.
//
//    Operating      searchable, exception-aware, continues into the
//                   Person Card.
//    Institutional  a formal as-of schedule an owner, lender, asset
//                   manager or buyer would recognise, plus export.
//
//  ONE ROW PER CANONICAL RENTABLE POSITION — 283 positions, never the 386
//  imported source rows. The Yardi schedule gave us the recognisable column
//  SHAPE; it is not runtime authority and its totals never blend into ours.
//
//  NO CALCULATION HERE. Every total is passed through from the canonical
//  response. Print and CSV read this same object, so the printed page, the
//  CSV and the operating page cannot disagree.
//
//  HONEST BLANKS, NEVER BACKFILLED FROM THE SPREADSHEET:
//   · unit_type      — 'Not configured' until a reviewed mapping receipt
//                      creates governed property_unit_types rows.
//   · security_deposit — BLANK. The imported column's meaning is not yet
//                      governed (required vs held vs dated ledger balance),
//                      and the evidence points at 'held as of the source
//                      date' rather than contractual economics. Writing it
//                      into a field that reads as contractual would make a
//                      guess permanent. The claims survive as evidence.
//   · market_rent    — absent from the schedule entirely. It is a source
//                      claim, not authorised pricing and not contractual
//                      economics.
//
//  WRITES NOTHING.
// ════════════════════════════════════════════════════════════════════

"use strict";

const { currentRentRoll } = require("./rent_roll_canonical");

const NOT_CONFIGURED = "Not configured";

// The institutional column order. Print, CSV and the JSON rows all use this
// one definition, so a column can never appear in one output and not another.
const COLUMNS = [
  { key: "position",          label: "Unit / Bed" },
  { key: "unit_type",         label: "Unit Type" },
  { key: "square_feet",       label: "Sq Ft" },
  { key: "resident",          label: "Resident" },
  { key: "lease_start",       label: "Lease Start" },
  { key: "lease_expiration",  label: "Lease Expiration" },
  { key: "monthly_rent",      label: "Monthly Contractual Rent" },
  { key: "security_deposit",  label: "Security Deposit" },
  { key: "current_balance",   label: "Current Balance" },
  { key: "balance_as_of",     label: "Balance As Of" },
  { key: "notice_state",      label: "Notice" },
  { key: "successor_state",   label: "Future Lease" },
  { key: "status",            label: "Status" },
];

const ymd = (v) => (v ? String(v).slice(0, 10) : "");

// Occupancy / exception state in language an owner or lender reads without a
// glossary. The canonical axes stay available in the raw rows beneath.
function statusLabel(r) {
  if (r.tenancy_state === "contested") return "Contested — overlapping leases";
  if (r.is_down) return "Down";
  if (r.tenancy_state === "unresolved") return "Unresolved occupancy evidence";
  if (r.tenancy_state === "vacant") return "Vacant";
  if (r.economics_state === "unavailable") return "Occupied — rent unavailable";
  return "Occupied";
}

function institutionalRow(r) {
  const bed = r.space_label && !/whole\s*unit/i.test(r.space_label) ? ` · ${r.space_label}` : "";
  return {
    space_id: r.space_id,
    unit_id: r.unit_id,
    position: `${r.unit_number || ""}${bed}`,
    position_kind: r.position_kind,
    // Governed classification only. A source code is provenance, not a type.
    unit_type: r.unit_type || NOT_CONFIGURED,
    square_feet: r.square_feet == null ? "" : r.square_feet,
    resident: r.resident && r.resident.name ? r.resident.name : (r.lease ? "Resident not linked" : ""),
    person_id: r.resident ? r.resident.person_id : null,
    lease_start: r.lease ? ymd(r.lease.start_date) : "",
    lease_expiration: r.lease ? ymd(r.lease.end_date) : "",
    monthly_rent: r.current_rent == null ? "" : Number(r.current_rent),
    // Deliberately blank — see the header. The reconciliation section says why.
    security_deposit: "",
    current_balance: r.balance == null ? "" : Number(r.balance),
    balance_as_of: r.balance_as_of ? ymd(r.balance_as_of) : "",
    notice_state: r.notice_state === "on_notice" ? "On notice" : "",
    successor_state: r.successor_state === "locked" ? "Locked"
      : r.successor_state === "pending" ? "Pending" : "",
    status: statusLabel(r),
    // canonical axes retained for the drill-down; not printed columns
    _axes: {
      tenancy_state: r.tenancy_state, evidence_state: r.evidence_state,
      economics_state: r.economics_state, proof_basis: r.proof_basis,
      conflict_state: r.conflict_state, imported_occupancy_claim: r.imported_occupancy_claim,
    },
  };
}

async function institutionalRentRoll(pool, { property_id, as_of = null } = {}) {
  const rr = await currentRentRoll(pool, { property_id, as_of });
  const prop = (await pool.query("select name, display_name from properties where id=$1", [property_id])).rows[0] || {};

  const rows = rr.rows.map(institutionalRow);
  const t = rr.totals;

  return {
    report: {
      title: "Rent Roll",
      property_id,
      property_name: prop.display_name || prop.name || null,
      as_of: rr.as_of,
      generated_at: new Date().toISOString(),
      basis: "canonical_property_positions",
      note: "One row per canonical rentable position. Totals are server-authored and identical to the operating Rent Roll.",
    },

    columns: COLUMNS,
    rows,

    // PASSED THROUGH, never recomputed.
    totals: {
      total_positions: t.inventory,
      confirmed_contractual_occupancy: t.confirmed_contractual_occupancy.occupied,
      occupancy_denominator: t.confirmed_contractual_occupancy.of_leasable_resolved,
      trusted_monthly_contractual_rent: t.contractual_rent_trusted,
      positions_contributing_rent: t.positions_contributing_rent,
      contested_rent_excluded: t.contractual_rent_excluded_contested,
      positions_economics_unavailable: t.occupied_without_known_rent,
      positions_conflicting_evidence: rr.exceptions.evidence_disagrees,
      positions_contested: rr.exceptions.contested,
      positions_down: t.down,
      proof_basis: rr.proof_summary,
    },

    // VISIBLE AND SEPARATE — recognisable schedule above, Spine's stronger
    // truth beneath it. Not fine print, and not an audit screen replacing the
    // report an owner expects.
    reconciliation: {
      statements: [
        `Trusted monthly contractual rent: $${Number(t.contractual_rent_trusted).toLocaleString()} from ${t.positions_contributing_rent} positions.`,
        `Contested rent claims excluded: $${Number(t.contractual_rent_excluded_contested).toLocaleString()} across ${rr.exceptions.contested} positions with overlapping lease claims.`,
        `${t.occupied_without_known_rent} occupied position(s) have unavailable contractual economics and contribute no rent.`,
        `${rr.exceptions.evidence_disagrees} position(s) have conflicting occupancy evidence between the opening source and canonical lease records.`,
        `Contractual proof basis: ${rr.proof_summary.native_verified} verified in Spine, ${rr.proof_summary.confirmed_opening_import} confirmed opening truth.`,
        "Security deposit is not shown: opening-source deposit claims exist but have not yet been mapped to a governed deposit meaning (required versus held).",
        "Unit classifications have not yet been configured.",
      ],
      contested_claims: rr.contested_claims,
      opening_truth: rr.opening_truth,
    },
  };
}

// CSV FROM THE SAME OBJECT — same columns, same order, same values. The CSV
// cannot disagree with the printed page because neither computes anything.
function institutionalCsv(report) {
  const esc = (v) => {
    const s = v == null ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [];
  lines.push(esc(report.report.title) + " — " + esc(report.report.property_name || ""));
  lines.push("As of," + esc(report.report.as_of) + ",Generated," + esc(report.report.generated_at));
  lines.push("");
  lines.push(report.columns.map((c) => esc(c.label)).join(","));
  for (const r of report.rows) lines.push(report.columns.map((c) => esc(r[c.key])).join(","));
  lines.push("");
  lines.push("TOTALS");
  const t = report.totals;
  lines.push("Total canonical rentable positions," + t.total_positions);
  lines.push("Confirmed contractual occupancy," + t.confirmed_contractual_occupancy + " of " + t.occupancy_denominator);
  lines.push("Trusted monthly contractual rent," + t.trusted_monthly_contractual_rent);
  lines.push("Positions contributing known rent," + t.positions_contributing_rent);
  lines.push("Contested rent excluded," + t.contested_rent_excluded);
  lines.push("Positions with unavailable economics," + t.positions_economics_unavailable);
  lines.push("Positions with conflicting occupancy evidence," + t.positions_conflicting_evidence);
  lines.push("");
  lines.push("RECONCILIATION");
  for (const s of report.reconciliation.statements) lines.push(esc(s));
  return lines.join("\n");
}

module.exports = { institutionalRentRoll, institutionalCsv, COLUMNS, NOT_CONFIGURED };
