"use strict";

const projection = require("./utility_projection.js");

const TABLES = Object.freeze({
  services: "utility_services",
  declarations: "utility_service_declarations",
  providers: "utility_providers",
  service_providers: "utility_service_providers",
  arrangements: "utility_arrangements",
  accounts: "utility_provider_accounts",
  account_services: "utility_account_services",
  service_points: "utility_service_points",
  meters: "utility_meters",
  meter_service_points: "utility_meter_service_points",
  account_service_points: "utility_account_service_points",
  account_meters: "utility_account_meters",
  statements: "utility_statements",
  statement_usage: "utility_statement_usage",
});

function requireProperty(propertyId) {
  if (!propertyId) throw new Error("utility_position_read requires property_id");
}

async function readSnapshot(client, { property_id } = {}) {
  requireProperty(property_id);
  const snapshot = { property_id };

  // Provider identity is portfolio-wide, but the reader admits only providers
  // referenced by this property's service relationships, accounts, or meters.
  // Every other table carries property_id directly. No portfolio bag is ever
  // loaded and filtered in JavaScript.
  for (const [key, table] of Object.entries(TABLES)) {
    if (key === "providers") {
      snapshot[key] = (await client.query(
        `select p.id, p.provider_name
           from utility_providers p
          where exists (select 1 from utility_service_providers sp
                         where sp.provider_id = p.id and sp.property_id = $1)
             or exists (select 1 from utility_provider_accounts a
                         where a.provider_id = p.id and a.property_id = $1)
             or exists (select 1 from utility_meters m
                         where m.provider_id = p.id and m.property_id = $1)`,
        [property_id])).rows;
      continue;
    }
    const rows = (await client.query(
      `select * from ${table} where property_id = $1`, [property_id])).rows;
    if (rows.some((row) => String(row.property_id) !== String(property_id))) {
      const error = new Error(`utility_position_read received a foreign-property row from ${table}`);
      error.code = "PROPERTY_SCOPE_VIOLATION";
      throw error;
    }
    snapshot[key] = rows;
  }
  return snapshot;
}

async function readPosition(client, { property_id, as_of = null } = {}) {
  const snapshot = await readSnapshot(client, { property_id });
  return projection.project(snapshot, { as_of });
}

async function readOpening(client, input = {}) {
  return (await readPosition(client, input)).opening;
}

async function readStanding(client, input = {}) {
  return (await readPosition(client, input)).standing;
}

async function readDetail(client, input = {}) {
  return (await readPosition(client, input)).detail;
}

module.exports = {
  TABLES,
  readSnapshot,
  readPosition,
  readOpening,
  readStanding,
  readDetail,
};
