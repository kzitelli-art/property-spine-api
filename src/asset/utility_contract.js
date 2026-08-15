"use strict";

const CONTRACT_VERSION = "utility.v1";

const STARTER_SERVICES = Object.freeze([
  Object.freeze({ key: "electricity", label: "Electricity" }),
  Object.freeze({ key: "natural_gas", label: "Natural gas" }),
  Object.freeze({ key: "water", label: "Water" }),
  Object.freeze({ key: "sewer", label: "Sewer" }),
  Object.freeze({ key: "water_sewer_combined", label: "Water / sewer" }),
  Object.freeze({ key: "steam_district_energy", label: "Steam / district energy" }),
  Object.freeze({ key: "fuel_oil", label: "Fuel oil" }),
  Object.freeze({ key: "propane", label: "Propane" }),
  Object.freeze({ key: "internet_data", label: "Internet / data" }),
  Object.freeze({ key: "telephone_telecom", label: "Telephone / telecom" }),
  Object.freeze({ key: "waste_trash", label: "Waste / trash" }),
  Object.freeze({ key: "recycling", label: "Recycling" }),
]);

const SERVICE_KEYS = Object.freeze(STARTER_SERVICES.map((s) => s.key));
const SERVICE_LABELS = Object.freeze(Object.fromEntries(
  STARTER_SERVICES.map((s) => [s.key, s.label])));

const APPLICABILITY = Object.freeze(["present", "not_applicable"]);
const PHYSICAL_ARRANGEMENTS = Object.freeze([
  "whole_building_master_meter",
  "common_house_meter",
  "individual_provider_meters",
  "internal_submeters",
  "shared_plant",
  "non_metered",
  "mixed",
  "unknown",
]);
const SERVICE_POINT_KINDS = Object.freeze([
  "whole_building", "common_area", "unit", "space", "shared_equipment",
  "service_address", "other", "unknown",
]);
const METER_KINDS = Object.freeze(["provider_meter", "internal_submeter"]);
const PROVIDER_BILL_RECIPIENTS = Object.freeze([
  "property", "resident", "billing_administrator", "other_third_party", "mixed",
]);
const PROVIDER_RESPONSIBLE_PARTIES = Object.freeze([
  "property", "resident", "other_third_party", "mixed",
]);
const ECONOMIC_RESPONSIBILITIES = Object.freeze([
  "property", "resident", "shared", "mixed",
]);
const RESIDENT_RECOVERY_METHODS = Object.freeze([
  "none_property_absorbs", "included_in_rent", "resident_direct_to_provider",
  "fixed_fee", "rubs_allocation", "actual_submeter_usage", "passthrough",
  "mixed", "other",
]);
const RESIDENT_PAYMENT_RECIPIENTS = Object.freeze([
  "property", "provider", "billing_administrator", "other_third_party", "mixed",
  "not_applicable",
]);
const USAGE_BASES = Object.freeze(["observed", "estimated", "stated_unknown"]);

const METERED_ARRANGEMENTS = Object.freeze([
  "whole_building_master_meter", "common_house_meter",
  "individual_provider_meters", "internal_submeters", "mixed",
]);

const THIRD_PARTY_RECOVERY_METHODS = Object.freeze([
  "fixed_fee", "rubs_allocation", "actual_submeter_usage", "passthrough", "mixed", "other",
]);

