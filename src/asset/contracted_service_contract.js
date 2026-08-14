"use strict";

const CONTRACT_VERSION = "contracted_service.v1";

// Suggestions help an operator use the portfolio's language. They are not a
// required-service census and never create rows or gaps by their mere presence.
const COMMON_SERVICE_SUGGESTIONS = Object.freeze([
  Object.freeze({ key: "building_cleaning", label: "Building cleaning" }),
  Object.freeze({ key: "elevator_maintenance", label: "Elevator maintenance" }),
  Object.freeze({ key: "fire_alarm_monitoring", label: "Fire alarm monitoring" }),
  Object.freeze({ key: "fire_sprinkler_service", label: "Fire sprinkler service" }),
  Object.freeze({ key: "security_concierge", label: "Security / concierge" }),
  Object.freeze({ key: "hvac_maintenance", label: "HVAC maintenance" }),
  Object.freeze({ key: "waste_removal", label: "Waste removal" }),
  Object.freeze({ key: "compactor_rental", label: "Compactor rental / service" }),
  Object.freeze({ key: "pest_control", label: "Pest control" }),
  Object.freeze({ key: "snow_removal", label: "Snow removal" }),
  Object.freeze({ key: "landscaping", label: "Landscaping" }),
  Object.freeze({ key: "water_treatment", label: "Water treatment" }),
  Object.freeze({ key: "meter_reading", label: "Meter reading" }),
  Object.freeze({ key: "parking_operations", label: "Parking operations" }),
  Object.freeze({ key: "other", label: "Other contracted service" }),
]);

const REQUIREMENT_DETERMINATIONS = Object.freeze([
  "contracted_service_required", "managed_in_house", "not_applicable",
]);
const DOCUMENT_KINDS = Object.freeze([
  "proposal", "agreement", "statement_of_work", "amendment", "addendum",
  "renewal_notice", "termination_notice", "invoice",
  "certificate_of_insurance", "service_report", "accounting_report", "other",
]);
const EXECUTION_STATES = Object.freeze([
  "unverified", "unsigned", "partially_executed", "executed",
]);
const TERM_AUTHORITIES = Object.freeze(["offered", "governing", "observed", "asserted"]);
const TERM_KINDS = Object.freeze([
  "fixed", "month_to_month", "continues_until_terminated", "one_time", "unknown",
]);
const PRICE_BASES = Object.freeze([
  "monthly", "annual", "per_visit", "hourly", "per_unit", "flat", "variable", "other",
]);
const FINANCIAL_OBSERVATION_KINDS = Object.freeze([
  "accounting_line", "underwriting", "budget", "invoice", "payment_claim", "other",
]);
const LOCATION_KINDS = Object.freeze([
  "whole_property", "building", "common_area", "equipment", "unit", "space", "other",
]);

const TRUTH_WALLS = Object.freeze([
  ["financial_expense_line", "executed_service_contract", ["contracted", "under contract", "active"]],
  ["budget_or_underwriting_assumption", "contractual_commitment", ["budgeted", "committed", "contracted"]],
  ["invoice", "governing_agreement", ["contract", "current agreement"]],
  ["invoice_amount", "contracted_price", ["contract price", "rate"]],
  ["invoice_amount", "accrued_expense", ["expense", "actual"]],
  ["invoice_amount", "amount_paid", ["paid", "settled"]],
  ["vendor_payee", "contractual_provider_identity", ["vendor", "provider", "contractor"]],
  ["provider_identity", "legal_entity_identity", ["legal name", "contracting party"]],
  ["provider_relationship", "engagement", ["contract", "engaged"]],
  ["service_category", "scope_of_work", ["scope", "covered"]],
  ["proposal", "executed_agreement", ["contract", "signed", "governing"]],
  ["partially_executed", "executed", ["signed", "executed"]],
  ["current_contracts_folder", "current_governing_contract", ["current", "active"]],
  ["document_effective_date", "execution", ["effective", "executed", "active"]],
  ["term_end", "notice_deadline", ["expires", "notice due", "renewal"]],
  ["automatic_renewal_clause", "confirmed_renewal_outcome", ["renewed", "current"]],
  ["passed_notice_deadline", "confirmed_renewal", ["renewed", "extended"]],
  ["scheduled_service", "completed_service", ["done", "serviced", "completed"]],
  ["service_report", "contracted_scope_satisfied", ["performed", "compliant", "complete"]],
  ["certificate_of_insurance", "active_service_agreement", ["active vendor", "under contract"]],
  ["certificate_of_insurance", "current_insurance_coverage", ["insured", "covered"]],
  ["contracted_service", "utility_service_topology", ["utility service", "provider account"]],
  ["contracted_service", "compliance_standing", ["compliant", "inspection current"]],
  ["contracted_service", "maintenance_work_execution", ["repaired", "completed", "done"]],
  ["contract_price", "accounting_actual", ["actual", "spent", "expense"]],
  ["provider", "one_contract", ["the contract", "only agreement"]],
  ["property_agreement", "portfolio_master_agreement", ["portfolio agreement", "all properties"]],
  ["missing_agreement", "no_agreement_exists", ["no contract", "not contracted"]],
  ["not_established", "not_applicable", ["none", "no", "does not apply"]],
].map(([left, right, dangerous_terms]) => Object.freeze({ left, right, dangerous_terms })));

