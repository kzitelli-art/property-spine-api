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

  // Every table carries property_id by construction. The reader never loads a
  // portfolio bag and filters in JavaScript; authority stays in each SELECT.
  for (const [key, table] of Object.entries(TABLES)) {
    snapshot[key] = (await client.query(
      `select * from ${table} where property_id = $1`, [property_id])).rows;
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

