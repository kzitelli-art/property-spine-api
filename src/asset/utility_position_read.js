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

/*  Every loader runs the same foreign-row check, including the bounded
    usage loader below. A second loading path that skipped it would be a
    second scope boundary, and the weaker one would be the real one. */
function assertOwned(rows, propertyId, table) {
  if (rows.some((row) => String(row.property_id) !== String(propertyId))) {
    const error = new Error(`utility_position_read received a foreign-property row from ${table}`);
    error.code = "PROPERTY_SCOPE_VIOLATION";
    throw error;
  }
  return rows;
}

/*  ── STATEMENT USAGE IS LOADED SEPARATELY, AND BOUNDED · §40.6 ────────
 *  `utility_statement_usage` is the fastest-growing table this read
 *  touches: rows arrive per meter, per line, per statement, per billing
 *  cycle, forever. It used to be loaded in full by the generic TABLES
 *  loop below.
 *
 *  Only ONE thing ever reads them. utility_projection.js passes the array
 *  to statementView() exactly once — for the LATEST statement of each
 *  account — and statementView filters it with
 *  `usageRows.filter((u) => u.statement_id === row.id)`. Every other row
 *  was loaded, held in memory and discarded. detail.recent_statements is
 *  built from those same already-built views, not from raw statements, so
 *  no surface reaches usage for any other statement.
 *
 *  ⚠ THE SELECTION IS NOT REPRODUCED HERE. Which statement is "latest",
 *  what supersedes what, and how as_of applies are owned by
 *  utility_projection.js and by nothing else. This module asks that
 *  module which statements survived, then loads usage for exactly those
 *  ids. There is no date comparison and no supersession rule in this file
 *  or in SQL — a second selection path is precisely the defect this
 *  shape exists to avoid.                                               */
async function loadStatementUsage(client, { property_id, statement_ids } = {}) {
  requireProperty(property_id);
  if (!statement_ids || !statement_ids.length) return [];
  const rows = (await client.query(
    `select * from ${TABLES.statement_usage}
      where property_id = $1`,
    [property_id])).rows;
  return assertOwned(rows, property_id, TABLES.statement_usage);
}

/*  THE FULL SERIES, REACHABLE BY NAME.
 *
 *  ⚠ ACTIVATION, STATED HONESTLY: this is a CLASS 1 detail primitive with
 *  NO PRODUCT CALLER. Nothing in src/ invokes it. It is exercised only by
 *  tests/utility_statement_usage_bound_equivalence.db.js. It is NOT a live
 *  detail surface and must not be described as one.
 *
 *  It exists rather than being deleted because §40.6 is standing PLUS
 *  detail: bounding the standing path is not permission to make the series
 *  unreachable, and a caller that appears later must not have to
 *  reintroduce an unbounded load in the standing read to get it.        */
async function loadAllStatementUsage(client, { property_id } = {}) {
  requireProperty(property_id);
  const rows = (await client.query(
    `select * from ${TABLES.statement_usage} where property_id = $1`,
    [property_id])).rows;
  return assertOwned(rows, property_id, TABLES.statement_usage);
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
    if (key === "statement_usage") {
      //  Bounded, and only once the projection has said which statements
      //  survive. Empty here so the provisional pass is honest about it.
      snapshot[key] = [];
      continue;
    }
    const rows = (await client.query(
      `select * from ${table} where property_id = $1`, [property_id])).rows;
    snapshot[key] = assertOwned(rows, property_id, table);
  }
  return snapshot;
}

/*  ── TWO PASSES THROUGH ONE CANONICAL PROJECTION ──────────────────────
 *  The provisional pass issues NO queries — project() is pure. It exists
 *  only to ask the canonical owner which statements survived into the
 *  position, so the bounded usage query can name them.
 *
 *  ⚠ THE SAME as_of GOES INTO BOTH PASSES. Threading a different one —
 *  or letting the provisional pass default to today while the caller
 *  asked for a historical date — would select usage for one set of
 *  statements and render another. `as_of` is passed through unchanged,
 *  null included, so both passes resolve it identically inside the
 *  projection.                                                          */
async function readPosition(client, { property_id, as_of = null } = {}) {
  const snapshot = await readSnapshot(client, { property_id });

  /*  ── as_of IS RESOLVED ONCE, HERE, AND IT IS NEVER NULL DOWNSTREAM ──
   *  ⚠ PASSING null TO BOTH PASSES IS NOT THE SAME AS PASSING ONE VALUE.
   *  project() resolves its own default — `day(as_of) || today` — so two
   *  calls with null each ask the clock independently. A read that
   *  straddles UTC midnight would then discover the surviving statements
   *  for one day and render the position for the next: usage attached to
   *  statements the final pass never selected.
   *
   *  Resolved through the CANONICAL exported helper, and today through the
   *  same helper rather than a second copy of the expression — so this
   *  cannot drift from what project() would have computed. An explicit
   *  as_of is passed through untouched.                                 */
  const asOf = projection.day(as_of) || projection.day(new Date());

  const provisional = projection.project(snapshot, { as_of: asOf });
  const statementIds = [...new Set(
    ((provisional.detail && provisional.detail.recent_statements) || [])
      .map((statement) => statement && statement.id)
      .filter(Boolean)
      .map(String))];

  snapshot.statement_usage = await loadStatementUsage(client, {
    property_id, statement_ids: statementIds,
  });
  return projection.project(snapshot, { as_of: asOf });
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
  loadStatementUsage,
  loadAllStatementUsage,
  readPosition,
  readOpening,
  readStanding,
  readDetail,
};
