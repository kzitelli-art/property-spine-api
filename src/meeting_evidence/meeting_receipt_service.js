"use strict";

const contract = require("./meeting_receipt_contract");
const { buildTranscriptVersionPayload } = require("./transcript_segments");
const { assertValidRecord } = require("./meeting_receipt_validator");
const { renderOwnerReceipt } = require("./meeting_receipt_renderer");
const { canonicalJson, sha256Text } = require("./meeting_receipt_extractor_runner");

function serviceError(httpStatus, code, message) {
  const e = new Error(message);
  e.httpStatus = httpStatus;
  e.code = code;
  return e;
}

async function withTransaction(db, fn) {
  if (!db || typeof db.connect !== "function" || typeof db.release === "function") return fn(db);
  const client = await db.connect();
  try {
    await client.query("begin");
    const out = await fn(client);
    await client.query("commit");
    return out;
  } catch (err) {
    try { await client.query("rollback"); } catch (_) {}
    throw err;
  } finally {
    client.release();
  }
}

function requireValue(value, code, message) {
  if (value === null || value === undefined || value === "") {
    throw serviceError(400, code, message);
  }
  return value;
}

function assertAllowedValue(list, value, code, message) {
  if (!contract.has(list, value)) throw serviceError(400, code, message);
  return value;
}

async function ensureCanonicalMeeting(db, {
  providerMeetingId,
  propertyId,
  meetingOccurredAt,
  occurredAtSource,
  boundByUserId,
} = {}) {
  requireValue(providerMeetingId, "missing_provider_meeting_id", "provider meeting id is required");
  requireValue(propertyId, "missing_property_id", "property id is required");
  requireValue(meetingOccurredAt, "missing_meeting_occurred_at", "meeting_occurred_at is required");
  requireValue(boundByUserId, "missing_bound_by_user_id", "bound_by_user_id is required");
  assertAllowedValue(contract.OCCURRED_AT_SOURCES, occurredAtSource,
    "unknown_occurred_at_source", "occurred_at_source is not canonical");

  const binding = (await db.query(
    `select provider_meeting_id, property_id, bound_by_user_id, bound_at
       from meeting_property_current_bindings
      where provider_meeting_id = $1 and property_id = $2`,
    [providerMeetingId, propertyId]
  )).rows[0];
  if (!binding) {
    throw serviceError(409, "provider_meeting_not_bound", "canonical meeting requires an existing governed property binding");
  }

  const inserted = (await db.query(
    `insert into meeting_evidence_meetings
       (provider_meeting_id, property_id, meeting_occurred_at, occurred_at_source,
        bound_by_user_id, bound_at)
     values ($1,$2,$3,$4,$5,$6)
     on conflict (provider_meeting_id, property_id) do nothing
     returning meeting_id, provider_meeting_id, property_id, meeting_occurred_at,
               occurred_at_source, bound_by_user_id, bound_at, created_at`,
    [providerMeetingId, propertyId, meetingOccurredAt, occurredAtSource,
     binding.bound_by_user_id, binding.bound_at]
  )).rows[0];
  if (inserted) return { ...inserted, deduplicated: false };

  const existing = (await db.query(
    `select meeting_id, provider_meeting_id, property_id, meeting_occurred_at,
            occurred_at_source, bound_by_user_id, bound_at, created_at
       from meeting_evidence_meetings
      where provider_meeting_id = $1 and property_id = $2`,
    [providerMeetingId, propertyId]
  )).rows[0];
  return { ...existing, deduplicated: true };
}

