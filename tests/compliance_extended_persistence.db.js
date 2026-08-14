#!/usr/bin/env node
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");
const receipt = require("./_run_receipt.js");
const writeContracts = require("../src/asset/compliance_fact_write_contracts.js");
const { createComplianceFactWriter } = require("../src/asset/compliance_fact_persistence.js");
const reads = require("../src/asset/compliance_read.js");

const URL = receipt.harnessConnectionString();
const EXPECTED = 32;
let passed = 0;
let failed = 0;
function ok(label, condition, detail) {
  if (condition) { passed++; console.log(`  ok    ${label}`); }
  else { failed++; console.log(`  FAIL  ${label}${detail ? `\n          ${detail}` : ""}`); }
}
async function refuses(label, fn, code) {
  let error = null;
  try { await fn(); } catch (caught) { error = caught; }
  ok(label, !!error && (!code || error.code === code || String(error.message).includes(code)),
    error && `${error.code || ""} ${error.message}`);
}
function sha(bytes) { return crypto.createHash("sha256").update(bytes).digest("hex"); }
function confirmation(artifact, key, item, fact, correction = null) {
  return writeContracts.validateConfirmation({
    contract_version: writeContracts.VERSION,
    artifact_id: String(artifact.id),
    artifact_sha256: artifact.sha256,
    idempotency_key: key,
    source_reviewed: true,
    item,
    fact,
    correction,
  });
}

