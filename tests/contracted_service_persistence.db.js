"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { Client } = require("pg");

const runReceipt = require("./_run_receipt.js");
const service = require("../src/asset/contracted_service_service.js");
const positionRead = require("../src/asset/contracted_service_position_read.js");
const artifactService = require("../src/onboarding/source_artifact_service.js");

const REQUIRED_TABLES = [
  "contracted_service_coverage_reviews",
  "contracted_service_requirements",
  "contracted_service_providers",
  "contracted_service_engagements",
  "contracted_service_documents",
  "contracted_service_terms",
  "contracted_service_scopes",
  "contracted_service_locations",
  "contracted_service_price_components",
  "contracted_service_financial_observations",
  "contracted_service_decision_links",
];

async function expectServiceCode(code, action) {
  let error = null;
  try { await action(); } catch (caught) { error = caught; }
  assert(error, `expected ${code}`);
  assert.strictEqual(error.code, code);
}

let savepointNumber = 0;
async function expectDatabaseRefusal(client, pattern, action) {
  const savepoint = `contracted_service_expected_${++savepointNumber}`;
  await client.query(`savepoint ${savepoint}`);
  let error = null;
  try { await action(); } catch (caught) { error = caught; }
  await client.query(`rollback to savepoint ${savepoint}`);
  await client.query(`release savepoint ${savepoint}`);
  assert(error, `expected database refusal matching ${pattern}`);
  assert(pattern.test(String(error.message)), String(error.message));
}

function pdf(label) {
  return Buffer.from(`%PDF-1.4\n1 0 obj\n(${label})\nendobj\n%%EOF`, "utf8");
}

async function retain(client, propertyId, userId, kind, label) {
  return artifactService.store(client, {
    scope_type: "property",
    scope_id: propertyId,
    filename: `${label}.pdf`,
    mimetype: "application/pdf",
    buffer: pdf(label),
    uploaded_by_user_id: userId,
    authority_basis: "disposable Contracted Services persistence proof",
    source_as_of_date: "2026-08-14",
    artifact_kind: kind,
  });
}