async function ingestTranscriptVersion(db, {
  meetingId,
  transcriptText,
  sourceKind = "provider_transcript",
  supersedesVersionId = null,
  lineageMap = null,
  providerDeliveryId = null,
  providerDeliveryQualificationId = null,
  linkedByUserId = null,
} = {}) {
  requireValue(meetingId, "missing_meeting_id", "meeting id is required");
  const payload = buildTranscriptVersionPayload(requireValue(transcriptText, "missing_transcript_text", "transcript text is required"), {
    sourceKind,
  });
  if (!payload.segments.length) {
    throw serviceError(400, "no_transcript_segments", "transcript text produced no addressable segments");
  }
  const providerSourceRequested = providerDeliveryId || providerDeliveryQualificationId || linkedByUserId;
  if (payload.source_kind === "read_ai_webhook_transcript" || providerSourceRequested) {
    requireValue(providerDeliveryId, "missing_provider_delivery_id", "provider delivery id is required for a provider transcript");
    requireValue(providerDeliveryQualificationId, "missing_provider_delivery_qualification_id",
      "provider delivery qualification id is required for a provider transcript");
    requireValue(linkedByUserId, "missing_transcript_source_linker", "linked_by_user_id is required for a provider transcript");
  }

  return withTransaction(db, async (client) => {
    const inserted = (await client.query(
      `insert into transcript_versions
         (meeting_id, source_digest, source_kind, supersedes_version_id, lineage_map)
       values ($1,$2,$3,$4,$5)
       on conflict (meeting_id, source_digest) do nothing
       returning transcript_version_id, meeting_id, source_digest, source_kind,
                 created_at, supersedes_version_id, lineage_map`,
      [meetingId, payload.source_digest, payload.source_kind, supersedesVersionId, lineageMap]
    )).rows[0];

    const version = inserted || (await client.query(
      `select transcript_version_id, meeting_id, source_digest, source_kind,
              created_at, supersedes_version_id, lineage_map
         from transcript_versions
        where meeting_id = $1 and source_digest = $2`,
      [meetingId, payload.source_digest]
    )).rows[0];

    if (inserted) {
      for (const segment of payload.segments) {
        await client.query(
          `insert into transcript_segments
             (transcript_version_id, ordinal, provider_timestamp, speaker_label, text, normalized_text)
           values ($1,$2,$3,$4,$5,$6)`,
          [version.transcript_version_id, segment.ordinal, segment.provider_timestamp,
           segment.speaker_label, segment.text, segment.normalized_text]
        );
      }
    }

    const segments = (await client.query(
      `select segment_id, transcript_version_id, ordinal, provider_timestamp,
              speaker_label, text, normalized_text
         from transcript_segments
        where transcript_version_id = $1
        order by ordinal asc`,
      [version.transcript_version_id]
    )).rows;

    let providerSource = null;
    if (providerSourceRequested || payload.source_kind === "read_ai_webhook_transcript") {
      const insertedSource = (await client.query(
        `insert into meeting_transcript_provider_sources
           (transcript_version_id, provider_delivery_id,
            provider_delivery_qualification_id, linked_by_user_id)
         values ($1,$2,$3,$4)
         on conflict (provider_delivery_qualification_id, transcript_version_id) do nothing
         returning source_link_id, transcript_version_id, provider_delivery_id,
                   provider_delivery_qualification_id, linked_by_user_id, linked_at`,
        [version.transcript_version_id, providerDeliveryId,
         providerDeliveryQualificationId, linkedByUserId]
      )).rows[0];
      providerSource = insertedSource || (await client.query(
        `select source_link_id, transcript_version_id, provider_delivery_id,
                provider_delivery_qualification_id, linked_by_user_id, linked_at
           from meeting_transcript_provider_sources
          where provider_delivery_qualification_id = $1
            and transcript_version_id = $2`,
        [providerDeliveryQualificationId, version.transcript_version_id]
      )).rows[0];
      if (!providerSource
          || String(providerSource.transcript_version_id) !== String(version.transcript_version_id)
          || String(providerSource.provider_delivery_qualification_id) !== String(providerDeliveryQualificationId)) {
        throw serviceError(409, "provider_delivery_transcript_lineage_conflict",
          "The exact provider delivery is already linked to different transcript lineage");
      }
    }

    return {
      version,
      segments,
      provider_source: providerSource,
      deduplicated: !inserted,
    };
  });
}

async function createExtractionRun(db, {
  extractionRunId = null,
  extractionAttemptId,
  meetingId,
  transcriptVersionId,
  model,
  modelVersion,
  extractorContractRevision = contract.CONTRACT_REVISION,
  promptRevision = contract.PROMPT_REVISION,
  extractionCoverage = "full",
  coverageNotes = null,
  initiatedByUserId = null,
} = {}) {
  requireValue(meetingId, "missing_meeting_id", "meeting id is required");
  requireValue(extractionAttemptId, "missing_extraction_attempt_id", "extraction attempt id is required");
  requireValue(transcriptVersionId, "missing_transcript_version_id", "transcript version id is required");
  requireValue(model, "missing_model", "model is required");
  requireValue(modelVersion, "missing_model_version", "model version is required");
  assertAllowedValue(contract.EXTRACTION_COVERAGES, extractionCoverage,
    "unknown_extraction_coverage", "extraction coverage is not canonical");

  return (await db.query(
    `insert into meeting_extraction_runs
       (extraction_run_id, extraction_attempt_id, meeting_id, transcript_version_id, model, model_version,
        extractor_contract_revision, prompt_revision, extraction_coverage,
        coverage_notes, initiated_by_user_id)
     values (coalesce($1, gen_random_uuid()), $2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     returning extraction_run_id, extraction_attempt_id, meeting_id, transcript_version_id, model,
               model_version, extractor_contract_revision, prompt_revision,
               extraction_coverage, coverage_notes, initiated_by_user_id, extracted_at`,
    [extractionRunId, extractionAttemptId, meetingId, transcriptVersionId, model, modelVersion, extractorContractRevision,
     promptRevision, extractionCoverage, coverageNotes, initiatedByUserId]
  )).rows[0];
}

