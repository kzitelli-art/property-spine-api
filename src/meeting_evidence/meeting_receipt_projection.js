"use strict";

const contract = require("./meeting_receipt_contract");
const { validateRecord } = require("./meeting_receipt_validator");

function list(v) {
  return Array.isArray(v) ? v : [];
}

function supersededCandidateIds(candidates) {
  const out = new Set();
  for (const candidate of list(candidates)) {
    if (candidate.supersedes_candidate_id) out.add(String(candidate.supersedes_candidate_id));
  }
  return out;
}

function hasMeasurement(candidate) {
  return list(candidate.measurements).length > 0;
}

function isSupersededByLaterDecisionOrRevision(candidate, candidates) {
  return list(candidates).some((other) =>
    String(other.supersedes_candidate_id || "") === String(candidate.candidate_id) &&
    ["decision", "correction_or_revision"].includes(other.candidate_type));
}

function assignOwnerSection(candidate, allCandidates) {
  if (candidate.material === false) return null;
  if (candidate.personal === true) return null;
  if (hasMeasurement(candidate)) return "PROPERTY PULSE";

  if (candidate.candidate_type === "decision") return "YOU DECIDED";
  if (candidate.candidate_type === "question" || candidate.candidate_type === "unresolved_issue") {
    return "RAISED, NOT ANSWERED";
  }
  if (candidate.candidate_type === "proposal") {
    return isSupersededByLaterDecisionOrRevision(candidate, allCandidates)
      ? null
      : "RAISED, NOT ANSWERED";
  }
  if (candidate.candidate_type === "instruction" || candidate.candidate_type === "commitment") {
    return "NEEDS FOLLOW-UP";
  }
  if (candidate.candidate_type === "constraint") return "WATCHING";
  if (candidate.candidate_type === "observation" || candidate.candidate_type === "reported_claim") return "ALSO HEARD";
  return null;
}

function projectOwnerReceipt(record) {
  const validation = validateRecord(record, { forReceipt: true });
  const errors = [...validation.errors];
  const candidates = list(record.candidates);
  const superseded = supersededCandidateIds(candidates);

  for (const candidate of candidates) {
    if (candidate.candidate_type === "decision" && superseded.has(String(candidate.candidate_id))) {
      errors.push({
        code: "superseded_decision_cannot_render",
        message: "an abandoned intermediate cannot render as the final decision",
        detail: candidate.candidate_id,
      });
    }
  }

  if (errors.length) return { ok: false, errors, items: [] };

  const items = [];
  for (const candidate of candidates) {
    const section = assignOwnerSection(candidate, candidates);
    if (!section) continue;
    items.push({
      candidate,
      candidate_id: candidate.candidate_id,
      section,
      first_ordinal: validation.firstOrdinal(candidate),
    });
  }

  items.sort((a, b) => {
    const sectionDelta = contract.OWNER_SECTIONS.indexOf(a.section) - contract.OWNER_SECTIONS.indexOf(b.section);
    if (sectionDelta) return sectionDelta;
    return a.first_ordinal - b.first_ordinal;
  });

  const nextOrdinalBySection = new Map();
  for (const item of items) {
    const next = (nextOrdinalBySection.get(item.section) || 0) + 1;
    nextOrdinalBySection.set(item.section, next);
    item.ordinal = next;
  }

  return { ok: true, errors: [], items };
}

module.exports = {
  assignOwnerSection,
  projectOwnerReceipt,
  supersededCandidateIds,
};
