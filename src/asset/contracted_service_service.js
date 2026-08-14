"use strict";

const contract = require("./contracted_service_contract.js");
const { GOVERNING_DOCUMENT_KINDS } = require("./contracted_service_projection.js");

function contractedServiceError(code, message, extra = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, extra);
  return error;
}

function requireProperty(propertyId) {
  if (!propertyId) throw contractedServiceError("BAD_INPUT", "property_id is required");
}

function requireUser(userId) {
  if (!userId) throw contractedServiceError("BAD_INPUT", "user_id is required");
}

function requireDate(name, value, { nullable = false } = {}) {
  if (nullable && (value === null || value === undefined || value === "")) return null;
  const text = String(value || "");
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  const date = match
    ? new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))) : null;
  if (!match || date.getUTCFullYear() !== Number(match[1])
      || date.getUTCMonth() + 1 !== Number(match[2])
      || date.getUTCDate() !== Number(match[3])) {
    throw contractedServiceError("BAD_INPUT", `${name} must be an ISO date`);
  }
  return text;
}

function requireRange(startName, start, endName, end) {
  if (start && end && String(end) <= String(start)) {
    throw contractedServiceError("BAD_INPUT", `${endName} must be after ${startName}`);
  }
}

function requireBoolean(name, value, { nullable = false } = {}) {
  if (nullable && (value === null || value === undefined)) return null;
  if (typeof value !== "boolean") {
    throw contractedServiceError("BAD_INPUT", `${name} must be true or false`);
  }
  return value;
}

function requirePositiveInteger(name, value, { nullable = false, allowZero = false } = {}) {
  if (nullable && (value === null || value === undefined)) return null;
  if (!Number.isSafeInteger(value) || (allowZero ? value < 0 : value <= 0)) {
    throw contractedServiceError("BAD_INPUT",
      `${name} must be ${allowZero ? "a non-negative" : "a positive"} safe integer`);
  }
  return value;
}

function requireCents(name, value, { nullable = false } = {}) {
  if (nullable && (value === null || value === undefined)) return null;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw contractedServiceError("BAD_INPUT", `${name} must be a non-negative safe integer of cents`);
  }
  return value;
}

function requireText(name, value) {
  const text = String(value || "").trim();
  if (!text) throw contractedServiceError("BAD_INPUT", `${name} is required`);
  return text;
}

function requireServiceClass(value) {
  if (!contract.isOpenServiceKey(value)) {
    throw contractedServiceError("BAD_INPUT",
      "service_class must be an open lower_snake_case service key");
  }
}

function requireProvenance(sourceArtifactId, note, what, { artifactRequired = false } = {}) {
  if (artifactRequired && !sourceArtifactId) {
    throw contractedServiceError("SOURCE_REQUIRED", `${what} requires a retained source artifact`);
  }
  if (!sourceArtifactId && !String(note || "").trim()) {
    throw contractedServiceError("PROVENANCE_REQUIRED",
      `${what} requires a source artifact or a plain account of where the fact came from`);
  }
}

function requireRevisionReason(supersedesId, revisionReason) {
  if (supersedesId && !String(revisionReason || "").trim()) {
    throw contractedServiceError("REVISION_REASON_REQUIRED",
      "a correction must say why the earlier fact is being superseded");
  }
}

async function assertProperty(client, propertyId) {
  const row = (await client.query("select id from properties where id = $1", [propertyId])).rows[0];
  if (!row) throw contractedServiceError("NOT_FOUND", "property not found");
}

async function assertArtifact(client, propertyId, artifactId) {
  if (!artifactId) return null;
  const row = (await client.query(
    "select id, scope_type, scope_id from source_artifacts where id = $1", [artifactId])).rows[0];
  if (!row) throw contractedServiceError("SOURCE_NOT_FOUND", "source artifact not found");
  if (row.scope_type !== "property" || String(row.scope_id) !== String(propertyId)) {
    throw contractedServiceError("SOURCE_SCOPE_MISMATCH",
      "contracted-service evidence must be retained for the same property");
  }
  return row;
}