async function openExtractionAttempt(db, {
  meetingId,
  transcriptVersionId,
  transcriptSourceLinkId,
  model,
  modelVersion,
  extractorContractRevision = contract.CONTRACT_REVISION,
  promptRevision = contract.PROMPT_REVISION,
  promptSha256,
  outputSchemaSha256,
  requestInputSha256,
  initiatedByUserId,
} = {}) {
  requireValue(meetingId, "missing_meeting_id", "meeting id is required");
  requireValue(transcriptVersionId, "missing_transcript_version_id", "transcript version id is required");
  requireValue(transcriptSourceLinkId, "missing_transcript_source_link_id", "transcript source link id is required");
  requireValue(model, "missing_model", "model is required");
  requireValue(modelVersion, "missing_model_version", "model version is required");
  requireValue(promptSha256, "missing_prompt_sha256", "prompt digest is required");
  requireValue(outputSchemaSha256, "missing_output_schema_sha256", "output schema digest is required");
  requireValue(requestInputSha256, "missing_request_input_sha256", "request input digest is required");
  requireValue(initiatedByUserId, "missing_initiated_by_user_id", "initiating user is required");

  return (await db.query(
    `insert into meeting_extraction_attempts
       (meeting_id, transcript_version_id, transcript_source_link_id,
        model, model_version, extractor_contract_revision, prompt_revision,
        prompt_sha256, output_schema_sha256, request_input_sha256,
        initiated_by_user_id)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     returning extraction_attempt_id, meeting_id, transcript_version_id,
               transcript_source_link_id, model, model_version,
               extractor_contract_revision, prompt_revision, prompt_sha256,
               output_schema_sha256, request_input_sha256,
               initiated_by_user_id, started_at`,
    [meetingId, transcriptVersionId, transcriptSourceLinkId, model, modelVersion,
     extractorContractRevision, promptRevision, promptSha256, outputSchemaSha256,
     requestInputSha256, initiatedByUserId]
  )).rows[0];
}

function validationErrorList(detail) {
  if (detail === null || detail === undefined) return [];
  if (Array.isArray(detail)) return detail;
  if (typeof detail === "object") return [detail];
  return [{ detail: String(detail) }];
}

async function recordExtractionAttemptOutcome(db, {
  extractionAttemptId,
  outcomeStatus,
  structuredOutput = null,
  failureCode = null,
  validationErrors = [],
  extractionRunId = null,
} = {}) {
  requireValue(extractionAttemptId, "missing_extraction_attempt_id", "extraction attempt id is required");
  if (!["accepted", "rejected", "provider_failed", "persistence_failed"].includes(outcomeStatus)) {
    throw serviceError(400, "unknown_extraction_outcome", "extraction outcome is not canonical");
  }
  const outputDigest = structuredOutput === null ? null : sha256Text(canonicalJson(structuredOutput));
  return (await db.query(
    `insert into meeting_extraction_attempt_outcomes
       (extraction_attempt_id, outcome_status, structured_output,
        structured_output_sha256, failure_code, validation_errors,
        extraction_run_id)
     values ($1,$2,$3,$4,$5,$6,$7)
     on conflict (extraction_attempt_id) do nothing
     returning extraction_outcome_id, extraction_attempt_id, outcome_status,
               structured_output_sha256, failure_code, validation_errors,
               extraction_run_id, completed_at`,
    [extractionAttemptId, outcomeStatus, structuredOutput, outputDigest,
     failureCode, JSON.stringify(validationErrorList(validationErrors)), extractionRunId]
  )).rows[0] || null;
}

async function loadPropertyPeople(db, { propertyId } = {}) {
  requireValue(propertyId, "missing_property_id", "property id is required");
  return (await db.query(
    `select distinct person_id, label
       from (
         select p.id as person_id, p.name as label
           from property_team_assignments pta
           join users u on u.id = pta.user_id
           join persons p on p.id = u.person_id
          where pta.property_id = $1
            and pta.active = true
            and u.is_active = true
            and u.status = 'active'
         union
         select p.id as person_id, p.name as label
           from assignments a
           join persons p on p.id = a.person_id
          where a.property_id = $1 and a.is_active = true
       ) scoped_people
      where label is not null and length(btrim(label)) > 0
      order by label asc, person_id asc`,
    [propertyId]
  )).rows;
}

async function persistSpeakerResolutions(db, {
  transcriptVersionId,
  resolutions = [],
} = {}) {
  requireValue(transcriptVersionId, "missing_transcript_version_id", "transcript version id is required");
  const out = [];
  for (const resolution of resolutions) {
    assertAllowedValue(contract.RESOLUTION_STATUSES, resolution.resolution_status,
      "unknown_resolution_status", "speaker resolution status is not canonical");
    requireValue(resolution.speaker_label, "missing_speaker_label", "speaker label is required");
    requireValue(resolution.resolution_basis, "missing_resolution_basis", "resolution basis is required");
    if (resolution.resolution_status !== "unresolved" && !resolution.resolved_person_id) {
      throw serviceError(400, "resolved_person_required", "probable or confirmed speaker resolution requires a server-resolved person");
    }
    if (resolution.resolution_status === "unresolved" && resolution.resolved_person_id) {
      throw serviceError(400, "unresolved_person_forbidden", "unresolved speaker resolution cannot carry a person");
    }
    out.push((await db.query(
      `insert into meeting_speaker_resolutions
         (transcript_version_id, speaker_label, resolved_person_id,
          resolution_status, resolution_basis, resolved_by_user_id)
       values ($1,$2,$3,$4,$5,null)
       returning resolution_id, transcript_version_id, speaker_label,
                 resolved_person_id, resolution_status, resolution_basis,
                 resolved_by_user_id, created_at, supersedes_resolution_id`,
      [transcriptVersionId, resolution.speaker_label, resolution.resolved_person_id || null,
       resolution.resolution_status, resolution.resolution_basis]
    )).rows[0]);
  }
  return out;
}

