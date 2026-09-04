"use strict";

const evidenceService = require("./meeting_evidence_service");
const receiptService = require("./meeting_receipt_service");
const release = require("./meeting_receipt_release_readiness");
const contract = require("./meeting_receipt_contract");
const {
  compileExtractorOutput,
  prepareMeetingReceiptExtraction,
} = require("./meeting_receipt_extractor_runner");

function workflowError(httpStatus, code, message, detail = null) {
  const error = new Error(message);
  error.httpStatus = httpStatus;
  error.code = code;
  error.detail = detail;
  return error;
}

async function preserveOutcome(db, receipts, outcome, originalError) {
  try {
    await receipts.recordExtractionAttemptOutcome(db, outcome);
  } catch (outcomeError) {
    if (originalError && typeof originalError === "object") {
      originalError.outcomePersistenceError = outcomeError && outcomeError.code
        ? outcomeError.code
        : "meeting_receipt_outcome_persistence_failed";
    }
  }
}

async function assertMeetingReceiptReady(db) {
  const row = (await db.query(release.releaseReadinessSql())).rows[0];
  const readiness = release.evaluateReleaseReadiness(row);
  if (!readiness.ok) {
    throw workflowError(503, "meeting_receipt_schema_not_ready", "Meeting Receipt is locked until its governed schema is applied", readiness);
  }
  return readiness;
}