async function assertOwned(client, table, id, propertyId, label) {
  const allowed = new Set([
    "contracted_service_requirements", "contracted_service_engagements",
    "contracted_service_documents", "contracted_service_terms",
    "contracted_service_scopes", "contracted_service_financial_observations",
  ]);
  if (!allowed.has(table)) throw new Error("contracted_service_service assertOwned table is not allowlisted");
  const row = (await client.query(
    `select * from ${table} where id = $1 and property_id = $2`, [id, propertyId])).rows[0];
  if (!row) throw contractedServiceError("NOT_FOUND", `${label} not found for this property`);
  return row;
}

async function assertProvider(client, providerId) {
  const row = (await client.query(
    "select id, provider_name from contracted_service_providers where id = $1", [providerId])).rows[0];
  if (!row) throw contractedServiceError("NOT_FOUND", "contracted-service provider not found");
  return row;
}

async function assertCorrectionDate(client, table, supersedesId, propertyId, dateColumn,
  effectiveDate, label) {
  if (!supersedesId) return null;
  const prior = await assertOwned(client, table, supersedesId, propertyId, label);
  if (String(prior[dateColumn] || "").slice(0, 10) !== String(effectiveDate || "").slice(0, 10)) {
    throw contractedServiceError("BAD_INPUT",
      `a corrected ${label} must retain the earlier fact's ${dateColumn} date`);
  }
  return prior;
}

async function recordCoverageReview(client, {
  property_id, reviewed_as_of, source_artifact_id = null, provenance_note = null, user_id,
} = {}) {
  requireProperty(property_id); requireUser(user_id); requireDate("reviewed_as_of", reviewed_as_of);
  requireProvenance(source_artifact_id, provenance_note, "a service coverage review");
  await assertProperty(client, property_id);
  await assertArtifact(client, property_id, source_artifact_id);
  return (await client.query(
    `insert into contracted_service_coverage_reviews
       (property_id, reviewed_as_of, source_artifact_id, provenance_note, reviewed_by_user_id)
     values ($1,$2,$3,$4,$5) returning *`,
    [property_id, reviewed_as_of, source_artifact_id,
     provenance_note && String(provenance_note).trim(), user_id])).rows[0];
}

async function recordRequirement(client, {
  property_id, service_class, service_label = null, determination, basis,
  effective_from, effective_to = null, source_artifact_id = null,
  provenance_note = null, supersedes_id = null, revision_reason = null, user_id,
} = {}) {
  requireProperty(property_id); requireUser(user_id); requireServiceClass(service_class);
  requireDate("effective_from", effective_from); requireDate("effective_to", effective_to,
    { nullable: true });
  requireRange("effective_from", effective_from, "effective_to", effective_to);
  contract.enumValue("determination", determination, contract.REQUIREMENT_DETERMINATIONS);
  requireProvenance(source_artifact_id, provenance_note || basis, "a service requirement");
  requireRevisionReason(supersedes_id, revision_reason);
  await assertProperty(client, property_id);
  await assertArtifact(client, property_id, source_artifact_id);
  await assertCorrectionDate(client, "contracted_service_requirements", supersedes_id,
    property_id, "effective_from", effective_from, "service requirement");
  return (await client.query(
    `insert into contracted_service_requirements
       (property_id, service_class, service_label, determination, basis,
        effective_from, effective_to, source_artifact_id, provenance_note,
        supersedes_id, revision_reason, recorded_by_user_id)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning *`,
    [property_id, service_class, service_label && String(service_label).trim(), determination,
     basis && String(basis).trim(), effective_from, effective_to, source_artifact_id,
     provenance_note && String(provenance_note).trim(), supersedes_id,
     revision_reason && String(revision_reason).trim(), user_id])).rows[0];
}

async function establishProvider(client, {
  property_id, provider_name, source_artifact_id = null, provenance_note = null, user_id,
} = {}) {
  requireProperty(property_id); requireUser(user_id);
  const name = requireText("provider_name", provider_name);
  requireProvenance(source_artifact_id, provenance_note, "a contracted-service provider");
  await assertProperty(client, property_id);
  await assertArtifact(client, property_id, source_artifact_id);
  const row = (await client.query(
    `insert into contracted_service_providers
       (provider_name, source_artifact_id, provenance_note, created_by_user_id)
     values ($1,$2,$3,$4) returning *`,
    [name, source_artifact_id, provenance_note && String(provenance_note).trim(), user_id])).rows[0];
  return row ? { id: row.id, provider_name: row.provider_name } : null;
}