async function persistCandidates(db, {
  meetingId,
  extractionRunId,
  candidates = [],
} = {}) {
  requireValue(meetingId, "missing_meeting_id", "meeting id is required");
  requireValue(extractionRunId, "missing_extraction_run_id", "extraction run id is required");

  return withTransaction(db, async (client) => {
    const out = [];
    for (const candidate of candidates) {
      assertAllowedValue(contract.CANDIDATE_TYPES, candidate.candidate_type,
        "unknown_candidate_type", "candidate type is not canonical");
      assertAllowedValue(contract.SOURCE_CLASSES, candidate.source_class,
        "unknown_source_class", "source class is not canonical");
      assertAllowedValue(contract.EPISTEMIC_STATUSES, candidate.epistemic_status,
        "unknown_epistemic_status", "epistemic status is not canonical");

      const row = (await client.query(
        `insert into meeting_interpretation_candidates
           (candidate_id, meeting_id, extraction_run_id, candidate_type, subject, summary,
            source_class, epistemic_status, owner_status, owner_label, owner_person_id,
            owner_resolution_status, relevant_time, material_qualifiers, material,
            personal, supersedes_candidate_id)
         values (coalesce($1, gen_random_uuid()), $2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
         returning candidate_id, meeting_id, extraction_run_id, candidate_type, subject,
                   summary, source_class, epistemic_status, owner_status, owner_label,
                   owner_person_id, owner_resolution_status, relevant_time,
                   material_qualifiers, material, personal, supersedes_candidate_id, created_at`,
        [candidate.candidate_id || null, meetingId, extractionRunId, candidate.candidate_type,
         candidate.subject, candidate.summary, candidate.source_class,
         candidate.epistemic_status, candidate.owner_status || "none",
         candidate.owner_label || null, candidate.owner_person_id || null,
         candidate.owner_resolution_status || null, candidate.relevant_time || null,
         JSON.stringify(candidate.material_qualifiers || []),
         candidate.material !== false, candidate.personal === true,
         candidate.supersedes_candidate_id || null]
      )).rows[0];

      for (const support of candidate.support || []) {
        await client.query(
          `insert into candidate_support (candidate_id, segment_id, support_role)
           values ($1,$2,$3)`,
          [row.candidate_id, support.segment_id, support.support_role]
        );
      }
      for (const quote of candidate.quotes || []) {
        await client.query(
          `insert into candidate_quotes
             (candidate_id, segment_id, speaker_label, char_start, char_end)
           values ($1,$2,$3,$4,$5)`,
          [row.candidate_id, quote.segment_id, quote.speaker_label,
           quote.char_start, quote.char_end]
        );
      }
      for (const branch of candidate.branches || []) {
        await client.query(
          `insert into candidate_branches
             (candidate_id, condition_summary, outcome_summary, supporting_segment_id, ordinal)
           values ($1,$2,$3,$4,$5)`,
          [row.candidate_id, branch.condition_summary, branch.outcome_summary,
           branch.supporting_segment_id, branch.ordinal]
        );
      }
      for (const measurement of candidate.measurements || []) {
        await client.query(
          `insert into candidate_measurements
             (candidate_id, measurement_label, value, unit, as_of, stated_by_segment_id, qualifiers)
           values ($1,$2,$3,$4,$5,$6,$7)`,
          [row.candidate_id, measurement.measurement_label, measurement.value,
           measurement.unit, measurement.as_of || null, measurement.stated_by_segment_id,
           JSON.stringify(measurement.qualifiers || [])]
        );
      }
      out.push(row);
    }
    return out;
  });
}

