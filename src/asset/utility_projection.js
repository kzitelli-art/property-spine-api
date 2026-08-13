"use strict";

const contract = require("./utility_contract.js");

function day(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

function activeAt(row, asOf) {
  const start = day(row.effective_from);
  const end = day(row.effective_to);
  return (!start || start <= asOf) && (!end || end > asOf);
}

function heads(rows) {
  const superseded = new Set((rows || []).map((r) => r.supersedes_id).filter(Boolean));
  return (rows || []).filter((r) => !superseded.has(r.id));
}

function current(rows, asOf) {
  return heads(rows).filter((r) => activeAt(r, asOf));
}

function newest(rows, fields) {
  return [...(rows || [])].sort((a, b) => {
    for (const field of fields) {
      const av = String(a[field] || "");
      const bv = String(b[field] || "");
      if (av !== bv) return av < bv ? 1 : -1;
    }
    return 0;
  })[0] || null;
}

function maskIdentifier(value) {
  const raw = String(value || "").replace(/\s+/g, "");
  if (!raw) return null;
  const visible = raw.slice(-4);
  return `${"*".repeat(Math.max(4, Math.min(8, raw.length - visible.length)))}${visible}`;
}

function sourceOf(row) {
  if (!row) return null;
  return {
    source_artifact_id: row.source_artifact_id || null,
    provenance_note: row.provenance_note || null,
    source_authority: "governed_read",
  };
}

function envelope(concept, value, asOf, extra = {}) {
  const out = {
    domain: "utility",
    concept,
    source_authority: "governed_read",
    provenance: "utility_position_read",
    as_of: asOf,
    ...extra,
  };
  if (value && value.truth_state) out.truth_state = value.truth_state;
  else out.value = value;
  return out;
}

function project(snapshot = {}, { as_of = null } = {}) {
  const asOf = day(as_of) || new Date().toISOString().slice(0, 10);
  const propertyId = snapshot.property_id || null;
  const serviceRows = snapshot.services || [];
  const declarations = current(snapshot.declarations || [], asOf);
  const providers = snapshot.providers || [];
  const serviceProviders = current(snapshot.service_providers || [], asOf);
  const arrangements = current(snapshot.arrangements || [], asOf);
  const accountRows = current(snapshot.accounts || [], asOf);
  const pointRows = current(snapshot.service_points || [], asOf);
  const meterRows = current(snapshot.meters || [], asOf);
  const accountServices = current(snapshot.account_services || [], asOf);
  const accountPoints = current(snapshot.account_service_points || [], asOf);
  const accountMeters = current(snapshot.account_meters || [], asOf);
  const meterPoints = current(snapshot.meter_service_points || [], asOf);
  const statements = heads(snapshot.statements || []);
  const usageRows = snapshot.statement_usage || [];

  const providerById = new Map(providers.map((r) => [r.id, r]));
  const serviceById = new Map(serviceRows.map((r) => [r.id, r]));
  const pointById = new Map(pointRows.map((r) => [r.id, r]));
  const meterById = new Map(meterRows.map((r) => [r.id, r]));
  const accountById = new Map(accountRows.map((r) => [r.id, r]));

  const servicesByKey = new Map();
  for (const starter of contract.STARTER_SERVICES) {
    servicesByKey.set(starter.key, { id: null, service_class: starter.key, service_label: starter.label });
  }
  for (const row of serviceRows) servicesByKey.set(row.service_class, row);

  const unresolved = [];
  const facts = [];

  function gap(concept, service, question, reason, extra = {}) {
    unresolved.push({ concept, service, question, reason, ...extra });
  }

  function linksFor(rows, key, id) {
    return rows.filter((r) => r[key] === id);
  }

  const serviceViews = [...servicesByKey.values()].map((service) => {
    const declaration = service.id
      ? newest(declarations.filter((r) => r.service_id === service.id), ["effective_from", "recorded_at"])
      : null;
    const serviceClass = service.service_class;
    const label = contract.labelForService(serviceClass, service.service_label);

    if (!declaration) {
      gap("service_applicability", serviceClass,
        `Does this property have ${label.toLowerCase()} service?`,
        "No present or not-applicable declaration has been established.");
      facts.push(envelope("service_applicability", { truth_state: "NOT_ESTABLISHED" }, asOf,
        { service_class: serviceClass }));
      return {
        id: service.id || null,
        service_class: serviceClass,
        label,
        applicability: { truth_state: "NOT_ESTABLISHED", value: null },
        providers: [],
        arrangement: null,
        accounts: [],
        service_points: [],
        meters: [],
        latest_statement: null,
        payment: { truth_state: "NOT_ESTABLISHED", reason: "No provider statement is established." },
      };
    }

    facts.push(envelope("service_applicability", declaration.applicability, asOf,
      { service_class: serviceClass, evidence: sourceOf(declaration) }));

    if (declaration.applicability === "not_applicable") {
      return {
        id: service.id,
        service_class: serviceClass,
        label,
        applicability: { truth_state: "ESTABLISHED", value: "not_applicable" },
        providers: [], arrangement: null, accounts: [], service_points: [], meters: [],
        latest_statement: null,
        payment: { truth_state: "NOT_APPLICABLE", reason: "The service is established as not applicable." },
        evidence: sourceOf(declaration),
      };
    }

    const providerLinks = linksFor(serviceProviders, "service_id", service.id);
    const providerViews = providerLinks.map((link) => {
      const p = providerById.get(link.provider_id);
      return p ? { id: p.id, name: p.provider_name, evidence: sourceOf(link) } : null;
    }).filter(Boolean);
    if (!providerViews.length) {
      gap("provider", serviceClass, `Who provides ${label.toLowerCase()} service?`,
        "The service is present but no provider relationship is established.");
    }

    const arrangement = newest(arrangements.filter((r) => r.service_id === service.id),
      ["effective_from", "recorded_at"]);
    if (!arrangement) {
      for (const [concept, question] of [
        ["physical_arrangement", `How is ${label.toLowerCase()} physically delivered?`],
        ["provider_responsibility", `Who is responsible to the ${label.toLowerCase()} provider?`],
        ["economic_responsibility", `Who economically bears the ${label.toLowerCase()} cost?`],
        ["resident_recovery", `How, if at all, are residents charged for ${label.toLowerCase()}?`],
      ]) gap(concept, serviceClass, question, "No current utility arrangement is established.");
    } else {
      if (!arrangement.physical_arrangement || arrangement.physical_arrangement === "unknown") {
        gap("physical_arrangement", serviceClass,
          `How is ${label.toLowerCase()} physically delivered?`,
          "The current arrangement does not establish the topology.");
      }
      if (!arrangement.provider_bill_recipient) {
        gap("provider_bill_recipient", serviceClass,
          `Who receives the provider bill for ${label.toLowerCase()}?`,
          "Provider bill receipt is not established.");
      }
      if (!arrangement.provider_responsible_party) {
        gap("provider_responsibility", serviceClass,
          `Who is responsible to the provider for ${label.toLowerCase()}?`,
          "Provider responsibility is not established.");
      }
      if (!arrangement.economic_responsibility) {
        gap("economic_responsibility", serviceClass,
          `Who economically bears the ${label.toLowerCase()} cost?`,
          "Economic responsibility is not established.");
      }
      if (!arrangement.resident_recovery_method) {
        gap("resident_recovery", serviceClass,
          `How, if at all, are residents charged for ${label.toLowerCase()}?`,
          "Resident recovery method is not established.");
      }
      if (contract.THIRD_PARTY_RECOVERY_METHODS.includes(arrangement.resident_recovery_method)
          && arrangement.resident_payment_recipient === "billing_administrator"
          && !arrangement.billing_administrator_name) {
        gap("billing_administrator", serviceClass,
          `Who administers resident ${label.toLowerCase()} billing?`,
          "The arrangement points to a billing administrator but does not establish its identity.");
      }
    }

    const serviceAccountIds = new Set(linksFor(accountServices, "service_id", service.id)
      .map((r) => r.account_id));
    const serviceAccounts = [...serviceAccountIds].map((id) => accountById.get(id)).filter(Boolean);
    const accountViews = serviceAccounts.map((account) => {
      const accountPointIds = new Set(linksFor(accountPoints, "account_id", account.id)
        .map((r) => r.service_point_id));
      const accountMeterIds = new Set(linksFor(accountMeters, "account_id", account.id)
        .map((r) => r.meter_id));
      const accountStatements = statements.filter((r) => r.account_id === account.id);
      const latest = newest(accountStatements, ["bill_date", "recorded_at"]);
      return {
        id: account.id,
        provider_id: account.provider_id,
        provider: (providerById.get(account.provider_id) || {}).provider_name || null,
        account_identifier_masked: maskIdentifier(account.external_account_identifier),
        service_address: account.service_address || null,
        billing_cadence: account.billing_cadence || null,
        serves: [...accountPointIds].map((id) => pointById.get(id)).filter(Boolean)
          .map((p) => ({ id: p.id, label: p.location_label, kind: p.point_kind })),
        meters: [...accountMeterIds].map((id) => meterById.get(id)).filter(Boolean)
          .map((m) => ({ id: m.id, kind: m.meter_kind, identifier_masked: maskIdentifier(m.meter_identifier) })),
        latest_statement: latest ? statementView(latest, usageRows, meterById) : null,
        evidence: sourceOf(account),
      };
    });

    const propertyBilled = arrangement && (
      arrangement.provider_bill_recipient === "property"
      || arrangement.provider_responsible_party === "property"
      || arrangement.provider_bill_recipient === "mixed"
      || arrangement.provider_responsible_party === "mixed");
    if (propertyBilled && !accountViews.length) {
      gap("provider_account", serviceClass,
        `Which provider account covers property-paid ${label.toLowerCase()} service?`,
        "The property is provider-billed or responsible, but no provider account is mapped.");
    }

    const servicePoints = pointRows.filter((r) => r.service_id === service.id);
    const pointIds = new Set(servicePoints.map((r) => r.id));
    const serviceMeterIds = new Set(meterPoints.filter((r) => pointIds.has(r.service_point_id))
      .map((r) => r.meter_id));
    const serviceMeters = [...serviceMeterIds].map((id) => meterById.get(id)).filter(Boolean);
    const topology = arrangement && arrangement.physical_arrangement;
    if (contract.METERED_ARRANGEMENTS.includes(topology)) {
      if (!servicePoints.length) {
        gap("service_point_map", serviceClass,
          `What does the ${label.toLowerCase()} service serve?`,
          "A metered arrangement is established but no service point is mapped.");
      }
      if (!serviceMeters.length) {
        gap("meter_map", serviceClass,
          `Which meters or submeters measure ${label.toLowerCase()} service?`,
          "A metered arrangement is established but no meter is mapped.");
      }
    }

    for (const meter of serviceMeters) {
      if (meter.meter_kind === "provider_meter"
          && !accountMeters.some((r) => r.meter_id === meter.id)) {
        gap("account_meter_mapping", serviceClass,
          `Which provider account is meter ${maskIdentifier(meter.meter_identifier)} associated with?`,
          "The provider meter is known but its provider-account relationship is not established.",
          { meter_id: meter.id });
      }
    }

    const latest = newest(accountViews.map((a) => a.latest_statement).filter(Boolean),
      ["bill_date", "recorded_at"]);
    const payment = latest
      ? { truth_state: "NOT_ESTABLISHED",
          reason: "No governed provider-settlement association exists for this statement." }
      : { truth_state: "NOT_ESTABLISHED", reason: "No provider statement is established." };

    facts.push(envelope("provider", providerViews.length
      ? providerViews.map((p) => p.name) : { truth_state: "NOT_ESTABLISHED" }, asOf,
      { service_class: serviceClass }));
    facts.push(envelope("provider_payment", { truth_state: payment.truth_state }, asOf,
      { service_class: serviceClass, reason: payment.reason }));

    return {
      id: service.id,
      service_class: serviceClass,
      label,
      applicability: { truth_state: "ESTABLISHED", value: "present" },
      providers: providerViews,
      arrangement: arrangement ? {
        physical_arrangement: arrangement.physical_arrangement || null,
        provider_bill_recipient: arrangement.provider_bill_recipient || null,
        provider_responsible_party: arrangement.provider_responsible_party || null,
        economic_responsibility: arrangement.economic_responsibility || null,
        resident_recovery_method: arrangement.resident_recovery_method || null,
        billing_administrator_name: arrangement.billing_administrator_name || null,
        resident_payment_recipient: arrangement.resident_payment_recipient || null,
        evidence: sourceOf(arrangement),
      } : null,
      accounts: accountViews,
      service_points: servicePoints.map((p) => ({
        id: p.id, kind: p.point_kind, label: p.location_label || null,
        unit_id: p.unit_id || null, space_id: p.space_id || null,
        evidence: sourceOf(p),
      })),
      meters: serviceMeters.map((m) => ({
        id: m.id, kind: m.meter_kind,
        identifier_masked: maskIdentifier(m.meter_identifier),
        serves: linksFor(meterPoints, "meter_id", m.id)
          .map((link) => pointById.get(link.service_point_id)).filter(Boolean)
          .map((point) => ({ id: point.id, kind: point.point_kind,
            label: point.location_label || null })),
        evidence: sourceOf(m),
      })),
      latest_statement: latest,
      payment,
      evidence: sourceOf(declaration),
    };
  });

  const establishedServices = serviceViews.filter((s) =>
    s.applicability.value === "present").length;
  const notApplicableServices = serviceViews.filter((s) =>
    s.applicability.value === "not_applicable").length;
  const unresolvedServices = serviceViews.filter((s) =>
    s.applicability.truth_state === "NOT_ESTABLISHED").length;
  const setupState = unresolved.length === 0
    ? "established"
    : (establishedServices || notApplicableServices ? "partially_established" : "not_established");

  const allAccounts = serviceViews.flatMap((s) => s.accounts || []);
  const uniqueAccounts = [...new Map(allAccounts.map((a) => [a.id, a])).values()];
  const allStatements = uniqueAccounts.map((a) => a.latest_statement).filter(Boolean);
  const nextDue = [...allStatements].filter((s) => s.due_date && s.due_date >= asOf)
    .sort((a, b) => a.due_date.localeCompare(b.due_date))[0] || null;

  const standing = {
    contract_version: contract.CONTRACT_VERSION,
    domain: "utility",
    property_id: propertyId,
    as_of: asOf,
    setup_state: setupState,
    established_services: establishedServices,
    not_applicable_services: notApplicableServices,
    unresolved_services: unresolvedServices,
    unresolved_count: unresolved.length,
    services: serviceViews.map((s) => ({
      service_class: s.service_class,
      label: s.label,
      applicability: s.applicability,
      providers: s.providers.map((p) => p.name),
      physical_arrangement: s.arrangement && s.arrangement.physical_arrangement,
      provider_bill_recipient: s.arrangement && s.arrangement.provider_bill_recipient,
      provider_responsible_party: s.arrangement && s.arrangement.provider_responsible_party,
      economic_responsibility: s.arrangement && s.arrangement.economic_responsibility,
      resident_recovery_method: s.arrangement && s.arrangement.resident_recovery_method,
      billing_administrator_name: s.arrangement && s.arrangement.billing_administrator_name,
      resident_payment_recipient: s.arrangement && s.arrangement.resident_payment_recipient,
      account_count: s.accounts.length,
      service_point_count: s.service_points.length,
      meter_count: s.meters.length,
      latest_statement: s.latest_statement,
      provider_payment: s.payment,
    })),
    next_due_statement: nextDue,
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
      services: serviceViews.map((s) => ({
        service_class: s.service_class,
        label: s.label,
        applicability: s.applicability,
      })),
      unresolved,
    },
    standing,
    detail: {
      services: serviceViews,
      accounts: uniqueAccounts,
      service_points: pointRows,
      meters: meterRows.map((m) => ({
        ...m, meter_identifier: undefined,
        identifier_masked: maskIdentifier(m.meter_identifier),
      })),
      recent_statements: allStatements.sort((a, b) =>
        String(b.bill_date || "").localeCompare(String(a.bill_date || ""))),
      unresolved,
    },
  };
}

function statementView(row, usageRows, meterById) {
  return {
    id: row.id,
    statement_identifier: row.statement_identifier || null,
    bill_date: day(row.bill_date),
    service_period_start: day(row.service_period_start),
    service_period_end: day(row.service_period_end),
    due_date: day(row.due_date),
    currency_code: row.currency_code,
    amount_billed_cents: row.amount_billed_cents,
    current_amount_due_cents: row.current_amount_due_cents,
    late_fee_cents: row.late_fee_cents,
    recorded_at: row.recorded_at || null,
    usage: usageRows.filter((u) => u.statement_id === row.id).map((u) => {
      const m = meterById.get(u.meter_id);
      return {
        service_id: u.service_id,
        meter_identifier_masked: m ? maskIdentifier(m.meter_identifier) : null,
        quantity: u.quantity,
        unit: u.usage_unit,
        basis: u.usage_basis,
      };
    }),
    evidence: sourceOf(row),
  };
}

module.exports = { project, day, activeAt, heads, maskIdentifier };
