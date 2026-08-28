/* ════════════════════════════════════════════════════════════════════
   tenancy_ask_spine_http.db.js — TENANCY THROUGH THE REAL DOOR.
   REAL POSTGRES · REAL EXPRESS · REAL HTTP · REAL SESSION.

   §33's proof ladder puts "Proven (real DB + real HTTP)" between the
   unit rung and the browser rung, and this is tenancy's. The seam test
   (tenancy_ask_spine.test.js) stubs the database and injects the
   reader. The read proof (tenancy_standing_read.db.js) calls the reader
   directly. Neither one proves that an operator's actual request, over
   a socket, carrying a real session token, reaches the real canonical
   read of 160 real beds — which is the only claim that matters to a
   person holding a phone.

   ── WHAT IS REAL HERE, AND WHAT IS NOT ──────────────────────────────
   REAL: Postgres with the whole schema; 72 units and 160 beds loaded
   from RentRoll07_1417.xlsx; a users row, a property_team_assignments
   row and a staff_sessions row resolved by the real
   resolveStaffSession; the real ask_spine router on a real Express
   app; requests over a real socket.

   NOT REAL: the Anthropic client. It is a stub that CAPTURES what it
   was sent. That is deliberate, and it is the point rather than a
   compromise — what needs proving is which facts crossed into model
   context, and a live model would make that harder to see, not easier.
   Whether the sentence reads well is the browser rung's business.

   ── THE THREE THINGS THIS RUNG EXISTS TO CATCH ──────────────────────
   1  §21 · property authority is server-derived. A body that names
      another property is REFUSED, not ignored.
   2  §40.8 · entitlement precedes intelligence. An operator without
      leasing or management gets a refusal, and the model is never
      called at all — asserted by the stub's own call count, not by
      reading the answer.
   3  The response KEYS. grounded_on.tenancy_* is a contract the app
      will read; an identifier sweep renamed one of these before and
      only a browser caught it. Pinned here by name.

   ISOLATION: HARNESS_DATABASE_URL, refused if it matches DATABASE_URL.
   Commits its fixtures under its own organization name and cleans that
   organization up on entry.

   CLASS 3 — test infrastructure.

   Run:
     HARNESS_DATABASE_URL=postgresql://postgres@127.0.0.1:5433/spine_full \
       node tests/proofs/tenancy_ask_spine_http.db.js
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const receipt = require("../_run_receipt.js");
const CONN = receipt.harnessConnectionString();
const { Pool } = require("pg");
const http = require("http");
const crypto = require("crypto");
const express = require("express");
const fs = require("fs");
const XLSX = require("xlsx");
const { mapRows } = require("../../src/onboarding/rent_roll_field_map.js");
const { materializeRentableSpaces } = require("../../src/tenancy/inventory_materialization.js");

const XLSX_PATH = process.env.SKYLINE_XLSX
  || "/root/.claude/uploads/27e16502-554d-5a14-9258-903418ff09cd/d657f655-RentRoll07_1417.xlsx";
const ORG = "Tenancy Ask Spine HTTP";

let pass = 0, fail = 0, ran = 0; const failures = [];
function ok(l, c, d) {
  ran++;
  if (c) { pass++; console.log("  ok    " + l); }
  else { fail++; failures.push(l); console.log("  FAIL  " + l + (d ? "\n          " + d : "")); }
}
const digest = (b) => crypto.createHash("sha256").update(b).digest("hex");
const ymd = (s) => {
  const m = String(s || "").trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  return m ? `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}` : null;
};

/*  A real request over a real socket. No supertest, no in-process
 *  shortcut — the header, the body and the status line all travel.  */
function post(port, path_, body, headers) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body || {});
    const req = http.request(
      { host: "127.0.0.1", port, path: path_, method: "POST",
        headers: { "content-type": "application/json",
                   "content-length": Buffer.byteLength(payload), ...(headers || {}) } },
      (res) => {
        let raw = "";
        res.on("data", (c) => { raw += c; });
        res.on("end", () => {
          let json = null;
          try { json = JSON.parse(raw); } catch (_) { /* leave null; the test says so */ }
          resolve({ status: res.statusCode, json, raw });
        });
      });
    req.on("error", reject);
    req.end(payload);
  });
}

