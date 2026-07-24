"use strict";

const fs = require("fs");
const path = require("path");
const assert = require("assert");

const root = __dirname;
const read = (name) => fs.readFileSync(path.join(root, name), "utf8");
const movein = read("movein.js");
const delivery = read("delivery.js");
const position = read("space_position.js");
const tenancy = read("economic_tenancy_service.js");
const charges = read("charges.js");
const migration = read("migrations/089_economic_tenancy_and_move_in_handoff.sql");

let passed = 0;
function check(name, condition) {
  assert(condition, name);
  passed++;
  console.log(`✓ ${name}`);
}
function includes(text, value) { return text.includes(value); }
function notIncludes(text, value) { return !text.includes(value); }
function between(text, start, end) {
  const a = text.indexOf(start);
  const b = text.indexOf(end, a + start.length);
  assert(a >= 0 && b > a, `section not found: ${start}`);
  return text.slice(a, b);
}

const readinessApproval = between(movein, "async function approveReadiness", "// ── SESSION-AUTHENTICATED");
const handoffRoute = between(movein, 'router.post("/operator/leasing/leases/:leaseId/delivery/keys-handed-over"', "// ── LEGACY/OPERATIONS");
const legacyApprove = between(movein, 'router.post("/movein/:obligationId/approve"', 'router.get("/move-ins"');

check("maintenance gates exclude keys/access preparation", includes(movein, 'const OPERATIONAL_GATES = ["readiness_checklist", "appliances_checked", "unit_condition_photos"]'));
check("readiness approval does not write possession", notIncludes(readinessApproval, "recordEffectivePossession"));
check("readiness approval does not write occupancy cache", notIncludes(readinessApproval, "occupancy_status='occupied'"));
check("readiness approval feeds only unit_ready", includes(readinessApproval, 'input_key: "unit_ready"'));
check("readiness approval explicitly states no tenancy or possession change", includes(readinessApproval, "does not activate tenancy or record possession"));
check("legacy body-authored approval is tombstoned", includes(legacyApprove, "410"));
check("legacy approval no longer reads approved_by_person_id", notIncludes(legacyApprove, "approved_by_person_id"));
check("key handoff is session authenticated", includes(movein, "staffSessions.resolveStaffSession"));
check("key handoff actor is server-derived", includes(handoffRoute, "actor: req.operator.id"));
check("key handoff records actor name", includes(handoffRoute, "actor_name: req.operator.name"));
check("key handoff requires recipient", includes(handoffRoute, "recipient_name is required"));
check("key handoff distinguishes resident and representative", includes(handoffRoute, "authorized_representative"));
check("key handoff blocks early possession", includes(handoffRoute, "EARLY_POSSESSION_BLOCKED"));
check("key handoff requires active tenancy", includes(handoffRoute, "TENANCY_NOT_ACTIVE"));
check("key handoff rechecks move-in funds", includes(handoffRoute, "MOVE_IN_FUNDS_OUTSTANDING"));
check("key handoff requires unit and access preparation", includes(handoffRoute, "DELIVERY_NOT_READY"));
check("only key handoff route records move_in possession", includes(handoffRoute, 'kind: "move_in"'));
check("handoff does not activate tenancy", notIncludes(handoffRoute, "lease_status='active'"));
check("delivery completion checks possession", includes(delivery, "hasEffectivePossession"));
check("delivery reports possession outstanding", includes(delivery, 'reason: "possession_outstanding"'));
check("delivery cannot complete from gates alone", includes(delivery, "if (!possession)"));
check("space position current axis requires active/commercial", includes(position, 'CURRENT_ECONOMIC_STATUSES = new Set(["active", "commercial"])'));
check("pending commenced lease has separate activation position", includes(position, "activation_pending_lease_position"));
check("pending commenced lease is not current", includes(position, 'normalizedStatus(lease) === "pending" && datesSpan'));
check("active no-possession state remains visible", includes(position, 'next_required_action = "possession_outstanding"'));
check("activation-pending state names funds requirement", includes(position, 'next_required_action = "economic_tenancy_activation_required"'));
check("possession event carries actual actor", includes(position, "actor,"));
check("possession event supports handoff detail payload", includes(position, 'details && typeof details === "object"'));
check("move-in charges require a positive exact first-period amount",
  includes(tenancy, "firstAmount <= 0") && includes(tenancy, "positive number"));
check("move-in charges do not compute proration from monthly rent", notIncludes(tenancy, "prorat"));
check("required fees must be explicitly reviewed", includes(tenancy, "required_fees must be an array"));
check("exact charge calculation carries an attributed note", includes(tenancy, "calculation_note is required"));
check("charge set stores immutable executed-document authority basis", includes(tenancy, "authorityBasis"));
check("economic tenancy requires all required charges paid", includes(tenancy, 'charges.every((c) => c.status === "paid"'));
check("applied payment is sufficient for operational clearance", includes(tenancy, 'proof_strength: fullyApplied'));
check("bank proof remains a stronger separate level", includes(tenancy, '"cash_proven"'));
check("activation updates lease to active", includes(tenancy, "set lease_status='active'"));
check("activation updates contracted occupancy cache", includes(tenancy, "update units set occupancy_status='occupied'"));
check("activation does not write possession event", notIncludes(between(tenancy, "async function attemptEconomicTenancyActivation", "async function composeMoveInState"), "unit_events"));
check("active payment reversal becomes exception, not deactivation", includes(tenancy, "active_money_exception"));
check("first_month suppresses recurring rent for same period", includes(charges, "first_month cannot both be billed"));
check("rent generator checks rent-equivalent claim", includes(charges, "hasRentEquivalent"));
check("missing-charge read accepts first_month as rent coverage", includes(charges, "c.charge_type in ('rent','first_month')"));
check("migration adds activation audit fields", includes(migration, "economic_tenancy_activated_at"));
check("migration creates governed move-in charge set", includes(migration, "create table if not exists lease_move_in_charge_sets"));
check("migration marks required move-in charges", includes(migration, "is_move_in_required"));
check("migration removes keys preparation from maintenance readiness", includes(migration, "array_remove(required_inputs, 'keys_access_ready')"));
check("migration is additive and drops no table", notIncludes(migration.toLowerCase(), "drop table"));
check("new move-in operating read is server-authored", includes(movein, '/operator/leasing/leases/:leaseId/move-in-state'));
check("charge confirmation is session-scoped", includes(movein, '/move-in-charges/confirm'));
check("tenancy activation is session-scoped", includes(movein, '/activate-tenancy'));

console.log(`\n${passed}/${passed} move-in truth-separation checks passed`);
