#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const express = require("express");
const receipt = require("../_run_receipt.js");
const readTranscript = require("../../src/meeting_evidence/read_ai_transcript");
const anthropicAdapter = require("../../src/meeting_evidence/anthropic_meeting_receipt_extractor");
const extractorRunner = require("../../src/meeting_evidence/meeting_receipt_extractor_runner");
const workflow = require("../../src/meeting_evidence/meeting_receipt_workflow");
const meetingReceiptService = require("../../src/meeting_evidence/meeting_receipt_service");
const meetingEvidenceRoutes = require("../../src/meeting_evidence/meeting_evidence_routes");
const release = require("../../src/meeting_evidence/meeting_receipt_release_readiness");

const EXPECTED = 80;
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

function includes(label, value, expected) {
  ok(label, String(value).includes(expected), `missing ${expected}`);
}

function notIncludes(label, value, expected) {
  ok(label, !String(value).includes(expected), `unexpected ${expected}`);
}

function uuid(n) {
  return "00000000-0000-4000-8000-" + String(n).padStart(12, "0");
}

async function rejects(promise, code) {
  try {
    await promise;
    return false;
  } catch (error) {
    return error && error.code === code;
  }
}

function modelOutput() {
  return {
    extraction_coverage: "full",
    coverage_notes: null,
    read_gaps: [],
    speaker_resolutions: [{
      speaker_label: "Amory",
      resolved_label: "Anne-Marie",
      resolution_status: "probable",
      resolution_basis: "the observed label is a probable ASR rendering of the property staff name",
    }],
    candidates: [{
      candidate_key: "staffing_observation",
      candidate_type: "observation",
      subject: "Saturday coverage",
      summary: "The meeting said Amory handled Saturday coverage.",
      source_class: "provider_transcript",
      epistemic_status: "stated",
      owner_status: "none",
      owner_label: null,
      owner_resolution_status: null,
      relevant_time: null,
      material_qualifiers: [],
      material: true,
      personal: false,
      supersedes_candidate_key: null,
      support: [{ segment_ordinal: 1, support_role: "observation_basis" }],
      quotes: [{ segment_ordinal: 1, speaker_label: "Kandice", quote_text_exact: "Amory handled Saturday coverage" }],
      branches: [],
      measurements: [],
    }],
  };
}

