"use strict";

const contract = require("./meeting_receipt_contract");

function err(code, message, detail) {
  return { code, message, detail };
}

function list(v) {
  return Array.isArray(v) ? v : [];
}

function jsonList(v) {
  return Array.isArray(v) ? v : [];
}

function walkKeys(value, path = "", out = []) {
  if (!value || typeof value !== "object") return out;
  if (Array.isArray(value)) {
    value.forEach((child, index) => walkKeys(child, `${path}[${index}]`, out));
    return out;
  }
  for (const key of Object.keys(value)) {
    const p = path ? `${path}.${key}` : key;
    if (/^confidence($|_|pct|score)/i.test(key)) out.push(p);
    walkKeys(value[key], p, out);
  }
  return out;
}

function byId(rows, idField) {
  const out = new Map();
  for (const row of list(rows)) out.set(String(row[idField]), row);
  return out;
}

function candidateEvidence(candidate) {
  return {
    support: list(candidate.support),
    quotes: list(candidate.quotes),
    branches: list(candidate.branches),
    measurements: list(candidate.measurements),
  };
}

function minOrdinal(candidate, segmentById) {
  const ids = [];
  for (const support of list(candidate.support)) ids.push(support.segment_id);
  for (const quote of list(candidate.quotes)) ids.push(quote.segment_id);
  for (const branch of list(candidate.branches)) ids.push(branch.supporting_segment_id);
  for (const measurement of list(candidate.measurements)) ids.push(measurement.stated_by_segment_id);
  const ordinals = ids
    .map((id) => segmentById.get(String(id)))
    .filter(Boolean)
    .map((segment) => segment.ordinal);
  return ordinals.length ? Math.min(...ordinals) : Number.MAX_SAFE_INTEGER;
}