async function insertReceiptDraft(db, record, {
  createdByUserId,
  intendedRecipientPersonId = null,
  supersedesReceiptId = null,
  receiptGrammarRevision = contract.OWNER_GRAMMAR_REVISION,
} = {}) {
  requireValue(createdByUserId, "missing_created_by_user_id", "created_by_user_id is required");
  assertValidRecord(record, { forReceipt: true });
  const rendered = renderOwnerReceipt(record, { receiptGrammarRevision });
  if (!rendered.ok) {
    throw serviceError(409, "receipt_blocked", "receipt failed validation before persistence");
  }

  return withTransaction(db, async (client) => {
    const receipt = (await client.query(
      `insert into meeting_receipts
         (meeting_id, extraction_run_id, audience_type, intended_recipient_person_id,
          receipt_grammar_revision, rendered_subject, rendered_body, rendered_digest,
          generation_status, created_by_user_id, supersedes_receipt_id)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       returning receipt_id, meeting_id, extraction_run_id, audience_type,
                 intended_recipient_person_id, receipt_grammar_revision,
                 rendered_subject, rendered_body, rendered_digest, generation_status,
                 created_by_user_id, created_at, manually_marked_sent_by_user_id,
                 manually_marked_sent_at, sent_channel_note, supersedes_receipt_id`,
      [record.meeting.meeting_id, record.run.extraction_run_id, rendered.audience_type,
       intendedRecipientPersonId, rendered.receipt_grammar_revision,
       rendered.rendered_subject, rendered.rendered_body, rendered.rendered_digest,
       rendered.generation_status, createdByUserId, supersedesReceiptId]
    )).rows[0];

    for (const item of rendered.items) {
      await client.query(
        `insert into meeting_receipt_items (receipt_id, candidate_id, section, ordinal)
         values ($1,$2,$3,$4)`,
        [receipt.receipt_id, item.candidate_id, item.section, item.ordinal]
      );
    }

    return { receipt, rendered };
  });
}

async function persistExtractionResult(db, record, {
  initiatedByUserId = null,
  extractionAttemptId,
} = {}) {
  assertValidRecord(record, { forReceipt: true });
  const run = record.run || {};
  requireValue(run.extraction_run_id, "missing_extraction_run_id", "extraction_run_id is required");

  return withTransaction(db, async (client) => {
    const insertedRun = await createExtractionRun(client, {
      extractionRunId: run.extraction_run_id,
      extractionAttemptId,
      meetingId: record.meeting.meeting_id,
      transcriptVersionId: run.transcript_version_id || record.transcript_version_id,
      model: run.model,
      modelVersion: run.model_version,
      extractorContractRevision: run.extractor_contract_revision,
      promptRevision: run.prompt_revision,
      extractionCoverage: run.extraction_coverage,
      coverageNotes: run.coverage_notes || null,
      initiatedByUserId: run.initiated_by_user_id || initiatedByUserId,
    });
    const candidates = await persistCandidates(client, {
      meetingId: record.meeting.meeting_id,
      extractionRunId: insertedRun.extraction_run_id,
      candidates: record.candidates,
    });
    const speakerResolutions = await persistSpeakerResolutions(client, {
      transcriptVersionId: run.transcript_version_id || record.transcript_version_id,
      resolutions: record.speaker_resolutions,
    });
    return {
      run: insertedRun,
      candidates,
      speaker_resolutions: speakerResolutions,
    };
  });
}

async function persistExtractionAndReceipt(db, record, {
  initiatedByUserId = null,
  createdByUserId,
  intendedRecipientPersonId = null,
  supersedesReceiptId = null,
  extractionAttemptId,
  structuredOutput,
} = {}) {
  requireValue(createdByUserId, "missing_created_by_user_id", "created_by_user_id is required");
  requireValue(extractionAttemptId, "missing_extraction_attempt_id", "extraction attempt id is required");
  requireValue(structuredOutput, "missing_structured_output", "structured model output is required");
  assertValidRecord(record, { forReceipt: true });
  return withTransaction(db, async (client) => {
    const extraction = await persistExtractionResult(client, record, {
      initiatedByUserId,
      extractionAttemptId,
    });
    const draft = await insertReceiptDraft(client, record, {
      createdByUserId,
      intendedRecipientPersonId,
      supersedesReceiptId,
    });
    const outcome = await recordExtractionAttemptOutcome(client, {
      extractionAttemptId,
      outcomeStatus: "accepted",
      structuredOutput,
      extractionRunId: extraction.run.extraction_run_id,
    });
    if (!outcome) {
      throw serviceError(409, "extraction_attempt_already_completed",
        "The extraction attempt already has a terminal outcome");
    }
    return { extraction, extraction_outcome: outcome, ...draft };
  });
}