const TRUTH_WALLS = Object.freeze([
  ["service_not_established", "service_not_applicable", ["have", "has", "none", "no"]],
  ["provider", "billing_administrator", ["provider", "utility company", "biller"]],
  ["provider_account", "property", ["account", "our account"]],
  ["provider_account", "meter", ["account", "meter", "submetered"]],
  ["meter", "submeter", ["metered", "submetered"]],
  ["meter", "unit", ["unit meter", "unit account"]],
  ["account_identifier", "service_location", ["account", "serves"]],
  ["bill_date", "service_period", ["current", "July bill"]],
  ["statement_amount", "current_amount_due", ["owe", "due", "bill"]],
  ["amount_billed", "amount_paid", ["paid", "settled", "handled"]],
  ["payment_date", "expense_period", ["paid in", "expense month"]],
  ["payment", "economic_expense", ["cost", "expense", "paid"]],
  ["resident_charge", "provider_statement", ["utility bill", "billed"]],
  ["resident_charge", "resident_collection", ["reimbursed", "recovered"]],
  ["resident_collection", "provider_payment", ["paid", "covered"]],
  ["resident_recovery", "provider_obligation_reduction", ["recovered", "net"]],
  ["resident_direct", "property_paid_then_recovered", ["tenant paid", "resident paid"]],
  ["master_metered", "submetered", ["master metered", "submetered"]],
  ["provider_metered", "resident_lease_responsibility", ["tenant meter", "tenant pays"]],
  ["submeter", "provider_account", ["submeter", "account"]],
  ["estimated_usage", "observed_usage", ["usage", "reading"]],
  ["late_fee", "utility_consumption", ["usage cost", "bill amount"]],
  ["billing_administrator_calculation", "provider_statement", ["Conservice bill", "provider bill"]],
  ["lease_obligation", "collected_cash", ["resident owes", "resident paid"]],
  ["cash_reading", "accrual_reading", ["month", "expense", "paid"]],
].map(([left, right, dangerous_terms]) => Object.freeze({ left, right, dangerous_terms })));

const DOES_NOT_ESTABLISH = Object.freeze([
  Object.freeze({ fact: "provider_statement", does_not_establish: "provider_payment" }),
  Object.freeze({ fact: "resident_recovery_method", does_not_establish: "resident_charge" }),
  Object.freeze({ fact: "resident_charge", does_not_establish: "resident_collection" }),
  Object.freeze({ fact: "resident_collection", does_not_establish: "provider_payment" }),
  Object.freeze({ fact: "provider_meter", does_not_establish: "resident_lease_responsibility" }),
  Object.freeze({ fact: "internal_submeter", does_not_establish: "provider_account" }),
  Object.freeze({ fact: "missing_service_evidence", does_not_establish: "service_not_applicable" }),
]);

const CAPABILITIES = Object.freeze({
  retrieval: Object.freeze({ claimed: true, basis: "governed utility standing and detail reads" }),
  comparison: Object.freeze({
    claimed: true,
    basis: "recorded statements on the same provider account; no portfolio normalization",
  }),
  causal_explanation: Object.freeze({
    claimed: false,
    clearing_condition: "a recorded causal fact links the observed change to a governed cause",
  }),
});

function isOpenServiceKey(value) {
  return /^[a-z][a-z0-9_]{1,63}$/.test(String(value || ""));
}

function labelForService(key, supplied) {
  if (supplied && String(supplied).trim()) return String(supplied).trim();
  return SERVICE_LABELS[key] || String(key || "").replace(/_/g, " ");
}

function enumValue(name, value, choices, { nullable = false } = {}) {
  if (nullable && (value === null || value === undefined || value === "")) return null;
  if (!choices.includes(value)) {
    const e = new Error(`${name} must be one of ${choices.join(", ")}`);
    e.code = "BAD_INPUT";
    throw e;
  }
  return value;
}

module.exports = {
  CONTRACT_VERSION,
  STARTER_SERVICES,
  SERVICE_KEYS,
  SERVICE_LABELS,
  APPLICABILITY,
  PHYSICAL_ARRANGEMENTS,
  SERVICE_POINT_KINDS,
  METER_KINDS,
  PROVIDER_BILL_RECIPIENTS,
  PROVIDER_RESPONSIBLE_PARTIES,
  ECONOMIC_RESPONSIBILITIES,
  RESIDENT_RECOVERY_METHODS,
  RESIDENT_PAYMENT_RECIPIENTS,
  USAGE_BASES,
  METERED_ARRANGEMENTS,
  THIRD_PARTY_RECOVERY_METHODS,
  TRUTH_WALLS,
  DOES_NOT_ESTABLISH,
  CAPABILITIES,
  isOpenServiceKey,
  labelForService,
  enumValue,
};
