// ════════════════════════════════════════════════════════════════════
//  by_bed_classification_proof.js — BY-BED CONTRACT PROOF
//
//  Demo Building cannot prove by-bed behaviour: every unit has exactly one
//  whole-unit space. By-bed is a supported leasing model, so it must be
//  proven by contract rather than left to a future property to discover.
//
//  The classifier is pure, so this needs no database, no fixture and no
//  write. Each case constructs the space rows a by-bed unit would produce
//  and asserts the beds classify INDEPENDENTLY.
//
//  Run:  node tests/by_bed_classification_proof.js
// ════════════════════════════════════════════════════════════════════

"use strict";
const path = require("path");
const { classifyPosition } = require(path.join(__dirname, "..", "src/tenancy/position_classifier"));

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("   PASS  " + m); } else { fail++; console.log("   FAIL  " + m); } };

const ASOF = "2026-07-27";
const names = new Map([["p_ana", "Ana"], ["p_ben", "Ben"], ["p_cal", "Cal"]]);
// One unit, three beds. Same unit_id and unit_number throughout — the whole
// point is that sharing those must NOT merge the beds.
const bed = (label, leases, extra = {}) => classifyPosition({
  space_id: "space_" + label, unit_id: "unit_301", unit_number: "301", space_label: label,
  leases, possession_events: [], notice_date: null, turn_status: null,
  compat_occupancy: "occupied", ...extra,
}, { asOf: ASOF, personNames: names });

console.log("\n══ one unit, several beds, independent tenancies ══");
const bedA = bed("Bed A", [
  { id: "LA", lease_status: "active", start_date: "2026-01-01", end_date: "2026-12-31", rent: "900", tenant_ids: ["p_ana"], source_type: "historical_snapshot", confidence: "confirmed" },
]);
const bedB = bed("Bed B", [
  { id: "LB", lease_status: "active", start_date: "2026-03-01", end_date: "2026-08-31", rent: "950", tenant_ids: ["p_ben"] },
]);
const bedC = bed("Bed C", []);

ok(bedA.current_lease_position.lease_id === "LA" && bedB.current_lease_position.lease_id === "LB",
  "each bed resolves its OWN lease");
ok(bedA.current_lease_position.tenants[0].name === "Ana" && bedB.current_lease_position.tenants[0].name === "Ben",
  "each bed resolves its OWN resident");
ok(bedA.current_lease_position.end_date !== bedB.current_lease_position.end_date,
  "beds carry different lease dates within one unit");
ok(bedC.current_lease_position === null, "an open bed is open even while siblings are leased");
ok(bedA.space_label === "Bed A" && bedB.space_label === "Bed B" && bedC.space_label === "Bed C",
  "space labels are preserved in the response");
ok(new Set([bedA.space_id, bedB.space_id, bedC.space_id]).size === 3,
  "each bed is a distinct position keyed by space_id");
ok(bedA.unit_number === bedB.unit_number && bedA.unit_number === bedC.unit_number,
  "beds share unit_number — which is exactly why it must never be the aggregation key");

console.log("\n══ successor on one bed does not touch its siblings ══");
const bedWithSuccessor = bed("Bed A", [
  { id: "LA", lease_status: "active", start_date: "2026-01-01", end_date: "2026-08-31", rent: "900", tenant_ids: ["p_ana"] },
  { id: "LA2", lease_status: "pending", start_date: "2026-09-01", end_date: "2027-08-31", rent: "950", tenant_ids: ["p_cal"] },
]);
ok(bedWithSuccessor.successor.state === "pending" && bedWithSuccessor.successor.lease_id === "LA2",
  "the bed with a next lease reports successor_state=pending");
ok(bedC.successor.state === "none", "the open sibling bed still reports successor_state=none");
ok(bedB.successor.state === "none", "the leased sibling without a next lease reports successor_state=none");

console.log("\n══ contest on one bed does not contaminate siblings ══");
const bedContested = bed("Bed A", [
  { id: "X1", lease_status: "active", start_date: "2026-01-01", end_date: "2026-12-31", rent: "900", tenant_ids: ["p_ana"] },
  { id: "X2", lease_status: "pending", start_date: "2026-06-01", end_date: "2027-05-31", rent: "980", tenant_ids: ["p_cal"] },
]);
ok(bedContested.conflict_state === "conflicted", "the contested bed is conflicted");
ok(bedContested.conflicting_lease_ids.length === 2, "both competing claims are named");
ok(bedContested.successor.state === "none", "an overlapping lease is not promoted to successor");
ok(bedB.conflict_state === "clear" && bedC.conflict_state === "clear",
  "sibling beds remain clear — contest does not spread across the unit");

console.log("\n══ unit-level condition applies to every bed ══");
// Turn state is a UNIT fact; the loader supplies it per space row, so every
// bed of a turning unit sees it. Proven here so the rule is explicit.
const turningA = bed("Bed A", [], { turn_status: "in_progress" });
const turningB = bed("Bed B", [], { turn_status: "in_progress" });
ok(turningA.physical_readiness === "turning" && turningB.physical_readiness === "turning",
  "a unit-level turn reaches every bed of the unit");
ok(turningA.availability_state === "vacant_turning",
  "a turning empty bed is vacant_turning, not ready_now");

console.log("\n══ notice is per-space, not per-unit ══");
const noticedBed = bed("Bed A", [
  { id: "LA", lease_status: "active", start_date: "2026-01-01", end_date: "2026-12-31", rent: "900", tenant_ids: ["p_ana"] },
], { notice_date: "2026-09-30" });
ok(noticedBed.notice_state === "on_notice" && noticedBed.availability_state === "on_notice",
  "the bed whose space carries the notice is on_notice");
ok(bedB.notice_state === "none", "a sibling bed without its own notice is not on_notice");

console.log("\n══ no aggregation by unit_number anywhere in the classifier ══");
const src = require("fs").readFileSync(path.join(__dirname, "..", "src/tenancy/position_classifier.js"), "utf8")
  .split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
ok(!/unit_number\s*[\]\[.=]/.test(src.replace("unit_number: row.unit_number,", "")),
  "unit_number is passed through only — never used to group, join or compare");

console.log(`\n════ ${pass} passed, ${fail} failed ════\n`);
process.exit(fail === 0 ? 0 : 1);
