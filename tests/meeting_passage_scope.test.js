#!/usr/bin/env node
"use strict";

const express = require("express");
const fs = require("fs");
const path = require("path");
const staffSessions = require("../src/identity/staff_session_service");
const routes = require("../src/meeting_evidence/meeting_evidence_routes");
const { readReadTranscript } = require("../src/meeting_evidence/read_ai_transcript");
const scope = require("../src/meeting_evidence/meeting_passage_scope_service");

const EXPECTED = 30;
let passed = 0;
let failed = 0;

function ok(label, condition, detail = "") {
  if (condition) {
    passed += 1;
    console.log("  ok    " + label);
  } else {
    failed += 1;
    console.error("  FAIL  " + label + (detail ? "\n        " + detail : ""));
  }
}

function uuid(n) {
  return "20000000-0000-4000-8000-" + String(n).padStart(12, "0");
}

function caught(fn) {
  try {
    fn();
    return null;
  } catch (error) {
    return error;
  }
}

async function main() {
  const serviceSource = fs.readFileSync(path.join(
    __dirname, "../src/meeting_evidence/meeting_passage_scope_service.js"), "utf8");
  ok("passage scope service does not import Ask Spine", !serviceSource.includes("/agent/") && !serviceSource.includes("ask_spine"));
  ok("passage scope service does not import receipt extraction", !serviceSource.includes("meeting_receipt"));
  ok("passage scope service writes no canonical meeting or operating domain",
    !/insert\s+into\s+(meeting_evidence_meetings|meeting_extraction_attempts|meeting_receipts|work_orders|obligations|leases)/i.test(serviceSource));

  const propertyId = uuid(1);
  const otherPropertyId = uuid(2);
  const operatorId = uuid(3);
  const providerMeetingId = uuid(4);
  const deliveryId = uuid(5);
  const longTurn = `${"general portfolio discussion ".repeat(80)}Skyline furniture decision. ${"other detail ".repeat(80)}`;
  const payload = {
    session_id: "temple-properties-session",
    start_time: "2026-08-20T13:00:00.000Z",
    transcript: {
      speaker_blocks: [
        {
          start_time: "1787230800000",
          speaker: { name: "Rob" },
          words: "Skyline is at 91.29% occupancy and has 147 leases.",
        },
        {
          start_time: "1787231100000",
          speaker: { name: "Alex" },
          words: "Berks needs a separate insurance follow-up.",
        },
        {
          start_time: "1787231400000",
          speaker: { name: "Rob" },
          words: longTurn,
        },
      ],
    },
  };
  const transcript = readReadTranscript(payload);
  ok("Read transcript exposes exact provider blocks", transcript.ok && transcript.blocks.length === 3);
  ok("block identity is ordinal rather than a property-name guess",
    transcript.blocks[0].provider_block_ordinal === 1 && transcript.blocks[0].speaker_label === "Rob");
  ok("exact provider start time survives addressing",
    transcript.blocks[1].provider_start_time === "1787231100000");

  const furnitureStart = longTurn.indexOf("Skyline furniture decision.");
  const normalized = scope.normalizePassageInput([
    {
      provider_block_ordinal: 3,
      char_start: furnitureStart,
      char_end: furnitureStart + "Skyline furniture decision.".length,
      scope_target_kind: "property",
      expected_text: "Skyline furniture decision.",
    },
    {
      provider_block_ordinal: 2,
      char_start: 0,
      char_end: payload.transcript.speaker_blocks[1].words.length,
      scope_target_kind: "external_property",
      external_scope_label: "Berks",
    },
    {
      provider_block_ordinal: 1,
      char_start: 0,
      char_end: payload.transcript.speaker_blocks[0].words.length,
      scope_target_kind: "property",
    },
  ], { blocks: transcript.blocks, propertyId });
  ok("non-contiguous property passages are accepted", normalized.filter((p) => p.property_id === propertyId).length === 2);
  ok("a 392-word-style turn can be narrowed to one exact sub-turn",
    normalized.find((p) => p.provider_block_ordinal === 3).passage_text === "Skyline furniture decision.");
  ok("external property label remains non-canonical evidence",
    normalized.find((p) => p.scope_target_kind === "external_property").property_id === null);
  ok("server attaches the active property to property passages",
    normalized.filter((p) => p.scope_target_kind === "property").every((p) => p.property_id === propertyId));
  ok("normalization orders passages by exact provider address",
    normalized.map((p) => p.provider_block_ordinal).join(",") === "1,2,3");
  ok("each exact passage carries a content digest",
    normalized.every((p) => /^[0-9a-f]{64}$/.test(p.passage_text_sha256)));

  const overlapping = caught(() => scope.normalizePassageInput([
    { provider_block_ordinal: 1, char_start: 0, char_end: 20, scope_target_kind: "property" },
    { provider_block_ordinal: 1, char_start: 10, char_end: 30, scope_target_kind: "unresolved" },
  ], { blocks: transcript.blocks, propertyId }));
  ok("overlapping scope ranges are refused", overlapping && overlapping.code === "passage_scope_overlap");

  const stale = caught(() => scope.normalizePassageInput([
    { provider_block_ordinal: 1, char_start: 0, char_end: 7, scope_target_kind: "property", expected_text: "Greenery" },
  ], { blocks: transcript.blocks, propertyId }));
  ok("stale expected text is refused", stale && stale.code === "passage_scope_stale_address");

  const smuggled = caught(() => scope.normalizePassageInput([
    { provider_block_ordinal: 1, char_start: 0, char_end: 7, scope_target_kind: "property", property_id: otherPropertyId },
  ], { blocks: transcript.blocks, propertyId }));
  ok("client property expansion is refused", smuggled && smuggled.code === "passage_scope_client_property_refused");

  const unnamedExternal = caught(() => scope.normalizePassageInput([
    { provider_block_ordinal: 2, char_start: 0, char_end: 5, scope_target_kind: "external_property" },
  ], { blocks: transcript.blocks, propertyId }));
  ok("external scope requires an explicit human label", unnamedExternal && unnamedExternal.code === "external_scope_label_required");

  const digestA = scope.passageScopeDigest("manual Temple review", "partial", normalized);
  const digestB = scope.passageScopeDigest("manual Temple review", "partial", normalized);
  ok("scope-set digest is deterministic", digestA === digestB && /^[0-9a-f]{64}$/.test(digestA));
  ok("scope basis participates in the digest",
    digestA !== scope.passageScopeDigest("different review basis", "partial", normalized));

  const unicodeText = "A \u{1F3E2} Skyline passage";
  const unicodePassage = scope.normalizePassageInput([{
    provider_block_ordinal: 1,
    char_start: 4,
    char_end: 11,
    scope_target_kind: "property",
    expected_text: "Skyline",
  }], {
    propertyId,
    blocks: [{
      provider_block_ordinal: 1,
      provider_start_time: "1",
      provider_timestamp: "0:00",
      speaker_label: "Rob",
      text: unicodeText,
    }],
  });
  ok("Unicode code-point offsets agree with Postgres after an emoji",
    unicodePassage[0].passage_text === "Skyline");

  const originalResolve = staffSessions.resolveStaffSession;
  staffSessions.resolveStaffSession = async () => ({
    id: operatorId,
    property_id: propertyId,
    allowed_modules: ["asset_management"],
    can_manage_roles: false,
  });
  const calls = [];
  const fakePassageService = {
    async classifyProviderMeetingScope(_db, args) {
      calls.push(["classify", args]);
      return { scope_classification_id: uuid(6), ...args, deduplicated: false };
    },
    async readScopeWorkspace(_db, args) {
      calls.push(["workspace", args]);
      return { blocks: [] };
    },
    async replacePassageScopeSet(_db, args) {
      calls.push(["scope", args]);
      return { set: { passage_scope_set_id: uuid(7) }, passages: [], deduplicated: false };
    },
    async readPropertyPassagePreview(_db, args) {
      calls.push(["preview", args]);
      return { property_id: args.propertyId, passages: [] };
    },
  };
  const app = express();
  app.use(express.json());
  app.use(routes.operatorRoutes({
    pool: { query: async () => ({ rows: [] }) },
    passageScopeServiceOverride: fakePassageService,
  }));
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  try {
    const base = `http://127.0.0.1:${server.address().port}/operator/meeting-evidence/provider-meetings/${providerMeetingId}`;
    const headers = { "content-type": "application/json", "x-staff-session": "proof" };
    const classified = await fetch(`${base}/scope-classifications`, {
      method: "POST", headers,
      body: JSON.stringify({ scope_mode: "mixed_property", classification_basis: "Temple cadence" }),
    });
    ok("classification HTTP route creates a governed assertion", classified.status === 201);
    ok("classification route derives the actor from the staff session",
      calls[0][1].classifiedByUserId === operatorId);

    const workspace = await fetch(`${base}/deliveries/${deliveryId}/scope-workspace`, { headers });
    ok("scope workspace route is reachable through the real HTTP router", workspace.status === 200);
    ok("scope workspace derives actor identity server-side", calls[1][1].actorUserId === operatorId);

    const created = await fetch(`${base}/deliveries/${deliveryId}/passage-scope-sets`, {
      method: "POST", headers,
      body: JSON.stringify({ scope_basis: "manual exact passage review", scope_review_coverage: "none", passages: [] }),
    });
    ok("passage scope HTTP route appends a complete set", created.status === 201);
    ok("passage scope route derives property from the staff session", calls[2][1].propertyId === propertyId);
    ok("passage scope route derives the scoping actor", calls[2][1].scopedByUserId === operatorId);

    const preview = await fetch(`${base}/deliveries/${deliveryId}/property-passage-preview`, { headers });
    ok("property preview route is reachable through the real HTTP router", preview.status === 200);
    ok("property preview derives property and actor server-side",
      calls[3][1].propertyId === propertyId && calls[3][1].actorUserId === operatorId);

    const refused = await fetch(`${base}/deliveries/${deliveryId}/passage-scope-sets`, {
      method: "POST", headers,
      body: JSON.stringify({ property_id: otherPropertyId, scope_basis: "attack", passages: [] }),
    });
    ok("shared HTTP wall refuses a different client property", refused.status === 403);
    ok("refused client property never reaches the scope service", calls.length === 4);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    staffSessions.resolveStaffSession = originalResolve;
  }

  const ran = passed + failed;
  if (ran !== EXPECTED) {
    console.error(`  FAIL  assertion receipt expected ${EXPECTED}, ran ${ran}`);
    failed += 1;
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
