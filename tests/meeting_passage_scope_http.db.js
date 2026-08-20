#!/usr/bin/env node
"use strict";

const crypto = require("crypto");
const express = require("express");
const { Pool } = require("pg");
const receipt = require("./_run_receipt");
const { databaseSsl } = require("../src/shared/database_ssl");
const routes = require("../src/meeting_evidence/meeting_evidence_routes");
const evidence = require("../src/meeting_evidence/meeting_evidence_service");

const EXPECTED = 35;
let passed = 0;
let failed = 0;

function ok(label, condition, detail = "") {
  if (condition) {
    passed += 1;
    console.log("  ok    " + label);
  } else {
    failed += 1;
    console.log("  FAIL  " + label + (detail ? "\n          " + detail : ""));
  }
}

function digest(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

async function request(base, path, { method = "GET", token, body } = {}) {
  const response = await fetch(base + path, {
    method,
    headers: {
      "content-type": "application/json",
      "x-staff-session": token,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let payload = null;
  try { payload = await response.json(); } catch (_) {}
  return { status: response.status, body: payload };
}

async function databaseError(pool, operation) {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await operation(client);
    await client.query("rollback");
    return null;
  } catch (error) {
    try { await client.query("rollback"); } catch (_) {}
    return error;
  } finally {
    client.release();
  }
}

async function main() {
  const url = receipt.harnessConnectionString();
  receipt.begin(__filename, { url, expected: EXPECTED });
  const pool = new Pool({ connectionString: url, ssl: databaseSsl(url), max: 4 });
  let server = null;

  const actor = crypto.randomUUID();
  const propertyId = crypto.randomUUID();
  const otherPropertyId = crypto.randomUUID();
  const connectionId = crypto.randomUUID();
  const deliveryId = crypto.randomUUID();
  const providerMeetingId = crypto.randomUUID();
  const sessionToken = crypto.randomBytes(32).toString("base64url");
  const sessionDigest = digest(sessionToken);
  const sessionId = crypto.randomUUID();
  const providerSessionId = "temple-properties-" + crypto.randomUUID();
  const providerRequestId = "temple-request-" + crypto.randomUUID();

  const blocks = [
    { start_time: "1787230800000", speaker: { name: "Rob" }, words: "Skyline is at 91.29% occupancy and has 147 leases." },
    { start_time: "1787231100000", speaker: { name: "Alex" }, words: "Berks needs a separate insurance follow-up." },
    { start_time: "1787231400000", speaker: { name: "Rob" }, words: "Greenery has a leasing question that is not for Skyline." },
    { start_time: "1787231700000", speaker: { name: "Alex" }, words: "Portfolio note. Skyline furniture purchase is approved. Temple Nest leasing remains unresolved." },
  ];
  const payload = Buffer.from(JSON.stringify({
    request_id: providerRequestId,
    session_id: providerSessionId,
    trigger: "meeting_end",
    title: "Temple Properties Weekly",
    start_time: "2026-08-20T13:00:00.000Z",
    transcript: { speaker_blocks: blocks },
  }));

  try {
    const ceiling = (await pool.query("select max(version) as ceiling from schema_migrations")).rows[0].ceiling;
    ok("proof database includes migration 188", ceiling === "188");
    const relations = (await pool.query(
      `select to_regclass('meeting_provider_current_scope_classifications') as classifications,
              to_regclass('meeting_passage_scope_current_sets') as scope_sets,
              to_regclass('meeting_property_current_passages') as property_passages`
    )).rows[0];
    ok("migration exposes current meeting classification", !!relations.classifications);
    ok("migration exposes current complete passage scope set", !!relations.scope_sets);
    ok("migration exposes property-filtered current passages", !!relations.property_passages);

    await pool.query(
      `insert into users (id, name, email) values ($1,'Temple Scope Proof',$2)`,
      [actor, `temple-scope-${actor}@example.invalid`]
    );
    await pool.query(
      `insert into properties (id, name, display_name) values
         ($1,'Skyline Scope Proof','Skyline Scope Proof'),
         ($2,'Other Scope Proof','Other Scope Proof')`,
      [propertyId, otherPropertyId]
    );
    await pool.query(
      `insert into property_team_assignments
         (property_id, user_id, role_title, allowed_modules, can_manage_roles)
       values ($1,$2,'Asset Manager',array['asset_management'],true)`,
      [propertyId, actor]
    );
    await pool.query(
      `insert into staff_sessions
         (id, user_id, property_id, token, token_digest, issuance_purpose, expires_at)
       values ($1,$2,$3,null,$4,'sms_otp',now() + interval '1 day')`,
      [sessionId, actor, propertyId, sessionDigest]
    );
    await pool.query(
      `insert into integration_connections
         (id, provider, authorized_by_user_id, connection_status)
       values ($1,'read_ai',$2,'active')`,
      [connectionId, actor]
    );
    await pool.query(
      `insert into meeting_provider_deliveries
         (id, provider, connection_id, provider_request_id, provider_session_id,
          payload_sha256, byte_length, raw_body, signature_header,
          delivery_state, provider_event_trigger)
       values ($1,'read_ai',$2,$3,$4,$5,$6,$7,$8,'processed_unbound','meeting_end')`,
      [deliveryId, connectionId, providerRequestId, providerSessionId,
       digest(payload), payload.length, payload, "a".repeat(64)]
    );
    await pool.query(
      `insert into meeting_provider_meetings
         (id, provider, connection_id, provider_session_id, first_delivery_id,
          provider_title, provider_started_at_text)
       values ($1,'read_ai',$2,$3,$4,'Temple Properties Weekly','2026-08-20T13:00:00.000Z')`,
      [providerMeetingId, connectionId, providerSessionId, deliveryId]
    );
    const finality = await evidence.qualifyProviderDelivery(pool, {
      providerMeetingId,
      providerDeliveryId: deliveryId,
      qualificationStatus: "qualified_final",
      qualificationBasis: "manual review of exact Temple proof delivery",
      qualifiedByUserId: actor,
    });
    ok("real service qualifies the exact delivery", finality.qualification_status === "qualified_final");

    const downstreamBefore = (await pool.query(
      `select (select count(*) from meeting_evidence_meetings)::int as meetings,
              (select count(*) from meeting_extraction_attempts)::int as attempts,
              (select count(*) from meeting_receipts)::int as receipts`
    )).rows[0];

    const app = express();
    app.use(express.json());
    app.use(routes.operatorRoutes({ pool }));
    server = await new Promise((resolve) => {
      const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
    });
    const base = `http://127.0.0.1:${server.address().port}`;
    const prefix = `/operator/meeting-evidence/provider-meetings/${providerMeetingId}`;

    const unclassifiedBind = await request(base, `${prefix}/bind`, {
      method: "POST", token: sessionToken, body: {},
    });
    ok("new whole-meeting binding refuses absent scope classification",
      unclassifiedBind.status === 409 && unclassifiedBind.body.code === "meeting_scope_classification_required");

    const classified = await request(base, `${prefix}/scope-classifications`, {
      method: "POST", token: sessionToken,
      body: { scope_mode: "mixed_property", classification_basis: "Temple cadence covers four properties" },
    });
    ok("real HTTP route records mixed-property classification", classified.status === 201);
    ok("classification records the authenticated connection authorizer",
      classified.body.classified_by_user_id === actor);

    const mixedBind = await request(base, `${prefix}/bind`, {
      method: "POST", token: sessionToken, body: {},
    });
    ok("mixed meeting is structurally refused from whole-property binding",
      mixedBind.status === 409 && mixedBind.body.code === "whole_meeting_binding_refused_for_mixed_scope");
    ok("mixed binding refusal leaves zero property bindings",
      (await pool.query("select count(*)::int as count from meeting_property_bindings where provider_meeting_id=$1", [providerMeetingId])).rows[0].count === 0);
    const directMixedBinding = await databaseError(pool, (client) => client.query(
      `insert into meeting_property_bindings
         (provider_meeting_id, property_id, bound_by_user_id, binding_basis, binding_kind)
       values ($1,$2,$3,'hostile direct mixed binding','initial')`,
      [providerMeetingId, propertyId, actor]
    ));
    ok("database itself refuses a direct whole-property binding for mixed scope",
      directMixedBinding && directMixedBinding.code === "23514");

    const workspace = await request(base, `${prefix}/deliveries/${deliveryId}/scope-workspace`, {
      token: sessionToken,
    });
    ok("connection authorizer can inspect the exact final delivery", workspace.status === 200);
    ok("workspace exposes all four provider blocks for human scoping", workspace.body.blocks.length === 4);
    ok("workspace preserves exact provider block text",
      workspace.body.blocks[1].text === blocks[1].words);

    const furniture = "Skyline furniture purchase is approved.";
    const templeNest = "Temple Nest leasing remains unresolved.";
    const firstScope = await request(base, `${prefix}/deliveries/${deliveryId}/passage-scope-sets`, {
      method: "POST", token: sessionToken,
      body: {
        scope_basis: "manual exact passage review of Temple weekly meeting",
        scope_review_coverage: "complete",
        passages: [
          { provider_block_ordinal: 1, char_start: 0, char_end: blocks[0].words.length, scope_target_kind: "property", expected_text: blocks[0].words },
          { provider_block_ordinal: 2, char_start: 0, char_end: blocks[1].words.length, scope_target_kind: "external_property", external_scope_label: "Berks", expected_text: blocks[1].words },
          { provider_block_ordinal: 3, char_start: 0, char_end: blocks[2].words.length, scope_target_kind: "external_property", external_scope_label: "Greenery", expected_text: blocks[2].words },
          { provider_block_ordinal: 4, char_start: 0, char_end: "Portfolio note.".length, scope_target_kind: "portfolio_wide", expected_text: "Portfolio note." },
          { provider_block_ordinal: 4, char_start: blocks[3].words.indexOf(furniture), char_end: blocks[3].words.indexOf(furniture) + furniture.length, scope_target_kind: "property", expected_text: furniture },
          { provider_block_ordinal: 4, char_start: blocks[3].words.indexOf(templeNest), char_end: blocks[3].words.indexOf(templeNest) + templeNest.length, scope_target_kind: "external_property", external_scope_label: "Temple Nest", expected_text: templeNest },
        ],
      },
    });
    ok("real HTTP and real Postgres commit one complete scope set", firstScope.status === 201);
    ok("scope set preserves the human's explicit review coverage",
      firstScope.body.set.scope_review_coverage === "complete");
    ok("complete scope set stores six exact non-overlapping passages", firstScope.body.passages.length === 6);
    const firstSetId = firstScope.body.set.passage_scope_set_id;

    const preview1 = await request(base, `${prefix}/deliveries/${deliveryId}/property-passage-preview`, {
      token: sessionToken,
    });
    ok("property preview returns only the two Skyline passages",
      preview1.status === 200 && preview1.body.property_passage_count === 2);
    ok("property preview includes non-contiguous Skyline evidence",
      preview1.body.scoped_excerpt.includes("91.29%") && preview1.body.scoped_excerpt.includes(furniture));
    ok("property preview excludes Berks text", !preview1.body.scoped_excerpt.includes("Berks"));
    ok("property preview excludes Greenery text", !preview1.body.scoped_excerpt.includes("Greenery"));
    ok("property preview excludes Temple Nest text", !preview1.body.scoped_excerpt.includes("Temple Nest"));
    ok("property preview does not disclose external scope labels or target counts",
      !JSON.stringify(preview1.body).includes("external_property")
      && !Object.prototype.hasOwnProperty.call(preview1.body, "coverage_counts"));

    const lateAppend = await databaseError(pool, (client) => client.query(
      `insert into meeting_passage_scopes
         (passage_scope_set_id, ordinal, provider_block_ordinal, char_start, char_end,
          provider_start_time, speaker_label, passage_text, passage_text_sha256,
          scope_target_kind, property_id)
       values ($1,99,1,0,7,$2,'Rob','Skyline',$3,'property',$4)`,
      [firstSetId, blocks[0].start_time, digest("Skyline"), propertyId]
    ));
    ok("database freezes passage membership when a scope set commits",
      lateAppend && lateAppend.code === "23001");

    const fabricatedEvidence = await databaseError(pool, async (client) => {
      const replacement = (await client.query(
        `insert into meeting_passage_scope_sets
           (provider_meeting_id, provider_delivery_qualification_id,
            scope_classification_id, scope_status, scope_review_coverage,
            scope_basis, scope_digest,
            scoped_by_user_id, supersedes_passage_scope_set_id)
         values ($1,$2,$3,'qualified','partial','hostile fabricated text',$4,$5,$6)
         returning passage_scope_set_id`,
        [providerMeetingId, firstScope.body.set.provider_delivery_qualification_id,
         firstScope.body.set.scope_classification_id, "b".repeat(64), actor, firstSetId]
      )).rows[0];
      await client.query(
        `insert into meeting_passage_scopes
           (passage_scope_set_id, ordinal, provider_block_ordinal, char_start, char_end,
            provider_start_time, speaker_label, passage_text, passage_text_sha256,
            scope_target_kind, property_id)
         values ($1,1,1,0,7,$2,'Rob','Greenery',$3,'property',$4)`,
        [replacement.passage_scope_set_id, blocks[0].start_time, digest("Greenery"), propertyId]
      );
    });
    ok("database refuses passage text that does not match exact provider bytes",
      fabricatedEvidence && fabricatedEvidence.code === "23514");

    const unauthorizedTarget = await databaseError(pool, async (client) => {
      const replacement = (await client.query(
        `insert into meeting_passage_scope_sets
           (provider_meeting_id, provider_delivery_qualification_id,
            scope_classification_id, scope_status, scope_review_coverage,
            scope_basis, scope_digest,
            scoped_by_user_id, supersedes_passage_scope_set_id)
         values ($1,$2,$3,'qualified','partial','hostile target property',$4,$5,$6)
         returning passage_scope_set_id`,
        [providerMeetingId, firstScope.body.set.provider_delivery_qualification_id,
         firstScope.body.set.scope_classification_id, "c".repeat(64), actor, firstSetId]
      )).rows[0];
      await client.query(
        `insert into meeting_passage_scopes
           (passage_scope_set_id, ordinal, provider_block_ordinal, char_start, char_end,
            provider_start_time, speaker_label, passage_text, passage_text_sha256,
            scope_target_kind, property_id)
         values ($1,1,1,0,7,$2,'Rob','Skyline',$3,'property',$4)`,
        [replacement.passage_scope_set_id, blocks[0].start_time, digest("Skyline"), otherPropertyId]
      );
    });
    ok("database refuses a property passage outside the classifier's authority",
      unauthorizedTarget && unauthorizedTarget.code === "42501");

    const staleRequest = await request(base, `${prefix}/deliveries/${deliveryId}/passage-scope-sets`, {
      method: "POST", token: sessionToken,
      body: {
        scope_basis: "stale reviewer window",
        scope_review_coverage: "partial",
        passages: [{ provider_block_ordinal: 1, char_start: 0, char_end: 7, scope_target_kind: "property", expected_text: "Greenery" }],
      },
    });
    ok("stale expected provider text is refused before persistence",
      staleRequest.status === 409 && staleRequest.body.code === "passage_scope_stale_address");

    const secondScope = await request(base, `${prefix}/deliveries/${deliveryId}/passage-scope-sets`, {
      method: "POST", token: sessionToken,
      body: {
        scope_basis: "correction: occupancy passage was portfolio context",
        scope_review_coverage: "complete",
        passages: [
          { provider_block_ordinal: 1, char_start: 0, char_end: blocks[0].words.length, scope_target_kind: "portfolio_wide", expected_text: blocks[0].words },
          { provider_block_ordinal: 2, char_start: 0, char_end: blocks[1].words.length, scope_target_kind: "external_property", external_scope_label: "Berks" },
          { provider_block_ordinal: 3, char_start: 0, char_end: blocks[2].words.length, scope_target_kind: "external_property", external_scope_label: "Greenery" },
          { provider_block_ordinal: 4, char_start: blocks[3].words.indexOf(furniture), char_end: blocks[3].words.indexOf(furniture) + furniture.length, scope_target_kind: "property", expected_text: furniture },
          { provider_block_ordinal: 4, char_start: blocks[3].words.indexOf(templeNest), char_end: blocks[3].words.indexOf(templeNest) + templeNest.length, scope_target_kind: "external_property", external_scope_label: "Temple Nest" },
        ],
      },
    });
    ok("scope correction appends a complete successor set", secondScope.status === 201);
    ok("scope correction points to the prior complete set",
      secondScope.body.set.supersedes_passage_scope_set_id === firstSetId);

    const preview2 = await request(base, `${prefix}/deliveries/${deliveryId}/property-passage-preview`, {
      token: sessionToken,
    });
    ok("correction immediately removes stale property visibility",
      preview2.body.property_passage_count === 1 && !preview2.body.scoped_excerpt.includes("91.29%"));
    ok("correction preserves its property passage without leaking neighbors",
      preview2.body.scoped_excerpt.includes(furniture) && !preview2.body.scoped_excerpt.includes(templeNest));
    const setState = (await pool.query(
      `select (select count(*) from meeting_passage_scope_sets where provider_meeting_id=$1)::int as history,
              (select count(*) from meeting_passage_scope_current_sets where provider_meeting_id=$1)::int as current_count`,
      [providerMeetingId]
    )).rows[0];
    ok("scope correction preserves history and leaves one current head",
      setState.history === 2 && setState.current_count === 1);

    const repeated = await request(base, `${prefix}/deliveries/${deliveryId}/passage-scope-sets`, {
      method: "POST", token: sessionToken,
      body: {
        scope_basis: "correction: occupancy passage was portfolio context",
        scope_review_coverage: "complete",
        passages: [
          { provider_block_ordinal: 1, char_start: 0, char_end: blocks[0].words.length, scope_target_kind: "portfolio_wide" },
          { provider_block_ordinal: 2, char_start: 0, char_end: blocks[1].words.length, scope_target_kind: "external_property", external_scope_label: "Berks" },
          { provider_block_ordinal: 3, char_start: 0, char_end: blocks[2].words.length, scope_target_kind: "external_property", external_scope_label: "Greenery" },
          { provider_block_ordinal: 4, char_start: blocks[3].words.indexOf(furniture), char_end: blocks[3].words.indexOf(furniture) + furniture.length, scope_target_kind: "property" },
          { provider_block_ordinal: 4, char_start: blocks[3].words.indexOf(templeNest), char_end: blocks[3].words.indexOf(templeNest) + templeNest.length, scope_target_kind: "external_property", external_scope_label: "Temple Nest" },
        ],
      },
    });
    ok("identical replacement request deduplicates instead of forking", repeated.status === 200 && repeated.body.deduplicated === true);

    const downstreamAfter = (await pool.query(
      `select (select count(*) from meeting_evidence_meetings)::int as meetings,
              (select count(*) from meeting_extraction_attempts)::int as attempts,
              (select count(*) from meeting_receipts)::int as receipts`
    )).rows[0];
    ok("mixed scope writes no canonical meeting, extraction attempt, or receipt",
      JSON.stringify(downstreamAfter) === JSON.stringify(downstreamBefore));

    const mutation = await databaseError(pool, (client) => client.query(
      "update meeting_passage_scope_sets set scope_basis='rewrite' where passage_scope_set_id=$1",
      [firstSetId]
    ));
    ok("scope-set history is append-only against update", mutation && mutation.code === "23001");
  } finally {
    if (server) {
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
    await pool.end();
  }

  process.exitCode = receipt.complete({
    harness: __filename,
    passed,
    failed,
    expectedAtLeast: EXPECTED,
  });
}

main().catch((error) => {
  receipt.died(__filename, error, passed + failed);
  process.exitCode = 1;
});