async function findProviderCandidates(client, { provider_name } = {}) {
  const name = requireText("provider_name", provider_name);
  const rows = (await client.query(
    `select id, provider_name from contracted_service_providers
      where lower(btrim(provider_name)) = lower(btrim($1))
      order by provider_name, id`, [name])).rows || [];
  return rows.map((row) => ({ id: row.id, provider_name: row.provider_name }));
}

async function createEngagement(client, {
  property_id, service_class, service_label = null, provider_id,
  engagement_label = null, effective_from = null, effective_to = null,
  source_artifact_id = null, provenance_note = null, user_id,
} = {}) {
  requireProperty(property_id); requireUser(user_id); requireServiceClass(service_class);
  requireDate("effective_from", effective_from, { nullable: true });
  requireDate("effective_to", effective_to, { nullable: true });
  requireRange("effective_from", effective_from, "effective_to", effective_to);
  requireProvenance(source_artifact_id, provenance_note, "a service engagement");
  await assertProperty(client, property_id);
  await assertProvider(client, provider_id);
  await assertArtifact(client, property_id, source_artifact_id);
  return (await client.query(
    `insert into contracted_service_engagements
       (property_id, service_class, service_label, provider_id, engagement_label,
        effective_from, effective_to, source_artifact_id, provenance_note, created_by_user_id)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning *`,
    [property_id, service_class, service_label && String(service_label).trim(), provider_id,
     engagement_label && String(engagement_label).trim(), effective_from, effective_to,
     source_artifact_id, provenance_note && String(provenance_note).trim(), user_id])).rows[0];
}

async function confirmDocument(client, {
  property_id, engagement_id = null, source_artifact_id, document_kind,
  execution_state, document_date = null, named_effective_date = null,
  filename = null, supersedes_id = null, revision_reason = null,
  provenance_note = null, user_id,
} = {}) {
  requireProperty(property_id); requireUser(user_id);
  contract.enumValue("document_kind", document_kind, contract.DOCUMENT_KINDS);
  contract.enumValue("execution_state", execution_state, contract.EXECUTION_STATES);
  requireDate("document_date", document_date, { nullable: true });
  requireDate("named_effective_date", named_effective_date, { nullable: true });
  requireProvenance(source_artifact_id, provenance_note, "a service document",
    { artifactRequired: true });
  requireRevisionReason(supersedes_id, revision_reason);
  await assertProperty(client, property_id);
  await assertArtifact(client, property_id, source_artifact_id);
  if (engagement_id) {
    await assertOwned(client, "contracted_service_engagements", engagement_id,
      property_id, "service engagement");
  }
  if (supersedes_id) {
    const prior = await assertOwned(client, "contracted_service_documents", supersedes_id,
      property_id, "service document confirmation");
    if (String(prior.source_artifact_id) !== String(source_artifact_id)) {
      throw contractedServiceError("BAD_INPUT",
        "a corrected document confirmation must refer to the same retained source artifact");
    }
  }
  return (await client.query(
    `insert into contracted_service_documents
       (property_id, engagement_id, source_artifact_id, document_kind, execution_state,
        document_date, named_effective_date, filename, supersedes_id, revision_reason,
        provenance_note, confirmed_by_user_id)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning *`,
    [property_id, engagement_id, source_artifact_id, document_kind, execution_state,
     document_date, named_effective_date, filename && String(filename).trim(), supersedes_id,
     revision_reason && String(revision_reason).trim(),
     provenance_note && String(provenance_note).trim(), user_id])).rows[0];
}

