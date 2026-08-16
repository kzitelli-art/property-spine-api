"use strict";

const assert = require("assert");
const contract = require("../src/asset/contracted_service_contract.js");
const rooms = require("../src/surfaces/asset_management.js").ROOMS;

assert.strictEqual(contract.CONTRACT_VERSION, "contracted_service.v1");
assert(contract.isOpenServiceKey("building_cleaning"));
assert(contract.isOpenServiceKey("facade_access_system"));
assert(!contract.isOpenServiceKey("Building cleaning"));
assert(!contract.isOpenServiceKey("x"));

assert.strictEqual(contract.labelForService("elevator_maintenance"), "Elevator maintenance");
assert.strictEqual(contract.labelForService("facade_access_system"), "facade access system");
assert.strictEqual(contract.labelForService("other", "Window washing"), "Window washing");

assert(contract.REQUIREMENT_DETERMINATIONS.includes("managed_in_house"));
assert(contract.DOCUMENT_KINDS.includes("proposal"));
assert(contract.DOCUMENT_KINDS.includes("accounting_report"));
assert(contract.EXECUTION_STATES.includes("partially_executed"));
assert(contract.TERM_AUTHORITIES.includes("offered"));
assert(contract.PRICE_BASES.includes("per_visit"));

const walls = new Set(contract.TRUTH_WALLS.map((wall) => `${wall.left}!=${wall.right}`));
for (const wall of [
  "financial_expense_line!=executed_service_contract",
  "proposal!=executed_agreement",
  "automatic_renewal_clause!=confirmed_renewal_outcome",
  "scheduled_service!=completed_service",
  "contracted_service!=utility_service_topology",
  "contracted_service!=compliance_standing",
  "contracted_service!=maintenance_work_execution",
  "contract_price!=accounting_actual",
  "not_established!=not_applicable",
]) assert(walls.has(wall), `missing truth wall ${wall}`);

assert.strictEqual(contract.CAPABILITIES.retrieval.claimed, true);
assert.strictEqual(contract.CAPABILITIES.comparison.claimed, false);
assert.strictEqual(contract.CAPABILITIES.causal_explanation.claimed, false);

assert.throws(() => contract.enumValue("execution_state", "probably_signed",
  contract.EXECUTION_STATES), (error) => error.code === "BAD_INPUT");
assert.strictEqual(contract.enumValue("notice", null, ["yes"], { nullable: true }), null);

const propertyExpenses = rooms.find((room) => room.key === "property_expenses");
const overviewCompartment = propertyExpenses.compartments.find(
  (compartment) => compartment.key === "contracted_services");
assert.strictEqual(overviewCompartment.derived, "contracted_services",
  "the Asset Management overview must render Contracted Services from its canonical standing");

console.log("contracted service contract tests passed");

