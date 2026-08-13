"use strict";

const contract = require("./utility_contract.js");

function utilityError(code, message, extra = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, extra);
  return error;
}

function requireUser(userId) {
  if (!userId) throw utilityError("BAD_INPUT", "user_id is required");
}

function requireProperty(propertyId) {
  if (!propertyId) throw utilityError("BAD_INPUT", "property_id is required");
}

function requireDate(name, value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ""))) {
    throw utilityError("BAD_INPUT", `${name} must be an ISO date`);
  }
}

function requireCents(name, value, { nullable = false } = {}) {
  if (nullable && (value === null || value === undefined)) return null;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw utilityError("BAD_INPUT", `${name} must be a non-negative safe integer of cents`);
  }
  return value;
}

function requireProvenance(sourceArtifactId, note, what, { artifactRequired = false } = {}) {
  if (artifactRequired && !sourceArtifactId) {
    throw utilityError("SOURCE_REQUIRED", `${what} requires a retained source artifact`);
  }
  if (!sourceArtifactId && !String(note || "").trim()) {
    throw utilityError("PROVENANCE_REQUIRED",
      `${what} requires a source artifact or a plain account of where the fact came from`);
  }
}

async function assertProperty(client, propertyId) {
  const row = (await client.query("select id from properties where id = $1", [propertyId])).rows[0];
  if (!row) throw utilityError("NOT_FOUND", "property not found");
}

async function assertArtifact(client, propertyId, artifactId) {
  if (!artifactId) return;
  const row = (await client.query(
    "select scope_type, scope_id from source_artifacts where id = $1", [artifactId])).rows[0];
  if (!row) throw utilityError("SOURCE_NOT_FOUND", "source artifact not found");
  if (row.scope_type !== "property" || String(row.scope_id) !== String(propertyId)) {
    throw utilityError("SOURCE_SCOPE_MISMATCH",
      "utility evidence must be retained for the same property");
  }
}

async function assertOwned(client, table, id, propertyId, label) {
  const allowed = new Set([
    "utility_services", "utility_provider_accounts",
    "utility_service_points", "utility_meters", "utility_statements",
  ]);
  if (!allowed.has(table)) throw new Error("utility_service assertOwned table is not allowlisted");
  const row = (await client.query(
    `select * from ${table} where id = $1 and property_id = $2`, [id, propertyId])).rows[0];
  if (!row) throw utilityError("NOT_FOUND", `${label} not found for this property`);
  return row;
}

async function assertProvider(client, providerId) {
  const row = (await client.query(
    "select id, provider_name from utility_providers where id = $1", [providerId])).rows[0];
  if (!row) throw utilityError("NOT_FOUND", "utility provider not found");
  return row;
}

async function assertStatementMap(client, table, leftColumn, leftId, rightColumn, rightId,
  propertyId, periodStart, periodEnd, label) {
  const allowed = new Set(["utility_account_services", "utility_account_meters"]);
  if (!allowed.has(table)) throw new Error("utility_service statement map table is not allowlisted");
  const row = (await client.query(
    `select id from ${table}
      where ${leftColumn} = $1 and ${rightColumn} = $2 and property_id = $3
        and effective_from <= $5 and (effective_to is null or effective_to > $4)
      order by effective_from desc limit 1`,
    [leftId, rightId, propertyId, periodStart, periodEnd])).rows[0];
  if (!row) {
    throw utilityError("BAD_INPUT",
      `${label} is not mapped to this provider account for the statement service period`);
  }
  return row;
}

async function ensureService(client, {
  property_id, service_class, service_label = null, user_id,
} = {}) {
  requireProperty(property_id); requireUser(user_id);
  if (!contract.isOpenServiceKey(service_class)) {
    throw utilityError("BAD_INPUT", "service_class must be an open lower_snake_case utility key");
  }
  await assertProperty(client, property_id);
  const inserted = await client.query(
    `insert into utility_services
       (property_id, service_class, service_label, created_by_user_id)
     values ($1,$2,$3,$4)
     on conflict (property_id, service_class) do nothing
     returning *`,
    [property_id, service_class, service_label && String(service_label).trim(), user_id]);
  if (inserted.rows[0]) return inserted.rows[0];
  return (await client.query(
    `select * from utility_services where property_id = $1 and service_class = $2`,
    [property_id, service_class])).rows[0];
}