(async () => {
  receipt.begin(__filename, { expected: EXPECTED });

  const officialPayload = {
    session_id: "session-1",
    trigger: "meeting_end",
    title: "Weekly Operations Review",
    start_time: "2026-08-17T14:00:00.000Z",
    summary: "Provider summary must not enter extraction input.",
    transcript: {
      speaker_blocks: [
        { start_time: "1786975200000", end_time: "1786975201000", speaker: { name: "Kandice" }, words: "Amory handled Saturday coverage." },
        { start_time: "1786975202000", end_time: "1786975203000", speaker: { name: "Robert" }, words: "Let me confirm the number." },
      ],
      speakers: [{ name: "Kandice" }, { name: "Robert" }],
    },
  };
  const parsed = readTranscript.readReadTranscript(officialPayload);
  ok("official Read AI speaker_blocks shape is accepted", parsed.ok === true);
  includes("Read AI words remain exact transcript text", parsed.transcript_text, "Amory handled Saturday coverage.");
  includes("first block receives elapsed timestamp", parsed.transcript_text, "0:00 - Kandice");
  includes("second block retains provider timing", parsed.transcript_text, "0:02 - Robert");
  ok("meeting occurrence comes from provider start_time", parsed.meeting_occurred_at === "2026-08-17T14:00:00.000Z");
  notIncludes("provider summary is excluded from canonical transcript", parsed.transcript_text, "Provider summary");
  ok("missing transcript is refused", readTranscript.readReadTranscript({}).code === "read_transcript_missing");
  ok("malformed transcript block is refused", readTranscript.readReadTranscript({
    start_time: officialPayload.start_time,
    transcript: { speaker_blocks: [{ start_time: "1786975200000", speaker: {}, words: "hello" }] },
  }).code === "read_transcript_block_invalid");

  let adapterArgs = null;
  const anthropic = {
    messages: {
      async create(args) {
        adapterArgs = args;
        return { content: [{ type: "tool_use", name: anthropicAdapter.TOOL_NAME, input: { extraction_coverage: "full", candidates: [] } }] };
      },
    },
  };
  const adapter = anthropicAdapter.createAnthropicMeetingReceiptExtractor({ anthropic, model: "fixture-model", maxTokens: 9000 });
  const adapterOutput = await adapter({ prompt: "prompt", schema: { type: "object" } });
  ok("Anthropic adapter returns only structured tool input", adapterOutput.extraction_coverage === "full");
  ok("Anthropic adapter uses the frozen extraction tool", adapterArgs.tools[0].name === anthropicAdapter.TOOL_NAME);
  ok("Anthropic adapter forces that exact tool", adapterArgs.tool_choice.name === anthropicAdapter.TOOL_NAME);
  ok("Anthropic adapter runs at temperature zero", adapterArgs.temperature === 0);
  ok("Anthropic adapter passes server schema as input_schema", adapterArgs.tools[0].input_schema.type === "object");
  ok("adapter identifies its provider", adapter.provider === "anthropic");
  ok("adapter exposes configured model provenance", adapter.model === "fixture-model");

  const proseAdapter = anthropicAdapter.createAnthropicMeetingReceiptExtractor({
    anthropic: { messages: { async create() { return { content: [
      { type: "text", text: "Here is the result" },
      { type: "tool_use", name: anthropicAdapter.TOOL_NAME, input: {} },
    ] }; } } },
  });
  ok("prose beside structured output is rejected", await rejects(
    proseAdapter({ prompt: "p", schema: {} }), "meeting_receipt_model_protocol_rejected"));
  const multiAdapter = anthropicAdapter.createAnthropicMeetingReceiptExtractor({
    anthropic: { messages: { async create() { return { content: [
      { type: "tool_use", name: anthropicAdapter.TOOL_NAME, input: {} },
      { type: "tool_use", name: anthropicAdapter.TOOL_NAME, input: {} },
    ] }; } } },
  });
  ok("multiple extraction tool calls are rejected", await rejects(
    multiAdapter({ prompt: "p", schema: {} }), "meeting_receipt_model_protocol_rejected"));
  const failedAdapter = anthropicAdapter.createAnthropicMeetingReceiptExtractor({
    anthropic: { messages: { async create() { throw new Error("provider secret detail"); } } },
  });
  ok("provider request errors are sanitized", await rejects(
    failedAdapter({ prompt: "p", schema: {} }), "meeting_receipt_model_request_failed"));

  const meeting = {
    meeting_id: uuid(1),
    property_id: uuid(2),
    property_name: "SOLO",
    meeting_occurred_at: "2026-08-17T14:00:00.000Z",
  };
  const transcriptVersion = { transcript_version_id: uuid(3), meeting_id: meeting.meeting_id };
  const segments = [{
    segment_id: uuid(4),
    transcript_version_id: transcriptVersion.transcript_version_id,
    ordinal: 1,
    provider_timestamp: "0:00",
    speaker_label: "Kandice",
    text: "Amory handled Saturday coverage.",
    normalized_text: "avry handled saturday coverage.",
  }];
  const speakerPeople = [{ person_id: uuid(5), label: "Anne-Marie" }];
  const preparedExtraction = extractorRunner.prepareMeetingReceiptExtraction({
    meeting, transcriptVersion, segments, speakerPeople,
  });
  const preparedPrompt = preparedExtraction.prompt;
  includes("prompt requires temporal evidence for every relevant time", preparedPrompt,
    "If relevant_time is non-null, support must include temporal_basis");
  includes("prompt requires both evidence roles for a reported claim", preparedPrompt,
    "A reported_claim requires both claim_basis and attribution support");
  includes("prompt says one segment may satisfy multiple evidence roles", preparedPrompt,
    "The same segment may carry temporal_basis and another required role");
  includes("schema repeats the temporal evidence requirement",
    JSON.stringify(preparedExtraction.schema.properties.candidates.items.properties.relevant_time),
    "support must include temporal_basis");
  includes("schema repeats the reported-claim evidence requirement",
    JSON.stringify(preparedExtraction.schema.properties.candidates.items.properties.support),
    "reported_claim requires claim_basis and attribution");
  let runnerInput = null;
  const scripted = async (args) => { runnerInput = args.input; return modelOutput(); };
  const run1 = await extractorRunner.runMeetingReceiptExtractor({
    extractor: scripted, meeting, transcriptVersion, segments, speakerPeople,
  });
  const run2 = await extractorRunner.runMeetingReceiptExtractor({
    extractor: scripted, meeting, transcriptVersion, segments, speakerPeople,
  });
  ok("runner accepts exact unique property-person resolution", run1.ok === true);
  ok("person id is attached by server after model output", run1.speaker_resolutions[0].resolved_person_id === uuid(5));
  notIncludes("model input contains no person ids", JSON.stringify(runnerInput), uuid(5));
  ok("each extraction rerun receives a new run id", run1.record.run.extraction_run_id !== run2.record.run.extraction_run_id);
  ok("candidate ids are unique across extraction runs", run1.candidates[0].candidate_id !== run2.candidates[0].candidate_id);
  ok("unknown probable person label is rejected", await rejects(Promise.resolve().then(() =>
    extractorRunner.compileExtractorOutput(modelOutput(), { meeting, transcriptVersion, segments, speakerPeople: [] })
  ), "extractor_person_label_unresolved"));
  ok("duplicate property person labels are treated as ambiguous", await rejects(Promise.resolve().then(() =>
    extractorRunner.compileExtractorOutput(modelOutput(), {
      meeting, transcriptVersion, segments,
      speakerPeople: [{ person_id: uuid(5), label: "Anne-Marie" }, { person_id: uuid(6), label: "Anne-Marie" }],
    })
  ), "extractor_person_label_ambiguous"));
  const unresolvedWithLabel = modelOutput();
  unresolvedWithLabel.speaker_resolutions[0].resolution_status = "unresolved";
  ok("unresolved resolution cannot smuggle a resolved label", await rejects(Promise.resolve().then(() =>
    extractorRunner.compileExtractorOutput(unresolvedWithLabel, { meeting, transcriptVersion, segments, speakerPeople })
  ), "extractor_unresolved_label_forbidden"));
  const unresolvedNamedOwner = modelOutput();
  unresolvedNamedOwner.candidates[0].owner_status = "named";
  unresolvedNamedOwner.candidates[0].owner_label = "Katie Leung";
  unresolvedNamedOwner.candidates[0].owner_resolution_status = "unresolved";
  const unresolvedNamedOwnerRun = extractorRunner.compileExtractorOutput(unresolvedNamedOwner, {
    meeting, transcriptVersion, segments, speakerPeople,
  });
  ok("transcript-named owner may remain unresolved", unresolvedNamedOwnerRun.candidates[0].owner_label === "Katie Leung");
  ok("unresolved named owner receives no person id", unresolvedNamedOwnerRun.candidates[0].owner_person_id === null);
  const forward = modelOutput();
  forward.candidates[0].supersedes_candidate_key = "later";
  forward.candidates.push({ ...forward.candidates[0], candidate_key: "later", supersedes_candidate_key: null });
  ok("forward supersession is rejected before database persistence", await rejects(Promise.resolve().then(() =>
    extractorRunner.compileExtractorOutput(forward, { meeting, transcriptVersion, segments, speakerPeople })
  ), "extractor_supersession_not_prior"));

  const root = path.join(__dirname, "..", "..");
  const routesSource = fs.readFileSync(path.join(root, "src", "meeting_evidence", "meeting_evidence_routes.js"), "utf8");
  const workflowSource = fs.readFileSync(path.join(root, "src", "meeting_evidence", "meeting_receipt_workflow.js"), "utf8");
  const adapterSource = fs.readFileSync(path.join(root, "src", "meeting_evidence", "anthropic_meeting_receipt_extractor.js"), "utf8");
  const serviceSource = fs.readFileSync(path.join(root, "src", "meeting_evidence", "meeting_receipt_service.js"), "utf8");
  const serverSource = fs.readFileSync(path.join(root, "server.js"), "utf8");
  const migration = fs.readFileSync(path.join(root, "migrations", "176_meeting_receipt_v0.sql"), "utf8");
  const hardeningMigration = fs.readFileSync(
    path.join(root, "migrations", "181_meeting_evidence_binding_finality_lineage.sql"), "utf8");
  includes("owner receipt generation endpoint is mounted", routesSource, "/owner-receipt");
  includes("property-scoped receipt read endpoint is mounted", routesSource, "/receipts/:id");
  includes("manual preview edit endpoint is mounted", routesSource, "/manual-edits");
  includes("manual sent assertion endpoint is mounted", routesSource, "/sent");
  includes("human feedback endpoint is mounted", routesSource, "/feedback");
  includes("release readiness endpoint is mounted", routesSource, "/release-readiness");
  includes("binding correction endpoint is mounted", routesSource, "/binding-corrections");
  includes("exact-delivery finality endpoint is mounted", routesSource, "/deliveries/:deliveryId/finality");
  includes("server injects the existing Anthropic client", serverSource, "operatorRoutes({ pool, anthropic })");
  notIncludes("workflow still does not call Ask Spine", workflowSource, "ask_spine");
  notIncludes("model adapter has no database dependency", adapterSource, "require(\"pg\")");
  includes("service persists speaker resolution lineage", serviceSource, "persistSpeakerResolutions");
  includes("service atomically persists extraction and receipt", serviceSource, "persistExtractionAndReceipt");
  notIncludes("receipt runtime does not send email", routesSource + workflowSource + serviceSource, "sendMail");
  includes("migration guards receipt-to-run lineage", migration, "trg_meeting_receipt_lineage_guard");
  includes("migration guards receipt item lineage", migration, "trg_meeting_receipt_item_guard");
  includes("migration guards review candidate lineage", migration, "trg_meeting_receipt_review_guard");
  includes("migration guards missed-item transcript evidence", migration, "trg_meeting_receipt_missed_item_guard");
  notIncludes("migration still does not write work orders", migration, "insert into work_orders");
  includes("hardening migration enforces one initial binding", hardeningMigration, "uq_meeting_binding_one_initial");
  includes("hardening migration cannot leapfrog Skyline 177 through 180", hardeningMigration,
    "requires migrations 177, 178, 179, and 180 to land first");
  includes("hardening migration prevents binding forks", hardeningMigration, "uq_meeting_binding_one_successor");
  includes("hardening migration exposes only current finality", hardeningMigration, "meeting_provider_delivery_current_qualifications");
  includes("finality method is closed to manual exact-delivery review", hardeningMigration,
    "qualification_method = 'manual_exact_delivery_review'");
  includes("hardening migration records model attempts and outcomes", hardeningMigration, "meeting_extraction_attempt_outcomes");
  includes("hardening migration defers accepted outcome enforcement to commit", hardeningMigration, "deferrable initially deferred");
  notIncludes("hardening migration still writes no canonical work", hardeningMigration, "insert into work_orders");

  const sentReceiptDb = {
    async query(sql) {
      const text = String(sql);
      if (text.includes("from meeting_receipts r")) return { rows: [{
        receipt_id: uuid(40),
        rendered_subject: "Spine subject",
        rendered_body: "Spine body",
        rendered_digest: "a".repeat(64),
        manually_marked_sent_at: "2026-08-17T15:00:00.000Z",
        manually_marked_sent_by_user_id: uuid(41),
      }] };
      if (text.includes("from meeting_receipt_items")) return { rows: [] };
      if (text.includes("meeting_receipt_manual_edit_deltas")) return { rows: [] };
      throw new Error("unexpected sent receipt query");
    },
  };
  ok("preview edits are refused after the receipt is sent", await rejects(
    meetingReceiptService.appendManualEditForReceipt(sentReceiptDb, {
      receiptId: uuid(40), propertyId: uuid(2), editedByUserId: uuid(41),
      fieldName: "rendered_body", humanText: "late edit",
    }),
    "receipt_preview_already_sent"
  ));
  ok("a conflicting second sent assertion is rejected", await rejects(
    meetingReceiptService.recordManualSend(sentReceiptDb, {
      receiptId: uuid(40), propertyId: uuid(2), markedByUserId: uuid(41),
      sentBody: "different body",
    }),
    "receipt_sent_assertion_conflict"
  ));

  const readinessRow = { ledger_ceiling: "181", migration_count: 168 };
  for (const table of release.REQUIRED_TABLES) readinessRow[`has_${table}`] = true;
  const db = {
    async query(sql) {
      if (String(sql).includes("schema_migrations")) return { rows: [readinessRow] };
      if (String(sql).includes("from properties")) return { rows: [{ property_name: "SOLO" }] };
      throw new Error("unexpected workflow query");
    },
  };
  let evidenceArgs = null;
  let persistedRecord = null;
  let persistedOptions = null;
  let attemptArgs = null;
  let persistenceCount = 0;
  const evidence = {
    async readBoundProviderTranscript(_db, args) {
      evidenceArgs = args;
      return {
        transcript_text: "0:00 - Kandice\nAmory handled Saturday coverage.",
        meeting_occurred_at: meeting.meeting_occurred_at,
        occurred_at_source: "provider_recorded",
        source_kind: "read_ai_webhook_transcript",
        provider_delivery_id: uuid(20),
        provider_delivery_qualification_id: uuid(25),
      };
    },
  };
  const receipts = {
    async ensureCanonicalMeeting() { return meeting; },
    async latestReceiptForMeeting() { return null; },
    async reissueGate() { return { ok_to_auto_reissue: true, review_count: 0, reason: null }; },
    async ingestTranscriptVersion() {
      return {
        version: transcriptVersion,
        segments,
        provider_source: { source_link_id: uuid(26) },
        deduplicated: false,
      };
    },
    async loadPropertyPeople() { return speakerPeople; },
    async openExtractionAttempt(_db, args) {
      attemptArgs = args;
      return { extraction_attempt_id: uuid(27), ...args };
    },
    async recordExtractionAttemptOutcome() {
      throw new Error("successful workflow must close the attempt inside accepted persistence");
    },
    async persistExtractionAndReceipt(_db, record, options) {
      persistenceCount += 1;
      persistedRecord = record;
      persistedOptions = options;
      return {
        extraction: { run: record.run, candidates: record.candidates },
        extraction_outcome: { extraction_outcome_id: uuid(28), outcome_status: "accepted" },
        receipt: { receipt_id: uuid(21), rendered_digest: "a".repeat(64) },
        rendered: { rendered_subject: "SOLO Receipt", rendered_body: "body" },
      };
    },
  };
  scripted.provider = "scripted";
  scripted.model = "fixture-model";
  const generated = await workflow.generateOwnerReceiptFromProviderMeeting({
    db,
    extractor: scripted,
    providerMeetingId: uuid(22),
    propertyId: meeting.property_id,
    initiatedByUserId: uuid(23),
    evidence,
    receipts,
  });
  ok("governed provider-to-receipt workflow completes", generated.receipt.receipt_id === uuid(21));
  ok("provider meeting lookup is property scoped", evidenceArgs.providerMeetingId === uuid(22) && evidenceArgs.propertyId === meeting.property_id);
  ok("workflow persists the validated extraction record", persistedRecord && persistedRecord.candidates.length === 1);
  ok("workflow response exposes transcript metadata, not transcript prose", !Object.prototype.hasOwnProperty.call(generated.transcript, "transcript_text"));
  ok("workflow opens attempt against the exact transcript source link",
    attemptArgs.transcriptSourceLinkId === uuid(26));
  ok("workflow records prompt, schema, and request digests before model use",
    [attemptArgs.promptSha256, attemptArgs.outputSchemaSha256, attemptArgs.requestInputSha256]
      .every((digest) => /^[0-9a-f]{64}$/.test(digest)));
  ok("accepted persistence is bound to the opened attempt",
    persistedOptions.extractionAttemptId === uuid(27));
  ok("workflow returns accepted attempt outcome lineage",
    generated.extraction_outcome.outcome_status === "accepted");

  const reviewedReceipts = {
    ...receipts,
    async latestReceiptForMeeting() { return { receipt_id: uuid(24) }; },
    async reissueGate() { return { ok_to_auto_reissue: false, review_count: 1, reason: "prior_human_review_requires_reissue_review" }; },
  };
  ok("prior human review blocks an unacknowledged reissue", await rejects(
    workflow.generateOwnerReceiptFromProviderMeeting({
      db, extractor: scripted, providerMeetingId: uuid(22), propertyId: meeting.property_id,
      initiatedByUserId: uuid(23), evidence, receipts: reviewedReceipts,
    }),
    "meeting_receipt_prior_review_requires_acknowledgement"
  ));
  ok("blocked reissue causes no additional extraction persistence", persistenceCount === 1);

  const operatorUserId = uuid(60);
  const operatorPropertyId = uuid(61);
  const providerMeetingId = uuid(62);
  let routeWorkflowArgs = null;
  let routeWorkflowCalls = 0;
  const routePool = {
    async query() {
      return { rows: [{
        session_id: uuid(63),
        id: operatorUserId,
        name: "Operator",
        property_id: operatorPropertyId,
        role_title: "Property Manager",
        allowed_modules: ["management"],
        primary_for_modules: ["management"],
        can_manage_roles: false,
      }] };
    },
  };
  const routeWorkflow = {
    async generateOwnerReceiptFromProviderMeeting(args) {
      routeWorkflowCalls += 1;
      routeWorkflowArgs = args;
      return {
        meeting: { meeting_id: uuid(64) },
        transcript: { transcript_version_id: uuid(65), segment_count: 1 },
        extraction_attempt: { extraction_attempt_id: uuid(70) },
        extraction_outcome: { extraction_outcome_id: uuid(71), outcome_status: "accepted" },
        extraction: { run: { extraction_run_id: uuid(66) } },
        receipt: { receipt_id: uuid(67) },
        rendered: { rendered_subject: "SOLO Receipt", rendered_body: "body" },
        reissue: { ok_to_auto_reissue: true },
      };
    },
    async assertMeetingReceiptReady() { return { ok: true }; },
  };
  const app = express();
  app.use(express.json());
  app.use(meetingEvidenceRoutes.operatorRoutes({
    pool: routePool,
    extractorOverride: async () => ({}),
    receiptWorkflowOverride: routeWorkflow,
    receiptServiceOverride: meetingReceiptService,
  }));
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  try {
    const address = server.address();
    const endpoint = `http://127.0.0.1:${address.port}/operator/meeting-evidence/provider-meetings/${providerMeetingId}/owner-receipt`;
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", "x-staff-session": "test-session" },
      body: JSON.stringify({ intended_recipient_person_id: uuid(68) }),
    });
    const body = await response.json();
    ok("real owner-receipt HTTP route returns created", response.status === 201 && body.receipt.receipt_id === uuid(67));
    ok("HTTP route invokes the governed workflow once", routeWorkflowCalls === 1);
    ok("HTTP route derives property from staff session", routeWorkflowArgs.propertyId === operatorPropertyId);
    ok("HTTP route derives actor from staff session", routeWorkflowArgs.initiatedByUserId === operatorUserId);
    ok("HTTP route takes provider meeting identity from path", routeWorkflowArgs.providerMeetingId === providerMeetingId);
    ok("HTTP route passes the intended recipient without client property authority", routeWorkflowArgs.intendedRecipientPersonId === uuid(68));

    const refused = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", "x-staff-session": "test-session" },
      body: JSON.stringify({ property_id: uuid(69) }),
    });
    ok("HTTP route refuses a client attempt to switch properties", refused.status === 403 && routeWorkflowCalls === 1);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }

  process.exitCode = receipt.complete({
    harness: __filename,
    passed,
    failed,
    expectedAtLeast: EXPECTED,
  });
})().catch((error) => {
  receipt.died(__filename, error, passed + failed);
  process.exitCode = 1;
});
