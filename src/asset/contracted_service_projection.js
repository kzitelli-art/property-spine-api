"use strict";

const contract = require("./contracted_service_contract.js");

const ATTENTION_WINDOW_DAYS = 90;
const GOVERNING_DOCUMENT_KINDS = Object.freeze([
  "agreement", "statement_of_work", "amendment", "addendum",
]);

function day(value) {
  if (!value) return null;
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
}

function parseDay(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day(value) || "");
  return match ? Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) : null;
}

function daysBetween(from, to) {
  const start = parseDay(from);
  const end = parseDay(to);
  if (start === null || end === null) return null;
  return Math.round((end - start) / 86400000);
}

function subtractDays(value, count) {
  const time = parseDay(value);
  if (time === null || !Number.isInteger(Number(count))) return null;
  return new Date(time - Number(count) * 86400000).toISOString().slice(0, 10);
}

function activeAt(row, asOf) {
  const start = day(row.effective_from || row.commencement_date);
  const end = day(row.effective_to);
  return (!start || start <= asOf) && (!end || end > asOf);
}

function heads(rows) {
  const superseded = new Set((rows || []).map((row) => row.supersedes_id).filter(Boolean));
  return (rows || []).filter((row) => !superseded.has(row.id));
}

function current(rows, asOf) {
  return heads(rows).filter((row) => activeAt(row, asOf));
}

function newest(rows, fields = ["recorded_at", "id"]) {
  return [...(rows || [])].sort((a, b) => {
    for (const field of fields) {
      const left = String(a[field] || "");
      const right = String(b[field] || "");
      if (left !== right) return left < right ? 1 : -1;
    }
    return 0;
  })[0] || null;
}

function sourceOf(row) {
  if (!row) return null;
  return {
    source_artifact_id: row.source_artifact_id || null,
    provenance_note: row.provenance_note || row.basis || null,
    source_authority: "governed_read",
  };
}

function envelope(concept, value, asOf, extra = {}) {
  const out = {
    domain: "contracted_service",
    concept,
    source_authority: "governed_read",
    provenance: "contracted_service_position_read",
    as_of: asOf,
    ...extra,
  };
  if (value && value.truth_state) out.truth_state = value.truth_state;
  else out.value = value;
  return out;
}

function documentView(row) {
  if (!row) return null;
  return {
    id: row.id,
    engagement_id: row.engagement_id || null,
    source_artifact_id: row.source_artifact_id || null,
    document_kind: row.document_kind,
    execution_state: row.execution_state,
    document_date: day(row.document_date),
    named_effective_date: day(row.named_effective_date),
    filename: row.filename || null,
    evidence: sourceOf(row),
  };
}

function priceView(row) {
  return {
    id: row.id,
    basis: row.price_basis,
    amount_cents: row.amount_cents === null || row.amount_cents === undefined
      ? null : Number(row.amount_cents),
    currency_code: row.currency_code || "USD",
    quantity_basis: row.quantity_basis || null,
    description: row.description || null,
  };
}

function termView(row, document, prices) {
  if (!row) return null;
  return {
    id: row.id,
    authority: row.term_authority,
    commencement_date: day(row.commencement_date),
    commencement_trigger: row.commencement_trigger || null,
    initial_end_date: day(row.initial_end_date),
    initial_term_months: row.initial_term_months === null
      || row.initial_term_months === undefined ? null : Number(row.initial_term_months),
    term_kind: row.term_kind,
    automatic_renewal: row.automatic_renewal === null || row.automatic_renewal === undefined
      ? null : !!row.automatic_renewal,
    renewal_period_months: row.renewal_period_months === null
      || row.renewal_period_months === undefined ? null : Number(row.renewal_period_months),
    notice_days: row.notice_days === null || row.notice_days === undefined
      ? null : Number(row.notice_days),
    continues_until_terminated: !!row.continues_until_terminated,
    termination_for_convenience: row.termination_for_convenience === null
      || row.termination_for_convenience === undefined
      ? null : !!row.termination_for_convenience,
    document: documentView(document),
    prices: (prices || []).map(priceView),
    evidence: sourceOf(row),
  };
}

function isExecutedGoverningTerm(term, documentById) {
  const document = documentById.get(term.document_id);
  return term.term_authority === "governing"
    && !!document
    && document.execution_state === "executed"
    && GOVERNING_DOCUMENT_KINDS.includes(document.document_kind);
}

