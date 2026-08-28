#!/usr/bin/env node
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");
const runReceipt = require("../_run_receipt.js");
const contracts = require("../../src/asset/compliance_contracts.js");
const documentRead = require("../../src/asset/compliance_document_read.js");
const { createComplianceWriter } = require("../../src/asset/compliance_persistence.js");
const reads = require("../../src/asset/compliance_read.js");

const URL = runReceipt.harnessConnectionString();
const EXPECTED_ASSERTIONS = 30;
let pass = 0, fail = 0;
function ok(label, condition, detail) {
  if (condition) { pass++; console.log("  ok    " + label); }
  else { fail++; console.log("  FAIL  " + label + (detail ? "\n          " + detail : "")); }
}
async function refuses(label, fn, expected) {
  let error = null;
  try { await fn(); } catch (caught) { error = caught; }
  ok(label, !!error && (!expected || error.code === expected ||
    String(error.message).includes(expected)), error && `${error.code || ""} ${error.message}`);
}
function sha(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}
function confirmation(artifact, proposal, key, override, correction = null) {
  return {
    contract_version: contracts.VERSIONS.confirmation,
    artifact_id: artifact.id,
    artifact_sha256: artifact.sha256,
    proposal_fingerprint: contracts.proposalFingerprint(artifact.sha256, proposal),
    idempotency_key: key,
    confirmed: { ...proposal.proposed, ...override },
    correction,
  };
}

