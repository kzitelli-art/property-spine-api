#!/usr/bin/env node
"use strict";

const crypto = require("crypto");
const { Pool } = require("pg");
const receipt = require("./_run_receipt");
const evidence = require("../src/meeting_evidence/meeting_evidence_service");
const receipts = require("../src/meeting_evidence/meeting_receipt_service");
const workflow = require("../src/meeting_evidence/meeting_receipt_workflow");

const HARNESS = __filename;
const EXPECTED = 48;
let passed = 0;
let failed = 0;
let ran = 0;

function ok(label, condition, detail = "") {
  ran += 1;
  if (condition) {
    passed += 1;
    console.log("  ok    " + label);
  } else {
    failed += 1;
    console.log("  FAIL  " + label + (detail ? "\n          " + detail : ""));
  }
}

function uuid(n) {
  return "10000000-0000-4000-8000-" + String(n).padStart(12, "0");
}

async function captured(promise) {
  try {
    await promise;
    return null;
  } catch (error) {
    return error;
  }
}

async function databaseRefusal(client, name, operation) {
  const savepoint = `sp_${name.replace(/[^a-z0-9_]/gi, "_")}`;
  await client.query(`savepoint ${savepoint}`);
  let error = null;
  try {
    await operation();
  } catch (caught) {
    error = caught;
  }
  await client.query(`rollback to savepoint ${savepoint}`);
  await client.query(`release savepoint ${savepoint}`);
  return error;
}

function validOutput() {
  return {
    extraction_coverage: "full",
    coverage_notes: null,
    read_gaps: [],
    speaker_resolutions: [],
    candidates: [{
      candidate_key: "roof_vendor_observation",
      candidate_type: "observation",
      subject: "Roof inspection",
      summary: "The meeting stated that the roof vendor will inspect Tuesday.",
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
      quotes: [{
        segment_ordinal: 1,
        speaker_label: "Morgan",
        quote_text_exact: "The roof vendor will inspect Tuesday.",
      }],
      branches: [],
      measurements: [],
    }],
  };
}