async function generateOwnerReceiptFromProviderMeeting({
  db,
  extractor,
  providerMeetingId,
  propertyId,
  initiatedByUserId,
  intendedRecipientPersonId = null,
  acknowledgePriorReview = false,
  evidence = evidenceService,
  receipts = receiptService,
} = {}) {
  if (!db) throw workflowError(500, "meeting_receipt_db_required", "Meeting Receipt workflow requires a database");
  if (typeof extractor !== "function") {
    throw workflowError(503, "meeting_receipt_model_unavailable", "Meeting Receipt extraction model is not configured");
  }

  const readiness = await assertMeetingReceiptReady(db);
  const source = await evidence.readBoundProviderTranscript(db, { providerMeetingId, propertyId });
  //  THE REFUSAL BEFORE THE WRITES. The recipient-scope check used to run
  //  after the canonical meeting and a transcript version were committed,
  //  so a 403 left durable rows behind it. Nothing below needs those rows
  //  to answer this question.
  const speakerPeople = await receipts.loadPropertyPeople(db, { propertyId });
  if (intendedRecipientPersonId && !speakerPeople.some((person) =>
    String(person.person_id) === String(intendedRecipientPersonId))) {
    throw workflowError(403, "receipt_recipient_out_of_scope",
      "The intended receipt recipient is not an active person for this property");
  }
  const meeting = await receipts.ensureCanonicalMeeting(db, {
    providerMeetingId,
    propertyId,
    meetingOccurredAt: source.meeting_occurred_at,
    occurredAtSource: source.occurred_at_source,
    boundByUserId: initiatedByUserId,
  });
  const priorReceipt = await receipts.latestReceiptForMeeting(db, { meetingId: meeting.meeting_id });
  const reissue = await receipts.reissueGate(db, { meetingId: meeting.meeting_id });
  if (!reissue.ok_to_auto_reissue && acknowledgePriorReview !== true) {
    throw workflowError(409, "meeting_receipt_prior_review_requires_acknowledgement",
      "A prior human correction exists; explicitly acknowledge it before generating a new receipt", reissue);
  }

  const ingested = await receipts.ingestTranscriptVersion(db, {
    meetingId: meeting.meeting_id,
    transcriptText: source.transcript_text,
    sourceKind: source.source_kind,
    providerDeliveryId: source.provider_delivery_id,
    providerDeliveryQualificationId: source.provider_delivery_qualification_id,
    linkedByUserId: initiatedByUserId,
  });
  const property = (await db.query(
    `select coalesce(display_name, name) as property_name from properties where id = $1`,
    [propertyId]
  )).rows[0];
  const recordMeeting = {
    ...meeting,
    property_name: property ? property.property_name : "Property",
  };
  const model = extractor.provider || "meeting-receipt-extractor";
  const modelVersion = extractor.model || "unknown";
  const prepared = prepareMeetingReceiptExtraction({
    meeting: recordMeeting,
    transcriptVersion: ingested.version,
    segments: ingested.segments,
    speakerPeople,
  });
  const attempt = await receipts.openExtractionAttempt(db, {
    meetingId: meeting.meeting_id,
    transcriptVersionId: ingested.version.transcript_version_id,
    transcriptSourceLinkId: ingested.provider_source.source_link_id,
    model,
    modelVersion,
    extractorContractRevision: contract.CONTRACT_REVISION,
    promptRevision: contract.PROMPT_REVISION,
    promptSha256: prepared.prompt_sha256,
    outputSchemaSha256: prepared.output_schema_sha256,
    requestInputSha256: prepared.request_input_sha256,
    initiatedByUserId,
  });

  let rawOutput;
  try {
    rawOutput = await extractor({
      prompt: prepared.prompt,
      schema: prepared.schema,
      input: prepared.input,
    });
  } catch (error) {
    const rejected = error && [
      "meeting_receipt_model_protocol_rejected",
      "meeting_receipt_model_output_missing",
    ].includes(error.code);
    await preserveOutcome(db, receipts, {
      extractionAttemptId: attempt.extraction_attempt_id,
      outcomeStatus: rejected ? "rejected" : "provider_failed",
      failureCode: (error && error.code) || "meeting_receipt_model_request_failed",
      validationErrors: rejected ? error.detail : [],
    }, error);
    throw error;
  }

  let extracted;
  try {
    extracted = compileExtractorOutput(rawOutput, {
      meeting: recordMeeting,
      transcriptVersion: ingested.version,
      segments: ingested.segments,
      model,
      modelVersion,
      speakerPeople,
    });
  } catch (error) {
    await preserveOutcome(db, receipts, {
      extractionAttemptId: attempt.extraction_attempt_id,
      outcomeStatus: "rejected",
      structuredOutput: rawOutput,
      failureCode: (error && error.code) || "extractor_output_rejected",
      validationErrors: error && error.detail,
    }, error);
    throw error;
  }

  let persisted;
  try {
    persisted = await receipts.persistExtractionAndReceipt(db, extracted.record, {
      initiatedByUserId,
      createdByUserId: initiatedByUserId,
      intendedRecipientPersonId,
      supersedesReceiptId: priorReceipt ? priorReceipt.receipt_id : null,
      extractionAttemptId: attempt.extraction_attempt_id,
      structuredOutput: rawOutput,
    });
  } catch (error) {
    await preserveOutcome(db, receipts, {
      extractionAttemptId: attempt.extraction_attempt_id,
      outcomeStatus: "persistence_failed",
      structuredOutput: rawOutput,
      failureCode: "meeting_receipt_persistence_failed",
    }, error);
    throw error;
  }

  return {
    readiness,
    meeting: recordMeeting,
    transcript: {
      transcript_version_id: ingested.version.transcript_version_id,
      source_digest: ingested.version.source_digest,
      source_kind: ingested.version.source_kind,
      segment_count: ingested.segments.length,
      deduplicated: ingested.deduplicated,
      provider_delivery_id: source.provider_delivery_id,
      provider_delivery_qualification_id: source.provider_delivery_qualification_id,
      provider_source_link_id: ingested.provider_source.source_link_id,
    },
    extraction_attempt: attempt,
    extraction_outcome: persisted.extraction_outcome,
    extraction: persisted.extraction,
    receipt: persisted.receipt,
    rendered: persisted.rendered,
    reissue,
  };
}

module.exports = {
  assertMeetingReceiptReady,
  generateOwnerReceiptFromProviderMeeting,
  workflowError,
};