async function recordTerm(client, {
  property_id, engagement_id, document_id, term_authority,
  commencement_date = null, commencement_trigger = null,
  initial_end_date = null, initial_term_months = null, term_kind,
  automatic_renewal = null, renewal_period_months = null, notice_days = null,
  continues_until_terminated = false, termination_for_convenience = null,
  source_artifact_id = null, provenance_note = null,
  supersedes_id = null, revision_reason = null, user_id,
} = {}) {
  requireProperty(property_id); requireUser(user_id);
  contract.enumValue("term_authority", term_authority, contract.TERM_AUTHORITIES);
  contract.enumValue("term_kind", term_kind, contract.TERM_KINDS);
  requireDate("commencement_date", commencement_date, { nullable: true });
  requireDate("initial_end_date", initial_end_date, { nullable: true });
  const trigger = commencement_trigger === null || commencement_trigger === undefined
    ? null : String(commencement_trigger).trim();
  if (trigger && trigger.length > 500) {
    throw contractedServiceError("BAD_INPUT", "commencement_trigger must be 500 characters or fewer");
  }
  requirePositiveInteger("initial_term_months", initial_term_months, { nullable: true });
  requireBoolean("automatic_renewal", automatic_renewal, { nullable: true });
  requireBoolean("continues_until_terminated", continues_until_terminated);
  requireBoolean("termination_for_convenience", termination_for_convenience, { nullable: true });
  requirePositiveInteger("renewal_period_months", renewal_period_months, { nullable: true });
  requirePositiveInteger("notice_days", notice_days, { nullable: true, allowZero: true });
  requireProvenance(source_artifact_id, provenance_note, "service terms");
  requireRevisionReason(supersedes_id, revision_reason);
  const hasCalendarTerm = !!(commencement_date && initial_end_date);
  const hasEventTerm = !!(trigger && initial_term_months);
  if (term_kind === "fixed" && !hasCalendarTerm && !hasEventTerm) {
    throw contractedServiceError("BAD_INPUT",
      "a fixed term requires calendar dates or a commencement trigger and initial duration");
  }
  if ((trigger && !initial_term_months) || (!trigger && initial_term_months)) {
    throw contractedServiceError("BAD_INPUT",
      "an event-anchored term requires both commencement_trigger and initial_term_months");
  }
  requireRange("commencement_date", commencement_date, "initial_end_date", initial_end_date);
  if (automatic_renewal === true && !renewal_period_months) {
    throw contractedServiceError("BAD_INPUT",
      "automatic renewal requires the stated renewal period in months");
  }
  await assertOwned(client, "contracted_service_engagements", engagement_id,
    property_id, "service engagement");
  const document = await assertOwned(client, "contracted_service_documents", document_id,
    property_id, "service document");
  if (document.engagement_id && String(document.engagement_id) !== String(engagement_id)) {
    throw contractedServiceError("BAD_INPUT", "the service document belongs to another engagement");
  }
  if (term_authority === "governing"
      && (document.execution_state !== "executed"
          || !GOVERNING_DOCUMENT_KINDS.includes(document.document_kind))) {
    throw contractedServiceError("EXECUTED_GOVERNING_SOURCE_REQUIRED",
      "governing terms require an executed agreement, statement of work, amendment, or addendum");
  }
  if (source_artifact_id
      && String(document.source_artifact_id) !== String(source_artifact_id)) {
    throw contractedServiceError("BAD_INPUT",
      "service terms must cite the retained source attached to their service document");
  }
  await assertArtifact(client, property_id, source_artifact_id);
  const priorTerm = await assertCorrectionDate(client, "contracted_service_terms", supersedes_id,
    property_id, "commencement_date", commencement_date, "service term");
  if (priorTerm && String(priorTerm.commencement_trigger || "") !== String(trigger || "")) {
    throw contractedServiceError("BAD_INPUT",
      "a corrected service term must retain the earlier commencement_trigger");
  }
  return (await client.query(
    `insert into contracted_service_terms
       (property_id, engagement_id, document_id, term_authority,
        commencement_date, commencement_trigger, initial_end_date, initial_term_months,
        term_kind, automatic_renewal, renewal_period_months, notice_days,
        continues_until_terminated, termination_for_convenience, source_artifact_id,
        provenance_note, supersedes_id, revision_reason, recorded_by_user_id)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
     returning *`,
    [property_id, engagement_id, document_id, term_authority, commencement_date, trigger,
     initial_end_date, initial_term_months, term_kind, automatic_renewal,
     renewal_period_months, notice_days, !!continues_until_terminated,
     termination_for_convenience, source_artifact_id,
     provenance_note && String(provenance_note).trim(), supersedes_id,
     revision_reason && String(revision_reason).trim(), user_id])).rows[0];
}

