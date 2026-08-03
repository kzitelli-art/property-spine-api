// ════════════════════════════════════════════════════════════════════
//  forward_rent_roll_summary.js — SLICE 10C. COMPLETE-PROPERTY SUMMARIES.
//
//  Aggregation ONLY. Every number here is counted from the frozen typed rows
//  produced by datedPositionRows. This file contains no lease interpretation,
//  no economics interpretation and no conflict resolution — a second reading
//  of those questions is exactly how two surfaces start disagreeing about one
//  property.
//
//  COMPLETE-PROPERTY, NEVER A PAGE. The summary is computed from the whole
//  authenticated property. A page is a transport concern and arrives in 10D;
//  it must never be able to change a total.
//
//  TWO DATED READS, ONE PER SIDE. Current and target are the same derivation
//  at two dates, so "what changed" is a comparison of two governed results
//  per spaces.id — never an inference from a rent difference.
// ════════════════════════════════════════════════════════════════════

"use strict";

const { datedPositionRows } = require("./dated_position_rows");

//  A position is contractually occupied ONLY under the governed locked state.
//  covered_unproven, successor_pending_not_locked, contested and open are all
//  NOT occupancy: a pending or contested claim does not become contracted
//  occupancy because a proposed start date arrived.
const OCCUPIED_STATE = "contractually_locked";

const REVENUE = "revenue", NON_REVENUE = "non_revenue", UNKNOWN = "unknown";

function positionCounts(rows) {
  const c = { total_canonical_positions: rows.length, revenue: 0, non_revenue: 0, unknown_denominator: 0,
              residential_revenue: 0, commercial_revenue: 0 };
  for (const r of rows) {
    if (r.denominator_class === REVENUE) {
      c.revenue++;
      if (r.use_type === "residential") c.residential_revenue++;
      else if (r.use_type === "commercial") c.commercial_revenue++;
    } else if (r.denominator_class === NON_REVENUE) c.non_revenue++;
    else c.unknown_denominator++;
  }
  //  RECONCILIATION, asserted here rather than hoped for downstream.
  c.reconciles = (c.revenue + c.non_revenue + c.unknown_denominator) === c.total_canonical_positions;
  return c;
}

//  OCCUPANCY for one dated side. Only revenue positions form the denominator;
//  non_revenue is excluded and unknown is not inferred into either.
function occupancySide(rows, label) {
  const revenue = rows.filter((r) => r.denominator_class === REVENUE);
  const unknownDenominator = rows.filter((r) => r.denominator_class === UNKNOWN);
  const conflict = revenue.filter((r) => r.conflict_state === "conflicted");
  const untrackable = revenue.filter((r) => r.evidence_state === "untrackable");
  const unavailable = revenue.filter((r) => r.evidence_state === "unavailable");
  const settled = revenue.filter((r) => !conflict.includes(r) && !untrackable.includes(r) && !unavailable.includes(r));
  const occupied = settled.filter((r) => r.position_state === OCCUPIED_STATE);
  const unoccupied = settled.filter((r) => r.position_state !== OCCUPIED_STATE);

  const blockers = [];
  if (unknownDenominator.length) blockers.push({
    code: "unknown_denominator", affects: ["denominator"], count: unknownDenominator.length,
    space_ids: unknownDenominator.slice(0, 25).map((r) => r.space_id),
    explanation: "Some positions have no governed use_type, so the revenue denominator is not established." });
  if (conflict.length) blockers.push({
    code: "occupancy_conflict", affects: ["numerator"], count: conflict.length,
    space_ids: conflict.slice(0, 25).map((r) => r.space_id),
    explanation: "Incompatible leases cover these positions, so their occupancy cannot be attributed." });
  if (untrackable.length) blockers.push({
    code: "untrackable_position", affects: ["numerator"], count: untrackable.length,
    space_ids: untrackable.slice(0, 25).map((r) => r.space_id),
    explanation: "These positions cannot be resolved to one canonical lineage." });
  if (unavailable.length) blockers.push({
    code: "source_unavailable", affects: ["numerator", "denominator"], count: unavailable.length,
    space_ids: unavailable.slice(0, 25).map((r) => r.space_id),
    explanation: "The supporting source could not be read for these positions." });

  //  PUBLICATION RULE. Every denominator classification known AND every
  //  revenue position settled. Otherwise the rate is withheld — never computed
  //  over the known subset and presented as the property.
  const publishable = blockers.length === 0 && revenue.length > 0;
  return {
    side: label,
    contracted_occupied_positions: occupied.length,
    contracted_unoccupied_positions: unoccupied.length,
    occupancy_conflict_positions: conflict.length,
    occupancy_untrackable_positions: untrackable.length,
    revenue_denominator: publishable ? revenue.length : null,
    rate: publishable ? Math.round((occupied.length / revenue.length) * 10000) / 100 : null,
    state: publishable ? "published" : (revenue.length === 0 ? "empty" : "withheld"),
    reconciles: publishable ? (occupied.length + unoccupied.length) === revenue.length : null,
    blockers,
  };
}

