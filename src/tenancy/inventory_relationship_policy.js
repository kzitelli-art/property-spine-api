// ════════════════════════════════════════════════════════════════════
//  inventory_relationship_policy.js — WHAT A RETIRED UNIT MAY STILL BE
//  REFERENCED BY, AND WHAT MAY NEVER ATTACH TO IT AGAIN.
//
//  One declaration, three consumers:
//    · the correction review (relationship counts, blockers, conflicts)
//    · migration 197's write-enforcement triggers (installed per entry
//      whose treatment is blocks_while_operative)
//    · the coverage gate (every column that references units or spaces
//      must appear here; every blocking entry must carry its trigger)
//
//  A foreign key alone cannot tell history from an active commitment, so
//  every entry names its TREATMENT and, for lifecycle tables, the exact
//  status vocabulary that means "no longer operative" — read from the
//  table's own CHECK constraint or its writer, never a generic "closed".
//
//    blocks_while_operative   an operative row blocks retirement; a NEW
//                             operative attachment, a re-target onto a
//                             retired unit, or reopening a terminal row on
//                             one is refused by the database
//    retained_history         evidence of what happened; keeps its identity,
//                             never blocks, never refused (audit, photos,
//                             observations, messages, walks, claims of work)
//    interest_only            a prospect's or lead's interest in a unit;
//                             not a commitment; never blocks
//    source_lineage           what produced the record; the current-
//                             representation claim rule reads it
//    retirement_ledger        the owner's own table
//
//  `status_column: ""` means every row is operative (no lifecycle):
//  configuration and money attachments are refused NEW on retired
//  inventory and reported as conflicts where they already exist.
//  `null_means` says whether a NULL status is operative (renewal cases:
//  terminal_state is null while the case is live).
// ════════════════════════════════════════════════════════════════════

"use strict";

const B = "blocks_while_operative", H = "retained_history", I = "interest_only", L = "source_lineage", R = "retirement_ledger";