async function declareService(client, {
  property_id, service_class, service_label = null, applicability,
  effective_from, effective_to = null,
  source_artifact_id = null, provenance_note = null,
  supersedes_id = null, revision_reason = null, user_id,
} = {}) {
  requireProperty(property_id); requireUser(user_id); requireDate("effective_from", effective_from);
  contract.enumValue("applicability", applicability, contract.APPLICABILITY);
  requireProvenance(source_artifact_id, provenance_note, "a utility service declaration");
  await assertArtifact(client, property_id, source_artifact_id);
  const service = await ensureService(client,
    { property_id, service_class, service_label, user_id });

  if (supersedes_id && !String(revision_reason || "").trim()) {
    throw utilityError("REVISION_REASON_REQUIRED", "a corrected service declaration requires a reason");
  }
  const row = (await client.query(
    `insert into utility_service_declarations
       (property_id, service_id, applicability, effective_from, effective_to,
        source_artifact_id, provenance_note, supersedes_id, revision_reason,
        recorded_by_user_id)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning *`,
    [property_id, service.id, applicability, effective_from, effective_to,
     source_artifact_id, provenance_note, supersedes_id, revision_reason, user_id])).rows[0];
  return { service, declaration: row };
}

async function establishProvider(client, {
  property_id, provider_name, source_artifact_id = null, provenance_note = null, user_id,
} = {}) {
  requireProperty(property_id); requireUser(user_id);
  if (!String(provider_name || "").trim()) {
    throw utilityError("BAD_INPUT", "provider_name is required");
  }
  requireProvenance(source_artifact_id, provenance_note, "a utility provider");
  await assertProperty(client, property_id);
  await assertArtifact(client, property_id, source_artifact_id);
  const inserted = await client.query(
    `insert into utility_providers
       (provider_name, source_artifact_id, provenance_note, recorded_by_user_id)
     values ($1,$2,$3,$4)
     on conflict do nothing returning *`,
    [String(provider_name).trim(), source_artifact_id, provenance_note, user_id]);
  const row = inserted.rows[0] || (await client.query(
    `select * from utility_providers where lower(btrim(provider_name)) = lower(btrim($1))`,
    [String(provider_name).trim()])).rows[0];

  // Identity provenance can originate at another property. Callers receive
  // only the provider identity, never another property's source reference.
  return row ? { id: row.id, provider_name: row.provider_name } : null;
}

async function relateProvider(client, {
  property_id, service_id, provider_id, effective_from, effective_to = null,
  source_artifact_id = null, provenance_note = null, user_id,
} = {}) {
  requireProperty(property_id); requireUser(user_id); requireDate("effective_from", effective_from);
  requireProvenance(source_artifact_id, provenance_note, "a utility provider relationship");
  await assertOwned(client, "utility_services", service_id, property_id, "utility service");
  await assertProvider(client, provider_id);
  await assertArtifact(client, property_id, source_artifact_id);
  return (await client.query(
    `insert into utility_service_providers
       (property_id, service_id, provider_id, effective_from, effective_to,
        source_artifact_id, provenance_note, recorded_by_user_id)
     values ($1,$2,$3,$4,$5,$6,$7,$8)
     on conflict (service_id, provider_id, effective_from) do nothing
     returning *`,
    [property_id, service_id, provider_id, effective_from, effective_to,
     source_artifact_id, provenance_note, user_id])).rows[0] || null;
}