async function main() {
  const admin = new Pool({ connectionString: URL });
  const schema = `compliance_extended_${Date.now()}`;
  let client;
  let pool;
  try {
    await admin.query(`create schema ${schema}`);
    client = await admin.connect();
    await client.query(`set search_path to ${schema}`);
    await client.query(`
      create table users (id uuid primary key default gen_random_uuid(), name text);
      create table properties (id uuid primary key default gen_random_uuid(), name text);
      create table source_artifacts (
        id uuid primary key default gen_random_uuid(), scope_type text not null,
        scope_id uuid not null, original_filename text not null, mime_type text,
        artifact_kind text not null default 'other', sha256 text, content bytea,
        source_as_of_date date, uploaded_by_user_id uuid references users(id));
    `);
    await client.query(fs.readFileSync(
      path.join(__dirname, "../migrations/168_compliance_canonical_truth.sql"), "utf8"));
    await client.query(fs.readFileSync(
      path.join(__dirname, "../migrations/170_compliance_extended_truth.sql"), "utf8"));

    const columns = (await client.query(
      `select column_name from information_schema.columns
        where table_schema=$1 and table_name='compliance_facts'`, [schema])).rows
      .map((row) => row.column_name);
    ok("170 adds exact inspection and applicability columns",
      ["inspection_outcome", "requirement_applicability"].every((name) => columns.includes(name)));
    ok("170 adds identifiers without a generic JSON payload",
      columns.includes("credential_subject_identifier") &&
      columns.includes("finding_external_reference") && !columns.includes("payload"));
    ok("Compliance persistence still owns no assignment column",
      !columns.some((name) => /owner_id|assigned_to|assigned_user_id/.test(name)));

    const actor = (await client.query("insert into users(name) values ('Operator') returning id")).rows[0];
    const property = (await client.query("insert into properties(name) values ('4233') returning id")).rows[0];
    const other = (await client.query("insert into properties(name) values ('Other') returning id")).rows[0];
    async function retain(propertyId, filename, body) {
      const bytes = Buffer.from(body);
      return (await client.query(
        `insert into source_artifacts
           (scope_type,scope_id,original_filename,mime_type,artifact_kind,sha256,content,
            uploaded_by_user_id)
         values ('property',$1,$2,'application/pdf','other',$3,$4,$5)
         returning id,sha256`,
        [propertyId, filename, sha(bytes), bytes, actor.id])).rows[0];
    }
    const certSource = await retain(property.id, "CRS.pdf", "Certificate of Rental Suitability");
    const inspectionSource = await retain(property.id, "Facade Inspection.pdf", "SAFE");
    const exemptionSource = await retain(property.id, "Lead Exemption.pdf", "exempt; no certificate");
    const findingSource = await retain(property.id, "Trash Violation.pdf", "CVN 71334222");
    const paymentSource = await retain(property.id, "SWEEP Receipt.pdf", "Payment 90259307");
    const otherSource = await retain(other.id, "Foreign.pdf", "foreign evidence");

    const rawPool = new Pool({ connectionString: URL });
    pool = {
      async connect() {
        const connection = await rawPool.connect();
        await connection.query(`set search_path to ${schema}`);
        return connection;
      },
      async query(...args) {
        const connection = await this.connect();
        try { return await connection.query(...args); }
        finally { connection.release(); }
      },
      async end() { await rawPool.end(); },
    };
    const writer = createComplianceFactWriter();
    const authority = { property_id: String(property.id), actor_user_id: String(actor.id) };
    const mintReference = async (claims) => sha(Buffer.from(JSON.stringify(claims)));
    const cert = confirmation(certSource, "cert-476856", {
      existing_item_id: null, item_kind: "credential",
      compliance_type: "rental_suitability_certificate",
    }, { fact_type: "credential_period", value: {
      issuing_authority: "City of Philadelphia Department of Licenses & Inspections",
      external_number: "476856", subject_identifier: "Rental License 922616",
      credential_code: null, activity_number: null, legal_entity_name: null,
      property_address: "4233 Chestnut St, Philadelphia, PA", unit_count: 281,
      effective_from: "2026-07-15", effective_through: "2026-09-13",
    } });
    const certReceipt = await writer.establishFact(pool, { authority, confirmation: cert });
    ok("authorized operator establishes a certificate period", certReceipt.outcome === "established");
    const certAttribution = (await client.query(
      `select f.established_by_user_id from compliance_facts f
        join compliance_items i on i.id=f.item_id where i.id=$1`, [certReceipt.record.id])).rows[0];
    ok("certificate attribution is the server actor",
      String(certAttribution.established_by_user_id) === String(actor.id));

    const inspection = confirmation(inspectionSource, "facade-2023", {
      existing_item_id: null, item_kind: "inspection", compliance_type: "facade_inspection",
    }, { fact_type: "inspection_result", value: {
      performed_on: "2023-10-16", outcome: "passed",
      summary: "Professional engineer recorded the exterior walls and appurtenances as SAFE.",
    } });
    const inspectionReceipt = await writer.establishFact(pool, { authority, confirmation: inspection });
    ok("completed inspection is persisted separately from findings",
      inspectionReceipt.established.item_kind === "inspection");

    const requirement = confirmation(exemptionSource, "lead-exemption-2023", {
      existing_item_id: null, item_kind: "requirement",
      compliance_type: "lead_certification_requirement",
    }, { fact_type: "requirement_applicability", value: {
      decided_on: "2023-05-08", applicability: "exempt",
      summary: "Authority confirmed the 4233 property row is exempt and no certificate will issue.",
    } });
    const requirementReceipt = await writer.establishFact(pool, { authority, confirmation: requirement });
    ok("exemption is persisted as applicability, not a certificate",
      requirementReceipt.established.item_kind === "requirement");

    const finding = confirmation(findingSource, "violation-71334222", {
      existing_item_id: null, item_kind: "finding", compliance_type: "code_violation",
    }, { fact_type: "finding_issued", value: {
      issued_on: "2025-10-30", external_reference: "CVN 71334222",
      summary: "Dumpster overflowing notice for the property.",
    } });
    const findingReceipt = await writer.establishFact(pool, { authority, confirmation: finding });
    ok("authority finding is persisted on the finding lifecycle",
      findingReceipt.established.fact_type === "finding_issued");

    const findingItem = {
      existing_item_id: findingReceipt.record.id,
      item_kind: "finding", compliance_type: "code_violation",
    };
    const payment = confirmation(paymentSource, "payment-71334222", findingItem,
      { fact_type: "payment_observed", value: {
        observed_on: "2025-12-30", amount_cents: 19000, currency_code: "USD",
        payment_reference: "90259307",
      } });
    await writer.establishFact(pool, { authority, confirmation: payment });
    ok("payment is persisted as payment evidence", (await client.query(
      "select count(*)::int n from compliance_facts where fact_type='payment_observed'"
    )).rows[0].n === 1);

    let standing = await reads.readComplianceStanding(pool, {
      property_id: String(property.id), as_of: "2026-08-13",
      mintReference,
    });
    let findingStanding = standing.items.find((item) => item.entity.record_id === findingReceipt.record.id);
    ok("payment cannot move finding standing", findingStanding.standing.code === "open");
    ok("payment is not decisive evidence for open standing",
      !findingStanding.evidence.some((entry) => entry.role === "payment"));

    const cure = confirmation(findingSource, "cure-71334222", findingItem,
      { fact_type: "cure_performed", value: {
        performed_on: "2026-01-02", summary: "Overflow condition was removed.",
      } });
    await writer.establishFact(pool, { authority, confirmation: cure });
    standing = await reads.readComplianceStanding(pool, {
      property_id: String(property.id), as_of: "2026-08-13",
      mintReference,
    });
    findingStanding = standing.items.find((item) => item.entity.record_id === findingReceipt.record.id);
    ok("cure remains awaiting authority", findingStanding.standing.code === "cure_recorded_awaiting_authority");

    const disposition = confirmation(findingSource, "closure-71334222", findingItem,
      { fact_type: "authority_disposition", value: {
        decided_on: "2026-01-08", disposition: "closed",
        summary: "Authority recorded the notice closed.",
      } });
    await writer.establishFact(pool, { authority, confirmation: disposition });
    standing = await reads.readComplianceStanding(pool, {
      property_id: String(property.id), as_of: "2026-08-13",
      mintReference,
    });
    findingStanding = standing.items.find((item) => item.entity.record_id === findingReceipt.record.id);
    ok("only authority disposition closes the finding", findingStanding.standing.code === "authority_closed");
    ok("standing returns all four canonical item kinds",
      standing.items.map((item) => item.entity.type).sort().join(",") ===
        "credential,finding,inspection,requirement");
    ok("certificate standing is current as of its period",
      standing.items.find((item) => item.entity.record_id === certReceipt.record.id).standing.code === "current");
    ok("inspection standing is passed",
      standing.items.find((item) => item.entity.record_id === inspectionReceipt.record.id).standing.code === "passed");
    ok("requirement standing is exempt",
      standing.items.find((item) => item.entity.record_id === requirementReceipt.record.id).standing.code === "exempt");
    ok("expanded items still do not imply a complete requirement census", standing.coverage.state === "unknown");
    ok("all expanded items carry server-minted record references",
      standing.items.every((item) => item.references.some((ref) => ref.role === "canonical_record")));
    ok("reader exposes no raw source artifact id",
      ![certSource, inspectionSource, exemptionSource, findingSource, paymentSource]
        .some((source) => JSON.stringify(standing).includes(String(source.id))));

    const detail = await reads.readComplianceDetail(pool, {
      property_id: String(property.id), item_id: findingReceipt.record.id, as_of: "2026-08-13",
      mintReference,
    });
    ok("finding detail preserves issuance, payment, cure and authority history",
      detail.history.map((event) => event.event).join(",") ===
        "finding_issued,payment_observed,cure_performed,authority_disposition");

    const replay = await writer.establishFact(pool, { authority, confirmation: inspection });
    ok("typed writer is idempotent", replay.outcome === "idempotent_replay");
    await refuses("idempotency key cannot be reused for different truth", () =>
      writer.establishFact(pool, { authority, confirmation: {
        ...inspection,
        fact: { ...inspection.fact, value: { ...inspection.fact.value, outcome: "failed" } },
      } }), "IDEMPOTENCY_CONFLICT");
    await refuses("cross-property artifact is refused", () => writer.establishFact(pool, {
      authority,
      confirmation: { ...inspection, artifact_id: String(otherSource.id),
        artifact_sha256: otherSource.sha256, idempotency_key: "foreign-source" },
    }), "ARTIFACT_OUT_OF_SCOPE");
    await refuses("cross-property item is refused", () => writer.establishFact(pool, {
      authority: { property_id: String(other.id), actor_user_id: String(actor.id) },
      confirmation: confirmation(otherSource, "foreign-item", findingItem,
        { fact_type: "payment_observed", value: {
          observed_on: "2026-01-01", amount_cents: 100, currency_code: "USD",
          payment_reference: null,
        } }),
    }), "ITEM_OUT_OF_SCOPE");
    await refuses("lifecycle observation cannot create a finding implicitly", () =>
      writer.establishFact(pool, { authority, confirmation: confirmation(paymentSource,
        "orphan-payment", { ...findingItem, existing_item_id: null }, payment.fact) }),
      "EXISTING_ITEM_REQUIRED");

    const inspectionFact = (await client.query(
      "select id from compliance_facts where item_id=$1 and fact_type='inspection_result'",
      [inspectionReceipt.record.id])).rows[0];
    const correction = confirmation(inspectionSource, "facade-correction", {
      existing_item_id: inspectionReceipt.record.id,
      item_kind: "inspection", compliance_type: "facade_inspection",
    }, { fact_type: "inspection_result", value: {
      ...inspection.fact.value,
      summary: "Corrected transcription: professional engineer checked SAFE on the signed form.",
    } }, { supersedes_fact_id: String(inspectionFact.id), reason: "Corrected from signed source." });
    await writer.establishFact(pool, { authority, confirmation: correction });
    const corrected = (await client.query(
      `select supersedes_fact_id,correction_reason from compliance_facts
        where item_id=$1 order by established_at desc,id desc limit 1`,
      [inspectionReceipt.record.id])).rows[0];
    ok("correction appends and preserves predecessor and reason",
      String(corrected.supersedes_fact_id) === String(inspectionFact.id) &&
      corrected.correction_reason === "Corrected from signed source.");

    await refuses("database refuses a fact on the wrong item kind", async () => {
      await client.query("begin");
      try {
        await client.query(
          `insert into compliance_facts
             (item_id,fact_type,finding_issued_on,finding_summary,request_fingerprint,
              establishment_fingerprint,established_by_user_id)
           values ($1,'finding_issued','2026-01-01','wrong kind',$2,$3,$4)`,
          [inspectionReceipt.record.id, "1".repeat(64), "2".repeat(64), actor.id]);
      } finally { await client.query("rollback"); }
    }, "not valid");
    await refuses("database refuses incompetent evidence role", () => client.query(
      `insert into compliance_fact_evidence(fact_id,source_artifact_id,evidence_role,label)
       values ($1,$2,'payment','wrong role')`, [inspectionFact.id, inspectionSource.id]), "not competent");
    await refuses("database refuses a canonical fact without competent evidence", async () => {
      await client.query("begin");
      try {
        const item = (await client.query(
          `insert into compliance_items(property_id,item_kind,compliance_type,created_by_user_id)
           values ($1,'inspection','unproven_inspection',$2) returning id`,
          [property.id, actor.id])).rows[0];
        await client.query(
          `insert into compliance_facts
             (item_id,fact_type,inspection_performed_on,inspection_outcome,inspection_summary,
              request_fingerprint,establishment_fingerprint,established_by_user_id)
           values ($1,'inspection_result','2026-01-01','passed','unsupported',$2,$3,$4)`,
          [item.id, "3".repeat(64), "4".repeat(64), actor.id]);
        await client.query("set constraints all immediate");
      } finally { await client.query("rollback"); }
    }, "requires inspection evidence");

    const counts = (await client.query(
      `select (select count(*)::int from compliance_items) items,
              (select count(*)::int from compliance_facts) facts,
              (select count(*)::int from compliance_fact_evidence) evidence`)).rows[0];
    ok("each committed fact has an evidence link", counts.facts === counts.evidence,
      JSON.stringify(counts));
    ok("the typed confirmation has no authority or assignment keys",
      !["property_id", "actor_user_id", "owner_id", "assigned_to"]
        .some((key) => Object.prototype.hasOwnProperty.call(inspection, key)));
  } finally {
    if (pool) await pool.end();
    if (client) client.release();
    try { await admin.query(`drop schema ${schema} cascade`); } catch (_) {}
    await admin.end();
  }
  process.exitCode = receipt.complete({
    harness: __filename, passed, failed, expectedAtLeast: EXPECTED,
  });
}

main().catch((error) => {
  process.exitCode = receipt.died(__filename, error, passed + failed);
});
