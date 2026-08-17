"use strict";

const crypto = require("crypto");
const contract = require("./meeting_receipt_contract");
const { projectOwnerReceipt } = require("./meeting_receipt_projection");
const { validateRenderedReceipt } = require("./meeting_receipt_validator");

const CORRECTION_LINE = "Reply with any line that's wrong, overstated, or missing something important.";

function list(v) {
  return Array.isArray(v) ? v : [];
}

function sha256Hex(text) {
  return crypto.createHash("sha256").update(String(text), "utf8").digest("hex");
}

function segmentMap(record) {
  return new Map(list(record.segments).map((segment) => [String(segment.segment_id), segment]));
}

function quoteText(quote, segments) {
  const segment = segments.get(String(quote.segment_id));
  if (!segment) return null;
  return String(segment.text).slice(quote.char_start, quote.char_end);
}

function sectionCounts(items) {
  const counts = new Map();
  for (const item of list(items)) counts.set(item.section, (counts.get(item.section) || 0) + 1);
  return counts;
}

function noun(count, one, many) {
  return `${count} ${count === 1 ? one : many}`;
}

function subjectFor(record, items) {
  const counts = sectionCounts(items);
  const meetingDate = (record.meeting && record.meeting.meeting_occurred_at)
    ? String(record.meeting.meeting_occurred_at).slice(0, 10)
    : "undated";
  const chunks = [];
  const decided = counts.get("YOU DECIDED") || 0;
  const open = counts.get("RAISED, NOT ANSWERED") || 0;
  const followUps = counts.get("NEEDS FOLLOW-UP") || 0;
  if (decided) chunks.push(noun(decided, "decision", "decisions"));
  if (followUps) chunks.push(noun(followUps, "follow-up", "follow-ups"));
  if (open) chunks.push(noun(open, "open item", "open items"));
  const suffix = chunks.length ? chunks.join(", ") : "no decisions";
  return `${record.meeting && record.meeting.property_name ? record.meeting.property_name : "Property"} Meeting Receipt - ${meetingDate} - ${suffix}`;
}

function ownerLabel(candidate) {
  if (candidate.owner_status === "unassigned") return "UNASSIGNED";
  if (candidate.owner_status === "none") return null;
  const label = candidate.owner_label || "Named owner";
  if (candidate.owner_resolution_status === "probable") return `${label} (probable)`;
  if (candidate.owner_resolution_status === "unresolved") return `${label} (unresolved)`;
  return label;
}

function renderMeasurement(measurement) {
  const value = `${measurement.measurement_label}: ${measurement.value}${measurement.unit === "%" ? "%" : " " + measurement.unit}`;
  const qualifiers = list(measurement.qualifiers).map(String);
  return qualifiers.length ? `${value} (${qualifiers.join("; ")})` : value;
}

function renderCandidate(item, segments) {
  const c = item.candidate;
  const parts = [];
  const owner = ownerLabel(c);
  const prefix = owner ? `${owner} - ` : "";
  parts.push(`- ${prefix}${c.subject}`);

  for (const measurement of list(c.measurements)) {
    parts.push(`  ${renderMeasurement(measurement)}`);
  }

  const qualifiers = list(c.material_qualifiers).map(String);
  const qualifierText = qualifiers.length ? ` (${qualifiers.join("; ")})` : "";
  parts.push(`  Spine read: ${c.summary}${qualifierText}`);

  for (const branch of list(c.branches).sort((a, b) => a.ordinal - b.ordinal)) {
    parts.push(`  Branch: if ${branch.condition_summary} -> ${branch.outcome_summary}`);
  }

  for (const quote of list(c.quotes)) {
    const text = quoteText(quote, segments);
    if (text) parts.push(`  ${quote.speaker_label}: "${text}"`);
  }

  return parts.join("\n");
}

function identityFootnotes(record) {
  const notes = [];
  for (const resolution of list(record.speaker_resolutions)) {
    if (resolution.resolution_status === "probable") {
      const resolved = resolution.resolved_label || resolution.resolved_person_id || "unresolved person";
      notes.push(`read ${resolution.speaker_label} as ${resolved}`);
    }
  }
  for (const candidate of list(record.candidates)) {
    if (candidate.owner_resolution_status === "probable" && candidate.owner_label) {
      notes.push(`owner label ${candidate.owner_label} is probable`);
    }
  }
  return [...new Set(notes)];
}

function readGapLines(record) {
  const out = [];
  const run = record.run || {};
  if (run.extraction_coverage && run.extraction_coverage !== "full") {
    out.push(`extraction coverage: ${run.extraction_coverage}${run.coverage_notes ? " - " + run.coverage_notes : ""}`);
  }
  for (const gap of list(record.read_gaps)) out.push(String(gap));
  for (const note of identityFootnotes(record)) out.push(`identity: ${note}`);
  return out;
}

function renderOwnerReceipt(record, {
  receiptGrammarRevision = contract.OWNER_GRAMMAR_REVISION,
} = {}) {
  const projection = projectOwnerReceipt(record);
  if (!projection.ok) {
    return {
      ok: false,
      generation_status: "blocked",
      errors: projection.errors,
      receipt_grammar_revision: receiptGrammarRevision,
    };
  }

  const segments = segmentMap(record);
  const subject = subjectFor(record, projection.items);
  const lines = [CORRECTION_LINE, ""];

  for (const section of contract.OWNER_SECTIONS) {
    const sectionItems = projection.items.filter((item) => item.section === section);
    if (!sectionItems.length) continue;
    lines.push(section);
    for (const item of sectionItems) lines.push(renderCandidate(item, segments));
    lines.push("");
  }

  const gaps = readGapLines(record);
  lines.push("READ GAPS");
  if (gaps.length) {
    for (const gap of gaps) lines.push(`- ${gap}`);
  } else {
    lines.push("- none recorded");
  }

  const body = lines.join("\n").trimEnd() + "\n";
  const digest = sha256Hex(`${subject}\n\n${body}`);
  const rendered = {
    ok: true,
    generation_status: "draft",
    audience_type: "owner",
    receipt_grammar_revision: receiptGrammarRevision,
    rendered_subject: subject,
    rendered_body: body,
    rendered_digest: digest,
    items: projection.items.map((item) => ({
      candidate_id: item.candidate_id,
      section: item.section,
      ordinal: item.ordinal,
      first_ordinal: item.first_ordinal,
    })),
  };

  const renderCheck = validateRenderedReceipt(record, rendered);
  if (!renderCheck.ok) {
    return {
      ok: false,
      generation_status: "blocked",
      errors: renderCheck.errors,
      receipt_grammar_revision: receiptGrammarRevision,
    };
  }

  return rendered;
}

module.exports = {
  CORRECTION_LINE,
  renderOwnerReceipt,
  sha256Hex,
};
