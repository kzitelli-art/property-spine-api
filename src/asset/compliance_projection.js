"use strict";

const contracts = require("./compliance_contracts.js");
const semantics = require("./compliance_semantics.js");

function uniqueReferences(references) {
  const seen = new Set();
  return references.filter((reference) => {
    const key = JSON.stringify(reference);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function evidenceForFacts(facts, factIds) {
  const wanted = new Set(factIds);
  return facts
    .filter((fact) => wanted.has(fact.fact_id))
    .flatMap((fact) => fact.evidence.map((entry) => ({
      role: entry.role,
      label: entry.label,
      reference: entry.reference,
    })));
}

function coverageUnresolved(coverage) {
  if (coverage.state === "unknown") {
    return [{
      code: "requirement_census_unknown",
      detail: "The property requirement census is unknown; this item standing is not a property-wide conclusion.",
    }];
  }
  if (coverage.state === "partial") {
    return [{
      code: "requirement_census_partial",
      detail: "The property requirement census is partial; this item standing is not a property-wide conclusion.",
    }];
  }
  return [];
}

function derive(spec, asOf) {
  if (spec.kind === "credential") return semantics.deriveCredentialStanding(spec.facts, asOf);
  if (spec.kind === "finding") return semantics.deriveFindingStanding(spec.facts, asOf);
  if (spec.kind === "inspection") return semantics.deriveInspectionStanding(spec.facts, asOf);
  if (spec.kind === "requirement") return semantics.deriveRequirementStanding(spec.facts, asOf);
  throw new TypeError("Compliance projection kind is not supported");
}

function projectItem(spec, asOf, coverage) {
  const standing = derive(spec, asOf);
  const attention = semantics.deriveAttention(spec.action_condition, asOf);
  const evidence = evidenceForFacts(spec.facts, standing.decisive_fact_ids);
  const references = uniqueReferences([
    spec.record_reference,
    ...evidence.map((entry) => entry.reference),
  ]);
  const next = attention.state === "none_established"
    ? standing.next
    : {
      date: spec.action_condition.due_on,
      action: spec.action_condition.action,
      state: "action_established",
    };

  return {
    entity: spec.entity,
    standing: { code: standing.code, as_of: asOf },
    why: standing.why,
    evidence,
    unresolved: [...standing.unresolved, ...coverageUnresolved(coverage)],
    next,
    attention,
    references,
  };
}

function buildStandingProjection({ as_of: asOf, coverage, items }) {
  const projected = items.map((spec) => projectItem(spec, asOf, coverage));
  const value = {
    contract_version: contracts.VERSIONS.standing,
    capability_classes: contracts.retrievalCapabilityReceipt(
      "canonical Compliance facts and pure as-of derivation"),
    composition_authorization: "unsolved_cross_domain",
    as_of: asOf,
    coverage,
    items: projected,
    references: uniqueReferences(projected.flatMap((item) => item.references)),
  };
  return contracts.validateStanding(value);
}

function historyDates(fact) {
  if (fact.fact_type === "credential_period") {
    return [fact.value.effective_from, fact.value.effective_through];
  }
  if (fact.fact_type === "finding_issued") return [fact.value.issued_on, null];
  if (fact.fact_type === "payment_observed") return [fact.value.observed_on, null];
  if (fact.fact_type === "cure_performed") return [fact.value.performed_on, null];
  if (fact.fact_type === "inspection_result") return [fact.value.performed_on, null];
  if (fact.fact_type === "requirement_applicability") return [fact.value.decided_on, null];
  return [fact.value.decided_on, null];
}

function historyEvent(fact) {
  if (fact.supersedes_fact_id !== null) return "fact_corrected";
  if (fact.fact_type === "credential_period") return "period_established";
  return fact.fact_type;
}

function buildDetailProjection({ as_of: asOf, coverage, item: spec }) {
  const history = semantics.buildEffectiveHistory(spec.facts);
  const projectedItem = projectItem(spec, asOf, coverage);
  const events = history.entries.map(({ fact }) => {
    const [effectiveFrom, effectiveThrough] = historyDates(fact);
    return {
      event: historyEvent(fact),
      effective_from: effectiveFrom,
      effective_through: effectiveThrough,
      supersedes_fact_id: fact.supersedes_fact_id,
      reason: fact.correction_reason,
      evidence: uniqueReferences(fact.evidence.map((entry) => entry.reference)),
    };
  });
  const references = uniqueReferences([
    ...projectedItem.references,
    ...events.flatMap((event) => event.evidence),
  ]);
  const value = {
    contract_version: contracts.VERSIONS.detail,
    capability_classes: contracts.retrievalCapabilityReceipt(
      "canonical Compliance facts, effective history, and pure as-of derivation"),
    composition_authorization: "unsolved_cross_domain",
    as_of: asOf,
    item: projectedItem,
    history: events,
    references,
  };
  return contracts.validateDetail(value);
}

module.exports = { buildStandingProjection, buildDetailProjection };