//  code: the blocker/conflict code the review reports (stable API vocabulary).
const POLICY = Object.freeze([
  //  ── the owner's own wall, kept by the owner (ANY lease, any status) ──
  { table: "leases", column: "space_id", treatment: B, status_column: "", terminal: [], null_means: "operative",
    code: "unit_carries_leases", label: "lease", enforced_by: "trg_refuse_lease_on_retired_inventory (180) + retireInventoryUnits",
    why: "A lease at any grain is tenancy truth; retiring beneath it would hide a real position." },
  //  ── inventory hierarchy ──
  { table: "spaces", column: "unit_id", treatment: B, status_column: "", terminal: [], null_means: "operative",
    code: "child_space", label: "position", counts_as_blocker: false,
    why: "A new or reparented position under a retired unit would revive it without a decision. Existing positions are the unit's own." },
  //  ── leasing commitments ──
  { table: "lease_applications", column: "unit_id", treatment: B, status_column: "status", terminal: ["declined", "withdrawn", "expired"], null_means: "operative", code: "open_applications", label: "application" },
  { table: "lease_applications", column: "space_id", treatment: B, status_column: "status", terminal: ["declined", "withdrawn", "expired"], null_means: "operative", code: "open_applications", label: "application" },
  { table: "lease_offers", column: "space_id", treatment: B, status_column: "status", terminal: ["expired", "superseded", "cancelled"], null_means: "operative", code: "current_offers", label: "offer" },
  { table: "application_invitations", column: "unit_id", treatment: B, status_column: "status", terminal: ["consumed", "expired", "revoked"], null_means: "operative", code: "open_invitations", label: "invitation" },
  { table: "application_invitations", column: "space_id", treatment: B, status_column: "status", terminal: ["consumed", "expired", "revoked"], null_means: "operative", code: "open_invitations", label: "invitation" },
  { table: "lease_packets", column: "unit_id", treatment: B, status_column: "status", terminal: ["voided", "executed"], null_means: "operative", code: "open_lease_packets", label: "lease packet" },
  { table: "lease_economic_schedules", column: "space_id", treatment: B, status_column: "status", terminal: ["cancelled", "superseded"], null_means: "operative", code: "economic_schedules", label: "economic schedule" },
  { table: "executed_lease_records", column: "space_id", treatment: B, status_column: "record_state", terminal: ["superseded", "voided"], null_means: "operative", code: "executed_lease_records", label: "executed lease record" },
  { table: "renewal_cases", column: "space_id", treatment: B, status_column: "terminal_state", terminal: ["executed", "declined", "notice_received", "moved_to_turnover", "closed"], null_means: "operative", code: "open_renewals", label: "renewal case" },
  //  ── possession and scheduled unit events ──
  { table: "unit_events", column: "unit_id", treatment: B, status_column: "status", terminal: ["cancelled", "superseded"], null_means: "operative", code: "possession_recorded", label: "unit event" },
  { table: "unit_events", column: "space_id", treatment: B, status_column: "status", terminal: ["cancelled", "superseded"], null_means: "operative", code: "possession_recorded", label: "unit event" },
  //  ── tours ──
  { table: "tour_availability", column: "unit_id", treatment: B, status_column: "status", terminal: ["cancelled"], null_means: "operative", code: "future_tours", label: "tour slot", extra_operative_sql: "and t.ends_at > now()" },
  { table: "leasing_tours", column: "unit_id", treatment: B, status_column: "status", terminal: ["completed", "no_show", "cancelled", "rescheduled"], null_means: "operative", code: "future_tours", label: "tour" },
  //  ── work, turnover, obligations ──
  { table: "work_orders", column: "unit_id", treatment: B, status_column: "status", terminal: ["closed", "cancelled", "completed", "done", "resolved", "void", "not_done"], null_means: "operative", code: "open_work_orders", label: "work order" },
  { table: "turnovers", column: "unit_id", treatment: B, status_column: "status", terminal: ["closed", "cancelled", "complete", "completed", "done"], null_means: "operative", code: "open_turnovers", label: "turnover" },
  { table: "obligations", column: "unit_id", treatment: B, status_column: "status", terminal: ["complete", "completed", "cancelled", "closed"], null_means: "operative", code: "open_obligations", label: "obligation" },
  { table: "unit_triage_required_work", column: "unit_id", treatment: B, status_column: "status", terminal: ["complete", "withdrawn", "superseded"], null_means: "operative", code: "required_work", label: "required work" },
  { table: "unit_triage_required_work", column: "space_id", treatment: B, status_column: "status", terminal: ["complete", "withdrawn", "superseded"], null_means: "operative", code: "required_work", label: "required work" },
  { table: "unit_readiness_certifications", column: "unit_id", treatment: B, status_column: "state", terminal: ["revoked", "corrected"], null_means: "operative", code: "readiness_certifications", label: "readiness certification" },
  { table: "bids", column: "unit_id", treatment: B, status_column: "", terminal: [], null_means: "operative", code: "procurement", label: "bid" },
  { table: "supply_requests", column: "unit_id", treatment: B, status_column: "", terminal: [], null_means: "operative", code: "procurement", label: "supply request" },
  //  ── money and claims: evidence with economic consequence; never "zero" ──
  { table: "scheduled_charges", column: "unit_id", treatment: B, status_column: "", terminal: [], null_means: "operative", code: "money_attached", label: "scheduled charge" },
  { table: "ledger_claims", column: "unit_id", treatment: B, status_column: "", terminal: [], null_means: "operative", code: "money_attached", label: "ledger claim" },
  { table: "deposit_claims", column: "unit_id", treatment: B, status_column: "", terminal: [], null_means: "operative", code: "money_attached", label: "deposit claim" },
  { table: "money_events", column: "unit_id", treatment: B, status_column: "", terminal: [], null_means: "operative", code: "money_attached", label: "money event" },
  //  ── configuration attachments ──
  { table: "utility_service_points", column: "unit_id", treatment: B, status_column: "", terminal: [], null_means: "operative", code: "configured_services", label: "utility service point" },
  { table: "utility_service_points", column: "space_id", treatment: B, status_column: "", terminal: [], null_means: "operative", code: "configured_services", label: "utility service point" },
  { table: "contracted_service_locations", column: "unit_id", treatment: B, status_column: "", terminal: [], null_means: "operative", code: "configured_services", label: "contracted service location" },
  { table: "contracted_service_locations", column: "space_id", treatment: B, status_column: "", terminal: [], null_means: "operative", code: "configured_services", label: "contracted service location" },
  //  ── retained history: evidence of what happened, identity kept ──
  { table: "unit_triage_findings", column: "unit_id", treatment: H, label: "triage finding" },
  { table: "unit_triage_confirmations", column: "unit_id", treatment: H, label: "triage confirmation" },
  { table: "unit_readiness_walks", column: "unit_id", treatment: H, label: "readiness walk" },
  { table: "unit_turn_scopes", column: "unit_id", treatment: H, label: "turn scope" },
  { table: "unit_turn_appliances", column: "unit_id", treatment: H, label: "turn appliance" },
  { table: "work_acceptances", column: "unit_id", treatment: H, label: "work acceptance" },
  { table: "work_completion_claims", column: "unit_id", treatment: H, label: "completion claim" },
  { table: "work_reopenings", column: "unit_id", treatment: H, label: "work reopening" },
  { table: "work_proof_attachments", column: "unit_id", treatment: H, label: "work proof" },
  { table: "unit_observations", column: "unit_id", treatment: H, label: "observation" },
  { table: "reclean_rulings", column: "unit_id", treatment: H, label: "reclean ruling" },
  { table: "tour_units_shown", column: "unit_id", treatment: H, label: "tour shown" },
  { table: "documents", column: "unit_id", treatment: H, label: "document" },
  { table: "comm_events", column: "unit_id", treatment: H, label: "communication" },
  { table: "events", column: "unit_id", treatment: H, label: "event" },
  { table: "staff_agent_messages", column: "unit_id", treatment: H, label: "staff agent message" },
  { table: "staff_agent_proposals", column: "unit_id", treatment: H, label: "staff agent proposal" },
  { table: "obligation_input_proofs", column: "unit_id", treatment: H, label: "obligation proof" },
  { table: "agent_facts", column: "space_id", treatment: H, label: "agent fact" },
  { table: "demo_runs", column: "unit_id", treatment: H, label: "demo run" },
  { table: "demo_runs", column: "space_id", treatment: H, label: "demo run" },
  //  ── interest, not commitment ──
  { table: "leasing_leads", column: "unit_id", treatment: I, label: "lead interest" },
  { table: "conversations", column: "unit_id", treatment: I, label: "conversation interest" },
  { table: "persons", column: "interested_unit_id", treatment: I, label: "person interest" },
  { table: "leasing_conversions", column: "preferred_unit_id", treatment: I, label: "preferred unit" },
  { table: "agent_runs", column: "selected_unit_id", treatment: I, label: "agent run selection" },
  //  ── lineage and the ledger itself ──
  { table: "import_source_rows", column: "produced_unit_id", treatment: L, label: "source row" },
  { table: "import_source_rows", column: "produced_space_id", treatment: L, label: "source row" },
  { table: "ingest_candidates", column: "promoted_unit_id", treatment: L, label: "promotion" },
  { table: "inventory_retirements", column: "unit_id", treatment: R, label: "retirement" },
]);