//  RENT. Two independently true subtotals, and a combined total that may be
//  published only when nothing material is missing, partial, conflicting,
//  untrackable or unavailable.
function rentSide(rows, label) {
  const dated = rows.filter((r) => r.evidence_state === "contractually_supported" && r.contractual_rent != null);
  const legacy = rows.filter((r) => r.evidence_state === "qualified_legacy" && r.contractual_rent != null);
  const sum = (a) => Math.round(a.reduce((s, r) => s + Number(r.contractual_rent), 0) * 100) / 100;

  //  Which positions can move the answer but cannot support one? Only
  //  revenue-bearing positions that actually claim a term.
  const material = rows.filter((r) => r.denominator_class === REVENUE);
  const incomplete = material.filter((r) => r.evidence_state === "incomplete");
  const conflicting = material.filter((r) => r.evidence_state === "conflicting");
  const untrackable = material.filter((r) => r.evidence_state === "untrackable");
  const unavailable = material.filter((r) => r.evidence_state === "unavailable");

  const blockers = [];
  const add = (code, list, explanation) => { if (list.length) blockers.push({
    code, affects: ["rent"], count: list.length,
    space_ids: list.slice(0, 25).map((r) => r.space_id), explanation }); };
  add("missing_economics", incomplete, "No governed amount reaches these positions on this date, or the only amount cannot prove this month.");
  add("conflicting_economics", conflicting, "More than one amount applies, so none is selected.");
  add("untrackable_position", untrackable, "These positions cannot be resolved to one canonical lineage.");
  add("source_unavailable", unavailable, "The supporting source could not be read for these positions.");

  const publishable = blockers.length === 0;
  const combined = publishable ? Math.round((sum(dated) + sum(legacy)) * 100) / 100 : null;
  return {
    side: label,
    dated_authority_subtotal: sum(dated),
    dated_authority_positions: dated.length,
    qualified_legacy_subtotal: sum(legacy),
    qualified_legacy_positions: legacy.length,
    combined_total: combined,
    //  DISCLOSURE, not a footnote. A total containing legacy amounts is not an
    //  entirely dated-authority total and must not read as one.
    includes_qualified_legacy: publishable ? legacy.length > 0 : null,
    state: publishable ? "published" : "withheld",
    reconciles: publishable ? Math.abs((sum(dated) + sum(legacy)) - combined) < 0.005 : null,
    evidence_mix: {
      contractually_supported: rows.filter((r) => r.evidence_state === "contractually_supported").length,
      qualified_legacy: rows.filter((r) => r.evidence_state === "qualified_legacy").length,
      incomplete: rows.filter((r) => r.evidence_state === "incomplete").length,
      conflicting: rows.filter((r) => r.evidence_state === "conflicting").length,
    },
    blockers,
  };
}

