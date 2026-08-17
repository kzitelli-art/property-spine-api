"use strict";

const evidenceService = require("./meeting_evidence_service");
const receiptService = require("./meeting_receipt_service");
const release = require("./meeting_receipt_release_readiness");
const { runMeetingReceiptExtractor } = require("./meeting_receipt_extractor_runner");

function workflowError(httpStatus, code, message, detail = null) {
  const error = new Error(message);
  error.httpStatus = httpStatus;
  error.code = code;
  error.detail = detail;
  return error;
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
  });
  const property = (await db.query(
    `select coalesce(display_name, name) as property_name from properties where id = $1`,
    [propertyId]
  )).rows[0];
  const speakerPeople = await receipts.loadPropertyPeople(db, { propertyId });
  if (intendedRecipientPersonId && !speakerPeople.some((person) =>
    String(person.person_id) === String(intendedRecipientPersonId))) {
    throw workflowError(403, "receipt_recipient_out_of_scope",
      "The intended receipt recipient is not an active person for this property");
  }
  const recordMeeting = {
    ...meeting,
    property_name: property ? property.property_name : "Property",
  };

  const extracted = await runMeetingReceiptExtractor({
    extractor,
    meeting: recordMeeting,
    transcriptVersion: ingested.version,
    segments: ingested.segments,
    model: extractor.provider || "meeting-receipt-extractor",
    modelVersion: extractor.model || "unknown",
    speakerPeople,
  });
  const persisted = await receipts.persistExtractionAndReceipt(db, extracted.record, {
    initiatedByUserId,
    createdByUserId: initiatedByUserId,
    intendedRecipientPersonId,
    supersedesReceiptId: priorReceipt ? priorReceipt.receipt_id : null,
  });

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
    },
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
