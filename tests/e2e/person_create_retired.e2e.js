"use strict";

/*  ══════════════════════════════════════════════════════════════════════
    person_create_retired.e2e.js — POST /persons MINTS NOBODY.

    Real mounted HTTP, through the real server's shared-key gate, on the
    owned proof database. `POST /persons` minted a human from a NAME ALONE
    — the direct contradiction of the continuity-handle rule frozen on
    2026-09-19 (CURRENT_STATE row 156): no normalised phone and no email,
    no durable Person. It is retired in place (410).

    WHAT THIS ASSERTS, AND WHY EACH ONE IS HERE:

      · The runtime is THIS tree. A 410 from a stale server on the same
        port proves nothing; E2E_EXPECT_SERVER_COMMIT is checked against
        /operator/build before anything else runs.
      · 410, NOT 404. A 404 would also leave the tables untouched and
        would look identical in a digest. The distinction IS the product:
        an external caller holding the shared key gets a refusal that
        names where the work goes, not a guess.
      · IT NO LONGER REASONS ABOUT THE REQUEST. The pre-retirement route
        answered 400 on a body with no name/email/phone and 404 on an
        unknown property_id. Every one of those now answers the SAME 410.
        A tombstone that still validates is still a door.
      · NOTHING IS WRITTEN — a whole-row digest of `persons` and `events`,
        not a count, so an overwrite or a delete is caught too.
      · IT IS NOT A NEW PUBLIC DOOR. Without the key, the server's gate
        refuses first; the tombstone is never reached.
      · THE READS BESIDE IT ARE UNTOUCHED. GET /persons still answers, so
        this retired the WRITER and not the surface.

    THE WITNESS, AND WHY IT IS IN THIS FILE RATHER THAN A SCRATCH SCRIPT.
    A retirement proof passes trivially against a route that never worked.
    PROOF_EXPECT_PERSON_CREATE_OPEN=1 inverts the expectation and runs the
    SAME calls against the pre-retirement handler:

        git checkout <parent sha> -- src/baseline/baseline_routes.js
        (reboot the owned server)
        PROOF_EXPECT_PERSON_CREATE_OPEN=1 node tests/e2e/person_create_retired.e2e.js

    It asserts 201 and a durable Person with NO phone, NO email and NO
    normalised handle — the defect, observed, not described. Modelled on
    PROOF_EXPECT_LEGACY_OPEN in legacy_ingestion_retired.e2e.js.
    ══════════════════════════════════════════════════════════════════════ */

const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const boundary = require("./proof_boundary.js");
const owned = boundary.manifest();
const { Pool } = require("pg");

const pool = new Pool({ connectionString: owned.url, ssl: false });
const API = process.env.E2E_API_BASE;
boundary.origin(API);
const KEY = process.env.E2E_OPERATOR_KEY || "e2e-key";
const expectedCommit = process.env.E2E_EXPECT_SERVER_COMMIT;
assert.match(expectedCommit || "", /^[a-f0-9]{40}$/, "exact expected runtime SHA required");

//  Witness mode: the parent handler is expected OPEN. Never a skip — the
//  same requests run, and the expectations invert.
const parentOpen = process.env.PROOF_EXPECT_PERSON_CREATE_OPEN === "1";

const one = async (sql, values) => (await pool.query(sql, values)).rows[0];
let passed = 0;
function check(label, condition, detail) {
  assert.ok(condition, `${label}: ${JSON.stringify(detail)}`);
  passed++;
  console.log(`PASS ${label}`);
}

async function call(method, path, { body, key = true, token } = {}) {
  const headers = {};
  if (key) headers["x-operator-key"] = KEY;
  if (token) headers["x-staff-session"] = token;
  let payload;
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const response = await fetch(API + path, {
    method, headers, body: payload, signal: AbortSignal.timeout(15000),
  });
  return { status: response.status, body: await response.json().catch(() => null) };
}

//  Whole rows, not counts: a count survives an overwrite and a
//  delete-plus-insert. A digest does not.
async function snapshot() {
  const state = {};
  for (const table of ["persons", "events"]) {
    state[table] = (await one(
      `select md5(coalesce(string_agg(row_to_json(t)::text, E'\\n' order by id),'')) digest from ${table} t`)).digest;
  }
  return JSON.stringify(state);
}