async function run() {
  const connectionString = runReceipt.harnessConnectionString();
  runReceipt.begin(__filename, { url: connectionString });
  const client = new Client({ connectionString, application_name: "contracted-services-proof" });
  await client.connect();
  try {
    await client.query("begin");
    try {
      const ddl = fs.readFileSync(path.join(__dirname, "..", "migrations",
        "171_contracted_services_canonical_truth.sql"), "utf8");
      const installedTables = (await client.query(
        `select table_name from information_schema.tables
          where table_schema = 'public' and table_name = any($1::text[])
          order by table_name`, [REQUIRED_TABLES])).rows.map((row) => row.table_name);
      assert(
        installedTables.length === 0 || installedTables.length === REQUIRED_TABLES.length,
        `partial Contracted Services schema: found ${installedTables.length}/${REQUIRED_TABLES.length} tables`
      );
      if (installedTables.length === 0) await client.query(ddl);

      const properties = (await client.query(
        "select id from properties order by created_at, id limit 2")).rows;
      const user = (await client.query("select id from users order by id limit 1")).rows[0];
      assert(properties.length >= 2, "persistence proof requires two existing properties");
      assert(user, "persistence proof requires one existing user");
      const [propertyA, propertyB] = properties.map((row) => row.id);
      const userId = user.id;

      const agreementA = await retain(client, propertyA, userId,
        "contracted_service_agreement", "proof-agreement-a");
      const unsignedA = await retain(client, propertyA, userId,
        "contracted_service_agreement", "proof-unsigned-a");
      const agreementB = await retain(client, propertyB, userId,
        "contracted_service_agreement", "proof-agreement-b");
      const accountingA = await retain(client, propertyA, userId,
        "contracted_service_accounting_report", "proof-accounting-a");

      await service.recordCoverageReview(client, {
        property_id: propertyA, reviewed_as_of: "2026-08-14",
        provenance_note: "Reviewed the retained service agreements and accounting workpapers.",
        user_id: userId,
      });
      const requirement = await service.recordRequirement(client, {
        property_id: propertyA, service_class: "elevator_maintenance",
        service_label: "Elevator maintenance", determination: "contracted_service_required",
        basis: "Passenger elevator requires a service arrangement.",
        effective_from: "2026-01-01", user_id: userId,
      });
      const correctedRequirement = await service.recordRequirement(client, {
        property_id: propertyA, service_class: "elevator_maintenance",
        service_label: "Elevator maintenance", determination: "contracted_service_required",
        basis: "Passenger elevator and emergency callback coverage require service.",
        effective_from: "2026-01-01", supersedes_id: requirement.id,
        revision_reason: "Clarified the coverage basis without changing its effective anchor.",
        user_id: userId,
      });
      assert.notStrictEqual(correctedRequirement.id, requirement.id);

      const provider = await service.establishProvider(client, {
        property_id: propertyA, provider_name: "Proof Vertical Services",
        source_artifact_id: agreementA.id, user_id: userId,
      });
      await service.establishProvider(client, {
        property_id: propertyA, provider_name: "  proof vertical services  ",
        source_artifact_id: agreementA.id, user_id: userId,
      });
      const candidates = await service.findProviderCandidates(client,
        { provider_name: "PROOF VERTICAL SERVICES" });
      assert.strictEqual(candidates.length, 2,
        "normalized provider names are recognition candidates, not identity");

      const engagementA = await service.createEngagement(client, {
        property_id: propertyA, service_class: "elevator_maintenance",
        service_label: "Elevator maintenance", provider_id: provider.id,
        engagement_label: "Passenger elevator", effective_from: "2026-01-01",
        source_artifact_id: agreementA.id, user_id: userId,
      });
      const engagementB = await service.createEngagement(client, {
        property_id: propertyB, service_class: "elevator_maintenance",
        service_label: "Elevator maintenance", provider_id: provider.id,
        engagement_label: "Second property elevator", effective_from: "2026-01-01",
        source_artifact_id: agreementB.id, user_id: userId,
      });
      assert.strictEqual(engagementB.provider_id, provider.id,
        "one canonical provider UUID can serve two properties");

      const unsignedDocument = await service.confirmDocument(client, {
        property_id: propertyA, engagement_id: engagementA.id,
        source_artifact_id: unsignedA.id, document_kind: "agreement",
        execution_state: "unsigned", document_date: "2025-12-15",
        filename: "proof-unsigned-a.pdf", user_id: userId,
      });
      const executedDocument = await service.confirmDocument(client, {
        property_id: propertyA, engagement_id: engagementA.id,
        source_artifact_id: agreementA.id, document_kind: "agreement",
        execution_state: "executed", document_date: "2025-12-20",
        filename: "proof-agreement-a.pdf", user_id: userId,
      });
      await service.confirmDocument(client, {
        property_id: propertyA, engagement_id: null,
        source_artifact_id: accountingA.id, document_kind: "accounting_report",
        execution_state: "unverified", filename: "proof-accounting-a.pdf", user_id: userId,
      });

      await expectServiceCode("EXECUTED_GOVERNING_SOURCE_REQUIRED", () => service.recordTerm(client, {
        property_id: propertyA, engagement_id: engagementA.id, document_id: unsignedDocument.id,
        term_authority: "governing", commencement_trigger: "equipment accepted for service",
        initial_term_months: 12, term_kind: "fixed", automatic_renewal: true,
        renewal_period_months: 12, notice_days: 90, source_artifact_id: unsignedA.id,
        user_id: userId,
      }));

      const term = await service.recordTerm(client, {
        property_id: propertyA, engagement_id: engagementA.id, document_id: executedDocument.id,
        term_authority: "governing", commencement_trigger: "equipment accepted for service",
        initial_term_months: 12, term_kind: "fixed", automatic_renewal: true,
        renewal_period_months: 12, notice_days: 90, source_artifact_id: agreementA.id,
        user_id: userId,
      });
      const scope = await service.recordScope(client, {
        property_id: propertyA, engagement_id: engagementA.id, term_id: term.id,
        scope_summary: "Preventive elevator maintenance and callback coverage.",
        frequency_summary: "Monthly preventive visit", effective_from: "2026-01-01",
        source_artifact_id: agreementA.id, user_id: userId,
      });
      await service.recordLocation(client, {
        property_id: propertyA, scope_id: scope.id, location_kind: "whole_property",
        location_label: "Property elevator system", effective_from: "2026-01-01",
        user_id: userId,
      });
      const price = await service.recordPriceComponent(client, {
        property_id: propertyA, term_id: term.id, price_basis: "variable",
        amount_cents: null, description: "Base service plus contract-defined callback rates.",
        user_id: userId,
      });
      assert.strictEqual(price.amount_cents, null,
        "variable contract price remains unknown rather than fabricated");
      const financial = await service.recordFinancialObservation(client, {
        property_id: propertyA, engagement_id: engagementA.id,
        service_class: "elevator_maintenance", provider_id: provider.id,
        source_artifact_id: accountingA.id, observation_kind: "accounting_line",
        line_label: "Elevator Repairs & Maintenance", period_start: "2026-01-01",
        period_end: "2026-07-01", amount_cents: 837400,
        provenance_note: "Observed in the accounting workpaper; not a contract price or payment.",
        user_id: userId,
      });
      assert.strictEqual(Number(financial.amount_cents), 837400);

      await expectServiceCode("SOURCE_SCOPE_MISMATCH", () => service.createEngagement(client, {
        property_id: propertyA, service_class: "pest_control", provider_id: provider.id,
        source_artifact_id: agreementB.id, user_id: userId,
      }));
      await expectServiceCode("NOT_FOUND", () => service.confirmDocument(client, {
        property_id: propertyB, engagement_id: engagementA.id,
        source_artifact_id: agreementB.id, document_kind: "agreement",
        execution_state: "executed", user_id: userId,
      }));

      await expectDatabaseRefusal(client, /executed eligible document/i, () => client.query(
        `insert into contracted_service_terms
          (property_id, engagement_id, document_id, term_authority,
           commencement_trigger, initial_term_months, term_kind, source_artifact_id,
           provenance_note, recorded_by_user_id)
         values ($1,$2,$3,'governing','equipment accepted',12,'fixed',$4,'proof',$5)`,
        [propertyA, engagementA.id, unsignedDocument.id, unsignedA.id, userId]));
      await expectDatabaseRefusal(client, /foreign key|violates/i, () => client.query(
        `insert into contracted_service_documents
          (property_id, engagement_id, source_artifact_id, document_kind,
           execution_state, confirmed_by_user_id)
         values ($1,$2,$3,'agreement','executed',$4)`,
        [propertyB, engagementA.id, agreementB.id, userId]));
      await expectDatabaseRefusal(client, /duplicate key|unique/i, () => service.recordRequirement(client, {
        property_id: propertyA, service_class: "elevator_maintenance",
        determination: "contracted_service_required", basis: "Second branch attempt.",
        effective_from: "2026-01-01", supersedes_id: requirement.id,
        revision_reason: "Attempted competing successor.", user_id: userId,
      }));
      await expectDatabaseRefusal(client, /append-only/i, () => client.query(
        "update contracted_service_engagements set engagement_label = 'changed' where id = $1",
        [engagementA.id]));

      const foreignUnit = (await client.query(
        "select id from units where property_id = $1 order by id limit 1", [propertyB])).rows[0];
      if (foreignUnit) {
        await expectDatabaseRefusal(client, /same property/i, () => service.recordLocation(client, {
          property_id: propertyA, scope_id: scope.id, location_kind: "unit",
          location_label: "Foreign unit", unit_id: foreignUnit.id,
          effective_from: "2026-01-01", user_id: userId,
        }));
      }

      const position = await positionRead.readPosition(client,
        { property_id: propertyA, as_of: "2026-08-14" });
      assert.strictEqual(position.standing.engagement_count, 1);
      assert.strictEqual(position.standing.unmatched_document_count, 1);
      assert.strictEqual(position.standing.unmatched_financial_observation_count, 0);
      assert.strictEqual(position.detail.engagements[0].provider.id, provider.id);
      assert(position.detail.engagements[0].term_standing.current,
        "executed event-anchored governing term survives the canonical read");
      assert(position.detail.engagements[0].term_standing.current.evidence.source_artifact_id,
        "governing source attribution survives the canonical read");
      assert.strictEqual(position.detail.engagements[0].payment.truth_state, "NOT_ESTABLISHED");

      const correctionHistory = (await client.query(
        "select id, supersedes_id from contracted_service_requirements where property_id=$1 and service_class=$2",
        [propertyA, "elevator_maintenance"])).rows;
      assert.strictEqual(correctionHistory.length, 2);
      const paymentColumns = (await client.query(
        `select table_name, column_name from information_schema.columns
          where table_schema='public' and table_name like 'contracted_service%'
            and column_name in ('paid_at','payment_status','payment_amount_cents')`)).rows;
      assert.deepStrictEqual(paymentColumns, [],
        "the contract domain does not manufacture provider-payment truth");

      console.log("Contracted Services PostgreSQL proof passed");
      console.log("  schema: 11 append-only canonical tables");
      console.log("  isolation: service and database property guards passed");
      console.log("  truth walls: execution, price, expense, invoice, and payment remain distinct");
      console.log(`  foreign-unit probe: ${foreignUnit ? "passed" : "not applicable (second property has no units)"}`);
    } finally {
      await client.query("rollback");
    }
  } finally {
    await client.end();
  }
}

run().catch((error) => {
  console.error("Contracted Services PostgreSQL proof failed:", error.message);
  process.exitCode = 1;
});