function termCovers(term, asOf) {
  const start = day(term.commencement_date);
  const end = day(term.initial_end_date);
  if (start && start > asOf) return false;
  if (!end) return term.term_kind === "month_to_month"
    || term.term_kind === "continues_until_terminated"
    || !!term.continues_until_terminated;
  return asOf < end;
}

function successorFor(term, terms) {
  const end = day(term.initial_end_date);
  if (!end) return null;
  return [...terms]
    .filter((candidate) => candidate.id !== term.id
      && day(candidate.commencement_date)
      && [0, 1].includes(daysBetween(end, day(candidate.commencement_date))))
    .sort((a, b) => day(a.commencement_date).localeCompare(day(b.commencement_date)))[0] || null;
}

function decisionOwner(snapshot, engagementId, termId) {
  const links = (snapshot.decision_links || []).filter((link) =>
    link.engagement_id === engagementId && (!termId || !link.term_id || link.term_id === termId));
  const link = newest(links, ["linked_at", "id"]);
  if (!link) return { state: "UNASSIGNED", obligation_id: null, user_id: null, label: "UNASSIGNED" };
  const obligation = (snapshot.obligations || []).find((row) => row.id === link.obligation_id) || null;
  const userId = obligation && (obligation.assigned_user_id
    || obligation.owner_user_id || obligation.assigned_to_user_id);
  const person = (snapshot.users || []).find((row) => row.id === userId) || null;
  return {
    state: userId ? "ASSIGNED" : "UNASSIGNED",
    obligation_id: link.obligation_id,
    user_id: userId || null,
    label: person ? (person.display_name || person.name || person.email || "Assigned") : "UNASSIGNED",
  };
}

