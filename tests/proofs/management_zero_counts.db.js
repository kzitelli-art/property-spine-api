/*
 * management_zero_counts.db.js — a reconciled source may state zero occupied
 * while its current rows contain occupied entries.  The source summary is
 * explicit evidence; consumers must preserve that literal zero instead of
 * falling back to a truthy row-derived count.
 *
 * This proof uses the existing signed-in reconciliation import and rent-roll
 * read routes.  It refuses to substitute direct database rows if the import
 * route is unavailable.  The disposable database and loopback server belong
 * to the caller's proof wrapper.
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const boundary = require("../e2e/proof_boundary.js");
require("../e2e/proof_fence_preload.js");
const { Pool } = require("pg");
const sessions = require("../../src/identity/staff_session_service.js");

const AS_OF = "2026-07-31";
const api = String(process.env.E2E_API_BASE || "").replace(/\/+$/, "");
let passed = 0;
let failed = 0;

function ok(label, condition) {
  if (condition) {
    passed += 1;
    console.log(`  ok    ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${label}`);
  }
}

function safeError(error) {
  const message = error && (error.publicMessage || error.code || error.message);
  return String(message || "proof failed")
    .replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, "<id>")
    .replace(/\bspine_proof_[a-f0-9]+\b/gi, "<owned-proof-db>")
    .slice(0, 240);
}

async function main() {
  if (!api) throw new Error("E2E_API_BASE is required; this proof exercises HTTP doors");
  await boundary.assertDatabase();

  const manifest = boundary.manifest();
  const pool = new Pool({ connectionString: manifest.url, ssl: false });
  try {
  const one = async (sql, args = []) => (await pool.query(sql, args)).rows[0];

  async function request(pathname, token, body) {
    const headers = { "x-staff-session": token, "content-type": "application/json" };
    const response = await fetch(api + pathname, {
      method: body === undefined ? "GET" : "POST",
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    });
    const bytes = Buffer.from(await response.arrayBuffer());
    let json = null;
    if ((response.headers.get("content-type") || "").includes("json") && bytes.length) {
      try { json = JSON.parse(bytes.toString("utf8")); } catch (_) { json = null; }
    }
    return { status: response.status, body: json };
  }

  async function issue(userId, propertyId) {
    const client = await pool.connect();
    try {
      await client.query("begin");
      const issued = await sessions.issueStaffSession(client, {
        userId,
        propertyId,
        purpose: "bootstrap_invite",
      });
      await client.query("commit");
      return issued.session_token;
    } finally {
      client.release();
    }
  }

  async function makeProperty(tag, name) {
    const property = await one(`insert into properties
      (name,canonical_key,organization_id,leasing_basis)
      values($1,$1,$2,'unit') returning id`, [`${tag}-${name}`, org.id]);
    await pool.query(`insert into property_team_assignments
      (property_id,user_id,role_title,allowed_modules,active)
      values($1,$2,'Synthetic management proof','{management,leasing}',true)`,
      [property.id, operator.id]);
    return property;
  }

  function reconciliation(name, occupied, vacant) {
    const unit_truth = [];
    for (let i = 0; i < occupied; i += 1) {
      unit_truth.push({
        Unit: `${name}-O${i + 1}`,
        "Unit Type": "1BR",
        "Current State": "occupied",
        "Current Resident": `Synthetic occupied ${i + 1}`,
        "Current Rent": 1000 + i,
      });
    }
    for (let i = 0; i < vacant; i += 1) {
      unit_truth.push({
        Unit: `${name}-V${i + 1}`,
        "Unit Type": "1BR",
        "Current State": "vacant",
        "Current Resident": null,
        "Current Rent": null,
      });
    }
    return {
      property: { name: `${tag}-${name}` },
      as_of: AS_OF,
      inventory: {
        residential_units: unit_truth.length,
        current_occupied: occupied,
        current_vacant: vacant,
        model: 0,
        down: 0,
        current_occupancy_pct: unit_truth.length
          ? occupied / unit_truth.length
          : null,
      },
      unit_truth,
    };
  }

  async function importAndRead(label, property, token, document) {
    const imported = await request("/operator/rent-roll/import", token, {
      reconciliation: document,
      source_file: `${tag}-${label}.json`,
      source_as_of_date: AS_OF,
    });
    const importAccepted = imported.status === 201 || imported.status === 200;
    ok(`${label}: existing reconciliation import route accepts authorized session`, importAccepted);
    if (!importAccepted) {
      throw new Error(`reconciliation import refused with HTTP ${imported.status}`);
    }

    const read = await request(`/operator/rent-roll?as_of=${AS_OF}`, token);
    const body = read.body || {};
    const rows = Array.isArray(body.rows) ? body.rows : [];
    const rowDerivedOccupied = rows.filter((row) =>
      ["current", "occupied", "notice", "commercial"].includes(String(row.status).toLowerCase())
    ).length;
    const summary = body.summary || {};
    ok(`${label}: existing rent-roll read returns reconciled source`,
      read.status === 200 && body.has_data === true && summary.reconciled === true
      && body.property_id === property.id);
    ok(`${label}: source and row cardinality are visible`,
      rows.length === document.unit_truth.length
      && summary.inventory === document.inventory.residential_units
      && summary.current_rows === document.inventory.residential_units
      && summary.source_rows === document.unit_truth.length);
    ok(`${label}: source summary preserves its literal occupied count`,
      summary.occupied === document.inventory.current_occupied
      && summary.residential_occupied === document.inventory.current_occupied);
    return { read, body, rows, rowDerivedOccupied, summary };
  }

  const tag = `management-zero-${randomUUID()}`;
  const org = await one("insert into organizations(name,slug) values($1,$1) returning id", [tag]);
  const person = await one("insert into persons(name) values($1) returning id", [`${tag}-operator`]);
  const operator = await one(`insert into users
    (name,email,role,platform_role,organization_id,person_id,is_active,status,account_kind)
    values($1,$2,'property_manager','member',$3,$4,true,'active','human_staff') returning id`,
    [`${tag} operator`, `${tag}@example.test`, org.id, person.id]);
  const zeroProperty = await makeProperty(tag, "zero");
  const controlProperty = await makeProperty(tag, "control");
  const zeroToken = await issue(operator.id, zeroProperty.id);
  const controlToken = await issue(operator.id, controlProperty.id);

    const zeroDocument = reconciliation("zero", 2, 0);
    // Deliberately inconsistent retained-source totals exercise the existing
    // summary precedence contract, not a claim about real property occupancy.
    zeroDocument.inventory.current_occupied = 0;
    zeroDocument.inventory.current_vacant = 2;
    zeroDocument.inventory.current_occupancy_pct = 0;
    const controlDocument = reconciliation("control", 1, 1);
    const zero = await importAndRead("zero", zeroProperty, zeroToken, zeroDocument);
    const control = await importAndRead("control", controlProperty, controlToken, controlDocument);

    ok("zero case: two current rows derive occupied count 2 while source summary is 0",
      zero.rowDerivedOccupied === 2
      && zero.summary.occupied === 0
      && zero.summary.residential_occupied === 0);
    ok("known occupied control: one current row and source summary occupied 1 agree",
      control.rowDerivedOccupied === 1
      && control.summary.occupied === 1
      && control.summary.residential_occupied === 1);

    if (failed === 0 && process.env.PROOF_OUTPUT_DIR) {
      const outputDir = path.resolve(process.env.PROOF_OUTPUT_DIR);
      fs.mkdirSync(outputDir, { recursive: true });
      fs.writeFileSync(path.join(outputDir, "zero-state.private.json"), JSON.stringify({
        proof: "management_zero_counts",
        version: 1,
        fixtures: [
          { token: zeroToken, property_id: zeroProperty.id, occupied: 0, inventory: 2 },
          { token: controlToken, property_id: controlProperty.id, occupied: 1, inventory: 2 },
        ],
      }), { mode: 0o600 });
    }
  } finally {
    await pool.end();
  }

  console.log(`\n════ ${passed} passed, ${failed} failed ════`);
  process.exitCode = failed ? 1 : 0;
}

main().catch((error) => {
  console.error(`MANAGEMENT_ZERO_COUNTS_FAILED: ${safeError(error)}`);
  process.exitCode = 1;
});
