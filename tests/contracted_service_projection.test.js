"use strict";

const assert = require("assert");
const projection = require("../src/asset/contracted_service_projection.js");

const PROPERTY = "property-1";

function baseSnapshot() {
  return {
    property_id: PROPERTY,
    coverage_reviews: [{
      id: "review-1", property_id: PROPERTY, reviewed_as_of: "2026-08-01",
      provenance_note: "Reviewed against the management binder and current GL.",
      recorded_at: "2026-08-01T12:00:00Z",
    }],
    requirements: [{
      id: "req-clean", property_id: PROPERTY, service_class: "building_cleaning",
      service_label: "Building cleaning", determination: "contracted_service_required",
      effective_from: "2026-01-01", basis: "Common areas require weekday cleaning.",
    }],
    providers: [{ id: "provider-clean", provider_name: "Angel Cleaning Services LLC" }],
    engagements: [{
      id: "eng-clean", property_id: PROPERTY, service_class: "building_cleaning",
      service_label: "Building cleaning", provider_id: "provider-clean",
      engagement_label: "Common-area cleaning", effective_from: "2026-01-01",
    }],
    documents: [{
      id: "doc-clean", property_id: PROPERTY, engagement_id: "eng-clean",
      source_artifact_id: "artifact-clean", filename: "Cleaning agreement.pdf",
      document_kind: "agreement", execution_state: "executed",
      document_date: "2025-12-15", named_effective_date: "2026-01-01",
    }],
    terms: [{
      id: "term-clean", property_id: PROPERTY, engagement_id: "eng-clean",
      document_id: "doc-clean", term_authority: "governing",
      commencement_date: "2026-01-01", initial_end_date: "2027-01-01",
      term_kind: "fixed", automatic_renewal: false, notice_days: 30,
      recorded_at: "2026-01-02T12:00:00Z",
    }],
    scopes: [{
      id: "scope-clean", property_id: PROPERTY, engagement_id: "eng-clean",
      term_id: "term-clean", effective_from: "2026-01-01",
      scope_summary: "Clean residential common areas and restrooms.",
      frequency_summary: "Monday through Friday",
      source_artifact_id: "artifact-clean",
    }],
    locations: [{
      id: "location-clean", property_id: PROPERTY, scope_id: "scope-clean",
      location_kind: "common_area", location_label: "Residential common areas",
      effective_from: "2026-01-01",
    }],
    prices: [{
      id: "price-clean", property_id: PROPERTY, term_id: "term-clean",
      price_basis: "monthly", amount_cents: 680000, currency_code: "USD",
      description: "Base cleaning services",
    }],
    financial_observations: [],
    decision_links: [],
    obligations: [],
    users: [],
  };
}

{
  const read = projection.project({ property_id: PROPERTY }, { as_of: "2026-08-14" });
  assert.strictEqual(read.setup_state, "not_established");
  assert.strictEqual(read.detail.engagements.length, 0);
  assert.strictEqual(read.opening.requirements.length, 0);
  assert.strictEqual(read.detail.unresolved.length, 1);
  assert.strictEqual(read.detail.unresolved[0].concept, "coverage_review");
}

{
  const read = projection.project(baseSnapshot(), { as_of: "2026-08-14" });
  assert.strictEqual(read.setup_state, "established");
  assert.strictEqual(read.standing.governed_engagement_count, 1);
  assert.strictEqual(read.standing.attention_count, 0);
  assert.strictEqual(read.detail.unresolved.length, 0);
  assert.strictEqual(read.detail.engagements[0].execution_standing, "EXECUTED_GOVERNING");
  assert.strictEqual(read.detail.engagements[0].term_standing.state, "CURRENT");
  assert.strictEqual(read.detail.engagements[0].term_standing.current.prices[0].amount_cents, 680000);
  assert.strictEqual(read.detail.engagements[0].payment.truth_state, "NOT_ESTABLISHED");
  assert.strictEqual(read.detail.engagements[0].service_completion.truth_state, "NOT_ESTABLISHED");
}

{
  const snapshot = baseSnapshot();
  snapshot.coverage_reviews = [];
  snapshot.documents[0] = {
    ...snapshot.documents[0], document_kind: "proposal", execution_state: "unsigned",
    filename: "Cleaning proposal - unsigned.pdf",
  };
  snapshot.terms[0] = { ...snapshot.terms[0], term_authority: "offered" };
  snapshot.financial_observations = [{
    id: "obs-clean", property_id: PROPERTY, engagement_id: "eng-clean",
    observation_kind: "accounting_line", line_label: "Building Cleaning Contract",
    period_start: "2025-01-01", period_end: "2025-12-31", amount_cents: 8851000,
    source_artifact_id: "artifact-uw",
  }];
  const read = projection.project(snapshot, { as_of: "2026-08-14" });
  const engagement = read.detail.engagements[0];
  assert.strictEqual(read.setup_state, "partially_established");
  assert.strictEqual(engagement.execution_standing, "OFFERED_OR_UNSIGNED");
  assert.strictEqual(engagement.term_standing.state, "NOT_ESTABLISHED");
  assert.strictEqual(engagement.term_standing.offered.authority, "offered");
  assert.strictEqual(engagement.financial_observations[0].amount_cents, 8851000);
  assert(read.detail.unresolved.some((gap) => gap.concept === "governing_term"));
  assert(!read.standing.facts.some((fact) =>
    fact.concept === "engagement_authority" && fact.value === "executed_governing"));
}

