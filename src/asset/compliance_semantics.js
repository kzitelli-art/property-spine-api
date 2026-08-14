"use strict";

const factContracts = require("./compliance_fact_contracts.js");

function buildEffectiveHistory(facts) {
  factContracts.validateFactList(facts);
  const byId = new Map();
  for (const fact of facts) {
    if (byId.has(fact.fact_id)) throw new TypeError(`duplicate fact_id: ${fact.fact_id}`);
    byId.set(fact.fact_id, fact);
  }

  const supersededIds = new Set();
  for (const fact of facts) {
    if (fact.supersedes_fact_id === null) continue;
    const prior = byId.get(fact.supersedes_fact_id);
    if (!prior) throw new TypeError(`${fact.fact_id} supersedes an unknown fact`);
    if (prior.fact_type !== fact.fact_type) {
      throw new TypeError(`${fact.fact_id} cannot correct a different fact type`);
    }
    if (prior.established_at >= fact.established_at) {
      throw new TypeError(`${fact.fact_id} correction must be established after its target`);
    }
    supersededIds.add(prior.fact_id);
  }

  const ordered = [...facts].sort((left, right) =>
    left.established_at.localeCompare(right.established_at) || left.fact_id.localeCompare(right.fact_id));
  const effective = ordered.filter((fact) => !supersededIds.has(fact.fact_id));
  const correctionTargets = new Map();
  for (const fact of effective) {
    if (fact.supersedes_fact_id === null) continue;
    const branch = correctionTargets.get(fact.supersedes_fact_id) || [];
    branch.push(fact.fact_id);
    correctionTargets.set(fact.supersedes_fact_id, branch);
  }
  return Object.freeze({
    entries: Object.freeze(ordered.map((fact) => Object.freeze({
      fact,
      change: fact.supersedes_fact_id === null ? "establishment" : "correction",
      effect: supersededIds.has(fact.fact_id) ? "superseded" : "effective",
    }))),
    effective_facts: Object.freeze(effective),
    superseded_facts: Object.freeze(ordered.filter((fact) => supersededIds.has(fact.fact_id))),
    correction_conflicts: Object.freeze([...correctionTargets.values()]
      .filter((branch) => branch.length > 1)
      .flat()),
  });
}

function validateAsOf(asOf) {
  if (typeof asOf !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(asOf)) {
    throw new TypeError("as_of must be an ISO date");
  }
  const [year, month, day] = asOf.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() + 1 !== month ||
      parsed.getUTCDate() !== day) {
    throw new TypeError("as_of must be a real calendar date");
  }
}

function unresolved(code, detail) {
  return Object.freeze({ code, detail });
}

function credentialResult(code, asOf, basis, period, factIds, unresolvedItems, next) {
  return Object.freeze({
    code,
    as_of: asOf,
    why: Object.freeze({
      basis,
      effective_from: period ? period.value.effective_from : null,
      effective_through: period ? period.value.effective_through : null,
    }),
    decisive_fact_ids: Object.freeze(factIds),
    unresolved: Object.freeze(unresolvedItems),
    next,
  });
}

function deriveCredentialStanding(facts, asOf) {
  validateAsOf(asOf);
  const history = buildEffectiveHistory(facts);
  const periods = history.effective_facts.filter((fact) => fact.fact_type === "credential_period");
  if (history.correction_conflicts.length > 0) {
    return credentialResult(
      "conflicted", asOf, "conflicting_established_periods", null,
      history.correction_conflicts,
      [unresolved("credential_correction_conflict", "Multiple effective corrections branch from one credential fact.")],
      null);
  }
  const covering = periods.filter((fact) =>
    fact.value.effective_from <= asOf && fact.value.effective_through >= asOf);

  if (covering.length > 1) {
    return credentialResult(
      "conflicted", asOf, "conflicting_established_periods", null,
      covering.map((fact) => fact.fact_id),
      [unresolved("credential_period_conflict", "Multiple effective credential periods cover the as-of date.")],
      null);
  }
  if (covering.length === 1) {
    const fact = covering[0];
    return credentialResult(
      "current", asOf, "established_credential_period", fact, [fact.fact_id],
      [unresolved("renewal_not_established", "A period end date is not an established renewal obligation.")],
      Object.freeze({ date: fact.value.effective_through, action: "Credential period ends", state: "date_only" }));
  }
  if (periods.length === 0) {
    return credentialResult(
      "not_established", asOf, "insufficient_canonical_facts", null, [],
      [unresolved("credential_period_not_established", "No credential period has been established.")], null);
  }

  const prior = periods
    .filter((fact) => fact.value.effective_through < asOf)
    .sort((left, right) => right.value.effective_through.localeCompare(left.value.effective_through));
  const future = periods
    .filter((fact) => fact.value.effective_from > asOf)
    .sort((left, right) => left.value.effective_from.localeCompare(right.value.effective_from));

  if (prior.length > 0) {
    const next = future.length > 0
      ? Object.freeze({ date: future[0].value.effective_from, action: "Credential period begins", state: "date_only" })
      : null;
    return credentialResult(
      "no_current_period_established", asOf, "credential_history_without_covering_period",
      prior[0], [prior[0].fact_id],
      [
        unresolved("covering_period_not_established", "No established credential period covers the as-of date."),
        unresolved("renewal_not_established", "An ended period is not an established renewal obligation."),
      ], next);
  }

  const first = future[0];
  return credentialResult(
    "not_yet_effective", asOf, "future_credential_period", first, [first.fact_id],
    [unresolved("covering_period_not_established", "The established credential period has not begun as of this date.")],
    Object.freeze({ date: first.value.effective_from, action: "Credential period begins", state: "date_only" }));
}