(async () => {
  await boundary.assertDatabase(owned);

  //  ── 0 · THE RUNTIME IS THIS TREE ──────────────────────────────────
  const staffSessions = require("../../src/identity/staff_session_service.js");
  const tag = `PersonRetire-${randomUUID()}`;
  const property = await one("insert into properties(name,address) values($1,'1 Proof Way') returning id", [tag]);
  const user = await one(`insert into users(name,email,role,is_active,status,account_kind)
    values($1,$2,'property_manager',true,'active','human_staff') returning id`, [tag, `${tag}@example.com`]);
  await pool.query(`insert into property_team_assignments
    (property_id,user_id,role_title,scope_type,allowed_modules,primary_for_modules,can_manage_roles,active)
    values($1,$2,'Proof','property','{leasing,management}','{leasing}',false,true)`, [property.id, user.id]);
  const client = await pool.connect();
  let token;
  try {
    await client.query("begin");
    token = (await staffSessions.issueStaffSession(client,
      { userId: user.id, propertyId: property.id, purpose: "sms_otp" })).session_token;
    await client.query("commit");
  } catch (error) { await client.query("rollback"); throw error; }
  finally { client.release(); }

  const build = await call("GET", "/operator/build", { token });
  check("runtime build receipt is accessible", build.status === 200, build);
  const commit = build.body && build.body.build && build.body.build.commit;
  check("the answering server is THIS tree, not a stale one on the port",
    commit === expectedCommit, { commit, expectedCommit });
  console.log(`PROOF_RUNTIME=${commit}`);

  const before = await snapshot();

  //  ── 1 · THE REQUEST THAT USED TO MINT A HUMAN ─────────────────────
  //  A complete, previously-VALID body. Before retirement this returned
  //  201 with a new person and wrote an `inquiry` event beside it.
  const full = await call("POST", "/persons", { body: {
    name: `${tag} Prospect`, email: `${tag}@example.com`, phone: "2155550123",
    source: "zillow", property_id: property.id,
  } });

  if (parentOpen) {
    //  ── THE WITNESS. The defect, observed on the parent handler. ─────
    check("PARENT: the open door answers 201", full.status === 201, full);
    const nameOnly = await call("POST", "/persons", { body: { name: `${tag} NameOnly` } });
    check("PARENT: a NAME ALONE is accepted", nameOnly.status === 201, nameOnly);
    const minted = (await pool.query(
      `select id, phone, email, primary_phone_e164 from persons where name=$1`, [`${tag} NameOnly`])).rows;
    check("PARENT: it minted a DURABLE PERSON with no continuity handle — no phone, no email, no normalised key",
      minted.length === 1 && minted[0].phone === null && minted[0].email === null
        && minted[0].primary_phone_e164 === null, minted);
    check("PARENT: the tables moved — the retirement proof is not asserting a route that never worked",
      await snapshot() !== before);
    console.log(`POST /persons PARENT WITNESS: ${passed} assertions passed — the defect is real`);
    return;
  }

  check("the door answers 410 Gone", full.status === 410, full);
  check("and it is REACHABLE — a 404 would leave the same digest and mean nothing else",
    full.status !== 404, full);
  check("the refusal carries the retirement code", full.body && full.body.code === "person_create_retired", full.body);

  //  ── 2 · THE REFUSAL IS SAYABLE AND NAMES WHERE THE WORK GOES ──────
  const receipt = String((full.body || {}).receipt || "");
  check("it names the leasing intake door", /POST \/leasing\/intake/.test(receipt), receipt);
  check("it names the link-resident door", /link-resident/.test(receipt), receipt);
  check("it states the rule a caller has to satisfy — a phone or an email",
    /phone/i.test(receipt) && /email/i.test(receipt) && /name on its own/i.test(receipt), receipt);
  check("it says nothing was changed", /Nothing was changed/i.test(receipt), receipt);
  check("it does not speak machinery at whoever reads it",
    !/insert|primary_phone_e164|lifecycle_status|tenant_ids|person_ingress|proposed_record/i.test(receipt), receipt);

  //  ── 3 · IT NO LONGER REASONS ABOUT THE REQUEST ────────────────────
  //  Each of these took a DIFFERENT path through the old handler and gave
  //  a different answer. One answer now, reached before any of it runs.
  const empty     = await call("POST", "/persons", { body: {} });                       // was 400
  const nameOnly  = await call("POST", "/persons", { body: { name: `${tag} NameOnly` } }); // was 201 — the defect
  const badProp   = await call("POST", "/persons", { body: { name: tag, property_id: randomUUID() } }); // was 404
  const badStatus = await call("POST", "/persons", { body: { name: tag, phone: "2155550124", lifecycle_status: "nonsense" } }); // was 400
  const noBody    = await call("POST", "/persons", {});                                  // was 400
  for (const [label, r] of [["an empty body", empty], ["a NAME ALONE — the defect itself", nameOnly],
    ["an unknown property_id", badProp], ["an invalid lifecycle_status", badStatus], ["no body at all", noBody]]) {
    check(`${label} gets the SAME 410 — input is never parsed or resolved`,
      r.status === 410 && r.body && r.body.code === "person_create_retired", { label, r });
  }

  //  ── 4 · NOTHING WAS WRITTEN, BY ANY OF IT ─────────────────────────
  check("persons and events are byte-identical after every refused call",
    await snapshot() === before);
  check("no person carries the name this proof tried to mint",
    (await one("select count(*)::int n from persons where name like $1", [`${tag}%`])).n === 0);

  //  ── 5 · IT IS NOT A NEW PUBLIC DOOR ───────────────────────────────
  const keyless = await call("POST", "/persons", { key: false, body: { name: tag, phone: "2155550125" } });
  check("without the shared key the server's gate refuses FIRST — the tombstone is never reached",
    keyless.status === 401 || keyless.status === 503, keyless);
  check("the keyless refusal is not the retirement receipt",
    !(keyless.body && keyless.body.code === "person_create_retired"), keyless.body);
  check("and it still wrote nothing", await snapshot() === before);

  //  ── 6 · THE WRITER IS RETIRED, NOT THE SURFACE ────────────────────
  const list = await call("GET", "/persons");
  check("GET /persons still answers — the reads beside it are untouched",
    list.status === 200 && Array.isArray(list.body), { status: list.status });

  console.log(`POST /persons retirement: ${passed} assertions passed`);
})().catch((error) => { console.error(error); process.exitCode = 1; })
  .finally(() => pool.end());
