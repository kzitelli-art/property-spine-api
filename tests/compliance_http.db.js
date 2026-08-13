#!/usr/bin/env node
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const path = require("path");
const express = require("express");
const { Pool } = require("pg");
const receipt = require("./_run_receipt.js");
const contracts = require("../src/asset/compliance_contracts.js");
const documentRead = require("../src/asset/compliance_document_read.js");

const URL = receipt.harnessConnectionString();
const EXPECTED = 52;
let passed = 0;
let failed = 0;

function ok(label, condition, detail) {
  if (condition) {
    passed++;
    console.log("  ok    " + label);
  } else {
    failed++;
    console.log("  FAIL  " + label + (detail ? "\n          " + detail : ""));
  }
}

function digest(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function confirmation(artifact, proposal, key, override = {}, correction = null) {
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

function request(port, method, route, { token, body, raw, headers: extraHeaders } = {}) {
  return new Promise((resolve, reject) => {
    const bytes = raw !== undefined ? raw
      : body === undefined ? null : Buffer.from(JSON.stringify(body));
    const headers = { ...(extraHeaders || {}) };
    if (token) headers["x-staff-session"] = token;
    if (bytes && raw === undefined) {
      headers["content-type"] = "application/json";
    }
    if (bytes) headers["content-length"] = String(bytes.length);
    const req = http.request({ host: "127.0.0.1", port, method, path: route, headers }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const buffer = Buffer.concat(chunks);
        let bodyValue = null;
        if ((res.headers["content-type"] || "").includes("application/json")) {
          try { bodyValue = JSON.parse(buffer.toString("utf8")); } catch (_) {}
        }
        resolve({ status: res.statusCode, headers: res.headers, buffer, body: bodyValue });
      });
    });
    req.on("error", reject);
    if (bytes) req.write(bytes);
    req.end();
  });
}