async function recordArrangement(client, {
  property_id, service_id,
  physical_arrangement = null, provider_bill_recipient = null,
  provider_responsible_party = null, economic_responsibility = null,
  resident_recovery_method = null, billing_administrator_name = null,
  resident_payment_recipient = null,
  effective_from, effective_to = null,
  source_artifact_id = null, provenance_note = null,
  supersedes_id = null, revision_reason = null, user_id,
} = {}) {
  requireProperty(property_id); requireUser(user_id); requireDate("effective_from", effective_from);
  requireProvenance(source_artifact_id, provenance_note, "a utility arrangement");
  contract.enumValue("physical_arrangement", physical_arrangement,
    contract.PHYSICAL_ARRANGEMENTS, { nullable: true });
  contract.enumValue("provider_bill_recipient", provider_bill_recipient,
    contract.PROVIDER_BILL_RECIPIENTS, { nullable: true });
  contract.enumValue("provider_responsible_party", provider_responsible_party,
    contract.PROVIDER_RESPONSIBLE_PARTIES, { nullable: true });
  contract.enumValue("economic_responsibility", economic_responsibility,
    contract.ECONOMIC_RESPONSIBILITIES, { nullable: true });
  contract.enumValue("resident_recovery_method", resident_recovery_method,
    contract.RESIDENT_RECOVERY_METHODS, { nullable: true });
  contract.enumValue("resident_payment_recipient", resident_payment_recipient,
    contract.RESIDENT_PAYMENT_RECIPIENTS, { nullable: true });
  if (resident_payment_recipient === "billing_administrator"
      && !String(billing_administrator_name || "").trim()) {
    throw utilityError("BAD_INPUT",
      "billing_administrator_name is required when the billing administrator receives payment");
  }
  if (supersedes_id && !String(revision_reason || "").trim()) {
    throw utilityError("REVISION_REASON_REQUIRED", "a corrected utility arrangement requires a reason");
  }
  await assertOwned(client, "utility_services", service_id, property_id, "utility service");
  await assertArtifact(client, property_id, source_artifact_id);
  return (await client.query(
    `insert into utility_arrangements
       (property_id, service_id, physical_arrangement, provider_bill_recipient,
        provider_responsible_party, economic_responsibility, resident_recovery_method,
        billing_administrator_name, resident_payment_recipient,
        effective_from, effective_to, source_artifact_id, provenance_note,
        supersedes_id, revision_reason, recorded_by_user_id)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
     returning *`,
    [property_id, service_id, physical_arrangement, provider_bill_recipient,
     provider_responsible_party, economic_responsibility, resident_recovery_method,
     billing_administrator_name && String(billing_administrator_name).trim(),
     resident_payment_recipient, effective_from, effective_to, source_artifact_id,
     provenance_note, supersedes_id, revision_reason, user_id])).rows[0];
}

async function establishAccount(client, {
  property_id, provider_id, external_account_identifier,
  billing_cadence = null, service_address = null, billing_address = null,
  effective_from, effective_to = null,
  source_artifact_id = null, provenance_note = null, user_id,
} = {}) {
  requireProperty(property_id); requireUser(user_id); requireDate("effective_from", effective_from);
  if (!String(external_account_identifier || "").trim()) {
    throw utilityError("BAD_INPUT", "external_account_identifier is required");
  }
  requireProvenance(source_artifact_id, provenance_note, "a provider account");
  await assertProvider(client, provider_id);
  await assertArtifact(client, property_id, source_artifact_id);
  return (await client.query(
    `insert into utility_provider_accounts
       (property_id, provider_id, external_account_identifier, billing_cadence,
        service_address, billing_address, effective_from, effective_to,
        source_artifact_id, provenance_note, recorded_by_user_id)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning *`,
    [property_id, provider_id, String(external_account_identifier).trim(), billing_cadence,
     service_address, billing_address, effective_from, effective_to,
     source_artifact_id, provenance_note, user_id])).rows[0];
}

async function recordServicePoint(client, {
  property_id, service_id, point_kind, location_label = null, service_address = null,
  unit_id = null, space_id = null, effective_from, effective_to = null,
  source_artifact_id = null, provenance_note = null, user_id,
} = {}) {
  requireProperty(property_id); requireUser(user_id); requireDate("effective_from", effective_from);
  contract.enumValue("point_kind", point_kind, contract.SERVICE_POINT_KINDS);
  if (point_kind === "unit" && !unit_id) throw utilityError("BAD_INPUT", "unit_id is required");
  if (point_kind === "space" && !space_id) throw utilityError("BAD_INPUT", "space_id is required");
  requireProvenance(source_artifact_id, provenance_note, "a utility service point");
  await assertOwned(client, "utility_services", service_id, property_id, "utility service");
  await assertArtifact(client, property_id, source_artifact_id);
  return (await client.query(
    `insert into utility_service_points
       (property_id, service_id, point_kind, location_label, service_address,
        unit_id, space_id, effective_from, effective_to, source_artifact_id,
        provenance_note, recorded_by_user_id)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning *`,
    [property_id, service_id, point_kind, location_label, service_address,
     unit_id, space_id, effective_from, effective_to, source_artifact_id,
     provenance_note, user_id])).rows[0];
}