(async () => {
  const url = receipt.harnessConnectionString();
  receipt.begin(HARNESS, { url, expected: EXPECTED });
  const pool = new Pool({ connectionString: url, ssl: { rejectUnauthorized: false }, max: 1 });
  const client = await pool.connect();
  const db = { query: (...args) => client.query(...args) };

  const actor = uuid(1);
  const limitedActor = uuid(2);
  const propertyA = uuid(10);
  const propertyB = uuid(11);
  const connectionId = uuid(20);
  const deliveryId = uuid(21);
  const providerMeetingId = uuid(22);

  try {
    await client.query("begin");
    await client.query(
      `insert into schema_migrations (version, name) values ('181','meeting_evidence_binding_finality_lineage')`
    );
    const relations = (await client.query(
      `select to_regclass('public.meeting_property_current_bindings') as binding_view,
              to_regclass('public.meeting_extraction_attempts') as attempts,
              to_regclass('public.meeting_extraction_attempt_outcomes') as outcomes`
    )).rows[0];
    ok("migration exposes one-current binding view", !!relations.binding_view);
    ok("migration exposes durable extraction attempts", !!relations.attempts);
    ok("migration exposes durable terminal outcomes", !!relations.outcomes);

    await client.query(
      `insert into users (id, name, email) values
         ($1,'Meeting Evidence Proof Operator','meeting-proof-operator@example.invalid'),
         ($2,'Meeting Evidence Limited Operator','meeting-proof-limited@example.invalid')`,
      [actor, limitedActor]
    );
    await client.query(
      `insert into properties (id, name, display_name) values
         ($1,'Meeting Proof A','Meeting Proof A'),
         ($2,'Meeting Proof B','Meeting Proof B')`,
      [propertyA, propertyB]
    );
    await client.query(
      `insert into property_team_assignments
         (property_id, user_id, role_title, allowed_modules, can_manage_roles)
       values
         ($1,$3,'Proof Manager',array['management'],true),
         ($2,$3,'Proof Manager',array['management'],true),
         ($1,$4,'Limited Proof Manager',array['management'],true)`,
      [propertyA, propertyB, actor, limitedActor]
    );
    await client.query(
      `insert into integration_connections
         (id, provider, authorized_by_user_id, connection_status)
       values ($1,'read_ai',$2,'active')`,
      [connectionId, actor]
    );

    const providerPayload = Buffer.from(JSON.stringify({
      request_id: "meeting-proof-request-1",
      session_id: "meeting-proof-session-1",
      trigger: "meeting_end",
      title: "De-identified Weekly Operations Review",
      start_time: "2026-08-17T14:00:00.000Z",
      transcript: {
        speaker_blocks: [{
          start_time: "1786975200000",
          end_time: "1786975201000",
          speaker: { name: "Morgan" },
          words: "The roof vendor will inspect Tuesday.",
        }],
      },
    }));
    const payloadDigest = crypto.createHash("sha256").update(providerPayload).digest("hex");
    await client.query(
      `insert into meeting_provider_deliveries
         (id, provider, connection_id, provider_request_id, provider_session_id,
          payload_sha256, byte_length, raw_body, signature_header,
          delivery_state, provider_event_trigger)
       values ($1,'read_ai',$2,'meeting-proof-request-1','meeting-proof-session-1',
               $3,$4,$5,$6,'processed_unbound','meeting_end')`,
      [deliveryId, connectionId, payloadDigest, providerPayload.length,
       providerPayload, "a".repeat(64)]
    );
    await client.query(
      `insert into meeting_provider_meetings
         (id, provider, connection_id, provider_session_id, first_delivery_id,
          provider_title, provider_started_at_text)
       values ($1,'read_ai',$2,'meeting-proof-session-1',$3,
               'De-identified Weekly Operations Review','2026-08-17T14:00:00.000Z')`,
      [providerMeetingId, connectionId, deliveryId]
    );

    const canonicalBefore = (await client.query(
      `select (select count(*) from work_orders)::int as work_orders,
              (select count(*) from obligations)::int as obligations,
              (select count(*) from leases)::int as leases`
    )).rows[0];

    const initialBinding = await evidence.bindProviderMeeting(db, {
      providerMeetingId,
      propertyId: propertyA,
      boundByUserId: actor,
    });
    ok("initial binding establishes property A", String(initialBinding.property_id) === propertyA);

    const noFinality = await captured(evidence.readBoundProviderTranscript(db, {
      providerMeetingId,
      propertyId: propertyA,
    }));
    ok("well-formed transcript is refused without explicit finality",
      noFinality && noFinality.code === "bound_meeting_has_no_qualified_final_transcript");
    ok("observed meeting_end trigger remains evidence rather than authority",
      (await client.query(`select provider_event_trigger from meeting_provider_deliveries where id=$1`, [deliveryId])).rows[0].provider_event_trigger === "meeting_end");

    const secondInitial = await databaseRefusal(client, "second_initial", () => client.query(
      `insert into meeting_property_bindings
         (provider_meeting_id, property_id, bound_by_user_id, binding_basis, binding_kind)
       values ($1,$2,$3,'hostile second initial','initial')`,
      [providerMeetingId, propertyB, actor]
    ));
    ok("database refuses a second initial property binding", secondInitial && secondInitial.code === "23505");

    const wrongQualifier = await captured(evidence.qualifyProviderDelivery(db, {
      providerMeetingId,
      providerDeliveryId: deliveryId,
      qualificationStatus: "qualified_final",
      qualificationBasis: "manual specimen review",
      qualifiedByUserId: limitedActor,
    }));
    ok("non-authorizer cannot qualify provider finality",
      wrongQualifier && wrongQualifier.code === "finality_qualification_authority_required");

    const finality1 = await evidence.qualifyProviderDelivery(db, {
      providerMeetingId,
      providerDeliveryId: deliveryId,
      qualificationStatus: "qualified_final",
      qualificationBasis: "manual review of the exact provider delivery",
      qualifiedByUserId: actor,
    });
    ok("connection authorizer can qualify one exact delivery final",
      finality1.qualification_status === "qualified_final"
      && finality1.qualification_method === "manual_exact_delivery_review");
    const qualifiedTranscript = await evidence.readBoundProviderTranscript(db, {
      providerMeetingId,
      propertyId: propertyA,
    });
    ok("qualified transcript resolves to the exact provider delivery",
      String(qualifiedTranscript.provider_delivery_id) === deliveryId);
    ok("qualified transcript exposes its exact finality assertion",
      String(qualifiedTranscript.provider_delivery_qualification_id) === String(finality1.qualification_id));

    const extractor = async () => validOutput();
    extractor.provider = "proof-extractor";
    extractor.model = "proof-v1";
    const receiptA = await workflow.generateOwnerReceiptFromProviderMeeting({
      db,
      extractor,
      providerMeetingId,
      propertyId: propertyA,
      initiatedByUserId: actor,
    });
    ok("property A receipt commits through governed workflow", !!receiptA.receipt.receipt_id);
    const acceptedChain = (await client.query(
      `select a.extraction_attempt_id, a.prompt_sha256, a.output_schema_sha256,
              a.request_input_sha256, o.outcome_status, o.extraction_run_id,
              s.provider_delivery_id, s.provider_delivery_qualification_id
         from meeting_extraction_attempts a
         join meeting_extraction_attempt_outcomes o using (extraction_attempt_id)
         join meeting_transcript_provider_sources s
           on s.source_link_id = a.transcript_source_link_id
        where a.extraction_attempt_id = $1`,
      [receiptA.extraction_attempt.extraction_attempt_id]
    )).rows[0];
    ok("accepted attempt has one durable terminal outcome", acceptedChain.outcome_status === "accepted");
    ok("accepted attempt preserves all three deterministic input digests",
      [acceptedChain.prompt_sha256, acceptedChain.output_schema_sha256,
       acceptedChain.request_input_sha256].every((value) => /^[0-9a-f]{64}$/.test(value)));
    ok("transcript source preserves exact delivery and qualification",
      String(acceptedChain.provider_delivery_id) === deliveryId
      && String(acceptedChain.provider_delivery_qualification_id) === String(finality1.qualification_id));
    ok("accepted outcome points to the extraction run",
      String(acceptedChain.extraction_run_id) === String(receiptA.extraction.run.extraction_run_id));
    await client.query("set constraints all immediate");
    ok("deferred run-to-accepted-outcome guard is satisfied", true);
    await client.query("set constraints all deferred");

    const finality2 = await evidence.qualifyProviderDelivery(db, {
      providerMeetingId,
      providerDeliveryId: deliveryId,
      qualificationStatus: "not_final",
      qualificationBasis: "correction after exact delivery review",
      qualifiedByUserId: actor,
    });
    ok("finality correction appends a not-final successor",
      String(finality2.supersedes_qualification_id) === String(finality1.qualification_id));
    const correctedNotFinal = await captured(evidence.readBoundProviderTranscript(db, {
      providerMeetingId,
      propertyId: propertyA,
    }));
    ok("not-final correction immediately blocks transcript interpretation",
      correctedNotFinal && correctedNotFinal.code === "bound_meeting_has_no_qualified_final_transcript");
    const receiptHiddenByFinality = await captured(receipts.loadReceiptForProperty(db, {
      receiptId: receiptA.receipt.receipt_id,
      propertyId: propertyA,
    }));
    ok("superseded finality immediately hides its derived receipt",
      receiptHiddenByFinality && receiptHiddenByFinality.code === "receipt_not_found");

    const finalityFork = await databaseRefusal(client, "finality_fork", () => client.query(
      `insert into meeting_provider_delivery_qualifications
         (provider_meeting_id, provider_delivery_id, qualification_status,
          qualification_basis, qualified_by_user_id, supersedes_qualification_id)
       values ($1,$2,'qualified_final','hostile fork',$3,$4)`,
      [providerMeetingId, deliveryId, actor, finality1.qualification_id]
    ));
    ok("database refuses a fork from an old finality assertion", !!finalityFork);

    const finality3 = await evidence.qualifyProviderDelivery(db, {
      providerMeetingId,
      providerDeliveryId: deliveryId,
      qualificationStatus: "qualified_final",
      qualificationBasis: "second exact-delivery review resolved correction",
      qualifiedByUserId: actor,
    });
    ok("finality can be restored only by another append-only assertion",
      String(finality3.supersedes_qualification_id) === String(finality2.qualification_id));
    const oldReceiptStillHidden = await captured(receipts.loadReceiptForProperty(db, {
      receiptId: receiptA.receipt.receipt_id,
      propertyId: propertyA,
    }));
    ok("new finality does not resurrect a receipt built under old finality",
      oldReceiptStillHidden && oldReceiptStillHidden.code === "receipt_not_found");
    const receiptA2 = await workflow.generateOwnerReceiptFromProviderMeeting({
      db,
      extractor,
      providerMeetingId,
      propertyId: propertyA,
      initiatedByUserId: actor,
    });
    ok("restored finality requires and permits a fresh property A receipt",
      !!receiptA2.receipt.receipt_id
      && (await receipts.loadReceiptForProperty(db, {
        receiptId: receiptA2.receipt.receipt_id,
        propertyId: propertyA,
      })).receipt.receipt_id === receiptA2.receipt.receipt_id);

    const weakCorrection = await captured(evidence.correctProviderMeetingBinding(db, {
      providerMeetingId,
      currentPropertyId: propertyA,
      replacementPropertyId: propertyB,
      correctedByUserId: limitedActor,
      correctionReason: "limited actor attack",
    }));
    ok("actor without authority at both properties cannot rebind",
      weakCorrection && weakCorrection.code === "binding_correction_authority_required");

    const correctedBinding = await evidence.correctProviderMeetingBinding(db, {
      providerMeetingId,
      currentPropertyId: propertyA,
      replacementPropertyId: propertyB,
      correctedByUserId: actor,
      correctionReason: "meeting belonged to proof property B",
    });
    ok("authorized correction appends property B as successor",
      String(correctedBinding.supersedes_binding_id) === String(initialBinding.id));
    const bindingCounts = (await client.query(
      `select (select count(*) from meeting_property_bindings where provider_meeting_id=$1)::int as history,
              (select count(*) from meeting_property_current_bindings where provider_meeting_id=$1)::int as current_count,
              (select property_id from meeting_property_current_bindings where provider_meeting_id=$1) as current_property`,
      [providerMeetingId]
    )).rows[0];
    ok("binding correction preserves both history rows", bindingCounts.history === 2);
    ok("binding correction leaves exactly one current head at B",
      bindingCounts.current_count === 1 && String(bindingCounts.current_property) === propertyB);

    const bindingFork = await databaseRefusal(client, "binding_fork", () => client.query(
      `insert into meeting_property_bindings
         (provider_meeting_id, property_id, bound_by_user_id, binding_basis,
          binding_kind, correction_reason, supersedes_binding_id)
       values ($1,$2,$3,'hostile fork','correction','fork attempt',$4)`,
      [providerMeetingId, propertyB, actor, initialBinding.id]
    ));
    ok("database refuses a fork from an old binding head", !!bindingFork);
    ok("property A immediately loses current meeting visibility",
      await evidence.readBoundProviderMeeting(db, { providerMeetingId, propertyId: propertyA }) === null);
    ok("property B gains current meeting visibility",
      !!(await evidence.readBoundProviderMeeting(db, { providerMeetingId, propertyId: propertyB })));

    const oldAtA = await captured(receipts.loadReceiptForProperty(db, {
      receiptId: receiptA.receipt.receipt_id,
      propertyId: propertyA,
    }));
    const oldAtB = await captured(receipts.loadReceiptForProperty(db, {
      receiptId: receiptA.receipt.receipt_id,
      propertyId: propertyB,
    }));
    ok("old property receipt disappears after correction", oldAtA && oldAtA.code === "receipt_not_found");
    ok("old interpretation does not silently leak into replacement property",
      oldAtB && oldAtB.code === "receipt_not_found");
    const refreshedAAfterBinding = await captured(receipts.loadReceiptForProperty(db, {
      receiptId: receiptA2.receipt.receipt_id,
      propertyId: propertyA,
    }));
    ok("binding correction also hides the refreshed A interpretation",
      refreshedAAfterBinding && refreshedAAfterBinding.code === "receipt_not_found");

    const receiptB = await workflow.generateOwnerReceiptFromProviderMeeting({
      db,
      extractor,
      providerMeetingId,
      propertyId: propertyB,
      initiatedByUserId: actor,
    });
    ok("replacement property creates a fresh governed receipt", !!receiptB.receipt.receipt_id);
    ok("fresh property B receipt is visible at B",
      (await receipts.loadReceiptForProperty(db, {
        receiptId: receiptB.receipt.receipt_id,
        propertyId: propertyB,
      })).receipt.receipt_id === receiptB.receipt.receipt_id);
    const sourceLinks = (await client.query(
      `select count(*)::int as count,
              count(distinct transcript_version_id)::int as versions
         from meeting_transcript_provider_sources
        where provider_delivery_id=$1`,
      [deliveryId]
    )).rows[0];
    ok("one exact delivery can support separate property-scoped transcript lineage",
      sourceLinks.count === 3 && sourceLinks.versions === 2);
    await client.query("set constraints all immediate");
    await client.query("set constraints all deferred");

    const beforeRejected = (await client.query(
      `select (select count(*) from meeting_extraction_runs)::int as runs,
              (select count(*) from meeting_receipts)::int as receipts`
    )).rows[0];
    const invalidOutput = validOutput();
    invalidOutput.candidates[0].quotes[0].quote_text_exact = "cleaned words not in transcript";
    const invalidExtractor = async () => invalidOutput;
    invalidExtractor.provider = "proof-extractor";
    invalidExtractor.model = "proof-invalid";
    const rejected = await captured(workflow.generateOwnerReceiptFromProviderMeeting({
      db,
      extractor: invalidExtractor,
      providerMeetingId,
      propertyId: propertyB,
      initiatedByUserId: actor,
    }));
    ok("validator rejection returns the exact hostile error",
      rejected && rejected.code === "extractor_quote_not_exact");
    const rejectedOutcome = (await client.query(
      `select o.outcome_status, o.failure_code, o.structured_output_sha256
         from meeting_extraction_attempt_outcomes o
         join meeting_extraction_attempts a using (extraction_attempt_id)
        where a.model_version='proof-invalid'`
    )).rows[0];
    ok("validator rejection persists structured output and terminal reason",
      rejectedOutcome.outcome_status === "rejected"
      && rejectedOutcome.failure_code === "extractor_quote_not_exact"
      && /^[0-9a-f]{64}$/.test(rejectedOutcome.structured_output_sha256));
    const afterRejected = (await client.query(
      `select (select count(*) from meeting_extraction_runs)::int as runs,
              (select count(*) from meeting_receipts)::int as receipts`
    )).rows[0];
    ok("validator rejection creates no extraction run", afterRejected.runs === beforeRejected.runs);
    ok("validator rejection creates no receipt", afterRejected.receipts === beforeRejected.receipts);

    const failedExtractor = async () => { throw new Error("secret provider failure detail"); };
    failedExtractor.provider = "proof-extractor";
    failedExtractor.model = "proof-provider-failure";
    const providerFailure = await captured(workflow.generateOwnerReceiptFromProviderMeeting({
      db,
      extractor: failedExtractor,
      providerMeetingId,
      propertyId: propertyB,
      initiatedByUserId: actor,
    }));
    ok("provider failure returns failure without manufacturing output", !!providerFailure);
    const failedOutcome = (await client.query(
      `select o.outcome_status, o.failure_code, o.structured_output
         from meeting_extraction_attempt_outcomes o
         join meeting_extraction_attempts a using (extraction_attempt_id)
        where a.model_version='proof-provider-failure'`
    )).rows[0];
    ok("provider failure is durably classified without raw secret detail",
      failedOutcome.outcome_status === "provider_failed"
      && failedOutcome.failure_code === "meeting_receipt_model_request_failed"
      && failedOutcome.structured_output === null);
    const noFailedRun = (await client.query(
      `select count(*)::int as count
         from meeting_extraction_runs r
         join meeting_extraction_attempts a
           on a.extraction_attempt_id=r.extraction_attempt_id
        where a.model_version='proof-provider-failure'`
    )).rows[0].count;
    ok("provider failure creates no accepted extraction run", noFailedRun === 0);

    const sourceB = receiptB.transcript.provider_source_link_id;
    const orphanRefusal = await databaseRefusal(client, "orphan_run", async () => {
      const orphanAttempt = await receipts.openExtractionAttempt(db, {
        meetingId: receiptB.meeting.meeting_id,
        transcriptVersionId: receiptB.transcript.transcript_version_id,
        transcriptSourceLinkId: sourceB,
        model: "proof-extractor",
        modelVersion: "proof-orphan",
        promptSha256: "1".repeat(64),
        outputSchemaSha256: "2".repeat(64),
        requestInputSha256: "3".repeat(64),
        initiatedByUserId: actor,
      });
      await client.query(
        `insert into meeting_extraction_runs
           (extraction_attempt_id, meeting_id, transcript_version_id, model,
            model_version, extractor_contract_revision, prompt_revision,
            extraction_coverage, initiated_by_user_id)
         values ($1,$2,$3,'proof-extractor','proof-orphan',
                 'meeting-receipt-v0-r4','meeting-receipt-extractor-v0','full',$4)`,
        [orphanAttempt.extraction_attempt_id, receiptB.meeting.meeting_id,
         receiptB.transcript.transcript_version_id, actor]
      );
      await client.query("set constraints trg_meeting_extraction_run_requires_outcome immediate");
    });
    ok("database refuses an extraction run without accepted terminal outcome", !!orphanRefusal);
    await client.query("set constraints all deferred");

    const bindingMutation = await databaseRefusal(client, "binding_mutation", () => client.query(
      `update meeting_property_bindings set correction_reason='rewrite' where id=$1`,
      [correctedBinding.id]
    ));
    ok("binding history is append-only against update", bindingMutation && bindingMutation.code === "23001");
    const attemptMutation = await databaseRefusal(client, "attempt_mutation", () => client.query(
      `delete from meeting_extraction_attempts where extraction_attempt_id=$1`,
      [receiptB.extraction_attempt.extraction_attempt_id]
    ));
    ok("extraction attempt history is append-only against delete", attemptMutation && attemptMutation.code === "23001");

    const canonicalAfter = (await client.query(
      `select (select count(*) from work_orders)::int as work_orders,
              (select count(*) from obligations)::int as obligations,
              (select count(*) from leases)::int as leases`
    )).rows[0];
    ok("meeting workflow writes no canonical operating domains",
      JSON.stringify(canonicalAfter) === JSON.stringify(canonicalBefore));

    await client.query("rollback");
  } catch (error) {
    try { await client.query("rollback"); } catch (_) {}
    throw error;
  } finally {
    client.release();
    await pool.end();
  }

  process.exitCode = receipt.complete({
    harness: HARNESS,
    passed,
    failed,
    expectedAtLeast: EXPECTED,
  });
})().catch((error) => {
  if (error && (error.code || error.detail)) {
    console.error("    Database detail:", error.code || "(no code)", error.detail || "(no detail)");
  }
  receipt.died(HARNESS, error, ran);
  process.exitCode = 1;
});
