"use strict";

const assert = require("assert");
const contract = require("../src/asset/utility_contract.js");
const projection = require("../src/asset/utility_projection.js");

let pass = 0;
function ok(label, fn) {
  fn(); pass++;
  console.log(`  ok    ${label}`);
}

const AS_OF = "2026-08-13";
let seq = 0;
function id(prefix) { seq += 1; return `${prefix}-${seq}`; }

function base() {
  return {
    property_id: "property-a",
    services: [], declarations: [], providers: [], service_providers: [],
    arrangements: [], accounts: [], account_services: [], service_points: [],
    meters: [], meter_service_points: [], account_service_points: [],
    account_meters: [], statements: [], statement_usage: [],
  };
}

function present(s, key, label) {
  const service = { id: id("svc"), property_id: s.property_id,
    service_class: key, service_label: label || null };
  s.services.push(service);
  s.declarations.push({ id: id("dec"), service_id: service.id,
    applicability: "present", effective_from: "2026-01-01",
    provenance_note: "operator confirmed" });
  return service;
}

function notApplicable(s, key) {
  const service = { id: id("svc"), property_id: s.property_id,
    service_class: key, service_label: null };
  s.services.push(service);
  s.declarations.push({ id: id("dec"), service_id: service.id,
    applicability: "not_applicable", effective_from: "2026-01-01",
    provenance_note: "operator confirmed" });
  return service;
}

function provider(s, service, name) {
  const p = { id: id("provider"), property_id: s.property_id, provider_name: name };
  s.providers.push(p);
  s.service_providers.push({ id: id("sp"), service_id: service.id, provider_id: p.id,
    effective_from: "2026-01-01", provenance_note: "statement" });
  return p;
}

function arrange(s, service, values = {}) {
  const row = {
    id: id("arr"), service_id: service.id, effective_from: "2026-01-01",
    physical_arrangement: "non_metered",
    provider_bill_recipient: "property",
    provider_responsible_party: "property",
    economic_responsibility: "property",
    resident_recovery_method: "none_property_absorbs",
    resident_payment_recipient: "not_applicable",
    provenance_note: "operator confirmed",
    ...values,
  };
  s.arrangements.push(row); return row;
}

function account(s, service, p, number) {
  const a = { id: id("account"), property_id: s.property_id, provider_id: p.id,
    external_account_identifier: number, effective_from: "2026-01-01",
    provenance_note: "provider statement" };
  s.accounts.push(a);
  s.account_services.push({ id: id("as"), account_id: a.id, service_id: service.id,
    effective_from: "2026-01-01" });
  return a;
}

function point(s, service, kind, label) {
  const p = { id: id("point"), property_id: s.property_id, service_id: service.id,
    point_kind: kind, location_label: label, effective_from: "2026-01-01",
    provenance_note: "meter schedule" };
  s.service_points.push(p); return p;
}

function meter(s, pnt, kind, number) {
  const m = { id: id("meter"), property_id: s.property_id, meter_kind: kind,
    meter_identifier: number, effective_from: "2026-01-01",
    provenance_note: "meter schedule" };
  s.meters.push(m);
  s.meter_service_points.push({ id: id("mp"), meter_id: m.id,
    service_point_id: pnt.id, effective_from: "2026-01-01" });
  return m;
}

function statement(s, a, values = {}) {
  const row = { id: id("stmt"), account_id: a.id, statement_identifier: id("bill"),
    bill_date: "2026-08-01", service_period_start: "2026-07-01",
    service_period_end: "2026-07-31", due_date: "2026-08-20",
    currency_code: "USD", amount_billed_cents: 10000,
    current_amount_due_cents: 10000, late_fee_cents: 0,
    recorded_at: "2026-08-02T00:00:00Z", provenance_note: "provider statement",
    ...values };
  s.statements.push(row); return row;
}

function view(s) { return projection.project(s, { as_of: AS_OF }); }
function service(v, key) { return v.detail.services.find((x) => x.service_class === key); }

console.log("\nUTILITIES CONTRACT - HOSTILE PROOFS\n");

