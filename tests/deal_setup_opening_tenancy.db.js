#!/usr/bin/env node
/* ════════════════════════════════════════════════════════════════════
   HARNESS — DEAL AUTHORITY · ACTIVATION · OPENING POSITION

   Real Postgres. Real constraints. Real transactions. No mocks: the
   services under test are the shipped ones, reached through their
   exported functions, and every assertion reads the database back rather
   than trusting a return value.

   ── WHAT IT PROVES ──────────────────────────────────────────────────
   A  DEAL AUTHORITY — 1A's doctrine, one layer up
      A1  a deal cannot be opened with no actor
      A2  a 'member' may not open a deal
      A3  a super_admin must NAME the organization
      A4  an org_admin's organization comes from the LOGIN
      A5  an org_admin naming a SIBLING organization is refused
      A6  every created deal carries an owner
      A7  a creation event records both identities and the authority used
      A8  that event cannot be updated
      A9  that event cannot be deleted
      A10 org → org reparenting is refused BY THE DATABASE
      A11 org → null (orphaning) is refused BY THE DATABASE
      A12 a bare INSERT is repaired, not trusted

   B  MEMBERSHIP — reuse 025, add currency, keep history
      B1  a property joins a deal through deal_intake_properties
      B2  a property owned by another client is refused
      B3  a property already current in another deal is refused
      B4  releasing keeps the row as history, status='released'
      B5  after release the property may join a new deal
      B6  the released membership is STILL READABLE (history survives)
      B7  the database refuses two current memberships for one property

   C  RETAINED ARTIFACT — the file, not its name
      C1  bytes, digest and size are stored together
      C2  the digest is of the real bytes
      C3  re-uploading identical bytes returns the SAME artifact
      C4  the bytes come back byte-identical
      C5  an artifact about a nonexistent scope is refused
      C6  the bytes cannot be rewritten
      C7  the artifact cannot be deleted
      C8  a renamed .csv that is really a workbook is refused

   D  ACTIVATION — one act, two substrates
      D1  an activation cannot exist without a property (fail CLOSED)
      D2  reading a rent roll writes an import_batch
      D3  …with the retained artifact on it
      D4  …and one import_source_row per readable row
      D5  a row with no unit number is EVIDENCE, not a silent drop
      D6  proposals are created, one per source row
      D7  every proposal points at its source row BY FOREIGN KEY
      D8  a row with no rent is needs_review, not staged
      D9  a vacant row is staged, not flagged as missing a tenant
      D10 re-reading the same file for the same property is refused
      D11 a rent roll with no unit column is refused, naming the columns
      D12 an artifact belonging to another property is refused

   E  CONFIRMATION — canonical truth, and the lineage loop closed
      E1  confirming writes a person and a lease
      E2  the lease is stamped with the import batch
      E3  the evidence row now names the lease it produced
      E4  …and the person it produced
      E5  a vacant row confirms WITHOUT inventing a lease
      E6  confirming twice is refused
      E7  people are never merged by name
      E8  a by-the-bed unit refuses to guess which bed

   F  OPENING POSITION — the statement, not a second rent roll
      F1  it cannot be established before anything is confirmed
      F2  it records what was established, as of the document's date
      F3  it counts what is still unresolved
      F4  it names its source artifact
      F5  it holds NO copy of any lease
      F6  what it established cannot be rewritten
      F7  re-establishing SUPERSEDES rather than duplicating
      F8  only one established position per property exists at a time

   H  THE CONSTRAINT SCANS WHAT THE CODE WRITES
      H1  every source_type any writer produces is permitted by the CHECK
      H2  the service's creation-source list and the database CHECK agree
          — read from the SOURCE, whole repo, because 158's first version
          claimed this after reading one writer and was wrong in production

   G  THE WHOLE CHAIN, WALKED IN SQL
      G1  file → source row → proposal → decision → lease, in one join
      G2  the position reaches its artifact through the batch

   run:  HARNESS_DATABASE_URL="postgres://..." node tests/deal_setup_opening_tenancy.db.js
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const crypto = require("crypto");
const { Pool } = require("pg");
const receipt = require("./_run_receipt.js");

const dealService = require("../src/onboarding/deal_service.js");
const activation  = require("../src/onboarding/activation_service.js");
const artifacts   = require("../src/onboarding/source_artifact_service.js");
const propertyCreation = require("../src/identity/property_creation_service.js");

const URL = receipt.harnessConnectionString();
const pool = new Pool({ connectionString: URL, ssl: { rejectUnauthorized: false } });

let pass = 0, fail = 0;
const ok = (label, cond, detail) => {
  if (cond) { pass++; console.log("  ok    " + label); }
  else { fail++; console.log("  FAIL  " + label + (detail ? "\n        " + detail : "")); }
  return cond;
};

//  Refusals are asserted by STABLE KEY, never by prose. A proof that
//  matches on message text passes when the wording is right and the
//  behaviour is wrong.
async function refused(label, expectedReason, fn) {
  try {
    await fn();
    return ok(label, false, "it was ALLOWED. Expected refusal: " + expectedReason);
  } catch (e) {
    const got = e.reason || e.refusalReason || e.code || e.message;
    return ok(label + "  → " + got, got === expectedReason,
      `expected '${expectedReason}', got '${got}'`);
  }
}
async function refusedByDatabase(label, fn) {
  try { await fn(); return ok(label, false, "the database ALLOWED it"); }
  catch (e) {
    //  pg reports SQLSTATE, not the condition NAME the migration raised
    //  with. 23001 = restrict_violation, 23505 = unique_violation,
    //  23502 = not_null_violation, 23503 = foreign_key_violation,
    //  P0001 = a bare `raise exception`. Asserting on the message text
    //  instead would pass whenever the prose was right and the behaviour
    //  was wrong.
    const DB_REFUSALS = new Set(["23001", "23505", "23502", "23503", "23514", "P0001"]);
    return ok(label + "  → SQLSTATE " + (e.code || "?"),
      DB_REFUSALS.has(String(e.code)),
      "expected a database refusal, got: " + e.code + " " + e.message);
  }
}

const TAG = "AMB1_" + process.pid;
const N = 100000 + (process.pid % 800000);

//  A real .csv, built here so the bytes under test are bytes we can state
//  exactly. Headers are deliberately MESSY — "Unit #", "Mkt Rent",
//  "Lease From" — because the mapping layer's whole job is real exports.
function rentRollCsv() {
  return [
    "Unit #,Resident,Mkt Rent,Actual Rent,Lease From,Lease To,Security Deposit,Balance,Notes",
    "101,\"Alvarez, Maria\",1500,1450,2025-06-01,2026-05-31,1450,0,renewed",
    "102,\"Chen, Wei\",1600,1600,2025-09-01,2026-08-31,1600,125.50,",
    "103,VACANT,1550,,,,,,ready",
    "104,\"Okafor, Ada\",1700,,2025-01-15,2026-01-14,1700,0,no rent on report",
    ",\"Ghost, Row\",1400,1400,2025-01-01,2025-12-31,,0,no unit number",
  ].join("\n");
}
//  Rows exactly as the browser's parser hands them over: original headers,
//  a 1-based __row_number. Parsed here rather than imported so the harness
//  does not depend on the app being loadable.
function parseCsvLikeTheApp(text) {
  const lines = text.split("\n").filter((l) => l.trim() !== "");
  const split = (l) => {
    const out = []; let cell = "", q = false;
    for (let i = 0; i < l.length; i++) {
      const ch = l[i];
      if (ch === '"') { if (q && l[i + 1] === '"') { cell += '"'; i++; } else q = !q; }
      else if (ch === "," && !q) { out.push(cell); cell = ""; }
      else cell += ch;
    }
    out.push(cell); return out;
  };
  const header = split(lines.shift()).map((h) => h.trim());
  return lines.map((l, i) => {
    const cells = split(l); const o = {};
    header.forEach((h, j) => { if (h) o[h] = (cells[j] ?? "").trim(); });
    o.__row_number = i + 2;
    return o;
  });
}

(async () => {
  receipt.begin(__filename, { url: URL, expected: 69 });

  // ── fixtures ───────────────────────────────────────────────────────
  const orgA = (await pool.query(
    `insert into organizations (name, slug) values ($1,$2) returning id`,
    [TAG + " Org A", TAG.toLowerCase() + "-a"])).rows[0].id;
  const orgB = (await pool.query(
    `insert into organizations (name, slug) values ($1,$2) returning id`,
    [TAG + " Org B", TAG.toLowerCase() + "-b"])).rows[0].id;

  const person = (await pool.query(
    `insert into persons (name) values ($1) returning id`, [TAG + " Human"])).rows[0].id;

  const mkUser = async (role, org) => (await pool.query(
    `insert into users (name, email, platform_role, organization_id, is_active, status, person_id)
     values ($1,$2,$3,$4,true,'active',$5) returning id`,
    [`${TAG} ${role}`, `${TAG}.${role}.${Math.random().toString(36).slice(2)}@example.test`,
     role, org, person])).rows[0].id;

  const superAdmin = await mkUser("super_admin", null);
  const adminA     = await mkUser("org_admin", orgA);
  const adminB     = await mkUser("org_admin", orgB);
  const member     = await mkUser("member", orgA);

  console.log("\n── A · DEAL AUTHORITY ──────────────────────────────────────");

  await refused("A1  no actor is refused", "no_authenticated_actor", () =>
    dealService.createDeal(pool, { deal_name: "X", creation_source: "asset_management_console" }));

  await refused("A2  a member may not open a deal", "insufficient_platform_role", () =>
    dealService.createDeal(pool, { user_id: member, deal_name: "X",
      creation_source: "asset_management_console" }));

  await refused("A3  super_admin must name the organization", "organization_required", () =>
    dealService.createDeal(pool, { user_id: superAdmin, deal_name: "X",
      creation_source: "asset_management_console" }));

  const dealA = await dealService.createDeal(pool, {
    user_id: adminA, deal_name: TAG + " SOLO", creation_source: "asset_management_console" });
  ok("A4  an org_admin's organization comes from the login", dealA.organization_id === orgA,
     `got ${dealA.organization_id}`);

  await refused("A5  an org_admin naming a sibling org is refused", "organization_scope_violation", () =>
    dealService.createDeal(pool, { user_id: adminA, deal_name: "X",
      requested_organization_id: orgB, creation_source: "asset_management_console" }));

  const dbDeal = (await pool.query(
    `select organization_id, organization_absent_reason from deal_intakes where id=$1`,
    [dealA.id])).rows[0];
  ok("A6  the created deal carries an owner",
     dbDeal.organization_id === orgA && dbDeal.organization_absent_reason === null);

  const ev = (await pool.query(
    `select * from deal_creation_events where deal_intake_id=$1`, [dealA.id])).rows;
  ok("A7  one creation event, both identities, authority recorded",
     ev.length === 1 && ev[0].actor_user_id === adminA && ev[0].actor_person_id === person
     && ev[0].authority_basis === "platform_role:org_admin"
     && ev[0].creation_source === "asset_management_console",
     JSON.stringify(ev[0] || {}));

  await refusedByDatabase("A8  the creation event cannot be updated", () =>
    pool.query(`update deal_creation_events set deal_name='rewritten' where id=$1`, [ev[0].id]));
  await refusedByDatabase("A9  the creation event cannot be deleted", () =>
    pool.query(`delete from deal_creation_events where id=$1`, [ev[0].id]));

  await refusedByDatabase("A10 org → org reparenting refused by the database", () =>
    pool.query(`update deal_intakes set organization_id=$2 where id=$1`, [dealA.id, orgB]));
  await refusedByDatabase("A11 org → null orphaning refused by the database", () =>
    pool.query(`update deal_intakes set organization_id=null where id=$1`, [dealA.id]));

  const bare = (await pool.query(
    `insert into deal_intakes (onboarding_type) values ('existing_asset')
     returning id, organization_absent_reason`)).rows[0];
  ok("A12 a bare INSERT is repaired with a stated reason",
     bare.organization_absent_reason === "ownership_not_stated_at_insert",
     `got ${bare.organization_absent_reason}`);

  console.log("\n── B · MEMBERSHIP ──────────────────────────────────────────");

  const propA = (await propertyCreation.createProperty(pool, {
    actor: { user_id: adminA }, organization_id: orgA,
    name: TAG + " Chestnut", address: `${N} Chestnut St`,
    city: "Philadelphia", state: "PA", zip: "19104",
    source: "deal_intake" })).property;
  const propB = (await propertyCreation.createProperty(pool, {
    actor: { user_id: adminB }, organization_id: orgB,
    name: TAG + " Elsewhere", address: `${N} Walnut St`,
    city: "Philadelphia", state: "PA", zip: "19107",
    source: "deal_intake" })).property;

  await dealService.addProperty(pool, {
    user_id: adminA, deal_intake_id: dealA.id, property_id: propA.id });
  const mem = (await pool.query(
    `select status, added_by_user_id, authority_basis from deal_intake_properties
      where intake_id=$1 and property_id=$2`, [dealA.id, propA.id])).rows[0];
  ok("B1  membership recorded through deal_intake_properties",
     mem && mem.status === "current" && mem.added_by_user_id === adminA);

  await refused("B2  another client's property is refused", "property_belongs_to_another_client", () =>
    dealService.addProperty(pool, { user_id: adminA, deal_intake_id: dealA.id, property_id: propB.id }));

  const dealA2 = await dealService.createDeal(pool, {
    user_id: adminA, deal_name: TAG + " SECOND", creation_source: "asset_management_console" });
  await refused("B3  a property already in a current deal is refused",
    "property_already_in_a_current_deal", () =>
    dealService.addProperty(pool, { user_id: adminA, deal_intake_id: dealA2.id, property_id: propA.id }));

  await dealService.releaseProperty(pool, {
    user_id: adminA, deal_intake_id: dealA.id, property_id: propA.id, reason: "harness" });
  const released = (await pool.query(
    `select status, released_at, released_reason from deal_intake_properties
      where intake_id=$1 and property_id=$2`, [dealA.id, propA.id])).rows[0];
  ok("B4  release keeps the row, marks it released with a time",
     released.status === "released" && released.released_at !== null);

  await dealService.addProperty(pool, {
    user_id: adminA, deal_intake_id: dealA2.id, property_id: propA.id });
  ok("B5  after release the property may join a new deal", true);

  const history = (await pool.query(
    `select count(*)::int c from deal_intake_properties where property_id=$1`, [propA.id])).rows[0].c;
  ok("B6  the released membership is still readable — history survives", history === 2,
     `expected 2 membership rows, found ${history}`);

  await refusedByDatabase("B7  two CURRENT memberships refused by the database", () =>
    pool.query(`update deal_intake_properties set status='current', released_at=null
                 where intake_id=$1 and property_id=$2`, [dealA.id, propA.id]));

  console.log("\n── C · RETAINED ARTIFACT ───────────────────────────────────");

  const csv = rentRollCsv();
  const buf = Buffer.from(csv, "utf8");
  const trueDigest = crypto.createHash("sha256").update(buf).digest("hex");

  const art = await artifacts.store(pool, {
    scope_type: "property", scope_id: propA.id,
    filename: "SOLO Rent Roll 2026-04-30.csv", mimetype: "text/csv", buffer: buf,
    uploaded_by_user_id: adminA, authority_basis: "platform_role:org_admin",
    source_as_of_date: "2026-04-30" });

  const artRow = (await pool.query(
    `select byte_size, sha256, stored_at, octet_length(content) as real_size
       from source_artifacts where id=$1`, [art.id])).rows[0];
  ok("C1  bytes, digest, size and time stored together",
     artRow.byte_size === buf.length && artRow.sha256 && artRow.stored_at !== null);
  ok("C2  the digest is of the real bytes",
     artRow.sha256 === trueDigest && artRow.real_size === buf.length);

  const again = await artifacts.store(pool, {
    scope_type: "property", scope_id: propA.id,
    filename: "SOLO Rent Roll 2026-04-30.csv", mimetype: "text/csv", buffer: buf,
    uploaded_by_user_id: adminA, authority_basis: "platform_role:org_admin" });
  ok("C3  identical bytes into the same scope return the SAME artifact",
     again.id === art.id && again.deduplicated === true);

  const back = await artifacts.read(pool, art.id);
  ok("C4  the bytes come back byte-identical", Buffer.compare(back.content, buf) === 0);

  await refusedByDatabase("C5  an artifact about a nonexistent scope is refused", () =>
    artifacts.store(pool, { scope_type: "property",
      scope_id: "00000000-0000-0000-0000-000000000000",
      filename: "x.csv", buffer: Buffer.from("a,b\n1,2"), uploaded_by_user_id: adminA }));

  await refusedByDatabase("C6  the bytes cannot be rewritten", () =>
    pool.query(`update source_artifacts set content=$2 where id=$1`,
      [art.id, Buffer.from("tampered")]));
  await refusedByDatabase("C7  the artifact cannot be deleted", () =>
    pool.query(`delete from source_artifacts where id=$1`, [art.id]));

  await refused("C8  a workbook renamed .csv is refused", "content_does_not_match_extension", async () =>
    artifacts.store(pool, { scope_type: "property", scope_id: propA.id,
      filename: "rentroll.csv", buffer: Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x01]),
      uploaded_by_user_id: adminA }));

  console.log("\n── D · ACTIVATION ──────────────────────────────────────────");

  await refusedByDatabase("D1  an activation with no property is refused at creation", () =>
    pool.query(`insert into activations (deal_id, source_label) values ($1,'x')`, [dealA2.id]));

  const act = (await activation.openActivation(pool, {
    user_id: adminA, deal_intake_id: dealA2.id, property_id: propA.id })).activation;

  const rows = parseCsvLikeTheApp(csv);
  const ingest = await activation.ingestRentRoll(pool, {
    user_id: adminA, deal_intake_id: dealA2.id, property_id: propA.id,
    activation_id: act.id, rows, source_artifact_id: art.id,
    source_as_of_date: "2026-04-30" });

  const batch = (await pool.query(
    `select * from import_batches where id=$1`, [ingest.import_batch_id])).rows[0];
  ok("D2  reading the rent roll wrote an import_batch",
     batch && batch.property_id === propA.id && batch.status === "committed"
     && batch.source_type === "rent_roll_ledger");
  ok("D3  the batch names the retained artifact", batch.source_artifact_id === art.id);

  const srcRows = (await pool.query(
    `select * from import_source_rows where import_batch_id=$1 order by row_index`,
    [batch.id])).rows;
  ok("D4  one source row per row the file contained", srcRows.length === 5,
     `expected 5, found ${srcRows.length}`);

  const ghost = srcRows.find((r) => !r.raw.unit_number);
  ok("D5  the row with no unit number is EVIDENCE, not silently dropped",
     Boolean(ghost) && /unusable/.test(ghost.parse_note || "") && ghost.produced_unit_id === null,
     JSON.stringify(ghost && ghost.parse_note));

  const props = (await pool.query(
    `select * from proposed_records where activation_id=$1`, [act.id])).rows;
  ok("D6  a proposal exists for every row read", props.length === 5,
     `expected 5, found ${props.length}`);
  ok("D7  every proposal points at its source row by FOREIGN KEY",
     props.every((p) => p.import_source_row_id !== null));

  const p104 = props.find((p) => p.natural_key === "104");
  ok("D8  a row with no rent is needs_review, not staged",
     p104 && p104.status === "needs_review", p104 && p104.status);

  const p103 = props.find((p) => p.natural_key === "103");
  ok("D9  a vacant row is staged, not flagged for a missing tenant",
     p103 && p103.status === "staged" && p103.normalized_json.is_vacant === true,
     p103 && `${p103.status} vacant=${p103.normalized_json.is_vacant}`);

  await refused("D10 re-reading the same file for the same property is refused",
    "already_established_from_this_file", () =>
    activation.ingestRentRoll(pool, { user_id: adminA, deal_intake_id: dealA2.id,
      property_id: propA.id, activation_id: act.id, rows, source_artifact_id: art.id,
      source_as_of_date: "2026-04-30" }));

  //  These two need FRESH setups: "one setup reads one source" is a fact
  //  about the setup, and it correctly refuses before it ever looks at the
  //  file. Reusing `act` here would prove the guard, not the file checks.
  const mkFreshSetup = async (label, num) => {
    const p = (await propertyCreation.createProperty(pool, {
      actor: { user_id: adminA }, organization_id: orgA,
      name: `${TAG} ${label}`, address: `${N + num} Locust St`,
      city: "Philadelphia", state: "PA", zip: "19107", source: "deal_intake" })).property;
    await dealService.addProperty(pool, {
      user_id: adminA, deal_intake_id: dealA2.id, property_id: p.id });
    const a = (await activation.openActivation(pool, {
      user_id: adminA, deal_intake_id: dealA2.id, property_id: p.id })).activation;
    return { property: p, activation: a };
  };

  const noUnitCsv = "Resident,Rent\nSmith,1200";
  const s11 = await mkFreshSetup("NoUnitCol", 11);
  const noUnitArt = await artifacts.store(pool, {
    scope_type: "property", scope_id: s11.property.id, filename: "bad.csv",
    buffer: Buffer.from(noUnitCsv), uploaded_by_user_id: adminA });
  await refused("D11 a rent roll with no unit column is refused", "no_unit_column", () =>
    activation.ingestRentRoll(pool, { user_id: adminA, deal_intake_id: dealA2.id,
      property_id: s11.property.id, activation_id: s11.activation.id,
      rows: parseCsvLikeTheApp(noUnitCsv), source_artifact_id: noUnitArt.id,
      source_as_of_date: "2026-04-30" }));

  const s12 = await mkFreshSetup("ForeignArt", 12);
  const foreignArt = await artifacts.store(pool, {
    scope_type: "property", scope_id: propB.id, filename: "other.csv",
    buffer: Buffer.from("Unit,Rent\n1,100"), uploaded_by_user_id: adminB });
  await refused("D12 an artifact belonging to another property is refused",
    "artifact_out_of_scope", () =>
    activation.ingestRentRoll(pool, { user_id: adminA, deal_intake_id: dealA2.id,
      property_id: s12.property.id, activation_id: s12.activation.id, rows,
      source_artifact_id: foreignArt.id, source_as_of_date: "2026-05-31" }));

  //  …and the guard itself, asserted where it belongs.
  await refused("D13 a second, different source into one setup is refused",
    "setup_already_read_a_source", () =>
    activation.ingestRentRoll(pool, { user_id: adminA, deal_intake_id: dealA2.id,
      property_id: propA.id, activation_id: act.id, rows,
      source_artifact_id: foreignArt.id, source_as_of_date: "2026-05-31" }));

  console.log("\n── E · CONFIRMATION ────────────────────────────────────────");

  const p101 = props.find((p) => p.natural_key === "101");
  const confirmed = await activation.confirmProposal(pool, {
    user_id: adminA, proposed_id: p101.id });

  const lease = (await pool.query(`select * from leases where id=$1`, [confirmed.lease_id])).rows[0];
  ok("E1  confirming wrote a person and a lease",
     Boolean(lease) && Array.isArray(lease.tenant_ids) && lease.tenant_ids.length === 1
     && Number(lease.rent) === 1450 && lease.lease_status === "active");
  ok("E2  the lease is stamped with the import batch", lease.import_batch_id === batch.id);

  const evRow = (await pool.query(
    `select produced_lease_id, produced_person_id, parse_note from import_source_rows where id=$1`,
    [p101.import_source_row_id])).rows[0];
  ok("E3  the evidence row now names the lease it produced",
     evRow.produced_lease_id === confirmed.lease_id);
  ok("E4  …and the person it produced", evRow.produced_person_id === confirmed.person_id);

  const vac = await activation.confirmProposal(pool, { user_id: adminA, proposed_id: p103.id });
  const vacRow = (await pool.query(
    `select status, promoted_record_id from proposed_records where id=$1`, [p103.id])).rows[0];
  ok("E5  a vacant row confirms WITHOUT inventing a lease",
     vac.vacant === true && vac.lease_id === null
     && vacRow.status === "promoted" && vacRow.promoted_record_id === null);

  await refused("E6  confirming twice is refused", "already_promoted", () =>
    activation.confirmProposal(pool, { user_id: adminA, proposed_id: p101.id }));

  //  A second resident with the SAME NAME must become a second person.
  const twinRows = [{ "Unit #": "201", "Resident": "Alvarez, Maria", "Mkt Rent": "1500",
                      "Actual Rent": "1500", "Lease From": "2025-06-01", "Lease To": "2026-05-31",
                      __row_number: 2 }];
  //  openActivation RESUMES the open activation for this property+deal —
  //  that resumption IS the "leave and come back" behaviour.
  const resumed = (await activation.openActivation(pool, {
    user_id: adminA, deal_intake_id: dealA2.id, property_id: propA.id }));
  ok("E7a a second open() on the same property RESUMES rather than forking",
     resumed.reopened === true && resumed.activation.id === act.id);

  //  …and one setup reads one source, so the twin goes to its own property.
  const propT = (await propertyCreation.createProperty(pool, {
    actor: { user_id: adminA }, organization_id: orgA,
    name: TAG + " Twin", address: `${N} Pine St`, city: "Philadelphia",
    state: "PA", zip: "19107", source: "deal_intake" })).property;
  await dealService.addProperty(pool, {
    user_id: adminA, deal_intake_id: dealA2.id, property_id: propT.id });
  const twinArt = await artifacts.store(pool, {
    scope_type: "property", scope_id: propT.id, filename: "twin.csv",
    buffer: Buffer.from("Unit #,Resident\n201,x"), uploaded_by_user_id: adminA });
  const twinAct = (await activation.openActivation(pool, {
    user_id: adminA, deal_intake_id: dealA2.id, property_id: propT.id })).activation;
  await activation.ingestRentRoll(pool, {
    user_id: adminA, deal_intake_id: dealA2.id, property_id: propT.id,
    activation_id: twinAct.id, rows: twinRows, source_artifact_id: twinArt.id,
    source_as_of_date: "2026-05-31" });
  const twinProp = (await pool.query(
    `select id from proposed_records where activation_id=$1 and natural_key='201'`,
    [twinAct.id])).rows[0];
  const twin = await activation.confirmProposal(pool, { user_id: adminA, proposed_id: twinProp.id });
  const sameName = (await pool.query(
    `select count(*)::int c from persons where name='Alvarez, Maria' and source='activation'`)).rows[0].c;
  ok("E7  two residents sharing a name are two people, never merged",
     sameName >= 2 && twin.person_id !== confirmed.person_id, `found ${sameName}`);

  //  Give unit 102 a second space so it looks like a by-the-bed unit.
  const u102 = (await pool.query(
    `select id from units where property_id=$1 and unit_number='102'`, [propA.id])).rows[0];
  await pool.query(`insert into spaces (unit_id, space_label) values ($1,'B')`, [u102.id]);
  const p102 = props.find((p) => p.natural_key === "102");
  await refused("E8  a by-the-bed unit refuses to guess which bed", "ambiguous_bed", () =>
    activation.confirmProposal(pool, { user_id: adminA, proposed_id: p102.id }));

  console.log("\n── F · OPENING POSITION ────────────────────────────────────");

  const propC = (await propertyCreation.createProperty(pool, {
    actor: { user_id: adminA }, organization_id: orgA,
    name: TAG + " Empty", address: `${N} Spruce St`,
    city: "Philadelphia", state: "PA", zip: "19107",
    source: "deal_intake" })).property;
  await dealService.addProperty(pool, {
    user_id: adminA, deal_intake_id: dealA2.id, property_id: propC.id });
  const emptyArt = await artifacts.store(pool, {
    scope_type: "property", scope_id: propC.id, filename: "nothing-confirmable.csv",
    buffer: Buffer.from("Unit #,Resident,Mkt Rent\n900,Someone,"), uploaded_by_user_id: adminA });
  const emptyAct = (await activation.openActivation(pool, {
    user_id: adminA, deal_intake_id: dealA2.id, property_id: propC.id })).activation;
  await activation.ingestRentRoll(pool, {
    user_id: adminA, deal_intake_id: dealA2.id, property_id: propC.id,
    activation_id: emptyAct.id,
    rows: [{ "Unit #": "900", "Resident": "Someone", "Mkt Rent": "", __row_number: 2 }],
    source_artifact_id: emptyArt.id, source_as_of_date: "2026-07-31" });
  await refused("F1  cannot establish before anything is confirmed", "nothing_confirmed", () =>
    activation.establishOpeningPosition(pool, { user_id: adminA, activation_id: emptyAct.id }));

  const established = await activation.establishOpeningPosition(pool, {
    user_id: adminA, activation_id: act.id });
  const pos = established.opening_position;
  ok("F2  it records what was established, as of the document's date",
     String(pos.as_of_date).slice(0, 15) === new Date("2026-04-30").toDateString().slice(0, 15)
     && pos.positions_established === 2,
     `as_of=${pos.as_of_date} established=${pos.positions_established}`);
  ok("F3  it counts what is still unresolved", pos.positions_unresolved >= 1,
     `unresolved=${pos.positions_unresolved}`);

  const srcs = (await pool.query(
    `select source_artifact_id from opening_tenancy_position_sources where opening_tenancy_position_id=$1`,
    [pos.id])).rows;
  ok("F4  it names its source artifact",
     srcs.length === 1 && srcs[0].source_artifact_id === art.id);

  const posCols = (await pool.query(
    `select column_name from information_schema.columns where table_name='opening_tenancy_positions'`)).rows
    .map((r) => r.column_name);
  ok("F5  it holds no copy of any lease",
     !posCols.some((c) => /tenant|rent_amount|lease_id|unit_number/.test(c)),
     posCols.join(","));

  await refusedByDatabase("F6  what it established cannot be rewritten", () =>
    pool.query(`update opening_tenancy_positions set positions_established=99 where id=$1`, [pos.id]));

  //  `act` is now 'activated', so this opens a genuinely NEW activation —
  //  which is what re-establishing from a later rent roll really is.
  const mayArt = await artifacts.store(pool, {
    scope_type: "property", scope_id: propA.id, filename: "SOLO Rent Roll 2026-05-31.csv",
    buffer: Buffer.from("Unit #,Resident,Actual Rent\n301,\"Nkemdi, Obi\",1800"),
    uploaded_by_user_id: adminA });
  const mayAct = (await activation.openActivation(pool, {
    user_id: adminA, deal_intake_id: dealA2.id, property_id: propA.id })).activation;
  ok("F7a a new activation opens once the previous one is activated", mayAct.id !== act.id);
  await activation.ingestRentRoll(pool, {
    user_id: adminA, deal_intake_id: dealA2.id, property_id: propA.id,
    activation_id: mayAct.id,
    rows: [{ "Unit #": "301", "Resident": "Nkemdi, Obi", "Actual Rent": "1800", __row_number: 2 }],
    source_artifact_id: mayArt.id, source_as_of_date: "2026-05-31" });
  const mayProp = (await pool.query(
    `select id from proposed_records where activation_id=$1 and natural_key='301'`,
    [mayAct.id])).rows[0];
  await activation.confirmProposal(pool, { user_id: adminA, proposed_id: mayProp.id });
  const second = await activation.establishOpeningPosition(pool, {
    user_id: adminA, activation_id: mayAct.id });
  const priorNow = (await pool.query(
    `select status, superseded_by_id from opening_tenancy_positions where id=$1`, [pos.id])).rows[0];
  ok("F7  re-establishing supersedes rather than duplicating",
     priorNow.status === "superseded" && priorNow.superseded_by_id === second.opening_position.id);

  const currentCount = (await pool.query(
    `select count(*)::int c from opening_tenancy_positions where property_id=$1 and status='established'`,
    [propA.id])).rows[0].c;
  ok("F8  exactly one established position per property", currentCount === 1, `found ${currentCount}`);

  console.log("\n── H · THE CONSTRAINT SCANS WHAT THE CODE WRITES ───────────");

  //  ── WHY THIS ASSERTION EXISTS ─────────────────────────────────────
  //  Migration 158's first version widened import_batches.source_type to
  //  "what the code actually writes" after reading ONE writer. It reached
  //  production and the release refused: a second writer, 260 lines below
  //  the first IN THE SAME FILE, produces 'rent_roll_reconciliation'.
  //
  //  A CHECK constraint is a claim about every writer. So this reads the
  //  SOURCE — every `insert into import_batches` in the repo — and proves
  //  the constraint permits each literal it finds. The next writer that
  //  invents a value fails here instead of in a production release.
  const fs = require("fs");
  const pathMod = require("path");
  const SRC = pathMod.join(__dirname, "..");
  const scanned = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name === ".git") continue;
      const full = pathMod.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith(".js")) scanned.push(full);
    }
  })(SRC);

  const written = new Set();
  for (const file of scanned) {
    const text = fs.readFileSync(file, "utf8");
    //  Look at the VALUES clause that follows each insert, which is where
    //  the literal sits. A window rather than a line, because the insert
    //  and its values are routinely several lines apart.
    let i = -1;
    while ((i = text.indexOf("insert into import_batches", i + 1)) !== -1) {
      const window = text.slice(i, i + 600);
      const values = window.slice(window.indexOf("values"));
      for (const m of values.matchAll(/'([a-z_]{4,})'/g)) {
        //  Only the first literal after `values` that looks like a
        //  source_type: the column order in every writer is
        //  (property_id, source_type, ...), so it is the first quoted
        //  string in the tuple.
        written.add(m[1]);
        break;
      }
    }
  }

  const permitted = new Set(
    ((await pool.query(
      `select pg_get_constraintdef(oid) as def from pg_constraint
        where conname = 'import_batches_source_type_check'`)).rows[0] || {}).def
      ?.match(/'([a-z_]+)'/g)?.map((x) => x.replace(/'/g, "")) || []);

  const missing = [...written].filter((w) => !permitted.has(w));
  ok(`H1  every source_type any writer produces is permitted by the CHECK ` +
     `(scanned ${scanned.length} .js files, whole repo incl. root)`,
     written.size > 0 && missing.length === 0,
     `writers produce: ${[...written].sort().join(", ")}\n        ` +
     `constraint permits: ${[...permitted].sort().join(", ")}\n        ` +
     `NOT PERMITTED: ${missing.join(", ") || "(none)"}`);

  //  ── TWO LISTS, ONE VOCABULARY ─────────────────────────────────────
  //  The service keeps CREATION_SOURCES so it can refuse readably; the
  //  database keeps ck_dce_source so the table is actually protected.
  //  They must agree, or one path refuses what the other accepts and the
  //  weaker one is the one somebody calls.
  const svcSources = [...dealService.CREATION_SOURCES].sort();
  const dbSources = (((await pool.query(
    `select pg_get_constraintdef(oid) as def from pg_constraint
      where conname = 'ck_dce_source'`)).rows[0] || {}).def || "")
    .match(/'([a-z_]+)'/g)?.map((x) => x.replace(/'/g, "")).sort() || [];
  ok("H2  the service's creation-source list and the database CHECK agree",
     svcSources.length > 0 && JSON.stringify(svcSources) === JSON.stringify(dbSources),
     `service: ${svcSources.join(", ")}\n        database: ${dbSources.join(", ")}`);

  console.log("\n── G · THE WHOLE CHAIN ─────────────────────────────────────");

  const chain = (await pool.query(
    `select sa.original_filename, sa.sha256,
            isr.row_index, isr.produced_lease_id,
            pr.status  as decision, pr.confirmed_by,
            l.id       as lease_id, l.rent,
            pe.name    as resident
       from source_artifacts sa
       join import_batches ib    on ib.source_artifact_id = sa.id
       join import_source_rows isr on isr.import_batch_id = ib.id
       join proposed_records pr  on pr.import_source_row_id = isr.id
       join leases l             on l.id = pr.promoted_record_id
       join persons pe           on pe.id = any(l.tenant_ids)
      where sa.id = $1 and pr.status = 'promoted'`, [art.id])).rows;
  ok("G1  file → source row → proposal → decision → lease, in ONE join",
     chain.length === 1 && chain[0].sha256 === trueDigest
     && chain[0].resident === "Alvarez, Maria" && Number(chain[0].rent) === 1450,
     JSON.stringify(chain));

  const reach = (await pool.query(
    `select sa.original_filename
       from opening_tenancy_positions op
       join import_batches ib on ib.id = op.import_batch_id
       join source_artifacts sa on sa.id = ib.source_artifact_id
      where op.id = $1`, [second.opening_position.id])).rows;
  ok("G2  the position reaches its source file through the batch", reach.length === 1);

  receipt.complete({ harness: __filename, passed: pass, failed: fail, expectedAtLeast: 62 });
  await pool.end();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
