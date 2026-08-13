"use strict";

const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");
const utility = require("../src/asset/utility_service.js");
const projection = require("../src/asset/utility_projection.js");

const DB = process.env.DATABASE_URL;
if (!DB) {
  console.error("UTILITY PERSISTENCE NOT PROVEN: DATABASE_URL is required");
  process.exit(2);
}

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

async function snapshot(client, propertyId) {
  const tables = {
    services: "utility_services",
    declarations: "utility_service_declarations",
    providers: "utility_providers",
    service_providers: "utility_service_providers",
    arrangements: "utility_arrangements",
    accounts: "utility_provider_accounts",
    account_services: "utility_account_services",
    service_points: "utility_service_points",
    meters: "utility_meters",
    meter_service_points: "utility_meter_service_points",
    account_service_points: "utility_account_service_points",
    account_meters: "utility_account_meters",
    statements: "utility_statements",
    statement_usage: "utility_statement_usage",
  };
  const out = { property_id: propertyId };
  for (const [key, table] of Object.entries(tables)) {
    out[key] = (await client.query(`select * from ${table} where property_id = $1`, [propertyId])).rows;
  }
  return out;
}

async function main() {
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
    `);

    const draft = fs.readFileSync(path.join(__dirname, "..", "docs",
      "UTILITIES_CANONICAL_SCHEMA_DRAFT.sql"), "utf8");
    await admin.query(draft);

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
    await utility.relateProvider(admin, {
      property_id: propertyA, service_id: electric.service.id, provider_id: peco.id,
      effective_from: "2026-01-01", provenance_note: "provider named on statement", user_id: userId,
    });
    await utility.recordArrangement(admin, {
      property_id: propertyA, service_id: electric.service.id,
      physical_arrangement: "mixed", provider_bill_recipient: "property",
      provider_responsible_party: "property", economic_responsibility: "shared",
      resident_recovery_method: "rubs_allocation", billing_administrator_name: "Conservice",
      resident_payment_recipient: "property", effective_from: "2026-01-01",
      provenance_note: "operator confirmed from utility addendum", user_id: userId,
    });

    const account = await utility.establishAccount(admin, {
      property_id: propertyA, provider_id: peco.id,
      external_account_identifier: "4800104651234", billing_cadence: "monthly",
      service_address: "Property A", effective_from: "2026-01-01",
      source_artifact_id: artifactA, user_id: userId,
    });
    await utility.link(admin, "account_service", {
      property_id: propertyA, left_id: account.id, right_id: electric.service.id,
      effective_from: "2026-01-01", source_artifact_id: artifactA, user_id: userId,
    });

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
    for (const [meterId, pointId] of [[providerMeter.id, commonPoint.id], [submeter.id, unitPoint.id]]) {
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
    ok("provider account, service points, provider meter, and submeter persist separately",
      account.id !== providerMeter.id && providerMeter.id !== submeter.id
      && commonPoint.id !== providerMeter.id);

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

    const state = projection.project(await snapshot(admin, propertyA), { as_of: "2026-08-13" });
    const electricView = state.detail.services.find((s) => s.service_class === "electricity");
    const gasView = state.detail.services.find((s) => s.service_class === "natural_gas");
    ok("persisted correction reads natural gas as not applicable",
      gasView.applicability.value === "not_applicable");
    ok("persisted account identifier leaves the projection masked",
      electricView.accounts[0].account_identifier_masked.endsWith("1234")
      && !JSON.stringify(state).includes("4800104651234"));
    ok("persisted provider meter and internal submeter remain different kinds",
      electricView.meters.some((m) => m.kind === "provider_meter")
      && electricView.meters.some((m) => m.kind === "internal_submeter"));
    ok("persisted provider statement does not establish payment",
      electricView.payment.truth_state === "NOT_ESTABLISHED");
    ok("resident recovery remains an arrangement, not a collection",
      electricView.arrangement.resident_recovery_method === "rubs_allocation"
      && !Object.prototype.hasOwnProperty.call(state.detail, "resident_collections"));

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

  console.log(`\n${pass + fail} assertions - ${pass} passed - ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