function evaluateTerm(engagementId, governingTerms, asOf, snapshot) {
  if (!governingTerms.length) {
    return {
      state: "NOT_ESTABLISHED",
      current: null,
      successor: null,
      milestone: null,
      accountable_owner: decisionOwner(snapshot, engagementId, null),
      reason: "No executed governing term is established.",
    };
  }

  const active = governingTerms.filter((term) => termCovers(term, asOf));
  const selected = newest(active, ["commencement_date", "recorded_at"]);
  if (selected) {
    const successor = successorFor(selected, governingTerms);
    const end = day(selected.initial_end_date);
    const noticeDeadline = end && Number.isInteger(Number(selected.notice_days))
      ? subtractDays(end, Number(selected.notice_days)) : null;
    const owner = decisionOwner(snapshot, engagementId, selected.id);

    if (successor) {
      return {
        state: "CURRENT",
        current: selected,
        successor,
        accountable_owner: owner,
        milestone: null,
        reason: `The current term runs through ${end}; a successor governing term starts ${day(successor.commencement_date)}.`,
      };
    }

    if (noticeDeadline) {
      const daysToNotice = daysBetween(asOf, noticeDeadline);
      if (daysToNotice < 0) {
        return {
          state: "ATTENTION",
          current: selected,
          successor: null,
          accountable_owner: owner,
          milestone: {
            kind: "renewal_outcome_not_established",
            date: noticeDeadline,
            term_end: end,
            days_from_deadline: Math.abs(daysToNotice),
            reason: "The contractual notice deadline passed, but Spine has no governed renewal or termination outcome.",
          },
          reason: "The current term has not ended, but its notice deadline has passed without a governed outcome.",
        };
      }
      return {
        state: daysToNotice <= ATTENTION_WINDOW_DAYS ? "ATTENTION" : "CURRENT",
        current: selected,
        successor: null,
        accountable_owner: owner,
        milestone: {
          kind: "notice_decision",
          date: noticeDeadline,
          term_end: end,
          days_to_deadline: daysToNotice,
          reason: `A renewal or termination decision is due before the ${noticeDeadline} notice deadline.`,
        },
        reason: daysToNotice <= ATTENTION_WINDOW_DAYS
          ? `The notice decision is ${daysToNotice} day${daysToNotice === 1 ? "" : "s"} away.`
          : `The current term runs through ${end}.`,
      };
    }

    if (end) {
      const daysToEnd = daysBetween(asOf, end);
      return {
        state: daysToEnd <= ATTENTION_WINDOW_DAYS ? "ATTENTION" : "CURRENT",
        current: selected,
        successor: null,
        accountable_owner: owner,
        milestone: {
          kind: "term_end",
          date: end,
          days_to_deadline: daysToEnd,
          reason: "The governing term states an end date but no notice requirement is established.",
        },
        reason: daysToEnd <= ATTENTION_WINDOW_DAYS
          ? `The stated term end is ${daysToEnd} day${daysToEnd === 1 ? "" : "s"} away.`
          : `The current term runs through ${end}.`,
      };
    }

    return {
      state: "CURRENT",
      current: selected,
      successor: null,
      milestone: null,
      accountable_owner: owner,
      reason: selected.term_kind === "month_to_month"
        ? "A governing month-to-month term is established."
        : "A governing term continuing until terminated is established.",
    };
  }

  const prior = newest(governingTerms.filter((term) => {
    const start = day(term.commencement_date);
    return !start || start <= asOf;
  }), ["initial_end_date", "commencement_date", "recorded_at"]);
  const future = [...governingTerms].filter((term) => day(term.commencement_date) > asOf)
    .sort((a, b) => day(a.commencement_date).localeCompare(day(b.commencement_date)))[0] || null;

  if (!prior && future) {
    return {
      state: "FUTURE",
      current: null,
      successor: future,
      milestone: { kind: "service_commencement", date: day(future.commencement_date) },
      accountable_owner: decisionOwner(snapshot, engagementId, future.id),
      reason: `The first governing term begins ${day(future.commencement_date)}.`,
    };
  }

  if (prior) {
    const priorStart = day(prior.commencement_date);
    const priorEnd = day(prior.initial_end_date);
    if (!priorStart || !priorEnd) {
      return {
        state: "OUTCOME_NOT_ESTABLISHED",
        current: prior,
        successor: future,
        milestone: {
          kind: "term_dates_not_established",
          date: null,
          reason: "The executed term is anchored to an event or missing a confirmed date.",
        },
        accountable_owner: decisionOwner(snapshot, engagementId, prior.id),
        reason: "The governing document is executed, but the current term dates are not established.",
      };
    }
    const fixedEnd = prior.term_kind === "fixed"
      && prior.automatic_renewal === false
      && !prior.continues_until_terminated;
    return {
      state: fixedEnd ? "ENDED" : "OUTCOME_NOT_ESTABLISHED",
      current: prior,
      successor: future,
      milestone: {
        kind: fixedEnd ? "term_ended" : "renewal_outcome_not_established",
        date: day(prior.initial_end_date),
        reason: fixedEnd
          ? "The executed fixed term ended and does not state automatic renewal."
          : "The stated term ended, but Spine has no governed successor, renewal, or termination outcome.",
      },
      accountable_owner: decisionOwner(snapshot, engagementId, prior.id),
      reason: fixedEnd
        ? `The governing term ended ${day(prior.initial_end_date)}.`
        : "Current service authority is not established after the stated term end.",
    };
  }

  return {
    state: "NOT_ESTABLISHED", current: null, successor: null, milestone: null,
    accountable_owner: decisionOwner(snapshot, engagementId, null),
    reason: "No governing term applies on the requested date.",
  };
}