function multipart(filename, contentType, buffer, fields = {}) {
  const boundary = "----spine-compliance-" + crypto.randomBytes(8).toString("hex");
  const parts = [];
  for (const [key, value] of Object.entries(fields)) {
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`));
  }
  parts.push(Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
    `Content-Type: ${contentType}\r\n\r\n`));
  parts.push(buffer, Buffer.from(`\r\n--${boundary}--\r\n`));
  return { raw: Buffer.concat(parts), headers: { "content-type": `multipart/form-data; boundary=${boundary}` } };
}

async function main() {
  receipt.begin(__filename, { url: URL, expected: EXPECTED });
  const admin = new Pool({ connectionString: URL });
  const schema = `compliance_http_${Date.now()}`;
  let client = null;
  let pool = null;
  let server = null;

  try {
    await admin.query(`create schema ${schema}`);
    client = await admin.connect();
    await client.query(`set search_path to ${schema}`);
    await client.query(`
      create table users (
        id uuid primary key default gen_random_uuid(), name text, phone text, email text,
        role text, is_active boolean not null default true, status text not null default 'active',
        account_kind text
      );
      create table properties (id uuid primary key default gen_random_uuid(), name text);
      create table property_team_assignments (
        property_id uuid not null references properties(id), user_id uuid not null references users(id),
        role_title text, allowed_modules text[] not null default '{}',
        primary_for_modules text[] not null default '{}', can_manage_roles boolean default false,
        active boolean not null default true, primary key(property_id, user_id)
      );
      create table staff_sessions (
        id uuid primary key default gen_random_uuid(), user_id uuid not null references users(id),
        property_id uuid not null references properties(id), token text, token_digest text,
        issuance_purpose text, created_at timestamptz not null default now(),
        expires_at timestamptz not null, revoked boolean not null default false
      );
      create table source_artifacts (
        id uuid primary key default gen_random_uuid(), scope_type text not null, scope_id uuid not null,
        original_filename text not null, mime_type text, artifact_kind text not null default 'other',
        byte_size integer, sha256 text, content bytea, stored_at timestamptz default now(),
        uploaded_at timestamptz default now(), source_as_of_date date,
        uploaded_by_user_id uuid references users(id), uploaded_by_basis text
      );
    `);
    await client.query(fs.readFileSync(
      path.join(__dirname, "../migrations/169_compliance_canonical_truth.sql"), "utf8"));

    const propertyA = (await client.query(
      "insert into properties(name) values ('Authority A') returning id")).rows[0];
    const propertyB = (await client.query(
      "insert into properties(name) values ('Authority B') returning id")).rows[0];
    const userA = (await client.query(
      "insert into users(name,email,role,account_kind) values ('Operator A','a@test','operator','staff') returning id"
    )).rows[0];
    const userB = (await client.query(
      "insert into users(name,email,role,account_kind) values ('Operator B','b@test','operator','staff') returning id"
    )).rows[0];
    const userNoEntitlement = (await client.query(
      "insert into users(name,email,role,account_kind) values ('Operator N','n@test','operator','staff') returning id"
    )).rows[0];

    async function session(userId, propertyId, modules) {
      const token = crypto.randomBytes(32).toString("base64url");
      await client.query(
        `insert into property_team_assignments
           (property_id,user_id,role_title,allowed_modules,active)
         values ($1,$2,'Asset Manager',$3,true)`, [propertyId, userId, modules]);
      await client.query(
        `insert into staff_sessions
           (user_id,property_id,token_digest,issuance_purpose,expires_at)
         values ($1,$2,$3,'bootstrap_invite',now() + interval '1 hour')`,
        [userId, propertyId, digest(Buffer.from(token))]);
      return token;
    }
    const tokenA = await session(userA.id, propertyA.id, ["asset_management"]);
    const tokenB = await session(userB.id, propertyB.id, ["asset_management"]);
    const tokenNoEntitlement = await session(
      userNoEntitlement.id, propertyA.id, ["management"]);

    const sourceBytes = Buffer.concat([Buffer.from("%PDF-1.4\n"), fs.readFileSync(
      path.join(__dirname, "fixtures/compliance/solo_4233_rental_license.txt"))]);
    async function retain(propertyId, userId, filename) {
      return (await client.query(
        `insert into source_artifacts
           (scope_type,scope_id,original_filename,mime_type,artifact_kind,byte_size,sha256,content,
            uploaded_by_user_id)
         values ('property',$1,$2,'application/pdf','other',$3,$4,$5,$6)
         returning id,sha256`,
        [propertyId, filename, sourceBytes.length, digest(sourceBytes), sourceBytes, userId])).rows[0];
    }
    const artifactB = await retain(propertyB.id, userB.id, "Foreign Rental License.pdf");
    const proposal = documentRead.propose(sourceBytes.toString("utf8"));
    const confirmedB = confirmation(artifactB, proposal, "http-confirm-foreign", {
      effective_from: "2026-04-30", effective_through: "2027-05-01",
    });

    const scopedUrl = new globalThis.URL(URL);
    scopedUrl.searchParams.set("options", `-c search_path=${schema}`);
    pool = new Pool({ connectionString: scopedUrl.toString() });
    let askModelRequest = null;
    const anthropic = { messages: { create: async (input) => {
      askModelRequest = input;
      return { content: [{ type: "text", text: JSON.stringify({
        outcome: "answered",
        answer: "The rental license is current through May 1, 2027, based on the established period.",
      }) }] };
    } } };
    const app = express();
    app.use(express.json({ limit: "1mb" }));
    app.use(require("../src/surfaces/asset_management.js")({
      pool,
      fileToText: async (file) => file.buffer.toString("utf8"),
    }));
    app.use(require("../src/agent/ask_spine.js")({ pool, anthropic }));
    server = await new Promise((resolve) => {
      const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
    });
    const port = server.address().port;
    const base = "/operator/asset-management/compliance";

    const unauthenticated = await request(port, "GET", base);
    ok("unauthenticated Compliance read is refused", unauthenticated.status === 401);
    const unentitled = await request(port, "GET", base, { token: tokenNoEntitlement });
    ok("authenticated operator without Asset Management entitlement is refused",
      unentitled.status === 403);
    const propertyClaim = await request(port, "GET",
      `${base}?property_id=${propertyB.id}`, { token: tokenA });
    ok("client property cannot override session property", propertyClaim.status === 403);

    const empty = await request(port, "GET", `${base}?as_of=2026-08-13`, { token: tokenA });
    ok("authorized same-property read succeeds", empty.status === 200);
    ok("not established is a successful empty read, not an infrastructure failure",
      empty.body.items.length === 0 && empty.body.coverage.state === "unknown");
    const badDate = await request(port, "GET", `${base}?as_of=8%2F13%2F2026`, { token: tokenA });
    ok("ambiguous read date is refused", badDate.status === 422);

    const uploaded = await request(port, "POST", `${base}/evidence`, {
      token: tokenA, ...multipart("Rental License 922616.pdf", "application/pdf", sourceBytes),
    });
    ok("governed HTTP intake retains and reads a generic Compliance PDF",
      uploaded.status === 201 && uploaded.body.intake.proposal.recognition_state === "recognized");
    ok("retained source stays generically classified",
      uploaded.body.intake.artifact.artifact_kind === "other");
    ok("first source proposes no existing-item relationship",
      uploaded.body.item_relationship === null);
    ok("source intake cannot establish canonical truth",
      (await client.query("select count(*)::int n from compliance_facts")).rows[0].n === 0);
    const artifactA = uploaded.body.intake.artifact;
    const confirmedA = confirmation(artifactA, proposal, "http-confirm-a", {
      effective_from: "2026-04-30", effective_through: "2027-05-01",
    });

    const foreignArtifact = await request(port, "POST", `${base}/confirm`, {
      token: tokenA, body: confirmedB,
    });
    ok("cross-property source artifact is refused without an existence oracle",
      foreignArtifact.status === 404 && foreignArtifact.body.error === "not_found");
    ok("foreign source refusal establishes no canonical truth",
      (await client.query("select count(*)::int n from compliance_facts")).rows[0].n === 0);

    const actorInjection = await request(port, "POST", `${base}/confirm`, {
      token: tokenA, body: { ...confirmedA, actor_user_id: userB.id },
    });
    ok("client actor input is refused by the exact confirmation contract",
      actorInjection.status === 422);
    ok("client actor input cannot create a fact",
      (await client.query("select count(*)::int n from compliance_facts")).rows[0].n === 0);
    const samePropertyInjection = await request(port, "POST", `${base}/confirm`, {
      token: tokenA, body: { ...confirmedA, property_id: propertyA.id },
    });
    ok("even a matching client property is not accepted as canonical writer input",
      samePropertyInjection.status === 422);

    const established = await request(port, "POST", `${base}/confirm`, {
      token: tokenA, body: confirmedA,
    });
    ok("authorized confirmation terminates in canonical truth", established.status === 201 &&
      established.body.outcome === "established");
    ok("confirmation returns the server-authored reread receipt",
      established.body.next.kind === "reread_compliance_standing");
    const itemId = established.body.record.id;
    const attribution = (await client.query(
      "select id,established_by_user_id from compliance_facts where item_id=$1", [itemId])).rows[0];
    ok("canonical attribution comes from the authenticated session actor",
      String(attribution.established_by_user_id) === String(userA.id));

    const standing = await request(port, "GET", `${base}?as_of=2026-08-13`, { token: tokenA });
    ok("canonical reread returns current standing", standing.status === 200 &&
      standing.body.items[0].standing.code === "current");
    const refs = standing.body.items[0].references;
    const recordRef = refs.find((entry) => entry.role === "canonical_record");
    const sourceRef = refs.find((entry) => entry.role === "source_artifact");
    ok("reader returns both server-minted reference classes",
      recordRef && sourceRef && recordRef.opener.kind === "server_minted" &&
      sourceRef.opener.kind === "server_minted");
    ok("source identity remains opaque in the reader wire response",
      !JSON.stringify(standing.body).includes(String(artifactA.id)));

    askModelRequest = null;
    const claimedAskProperty = await request(port, "POST", "/operator/ask-spine/ask", {
      token: tokenA, body: { property_id: propertyB.id, question: "Is our rental license current?" },
    });
    ok("Ask Spine refuses a client property claim before reading Compliance",
      claimedAskProperty.status === 403 && askModelRequest === null);
    const unentitledAsk = await request(port, "POST", "/operator/ask-spine/ask", {
      token: tokenNoEntitlement, body: { question: "Is our rental license current?" },
    });
    ok("Ask Spine distinguishes missing Compliance entitlement",
      unentitledAsk.status === 200 && unentitledAsk.body.outcome === "not_authorized" &&
      askModelRequest === null);
    const composedAsk = await request(port, "POST", "/operator/ask-spine/ask", {
      token: tokenA,
      body: { question: "Is the rental license current and who has the work order?" },
    });
    ok("Ask Spine refuses unresolved cross-domain composition",
      composedAsk.status === 200 && composedAsk.body.outcome === "composition_unavailable" &&
      askModelRequest === null);

    const complianceAsk = await request(port, "POST", "/operator/ask-spine/ask", {
      token: tokenA, body: { question: "Is our rental license current and why?" },
    });
    ok("authorized Ask Spine request answers from canonical Compliance standing",
      complianceAsk.status === 200 && complianceAsk.body.outcome === "answered" &&
      /current through May 1, 2027/.test(complianceAsk.body.answer));
    const askFacts = askModelRequest.messages[0].content;
    const askFactsPayload = JSON.parse(askFacts
      .replace(/^QUESTION SUBJECT:[^\n]+\nFACTS:\n/, "")
      .replace(/\n\nOPERATOR ASKED:[\s\S]*$/, ""));
    ok("the model receives only the session property's Compliance subject",
      askFacts.includes(String(propertyA.id)) && /QUESTION SUBJECT: compliance/.test(askFacts) &&
      !("attention" in askFactsPayload) && !("work_orders" in askFactsPayload));
    ok("the model receives no canonical ids or opener tokens",
      !askFacts.includes(String(itemId)) && !askFacts.includes(String(artifactA.id)) &&
      !/server_minted|opener|opaque/.test(askFacts));
    const askReferenceKinds = complianceAsk.body.references
      .map((entry) => entry.open.kind).sort().join(",");
    ok("Ask Spine returns both server-resolved Compliance opener classes",
      askReferenceKinds === "compliance_record,compliance_source" &&
      complianceAsk.body.references.every((entry) => !!entry.open.token));
    ok("Ask Spine receipt names its governed read and unsolved composition state",
      complianceAsk.body.grounded_on.compliance_items === 1 &&
      complianceAsk.body.grounded_on.composition_authorization === "unsolved_cross_domain" &&
      complianceAsk.body.grounded_on.open_items === null);
    const askRecord = complianceAsk.body.references.find(
      (entry) => entry.open.kind === "compliance_record");
    const openedAskRecord = await request(port, "GET",
      `${base}/open/record/${encodeURIComponent(askRecord.open.token)}?as_of=2026-08-13`,
      { token: tokenA });
    ok("Ask Spine's record reference opens through the canonical Compliance route",
      openedAskRecord.status === 200 &&
      openedAskRecord.body.item.entity.record_id === String(itemId));
    const askSource = complianceAsk.body.references.find(
      (entry) => entry.open.kind === "compliance_source");
    const openedAskSource = await request(port, "GET",
      `${base}/open/source/${encodeURIComponent(askSource.open.token)}`, { token: tokenA });
    ok("Ask Spine's source reference opens the exact retained bytes",
      openedAskSource.status === 200 && openedAskSource.buffer.equals(sourceBytes));

    const overview = await request(port, "GET", "/operator/asset-management/overview", {
      token: tokenA,
    });
    const complianceRoom = overview.body.rooms.find((room) => room.key === "compliance");
    ok("Asset Management overview asks Compliance for establishment",
      overview.status === 200 && complianceRoom.establishment === "partially_established");
    ok("credential truth establishes only the license compartment",
      complianceRoom.compartments.find((entry) => entry.key === "licenses_registrations")
        .establishment === "established" &&
      complianceRoom.compartments.find((entry) => entry.key === "violations_cure")
        .establishment === "not_established");
    ok("overview preserves the unknown requirement census",
      /requirement census remains unknown/i.test(complianceRoom.establishment_summary));

    const recognizedAgain = await request(port, "POST", `${base}/evidence`, {
      token: tokenA, ...multipart("Renewed Rental License.pdf", "application/pdf", sourceBytes),
    });
    ok("new evidence may propose continuity with an existing canonical item",
      recognizedAgain.status === 201 && recognizedAgain.body.item_relationship &&
      recognizedAgain.body.item_relationship.candidate.item_id === String(itemId));
    ok("continuity remains explicitly unestablished",
      recognizedAgain.body.item_relationship.state === "proposed" &&
      recognizedAgain.body.item_relationship.does_not_establish.includes("canonical_item_resolution") &&
      (await client.query("select count(*)::int n from compliance_facts")).rows[0].n === 1);

    const detail = await request(port, "GET", `${base}/items/${itemId}?as_of=2026-08-13`, {
      token: tokenA,
    });
    ok("same-property canonical detail is allowed",
      detail.status === 200 && detail.body.item.entity.record_id === String(itemId));
    const crossDetail = await request(port, "GET",
      `${base}/items/${itemId}?as_of=2026-08-13`, { token: tokenB });
    ok("cross-property canonical item is refused", crossDetail.status === 404);
    const absentDetail = await request(port, "GET",
      `${base}/items/${crypto.randomUUID()}?as_of=2026-08-13`, { token: tokenB });
    ok("absent and cross-property item reads expose the same response",
      absentDetail.status === crossDetail.status &&
      JSON.stringify(absentDetail.body) === JSON.stringify(crossDetail.body));

    const crossCorrection = await request(port, "POST", `${base}/items/${itemId}/confirm`, {
      token: tokenB,
      body: { ...confirmedB, idempotency_key: "cross-correction", correction: {
        supersedes_fact_id: attribution.id, reason: "Hostile cross-property correction",
      } },
    });
    ok("cross-property correction target is refused without disclosure",
      crossCorrection.status === 404 && crossCorrection.body.error === "not_found");
    ok("cross-property correction creates no successor fact",
      (await client.query("select count(*)::int n from compliance_facts")).rows[0].n === 1);

    const recordPath = `${base}/open/record/${encodeURIComponent(recordRef.opener.token)}`;
    const openedRecord = await request(port, "GET", `${recordPath}?as_of=2026-08-13`, {
      token: tokenA,
    });
    ok("property-scoped canonical record reference opens", openedRecord.status === 200 &&
      openedRecord.body.item.entity.record_id === String(itemId));
    const crossedRecord = await request(port, "GET", `${recordPath}?as_of=2026-08-13`, {
      token: tokenB,
    });
    ok("canonical record reference cannot cross properties",
      crossedRecord.status === 404 && crossedRecord.body.error === "opener_unavailable");
    const tamperedParts = recordRef.opener.token.split(".");
    tamperedParts[2] = (tamperedParts[2][0] === "A" ? "B" : "A") + tamperedParts[2].slice(1);
    const tampered = tamperedParts.join(".");
    const badOpener = await request(port, "GET",
      `${base}/open/record/${encodeURIComponent(tampered)}?as_of=2026-08-13`, { token: tokenA });
    ok("tampered reference is an opener-unavailable failure",
      badOpener.status === 404 && badOpener.body.error === "opener_unavailable");

    const sourcePath = `${base}/open/source/${encodeURIComponent(sourceRef.opener.token)}`;
    const openedSource = await request(port, "GET", sourcePath, { token: tokenA });
    ok("property-scoped retained source reference opens exact bytes",
      openedSource.status === 200 && openedSource.buffer.equals(sourceBytes));
    ok("source opener emits browser-safe private headers",
      openedSource.headers["x-content-type-options"] === "nosniff" &&
      openedSource.headers["cache-control"] === "private, no-store" &&
      /sandbox/.test(openedSource.headers["content-security-policy"]));
    const crossedSource = await request(port, "GET", sourcePath, { token: tokenB });
    ok("retained source reference cannot cross properties",
      crossedSource.status === 404 && crossedSource.body.error === "opener_unavailable");

    const missingReason = await request(port, "POST", `${base}/items/${itemId}/confirm`, {
      token: tokenA,
      body: { ...confirmedA, idempotency_key: "missing-reason", correction: {
        supersedes_fact_id: attribution.id, reason: "",
      } },
    });
    ok("HTTP correction without a reason is refused", missingReason.status === 422);
    const correction = await request(port, "POST", `${base}/items/${itemId}/confirm`, {
      token: tokenA,
      body: {
        ...confirmedA,
        idempotency_key: "http-correction",
        confirmed: { ...confirmedA.confirmed, effective_from: "2026-05-01" },
        correction: { supersedes_fact_id: attribution.id, reason: "Corrected from source review." },
      },
    });
    ok("authorized HTTP correction appends canonical truth", correction.status === 201);
    const history = (await client.query(
      `select established_by_user_id,supersedes_fact_id,correction_reason
         from compliance_facts where item_id=$1 order by established_at,id`, [itemId])).rows;
    ok("correction preserves predecessor, reason and session attribution",
      history.length === 2 && String(history[1].supersedes_fact_id) === String(attribution.id) &&
      history[1].correction_reason === "Corrected from source review." &&
      String(history[1].established_by_user_id) === String(userA.id));

    await client.query("update source_artifacts set content=null where id=$1", [artifactA.id]);
    const unavailableSource = await request(port, "GET", sourcePath, { token: tokenA });
    ok("retained record with unavailable bytes is distinct from opener failure",
      unavailableSource.status === 410 && unavailableSource.body.error === "source_unavailable");

    await client.query("alter table compliance_items rename to compliance_items_read_failure");
    const failedRead = await request(port, "GET", `${base}?as_of=2026-08-13`, { token: tokenA });
    ok("database read failure is not collapsed into not established",
      failedRead.status === 503 && failedRead.body.error === "read_failed");
    await client.query("alter table compliance_items_read_failure rename to compliance_items");
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (pool) await pool.end();
    if (client) {
      try { await client.query(`drop schema ${schema} cascade`); } catch (_) {}
      client.release();
    }
    await admin.end();
  }

  process.exitCode = receipt.complete({
    harness: __filename, passed, failed, expectedAtLeast: EXPECTED,
  });
}

main().catch((error) => {
  process.exitCode = receipt.died(__filename, error, passed + failed);
});
