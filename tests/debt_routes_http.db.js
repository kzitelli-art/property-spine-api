/* ════════════════════════════════════════════════════════════════════
   debt_routes_http.db.js — THE DEBT READ SEAM, OVER REAL HTTP.

   Real Express, the real Asset Management surface, the real gate, the
   real writers and the real reader, against real PostgreSQL. Only the
   SESSION RESOLVER is stubbed — the same seam the Taxes HTTP proof
   stubs, and stated rather than silent.

   ── TWO THINGS THIS PROVES THAT NO UNIT TEST CAN ────────────────────

   1  AUTHORITY AT THE SEAM. Not "the route is expected to check" — the
      route is made to refuse. A client-supplied property_id, a session
      without the module, no session at all, and an operator reaching for
      another property's instrument each get a specific verdict.

      `:id` NAMES an instrument. It must never GRANT one.

   2  THE WALLS SURVIVE SERIALISATION. W1–W9 are proven against
      position() elsewhere; this asserts they are still intact after the
      payload becomes JSON and crosses HTTP.

      That is not paranoia. Migration 159 renamed an API response key and
      not the app that read it: nothing threw, the deal page silently
      showed "Setup in progress" for an established property, and the
      HTTP proof missed it because it asserted the DATABASE rather than
      the RESPONSE SHAPE. These assertions read keys BY NAME.

   ── THERE ARE NO WRITE ROUTES, AND THAT IS DELIBERATE ───────────────
   4125 is established here through the CANONICAL WRITERS directly,
   because exposing them as HTTP endpoints was scoped and refused. The
   writers are canonical; they are simply not public doors.

   ISOLATION: HARNESS_DATABASE_URL, refused if it matches DATABASE_URL.

   Run:
     HARNESS_DATABASE_URL=postgresql://postgres@127.0.0.1:5433/postgres \
       node tests/debt_routes_http.db.js
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const fs = require("fs");
const path = require("path");
const http = require("http");
const { Pool } = require("pg");
const receipt = require("./_run_receipt.js");
const svc = require("../src/asset/debt_instrument_service.js");

const SCHEMA = "debt_routes_proof";
const MIGRATION = path.join(__dirname, "..", "migrations", "171_debt_instruments.sql");

const URL_ = receipt.harnessConnectionString();
receipt.begin(__filename, { url: URL_, expected: 22 });

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
    await c.query(`create table legal_entities (id uuid primary key default gen_random_uuid())`);
    await c.query(`create table source_artifacts (id uuid primary key default gen_random_uuid())`);
    await c.query(fs.readFileSync(MIGRATION, "utf8"));

    const uid = "11111111-1111-1111-1111-111111111111";
    await c.query(`insert into users values ($1)`, [uid]);
    const prop = (await c.query(`insert into properties (name) values ('4125 Chestnut') returning id`)).rows[0].id;
    const other = (await c.query(`insert into properties (name) values ('4233 Chestnut') returning id`)).rows[0].id;
    const bare = (await c.query(`insert into properties (name) values ('No Debt Here') returning id`)).rows[0].id;
    const ent = (await c.query(`insert into legal_entities default values returning id`)).rows[0].id;
    const art = (await c.query(`insert into source_artifacts default values returning id`)).rows[0].id;

    //  ── 4125, through the canonical writers. No write routes exist. ──
    const inst = await svc.establishInstrument(c, {
      instrument_kind: "first_mortgage", loan_number: "480010465",
      original_principal_cents: 2825000000, currency: "USD",
      origination_date: "2020-08-01", first_payment_date: "2020-09-01",
      source_artifact_id: art, recorded_by_user_id: uid });
    await svc.addParty(c, { instrument_id: inst.id, party_role: "borrower",
      legal_entity_id: ent, effective_from: "2020-08-01", recorded_by_user_id: uid });
    await svc.addParty(c, { instrument_id: inst.id, party_role: "holder_assignee",
      party_name_text: "Freddie Mac", effective_from: "2020-08-01", recorded_by_user_id: uid });
    await svc.addParty(c, { instrument_id: inst.id, party_role: "servicer",
      party_name_text: "Lument Real Estate Capital, LLC", effective_from: "2020-09-01",
      recorded_by_user_id: uid });
    await svc.addCollateral(c, { instrument_id: inst.id, property_id: prop, lien_position: 1,
      effective_from: "2020-08-01", established_by_source_artifact_id: art, recorded_by_user_id: uid });
    const io = await svc.addTerm(c, { instrument_id: inst.id, effective_from: "2020-09-01",
      effective_to: "2024-08-01", term_source: "original", rate_kind: "fixed", fixed_rate_bp: 328,
      day_count_convention: "actual_360", payment_frequency: "monthly",
      amortization_kind: "interest_only", maturity_date: "2030-08-01", recorded_by_user_id: uid });
    await svc.addTerm(c, { instrument_id: inst.id, effective_from: "2024-09-01",
      term_source: "original", rate_kind: "fixed", fixed_rate_bp: 328,
      day_count_convention: "actual_360", payment_frequency: "monthly",
      amortization_kind: "level_payment", level_payment_cents: 12341140,
      maturity_date: "2030-08-01", supersedes_term_id: io.id, recorded_by_user_id: uid });
    await svc.addReserveRequirement(c, { instrument_id: inst.id, reserve_kind: "tax_imposition",
      amount_cents: 407624, amount_basis: "monthly", effective_from: "2020-08-01",
      recorded_by_user_id: uid });
    await svc.recordBalanceObservation(c, { instrument_id: inst.id,
      observed_balance_cents: 2774526577, as_of_date: "2025-08-01",
      observation_source: "lender_statement", source_artifact_id: art, recorded_by_user_id: uid });

    //  An instrument the entitled operator's property does NOT secure.
    const foreign = await svc.establishInstrument(c, {
      instrument_kind: "first_mortgage", loan_number: "OTHER-999",
      original_principal_cents: 6825000000, currency: "USD",
      first_payment_date: "2022-09-01", recorded_by_user_id: uid });
    await svc.addCollateral(c, { instrument_id: foreign.id, property_id: other,
      effective_from: "2022-08-01", recorded_by_user_id: uid });
    await svc.addTerm(c, { instrument_id: foreign.id, effective_from: "2022-09-01",
      term_source: "original", rate_kind: "fixed", fixed_rate_bp: 500,
      day_count_convention: "actual_360", payment_frequency: "monthly",
      amortization_kind: "interest_only", maturity_date: "2032-08-01", recorded_by_user_id: uid });
    c.release();

    // ── REAL HTTP, REAL ROUTER ────────────────────────────────────────
    const SESSIONS = {
      entitled:   { id: uid, property_id: prop,  allowed_modules: ["asset_management"] },
      unentitled: { id: uid, property_id: prop,  allowed_modules: ["leasing"] },
      elsewhere:  { id: uid, property_id: other, allowed_modules: ["asset_management"] },
      nodebt:     { id: uid, property_id: bare,  allowed_modules: ["asset_management"] },
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

    /*  ══ AUTHORITY ════════════════════════════════════════════════ */
    console.log("\n  ── authority at the seam ──");

    const anon = await request({ path: "/operator/debt/standing" });
    ok("no session → 401", anon.status === 401, `got ${anon.status}`);

    const unent = await request({ path: "/operator/debt/standing", token: "unentitled" });
    ok("session without the asset_management module → 403",
       unent.status === 403, `got ${unent.status}`);

    //  §21 — REFUSED, not silently ignored. A caller must never be able to
    //  believe it chose the scope.
    const spoof = await request({
      path: `/operator/debt/standing?property_id=${other}`, token: "entitled" });
    ok("client-supplied property_id for ANOTHER property → 403 refused",
       spoof.status === 403, `got ${spoof.status}`);
    ok("…and the refusal names the property actually being acted on",
       spoof.json && spoof.json.acting_on === prop);

    const echo = await request({
      path: `/operator/debt/standing?property_id=${prop}`, token: "entitled" });
    ok("client-supplied property_id matching the operator's → allowed",
       echo.status === 200, `got ${echo.status}`);

    //  Path identity is not authority.
    const reach = await request({
      path: `/operator/debt/instrument/${foreign.id}`, token: "entitled" });
    ok("reaching another property's instrument by uuid → 404",
       reach.status === 404, `got ${reach.status}`);
    ok("…and none of that instrument's data leaks into the refusal",
       !/OTHER-999|6825000000/.test(reach.raw));

    const mirror = await request({
      path: `/operator/debt/instrument/${inst.id}`, token: "elsewhere" });
    ok("an operator at 4233 cannot read 4125's instrument",
       mirror.status === 404, `got ${mirror.status}`);
    ok("…and 4125's loan number does not appear in that response",
       !/480010465/.test(mirror.raw));

    /*  ══ HONEST EMPTY ════════════════════════════════════════════ */
    console.log("\n  ── honest empty is an answer, not an error ──");
    const empty = await request({ path: "/operator/debt/standing", token: "nodebt" });
    ok("a property with no debt → 200, not an error", empty.status === 200, `got ${empty.status}`);
    ok("…and says NOT_ESTABLISHED rather than implying no debt exists",
       empty.json && empty.json.instrument_count === 0
       && empty.json.standing.truth_state === "NOT_ESTABLISHED");

    /*  ══ THE WALLS SURVIVE HTTP ═══════════════════════════════════ */
    console.log("\n  ── W1–W9 survive serialisation (keys read BY NAME) ──");
    const st = await request({ path: "/operator/debt/standing", token: "entitled" });
    ok("standing returns the property's instrument", st.status === 200
       && st.json.instrument_count === 1, `got ${st.status}`);
    const p0 = st.json.instruments[0];

    ok("W8 · observed and projected are separate keys",
       p0.principal_position.observed.value_cents === 2774526577
       && p0.principal_position.projected.value_cents === 2713187412);
    ok("W8 · there is no generic `balance` key in the JSON",
       !/"balance"\s*:/.test(st.raw));
    ok("W7 · the observation keeps its as_of and is marked stale",
       p0.principal_position.observed.as_of_date === "2025-08-01"
       && p0.principal_position.observed.stale === true);
    ok("W9 · debt_service is the P&I 12341140, not the 13226971 draft",
       p0.debt_service.principal_and_interest_cents === 12341140
       && !/13226971/.test(st.raw));
    ok("W1 · payoff is NOT_ESTABLISHED and carries no value",
       p0.payoff.truth_state === "NOT_ESTABLISHED" && p0.payoff.value_cents === undefined);
    ok("W5 · covenant_standing is NOT_ESTABLISHED, with no affirmative token",
       p0.covenant_standing.truth_state === "NOT_ESTABLISHED"
       && !/(compliant|in_compliance)/i.test(st.raw));
    ok("W6 · the tax escrow requirement returns with its obligation unestablished",
       p0.reserve_requirements[0].reserve_kind === "tax_imposition"
       && p0.reserve_requirements[0].underlying_obligation_status === "NOT_ESTABLISHED");
    ok("W3 · maturity is contractual and extension is NOT_ESTABLISHED",
       p0.contractual_maturity.date === "2030-08-01"
       && p0.extension.truth_state === "NOT_ESTABLISHED");

    /*  ══ DETAIL ═══════════════════════════════════════════════════ */
    console.log("\n  ── the detail projection is a second read (§40.6) ──");
    ok("standing carries NO payment schedule — it stays cheap",
       p0.payment_schedule === undefined && st.json.payment_schedule === undefined);

    const det = await request({ path: `/operator/debt/instrument/${inst.id}`, token: "entitled" });
    ok("detail returns the full 120-row derived schedule",
       det.status === 200 && Array.isArray(det.json.payment_schedule)
       && det.json.payment_schedule.length === 120, `got ${det.status}`);
    ok("…and every row declares itself a derivation, not an observation",
       det.json.payment_schedule.every((r) => r.basis === "schedule_derivation"));

    await admin.query(`drop schema ${SCHEMA} cascade`);
  } catch (e) {
    if (server) server.close();
    if (scoped) await scoped.end();
    if (admin) await admin.end();
    process.exit(receipt.died(__filename, e, ran));
  }
  server.close();
  await scoped.end();
  await admin.end();
  process.exit(receipt.complete({ harness: __filename, passed: pass, failed: fail, expectedAtLeast: 22 }));
})();