function readRentRoll(file) {
  const wb = XLSX.readFile(file);
  const grid = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: false, defval: null });
  const meta = {};
  for (const r of grid.slice(0, 6)) {
    const a = String(r[0] || ""); const m = a.match(/^(As Of)\s*=\s*(.+)$/);
    if (m) meta[m[1]] = m[2].trim();
  }
  const h1 = grid[5] || [], h2 = grid[6] || [];
  const headers = h1.map((h, i) => [h, h2[i]].filter(Boolean).join(" ").trim() || `col${i}`);
  const out = []; let section = null;
  grid.forEach((r, i) => {
    const a = String(r[0] || "").trim();
    const lone = a && r.slice(1).filter((x) => x != null).length === 0;
    if (lone && /^Current\/Notice\/Vacant/.test(a)) { section = "current"; return; }
    if (lone && /^Future Residents/.test(a)) { section = "future"; return; }
    if (a === "Summary Groups") { section = null; return; }
    if (!section || !/^\d{3,4}-\d{2,3}$/.test(a)) return;
    const row = { __row_number: i + 1, __section: section };
    headers.forEach((h, c) => { row[h] = c === 0 ? a : r[c]; });
    out.push(row);
  });
  const totals = {};
  grid.slice(-8).forEach((r) => {
    const k = String(r[0] || "").trim();
    if (k === "Occupied Beds") totals.occupied = Number(r[11]);
    if (k === "Totals") totals.beds = Number(r[11]);
  });
  return { meta, rows: out, totals };
}