async function loadReceiptForProperty(db, { receiptId, propertyId } = {}) {
  requireValue(receiptId, "missing_receipt_id", "receipt id is required");
  requireValue(propertyId, "missing_property_id", "property id is required");
  const receipt = (await db.query(
    `select r.receipt_id, r.meeting_id, r.extraction_run_id, r.audience_type,
            r.intended_recipient_person_id, r.receipt_grammar_revision,
            r.rendered_subject, r.rendered_body, r.rendered_digest,
            r.generation_status, r.created_by_user_id, r.created_at,
            r.manually_marked_sent_by_user_id, r.manually_marked_sent_at,
            r.sent_channel_note, r.supersedes_receipt_id
       from meeting_receipts r
       join meeting_evidence_meetings m on m.meeting_id = r.meeting_id
       join meeting_extraction_runs run on run.extraction_run_id = r.extraction_run_id
       join meeting_extraction_attempts attempt
         on attempt.extraction_attempt_id = run.extraction_attempt_id
       join meeting_transcript_provider_sources source
         on source.source_link_id = attempt.transcript_source_link_id
       join meeting_provider_delivery_current_qualifications finality
         on finality.qualification_id = source.provider_delivery_qualification_id
        and finality.qualification_status = 'qualified_final'
       join meeting_property_current_bindings b
         on b.provider_meeting_id = m.provider_meeting_id
        and b.property_id = m.property_id
      where r.receipt_id = $1 and m.property_id = $2`,
    [receiptId, propertyId]
  )).rows[0];
  if (!receipt) throw serviceError(404, "receipt_not_found", "No meeting receipt is visible for this property");

  const items = (await db.query(
    `select i.receipt_item_id, i.candidate_id, i.section, i.ordinal,
            c.candidate_type, c.subject, c.summary, c.epistemic_status,
            c.owner_status, c.owner_label, c.owner_resolution_status,
            c.material_qualifiers
       from meeting_receipt_items i
       join meeting_interpretation_candidates c on c.candidate_id = i.candidate_id
      where i.receipt_id = $1
      order by array_position(array[
        'PROPERTY PULSE','YOU DECIDED','RAISED, NOT ANSWERED',
        'NEEDS FOLLOW-UP','WATCHING','ALSO HEARD'
      ]::text[], i.section), i.ordinal`,
    [receiptId]
  )).rows;
  return { receipt, items };
}

async function latestReceiptForMeeting(db, { meetingId } = {}) {
  requireValue(meetingId, "missing_meeting_id", "meeting id is required");
  return (await db.query(
    `select receipt_id, meeting_id, extraction_run_id, created_at
       from meeting_receipts
      where meeting_id = $1
      order by created_at desc, receipt_id desc
      limit 1`,
    [meetingId]
  )).rows[0] || null;
}

async function appendManualEditForReceipt(db, {
  receiptId,
  propertyId,
  editedByUserId,
  editSource = "manual_preview",
  fieldName,
  humanText,
  changeNote = null,
} = {}) {
  const scoped = await loadReceiptForProperty(db, { receiptId, propertyId });
  if (scoped.receipt.manually_marked_sent_at) {
    throw serviceError(409, "receipt_preview_already_sent", "a sent receipt cannot receive another preview edit");
  }
  assertAllowedValue(contract.MANUAL_EDIT_FIELDS, fieldName, "unknown_edit_field", "edit field is not canonical");
  return appendManualEditDelta(db, {
    receiptId,
    editedByUserId,
    editSource,
    fieldName,
    spineText: scoped.receipt[fieldName],
    humanText,
    receiptDigestAtEdit: scoped.receipt.rendered_digest,
    changeNote,
  });
}

async function recordManualSend(db, {
  receiptId,
  propertyId,
  markedByUserId,
  sentSubject = null,
  sentBody = null,
  sentAt = new Date(),
  sentChannelNote = null,
} = {}) {
  return withTransaction(db, async (client) => {
    const scoped = await loadReceiptForProperty(client, { receiptId, propertyId });
    const receipt = scoped.receipt;
    if (receipt.manually_marked_sent_at) {
      const sentCopyRows = (await client.query(
        `select field_name, human_text
           from meeting_receipt_manual_edit_deltas
          where receipt_id = $1 and edit_source = 'sent_copy'
          order by edited_at asc, edit_id asc`,
        [receiptId]
      )).rows;
      const sentCopy = new Map(sentCopyRows.map((row) => [row.field_name, row.human_text]));
      const assertions = [
        ["rendered_subject", sentSubject],
        ["rendered_body", sentBody],
      ];
      for (const [fieldName, assertedText] of assertions) {
        if (assertedText === null || assertedText === undefined) continue;
        const recordedText = sentCopy.has(fieldName) ? sentCopy.get(fieldName) : receipt[fieldName];
        if (String(assertedText) !== String(recordedText)) {
          throw serviceError(409, "receipt_sent_assertion_conflict",
            "receipt is already marked sent with different recorded text");
        }
      }
      return { receipt, edit_deltas: [], deduplicated: true };
    }
    const edits = [];
    const supplied = [
      ["rendered_subject", sentSubject],
      ["rendered_body", sentBody],
    ];
    for (const [fieldName, humanText] of supplied) {
      if (humanText === null || humanText === undefined || String(humanText) === String(receipt[fieldName])) continue;
      edits.push(await appendManualEditDelta(client, {
        receiptId,
        editedByUserId: markedByUserId,
        editSource: "sent_copy",
        fieldName,
        spineText: receipt[fieldName],
        humanText,
        receiptDigestAtEdit: receipt.rendered_digest,
        changeNote: "manual sent copy differed from Spine draft",
      }));
    }
    const sent = await markReceiptSent(client, {
      receiptId,
      markedByUserId,
      sentAt,
      sentChannelNote,
    });
    if (!sent) throw serviceError(409, "receipt_sent_assertion_conflict", "receipt could not be marked sent");
    return { receipt: sent, edit_deltas: edits, deduplicated: false };
  });
}