async function recordMeter(client, {
  property_id, provider_id = null, meter_kind, meter_identifier,
  effective_from, effective_to = null,
  source_artifact_id = null, provenance_note = null, user_id,
} = {}) {
  requireProperty(property_id); requireUser(user_id); requireDate("effective_from", effective_from);
  contract.enumValue("meter_kind", meter_kind, contract.METER_KINDS);
  if (!String(meter_identifier || "").trim()) {
    throw utilityError("BAD_INPUT", "meter_identifier is required");
  }
  if (meter_kind === "provider_meter" && !provider_id) {
    throw utilityError("BAD_INPUT", "provider_id is required for a provider meter");
  }
  requireProvenance(source_artifact_id, provenance_note, "a utility meter");
  await assertProperty(client, property_id);
  if (provider_id) {
    await assertProvider(client, provider_id);
  }
  await assertArtifact(client, property_id, source_artifact_id);
  return (await client.query(
    `insert into utility_meters
       (property_id, provider_id, meter_kind, meter_identifier, effective_from,
        effective_to, source_artifact_id, provenance_note, recorded_by_user_id)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning *`,
    [property_id, provider_id, meter_kind, String(meter_identifier).trim(),
     effective_from, effective_to, source_artifact_id, provenance_note, user_id])).rows[0];
}

const LINK_SPECS = Object.freeze({
  account_service: Object.freeze({
    table: "utility_account_services", left: "account_id", right: "service_id",
    leftTable: "utility_provider_accounts", leftLabel: "provider account",
    rightTable: "utility_services", rightLabel: "utility service",
  }),
  meter_service_point: Object.freeze({
    table: "utility_meter_service_points", left: "meter_id", right: "service_point_id",
    leftTable: "utility_meters", leftLabel: "utility meter",
    rightTable: "utility_service_points", rightLabel: "utility service point",
  }),
  account_service_point: Object.freeze({
    table: "utility_account_service_points", left: "account_id", right: "service_point_id",
    leftTable: "utility_provider_accounts", leftLabel: "provider account",
    rightTable: "utility_service_points", rightLabel: "utility service point",
  }),
  account_meter: Object.freeze({
    table: "utility_account_meters", left: "account_id", right: "meter_id",
    leftTable: "utility_provider_accounts", leftLabel: "provider account",
    rightTable: "utility_meters", rightLabel: "utility meter",
  }),
});

async function link(client, kind, {
  property_id, left_id, right_id, effective_from, effective_to = null,
  source_artifact_id = null, provenance_note = null, user_id,
} = {}) {
  const spec = LINK_SPECS[kind];
  if (!spec) throw utilityError("BAD_INPUT", "unknown utility relationship kind");
  requireProperty(property_id); requireUser(user_id); requireDate("effective_from", effective_from);
  requireProvenance(source_artifact_id, provenance_note, "a utility map relationship");
  await assertOwned(client, spec.leftTable, left_id, property_id, spec.leftLabel);
  await assertOwned(client, spec.rightTable, right_id, property_id, spec.rightLabel);
  await assertArtifact(client, property_id, source_artifact_id);
  return (await client.query(
    `insert into ${spec.table}
       (property_id, ${spec.left}, ${spec.right}, effective_from, effective_to,
        source_artifact_id, provenance_note, recorded_by_user_id)
     values ($1,$2,$3,$4,$5,$6,$7,$8)
     on conflict (${spec.left}, ${spec.right}, effective_from) do nothing
     returning *`,
    [property_id, left_id, right_id, effective_from, effective_to,
     source_artifact_id, provenance_note, user_id])).rows[0] || null;
}

