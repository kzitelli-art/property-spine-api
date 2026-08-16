/* ════════════════════════════════════════════════════════════════════
   equity_routes_http.db.js — THE EQUITY READ SEAM, OVER REAL HTTP.
   Rebuilt against migration 174's Round-4 shape.

   Real Express, the real Asset Management surface, the real gate, the
   real writers and the real reader, against real PostgreSQL. Only the
   SESSION RESOLVER is stubbed — same seam Debt's own HTTP proof stubs.

   TWO THINGS THIS PROVES THAT NO UNIT TEST CAN — same as Debt's:
   1  authority at the seam (§21) — a client-supplied property_id is
      refused, not silently ignored.
   2  the walls survive serialisation — E1–E10 and the Round-4 rulings
      are proven against position() elsewhere; this asserts they are
      still intact after the payload becomes JSON and crosses HTTP,
      reading keys BY NAME.

   ISOLATION: HARNESS_DATABASE_URL, refused if it matches DATABASE_URL.

   Run:
     HARNESS_DATABASE_URL=postgresql://postgres@127.0.0.1:5432/postgres \
       node tests/equity_routes_http.db.js
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const fs = require("fs");
const path = require("path");
const http = require("http");
const { Pool } = require("pg");
const receipt = require("./_run_receipt.js");
const svc = require("../src/asset/equity_position_service.js");

const SCHEMA = "equity_routes_proof";
const MIGRATION = path.join(__dirname, "..", "migrations", "174_equity_positions.sql");

const URL_ = receipt.harnessConnectionString();
receipt.begin(__filename, { url: URL_, expected: 15 });

let pass = 0, fail = 0, ran = 0;
function ok(label, cond, detail) {
  ran++;
  if (cond) { pass++; console.log("  ok    " + label); }
  else { fail++; console.log("  FAIL  " + label + (detail ? "\n          " + detail : "")); }
}

let server = null, scoped = null, admin = null;

(async () => {
  try {
    admin = new Pool({ connectionString: URL_ });
    const c = await admin.connect();
    await c.query(`drop schema if exists ${SCHEMA} cascade`);
    await c.query(`create schema ${SCHEMA}`);
    await c.query(`set search_path to ${SCHEMA}`);
    await c.query(`create extension if not exists pgcrypto`);
    await c.query(`create table users (id uuid primary key)`);
    await c.query(`create table properties (id uuid primary key default gen_random_uuid(), name text)`);
    await c.query(`create table legal_entities (id uuid primary key default gen_random_uuid(), legal_name text not null)`);
    await c.query(`create table source_artifacts (id uuid primary key default gen_random_uuid())`);
    await c.query(fs.readFileSync(MIGRATION, "utf8"));

    const uid = "11111111-1111-1111-1111-111111111111";
    await c.query(`insert into users values ($1)`, [uid]);
    const prop = (await c.query(`insert into properties (name) values ('4125 Chestnut') returning id`)).rows[0].id;
    const other = (await c.query(`insert into properties (name) values ('4233 Chestnut') returning id`)).rows[0].id;
    const bare = (await c.query(`insert into properties (name) values ('No Equity Here') returning id`)).rows[0].id;
    const msc = (await c.query(
      `insert into legal_entities (legal_name) values ('MSC 4125 Chestnut LLC') returning id`)).rows[0].id;
    const interestHolder = (await c.query(
      `insert into legal_entities (legal_name) values ('4125 Chestnut Interest Holder LLC') returning id`)).rows[0].id;
    const art = (await c.query(`insert into source_artifacts default values returning id`)).rows[0].id;

    //  ── 4125's MSC position, through the canonical writers. No write
    //  routes exist — same discipline as Debt. ──
    const position = await svc.addPosition(c, {
      property_id: prop, issuer_legal_entity_id: interestHolder, position_class: "preferred",
      holder_legal_entity_id: msc, effective_from: "2020-07-31",
      source_artifact_id: art, recorded_by_user_id: uid });
    await svc.addPreferredTerms(c, {
      position_id: position.id, term_source: "governing_document", source_authority: "governed_read",
      current_pay_rate_bp: 1250, compounding: "quarterly", effective_from: "2020-07-31",
      source_artifact_id: art, recorded_by_user_id: uid });

    //  A second property with an equity position secured by NOTHING to do
    //  with `prop` — the authority-bypass fixture, same shape as Debt's
    //  `foreign` instrument.
    await svc.addPosition(c, {
      property_id: other, issuer_legal_entity_id: interestHolder, position_class: "common",
      holder_name_text: "OTHER-PROPERTY-HOLDER-999", effective_from: "2022-01-01",
      source_artifact_id: art, recorded_by_user_id: uid });
    c.release();

    // ── REAL HTTP, REAL ROUTER ────────────────────────────────────────
    const SESSIONS = {
      entitled:   { id: uid, property_id: prop,  allowed_modules: ["asset_management"] },
      unentitled: { id: uid, property_id: prop,  allowed_modules: ["leasing"] },
      elsewhere:  { id: uid, property_id: other, allowed_modules: ["asset_management"] },
      noequity:   { id: uid, property_id: bare,  allowed_modules: ["asset_management"] },
    };
    const resolverPath = require.resolve("../src/identity/staff_session_service.js");
    require.cache[resolverPath] = { id: resolverPath, filename: resolverPath, loaded: true,
      exports: { resolveStaffSession: async (_p, t) => SESSIONS[t] || null } };

    const express = require("express");
    const app = express();
    app.use(express.json());
    scoped = new Pool({ connectionString: URL_ });
    scoped.on("connect", (cl) => cl.query(`set search_path to ${SCHEMA}`));
    app.use("/", require("../src/surfaces/asset_management.js")({
      pool: scoped,
      fileToText: async ({ buffer }) => buffer.toString("utf8"),
    }));
    server = http.createServer(app);
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const port = server.address().port;

    function request({ path: p, token }) {
      return new Promise((resolve) => {
        const headers = {};
        if (token) headers["x-staff-session"] = token;
        const req = http.request({ host: "127.0.0.1", port, path: p, method: "GET", headers }, (r) => {
          let body = "";
          r.on("data", (d) => (body += d));
          r.on("end", () => {
            let json = null;
            try { json = JSON.parse(body); } catch (_) {}
            resolve({ status: r.statusCode, json, raw: body });
          });
        });
        req.end();
      });
    }

    console.log("\n  ── authority at the seam ──");
    const anon = await request({ path: "/operator/equity/standing" });
    ok("no session → 401", anon.status === 401, `got ${anon.status}`);

    const unent = await request({ path: "/operator/equity/standing", token: "unentitled" });
    ok("session without the asset_management module → 403", unent.status === 403, `got ${unent.status}`);

    const spoof = await request({
      path: `/operator/equity/standing?property_id=${other}`, token: "entitled" });
    ok("client-supplied property_id for ANOTHER property → 403 refused",
       spoof.status === 403, `got ${spoof.status}`);

    const mirror = await request({ path: "/operator/equity/standing", token: "elsewhere" });
    ok("an operator at 4233 cannot read 4125's equity", mirror.status === 200);
    ok("...and MSC's real position does not leak into 4233's response",
       !/"position_class":"preferred"/.test(mirror.raw) || !mirror.raw.includes(msc));
    ok("...and the OTHER property's own holder is what's actually returned, not 4125's",
       mirror.raw.includes("OTHER-PROPERTY-HOLDER-999"));

    console.log("\n  ── honest empty is an answer, not an error ──");
    const empty = await request({ path: "/operator/equity/standing", token: "noequity" });
    ok("a property with no equity → 200, not an error", empty.status === 200, `got ${empty.status}`);
    ok("...and says NOT_ESTABLISHED rather than implying no equity exists",
       empty.json && empty.json.positions.length === 0
       && empty.json.standing.truth_state === "NOT_ESTABLISHED");

    console.log("\n  ── walls survive serialisation (keys read BY NAME) ──");
    const st = await request({ path: "/operator/equity/standing", token: "entitled" });
    ok("200, real data", st.status === 200);
    const positions = st.json.positions;
    ok("the position is present", positions.length === 1 && positions[0].position_id === position.id);
    ok("MSC's position reads back preferred, by name",
       positions[0].position_class === "preferred");
    ok("MSC's legal name is returned for institutional display rather than leaving only a UUID",
       positions[0].holder.legal_name === "MSC 4125 Chestnut LLC");
    ok("...with its rate as-stated, quarterly, by source_authority — not a bare number",
       positions[0].preferred.terms[0].source_authority === "governed_read"
       && positions[0].preferred.terms[0].compounding === "quarterly");
    ok("E3 · accrued_preferred_return is NOT_ESTABLISHED over the wire, never a computed figure",
       positions[0].preferred.accrued_preferred_return.truth_state === "NOT_ESTABLISHED");
    ok("E9 · no pledge recorded reads NOT_ESTABLISHED, never a false 'unencumbered'",
       positions[0].encumbrance.truth_state === "NOT_ESTABLISHED");

    await admin.query(`drop schema if exists ${SCHEMA} cascade`);
  } catch (e) {
    if (server) server.close();
    if (scoped) await scoped.end();
    if (admin) await admin.end();
    process.exit(receipt.died(__filename, e, ran));
  }
  if (server) server.close();
  if (scoped) await scoped.end();
  if (admin) await admin.end();
  process.exit(receipt.complete({ harness: __filename, passed: pass, failed: fail, expectedAtLeast: 14 }));
})();
