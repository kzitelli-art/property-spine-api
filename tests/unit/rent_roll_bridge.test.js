#!/usr/bin/env node
/**
 * PERSON → RENT-ROLL BRIDGE PROOF
 *
 * The rent roll is unit-keyed reconciliation truth; the lifecycle is
 * person-keyed. They meet at the lease. This harness runs the REAL
 * readLatestSnapshot + spacePosition code against a stub Postgres and
 * proves the bridge:
 *
 *   · a signed (pending, forward) lease APPEARS on its unit row as forward
 *     intent — with the person — and never enters current occupancy
 *   · a commenced lease + recorded possession appears as canonical current
 *     truth, lighting person_id for the app's person-keyed doorways
 *   · canonical/reconciliation disagreement is SURFACED, never resolved
 *   · reconciliation-only rows pass through untouched
 *   · spacePosition failure degrades honestly (no canonical, no guess)
 *
 * Claim ceiling: locally-exercised (real modules, stub Postgres). The live
 * proof is GET /operator/rent-roll after a real confirm-term.
 *
 * Run from the repo root:  node rent_roll_bridge.test.js
 */
const path = require("path");
let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else { fail++; console.log("  FAIL  " + name + (detail ? "  → " + detail : "")); }
};

const PROP = "prop-1";
const P_MARLOW = "11111111-1111-1111-1111-111111111111";
const P_RIVER = "22222222-2222-2222-2222-222222222222";
const P_GHOST = "33333333-3333-3333-3333-333333333333"; // no persons row — name must be honest null

// the reconciliation document — four units, occupancy totals fixed by the doc
const DOC = {
  property: { name: "Proof Building" },
  as_of: "2026-07-22", ledger_cut: "2026-07-21",
  inventory: { residential_units: 4, current_occupied: 2, current_vacant: 2, model: 0, down: 0, current_occupancy_pct: 0.5 },
  september_1: { current_occupied_monthly_rent: 3400 },
  unit_truth: [
    { Unit: "101", "Unit Type": "1BR", SF: 650, "Current State": "occupied", "Current Resident": "Legacy Resident", "Current Rent": 1700, "Current Lease End": "2026-12-31" },
    { Unit: "202", "Unit Type": "2BR", SF: 900, "Current State": "vacant", "Current Rent": null },
    { Unit: "303", "Unit Type": "1BR", SF: 640, "Current State": "occupied", "Current Resident": null, "Current Rent": 1500, "Current Lease End": "2027-01-31" },
    { Unit: "404", "Unit Type": "STU", SF: 420, "Current State": "vacant", "Current Rent": null },
  ],
};

// canonical positions feeding the overlay:
//  303: commenced lease + possession, rent DISAGREES with reconciliation (1600 vs 1500)
//  202: Marlow's forward pending lease (starts after as_of) — the demo scenario
//  404: possession with NO valid lease (conflict class) — the honest-alarm case
//  101: reconciliation-only (no spaces rows returned for it)
const SPACE_ROWS = [
  { space_id: "sp-303", unit_id: "u-303", unit_number: "303", space_label: null,
    leases: [{ id: "L-303", lease_status: "active", start_date: "2026-01-01", end_date: "2027-01-31", rent: 1600, tenant_ids: [P_RIVER] }],
    possession_events: [{ event_type: "move_in", effective_date: "2026-01-02", status: "effective" }],
    notice_date: null, turn_status: null, compat_occupancy: "occupied" },
  { space_id: "sp-202", unit_id: "u-202", unit_number: "202", space_label: null,
    leases: [{ id: "L-202", lease_status: "pending", start_date: "2026-08-01", end_date: "2027-07-31", rent: 1850, tenant_ids: [P_MARLOW] }],
    possession_events: [], notice_date: null, turn_status: null, compat_occupancy: "vacant" },
  { space_id: "sp-404", unit_id: "u-404", unit_number: "404", space_label: null,
    leases: [{ id: "L-404", lease_status: "voided", start_date: "2025-01-01", end_date: "2025-12-31", rent: 1200, tenant_ids: [P_GHOST] }],
    possession_events: [{ event_type: "move_in", effective_date: "2025-01-02", status: "effective" }],
    notice_date: null, turn_status: null, compat_occupancy: "occupied" },
];

