"use strict";

const contract = require("./meeting_receipt_contract");

const EXTRACTOR_OUTPUT_SCHEMA = Object.freeze({
  type: "object",
  properties: {
    extraction_coverage: { type: "string", enum: contract.EXTRACTION_COVERAGES },
    coverage_notes: { type: ["string", "null"] },
    read_gaps: { type: "array", items: { type: "string" } },
    speaker_resolutions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          speaker_label: { type: "string" },
          resolved_label: { type: ["string", "null"] },
          resolution_status: { type: "string", enum: contract.RESOLUTION_STATUSES },
          resolution_basis: { type: "string" },
        },
        required: ["speaker_label", "resolved_label", "resolution_status", "resolution_basis"],
        additionalProperties: false,
      },
    },
    candidates: {
      type: "array",
      items: {
        type: "object",
        properties: {
          candidate_key: { type: "string" },
          candidate_type: { type: "string", enum: contract.CANDIDATE_TYPES },
          subject: { type: "string" },
          summary: { type: "string" },
          source_class: { type: "string", enum: contract.SOURCE_CLASSES },
          epistemic_status: { type: "string", enum: contract.EPISTEMIC_STATUSES },
          owner_status: { type: "string", enum: contract.OWNER_STATUSES },
          owner_label: { type: ["string", "null"] },
          owner_resolution_status: { type: ["string", "null"], enum: [...contract.RESOLUTION_STATUSES, null] },
          relevant_time: {
            type: ["string", "null"],
            description: "When non-null, support must include temporal_basis for the transcript segment establishing this time.",
          },
          material_qualifiers: { type: "array", items: { type: "string" } },
          material: { type: "boolean" },
          personal: { type: "boolean" },
          supersedes_candidate_key: { type: ["string", "null"] },
          support: {
            type: "array",
            description: "Evidence roles are additive: one segment may appear more than once with different roles. relevant_time requires temporal_basis; reported_claim requires claim_basis and attribution; decision requires decision_basis; instruction requires instruction_basis; commitment requires commitment_basis or instruction_basis; proposal requires proposal_basis; constraint requires observation_basis.",
            items: {
              type: "object",
              properties: {
                segment_ordinal: { type: "integer" },
                support_role: { type: "string", enum: contract.SUPPORT_ROLES },
              },
              required: ["segment_ordinal", "support_role"],
              additionalProperties: false,
            },
          },
          quotes: {
            type: "array",
            items: {
              type: "object",
              properties: {
                segment_ordinal: { type: "integer" },
                speaker_label: { type: "string" },
                quote_text_exact: { type: "string" },
              },
              required: ["segment_ordinal", "speaker_label", "quote_text_exact"],
              additionalProperties: false,
            },
          },
          branches: {
            type: "array",
            items: {
              type: "object",
              properties: {
                condition_summary: { type: "string" },
                outcome_summary: { type: "string" },
                segment_ordinal: { type: "integer" },
                ordinal: { type: "integer" },
              },
              required: ["condition_summary", "outcome_summary", "segment_ordinal", "ordinal"],
              additionalProperties: false,
            },
          },
          measurements: {
            type: "array",
            items: {
              type: "object",
              properties: {
                measurement_label: { type: "string" },
                value: { type: "number" },
                unit: { type: "string" },
                as_of: { type: ["string", "null"] },
                segment_ordinal: { type: "integer" },
                qualifiers: { type: "array", items: { type: "string" } },
              },
              required: ["measurement_label", "value", "unit", "segment_ordinal", "qualifiers"],
              additionalProperties: false,
            },
          },
        },
        required: [
          "candidate_key",
          "candidate_type",
          "subject",
          "summary",
          "source_class",
          "epistemic_status",
          "owner_status",
          "material_qualifiers",
          "material",
          "personal",
          "support",
          "quotes",
        ],
        additionalProperties: false,
      },
    },
  },
  required: ["extraction_coverage", "candidates"],
  additionalProperties: false,
});

function buildExtractorPrompt({ meeting, segments, speakerLabels = [] }) {
  const segmentLines = segments.map((segment) => {
    return [
      `SEGMENT ${segment.ordinal}`,
      `timestamp: ${segment.provider_timestamp || ""}`,
      `speaker: ${segment.speaker_label}`,
      `text: ${segment.text}`,
    ].join("\n");
  });
  return [
    "You are extracting Meeting Receipt candidates from a property operations meeting transcript.",
    "Return only the structured schema. Do not write receipt prose.",
    "",
    "Hard rules:",
    "- Invalid output is rejected by the server, not repaired.",
    "- Reference transcript evidence by segment_ordinal only.",
    "- Quote text must be an exact contiguous substring of one segment.",
    "- Do not provide database ids, character ranges, confidence fields, read_status, or cleaned quotes.",
    "- A reported resident statement is a reported_claim, not an observation.",
    "- A pricing idea without a final ruling is a proposal or question, never a decision.",
    "- A named owner must come from the transcript or an explicit speaker resolution; otherwise use unassigned or none.",
    "- A probable or confirmed resolved identity must use one exact label from the server-provided property people list.",
    "- Use unresolved with resolved_label=null when no exact property-person label is established.",
    "- Do not treat silence, enthusiasm, or discussion as a decision or assignment.",
    "- Preserve every material branch of a conditional decision and every material hedge on an unconfirmed statement.",
    "- A superseded candidate must appear earlier in candidates than the candidate that supersedes it.",
    "- Personal chatter can be retained for exclusion by setting personal=true.",
    "- If relevant_time is non-null, support must include temporal_basis. The same segment may carry temporal_basis and another required role.",
    "- A decision requires decision_basis support.",
    "- An instruction requires instruction_basis support.",
    "- A commitment requires commitment_basis or instruction_basis support.",
    "- A reported_claim requires both claim_basis and attribution support; observation_basis does not substitute for either role.",
    "- A proposal requires proposal_basis support.",
    "- A constraint requires observation_basis support.",
    "",
    `Meeting: ${meeting && meeting.property_name ? meeting.property_name : "Property"} ${meeting && meeting.meeting_occurred_at ? meeting.meeting_occurred_at : ""}`,
    `Property people labels (names only, no ids): ${speakerLabels.length ? speakerLabels.join(" | ") : "none supplied"}`,
    "",
    segmentLines.join("\n\n"),
  ].join("\n");
}

module.exports = {
  EXTRACTOR_OUTPUT_SCHEMA,
  buildExtractorPrompt,
};