function findingDate(fact) {
  if (fact.fact_type === "finding_issued") return fact.value.issued_on;
  if (fact.fact_type === "payment_observed") return fact.value.observed_on;
  if (fact.fact_type === "cure_performed") return fact.value.performed_on;
  return fact.value.decided_on;
}

function findingResult(code, asOf, basis, decisiveFacts, unresolvedItems) {
  const dates = decisiveFacts.map(findingDate).sort();
  return Object.freeze({
    code,
    as_of: asOf,
    why: Object.freeze({
      basis,
      effective_from: dates.length > 0 ? dates[0] : null,
      effective_through: null,
    }),
    decisive_fact_ids: Object.freeze(decisiveFacts.map((fact) => fact.fact_id)),
    unresolved: Object.freeze(unresolvedItems),
    next: null,
  });
}

function deriveFindingStanding(facts, asOf) {
  validateAsOf(asOf);
  const history = buildEffectiveHistory(facts);
  if (history.correction_conflicts.length > 0) {
    const conflicted = history.effective_facts
      .filter((fact) => history.correction_conflicts.includes(fact.fact_id));
    return findingResult(
      "conflicted", asOf, "conflicting_finding_facts", conflicted,
      [unresolved("finding_correction_conflict", "Multiple effective corrections branch from one finding fact.")]);
  }
  const effective = history.effective_facts.filter((fact) => findingDate(fact) <= asOf);
  const issued = effective.filter((fact) => fact.fact_type === "finding_issued");
  const cures = effective.filter((fact) => fact.fact_type === "cure_performed")
    .sort((left, right) => findingDate(left).localeCompare(findingDate(right)));
  const dispositions = effective.filter((fact) => fact.fact_type === "authority_disposition")
    .sort((left, right) => findingDate(left).localeCompare(findingDate(right)) ||
      left.established_at.localeCompare(right.established_at));

  if (issued.length > 1) {
    return findingResult(
      "conflicted", asOf, "conflicting_finding_facts", issued,
      [unresolved("finding_conflict", "Multiple effective issuance facts exist for one finding.")]);
  }
  if (issued.length === 0) {
    return findingResult(
      "not_established", asOf, "insufficient_canonical_facts", [],
      [unresolved("finding_not_established", "No finding issuance has been established.")]);
  }

  const issuedOn = issued[0].value.issued_on;
  if (cures.some((fact) => fact.value.performed_on < issuedOn) ||
      dispositions.some((fact) => fact.value.decided_on < issuedOn)) {
    return findingResult(
      "conflicted", asOf, "conflicting_finding_facts", [issued[0], ...cures, ...dispositions],
      [unresolved("finding_timeline_conflict", "A lifecycle fact predates the established finding issuance.")]);
  }

  const latestDate = dispositions.length > 0 ? dispositions[dispositions.length - 1].value.decided_on : null;
  const latestDispositions = dispositions.filter((fact) => fact.value.decided_on === latestDate);
  if (new Set(latestDispositions.map((fact) => fact.value.disposition)).size > 1) {
    return findingResult(
      "conflicted", asOf, "conflicting_authority_dispositions",
      [issued[0], ...latestDispositions],
      [unresolved("authority_disposition_conflict", "Conflicting authority dispositions share the latest decision date.")]);
  }

  const latestDisposition = latestDispositions[latestDispositions.length - 1] || null;
  const latestCure = cures[cures.length - 1] || null;
  if (latestDisposition && latestDisposition.value.disposition === "closed") {
    return findingResult(
      "authority_closed", asOf, "authority_disposition_closed",
      [issued[0], ...(latestCure ? [latestCure] : []), latestDisposition], []);
  }
  if (latestDisposition && latestDisposition.value.disposition === "remains_open") {
    return findingResult(
      "open", asOf, "authority_disposition_remains_open",
      [issued[0], ...(latestCure ? [latestCure] : []), latestDisposition],
      [unresolved("authority_closure_not_established", "The latest authority disposition leaves the finding open.")]);
  }
  if (latestCure) {
    return findingResult(
      "cure_recorded_awaiting_authority", asOf, "cure_without_authority_closure",
      [issued[0], latestCure],
      [unresolved("authority_closure_not_established", "A cure is recorded, but authority closure is not established.")]);
  }
  return findingResult(
    "open", asOf, "finding_issued_without_closure", [issued[0]],
    [unresolved("cure_not_established", "No cure or authority closure has been established.")]);
}

function deriveAttention(actionCondition, asOf) {
  validateAsOf(asOf);
  if (actionCondition === null || actionCondition === undefined) {
    return Object.freeze({ state: "none_established", obligation_id: null });
  }
  factContracts.validateActionCondition(actionCondition);
  let state = "action_required";
  if (actionCondition.due_on > asOf) state = "upcoming";
  if (actionCondition.due_on < asOf) state = "overdue";
  return Object.freeze({ state, obligation_id: actionCondition.obligation_id });
}

module.exports = {
  buildEffectiveHistory,
  deriveCredentialStanding,
  deriveFindingStanding,
  deriveAttention,
};