async function markReceiptSent(db, {
  receiptId,
  markedByUserId,
  sentAt = new Date(),
  sentChannelNote = null,
} = {}) {
  requireValue(receiptId, "missing_receipt_id", "receipt id is required");
  requireValue(markedByUserId, "missing_marked_by_user_id", "marked_by_user_id is required");
  return (await db.query(
    `update meeting_receipts
        set manually_marked_sent_by_user_id = $2,
            manually_marked_sent_at = $3,
            sent_channel_note = $4
      where receipt_id = $1
        and manually_marked_sent_by_user_id is null
        and manually_marked_sent_at is null
      returning receipt_id, manually_marked_sent_by_user_id,
                manually_marked_sent_at, sent_channel_note`,
    [receiptId, markedByUserId, sentAt, sentChannelNote]
  )).rows[0] || null;
}

async function appendCandidateReview(db, {
  receiptId,
  receiptItemId = null,
  candidateId,
  reviewTarget,
  reviewClass,
  reviewSource,
  reviewSourceId = null,
  reviewerUserId,
  reviewerPersonId = null,
  note = null,
} = {}) {
  requireValue(receiptId, "missing_receipt_id", "receipt id is required");
  requireValue(candidateId, "missing_candidate_id", "candidate id is required");
  requireValue(reviewerUserId, "missing_reviewer_user_id", "reviewer_user_id is required");
  assertAllowedValue(contract.REVIEW_TARGETS, reviewTarget, "unknown_review_target", "review target is not canonical");
  const classList = reviewTarget === "interpretation"
    ? contract.INTERPRETATION_REVIEW_CLASSES
    : contract.PROJECTION_REVIEW_CLASSES;
  assertAllowedValue(classList, reviewClass, "unknown_review_class", "review class is not canonical for its target");
  assertAllowedValue(contract.REVIEW_SOURCES, reviewSource, "unknown_review_source", "review source is not canonical");
  if (reviewTarget === "projection" && reviewClass === "should_have_rendered" && receiptItemId) {
    throw serviceError(400, "should_have_rendered_item_must_be_null", "should_have_rendered targets candidates filtered out of the receipt");
  }

  return (await db.query(
    `insert into meeting_receipt_candidate_reviews
       (receipt_id, receipt_item_id, candidate_id, review_target, review_class,
        review_source, review_source_id, reviewer_user_id, reviewer_person_id, note)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     returning review_id, receipt_id, receipt_item_id, candidate_id, review_target,
               review_class, review_source, review_source_id, reviewer_user_id,
               reviewer_person_id, reviewed_at, note`,
    [receiptId, receiptItemId, candidateId, reviewTarget, reviewClass,
     reviewSource, reviewSourceId, reviewerUserId, reviewerPersonId, note]
  )).rows[0];
}

async function appendMissedItem(db, {
  receiptId,
  description,
  supportingSegmentIds,
  reviewSource,
  reviewSourceId = null,
  reviewerUserId,
  reviewerPersonId = null,
} = {}) {
  requireValue(receiptId, "missing_receipt_id", "receipt id is required");
  requireValue(description, "missing_description", "description is required");
  requireValue(reviewerUserId, "missing_reviewer_user_id", "reviewer_user_id is required");
  if (!Array.isArray(supportingSegmentIds) || !supportingSegmentIds.length) {
    throw serviceError(400, "missing_supporting_segment_ids", "missed items require supporting transcript evidence");
  }
  assertAllowedValue(contract.REVIEW_SOURCES, reviewSource, "unknown_review_source", "review source is not canonical");

  return (await db.query(
    `insert into meeting_receipt_missed_items
       (receipt_id, description, supporting_segment_ids, review_source,
        review_source_id, reviewer_user_id, reviewer_person_id)
     values ($1,$2,$3,$4,$5,$6,$7)
     returning missed_id, receipt_id, description, supporting_segment_ids,
               review_source, review_source_id, reviewer_user_id,
               reviewer_person_id, reviewed_at`,
    [receiptId, description, supportingSegmentIds, reviewSource, reviewSourceId,
     reviewerUserId, reviewerPersonId]
  )).rows[0];
}