async function recordScope(client, {
  property_id, engagement_id, term_id = null, scope_summary,
  frequency_summary = null, exclusions_summary = null,
  effective_from, effective_to = null, source_artifact_id = null, provenance_note = null,
  supersedes_id = null, revision_reason = null, user_id,
} = {}) {
  requireProperty(property_id); requireUser(user_id); requireDate("effective_from", effective_from);
  requireDate("effective_to", effective_to, { nullable: true });
  requireRange("effective_from", effective_from, "effective_to", effective_to);
  const summary = requireText("scope_summary", scope_summary);
  requireProvenance(source_artifact_id, provenance_note, "a service scope");
  requireRevisionReason(supersedes_id, revision_reason);
  await assertOwned(client, "contracted_service_engagements", engagement_id,
    property_id, "service engagement");
  if (term_id) {
    const term = await assertOwned(client, "contracted_service_terms", term_id,
      property_id, "service term");
    if (String(term.engagement_id) !== String(engagement_id)) {
      throw contractedServiceError("BAD_INPUT", "the service term belongs to another engagement");
    }
  }
  await assertArtifact(client, property_id, source_artifact_id);
  await assertCorrectionDate(client, "contracted_service_scopes", supersedes_id,
    property_id, "effective_from", effective_from, "service scope");
  return (await client.query(
    `insert into contracted_service_scopes
       (property_id, engagement_id, term_id, scope_summary, frequency_summary,
        exclusions_summary, effective_from, effective_to, source_artifact_id,
        provenance_note, supersedes_id, revision_reason, recorded_by_user_id)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) returning *`,
    [property_id, engagement_id, term_id, summary,
     frequency_summary && String(frequency_summary).trim(),
     exclusions_summary && String(exclusions_summary).trim(), effective_from, effective_to,
     source_artifact_id, provenance_note && String(provenance_note).trim(), supersedes_id,
     revision_reason && String(revision_reason).trim(), user_id])).rows[0];
}

async function recordLocation(client, {
  property_id, scope_id, location_kind, location_label,
  unit_id = null, space_id = null, effective_from, effective_to = null, user_id,
} = {}) {
  requireProperty(property_id); requireUser(user_id); requireDate("effective_from", effective_from);
  requireDate("effective_to", effective_to, { nullable: true });
  requireRange("effective_from", effective_from, "effective_to", effective_to);
  contract.enumValue("location_kind", location_kind, contract.LOCATION_KINDS);
  const label = requireText("location_label", location_label);
  await assertOwned(client, "contracted_service_scopes", scope_id, property_id, "service scope");
  return (await client.query(
    `insert into contracted_service_locations
       (property_id, scope_id, location_kind, location_label, unit_id, space_id,
        effective_from, effective_to, recorded_by_user_id)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning *`,
    [property_id, scope_id, location_kind, label, unit_id, space_id,
     effective_from, effective_to, user_id])).rows[0];
}

async function recordPriceComponent(client, {
  property_id, term_id, price_basis, amount_cents = null, currency_code = "USD",
  quantity_basis = null, description = null, user_id,
} = {}) {
  requireProperty(property_id); requireUser(user_id);
  contract.enumValue("price_basis", price_basis, contract.PRICE_BASES);
  const normalizedAmount = requireCents("amount_cents", amount_cents, { nullable: true });
  if (price_basis !== "variable" && normalizedAmount === null) {
    throw contractedServiceError("BAD_INPUT", "a non-variable price component requires amount_cents");
  }
  if (normalizedAmount === null && !String(description || "").trim()) {
    throw contractedServiceError("BAD_INPUT", "unknown or variable pricing requires a description");
  }
  await assertOwned(client, "contracted_service_terms", term_id, property_id, "service term");
  return (await client.query(
    `insert into contracted_service_price_components
       (property_id, term_id, price_basis, amount_cents, currency_code,
        quantity_basis, description, recorded_by_user_id)
     values ($1,$2,$3,$4,$5,$6,$7,$8) returning *`,
    [property_id, term_id, price_basis, normalizedAmount, currency_code,
     quantity_basis && String(quantity_basis).trim(),
     description && String(description).trim(), user_id])).rows[0];
}