async function cleanup(pool) {
  const props = (await pool.query(
    `select p.id from properties p join organizations o on o.id=p.organization_id where o.name=$1`, [ORG])).rows;
  for (const { id } of props) {
    await pool.query(`delete from staff_sessions where property_id=$1`, [id]);
    await pool.query(`delete from property_team_assignments where property_id=$1`, [id]);
    await pool.query(`delete from leases where property_id=$1`, [id]);
    await pool.query(`delete from spaces where unit_id in (select id from units where property_id=$1)`, [id]);
    await pool.query(`delete from units where property_id=$1`, [id]);
    await pool.query(`delete from import_batches where property_id=$1`, [id]);
    await pool.query(`delete from properties where id=$1`, [id]);
  }
  await pool.query(`delete from persons where source='tenancy_ask_http'`);
  await pool.query(`delete from users where email like 'tenancy-http-%@test'`);
  await pool.query(`delete from organizations where name=$1`, [ORG]);
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

receipt.begin(__filename, { url: CONN, expected: 22 });

(async () => {
  if (!fs.existsSync(XLSX_PATH)) {
    console.error(`\n  REFUSED: the real artifact is not at ${XLSX_PATH}.\n`);
    process.exit(2);
  }
  const pool = new Pool({ connectionString: CONN });
  await cleanup(pool);

  // ── REAL SKYLINE, REAL SCHEMA ─────────────────────────────────────
  const { meta, rows, totals } = readRentRoll(XLSX_PATH);
  const { mapped } = mapRows(rows);
  const current = mapped.filter((_, i) => rows[i].__section === "current");
  const future = mapped.filter((_, i) => rows[i].__section === "future");
  const AS_OF = ymd(meta["As Of"]);

  const org = (await pool.query(`insert into organizations (name) values ($1) returning id`, [ORG])).rows[0].id;
  const prop = (await pool.query(
    `insert into properties (name, address, organization_id, leasing_basis)
     values ('Skyline Apartments','1417 N 15th St',$1,'bed') returning id`, [org])).rows[0].id;
  const otherProp = (await pool.query(
    `insert into properties (name, address, organization_id) values ('Elsewhere','1 Other St',$1) returning id`,
    [org])).rows[0].id;
  const batch = (await pool.query(
    `insert into import_batches (property_id, source_type, source_file, source_as_of_date, leasing_model, confidence, status)
     values ($1,'historical_snapshot','RentRoll07_1417.xlsx',$2,'bed','confirmed','committed') returning id`,
    [prop, AS_OF])).rows[0].id;

  const labelsByUnit = new Map();
  for (const m of current) {
    if (!labelsByUnit.has(m.unit_number)) labelsByUnit.set(m.unit_number, []);
    const l = labelsByUnit.get(m.unit_number);
    if (!l.includes(m.space_label)) l.push(m.space_label);
  }
  const spaceOf = new Map();
  const c1 = await pool.connect();
  try {
    await c1.query("begin");
    for (const [unitNumber, labels] of labelsByUnit) {
      const u = (await c1.query(
        `insert into units (property_id, unit_number, occupancy_status) values ($1,$2,'unknown') returning id`,
        [prop, unitNumber])).rows[0].id;
      await materializeRentableSpaces(c1, { unit_id: u, labels, kind: "bed", use_type: "residential" });
      for (const s of (await c1.query(`select id, space_label from spaces where unit_id=$1`, [u])).rows) {
        spaceOf.set(`${unitNumber}|${s.space_label}`, s.id);
      }
    }
    await c1.query("commit");
  } catch (e) { await c1.query("rollback"); throw e; } finally { c1.release(); }

  for (const m of [...current.filter((x) => x.name), ...future]) {
    const sid = spaceOf.get(`${String(m.unit_number).trim()}|${String(m.space_label).trim()}`);
    if (!sid) continue;
    const person = (await pool.query(
      `insert into persons (name, source, lifecycle_status, leasing_stage, import_batch_id,
                            source_type, source_as_of_date, confidence)
       values ($1,'tenancy_ask_http','resident','resident',$2,'rent_roll_ledger',$3,'confirmed') returning id`,
      [m.name, batch, AS_OF])).rows[0].id;
    await pool.query(
      `insert into leases (property_id, space_id, tenant_ids, rent, start_date, end_date, lease_status,
                           import_batch_id, source_type, source_as_of_date, confidence)
       values ($1,$2,$3,$4,$5,$6,'active',$7,'historical_snapshot',$8,'confirmed')`,
      [prop, sid, [person], Number(m.actual_rent) > 0 ? Number(m.actual_rent) : null,
       m.lease_from, m.lease_to, batch, AS_OF]);
  }

  // ── REAL OPERATORS, REAL SESSIONS ─────────────────────────────────
  async function operator(email, modules) {
    //  Real enum, real check constraint. `role_name` has no 'operator'
    //  member and account_kind refuses 'staff' — the schema is the schema,
    //  and a harness that invented values would be proving against a
    //  database this product does not have.
    const uid = (await pool.query(
      `insert into users (name,email,role,account_kind) values ($1,$2,'property_manager','human_staff') returning id`,
      [email, email])).rows[0].id;
    await pool.query(
      `insert into property_team_assignments (property_id,user_id,role_title,allowed_modules,active)
       values ($1,$2,'Operator',$3::text[],true)`, [prop, uid, modules]);
    const token = crypto.randomBytes(24).toString("hex");
    await pool.query(
      `insert into staff_sessions (user_id,property_id,token_digest,issuance_purpose,expires_at)
       values ($1,$2,$3,'bootstrap_invite',now() + interval '1 hour')`,
      [uid, prop, digest(Buffer.from(token))]);
    return token;
  }
  const leasingToken = await operator("tenancy-http-leasing@test", ["leasing"]);
  const amOnlyToken = await operator("tenancy-http-am@test", ["asset_management"]);

  // ── THE REAL ROUTER, ON A REAL SERVER ─────────────────────────────
  //  The stub RECORDS. Nothing about the request is shaped by it.
  const modelCalls = [];
  const anthropic = { messages: { create: async (input) => {
    modelCalls.push(input);
    return { content: [{ type: "text", text: JSON.stringify({
      outcome: "answered",
      answer: "37 of 160 beds are occupied at 7/31; 91 more are committed from 8/3.",
    }) }] };
  } } };

  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use(require("../../src/agent/ask_spine.js")({ pool, anthropic }));
  const server = await new Promise((res) => { const s = app.listen(0, "127.0.0.1", () => res(s)); });
  const port = server.address().port;

  console.log("\n  ── the door itself ──");
  {
    const r = await post(port, "/operator/ask-spine/ask", { question: "what is our occupancy" });
    ok("H1  no session is 401, not an empty answer", r.status === 401, `${r.status} ${r.raw.slice(0, 120)}`);
    ok("H2  …and the model was never called", modelCalls.length === 0, `${modelCalls.length} call(s)`);
  }
  {
    //  §21. The browser may REQUEST; it may not determine authority.
    const r = await post(port, "/operator/ask-spine/ask",
      { question: "what is our occupancy", property_id: otherProp },
      { "x-staff-session": leasingToken });
    ok("H3  a body naming another property is REFUSED (403), not quietly ignored",
       r.status === 403, `${r.status} ${r.raw.slice(0, 160)}`);
    ok("H4  …and the refusal says which property it IS acting on",
       r.json && String(r.json.acting_on) === String(prop), JSON.stringify(r.json));
    ok("H5  …and still no model call", modelCalls.length === 0, `${modelCalls.length} call(s)`);
  }

  console.log("\n  ── §40.8 · entitlement precedes intelligence, over the wire ──");
  {
    const r = await post(port, "/operator/ask-spine/ask", { question: "how many beds are occupied" },
      { "x-staff-session": amOnlyToken });
    ok("H6  an asset-management-only operator is not_authorized for the rent roll",
       r.status === 200 && r.json.outcome === "not_authorized", JSON.stringify(r.json));
    ok("H7  …with a sentence, not an error code",
       /not available in your current access/i.test(r.json.answer || ""), r.json.answer);
    //  THE ASSERTION. Not "the answer withheld it" — the facts were never
    //  gathered and the model was never reached.
    ok("H8  …and the model was NEVER reached for an unentitled question",
       modelCalls.length === 0, `${modelCalls.length} call(s)`);
    ok("H9  …and no reference was minted",
       Array.isArray(r.json.references) && r.json.references.length === 0);
  }

  console.log("\n  ── the entitled question, against 160 real beds ──");
  let answered = null;
  {
    answered = await post(port, "/operator/ask-spine/ask",
      { question: "how many beds are occupied and what is committed next" },
      { "x-staff-session": leasingToken });
    ok("H10 200 and `answered`", answered.status === 200 && answered.json.outcome === "answered",
       JSON.stringify(answered.json).slice(0, 200));
    ok("H11 the model was called exactly once", modelCalls.length === 1, `${modelCalls.length}`);
  }

  const sent = modelCalls[0] ? String(modelCalls[0].messages[0].content) : "";
  const facts = sent ? JSON.parse(sent.slice(sent.indexOf("{"), sent.lastIndexOf("}") + 1)) : null;
  ok("H12 the subject reached the model as tenancy", /QUESTION SUBJECT: tenancy/.test(sent), sent.slice(0, 60));
  /*  ⚠ ASK SPINE ANSWERS *NOW*, NOT THE IMPORT.
   *  The first version of this assertion compared the answer to the
   *  artifact's own 07/31 summary — 37 of 160 — and failed, correctly.
   *  The composer reads standing at TODAY, and today is past 08/03, so
   *  the 91 committed positions have commenced and are current. That is
   *  the whole point of `as_of` being a parameter rather than a property
   *  of the model: the ledger and the sentence both move with the date.
   *
   *  So the wire is checked against the CANONICAL READ at the very date
   *  the response reported, not against a snapshot taken two weeks
   *  earlier. Which is the stronger claim anyway — it proves the facts
   *  came from that read rather than merely resembling the file.  */
  const canonical = await require("../../src/tenancy/tenancy_position_read.js")
    .readTenancyStanding(pool, { property_id: prop, as_of: facts && facts.tenancy && facts.tenancy.as_of });
  ok("H13 the facts on the wire ARE the canonical read, at the date they claim",
     !!facts && facts.tenancy
     && JSON.stringify(facts.tenancy.position) === JSON.stringify(canonical.position)
     && JSON.stringify(facts.tenancy.unknowns) === JSON.stringify(canonical.unknowns),
     `wire ${JSON.stringify(facts && facts.tenancy && facts.tenancy.position)}\n          ` +
     `read ${JSON.stringify(canonical.position)}`);
  ok("H13b …of the real 160-bed inventory, whatever the date",
     !!facts && facts.tenancy.position.rentable_positions === totals.beds
     && facts.tenancy.position.occupied + facts.tenancy.position.open === totals.beds,
     JSON.stringify(facts && facts.tenancy && facts.tenancy.position));
  ok("H13c …taken at TODAY, not replayed from the import's as-of date",
     !!facts && facts.tenancy.as_of === new Date().toISOString().slice(0, 10)
     && facts.tenancy.as_of > AS_OF,
     `${facts && facts.tenancy && facts.tenancy.as_of} (import was ${AS_OF})`);
  ok("H14 …read at the property the SESSION named",
     !!facts && String(facts.property_id) === String(prop));
  ok("H15 …with the truth walls attached to the facts themselves",
     !!facts && Array.isArray(facts.tenancy.truth_walls)
     && facts.tenancy.truth_walls.some((w) => /occupied ≠ paying/.test(w)));
  ok("H16 …and the unknowns, so a fluent sentence cannot be built over them",
     !!facts && facts.tenancy.unknowns
     && Number.isInteger(facts.tenancy.unknowns.occupied_positions_with_no_recorded_rent));
  ok("H17 …and the source it was established from",
     !!facts && facts.tenancy.established_from
     && /RentRoll07_1417/.test(facts.tenancy.established_from.source_file));
  /*  §40.8: references are minted server-side from entitled facts. A model
   *  holding a record id can compose a link Spine did not resolve — so the
   *  serialized payload must contain no uuid at all.  */
  ok("H18 NO record id crosses into model context",
     !UUID.test(sent.replace(/QUESTION SUBJECT: \w+/, "").replace(String(prop), "")),
     (sent.match(UUID) || []).slice(0, 1).join(""));

  console.log("\n  ── the response KEYS are a contract (a rename broke one before) ──");
  const g = answered.json.grounded_on || {};
  ok("H19 grounded_on.tenancy_standing is present and reads ESTABLISHED",
     g.tenancy_standing === "ESTABLISHED", JSON.stringify(g));
  ok("H20 grounded_on.tenancy_read_state is present and reads OK",
     g.tenancy_read_state === "OK", JSON.stringify(g.tenancy_read_state));
  ok("H21 grounded_on.tenancy_rentable_positions carries the real count",
     g.tenancy_rentable_positions === totals.beds, String(g.tenancy_rentable_positions));
  ok("H22 grounded_on.tenancy_as_of is an ISO date the app can render",
     /^\d{4}-\d{2}-\d{2}$/.test(String(g.tenancy_as_of)), String(g.tenancy_as_of));
  ok("H23 nothing failed, and the response says so rather than staying silent",
     Array.isArray(g.reads_that_failed) && g.reads_that_failed.length === 0,
     JSON.stringify(g.reads_that_failed));
  ok("H24 the property_id echoed to the client is the SESSION's",
     String(answered.json.property_id) === String(prop));

  server.close();
  await pool.end();
  console.log("");
  process.exit(receipt.complete({ harness: __filename, passed: pass, failed: fail, expectedAtLeast: 22 }));
})().catch((e) => {
  console.error(e && e.stack ? e.stack : e);
  process.exit(receipt.died(__filename, e, ran));
});