ok("1. gas unknown is NOT_ESTABLISHED, never no gas", () => {
  const s = base();
  const e = present(s, "electricity"); provider(s, e, "PECO"); arrange(s, e);
  const v = view(s);
  assert.deepStrictEqual(service(v, "natural_gas").applicability,
    { truth_state: "NOT_ESTABLISHED", value: null });
});

ok("2. resident-direct electric does not require a property account", () => {
  const s = base(); const e = present(s, "electricity"); provider(s, e, "PECO");
  arrange(s, e, { physical_arrangement: "individual_provider_meters",
    provider_bill_recipient: "resident", provider_responsible_party: "resident",
    economic_responsibility: "resident",
    resident_recovery_method: "resident_direct_to_provider",
    resident_payment_recipient: "provider" });
  const p = point(s, e, "unit", "Unit 506"); meter(s, p, "provider_meter", "M-506");
  const v = view(s);
  assert(!v.opening.unresolved.some((g) =>
    g.service === "electricity" && g.concept === "provider_account"));
});

ok("3. property-paid RUBS remains separate from provider payment", () => {
  const s = base(); const w = present(s, "water_sewer_combined");
  const p = provider(s, w, "Philadelphia Water");
  arrange(s, w, { physical_arrangement: "whole_building_master_meter",
    resident_recovery_method: "rubs_allocation", resident_payment_recipient: "property" });
  const a = account(s, w, p, "WATER-1234"); const pt = point(s, w, "whole_building", "Building");
  const m = meter(s, pt, "provider_meter", "WM-1");
  s.account_meters.push({ id: id("am"), account_id: a.id, meter_id: m.id,
    effective_from: "2026-01-01" });
  statement(s, a);
  const v = service(view(s), "water_sewer_combined");
  assert.strictEqual(v.arrangement.resident_recovery_method, "rubs_allocation");
  assert.strictEqual(v.payment.truth_state, "NOT_ESTABLISHED");
});

ok("4. internal submeters never become provider accounts", () => {
  const s = base(); const e = present(s, "electricity"); const p = provider(s, e, "PECO");
  arrange(s, e, { physical_arrangement: "internal_submeters",
    resident_recovery_method: "actual_submeter_usage", resident_payment_recipient: "property" });
  account(s, e, p, "MASTER-1111");
  const pt = point(s, e, "unit", "Unit 413"); meter(s, pt, "internal_submeter", "SUB-413");
  const v = service(view(s), "electricity");
  assert.strictEqual(v.accounts.length, 1);
  assert.strictEqual(v.meters[0].kind, "internal_submeter");
  assert(!v.accounts.some((a) => a.account_identifier_masked.endsWith("0413")));
});

ok("5. many accounts remain distinct and organized by what they serve", () => {
  const s = base(); const e = present(s, "electricity"); const p = provider(s, e, "PECO");
  arrange(s, e, { physical_arrangement: "individual_provider_meters" });
  const common = point(s, e, "common_area", "Common areas");
  const unit = point(s, e, "unit", "Unit 506");
  const a1 = account(s, e, p, "ACCT-1001"); const a2 = account(s, e, p, "ACCT-2506");
  s.account_service_points.push({ id: id("ap"), account_id: a1.id,
    service_point_id: common.id, effective_from: "2026-01-01" });
  s.account_service_points.push({ id: id("ap"), account_id: a2.id,
    service_point_id: unit.id, effective_from: "2026-01-01" });
  const v = service(view(s), "electricity");
  assert.strictEqual(v.accounts.length, 2);
  assert.deepStrictEqual(v.accounts.map((a) => a.serves[0].label).sort(), ["Common areas", "Unit 506"]);
});

ok("6. one account can cover combined water and sewer without fake statements", () => {
  const s = base(); const w = present(s, "water"); const sewer = present(s, "sewer");
  const p = provider(s, w, "City Utility");
  s.service_providers.push({ id: id("sp"), service_id: sewer.id, provider_id: p.id,
    effective_from: "2026-01-01", provenance_note: "provider statement" });
  arrange(s, w); arrange(s, sewer);
  const a = account(s, w, p, "CITY-7788");
  s.account_services.push({ id: id("as"), account_id: a.id, service_id: sewer.id,
    effective_from: "2026-01-01" });
  statement(s, a);
  const v = view(s);
  assert.strictEqual(service(v, "water").latest_statement.id,
    service(v, "sewer").latest_statement.id);
});