async function recordFinancialObservation(client, {
  property_id, engagement_id = null, service_class = null, service_label = null,
  provider_id = null, source_artifact_id, observation_kind, line_label = null,
  period_start = null, period_end = null, amount_cents = null, currency_code = "USD",
  provenance_note = null, supersedes_id = null, revision_reason = null, user_id,
} = {}) {
  requireProperty(property_id); requireUser(user_id);
  contract.enumValue("observation_kind", observation_kind,
    contract.FINANCIAL_OBSERVATION_KINDS);
  if (service_class) requireServiceClass(service_class);
  requireDate("period_start", period_start, { nullable: true });
  requireDate("period_end", period_end, { nullable: true });
  requireRange("period_start", period_start, "period_end", period_end);
  requireCents("amount_cents", amount_cents, { nullable: true });
  requireProvenance(source_artifact_id, provenance_note, "a financial observation",
    { artifactRequired: true });
  requireRevisionReason(supersedes_id, revision_reason);
  if (!engagement_id && !service_class && !provider_id && !String(line_label || "").trim()) {
    throw contractedServiceError("BAD_INPUT",
      "a financial observation must identify an engagement, service, provider, or source line");
  }
  if (engagement_id) {
    await assertOwned(client, "contracted_service_engagements", engagement_id,
      property_id, "service engagement");
  }
  if (provider_id) await assertProvider(client, provider_id);
  await assertArtifact(client, property_id, source_artifact_id);
  if (supersedes_id) {
    await assertOwned(client, "contracted_service_financial_observations", supersedes_id,
      property_id, "financial observation");
  }
  return (await client.query(
    `insert into contracted_service_financial_observations
       (property_id, engagement_id, service_class, service_label, provider_id,
        source_artifact_id, observation_kind, line_label, period_start, period_end,
        amount_cents, currency_code, provenance_note, supersedes_id, revision_reason,
        observed_by_user_id)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
     returning *`,
    [property_id, engagement_id, service_class,
     service_label && String(service_label).trim(), provider_id, source_artifact_id,
     observation_kind, line_label && String(line_label).trim(), period_start, period_end,
     amount_cents, currency_code, provenance_note && String(provenance_note).trim(),
     supersedes_id, revision_reason && String(revision_reason).trim(), user_id])).rows[0];
}

async function linkDecision(client, {
  property_id, engagement_id, obligation_id, decision_kind,
  term_id = null, user_id,
} = {}) {
  requireProperty(property_id); requireUser(user_id);
  const kind = requireText("decision_kind", decision_kind);
  await assertOwned(client, "contracted_service_engagements", engagement_id,
    property_id, "service engagement");
  if (term_id) {
    const term = await assertOwned(client, "contracted_service_terms", term_id,
      property_id, "service term");
    if (String(term.engagement_id) !== String(engagement_id)) {
      throw contractedServiceError("BAD_INPUT", "the service term belongs to another engagement");
    }
  }
  const obligation = (await client.query(
    "select id from obligations where id = $1 and property_id = $2",
    [obligation_id, property_id])).rows[0];
  if (!obligation) throw contractedServiceError("NOT_FOUND", "decision obligation not found for this property");
  return (await client.query(
    `insert into contracted_service_decision_links
       (property_id, engagement_id, obligation_id, decision_kind, term_id, linked_by_user_id)
     values ($1,$2,$3,$4,$5,$6) returning *`,
    [property_id, engagement_id, obligation_id, kind, term_id, user_id])).rows[0];
}

module.exports = {
  contractedServiceError,
  recordCoverageReview,
  recordRequirement,
  establishProvider,
  findProviderCandidates,
  createEngagement,
  confirmDocument,
  recordTerm,
  recordScope,
  recordLocation,
  recordPriceComponent,
  recordFinancialObservation,
  linkDecision,
};