async function main() {
  const admin = new Pool({ connectionString: URL });
  const schema = `compliance_${Date.now()}`;
  let c, scoped;
  try {
    await admin.query(`create schema ${schema}`);
    c = await admin.connect();
    await c.query(`set search_path to ${schema}`);
    await c.query(`
      create table users (id uuid primary key default gen_random_uuid(), name text);
      create table properties (id uuid primary key default gen_random_uuid(), name text);
      create table source_artifacts (
        id uuid primary key default gen_random_uuid(), scope_type text not null,
        scope_id uuid not null, original_filename text not null, mime_type text,
        artifact_kind text not null default 'other', sha256 text, content bytea,
        source_as_of_date date, uploaded_by_user_id uuid references users(id));
    `);
    await c.query(fs.readFileSync(
      path.join(__dirname, "../../migrations/168_compliance_canonical_truth.sql"), "utf8"));
    await c.query(fs.readFileSync(
      path.join(__dirname, "../../migrations/170_compliance_extended_truth.sql"), "utf8"));

    const tables = (await c.query(
      `select table_name from information_schema.tables
        where table_schema = $1 and table_name like 'compliance_%'
        order by table_name`, [schema])).rows.map((row) => row.table_name);
    ok("migration creates the three minimum canonical tables",
      tables.join(",") === "compliance_fact_evidence,compliance_facts,compliance_items",
      tables.join(","));
    const columns = (await c.query(
      `select column_name from information_schema.columns
        where table_schema = $1 and table_name like 'compliance_%'`, [schema])).rows
      .map((row) => row.column_name);
    ok("standing, attention and assignment are not persisted",
      !columns.some((name) => ["standing", "attention", "owner_id", "assigned_to",
        "assigned_user_id"].includes(name)), columns.join(","));
    ok("facts use typed columns rather than an arbitrary JSON payload",
      !columns.includes("value") && !columns.includes("payload") &&
      columns.includes("credential_effective_from") && columns.includes("authority_disposition"));

    const user = (await c.query("insert into users(name) values ('Operator') returning id")).rows[0];
    const property = (await c.query("insert into properties(name) values ('Solo') returning id")).rows[0];
    const other = (await c.query("insert into properties(name) values ('Other') returning id")).rows[0];
    const source2027 = fs.readFileSync(
      path.join(__dirname, "fixtures/compliance/solo_4233_rental_license.txt"));
    const source2026 = Buffer.from(source2027.toString()
      .replace("5/1/2027 4/30/2026", "5/1/2026 5/2/2025"));
    async function retain(bytes, filename, propertyId = property.id) {
      return (await c.query(
        `insert into source_artifacts
           (scope_type, scope_id, original_filename, mime_type, artifact_kind,
            sha256, content, uploaded_by_user_id)
         values ('property',$1,$2,'application/pdf','other',$3,$4,$5)
         returning id, sha256`, [propertyId, filename, sha(bytes), bytes, user.id])).rows[0];
    }
    const artifact2026 = await retain(source2026, "Rental License Exp May 2026.pdf");
    const artifact2027 = await retain(source2027, "Rental License Exp May 2027.pdf");
    const foreignArtifact = await retain(source2027, "Foreign.pdf", other.id);
    const proposal2026 = documentRead.propose(source2026.toString());
    const proposal2027 = documentRead.propose(source2027.toString());

    scoped = new Pool({ connectionString: URL });
    scoped.on("connect", (client) => client.query(`set search_path to ${schema}`));
    async function transactionRefuses(label, action, expected) {
      const client = await scoped.connect();
      let error = null;
      try {
        await client.query("begin");
        await action(client);
        await client.query("commit");
      } catch (caught) {
        error = caught;
        try { await client.query("rollback"); } catch (_) {}
      } finally {
        client.release();
      }
      ok(label, !!error && (!expected || error.code === expected ||
        String(error.message).includes(expected)), error && `${error.code || ""} ${error.message}`);
    }
    const writer = createComplianceWriter({
      readProposal: async ({ artifact }) => documentRead.propose(artifact.content.toString()),
    });
    const authority = { property_id: property.id, actor_user_id: user.id };
    const confirmed2026 = confirmation(artifact2026, proposal2026, "confirm-2026", {
      effective_from: "2025-05-02", effective_through: "2026-05-01",
    });
    const first = await writer.establishCredentialPeriod(scoped, {
      authority, confirmation: confirmed2026,
    });
    ok("authorized operator establishes the retained 2026 credential", first.outcome === "established");
    const itemId = first.record.id;
    const counts = (await c.query(`select
      (select count(*)::int from compliance_items) items,
      (select count(*)::int from compliance_facts) facts,
      (select count(*)::int from compliance_fact_evidence) evidence`)).rows[0];
    ok("one confirmation creates one item, fact and evidence link",
      counts.items === 1 && counts.facts === 1 && counts.evidence === 1,
      JSON.stringify(counts));
    const attribution = (await c.query(
      "select established_by_user_id from compliance_facts")).rows[0];
    ok("canonical attribution is the server-derived actor",
      String(attribution.established_by_user_id) === String(user.id));
    const replay = await writer.establishCredentialPeriod(scoped, {
      authority, confirmation: confirmed2026,
    });
    ok("double-click confirmation is an idempotent replay", replay.outcome === "idempotent_replay");
    const retry = await writer.establishCredentialPeriod(scoped, {
      authority, confirmation: { ...confirmed2026, idempotency_key: "retry-after-timeout" },
    });
    ok("same confirmed proposal with a fresh HTTP key remains one fact",
      retry.outcome === "idempotent_replay" &&
      (await c.query("select count(*)::int n from compliance_facts")).rows[0].n === 1);
    await refuses("a reused idempotency key cannot change the confirmation", () =>
      writer.establishCredentialPeriod(scoped, { authority, confirmation: {
        ...confirmed2026,
        confirmed: { ...confirmed2026.confirmed, effective_from: "2025-05-03" },
      } }), "IDEMPOTENCY_CONFLICT");
    await refuses("another property's retained source is refused", () =>
      writer.establishCredentialPeriod(scoped, { authority, confirmation:
        confirmation(foreignArtifact, proposal2027, "foreign", {
          effective_from: "2026-04-30", effective_through: "2027-05-01",
        }) }), "ARTIFACT_OUT_OF_SCOPE");
    await refuses("client actor injection remains outside the exact confirmation contract", () =>
      writer.establishCredentialPeriod(scoped, { authority, confirmation: {
        ...confirmed2026, actor_user_id: other.id,
      } }));

    const confirmed2027 = confirmation(artifact2027, proposal2027, "confirm-2027", {
      effective_from: "2026-04-30", effective_through: "2027-05-01",
    });
    const successor = await writer.establishCredentialPeriod(scoped, {
      authority, existing_item_id: itemId, confirmation: confirmed2027,
    });
    ok("server-validated continuity appends the successor to the canonical item",
      successor.record.id === itemId);
    const periods = (await c.query(
      `select credential_effective_from::text from compliance_facts
        where item_id = $1 order by credential_effective_from`, [itemId])).rows;
    ok("successive periods remain two establishments, not one overwrite",
      periods.map((row) => row.credential_effective_from).join(",") ===
      "2025-05-02,2026-04-30");
    const separate = await writer.establishCredentialPeriod(scoped, {
      authority, confirmation: { ...confirmed2027, idempotency_key: "treat-separate" },
    });
    ok("same number does not auto-resolve an existing item", separate.record.id !== itemId);
    ok("treat-separate created a distinct item only because that relationship was requested",
      (await c.query("select count(*)::int n from compliance_items")).rows[0].n === 2);

    const mintReference = async (subject) =>
      `signed:${crypto.createHash("sha256").update(JSON.stringify(subject)).digest("hex")}`;
    const standing = await reads.readComplianceStanding(c, {
      property_id: property.id, as_of: "2026-08-13", mintReference,
    });
    const canonicalItem = standing.items.find((item) => item.entity.record_id === String(itemId));
    ok("DB-backed standing derives current from canonical facts",
      canonicalItem.standing.code === "current");
    ok("expiration creates a date but no operational attention",
      canonicalItem.next.state === "date_only" &&
      canonicalItem.attention.state === "none_established");
    ok("unknown requirement census remains explicit", standing.coverage.state === "unknown");
    ok("the read returns server-minted semantic references",
      canonicalItem.references.every((entry) => entry.opener.kind === "server_minted"));
    ok("the read exposes no raw artifact identity",
      !JSON.stringify(canonicalItem).includes(String(artifact2027.id)));
    const overlap = await reads.readComplianceStanding(c, {
      property_id: property.id, as_of: "2026-05-01", mintReference,
    });
    ok("the real source-backed overlap is surfaced as conflicted",
      overlap.items.find((item) => item.entity.record_id === String(itemId)).standing.code === "conflicted");
    const detail = await reads.readComplianceDetail(c, {
      property_id: property.id, item_id: itemId, as_of: "2026-08-13", mintReference,
    });
    ok("detail retains both periods as establishments",
      detail.history.length === 2 && detail.history.every((event) => event.event === "period_established"));
    ok("a property mismatch cannot read another canonical record",
      await reads.readComplianceDetail(c, {
        property_id: other.id, item_id: itemId, as_of: "2026-08-13", mintReference,
      }) === null);

    const priorFact = (await c.query(
      "select id from compliance_facts where item_id=$1 and credential_effective_from='2025-05-02'",
      [itemId])).rows[0];
    const corrected = confirmation(artifact2026, proposal2026, "correct-2026", {
      external_credential_number: "922616-CORRECTED",
      effective_from: "2025-05-03", effective_through: "2026-05-01",
    }, { supersedes_fact_id: priorFact.id, reason: "Corrected from authority-issued credential." });
    await writer.establishCredentialPeriod(scoped, {
      authority, existing_item_id: itemId, confirmation: corrected,
    });
    const factHistory = (await c.query(
      "select id, supersedes_fact_id from compliance_facts where item_id=$1", [itemId])).rows;
    ok("correction appends a new fact and preserves its predecessor",
      factHistory.length === 3 && factHistory.some((row) =>
        String(row.supersedes_fact_id) === String(priorFact.id)));
    await transactionRefuses("silent fact editing is refused by Postgres", (client) =>
      client.query("update compliance_facts set correction_reason='rewrite' where id=$1", [priorFact.id]),
    "append-only");
    await transactionRefuses("canonical item identity cannot be moved to another property", (client) =>
      client.query("update compliance_items set property_id=$1 where id=$2", [other.id, itemId]),
    "append-only");

    const findingItem = (await c.query(
      `insert into compliance_items(property_id,item_kind,compliance_type,created_by_user_id)
       values ($1,'finding','violation',$2) returning id`, [property.id, user.id])).rows[0];
    await transactionRefuses("supporting evidence alone cannot establish a finding", async (client) => {
      const bareFinding = (await client.query(
        `insert into compliance_facts
           (item_id, fact_type, finding_issued_on, finding_summary,
            request_fingerprint, establishment_fingerprint, established_by_user_id)
         values ($1,'finding_issued','2026-08-01','Notice',$2,$3,$4) returning id`,
        [findingItem.id, "1".repeat(64), "2".repeat(64), user.id])).rows[0];
      await client.query(
        `insert into compliance_fact_evidence(fact_id,source_artifact_id,evidence_role,label)
         values ($1,$2,'supporting','support')`, [bareFinding.id, artifact2027.id]);
    }, "requires finding evidence");
    await transactionRefuses("payment evidence cannot establish credential issuance", async (client) => {
        const payment = (await client.query(
          `insert into compliance_facts
             (item_id, fact_type, payment_observed_on, payment_amount_cents,
              payment_currency_code, request_fingerprint, establishment_fingerprint,
              established_by_user_id)
           values ($1,'payment_observed','2026-08-01',100,'USD',$2,$3,$4) returning id`,
          [findingItem.id, "3".repeat(64), "4".repeat(64), user.id])).rows[0];
        await client.query(
          `insert into compliance_fact_evidence(fact_id,source_artifact_id,evidence_role,label)
           values ($1,$2,'issuance','license')`, [payment.id, artifact2027.id]);
    }, "not competent");
    await transactionRefuses("a foreign-property artifact cannot be linked behind the writer", async (client) => {
        const finding = (await client.query(
          `insert into compliance_facts
             (item_id, fact_type, finding_issued_on, finding_summary,
              request_fingerprint, establishment_fingerprint, established_by_user_id)
           values ($1,'finding_issued','2026-08-01','Notice',$2,$3,$4) returning id`,
          [findingItem.id, "5".repeat(64), "6".repeat(64), user.id])).rows[0];
        await client.query(
          `insert into compliance_fact_evidence(fact_id,source_artifact_id,evidence_role,label)
           values ($1,$2,'finding','foreign')`, [finding.id, foreignArtifact.id]);
    }, "must belong to the fact item property");
    const finalDetail = await reads.readComplianceDetail(c, {
      property_id: property.id, item_id: itemId, as_of: "2026-08-13", mintReference,
    });
    ok("detail retains correction target, reason and complete history",
      finalDetail.history.length === 3 && finalDetail.history.some((event) =>
        event.event === "fact_corrected" && /Corrected/.test(event.reason)));
  } finally {
    if (scoped) await scoped.end();
    if (c) { try { await c.query(`drop schema ${schema} cascade`); } catch (_) {} c.release(); }
    await admin.end();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (pass + fail !== EXPECTED_ASSERTIONS) {
    console.error(`Assertion census drift: expected ${EXPECTED_ASSERTIONS}, ran ${pass + fail}`);
    process.exit(2);
  }
  process.exit(fail ? 1 : 0);
}

main().catch((error) => { console.error(error); process.exit(1); });