async function recordStatement(client, {
  property_id, account_id, statement_identifier = null,
  bill_date, service_period_start, service_period_end, due_date = null,
  currency_code, amount_billed_cents, current_amount_due_cents = null,
  late_fee_cents = null, source_artifact_id, provenance_note = null,
  supersedes_id = null, revision_reason = null, usage = [], user_id,
} = {}) {
  requireProperty(property_id); requireUser(user_id);
  for (const [name, value] of [["bill_date", bill_date],
    ["service_period_start", service_period_start], ["service_period_end", service_period_end]]) {
    requireDate(name, value);
  }
  if (due_date) requireDate("due_date", due_date);
  if (service_period_end < service_period_start) {
    throw utilityError("BAD_INPUT", "service_period_end must be on or after service_period_start");
  }
  if (!/^[A-Z]{3}$/.test(String(currency_code || ""))) {
    throw utilityError("BAD_INPUT", "currency_code must be an explicit three-letter ISO code");
  }
  requireCents("amount_billed_cents", amount_billed_cents);
  requireCents("current_amount_due_cents", current_amount_due_cents, { nullable: true });
  requireCents("late_fee_cents", late_fee_cents, { nullable: true });
  requireProvenance(source_artifact_id, provenance_note, "a utility statement",
    { artifactRequired: true });
  if (supersedes_id && !String(revision_reason || "").trim()) {
    throw utilityError("REVISION_REASON_REQUIRED", "a corrected utility statement requires a reason");
  }
  await assertOwned(client, "utility_provider_accounts", account_id, property_id,
    "provider account");
  await assertArtifact(client, property_id, source_artifact_id);

  const usageItems = usage || [];
  for (const item of usageItems) {
    contract.enumValue("usage_basis", item.usage_basis, contract.USAGE_BASES);
    if (!Number.isFinite(item.quantity) || item.quantity < 0) {
      throw utilityError("BAD_INPUT", "usage quantity must be a non-negative number");
    }
    if (!String(item.usage_unit || "").trim()) {
      throw utilityError("BAD_INPUT", "usage_unit is required when usage is recorded");
    }
    await assertOwned(client, "utility_services", item.service_id, property_id, "utility service");
    await assertStatementMap(client, "utility_account_services", "account_id", account_id,
      "service_id", item.service_id, property_id, service_period_start, service_period_end,
      "utility service");
    if (item.meter_id) {
      await assertOwned(client, "utility_meters", item.meter_id, property_id, "utility meter");
      await assertStatementMap(client, "utility_account_meters", "account_id", account_id,
        "meter_id", item.meter_id, property_id, service_period_start, service_period_end,
        "utility meter");
    }
  }

  const statement = (await client.query(
    `insert into utility_statements
       (property_id, account_id, statement_identifier, bill_date,
        service_period_start, service_period_end, due_date, currency_code,
        amount_billed_cents, current_amount_due_cents, late_fee_cents,
        source_artifact_id, provenance_note, supersedes_id, revision_reason,
        recorded_by_user_id)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
     returning *`,
    [property_id, account_id, statement_identifier, bill_date,
     service_period_start, service_period_end, due_date, currency_code,
     amount_billed_cents, current_amount_due_cents, late_fee_cents,
     source_artifact_id, provenance_note, supersedes_id, revision_reason, user_id])).rows[0];

  const recordedUsage = [];
  for (const item of usageItems) {
    recordedUsage.push((await client.query(
      `insert into utility_statement_usage
         (property_id, statement_id, account_id, service_id, meter_id,
          quantity, usage_unit, usage_basis, source_artifact_id, recorded_by_user_id)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning *`,
      [property_id, statement.id, account_id, item.service_id, item.meter_id || null,
       item.quantity, String(item.usage_unit).trim(), item.usage_basis,
       source_artifact_id, user_id])).rows[0]);
  }
  return { statement, usage: recordedUsage };
}

module.exports = {
  utilityError,
  ensureService,
  declareService,
  establishProvider,
  relateProvider,
  recordArrangement,
  establishAccount,
  recordServicePoint,
  recordMeter,
  link,
  recordStatement,
};
