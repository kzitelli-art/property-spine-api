"use strict";

const crypto = require("crypto");
const contract = require("./meeting_receipt_contract");
const { validateRecord } = require("./meeting_receipt_validator");
const { buildExtractorPrompt, EXTRACTOR_OUTPUT_SCHEMA } = require("./meeting_receipt_extractor_prompt");

function extractorError(code, message, detail) {
  const e = new Error(message);
  e.code = code;
  e.detail = detail;
  e.httpStatus = 422;
  return e;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  if (value && typeof value === "object") {
    const keys = Object.keys(value).filter((key) => value[key] !== undefined).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256Text(value) {
  return crypto.createHash("sha256").update(String(value), "utf8").digest("hex");
}

function list(v) {
  return Array.isArray(v) ? v : [];
}

function normalizedLabel(value) {
  return String(value || "").trim().replace(/\s+/g, " ").toLowerCase();
}

function peopleIndex(people) {
  const out = new Map();
  for (const person of list(people)) {
    const key = normalizedLabel(person.label);
    if (!key || !person.person_id) continue;
    if (!out.has(key)) out.set(key, []);
    out.get(key).push(person);
  }
  return out;
}

function resolvePersonLabel(label, status, index, role) {
  if (!contract.has(contract.RESOLUTION_STATUSES, status)) {
    throw extractorError("extractor_resolution_status_unknown", `${role} resolution_status is not canonical`, status);
  }
  if (status === "unresolved") {
    if (label !== null && label !== undefined && String(label).trim()) {
      throw extractorError("extractor_unresolved_label_forbidden", `${role} unresolved identity must not carry resolved_label`, label);
    }
    return null;
  }
  const key = normalizedLabel(label);
  const matches = key ? (index.get(key) || []) : [];
  if (matches.length !== 1) {
    throw extractorError(
      matches.length ? "extractor_person_label_ambiguous" : "extractor_person_label_unresolved",
      `${role} probable or confirmed identity must match exactly one property person label`,
      label
    );
  }
  return matches[0];
}

function stableUuid(...parts) {
  const hash = crypto.createHash("sha256").update(parts.map((p) => String(p || "")).join("\u001f")).digest();
  const bytes = Buffer.from(hash.subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function assertNoForbiddenKeys(value, path = "") {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((child, index) => assertNoForbiddenKeys(child, `${path}[${index}]`));
    return;
  }
  for (const key of Object.keys(value)) {
    const here = path ? `${path}.${key}` : key;
    if (key === "candidate_id" || key === "segment_id" || key === "owner_person_id" ||
        key === "resolved_person_id" || key === "char_start" || key === "char_end" ||
        key === "read_status" || /^confidence($|_|pct|score)/i.test(key)) {
      throw extractorError("extractor_forbidden_key", `extractor output carried forbidden key ${here}`, here);
    }
    assertNoForbiddenKeys(value[key], here);
  }
}

function segmentByOrdinal(segments) {
  const out = new Map();
  for (const segment of list(segments)) out.set(Number(segment.ordinal), segment);
  return out;
}

function segmentForOrdinal(map, ordinal, role) {
  const segment = map.get(Number(ordinal));
  if (!segment) throw extractorError("extractor_segment_missing", `${role} references a missing segment ordinal`, { ordinal, role });
  return segment;
}

function exactQuoteRange(segment, quoteText) {
  const text = String(segment.text || "");
  const q = String(quoteText || "");
  const first = text.indexOf(q);
  if (!q || first < 0) {
    throw extractorError("extractor_quote_not_exact", "quote_text_exact must be an exact substring of the referenced segment", {
      segment_ordinal: segment.ordinal,
      quote_text_exact: q,
    });
  }
  const second = text.indexOf(q, first + Math.max(q.length, 1));
  if (second >= 0) {
    throw extractorError("extractor_quote_ambiguous", "quote_text_exact occurs more than once in the referenced segment", {
      segment_ordinal: segment.ordinal,
      quote_text_exact: q,
    });
  }
  return { char_start: first, char_end: first + q.length };
}

function transcriptContainsLabel(segments, label) {
  const observed = String(label || "");
  return observed && list(segments).some((segment) =>
    String(segment.speaker_label) === observed || String(segment.text || "").includes(observed));
}

function normalizeCandidate(raw, {
  meeting,
  run,
  segmentMap,
  candidateIdByKey,
  personIndex,
}) {
  const key = String(raw.candidate_key || "").trim();
  if (!key) throw extractorError("extractor_candidate_key_required", "candidate_key is required");
  if (!contract.has(contract.CANDIDATE_TYPES, raw.candidate_type)) {
    throw extractorError("extractor_unknown_candidate_type", "candidate_type is not canonical", raw.candidate_type);
  }
  const support = list(raw.support).map((item) => {
    const segment = segmentForOrdinal(segmentMap, item.segment_ordinal, "support");
    return {
      segment_id: segment.segment_id,
      support_role: item.support_role,
    };
  });
  const quotes = list(raw.quotes).map((item) => {
    const segment = segmentForOrdinal(segmentMap, item.segment_ordinal, "quote");
    if (segment.speaker_label !== item.speaker_label) {
      throw extractorError("extractor_quote_speaker_mismatch", "quote speaker must match the referenced segment", {
        segment_ordinal: item.segment_ordinal,
        expected: segment.speaker_label,
        received: item.speaker_label,
      });
    }
    const range = exactQuoteRange(segment, item.quote_text_exact);
    return {
      segment_id: segment.segment_id,
      speaker_label: segment.speaker_label,
      char_start: range.char_start,
      char_end: range.char_end,
    };
  });
  const branches = list(raw.branches).map((item) => {
    const segment = segmentForOrdinal(segmentMap, item.segment_ordinal, "branch");
    return {
      condition_summary: item.condition_summary,
      outcome_summary: item.outcome_summary,
      supporting_segment_id: segment.segment_id,
      ordinal: item.ordinal,
    };
  });
  const measurements = list(raw.measurements).map((item) => {
    const segment = segmentForOrdinal(segmentMap, item.segment_ordinal, "measurement");
    return {
      measurement_label: item.measurement_label,
      value: item.value,
      unit: item.unit,
      as_of: item.as_of || null,
      stated_by_segment_id: segment.segment_id,
      qualifiers: list(item.qualifiers),
    };
  });
  const supersedes = raw.supersedes_candidate_key
    ? candidateIdByKey.get(String(raw.supersedes_candidate_key))
    : null;
  if (raw.supersedes_candidate_key && !supersedes) {
    throw extractorError("extractor_supersession_missing", "supersedes_candidate_key must reference another candidate_key", {
      candidate_key: key,
      supersedes_candidate_key: raw.supersedes_candidate_key,
    });
  }
  const ownerResolutionStatus = raw.owner_resolution_status || null;
  const ownerPerson = ownerResolutionStatus &&
      ownerResolutionStatus !== "unresolved" &&
      raw.owner_status === "named"
    ? resolvePersonLabel(raw.owner_label, ownerResolutionStatus, personIndex, "owner")
    : null;
  return {
    candidate_id: candidateIdByKey.get(key),
    meeting_id: meeting.meeting_id,
    extraction_run_id: run.extraction_run_id,
    candidate_type: raw.candidate_type,
    subject: raw.subject,
    summary: raw.summary,
    source_class: raw.source_class,
    epistemic_status: raw.epistemic_status,
    owner_status: raw.owner_status || "none",
    owner_label: raw.owner_label || null,
    owner_person_id: ownerPerson ? ownerPerson.person_id : null,
    owner_resolution_status: ownerResolutionStatus,
    relevant_time: raw.relevant_time || null,
    material_qualifiers: list(raw.material_qualifiers),
    material: raw.material !== false,
    personal: raw.personal === true,
    supersedes_candidate_id: supersedes,
    support,
    quotes,
    branches,
    measurements,
  };
}

function compileExtractorOutput(output, {
  meeting,
  transcriptVersion,
  segments,
  extractionRunId = null,
  model = "extractor",
  modelVersion = "unknown",
  extractorContractRevision = contract.CONTRACT_REVISION,
  promptRevision = contract.PROMPT_REVISION,
  speakerPeople = [],
} = {}) {
  if (!meeting || !meeting.meeting_id) throw extractorError("missing_meeting", "meeting is required");
  if (!transcriptVersion || !transcriptVersion.transcript_version_id) {
    throw extractorError("missing_transcript_version", "transcriptVersion is required");
  }
  if (!list(segments).length) throw extractorError("missing_segments", "segments are required");
  assertNoForbiddenKeys(output);

  const coverage = output.extraction_coverage || "failed";
  if (!contract.has(contract.EXTRACTION_COVERAGES, coverage)) {
    throw extractorError("extractor_unknown_coverage", "extraction_coverage is not canonical", coverage);
  }
  const run = {
    extraction_run_id: extractionRunId || crypto.randomUUID(),
    meeting_id: meeting.meeting_id,
    transcript_version_id: transcriptVersion.transcript_version_id,
    model,
    model_version: modelVersion,
    extractor_contract_revision: extractorContractRevision,
    prompt_revision: promptRevision,
    extraction_coverage: coverage,
    coverage_notes: output.coverage_notes || null,
  };
  const keys = list(output.candidates).map((candidate) => String(candidate.candidate_key || "").trim());
  if (keys.some((key) => !key)) {
    throw extractorError("extractor_candidate_key_required", "every candidate requires candidate_key");
  }
  if (new Set(keys).size !== keys.length) {
    throw extractorError("extractor_candidate_key_duplicate", "candidate_key values must be unique");
  }
  const keyOrdinal = new Map(keys.map((key, index) => [key, index]));
  list(output.candidates).forEach((candidate, index) => {
    const priorKey = candidate.supersedes_candidate_key && String(candidate.supersedes_candidate_key);
    if (priorKey && keyOrdinal.has(priorKey) && keyOrdinal.get(priorKey) >= index) {
      throw extractorError("extractor_supersession_not_prior",
        "supersedes_candidate_key must reference an earlier candidate in the same output", priorKey);
    }
  });
  const candidateIdByKey = new Map(keys.map((key) => [
    key,
    stableUuid(meeting.meeting_id, run.extraction_run_id, key),
  ]));
  const segmentMap = segmentByOrdinal(segments);
  const personIndex = peopleIndex(speakerPeople);
  const candidates = list(output.candidates).map((candidate) =>
    normalizeCandidate(candidate, { meeting, run, segmentMap, candidateIdByKey, personIndex }));
  const resolutionLabels = list(output.speaker_resolutions).map((resolution) => String(resolution.speaker_label || ""));
  if (new Set(resolutionLabels).size !== resolutionLabels.length) {
    throw extractorError("extractor_speaker_resolution_duplicate", "speaker labels may be resolved only once per extraction");
  }
  const speakerResolutions = list(output.speaker_resolutions).map((resolution) => {
    if (!transcriptContainsLabel(segments, resolution.speaker_label)) {
      throw extractorError("extractor_speaker_label_missing", "identity resolution must reference a label observed exactly in the transcript", resolution.speaker_label);
    }
    const person = resolvePersonLabel(
      resolution.resolved_label,
      resolution.resolution_status,
      personIndex,
      "speaker"
    );
    return {
      speaker_label: resolution.speaker_label,
      resolved_label: person ? person.label : null,
      resolved_person_id: person ? person.person_id : null,
      resolution_status: resolution.resolution_status,
      resolution_basis: resolution.resolution_basis,
    };
  });
  const record = {
    meeting,
    transcript_version_id: transcriptVersion.transcript_version_id,
    run,
    segments,
    candidates,
    speaker_resolutions: speakerResolutions,
    read_gaps: list(output.read_gaps),
  };
  const validation = validateRecord(record, { forReceipt: true });
  if (!validation.ok) {
    throw extractorError("extractor_output_rejected", "extractor output failed meeting receipt validation", validation.errors);
  }
  return {
    ok: true,
    record,
    candidates,
    speaker_resolutions: record.speaker_resolutions,
    read_gaps: record.read_gaps,
  };
}

async function runMeetingReceiptExtractor({
  extractor,
  meeting,
  transcriptVersion,
  segments,
  model = "meeting-receipt-extractor",
  modelVersion = "v0",
  extractionRunId = null,
  speakerPeople = [],
} = {}) {
  if (typeof extractor !== "function") {
    throw extractorError("extractor_required", "an extractor function is required");
  }
  const prepared = prepareMeetingReceiptExtraction({ meeting, transcriptVersion, segments, speakerPeople });
  const raw = await extractor({
    prompt: prepared.prompt,
    schema: prepared.schema,
    input: prepared.input,
  });
  return compileExtractorOutput(raw, {
    meeting,
    transcriptVersion,
    segments,
    model,
    modelVersion,
    extractionRunId,
    speakerPeople,
  });
}

function prepareMeetingReceiptExtraction({ meeting, transcriptVersion, segments, speakerPeople = [] } = {}) {
  if (!meeting || !meeting.meeting_id) throw extractorError("missing_meeting", "meeting is required");
  if (!transcriptVersion || !transcriptVersion.transcript_version_id) {
    throw extractorError("missing_transcript_version", "transcriptVersion is required");
  }
  if (!list(segments).length) throw extractorError("missing_segments", "segments are required");
  const speakerLabels = list(speakerPeople).map((person) => person.label).filter(Boolean);
  const prompt = buildExtractorPrompt({ meeting, segments, speakerLabels });
  const input = {
    meeting,
    transcript_version: transcriptVersion,
    speaker_resolution_labels: speakerLabels,
    segments: segments.map((segment) => ({
      ordinal: segment.ordinal,
      provider_timestamp: segment.provider_timestamp,
      speaker_label: segment.speaker_label,
      text: segment.text,
    })),
  };
  return {
    prompt,
    schema: EXTRACTOR_OUTPUT_SCHEMA,
    input,
    prompt_sha256: sha256Text(prompt),
    output_schema_sha256: sha256Text(canonicalJson(EXTRACTOR_OUTPUT_SCHEMA)),
    request_input_sha256: sha256Text(canonicalJson(input)),
  };
}

module.exports = {
  canonicalJson,
  compileExtractorOutput,
  extractorError,
  normalizedLabel,
  prepareMeetingReceiptExtraction,
  runMeetingReceiptExtractor,
  sha256Text,
  stableUuid,
  transcriptContainsLabel,
};