const DOES_NOT_ESTABLISH = Object.freeze([
  Object.freeze({ fact: "financial_observation", does_not_establish: "governing_agreement" }),
  Object.freeze({ fact: "invoice", does_not_establish: "provider_payment" }),
  Object.freeze({ fact: "proposal", does_not_establish: "executed_agreement" }),
  Object.freeze({ fact: "document_folder_location", does_not_establish: "current_term" }),
  Object.freeze({ fact: "automatic_renewal_clause", does_not_establish: "renewal_outcome" }),
  Object.freeze({ fact: "service_schedule", does_not_establish: "service_completion" }),
  Object.freeze({ fact: "service_report", does_not_establish: "full_scope_satisfaction" }),
  Object.freeze({ fact: "vendor_certificate_of_insurance", does_not_establish: "property_coverage" }),
  Object.freeze({ fact: "utility_provider_relationship", does_not_establish: "service_contract" }),
  Object.freeze({ fact: "inspection_record", does_not_establish: "service_contract" }),
  Object.freeze({ fact: "missing_requirement", does_not_establish: "not_applicable" }),
]);

const CAPABILITIES = Object.freeze({
  retrieval: Object.freeze({
    claimed: true,
    basis: "governed Contracted Services standing, terms, scope and recorded observations",
  }),
  comparison: Object.freeze({
    claimed: false,
    clearing_condition: "a governed normalization basis is recorded for the requested comparison",
  }),
  causal_explanation: Object.freeze({
    claimed: false,
    clearing_condition: "a recorded causal fact links the changed result to a governed cause",
  }),
});

function isOpenServiceKey(value) {
  return /^[a-z][a-z0-9_]{1,63}$/.test(String(value || ""));
}

function labelForService(key, supplied) {
  if (supplied && String(supplied).trim()) return String(supplied).trim();
  const found = COMMON_SERVICE_SUGGESTIONS.find((item) => item.key === key);
  return found ? found.label : String(key || "").replace(/_/g, " ");
}

function enumValue(name, value, choices, { nullable = false } = {}) {
  if (nullable && (value === null || value === undefined || value === "")) return null;
  if (!choices.includes(value)) {
    const error = new Error(`${name} must be one of ${choices.join(", ")}`);
    error.code = "BAD_INPUT";
    throw error;
  }
  return value;
}

module.exports = {
  CONTRACT_VERSION,
  COMMON_SERVICE_SUGGESTIONS,
  REQUIREMENT_DETERMINATIONS,
  DOCUMENT_KINDS,
  EXECUTION_STATES,
  TERM_AUTHORITIES,
  TERM_KINDS,
  PRICE_BASES,
  FINANCIAL_OBSERVATION_KINDS,
  LOCATION_KINDS,
  TRUTH_WALLS,
  DOES_NOT_ESTABLISH,
  CAPABILITIES,
  isOpenServiceKey,
  labelForService,
  enumValue,
};