async function appendManualEditDelta(db, {
  receiptId,
  editedByUserId,
  editSource,
  fieldName,
  spineText,
  humanText,
  receiptDigestAtEdit,
  changeNote = null,
} = {}) {
  requireValue(receiptId, "missing_receipt_id", "receipt id is required");
  requireValue(editedByUserId, "missing_edited_by_user_id", "edited_by_user_id is required");
  requireValue(spineText, "missing_spine_text", "spine_text is required");
  requireValue(humanText, "missing_human_text", "human_text is required");
  requireValue(receiptDigestAtEdit, "missing_receipt_digest_at_edit", "receipt_digest_at_edit is required");
  assertAllowedValue(contract.MANUAL_EDIT_SOURCES, editSource, "unknown_edit_source", "edit source is not canonical");
  assertAllowedValue(contract.MANUAL_EDIT_FIELDS, fieldName, "unknown_edit_field", "edit field is not canonical");
  if (String(spineText) === String(humanText)) {
    throw serviceError(400, "manual_edit_delta_required", "manual edit delta must record a changed line");
  }

  return (await db.query(
    `insert into meeting_receipt_manual_edit_deltas
       (receipt_id, edited_by_user_id, edit_source, field_name, spine_text,
        human_text, receipt_digest_at_edit, change_note)
     values ($1,$2,$3,$4,$5,$6,$7,$8)
     returning edit_id, receipt_id, edited_by_user_id, edited_at, edit_source,
               field_name, spine_text, human_text, receipt_digest_at_edit, change_note`,
    [receiptId, editedByUserId, editSource, fieldName, spineText,
     humanText, receiptDigestAtEdit, changeNote]
  )).rows[0];
}

async function recordReceiptFeedback(db, feedback = {}) {
  const kind = requireValue(feedback.feedbackKind, "missing_feedback_kind", "feedback kind is required");
  assertAllowedValue(contract.FEEDBACK_KINDS, kind, "unknown_feedback_kind", "feedback kind is not canonical");

  if (kind === "missing") {
    return {
      destination: "meeting_receipt_missed_items",
      row: await appendMissedItem(db, {
        receiptId: feedback.receiptId,
        description: feedback.description,
        supportingSegmentIds: feedback.supportingSegmentIds,
        reviewSource: feedback.reviewSource,
        reviewSourceId: feedback.reviewSourceId || null,
        reviewerUserId: feedback.reviewerUserId,
        reviewerPersonId: feedback.reviewerPersonId || null,
      }),
    };
  }

  const projectionMap = {
    should_not_have_rendered: "not_material",
    wrong_section: "wrong_section",
    should_have_rendered: "should_have_rendered",
  };
  if (projectionMap[kind]) {
    if (kind === "should_have_rendered" && feedback.receiptItemId) {
      throw serviceError(400, "should_have_rendered_item_must_be_null", "should_have_rendered targets candidates filtered out of the receipt");
    }
    return {
      destination: "meeting_receipt_candidate_reviews",
      review_target: "projection",
      row: await appendCandidateReview(db, {
        receiptId: feedback.receiptId,
        receiptItemId: feedback.receiptItemId || null,
        candidateId: feedback.candidateId,
        reviewTarget: "projection",
        reviewClass: projectionMap[kind],
        reviewSource: feedback.reviewSource,
        reviewSourceId: feedback.reviewSourceId || null,
        reviewerUserId: feedback.reviewerUserId,
        reviewerPersonId: feedback.reviewerPersonId || null,
        note: feedback.note || null,
      }),
    };
  }

  const interpretationMap = {
    wrong: "wrong",
    overstated: "overclaimed",
    assigned_wrong_person: "wrong",
  };
  return {
    destination: "meeting_receipt_candidate_reviews",
    review_target: "interpretation",
    row: await appendCandidateReview(db, {
      receiptId: feedback.receiptId,
      receiptItemId: feedback.receiptItemId || null,
      candidateId: feedback.candidateId,
      reviewTarget: "interpretation",
      reviewClass: interpretationMap[kind],
      reviewSource: feedback.reviewSource,
      reviewSourceId: feedback.reviewSourceId || null,
      reviewerUserId: feedback.reviewerUserId,
      reviewerPersonId: feedback.reviewerPersonId || null,
      note: feedback.note || null,
    }),
  };
}

async function reissueGate(db, { meetingId } = {}) {
  requireValue(meetingId, "missing_meeting_id", "meeting id is required");
  const row = (await db.query(
    `select count(*)::int as review_count
       from meeting_receipt_candidate_reviews r
       join meeting_receipts receipt on receipt.receipt_id = r.receipt_id
      where receipt.meeting_id = $1`,
    [meetingId]
  )).rows[0] || { review_count: 0 };
  return {
    ok_to_auto_reissue: row.review_count === 0,
    review_count: row.review_count,
    reason: row.review_count === 0 ? null : "prior_human_review_requires_reissue_review",
  };
}

module.exports = {
  appendCandidateReview,
  appendManualEditForReceipt,
  appendManualEditDelta,
  appendMissedItem,
  createExtractionRun,
  ensureCanonicalMeeting,
  ingestTranscriptVersion,
  insertReceiptDraft,
  latestReceiptForMeeting,
  loadPropertyPeople,
  loadReceiptForProperty,
  markReceiptSent,
  openExtractionAttempt,
  persistExtractionAndReceipt,
  persistExtractionResult,
  persistCandidates,
  persistSpeakerResolutions,
  recordManualSend,
  recordExtractionAttemptOutcome,
  recordReceiptFeedback,
  reissueGate,
  serviceError,
};