function makePool({ breakSpaces = false } = {}) {
  return {
    query: async (sql, params) => {
      const s = String(sql);
      if (/source_type='rent_roll_reconciliation'/.test(s))
        return { rows: [{ id: "B-1", source_type: "rent_roll_reconciliation", source_file: "recon.xlsx", source_as_of_date: "2026-07-22", leasing_model: "unit", confidence: "manually_reviewed", status: "committed", loaded_at: "2026-07-22T00:00:00Z", notes: null }] };
      if (/rent_roll_truth_reconciliation_document/.test(s))
        return { rows: [{ raw: { payload: DOC } }] };
      if (/source_type in \('rent_roll_ledger','historical_snapshot'\)/.test(s))
        return { rows: [] }; // no baseline batch — rows come from the reconciliation
      if (/from spaces s/.test(s)) {
        if (breakSpaces) throw new Error("simulated spaces outage");
        return { rows: JSON.parse(JSON.stringify(SPACE_ROWS)) };
      }
      if (/from persons where id\s*=\s*any/.test(s)) {
        const ids = params[0] || [];
        const known = { [P_MARLOW]: "Marlow Reyes", [P_RIVER]: "River Chen" }; // P_GHOST deliberately absent
        return { rows: ids.filter((i) => known[i]).map((i) => ({ id: i, name: known[i] })) };
      }
      return { rows: [] };
    },
  };
}