function project(snapshot = {}, { as_of = null } = {}) {
  const asOf = day(as_of) || new Date().toISOString().slice(0, 10);
  const propertyId = snapshot.property_id || null;
  const coverageReview = newest((snapshot.coverage_reviews || [])
    .filter((row) => day(row.reviewed_as_of) <= asOf), ["reviewed_as_of", "recorded_at"]);
  const requirements = current(snapshot.requirements || [], asOf);
  const engagements = current(snapshot.engagements || [], asOf);
  const documents = heads(snapshot.documents || []);
  const terms = heads(snapshot.terms || []);
  const scopes = current(snapshot.scopes || [], asOf);
  const locations = current(snapshot.locations || [], asOf);
  const prices = heads(snapshot.prices || []);
  const observations = heads(snapshot.financial_observations || []);
  const providerById = new Map((snapshot.providers || []).map((row) => [row.id, row]));
  const documentById = new Map(documents.map((row) => [row.id, row]));
  const unresolved = [];
  const facts = [];

  function gap(concept, question, reason, extra = {}) {
    unresolved.push({ concept, question, reason, ...extra });
  }

  if (!coverageReview) {
    gap("coverage_review", "Which contracted services should this property have?",
      "No current property-wide service census has been reviewed.");
    facts.push(envelope("coverage_review", { truth_state: "NOT_ESTABLISHED" }, asOf));
  } else {
    facts.push(envelope("coverage_review", day(coverageReview.reviewed_as_of), asOf,
      { evidence: sourceOf(coverageReview) }));
  }

  const engagementViews = engagements.map((engagement) => {
    const provider = providerById.get(engagement.provider_id) || null;
    const engagementDocuments = documents.filter((row) => row.engagement_id === engagement.id);
    const engagementTerms = terms.filter((row) => row.engagement_id === engagement.id);
    const governingTerms = engagementTerms.filter((row) => isExecutedGoverningTerm(row, documentById));
    const offeredTerms = engagementTerms.filter((row) => row.term_authority === "offered");
    const observedTerms = engagementTerms.filter((row) => row.term_authority === "observed");
    const invalidGoverningTerms = engagementTerms.filter((row) =>
      row.term_authority === "governing" && !isExecutedGoverningTerm(row, documentById));
    const termStanding = evaluateTerm(engagement.id, governingTerms, asOf, snapshot);
    const currentTerm = termStanding.current;
    const currentScope = newest(scopes.filter((row) => row.engagement_id === engagement.id),
      ["effective_from", "recorded_at"]);
    const scopeLocations = currentScope
      ? locations.filter((row) => row.scope_id === currentScope.id).map((row) => ({
          id: row.id,
          kind: row.location_kind,
          label: row.location_label,
          unit_id: row.unit_id || null,
          space_id: row.space_id || null,
        })) : [];
    const termPrices = currentTerm
      ? prices.filter((row) => row.term_id === currentTerm.id) : [];
    const offered = newest(offeredTerms, ["commencement_date", "recorded_at"]);
    const observed = newest(observedTerms, ["commencement_date", "recorded_at"]);
    const observationsForEngagement = observations.filter((row) => row.engagement_id === engagement.id);

    if (!provider) {
      gap("provider", `Who provides ${contract.labelForService(engagement.service_class, engagement.service_label)}?`,
        "The engagement has no governed provider identity.", { engagement_id: engagement.id });
    }
    if (invalidGoverningTerms.length) {
      gap("document_execution", "Which executed document makes these terms governing?",
        "Terms were marked governing without an executed governing document.",
        { engagement_id: engagement.id });
    }
    if (!governingTerms.length) {
      gap("governing_term", "Which executed document governs this service now?",
        offered
          ? "Offered terms are recorded, but no executed governing term is established."
          : "No executed governing term is established.",
        { engagement_id: engagement.id });
    }
    if (!currentScope) {
      gap("scope", "What work and locations are covered by this engagement?",
        "No current governed scope is established.", { engagement_id: engagement.id });
    }
    if (currentTerm && !termPrices.length) {
      gap("contract_price", "What price basis does the governing term state?",
        "The governing term has no recorded price component.", { engagement_id: engagement.id });
    }
    if (termStanding.milestone && termStanding.state === "ATTENTION"
        && termStanding.accountable_owner.state === "UNASSIGNED") {
      gap("decision_owner", "Who owns the next contract decision?",
        "The next notice or term milestone has no accountable owner.",
        { engagement_id: engagement.id, milestone: termStanding.milestone });
    }
    if (["OUTCOME_NOT_ESTABLISHED", "ENDED"].includes(termStanding.state)) {
      gap("current_authority", "What governs this service after the stated term end?",
        termStanding.reason, { engagement_id: engagement.id });
    }

    const sourceDocument = currentTerm ? documentById.get(currentTerm.document_id) : null;
    const executionStanding = currentTerm
      ? "EXECUTED_GOVERNING"
      : offered || engagementDocuments.some((row) => row.execution_state === "unsigned")
        ? "OFFERED_OR_UNSIGNED"
        : engagementDocuments.length ? "EVIDENCE_ONLY" : "NOT_ESTABLISHED";

    facts.push(envelope("engagement_authority",
      currentTerm ? "executed_governing" : { truth_state: "NOT_ESTABLISHED" }, asOf,
      { engagement_id: engagement.id, service_class: engagement.service_class,
        evidence: sourceOf(sourceDocument || newest(engagementDocuments)) }));
    facts.push(envelope("provider_payment", { truth_state: "NOT_ESTABLISHED" }, asOf,
      { engagement_id: engagement.id,
        reason: "Contract pricing and financial observations do not establish settlement." }));
    facts.push(envelope("service_completion", { truth_state: "NOT_ESTABLISHED" }, asOf,
      { engagement_id: engagement.id,
        reason: "A standing engagement and service schedule do not establish completed work." }));

    return {
      id: engagement.id,
      service_class: engagement.service_class,
      label: contract.labelForService(engagement.service_class, engagement.service_label),
      engagement_label: engagement.engagement_label || null,
      provider: provider ? { id: provider.id, name: provider.provider_name } : null,
      execution_standing: executionStanding,
      term_standing: {
        state: termStanding.state,
        reason: termStanding.reason,
        milestone: termStanding.milestone,
        accountable_owner: termStanding.accountable_owner,
        current: currentTerm
          ? termView(currentTerm, documentById.get(currentTerm.document_id), termPrices) : null,
        successor: termStanding.successor
          ? termView(termStanding.successor,
              documentById.get(termStanding.successor.document_id),
              prices.filter((row) => row.term_id === termStanding.successor.id)) : null,
        offered: offered
          ? termView(offered, documentById.get(offered.document_id),
              prices.filter((row) => row.term_id === offered.id)) : null,
        observed: observed
          ? termView(observed, documentById.get(observed.document_id),
              prices.filter((row) => row.term_id === observed.id)) : null,
      },
      scope: currentScope ? {
        id: currentScope.id,
        summary: currentScope.scope_summary,
        frequency: currentScope.frequency_summary || null,
        exclusions: currentScope.exclusions_summary || null,
        locations: scopeLocations,
        evidence: sourceOf(currentScope),
      } : null,
      documents: engagementDocuments.map(documentView),
      financial_observations: observationsForEngagement.map((row) => ({
        id: row.id,
        service_class: row.service_class || engagement.service_class,
        provider_id: row.provider_id || null,
        provider_name: row.provider_id && providerById.get(row.provider_id)
          ? providerById.get(row.provider_id).provider_name : row.provider_name || null,
        kind: row.observation_kind,
        line_label: row.line_label || null,
        period_start: day(row.period_start),
        period_end: day(row.period_end),
        amount_cents: row.amount_cents === null || row.amount_cents === undefined
          ? null : Number(row.amount_cents),
        currency_code: row.currency_code || "USD",
        evidence: sourceOf(row),
      })),
      payment: { truth_state: "NOT_ESTABLISHED",
        reason: "No governed accounting settlement is linked to this engagement." },
      service_completion: { truth_state: "NOT_ESTABLISHED",
        reason: "Contracted expectation is separate from Maintenance execution." },
    };
  });

  const requirementsViews = requirements.map((requirement) => {
    const matching = engagementViews.filter((row) => row.service_class === requirement.service_class);
    if (requirement.determination === "contracted_service_required" && !matching.length) {
      gap("required_engagement", `Who is engaged for ${contract.labelForService(
        requirement.service_class, requirement.service_label)}?`,
      "The service is required from a contractor, but no engagement is established.",
      { service_class: requirement.service_class });
    }
    if (requirement.determination !== "contracted_service_required" && matching.length) {
      gap("delivery_model_conflict", "Is this service contracted or handled another way?",
        "The current requirement determination conflicts with a recorded contractor engagement.",
        { service_class: requirement.service_class });
    }
    return {
      id: requirement.id,
      service_class: requirement.service_class,
      label: contract.labelForService(requirement.service_class, requirement.service_label),
      determination: requirement.determination,
      basis: requirement.basis || null,
      engagement_count: matching.length,
      evidence: sourceOf(requirement),
    };
  });

  const knownEngagementIds = new Set(engagementViews.map((row) => row.id));
  const allEngagementIds = new Set((snapshot.engagements || []).map((row) => row.id));
  const unmatchedDocuments = documents.filter((row) =>
    !row.engagement_id || !allEngagementIds.has(row.engagement_id)).map(documentView);
  const unmatchedObservations = observations.filter((row) =>
    !row.engagement_id || !knownEngagementIds.has(row.engagement_id)).map((row) => ({
      id: row.id,
      service_class: row.service_class || null,
      label: row.service_class ? contract.labelForService(row.service_class, row.service_label) : null,
      provider_id: row.provider_id || null,
      provider_name: row.provider_id && providerById.get(row.provider_id)
        ? providerById.get(row.provider_id).provider_name : row.provider_name || null,
      kind: row.observation_kind,
      line_label: row.line_label || null,
      period_start: day(row.period_start),
      period_end: day(row.period_end),
      amount_cents: row.amount_cents === null || row.amount_cents === undefined
        ? null : Number(row.amount_cents),
      currency_code: row.currency_code || "USD",
      evidence: sourceOf(row),
    }));

  for (const document of unmatchedDocuments) {
    gap("unmatched_service_document", "Which provider engagement does this retained evidence belong to?",
      "A service document is retained, but it is not mapped to a governed engagement.",
      { document_id: document.id, source_artifact_id: document.source_artifact_id });
  }

  for (const observation of unmatchedObservations) {
    const sameService = engagementViews.filter((row) =>
      observation.service_class && row.service_class === observation.service_class);
    const conflictingProvider = observation.provider_name && sameService.find((row) =>
      row.provider && row.provider.name
      && row.provider.name.toLowerCase() !== observation.provider_name.toLowerCase());
    gap("unmatched_financial_observation", conflictingProvider
      ? `Does ${observation.provider_name} replace or supplement ${conflictingProvider.provider.name}?`
      : "Which governed engagement explains this service amount?",
    conflictingProvider
      ? "A financial source names a different provider for the same service class."
      : "A financial source names a service amount, but it is not mapped to a governed engagement.",
    { financial_observation_id: observation.id, service_class: observation.service_class,
      engagement_id: conflictingProvider ? conflictingProvider.id : null });
  }

  const hasTruth = requirements.length || engagements.length || documents.length
    || observations.length || !!coverageReview;
  const setupState = !hasTruth ? "not_established"
    : coverageReview && unresolved.length === 0 ? "established" : "partially_established";
  const attention = engagementViews.filter((row) =>
    ["ATTENTION", "OUTCOME_NOT_ESTABLISHED", "ENDED"].includes(row.term_standing.state));
  const governed = engagementViews.filter((row) => row.execution_standing === "EXECUTED_GOVERNING");
  const nextMilestone = engagementViews.map((row) => ({
    engagement_id: row.id,
    label: row.label,
    provider: row.provider,
    milestone: row.term_standing.milestone,
    accountable_owner: row.term_standing.accountable_owner,
  })).filter((row) => row.milestone && row.milestone.date)
    .sort((a, b) => a.milestone.date.localeCompare(b.milestone.date))[0] || null;

  const standing = {
    contract_version: contract.CONTRACT_VERSION,
    domain: "contracted_service",
    property_id: propertyId,
    as_of: asOf,
    setup_state: setupState,
    coverage_review: coverageReview ? {
      id: coverageReview.id,
      reviewed_as_of: day(coverageReview.reviewed_as_of),
      evidence: sourceOf(coverageReview),
    } : { truth_state: "NOT_ESTABLISHED" },
    requirement_count: requirementsViews.length,
    engagement_count: engagementViews.length,
    governed_engagement_count: governed.length,
    attention_count: attention.length,
    unmatched_document_count: unmatchedDocuments.length,
    unmatched_financial_observation_count: unmatchedObservations.length,
    next_milestone: nextMilestone,
    engagements: engagementViews.map((row) => ({
      id: row.id,
      service_class: row.service_class,
      label: row.label,
      provider: row.provider,
      execution_standing: row.execution_standing,
      term_state: row.term_standing.state,
      term_reason: row.term_standing.reason,
      milestone: row.term_standing.milestone,
      accountable_owner: row.term_standing.accountable_owner,
      price_components: row.term_standing.current ? row.term_standing.current.prices : [],
      scope_summary: row.scope ? row.scope.summary : null,
    })),
    unresolved_count: unresolved.length,
    unresolved: unresolved.slice(0, 12),
    facts,
    truth_walls: contract.TRUTH_WALLS,
    does_not_establish: contract.DOES_NOT_ESTABLISH,
    capabilities: contract.CAPABILITIES,
  };

  return {
    contract_version: contract.CONTRACT_VERSION,
    property_id: propertyId,
    as_of: asOf,
    setup_state: setupState,
    opening: {
      setup_state: setupState,
      coverage_review: standing.coverage_review,
      requirements: requirementsViews,
      unresolved,
    },
    standing,
    detail: {
      requirements: requirementsViews,
      engagements: engagementViews,
      unmatched_documents: unmatchedDocuments,
      unmatched_financial_observations: unmatchedObservations,
      unresolved,
    },
  };
}

module.exports = {
  ATTENTION_WINDOW_DAYS,
  GOVERNING_DOCUMENT_KINDS,
  day,
  daysBetween,
  subtractDays,
  activeAt,
  heads,
  project,
};