{
  const snapshot = baseSnapshot();
  snapshot.documents[0].document_date = "2024-11-11";
  snapshot.terms[0] = {
    ...snapshot.terms[0], commencement_date: "2026-01-01", initial_end_date: "2027-01-01",
    automatic_renewal: true, renewal_period_months: 60, notice_days: 90,
  };
  const read = projection.project(snapshot, { as_of: "2026-10-15" });
  const engagement = read.detail.engagements[0];
  assert.strictEqual(engagement.term_standing.state, "ATTENTION");
  assert.strictEqual(engagement.term_standing.milestone.kind, "renewal_outcome_not_established");
  assert.strictEqual(engagement.term_standing.milestone.date, "2026-10-03");
  assert.strictEqual(engagement.term_standing.accountable_owner.state, "UNASSIGNED");
  assert(read.detail.unresolved.some((gap) => gap.concept === "decision_owner"));
  assert(!/renewed/i.test(engagement.term_standing.reason));
}

{
  const snapshot = baseSnapshot();
  snapshot.terms[0] = {
    ...snapshot.terms[0], commencement_date: "2026-01-01", initial_end_date: "2027-01-01",
    automatic_renewal: true, renewal_period_months: 60, notice_days: 90,
  };
  snapshot.documents.push({
    id: "doc-renewal", property_id: PROPERTY, engagement_id: "eng-clean",
    source_artifact_id: "artifact-renewal", filename: "Executed renewal.pdf",
    document_kind: "amendment", execution_state: "executed", document_date: "2026-09-15",
  });
  snapshot.terms.push({
    id: "term-renewal", property_id: PROPERTY, engagement_id: "eng-clean",
    document_id: "doc-renewal", term_authority: "governing",
    commencement_date: "2027-01-01", initial_end_date: "2032-01-01",
    term_kind: "fixed", automatic_renewal: false, notice_days: 90,
    recorded_at: "2026-09-16T12:00:00Z",
  });
  snapshot.prices.push({
    id: "price-renewal", property_id: PROPERTY, term_id: "term-renewal",
    price_basis: "monthly", amount_cents: 720000, currency_code: "USD",
  });
  const read = projection.project(snapshot, { as_of: "2026-10-15" });
  const standing = read.detail.engagements[0].term_standing;
  assert.strictEqual(standing.state, "CURRENT");
  assert.strictEqual(standing.successor.id, "term-renewal");
  assert.strictEqual(standing.milestone, null);
  assert(!read.detail.unresolved.some((gap) => gap.concept === "decision_owner"));
}

{
  const snapshot = baseSnapshot();
  snapshot.terms[0] = {
    ...snapshot.terms[0], commencement_date: "2026-01-01", initial_end_date: "2027-01-01",
    automatic_renewal: true, renewal_period_months: 60, notice_days: 90,
  };
  snapshot.documents.push({
    id: "doc-distant", property_id: PROPERTY, engagement_id: "eng-clean",
    source_artifact_id: "artifact-distant", document_kind: "agreement",
    execution_state: "executed",
  });
  snapshot.terms.push({
    id: "term-distant", property_id: PROPERTY, engagement_id: "eng-clean",
    document_id: "doc-distant", term_authority: "governing",
    commencement_date: "2028-01-01", initial_end_date: "2029-01-01",
    term_kind: "fixed", automatic_renewal: false, notice_days: 30,
  });
  const read = projection.project(snapshot, { as_of: "2026-10-15" });
  const standing = read.detail.engagements[0].term_standing;
  assert.strictEqual(standing.state, "ATTENTION");
  assert.strictEqual(standing.successor, null);
  assert.strictEqual(standing.milestone.kind, "renewal_outcome_not_established");
}

{
  const snapshot = baseSnapshot();
  snapshot.terms[0] = {
    ...snapshot.terms[0], commencement_date: "2026-01-01", initial_end_date: "2027-01-01",
    automatic_renewal: true, renewal_period_months: 36, notice_days: 90,
  };
  const read = projection.project(snapshot, { as_of: "2027-02-01" });
  assert.strictEqual(read.detail.engagements[0].term_standing.state, "OUTCOME_NOT_ESTABLISHED");
  assert(read.detail.unresolved.some((gap) => gap.concept === "current_authority"));
}