(async () => {
  console.log("\nPERSON → RENT-ROLL BRIDGE PROOF\n");

  // reach the un-exported reader through the module's route, or directly if exported.
  // readLatestSnapshot is module-internal; drive it through GET /operator/rent-roll
  // with a stubbed session — the same path the app takes.
  const loaderModule = require(path.join(__dirname, "..", "..", "src", "shared", "snapshot_loader.js"));
  const spaceMod = require(path.join(__dirname, "..", "..", "src", "tenancy", "space_position.js"));

  // ── 1. spacePosition surfaces the person ─────────────────────────────
  console.log("1. spacePosition carries tenant identity");
  const sp = await spaceMod.spacePosition(makePool(), { property_id: PROP, as_of: "2026-07-22" });
  const pos202 = sp.positions.find((p) => p.unit_number === "202");
  const pos303 = sp.positions.find((p) => p.unit_number === "303");
  const pos404 = sp.positions.find((p) => p.unit_number === "404");
  ok("forward lease carries its tenant (person_id + name)",
    !!(pos202 && pos202.future_lease_position && pos202.future_lease_position.tenants &&
    pos202.future_lease_position.tenants[0] &&
    pos202.future_lease_position.tenants[0].person_id === P_MARLOW &&
    pos202.future_lease_position.tenants[0].name === "Marlow Reyes"));
  ok("current lease carries its tenant",
    !!(pos303 && pos303.current_lease_position && pos303.current_lease_position.tenants &&
    pos303.current_lease_position.tenants[0] &&
    pos303.current_lease_position.tenants[0].name === "River Chen"));
  ok("a pending lease is NOT a current position (date + validity test)",
    pos202 && pos202.current_lease_position === null);
  ok("voided lease is invalid → possession_without_current_lease alarm",
    pos404 && pos404.next_required_action === "possession_without_current_lease");

  // ── 2. the rent-roll read with the overlay ───────────────────────────
  console.log("\n2. GET /operator/rent-roll (the app's exact read path)");
  const express = require("express");
  const app = express();
  // stub the staff session the route resolves
  const staffSessions = require(path.join(__dirname, "..", "..", "src", "identity", "staff_session_service.js"));
  const realResolve = staffSessions.resolveStaffSession;
  staffSessions.resolveStaffSession = async () => ({ id: "op-1", property_id: PROP });
  app.use("/", loaderModule({ pool: makePool() }));
  const srv = app.listen(0);
  const port = srv.address().port;
  const res = await fetch(`http://127.0.0.1:${port}/operator/rent-roll`, { headers: { "x-staff-session": "T" } });
  const body = await res.json();
  srv.close();
  staffSessions.resolveStaffSession = realResolve;

  ok("route answers 200 with reconciliation truth", res.status === 200 && body.has_data === true && body.rows.length === 4);
  ok("position overlay reported ok", body.position_status === "ok");

  const r101 = body.rows.find((r) => r.unit_number === "101");
  const r202 = body.rows.find((r) => r.unit_number === "202");
  const r303 = body.rows.find((r) => r.unit_number === "303");
  const r404 = body.rows.find((r) => r.unit_number === "404");

  // THE DEMO SCENARIO: Marlow signs → confirm-term → pending lease → the rent roll shows it
  ok("Marlow's forward lease appears on unit 202 as forward intent",
    r202 && r202.canonical && r202.canonical.forward && r202.canonical.forward.lease_id === "L-202");
  ok("…with the person (person_id lights the app's doorways)",
    r202 && r202.person_id === P_MARLOW && r202.name === "Marlow Reyes");
  ok("…and the unit still reads vacant/committed_future — forward ≠ current occupancy",
    r202 && r202.status === "vacant" && r202.canonical && r202.canonical.availability_state === "committed_future" && r202.canonical.current === null);
  ok("current-occupancy denominators untouched by forward leases",
    body.summary.occupied === 2 && body.summary.vacant === 2 && body.summary.inventory === 4);

  ok("commenced+possessed lease appears as canonical current on 303",
    r303 && r303.canonical && r303.canonical.current && r303.canonical.current.lease_id === "L-303" &&
    r303.canonical.possession && r303.canonical.possession.since === "2026-01-02");
  ok("303 name filled from the person where reconciliation had none",
    r303 && r303.name === "River Chen" && r303.person_id === P_RIVER);
  ok("rent disagreement SURFACED, both numbers, nothing overwritten",
    r303 && r303.actual_rent === 1500 && r303.canonical &&
    (r303.canonical.conflicts || []).some((c) => c.field === "rent" && c.reconciliation === 1500 && c.canonical === 1600));
  ok("possession-without-lease conflict surfaced on 404",
    r404 && r404.canonical && (r404.canonical.conflicts || []).some((c) => String(c.canonical).includes("possession_without_current_lease")));
  ok("unknown person renders honest null name, never invented",
    r404 && (r404.name == null));
  ok("reconciliation-only row (101) passes through with no canonical block",
    r101 && !r101.canonical && r101.name === "Legacy Resident" && r101.person_id == null);
  ok("summary counts the bridge without changing occupancy math",
    !!(body.summary && body.summary.canonical_rows === 3 && body.summary.canonical_forward_rows === 1 && body.summary.canonical_conflict_rows >= 2));

  // ── 3. honest degradation ────────────────────────────────────────────
  console.log("\n3. Honest degradation when position truth is unavailable");
  const app2 = express();
  staffSessions.resolveStaffSession = async () => ({ id: "op-1", property_id: PROP });
  app2.use("/", loaderModule({ pool: makePool({ breakSpaces: true }) }));
  const srv2 = app2.listen(0);
  const res2 = await fetch(`http://127.0.0.1:${srv2.address().port}/operator/rent-roll`, { headers: { "x-staff-session": "T" } });
  const body2 = await res2.json();
  srv2.close();
  staffSessions.resolveStaffSession = realResolve;
  ok("spacePosition outage → position_status unavailable, rows still served",
    body2.position_status === "unavailable" && body2.rows.length === 4);
  ok("…and no canonical blocks are fabricated", body2.rows.every((r) => !r.canonical));

  console.log("\n" + "-".repeat(52));
  console.log((fail === 0 ? "ALL PASS" : "FAILURES PRESENT") + `   ${pass}/${pass + fail}`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error("harness error:", e); process.exit(1); });
