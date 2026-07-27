// ════════════════════════════════════════════════════════════════════
//  market_evidence_contract.js — THE SEAM, AND NOTHING BEHIND IT
//
//  CONTRACT ONLY. No Rent Survey, no scraping, no competitor records, no
//  storage, no automated pricing change. This file defines the shape future
//  market evidence must satisfy, and proves the pricing service can DISPLAY
//  such an observation while being structurally unable to CONSUME it.
//
//  ── WHY THE SEAM COMES FIRST ─────────────────────────────────────────
//  The chain has a direction:
//      market evidence → management judgment → PUBLISHED PRICING
//  Evidence informs a human. It never becomes a price. If observations were
//  built before the authority model was stable, the shortest path from a
//  scraped competitor rent to a live quote would be a few lines of code, and
//  the judgment step would be the thing that got skipped.
//
//  An observation is APPEND-ONLY: a competitor's advertised rent last Tuesday
//  remains a true statement about last Tuesday even after they change it.
//  Corrections supersede; they do not overwrite. A store that overwrites
//  cannot answer "what did we know when we priced this?", which is the only
//  question evidence exists to answer.
// ════════════════════════════════════════════════════════════════════

"use strict";

const OBSERVATION_FIELDS = {
  observation_id:        { required: true,  note: "Stable identity. Append-only; never reused." },
  source:                { required: true,  enum: ["public_listing", "human_verified", "operator_report", "third_party_feed"],
                           note: "How it was obtained. Determines the ceiling on confidence." },
  observed_at:           { required: true,  note: "When the observation was TRUE, not when it was recorded." },
  recorded_at:           { required: true,  note: "When it entered the system. Both are needed to age it." },
  subject_kind:          { required: true,  enum: ["own_property", "competitor_property"] },
  subject_property_id:   { required: false, note: "Set for own_property. Null for a competitor." },
  competitor_ref:        { required: false, note: "Opaque reference. No competitor records are created by this contract." },
  unit_type_relationship:{ required: true,  enum: ["governed_unit_type", "asserted_comparable", "unmapped"],
                           note: "An external listing is NEVER a governed type. 'asserted_comparable' " +
                                 "records a human's claim of similarity, and marks it as a claim." },
  governed_unit_type_id: { required: false, note: "Only when unit_type_relationship = governed_unit_type." },
  advertised_rent:       { required: false, note: "Null is legitimate — a listing may show no price." },
  advertised_concession: { required: false, note: "Free text as observed. Never parsed into an economic promise." },
  term_and_conditions:   { required: false, note: "Lease term, furnished, inclusions — as observed." },
  verification:          { required: true,  enum: ["public_unverified", "human_verified"] },
  confidence:            { required: true,  enum: ["low", "medium", "high"] },
  freshness_days:        { required: true,  note: "Derived from observed_at. An observation does not " +
                                 "become false with age, it becomes less relevant — so freshness is " +
                                 "reported, never used to silently drop a row." },
  supersedes_observation_id: { required: false, note: "A correction points at what it corrects. The " +
                                 "superseded row is retained." },
  resolution:            { required: false, enum: ["stands", "superseded", "withdrawn", "disputed"] },
};

const REQUIRED = Object.keys(OBSERVATION_FIELDS).filter((k) => OBSERVATION_FIELDS[k].required);

// The permanent boundary, stated as a value so it can be asserted.
const CONSUMPTION_RULE = {
  may_be_displayed_as_evidence: true,
  may_be_consumed_as_pricing: false,
  may_trigger_a_pricing_change: false,
  reason: "Market evidence informs management judgment. Only a human publishing a governed version " +
          "creates pricing. There is no path from an observation to a published rent that does not " +
          "pass through a person with may_publish_pricing.",
};

/** Validate a proposed observation against the contract. PURE. */
function validateObservation(o = {}) {
  const errors = [];
  for (const f of REQUIRED) {
    if (o[f] === undefined || o[f] === null || o[f] === "") errors.push({ code: "missing_required_field", field: f });
  }
  for (const [f, spec] of Object.entries(OBSERVATION_FIELDS)) {
    if (spec.enum && o[f] != null && !spec.enum.includes(o[f]))
      errors.push({ code: "invalid_value", field: f, detail: `must be one of ${spec.enum.join(", ")}` });
  }
  if (o.unit_type_relationship === "governed_unit_type" && !o.governed_unit_type_id)
    errors.push({ code: "governed_relationship_without_type", field: "governed_unit_type_id" });
  if (o.subject_kind === "competitor_property" && o.governed_unit_type_id)
    errors.push({ code: "competitor_mapped_to_governed_type", field: "governed_unit_type_id",
      detail: "A competitor's unit cannot BE one of our governed types. Record it as asserted_comparable." });
  if (o.verification === "public_unverified" && o.confidence === "high")
    errors.push({ code: "confidence_exceeds_verification", field: "confidence",
      detail: "An unverified public listing cannot carry high confidence." });
  if (o.supersedes_observation_id && o.resolution !== "superseded" && o.resolution !== "stands")
    errors.push({ code: "supersession_without_resolution", field: "resolution" });
  return { valid: errors.length === 0, errors };
}

/**
 * The DISPLAY seam. Returns observations shaped for a pricing surface, each
 * explicitly marked non-authoritative. Takes observations as an argument —
 * there is no store to read from, by design.
 */
function asDisplayEvidence(observations = []) {
  return {
    status: observations.length ? "available" : "unavailable",
    reason: observations.length ? null : "governed_market_observations_not_built",
    authoritative: false,
    consumption_rule: CONSUMPTION_RULE,
    observations: observations.map((o) => ({
      observation_id: o.observation_id,
      source: o.source, observed_at: o.observed_at, freshness_days: o.freshness_days,
      subject: o.subject_kind === "own_property" ? "this property" : (o.competitor_ref || "a competitor"),
      relationship: o.unit_type_relationship,
      advertised_rent: o.advertised_rent ?? null,
      advertised_concession: o.advertised_concession ?? null,
      verification: o.verification, confidence: o.confidence,
      resolution: o.resolution || "stands",
      // Repeated per row so a single row lifted out of context still carries it.
      disposition: "evidence_only_not_pricing",
    })),
  };
}

/**
 * Prove the boundary: attempting to turn an observation into a pricing term
 * is refused, whatever the observation says.
 */
function attemptConsumeAsPricing(observation) {
  return {
    accepted: false,
    code: "market_observation_cannot_become_pricing",
    detail: CONSUMPTION_RULE.reason,
    observation_id: observation ? observation.observation_id : null,
  };
}

module.exports = {
  OBSERVATION_FIELDS, REQUIRED, CONSUMPTION_RULE,
  validateObservation, asDisplayEvidence, attemptConsumeAsPricing,
};
