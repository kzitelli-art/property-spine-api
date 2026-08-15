"use strict";

const projection = require("./contracted_service_projection.js");

const TABLES = Object.freeze({
  coverage_reviews: "contracted_service_coverage_reviews",
  requirements: "contracted_service_requirements",
  engagements: "contracted_service_engagements",
  documents: "contracted_service_documents",
  terms: "contracted_service_terms",
  scopes: "contracted_service_scopes",
  locations: "contracted_service_locations",
  prices: "contracted_service_price_components",
  financial_observations: "contracted_service_financial_observations",
  decision_links: "contracted_service_decision_links",
});

function requireProperty(propertyId) {
  if (!propertyId) throw new Error("contracted_service_position_read requires property_id");
}

function assertScoped(rows, propertyId, table) {
  if ((rows || []).some((row) => String(row.property_id) !== String(propertyId))) {
    const error = new Error(`contracted_service_position_read received a foreign-property row from ${table}`);
    error.code = "PROPERTY_SCOPE_VIOLATION";
    throw error;
  }
}

async function readSnapshot(client, { property_id } = {}) {
  requireProperty(property_id);
  const snapshot = { property_id };

  for (const [key, table] of Object.entries(TABLES)) {
    const rows = (await client.query(
      `select * from ${table} where property_id = $1`, [property_id])).rows || [];
    assertScoped(rows, property_id, table);
    snapshot[key] = rows;
  }

  // Provider identity is portfolio-wide. The property reader admits a provider
  // only through this property's engagement or financial observation.
  snapshot.providers = (await client.query(
    `select p.id, p.provider_name
       from contracted_service_providers p
      where exists (
              select 1 from contracted_service_engagements e
               where e.provider_id = p.id and e.property_id = $1)
         or exists (
              select 1 from contracted_service_financial_observations f
               where f.provider_id = p.id and f.property_id = $1)`,
    [property_id])).rows || [];

  // Decision ownership is read through the explicit domain link. Unrelated
  // obligations at the property never enter this projection.
  snapshot.obligations = (await client.query(
    `select o.id, o.property_id, o.assigned_user_id, o.status, o.due_at
       from obligations o
      where o.property_id = $1
        and exists (
          select 1 from contracted_service_decision_links l
           where l.obligation_id = o.id and l.property_id = $1)`,
    [property_id])).rows || [];
  assertScoped(snapshot.obligations, property_id, "obligations");

  const userIds = [...new Set(snapshot.obligations.map((row) => row.assigned_user_id).filter(Boolean))];
  snapshot.users = userIds.length ? (await client.query(
    "select id, name, email from users where id = any($1::uuid[])", [userIds])).rows || [] : [];

  return snapshot;
}

async function readPosition(client, { property_id, as_of = null } = {}) {
  return projection.project(await readSnapshot(client, { property_id }), { as_of });
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