//  CHANGES. Derived from two governed dated results for the SAME spaces.id.
//  A rent difference alone never implies a renewal, a move-in or a move-out.
function changes(currentRows, targetRows) {
  const byId = (rows) => new Map(rows.map((r) => [String(r.space_id), r]));
  const cur = byId(currentRows), tgt = byId(targetRows);
  const out = { contractual_starts: [], contractual_ends: [], rent_increases: [], rent_decreases: [],
                unchanged_contractual_rent: 0, newly_occupied: [], newly_unoccupied: [], unresolved: [] };
  for (const [id, t] of tgt) {
    const c = cur.get(id);
    if (!c) continue;
    const bothSettled = c.conflict_state !== "conflicted" && t.conflict_state !== "conflicted"
      && !["untrackable", "unavailable"].includes(c.evidence_state)
      && !["untrackable", "unavailable"].includes(t.evidence_state);
    if (!bothSettled) { out.unresolved.push({ space_id: id, reason: "one or both sides are conflicting or untrackable" }); continue; }

    const cOcc = c.position_state === OCCUPIED_STATE, tOcc = t.position_state === OCCUPIED_STATE;
    if (!cOcc && tOcc) out.newly_occupied.push({ space_id: id, lease_id: t.governing_lease_id });
    if (cOcc && !tOcc) out.newly_unoccupied.push({ space_id: id, lease_id: c.governing_lease_id });
    if (c.governing_lease_id !== t.governing_lease_id) {
      if (t.governing_lease_id) out.contractual_starts.push({ space_id: id, lease_id: t.governing_lease_id });
      if (c.governing_lease_id) out.contractual_ends.push({ space_id: id, lease_id: c.governing_lease_id });
    }
    //  Rent movement is only stated when BOTH sides carry a governed amount.
    if (c.contractual_rent != null && t.contractual_rent != null) {
      const d = Number(t.contractual_rent) - Number(c.contractual_rent);
      if (d > 0) out.rent_increases.push({ space_id: id, from: Number(c.contractual_rent), to: Number(t.contractual_rent),
                                           from_authority: c.rent_authority, to_authority: t.rent_authority });
      else if (d < 0) out.rent_decreases.push({ space_id: id, from: Number(c.contractual_rent), to: Number(t.contractual_rent),
                                                from_authority: c.rent_authority, to_authority: t.rent_authority });
      else out.unchanged_contractual_rent++;
    } else {
      out.unresolved.push({ space_id: id, reason: "one or both sides have no governed amount" });
    }
  }
  return out;
}

async function forwardRentRollSummary(pool, { property_id, as_of = null } = {}) {
  //  Current side first: it also establishes the property's operating day, so
  //  a property with no governed timezone refuses once rather than twice.
  const current = await datedPositionRows(pool, { property_id });
  if (current.state !== "ok") {
    return { contract_version: "forward_rent_roll_summary_v1", property_id,
             state: current.state, result_state: current.result_state,
             reason: current.reason, detail: current.detail, summary: null };
  }
  const targetDate = as_of || current.as_of;
  const target = targetDate === current.as_of ? current
    : await datedPositionRows(pool, { property_id, as_of: targetDate });

  const counts = positionCounts(target.rows);
  return {
    contract_version: "forward_rent_roll_summary_v1",
    property_id,
    operating_timezone: current.operating_timezone,
    state: "ok",
    result_state: target.rows.length ? "qualifying_result_exists" : "no_qualifying_result",
    summary: {
      current_date: current.as_of,
      target_date: targetDate,
      positions: counts,
      occupancy: { current: occupancySide(current.rows, "current"), target: occupancySide(target.rows, "target") },
      contractual_rent: { current: rentSide(current.rows, "current"), target: rentSide(target.rows, "target") },
      changes: changes(current.rows, target.rows),
    },
    rows: target.rows,
  };
}

module.exports = { forwardRentRollSummary, occupancySide, rentSide, changes, positionCounts, OCCUPIED_STATE };