function validateRecord(record, { forReceipt = true } = {}) {
  const errors = [];
  const segments = list(record.segments);
  const candidates = list(record.candidates);
  const segmentById = byId(segments, "segment_id");
  const candidateById = byId(candidates, "candidate_id");
  const run = record.run || {};
  const transcriptVersionId = String(run.transcript_version_id || record.transcript_version_id || "");

  const confidenceKeys = walkKeys(record);
  if (confidenceKeys.length) {
    errors.push(err("confidence_field_forbidden", "confidence fields are forbidden", confidenceKeys));
  }

  if (!contract.has(contract.EXTRACTION_COVERAGES, run.extraction_coverage)) {
    errors.push(err("unknown_extraction_coverage", "extraction coverage is not canonical", run.extraction_coverage));
  } else if (forReceipt && run.extraction_coverage !== "full") {
    errors.push(err("coverage_not_full", "partial, degraded, or failed extraction cannot render as complete", run.extraction_coverage));
  }

  const resolvedSpeakerLabels = new Set();
  for (const resolution of list(record.speaker_resolutions)) {
    const speakerLabel = String(resolution.speaker_label || "");
    if (!segments.some((segment) =>
      String(segment.speaker_label) === speakerLabel || String(segment.text || "").includes(speakerLabel))) {
      errors.push(err("speaker_resolution_segment_missing",
        "identity resolution must reference a label observed exactly in the transcript", speakerLabel));
    }
    if (resolvedSpeakerLabels.has(speakerLabel)) {
      errors.push(err("speaker_resolution_duplicate", "speaker label may be resolved only once per extraction", speakerLabel));
    }
    resolvedSpeakerLabels.add(speakerLabel);
    if (!contract.has(contract.RESOLUTION_STATUSES, resolution.resolution_status)) {
      errors.push(err("unknown_resolution_status", "speaker resolution status is not canonical", resolution.resolution_status));
    }
    if (!String(resolution.resolution_basis || "").trim()) {
      errors.push(err("speaker_resolution_basis_missing", "speaker resolution requires a basis", speakerLabel));
    }
    if (resolution.resolution_status === "unresolved" &&
        (resolution.resolved_label || resolution.resolved_person_id)) {
      errors.push(err("unresolved_speaker_has_identity", "unresolved speaker cannot carry a resolved identity", speakerLabel));
    }
  }

  for (const candidate of candidates) {
    const label = candidate.candidate_id || candidate.subject || "candidate";
    if (!contract.has(contract.CANDIDATE_TYPES, candidate.candidate_type)) {
      errors.push(err("unknown_candidate_type", "candidate type is not canonical", { label, value: candidate.candidate_type }));
    }
    if (!contract.has(contract.SOURCE_CLASSES, candidate.source_class)) {
      errors.push(err("unknown_source_class", "source class is not canonical", { label, value: candidate.source_class }));
    }
    if (!contract.has(contract.EPISTEMIC_STATUSES, candidate.epistemic_status)) {
      errors.push(err("unknown_epistemic_status", "epistemic status is not canonical", { label, value: candidate.epistemic_status }));
    }
    if ("read_status" in candidate) {
      errors.push(err("candidate_read_status_forbidden", "read_status belongs to governed reads, not candidates", label));
    }
    if (!contract.has(contract.OWNER_STATUSES, candidate.owner_status)) {
      errors.push(err("unknown_owner_status", "owner status is not canonical", { label, value: candidate.owner_status }));
    }
    if (candidate.owner_status === "unassigned" && (candidate.owner_label || candidate.owner_person_id)) {
      errors.push(err("unassigned_owner_named", "unassigned items cannot render a named owner", label));
    }
    if (candidate.owner_status === "none" &&
        (candidate.owner_label || candidate.owner_person_id || candidate.owner_resolution_status)) {
      errors.push(err("owner_none_has_identity", "owner_status none cannot carry owner identity", label));
    }
    if (candidate.owner_status === "named" && !candidate.owner_label && !candidate.owner_person_id) {
      errors.push(err("named_owner_missing_identity", "named owner requires a label or person id", label));
    }
    if (candidate.owner_person_id && candidate.owner_status !== "named") {
      errors.push(err("owner_person_requires_named", "owner_person_id requires owner_status named", label));
    }
    if (candidate.owner_resolution_status &&
        !contract.has(contract.RESOLUTION_STATUSES, candidate.owner_resolution_status)) {
      errors.push(err("unknown_owner_resolution_status", "owner resolution status is not canonical", {
        label,
        value: candidate.owner_resolution_status,
      }));
    }
    if (candidate.owner_resolution_status && candidate.owner_status !== "named") {
      errors.push(err("owner_resolution_requires_named", "owner resolution status requires owner_status named", label));
    }
    if (candidate.relevant_time && !list(candidate.support).some((s) => s.support_role === "temporal_basis")) {
      errors.push(err("time_without_temporal_basis", "date-specific commitment requires temporal_basis", label));
    }
    if (candidate.epistemic_status === "unconfirmed" && jsonList(candidate.material_qualifiers).length === 0) {
      errors.push(err("unconfirmed_without_qualifier", "material hedge must be recorded as a qualifier", label));
    }
    if (candidate.epistemic_status === "reported" && candidate.candidate_type === "observation") {
      errors.push(err("reported_observation_forbidden", "reported evidence cannot be typed as direct observation", label));
    }

    const evidence = candidateEvidence(candidate);
    for (const support of evidence.support) {
      if (!contract.has(contract.SUPPORT_ROLES, support.support_role)) {
        errors.push(err("unknown_support_role", "support role is not canonical", { label, value: support.support_role }));
      }
      const segment = segmentById.get(String(support.segment_id));
      if (!segment) {
        errors.push(err("support_segment_missing", "support references a missing transcript segment", { label, support }));
      } else if (transcriptVersionId && String(segment.transcript_version_id) !== transcriptVersionId) {
        errors.push(err("support_wrong_transcript_version", "support references the wrong transcript version", { label, support }));
      }
    }

    const roles = new Set(evidence.support.map((s) => s.support_role));
    if (candidate.candidate_type === "decision" && !roles.has("decision_basis")) {
      errors.push(err("decision_without_basis", "decision requires decision_basis", label));
    }
    if (candidate.candidate_type === "instruction" && !roles.has("instruction_basis")) {
      errors.push(err("instruction_without_basis", "instruction requires instruction_basis", label));
    }
    if (candidate.candidate_type === "commitment" &&
        !roles.has("commitment_basis") && !roles.has("instruction_basis")) {
      errors.push(err("commitment_without_basis", "commitment requires commitment_basis or instruction_basis", label));
    }
    if (candidate.candidate_type === "reported_claim" &&
        (!roles.has("claim_basis") || !roles.has("attribution"))) {
      errors.push(err("reported_claim_without_attribution", "reported claim requires claim_basis and attribution", label));
    }
    if (candidate.candidate_type === "proposal" && !roles.has("proposal_basis")) {
      errors.push(err("proposal_without_basis", "proposal requires proposal_basis", label));
    }
    if (candidate.candidate_type === "constraint" && !roles.has("observation_basis")) {
      errors.push(err("constraint_without_observation_basis", "constraint requires observation_basis", label));
    }
    if (jsonList(candidate.material_qualifiers).includes("conditional") &&
        candidate.candidate_type === "decision" && evidence.branches.length === 0) {
      errors.push(err("conditional_decision_without_branches", "conditional decision requires branches", label));
    }
    if (candidate.supersedes_candidate_id) {
      const prior = candidateById.get(String(candidate.supersedes_candidate_id));
      if (!prior ||
          String(prior.meeting_id) !== String(candidate.meeting_id) ||
          String(prior.extraction_run_id) !== String(candidate.extraction_run_id)) {
        errors.push(err("supersession_out_of_scope", "supersession must stay inside one meeting and extraction run", label));
      }
    }

    for (const quote of evidence.quotes) {
      if ("text" in quote) {
        errors.push(err("quote_text_forbidden", "quote text is never stored on candidates", label));
      }
      const segment = segmentById.get(String(quote.segment_id));
      if (!segment) {
        errors.push(err("quote_segment_missing", "quote references a missing segment", { label, quote }));
        continue;
      }
      if (transcriptVersionId && String(segment.transcript_version_id) !== transcriptVersionId) {
        errors.push(err("quote_wrong_transcript_version", "quote references the wrong transcript version", { label, quote }));
      }
      if (segment.speaker_label !== quote.speaker_label) {
        errors.push(err("quote_speaker_mismatch", "quote speaker must match segment speaker", { label, quote }));
      }
      if (!Number.isInteger(quote.char_start) || !Number.isInteger(quote.char_end) ||
          quote.char_start < 0 || quote.char_end <= quote.char_start ||
          quote.char_end > String(segment.text).length) {
        errors.push(err("quote_range_invalid", "quote must map to contiguous source text in one segment", { label, quote }));
      }
    }

    for (const branch of evidence.branches) {
      if (candidate.candidate_type !== "decision") {
        errors.push(err("branch_on_non_decision", "conditional branches render only on decisions", label));
      }
      const segment = segmentById.get(String(branch.supporting_segment_id));
      if (!segment) errors.push(err("branch_segment_missing", "branch references a missing segment", { label, branch }));
      if (!branch.condition_summary || !branch.outcome_summary) {
        errors.push(err("branch_incomplete", "branch requires condition and outcome", { label, branch }));
      }
    }

    for (const measurement of evidence.measurements) {
      const segment = segmentById.get(String(measurement.stated_by_segment_id));
      if (!segment) errors.push(err("measurement_segment_missing", "measurement references a missing segment", { label, measurement }));
      if (jsonList(measurement.qualifiers).length === 0) {
        errors.push(err("measurement_without_qualifier", "headline measurement requires non-empty qualifiers", label));
      }
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    firstOrdinal(candidate) {
      return minOrdinal(candidate, segmentById);
    },
  };
}

function assertValidRecord(record, options) {
  const result = validateRecord(record, options);
  if (!result.ok) {
    const error = new Error("meeting receipt record failed validation");
    error.code = "meeting_receipt_validation_failed";
    error.errors = result.errors;
    throw error;
  }
  return result;
}

function validateRenderedReceipt(record, rendered) {
  const errors = [];
  const body = `${rendered.rendered_subject || ""}\n${rendered.rendered_body || ""}`;
  for (const candidate of list(record.candidates)) {
    for (const qualifier of jsonList(candidate.material_qualifiers)) {
      if (candidate.material !== false && candidate.personal !== true && !body.includes(String(qualifier))) {
        errors.push(err("qualifier_not_rendered", "material qualifier must render on its item", {
          candidate_id: candidate.candidate_id,
          qualifier,
        }));
      }
    }
    for (const measurement of list(candidate.measurements)) {
      for (const qualifier of jsonList(measurement.qualifiers)) {
        if (candidate.material !== false && candidate.personal !== true && !body.includes(String(qualifier))) {
          errors.push(err("measurement_qualifier_not_rendered", "measurement qualifier must render adjacent to the value", {
            candidate_id: candidate.candidate_id,
            qualifier,
          }));
        }
      }
    }
  }
  return { ok: errors.length === 0, errors };
}

module.exports = {
  assertValidRecord,
  validateRecord,
  validateRenderedReceipt,
};
