"use strict";

const statusModel = require("../governance/status_model");

const CONTRACT_REVISION = "meeting-receipt-v0-r4";
const PROMPT_REVISION = "meeting-receipt-extractor-v0";
const OWNER_GRAMMAR_REVISION = "owner-receipt-v0";

const OCCURRED_AT_SOURCES = Object.freeze([
  "provider_scheduled",
  "provider_recorded",
  "manual_entry",
]);

const EXTRACTION_COVERAGES = Object.freeze([
  "full",
  "partial",
  "degraded",
  "failed",
]);

const CANDIDATE_TYPES = Object.freeze([
  "reported_claim",
  "observation",
  "question",
  "constraint",
  "proposal",
  "decision",
  "instruction",
  "commitment",
  "unresolved_issue",
  "correction_or_revision",
]);

const SUPPORT_ROLES = Object.freeze([
  "decision_basis",
  "proposal_basis",
  "instruction_basis",
  "commitment_basis",
  "claim_basis",
  "observation_basis",
  "qualifier",
  "attribution",
  "superseded_position",
  "temporal_basis",
  "ownership_basis",
]);

const OWNER_STATUSES = Object.freeze(["named", "unassigned", "none"]);

const OWNER_SECTIONS = Object.freeze([
  "PROPERTY PULSE",
  "YOU DECIDED",
  "RAISED, NOT ANSWERED",
  "NEEDS FOLLOW-UP",
  "WATCHING",
  "ALSO HEARD",
]);

const REVIEW_TARGETS = Object.freeze(["interpretation", "projection"]);
const INTERPRETATION_REVIEW_CLASSES = Object.freeze(["confirmed", "wrong", "overclaimed", "incomplete"]);
const PROJECTION_REVIEW_CLASSES = Object.freeze(["wrong_section", "not_material", "should_have_rendered"]);
const REVIEW_SOURCES = Object.freeze(["direct_review", "manual_entry", "stored_reply"]);
const MANUAL_EDIT_FIELDS = Object.freeze(["rendered_subject", "rendered_body"]);
const MANUAL_EDIT_SOURCES = Object.freeze(["manual_preview", "sent_copy", "stored_reply"]);
const FEEDBACK_KINDS = Object.freeze([
  "wrong",
  "overstated",
  "assigned_wrong_person",
  "missing",
  "should_not_have_rendered",
  "wrong_section",
  "should_have_rendered",
]);

const WRITE_ALLOWLIST = Object.freeze([
  "meeting_evidence_meetings",
  "transcript_versions",
  "transcript_segments",
  "meeting_speaker_resolutions",
  "meeting_extraction_runs",
  "meeting_interpretation_candidates",
  "candidate_support",
  "candidate_quotes",
  "candidate_branches",
  "candidate_measurements",
  "meeting_receipts",
  "meeting_receipt_items",
  "meeting_receipt_candidate_reviews",
  "meeting_receipt_missed_items",
  "meeting_receipt_manual_edit_deltas",
]);

function has(list, value) {
  return list.includes(String(value || ""));
}

module.exports = {
  CONTRACT_REVISION,
  PROMPT_REVISION,
  OWNER_GRAMMAR_REVISION,
  OCCURRED_AT_SOURCES,
  EXTRACTION_COVERAGES,
  CANDIDATE_TYPES,
  SUPPORT_ROLES,
  OWNER_STATUSES,
  OWNER_SECTIONS,
  REVIEW_TARGETS,
  INTERPRETATION_REVIEW_CLASSES,
  PROJECTION_REVIEW_CLASSES,
  REVIEW_SOURCES,
  MANUAL_EDIT_FIELDS,
  MANUAL_EDIT_SOURCES,
  FEEDBACK_KINDS,
  WRITE_ALLOWLIST,
  ...statusModel,
  has,
};