ok("7. service period remains distinct from bill and payment months", () => {
  const s = base(); const e = present(s, "electricity"); const p = provider(s, e, "PECO");
  arrange(s, e); const a = account(s, e, p, "E-9090");
  statement(s, a, { bill_date: "2026-08-03", service_period_start: "2026-07-01",
    service_period_end: "2026-07-31" });
  const st = service(view(s), "electricity").latest_statement;
  assert.strictEqual(st.bill_date, "2026-08-03");
  assert.strictEqual(st.service_period_start, "2026-07-01");
  assert.strictEqual(service(view(s), "electricity").payment.truth_state, "NOT_ESTABLISHED");
});

ok("8. resident recovery method never establishes a collection", () => {
  assert(contract.DOES_NOT_ESTABLISH.some((w) =>
    w.fact === "resident_charge" && w.does_not_establish === "resident_collection"));
  assert(contract.DOES_NOT_ESTABLISH.some((w) =>
    w.fact === "resident_collection" && w.does_not_establish === "provider_payment"));
});

ok("9. a provider statement with no settlement remains payment unknown", () => {
  const s = base(); const e = present(s, "electricity"); const p = provider(s, e, "PECO");
  arrange(s, e); const a = account(s, e, p, "E-0009"); statement(s, a);
  assert.strictEqual(service(view(s), "electricity").payment.truth_state, "NOT_ESTABLISHED");
});

ok("10. provider, billing administrator, and payment recipient stay distinct", () => {
  const s = base(); const w = present(s, "water"); provider(s, w, "Philadelphia Water");
  arrange(s, w, { resident_recovery_method: "rubs_allocation",
    billing_administrator_name: "Conservice",
    resident_payment_recipient: "billing_administrator" });
  const v = service(view(s), "water");
  assert.deepStrictEqual(v.providers.map((p) => p.name), ["Philadelphia Water"]);
  assert.strictEqual(v.arrangement.billing_administrator_name, "Conservice");
  assert.strictEqual(v.arrangement.resident_payment_recipient, "billing_administrator");
});

ok("11. a non-metered internet account requires no fake meter", () => {
  const s = base(); const i = present(s, "internet_data"); const p = provider(s, i, "Comcast");
  arrange(s, i, { physical_arrangement: "non_metered" }); account(s, i, p, "NET-3131");
  const v = view(s);
  assert(!v.opening.unresolved.some((g) =>
    g.service === "internet_data" && g.concept === "meter_map"));
  assert.strictEqual(service(v, "internet_data").meters.length, 0);
});

ok("12. a provider meter without an account match surfaces the exact gap", () => {
  const s = base(); const e = present(s, "electricity"); provider(s, e, "PECO");
  arrange(s, e, { physical_arrangement: "whole_building_master_meter",
    provider_bill_recipient: "resident", provider_responsible_party: "resident",
    economic_responsibility: "resident",
    resident_recovery_method: "resident_direct_to_provider",
    resident_payment_recipient: "provider" });
  const pt = point(s, e, "whole_building", "Building"); meter(s, pt, "provider_meter", "M-UNKNOWN");
  const v = view(s);
  assert(v.opening.unresolved.some((g) =>
    g.service === "electricity" && g.concept === "account_meter_mapping"));
});

ok("the service vocabulary is open while starter services remain explicit", () => {
  assert(contract.isOpenServiceKey("district_cooling"));
  assert(!contract.SERVICE_KEYS.includes("district_cooling"));
});

ok("account identifiers are masked before leaving the projection", () => {
  assert.strictEqual(projection.maskIdentifier("123456789"), "*****6789");
});

ok("causal explanation is explicitly not claimed", () => {
  assert.strictEqual(contract.CAPABILITIES.causal_explanation.claimed, false);
});

console.log(`\n${pass} assertions passed\n`);
