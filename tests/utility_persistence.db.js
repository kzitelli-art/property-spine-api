"use strict";

const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");
const receipt = require("./_run_receipt.js");
const utility = require("../src/asset/utility_service.js");
const positionRead = require("../src/asset/utility_position_read.js");

const DB = receipt.harnessConnectionString();

let pass = 0;
let fail = 0;
function ok(label, condition, detail = "") {
  if (condition) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail ? `\n        ${detail}` : ""}`); }
}

async function rejects(label, fn, pattern) {
  let error = null;
  try { await fn(); } catch (e) { error = e; }
  ok(label, !!error && pattern.test(String(error.code || "") + " " + String(error.message || "")),
    error ? `${error.code || ""} ${error.message}` : "operation unexpectedly succeeded");
}

function sqlName(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2, 10)}`;
}

async function main() {
  receipt.begin(__filename, { url: DB });
  const pool = new Pool({ connectionString: DB });
  const admin = await pool.connect();
  const schema = sqlName("utility_proof");

  try {
    await admin.query(`create schema ${schema}`);
    await admin.query(`set search_path to ${schema}, public`);

    await admin.query(`
      create table properties (
        id uuid primary key default gen_random_uuid(), name text not null
      );
      create table users (
        id uuid primary key default gen_random_uuid(), name text
      );
      create table units (
        id uuid primary key default gen_random_uuid(),
        property_id uuid not null references properties(id), unit_number text not null
      );
      create table spaces (
        id uuid primary key default gen_random_uuid(),
        unit_id uuid not null references units(id), space_label text
      );
      create table source_artifacts (
        id uuid primary key default gen_random_uuid(),
        scope_type text not null check (scope_type in ('deal','property')),
        scope_id uuid not null,
        original_filename text not null,
        artifact_kind text not null,
        source_as_of_date date,
        constraint source_artifacts_artifact_kind_check
          check (artifact_kind in ('rent_roll','other'))
      );
      create table vendors (
        id uuid primary key default gen_random_uuid(),
        canonical_name text not null,
        vendor_type text not null default 'vendor'
      );
    `);

    const migration = fs.readFileSync(path.join(__dirname, "..", "migrations",
      "169_utilities_canonical_truth.sql"), "utf8");
    await admin.query(migration);

    const userId = (await admin.query(
      "insert into users(name) values ('Utilities Operator') returning id")).rows[0].id;
    const propertyA = (await admin.query(
      "insert into properties(name) values ('Property A') returning id")).rows[0].id;
    const propertyB = (await admin.query(
      "insert into properties(name) values ('Property B') returning id")).rows[0].id;
    const unitA = (await admin.query(
      "insert into units(property_id,unit_number) values ($1,'506') returning id", [propertyA])).rows[0].id;
    const unitB = (await admin.query(
      "insert into units(property_id,unit_number) values ($1,'101') returning id", [propertyB])).rows[0].id;
    const artifactA = (await admin.query(
      `insert into source_artifacts(scope_type,scope_id,original_filename,artifact_kind,source_as_of_date)
       values ('property',$1,'PECO July statement.pdf','utility_statement','2026-08-01') returning id`,
      [propertyA])).rows[0].id;
    const artifactB = (await admin.query(
      `insert into source_artifacts(scope_type,scope_id,original_filename,artifact_kind,source_as_of_date)
       values ('property',$1,'Other property statement.pdf','utility_statement','2026-08-01') returning id`,
      [propertyB])).rows[0].id;

    console.log("\nUTILITIES PERSISTENCE - REAL POSTGRES\n");

    const electric = await utility.declareService(admin, {
      property_id: propertyA, service_class: "electricity", applicability: "present",
      effective_from: "2026-01-01", provenance_note: "operator confirmed from account file",
      user_id: userId,
    });
    ok("canonical service declaration persists",
      electric.declaration.applicability === "present" && electric.service.property_id === propertyA);

    const gasInitial = await utility.declareService(admin, {
      property_id: propertyA, service_class: "natural_gas", applicability: "present",
      effective_from: "2026-01-01", provenance_note: "initial operator statement", user_id: userId,
    });
    const gasCorrection = await utility.declareService(admin, {
      property_id: propertyA, service_class: "natural_gas", applicability: "not_applicable",
      effective_from: "2026-01-01", provenance_note: "confirmed against building systems",
      supersedes_id: gasInitial.declaration.id,
      revision_reason: "Initial property statement was incorrect", user_id: userId,
    });
    const gasRows = (await admin.query(
      "select id,supersedes_id from utility_service_declarations where service_id=$1 order by recorded_at",
      [gasInitial.service.id])).rows;
    ok("correction preserves both declarations and names its predecessor",
      gasRows.length === 2 && gasCorrection.declaration.supersedes_id === gasInitial.declaration.id);
    await rejects("a declaration can have only one correction", () => utility.declareService(admin, {
      property_id: propertyA, service_class: "natural_gas", applicability: "present",
      effective_from: "2026-01-01", provenance_note: "conflicting retry",
      supersedes_id: gasInitial.declaration.id, revision_reason: "retry", user_id: userId,
    }), /unique|duplicate/i);

    const peco = await utility.establishProvider(admin, {
      property_id: propertyA, provider_name: "PECO",
      provenance_note: "provider named on statement", user_id: userId,
    });
    const electricB = await utility.declareService(admin, {
      property_id: propertyB, service_class: "electricity", applicability: "present",
      effective_from: "2026-01-01", provenance_note: "operator confirmed from account file",
      user_id: userId,
    });
    const pecoCandidates = await utility.findProviderCandidates(admin,
      { provider_name: " peco " });
    ok("the same PECO name proposes the existing portfolio provider identity",
      pecoCandidates.length === 1 && pecoCandidates[0].id === peco.id
      && Number((await admin.query("select count(*) as n from utility_providers")).rows[0].n) === 1);
    const waterDepartmentA = await utility.establishProvider(admin, {
      property_id: propertyA, provider_name: "Water Department",
      provenance_note: "municipal provider A", user_id: userId,
    });
    const waterDepartmentB = await utility.establishProvider(admin, {
      property_id: propertyB, provider_name: " water department ",
      source_artifact_id: artifactB, user_id: userId,
    });
    ok("same normalized names can remain separate canonical provider identities",
      waterDepartmentA.id !== waterDepartmentB.id
      && (await utility.findProviderCandidates(admin,
        { provider_name: "WATER DEPARTMENT" })).length === 2);
    ok("provider establishment creates no Money vendor or payee assertion",
      Number((await admin.query("select count(*) as n from vendors")).rows[0].n) === 0);

    await utility.relateProvider(admin, {
      property_id: propertyA, service_id: electric.service.id, provider_id: peco.id,
      effective_from: "2026-01-01", provenance_note: "provider named on statement", user_id: userId,
    });
    await utility.relateProvider(admin, {
      property_id: propertyB, service_id: electricB.service.id, provider_id: peco.id,
      effective_from: "2026-01-01", source_artifact_id: artifactB, user_id: userId,
    });
    await rejects("not-applicable service cannot acquire active provider topology", () =>
      utility.relateProvider(admin, {
        property_id: propertyA, service_id: gasInitial.service.id, provider_id: peco.id,
        effective_from: "2026-01-01", provenance_note: "hostile topology",
        user_id: userId,
      }), /not-applicable|active topology/i);
    await utility.recordArrangement(admin, {
      property_id: propertyA, service_id: electric.service.id,
      physical_arrangement: "mixed", provider_bill_recipient: "property",
      provider_responsible_party: "property", economic_responsibility: "property",
      resident_recovery_method: "none_property_absorbs",
      resident_payment_recipient: "not_applicable", effective_from: "2026-01-01",
      effective_to: "2026-07-01",
      provenance_note: "operator confirmed from utility addendum", user_id: userId,
    });
    await utility.recordArrangement(admin, {
      property_id: propertyA, service_id: electric.service.id,
      physical_arrangement: "mixed", provider_bill_recipient: "property",
      provider_responsible_party: "property", economic_responsibility: "shared",
      resident_recovery_method: "rubs_allocation", billing_administrator_name: "Conservice",
      resident_payment_recipient: "property", effective_from: "2026-07-01",
      provenance_note: "new resident recovery arrangement", user_id: userId,
    });

    const account = await utility.establishAccount(admin, {
      property_id: propertyA, provider_id: peco.id,
      external_account_identifier: "4800104651234", billing_cadence: "monthly",
      service_address: "Property A", effective_from: "2026-01-01",
      source_artifact_id: artifactA, user_id: userId,
    });
    const accountB = await utility.establishAccount(admin, {
      property_id: propertyB, provider_id: peco.id,
      external_account_identifier: "4800104651234", billing_cadence: "monthly",
      service_address: "Property B", effective_from: "2026-01-01",
      source_artifact_id: artifactB, user_id: userId,
    });
    await utility.link(admin, "account_service", {
      property_id: propertyA, left_id: account.id, right_id: electric.service.id,
      effective_from: "2026-01-01", source_artifact_id: artifactA, user_id: userId,
    });
    await utility.link(admin, "account_service", {
      property_id: propertyB, left_id: accountB.id, right_id: electricB.service.id,
      effective_from: "2026-01-01", source_artifact_id: artifactB, user_id: userId,
    });
    await rejects("duplicate provider account identity is rejected within one property", () =>
      utility.establishAccount(admin, {
        property_id: propertyA, provider_id: peco.id,
        external_account_identifier: "4800104651234", effective_from: "2026-02-01",
        provenance_note: "hostile duplicate", user_id: userId,
      }), /unique|duplicate/i);
    await rejects("account cannot map to a service its provider does not supply", () =>
      utility.link(admin, "account_service", {
        property_id: propertyA, left_id: account.id, right_id: gasInitial.service.id,
        effective_from: "2026-01-01", provenance_note: "hostile mismatch", user_id: userId,
      }), /provider must supply|not-applicable/i);

    const commonPoint = await utility.recordServicePoint(admin, {
      property_id: propertyA, service_id: electric.service.id, point_kind: "common_area",
      location_label: "Common areas", effective_from: "2026-01-01",
      provenance_note: "operator confirmed meter schedule", user_id: userId,
    });
    const unitPoint = await utility.recordServicePoint(admin, {
      property_id: propertyA, service_id: electric.service.id, point_kind: "unit",
      unit_id: unitA, location_label: "Unit 506", effective_from: "2026-01-01",
      provenance_note: "operator confirmed meter schedule", user_id: userId,
    });
    const pointB = await utility.recordServicePoint(admin, {
      property_id: propertyB, service_id: electricB.service.id, point_kind: "unit",
      unit_id: unitB, location_label: "Unit 101", effective_from: "2026-01-01",
      source_artifact_id: artifactB, user_id: userId,
    });
    const meterB = await utility.recordMeter(admin, {
      property_id: propertyB, provider_id: peco.id, meter_kind: "provider_meter",
      meter_identifier: "PROPERTY-B-METER", effective_from: "2026-01-01",
      source_artifact_id: artifactB, user_id: userId,
    });
    await utility.link(admin, "account_service_point", {
      property_id: propertyB, left_id: accountB.id, right_id: pointB.id,
      effective_from: "2026-01-01", source_artifact_id: artifactB, user_id: userId,
    });
    await rejects("account cannot attach to another property's service point", () =>
      utility.link(admin, "account_service_point", {
        property_id: propertyA, left_id: account.id, right_id: pointB.id,
        effective_from: "2026-01-01", source_artifact_id: artifactA, user_id: userId,
      }), /NOT_FOUND|not found/i);
    await rejects("account cannot attach to another property's meter", () =>
      utility.link(admin, "account_meter", {
        property_id: propertyA, left_id: account.id, right_id: meterB.id,
        effective_from: "2026-01-01", source_artifact_id: artifactA, user_id: userId,
      }), /NOT_FOUND|not found/i);
    const providerMeter = await utility.recordMeter(admin, {
      property_id: propertyA, provider_id: peco.id, meter_kind: "provider_meter",
      meter_identifier: "99887766", effective_from: "2026-01-01",
      provenance_note: "provider statement", user_id: userId,
    });
    const submeter = await utility.recordMeter(admin, {
      property_id: propertyA, meter_kind: "internal_submeter",
      meter_identifier: "SUB-506", effective_from: "2026-01-01",
      provenance_note: "submeter schedule", user_id: userId,
    });
    const submeterTwo = await utility.recordMeter(admin, {
      property_id: propertyA, meter_kind: "internal_submeter",
      meter_identifier: "SUB-507", effective_from: "2026-01-01",
      provenance_note: "submeter schedule", user_id: userId,
    });
    for (const [meterId, pointId] of [[providerMeter.id, commonPoint.id],
      [submeter.id, unitPoint.id], [submeterTwo.id, unitPoint.id]]) {
      await utility.link(admin, "meter_service_point", {
        property_id: propertyA, left_id: meterId, right_id: pointId,
        effective_from: "2026-01-01", provenance_note: "operator confirmed topology",
        user_id: userId,
      });
    }
    await utility.link(admin, "account_meter", {
      property_id: propertyA, left_id: account.id, right_id: providerMeter.id,
      effective_from: "2026-01-01", source_artifact_id: artifactA, user_id: userId,
    });
    await utility.link(admin, "account_service_point", {
      property_id: propertyA, left_id: account.id, right_id: commonPoint.id,
      effective_from: "2026-01-01", source_artifact_id: artifactA, user_id: userId,
    });
    ok("master provider account, service points, provider meter, and several submeters persist separately",
      account.id !== providerMeter.id && providerMeter.id !== submeter.id
      && submeter.id !== submeterTwo.id && commonPoint.id !== providerMeter.id);

    const water = await utility.declareService(admin, {
      property_id: propertyA, service_class: "water", applicability: "present",
      effective_from: "2026-01-01", provenance_note: "combined municipal account",
      user_id: userId,
    });
    const sewer = await utility.declareService(admin, {
      property_id: propertyA, service_class: "sewer", applicability: "present",
      effective_from: "2026-01-01", provenance_note: "combined municipal account",
      user_id: userId,
    });
    const cityUtility = await utility.establishProvider(admin, {
      property_id: propertyA, provider_name: "City Utility",
      provenance_note: "combined water and sewer statement", user_id: userId,
    });
    for (const service of [water.service, sewer.service]) {
      await utility.relateProvider(admin, {
        property_id: propertyA, service_id: service.id, provider_id: cityUtility.id,
        effective_from: "2026-01-01", provenance_note: "combined statement",
        user_id: userId,
      });
    }
    const combinedAccount = await utility.establishAccount(admin, {
      property_id: propertyA, provider_id: cityUtility.id,
      external_account_identifier: "CITY-7788", effective_from: "2026-01-01",
      source_artifact_id: artifactA, user_id: userId,
    });
    for (const service of [water.service, sewer.service]) {
      await utility.link(admin, "account_service", {
        property_id: propertyA, left_id: combinedAccount.id, right_id: service.id,
        effective_from: "2026-01-01", source_artifact_id: artifactA, user_id: userId,
      });
    }
    ok("one provider account can map to combined water and sewer without a fake meter",
      Number((await admin.query(
        "select count(*) as n from utility_account_services where account_id=$1",
        [combinedAccount.id])).rows[0].n) === 2
      && Number((await admin.query(
        "select count(*) as n from utility_account_meters where account_id=$1",
        [combinedAccount.id])).rows[0].n) === 0);

    const bill = await utility.recordStatement(admin, {
      property_id: propertyA, account_id: account.id, statement_identifier: "2026-07-PECO",
      bill_date: "2026-08-01", service_period_start: "2026-07-01",
      service_period_end: "2026-07-31", due_date: "2026-08-20", currency_code: "USD",
      amount_billed_cents: 1844217, current_amount_due_cents: 1844217, late_fee_cents: 0,
      source_artifact_id: artifactA,
      usage: [{ service_id: electric.service.id, meter_id: providerMeter.id,
        quantity: 14750, usage_unit: "kWh", usage_basis: "observed" }],
      user_id: userId,
    });
    ok("statement preserves bill date, service period, due date, amounts, and observed usage",
      String(bill.statement.bill_date).slice(0, 10) === "2026-08-01"
      && String(bill.statement.service_period_start).slice(0, 10) === "2026-07-01"
      && Number(bill.statement.amount_billed_cents) === 1844217
      && bill.usage[0].usage_basis === "observed");

    const unmappedMeter = await utility.recordMeter(admin, {
      property_id: propertyA, provider_id: peco.id, meter_kind: "provider_meter",
      meter_identifier: "UNMAPPED-100", effective_from: "2026-01-01",
      provenance_note: "hostile statement-map proof", user_id: userId,
    });
    await rejects("statement usage cannot borrow a meter outside its account map", () =>
      utility.recordStatement(admin, {
        property_id: propertyA, account_id: account.id, statement_identifier: "wrong-meter",
        bill_date: "2026-08-01", service_period_start: "2026-07-01",
        service_period_end: "2026-07-31", currency_code: "USD",
        amount_billed_cents: 1, source_artifact_id: artifactA,
        usage: [{ service_id: electric.service.id, meter_id: unmappedMeter.id,
          quantity: 1, usage_unit: "kWh", usage_basis: "observed" }], user_id: userId,
      }), /BAD_INPUT|not mapped/i);
    await rejects("database rejects direct statement usage for an unmapped service", () =>
      admin.query(
        `insert into utility_statement_usage
           (property_id,statement_id,account_id,service_id,quantity,usage_unit,
            usage_basis,source_artifact_id,recorded_by_user_id)
         values ($1,$2,$3,$4,1,'therms','observed',$5,$6)`,
        [propertyA, bill.statement.id, account.id, gasInitial.service.id, artifactA, userId]),
      /service must be mapped/i);
    await rejects("database rejects direct statement usage for an unmapped meter", () =>
      admin.query(
        `insert into utility_statement_usage
           (property_id,statement_id,account_id,service_id,meter_id,quantity,usage_unit,
            usage_basis,source_artifact_id,recorded_by_user_id)
         values ($1,$2,$3,$4,$5,1,'kWh','observed',$6,$7)`,
        [propertyA, bill.statement.id, account.id, electric.service.id,
         unmappedMeter.id, artifactA, userId]),
      /meter must be mapped/i);

    await rejects("cross-property provider association is refused", () => utility.relateProvider(admin, {
      property_id: propertyB, service_id: electric.service.id, provider_id: peco.id,
      effective_from: "2026-01-01", provenance_note: "illegal association", user_id: userId,
    }), /NOT_FOUND|not found/i);
    await rejects("cross-property unit association is refused by the database", () =>
      utility.recordServicePoint(admin, {
        property_id: propertyA, service_id: electric.service.id, point_kind: "unit",
        unit_id: unitB, location_label: "Wrong property unit", effective_from: "2026-01-01",
        provenance_note: "hostile proof", user_id: userId,
      }), /same property/i);
    await rejects("cross-property source evidence is refused", () => utility.recordStatement(admin, {
      property_id: propertyA, account_id: account.id, statement_identifier: "wrong-source",
      bill_date: "2026-08-01", service_period_start: "2026-07-01",
      service_period_end: "2026-07-31", currency_code: "USD",
      amount_billed_cents: 1, source_artifact_id: artifactB, user_id: userId,
    }), /SOURCE_SCOPE_MISMATCH|same property/i);
    await rejects("statement cannot attach to another property's account", () =>
      utility.recordStatement(admin, {
        property_id: propertyB, account_id: account.id, statement_identifier: "wrong-account",
        bill_date: "2026-08-01", service_period_start: "2026-07-01",
        service_period_end: "2026-07-31", currency_code: "USD",
        amount_billed_cents: 1, source_artifact_id: artifactB, user_id: userId,
      }), /NOT_FOUND|not found/i);

    const beforeRecovery = await positionRead.readPosition(admin,
      { property_id: propertyA, as_of: "2026-06-30" });
    const state = await positionRead.readPosition(admin,
      { property_id: propertyA, as_of: "2026-08-13" });
    const stateB = await positionRead.readPosition(admin,
      { property_id: propertyB, as_of: "2026-08-13" });
    const electricView = state.detail.services.find((s) => s.service_class === "electricity");
    const electricViewB = stateB.detail.services.find((s) => s.service_class === "electricity");
    const gasView = state.detail.services.find((s) => s.service_class === "natural_gas");
    ok("persisted correction reads natural gas as not applicable",
      gasView.applicability.value === "not_applicable");
    ok("absence remains NOT_ESTABLISHED rather than a fake negative declaration",
      state.detail.services.find((s) => s.service_class === "internet_data")
        .applicability.truth_state === "NOT_ESTABLISHED");
    ok("effective dating gives the correct arrangement at each as-of date",
      beforeRecovery.detail.services.find((s) => s.service_class === "electricity")
        .arrangement.resident_recovery_method === "none_property_absorbs"
      && electricView.arrangement.resident_recovery_method === "rubs_allocation");
    ok("persisted account identifier leaves the projection masked",
      electricView.accounts[0].account_identifier_masked.endsWith("1234")
      && !JSON.stringify(state).includes("4800104651234"));
    ok("persisted provider meter and several internal submeters remain different kinds",
      electricView.meters.some((m) => m.kind === "provider_meter")
      && electricView.meters.filter((m) => m.kind === "internal_submeter").length === 2);
    ok("a meter and service point may remain established while account mapping is unresolved",
      electricView.meters.some((m) => m.kind === "internal_submeter"
        && m.serves.some((point) => point.label === "Unit 506"))
      && electricView.accounts[0].meters.every((m) => m.kind !== "internal_submeter"));
    ok("the same provider has isolated accounts and points at each property",
      electricView.providers[0].name === "PECO"
      && electricViewB.providers[0].name === "PECO"
      && electricView.accounts[0].serves.some((point) => point.label === "Common areas")
      && electricViewB.accounts[0].serves.some((point) => point.label === "Unit 101")
      && !JSON.stringify(state).includes("Unit 101")
      && !JSON.stringify(stateB).includes("Common areas"));
    ok("a provider account with no meter remains a valid independent account",
      electricViewB.accounts.length === 1 && electricViewB.accounts[0].meters.length === 0);
    ok("combined water and sewer read through the same account identity",
      state.detail.services.find((s) => s.service_class === "water").accounts[0].id
      === state.detail.services.find((s) => s.service_class === "sewer").accounts[0].id);
    ok("persisted provider statement does not establish payment",
      electricView.payment.truth_state === "NOT_ESTABLISHED");
    ok("resident recovery remains an arrangement, not a collection",
      electricView.arrangement.resident_recovery_method === "rubs_allocation"
      && !Object.prototype.hasOwnProperty.call(state.detail, "resident_collections"));
    ok("source evidence remains attributable to the property account",
      (await admin.query(
        "select source_artifact_id from utility_provider_accounts where id=$1", [account.id]))
        .rows[0].source_artifact_id === artifactA);

    const forbiddenColumns = (await admin.query(`
      select table_name,column_name from information_schema.columns
       where table_schema=$1 and table_name like 'utility_%'
         and column_name in ('status','current','paid','healthy','is_paid')`, [schema])).rows;
    ok("schema has no mutable current/healthy/paid shortcut", forbiddenColumns.length === 0,
      JSON.stringify(forbiddenColumns));

    const settlementTables = (await admin.query(`
      select table_name from information_schema.tables
       where table_schema=$1 and table_name like 'utility_%payment%'
          or (table_schema=$1 and table_name like 'utility_%settlement%')`, [schema])).rows;
    ok("schema creates no unsupported provider payment or settlement rail", settlementTables.length === 0,
      JSON.stringify(settlementTables));

    // Direct SQL is also contained: composite foreign keys reject a relation
    // whose property column disagrees with the related account and meter.
    await rejects("database rejects a direct cross-property account/meter link", () => admin.query(
      `insert into utility_account_meters
         (property_id,account_id,meter_id,effective_from,provenance_note,recorded_by_user_id)
       values ($1,$2,$3,'2026-01-01','hostile direct insert',$4)`,
      [propertyB, account.id, providerMeter.id, userId]), /foreign key|violates/i);

  } finally {
    await admin.query("set search_path to public").catch(() => {});
    await admin.query(`drop schema if exists ${schema} cascade`).catch(() => {});
    admin.release();
    await pool.end();
  }

  process.exit(receipt.complete({
    harness: __filename, passed: pass, failed: fail, expectedAtLeast: 20,
  }));
}

main().catch((error) => {
  process.exit(receipt.died(__filename, error, pass + fail));
});