const BLOCKING = Object.freeze(POLICY.filter((p) => p.treatment === B));

//  The SQL predicate for "this row is operative", on alias `t`.
function operativeSql(entry) {
  if (!entry.status_column) return "true" + (entry.extra_operative_sql ? " " + entry.extra_operative_sql : "");
  const list = entry.terminal.map((s) => `'${s.replace(/'/g, "''")}'`).join(",");
  const nullCase = entry.null_means === "operative" ? "true" : "false";
  const base = list.length
    ? `(case when t.${entry.status_column} is null then ${nullCase} else t.${entry.status_column} not in (${list}) end)`
    : `(case when t.${entry.status_column} is null then ${nullCase} else true end)`;
  return base + (entry.extra_operative_sql ? " " + entry.extra_operative_sql : "");
}

//  Which table+column pairs the migration must carry a trigger for. One
//  trigger per TABLE (the function reads unit_id/space_id itself); the
//  status vocabulary is the same for every column of that table.
function triggerTables() {
  const byTable = new Map();
  for (const e of BLOCKING) {
    if (e.table === "leases") continue;   //  180's own trigger
    if (!byTable.has(e.table)) byTable.set(e.table, e);
  }
  return [...byTable.values()];
}

module.exports = { POLICY, BLOCKING, TREATMENTS: Object.freeze({ B, H, I, L, R }), operativeSql, triggerTables };