{
  const snapshot = baseSnapshot();
  snapshot.terms[0] = {
    ...snapshot.terms[0], commencement_date: "2026-01-01", initial_end_date: "2027-01-01",
    automatic_renewal: false, notice_days: null, term_kind: "fixed",
  };
  const read = projection.project(snapshot, { as_of: "2027-02-01" });
  assert.strictEqual(read.detail.engagements[0].term_standing.state, "ENDED");
  assert.strictEqual(read.detail.engagements[0].term_standing.milestone.kind, "term_ended");
}

{
  const snapshot = baseSnapshot();
  snapshot.financial_observations.push({
    id: "obs-fire", property_id: PROPERTY, engagement_id: null,
    service_class: "fire_alarm_monitoring", observation_kind: "accounting_line",
    line_label: "Fire Alarm Service", period_start: "2025-01-01", period_end: "2025-12-31",
    amount_cents: 2053009, source_artifact_id: "artifact-t12",
  });
  const read = projection.project(snapshot, { as_of: "2026-08-14" });
  assert.strictEqual(read.standing.unmatched_financial_observation_count, 1);
  assert.strictEqual(read.detail.unmatched_financial_observations[0].label, "Fire alarm monitoring");
  assert(read.detail.unresolved.some((gap) => gap.concept === "unmatched_financial_observation"));
  assert.strictEqual(read.setup_state, "partially_established");
}

{
  const snapshot = baseSnapshot();
  snapshot.documents.push({
    id: "doc-unmatched", property_id: PROPERTY, engagement_id: null,
    source_artifact_id: "artifact-generator", filename: "Generator proposal.pdf",
    document_kind: "proposal", execution_state: "unsigned", document_date: "2023-01-12",
  });
  const read = projection.project(snapshot, { as_of: "2026-08-14" });
  assert.strictEqual(read.standing.unmatched_document_count, 1);
  assert.strictEqual(read.detail.unmatched_documents[0].filename, "Generator proposal.pdf");
  assert(read.detail.unresolved.some((gap) => gap.concept === "unmatched_service_document"));
}

{
  const snapshot = baseSnapshot();
  snapshot.terms[0] = {
    ...snapshot.terms[0], commencement_date: null, initial_end_date: null,
    term_kind: "unknown", automatic_renewal: true, renewal_period_months: 60,
  };
  const read = projection.project(snapshot, { as_of: "2026-08-14" });
  const standing = read.detail.engagements[0].term_standing;
  assert.strictEqual(standing.state, "OUTCOME_NOT_ESTABLISHED");
  assert.strictEqual(standing.milestone.kind, "term_dates_not_established");
  assert(!/ended/i.test(standing.reason));
}

{
  const snapshot = baseSnapshot();
  snapshot.providers.push({ id: "provider-observed", provider_name: "Observed Provider" });
  snapshot.financial_observations.push({
    id: "obs-conflict", property_id: PROPERTY, engagement_id: null,
    service_class: "building_cleaning", provider_id: "provider-observed",
    observation_kind: "invoice", line_label: "Building Cleaning Contract",
    period_start: "2026-06-01", period_end: "2026-06-30", amount_cents: 155000,
  });
  const read = projection.project(snapshot, { as_of: "2026-08-14" });
  const gap = read.detail.unresolved.find((row) =>
    row.financial_observation_id === "obs-conflict");
  assert(gap.question.includes("replace or supplement"));
  assert.strictEqual(gap.engagement_id, "eng-clean");
}

{
  const snapshot = baseSnapshot();
  snapshot.documents[0].execution_state = "unsigned";
  const read = projection.project(snapshot, { as_of: "2026-08-14" });
  assert.strictEqual(read.detail.engagements[0].execution_standing, "OFFERED_OR_UNSIGNED");
  assert.strictEqual(read.detail.engagements[0].term_standing.state, "NOT_ESTABLISHED");
  assert(read.detail.unresolved.some((gap) => gap.concept === "document_execution"));
}

{
  const snapshot = baseSnapshot();
  snapshot.providers.push({ id: "provider-shared", provider_name: "Building Systems Co." });
  snapshot.engagements.push(
    { id: "eng-fire", property_id: PROPERTY, service_class: "fire_alarm_monitoring",
      provider_id: "provider-shared", effective_from: "2026-01-01" },
    { id: "eng-sprinkler", property_id: PROPERTY, service_class: "fire_sprinkler_service",
      provider_id: "provider-shared", effective_from: "2026-01-01" },
  );
  const read = projection.project(snapshot, { as_of: "2026-08-14" });
  const shared = read.detail.engagements.filter((row) => row.provider
    && row.provider.id === "provider-shared");
  assert.strictEqual(shared.length, 2);
  assert.notStrictEqual(shared[0].id, shared[1].id);
}

console.log("contracted service projection tests passed");
