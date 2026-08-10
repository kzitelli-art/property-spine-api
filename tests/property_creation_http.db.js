#!/usr/bin/env node
/* ════════════════════════════════════════════════════════════════════
   HARNESS — THE FOUR DOORS, THROUGH REAL HTTP (Build 1A-1)

   The DB harness proves the SERVICE. This proves the ROUTES: that each
   of the four doors reaches the canonical service, that the operator key
   alone no longer creates a property, and that the live super-admin
   wizard's contract is unchanged.

   ── WHY THIS IS A SEPARATE HARNESS ──────────────────────────────────
   THREAD_HANDOFF's standing trap: "a proof against a re-implementation
   is a proof about the re-implementation." A harness that mounts a bare
   express app models a server production does not have — the legal-pages
   incident was exactly that. So this builds the REAL gate chain from
   server.js's own rules (the operator-key middleware and the
   isOperatorPath/PUBLIC_PREFIXES allowlist shape) and mounts the SHIPPED
   route modules behind it.

   It is honest about the remaining gap: it does not boot server.js
   itself, because server.js opens Twilio, Anthropic and Plaid clients and
   binds a port. What it reproduces is the gate ordering those routes sit
   behind, and it asserts that ordering rather than assuming it.

   ── WHAT IT PROVES ──────────────────────────────────────────────────
   H1  the operator key ALONE no longer creates a property (all 3 doors)
   H2  a valid staff session + the key does create one
   H3  the created property carries an organization and a creation event
   H4  the live wizard's request/response contract is unchanged
   H5  a member's session is refused at the HTTP boundary, 403
   H6  bank intake's idempotency is intact over HTTP
   H7  owner.js still returns its owner-facing CARD shape, plus the
       absent-identity reason it could not previously explain
   H8  dealintake still teaches aliases and re-resolves its files

   run:  HARNESS_DATABASE_URL="postgres://..." node tests/property_creation_http.db.js
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const express = require("express");
const http = require("http");
const crypto = require("crypto");
const { Pool } = require("pg");
const receipt = require("./_run_receipt.js");

const URL = receipt.harnessConnectionString();
const pool = new Pool({ connectionString: URL, ssl: { rejectUnauthorized: false } });

const OPERATOR_KEY = "harness-operator-key-" + crypto.randomBytes(4).toString("hex");

let pass = 0, fail = 0;
const ok = (label, cond, detail) => {
  if (cond) { pass++; console.log("  ok    " + label); }
  else { fail++; console.log("  FAIL  " + label + (detail ? "\n        " + detail : "")); }
  return cond;
};

const TAG = "B1A1H_" + process.pid;
//  See the note in property_creation_canonical.db.js: canonical_key is
//  globally unique, so fixed street numbers make a harness single-use.
const N = 100000 + (process.pid % 800000);

// ── the REAL gate chain, transcribed from server.js ─────────────────
//  Not a simplification: the same allowlist shape, the same exact-boundary
//  operator-path match, the same fail-closed 503, the same 401 wording.
function buildApp() {
  const app = express();
  app.use(express.json({ limit: "1mb" }));

  const PUBLIC_EXACT = new Set(["/health", "/leasing/intake", "/communications/inbound-sms", "/applications/submit-public"]);
  const PUBLIC_PREFIXES = ["/tenant/", "/t/", "/public/", "/intake/", "/intake", "/auth/", "/demo/", "/agent/", "/legal/"];
  const isOperatorPath = (p) => p === "/operator" || p.startsWith("/operator/");

  app.use((req, res, next) => {
    if (req.method === "OPTIONS") return next();
    const p = req.path;
    if (PUBLIC_EXACT.has(p) || PUBLIC_PREFIXES.some((x) => p === x || p.startsWith(x))) return next();
    if (isOperatorPath(p)) return next();
    if (p === "/admin" || p.startsWith("/admin/")) return next();
    if (p === "/org" || p.startsWith("/org/")) return next();
    if (!OPERATOR_KEY) return res.status(503).json({ receipt: "Operator routes are locked: set OPERATOR_KEY..." });
    if (req.get("x-operator-key") !== OPERATOR_KEY) return res.status(401).json({ receipt: "Missing or wrong x-operator-key." });
    next();
  });

  //  The SHIPPED modules. Two of them need collaborators they will not
  //  exercise on the creation path; they are constructed, never called.
  app.use("/", require("../src/identity/super_admin.js")({ pool }));
  app.use("/", require("../src/money/bankintake.js")({ pool }));
  app.use("/", require("../src/surfaces/owner.js")({ pool }));
  app.use("/", require("../src/onboarding/dealintake.js")({
    pool,
    anthropic: { messages: { create: async () => { throw new Error("not used on the creation path"); } } },
    INGEST_MODEL: "unused",
    registryInstance: { resolveOnly: async () => ({ status: "skipped" }) },
    fileToText: async () => "",
    runIngestAuto: async () => ({}),
    upload: { array: () => (req, res, next) => next(), single: () => (req, res, next) => next() },
  }));
  return app;
}

function request(port, method, path, { body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request({ host: "127.0.0.1", port, method, path,
      headers: Object.assign({ "content-type": "application/json" },
        payload ? { "content-length": Buffer.byteLength(payload) } : {}, headers) },
      (res) => {
        let data = "";
        res.on("data", (c) => { data += c; });
        res.on("end", () => {
          let parsed = null;
          try { parsed = data ? JSON.parse(data) : null; } catch (_) { parsed = { _raw: data }; }
          resolve({ status: res.statusCode, body: parsed });
        });
      });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

(async () => {
  receipt.begin(__filename, { url: URL, expected: 16 });

  const server = buildApp().listen(0);
  await new Promise((r) => server.once("listening", r));
  const port = server.address().port;
  console.log("  real HTTP server on 127.0.0.1:" + port + "\n");

  // ── fixtures: two orgs, three logins, real staff sessions ─────────
  const orgA = (await pool.query(`insert into organizations (name, slug) values ($1,$2) returning id`,
    [TAG + " Org A", TAG.toLowerCase() + "-a"])).rows[0].id;
  const person = (await pool.query(`insert into persons (name) values ($1) returning id`, [TAG + " Human"])).rows[0].id;

  const mkUser = async (role, org) => (await pool.query(
    `insert into users (name, email, platform_role, organization_id, is_active, status, person_id)
     values ($1,$2,$3,$4,true,'active',$5) returning id`,
    [TAG + " " + role, `${TAG}.${role}.${crypto.randomBytes(3).toString("hex")}@example.test`, role, org, person])).rows[0].id;

  const superAdmin = await mkUser("super_admin", null);
  const adminA = await mkUser("org_admin", orgA);
  const member = await mkUser("member", orgA);

  //  A staff session requires an ACTIVE property_team_assignment — the
  //  session resolver joins it. That is the shipped rule, so the fixture
  //  obeys it rather than working around it.
  const seat = (await pool.query(
    `insert into properties (name, canonical_key) values ($1,$2) returning id`,
    [TAG + " session seat", TAG + "-SEAT"])).rows[0].id;

  const mkSession = async (userId) => {
    const raw = crypto.randomBytes(32).toString("base64url");
    await pool.query(
      `insert into property_team_assignments (property_id, user_id, role_title, allowed_modules, active)
       values ($1,$2,'harness',ARRAY['management'],true)
       on conflict do nothing`, [seat, userId]);
    await pool.query(
      `insert into staff_sessions (user_id, property_id, token, token_digest, issuance_purpose, expires_at)
       values ($1,$2,null,$3,'bootstrap_invite', now() + interval '2 hours')`,
      [userId, seat, crypto.createHash("sha256").update(raw, "utf8").digest("hex")]);
    return raw;
  };

  const sSuper = await mkSession(superAdmin);
  const sAdminA = await mkSession(adminA);
  const sMember = await mkSession(member);

  const KEY = { "x-operator-key": OPERATOR_KEY };
  const withSession = (t) => Object.assign({}, KEY, { "x-staff-session": t });

  // ══════════════════════════════════════════════════════════════════
  console.log("  ── H1 · THE OPERATOR KEY ALONE NO LONGER CREATES ──");
  // ══════════════════════════════════════════════════════════════════
  const r1a = await request(port, "POST", "/bank/onboard-property",
    { headers: KEY, body: { name: TAG + " key only", canonical_key: TAG + "-KEYONLY" } });
  ok("H1a /bank/onboard-property refuses the key alone (401)",
    r1a.status === 401 && r1a.body.reason === "no_authenticated_actor",
    JSON.stringify(r1a));

  const r1b = await request(port, "POST", "/owner/properties/create-from-upload",
    { headers: KEY, body: { name: TAG + " key only 2" } });
  ok("H1b /owner/properties/create-from-upload refuses the key alone (401)",
    r1b.status === 401 && r1b.body.reason === "no_authenticated_actor",
    JSON.stringify(r1b));

  const intake = (await pool.query(
    `insert into deal_intakes (onboarding_type) values ('management_takeover') returning id`)).rows[0].id;
  const r1c = await request(port, "POST", `/deal-intakes/${intake}/create-property`,
    { headers: KEY, body: { name: TAG + " key only 3", address: `${N + 700} Market Street` } });
  ok("H1c /deal-intakes/:id/create-property refuses the key alone (401)",
    r1c.status === 401 && r1c.body.reason === "no_authenticated_actor",
    JSON.stringify(r1c));

  //  And nothing was created by any of the three refusals.
  const leaked = (await pool.query(
    `select count(*)::int n from properties where name like $1`, [TAG + " key only%"])).rows[0].n;
  ok("H1d the three refusals created NO property", leaked === 0, leaked + " leaked");

  // ══════════════════════════════════════════════════════════════════
  console.log("\n  ── H2–H4 · THE LIVE WIZARD, CONTRACT UNCHANGED ──");
  // ══════════════════════════════════════════════════════════════════
  //  Exactly the body the deployed app sends (saWizAddProperty), including
  //  its optional-address shape.
  const wiz = await request(port, "POST", `/admin/organizations/${orgA}/properties/new`, {
    headers: { "x-staff-session": sSuper },
    body: { name: TAG + " Wizard Building", display_name: TAG + " Wizard",
            address: `${N + 1325} N 15th Street`, city: "Philadelphia", state: "PA",
            zip: "19121", property_type: "multifamily", planned_unit_count: 24 },
  });
  ok("H4a the wizard still answers 201 with the property object",
    wiz.status === 201 && wiz.body && wiz.body.id && wiz.body.name === TAG + " Wizard Building",
    JSON.stringify(wiz).slice(0, 300));
  ok("H4b every field the wizard sends is still round-tripped",
    wiz.body.display_name === TAG + " Wizard" && wiz.body.city === "Philadelphia"
      && wiz.body.state === "PA" && wiz.body.zip === "19121"
      && wiz.body.property_type === "multifamily" && wiz.body.planned_unit_count === 24,
    JSON.stringify(wiz.body));
  //  Directional dropped, street type dropped, NAME kept — the whole
  //  point of the derivation, asserted on a per-run number.
  ok(`H4c and it now carries a derived identity  (${N + 1325} N 15th Street → ${N + 1325}-15TH)`,
    wiz.body.canonical_key === `${N + 1325}-15TH`, "got " + JSON.stringify(wiz.body.canonical_key));

  const wizEv = (await pool.query(
    `select actor_user_id, authority_basis, creation_source, organization_id
       from property_creation_events where property_id = $1`, [wiz.body.id])).rows;
  ok("H3a the wizard's property carries an organization",
    String(wiz.body.organization_id) === String(orgA));
  ok("H3b and an attributable creation event",
    wizEv.length === 1 && String(wizEv[0].actor_user_id) === String(superAdmin)
      && wizEv[0].authority_basis === "platform_role:super_admin"
      && wizEv[0].creation_source === "super_admin_wizard",
    JSON.stringify(wizEv));

  //  The address-less wizard case the live surface permits.
  const wizNoAddr = await request(port, "POST", `/admin/organizations/${orgA}/properties/new`,
    { headers: { "x-staff-session": sSuper }, body: { name: TAG + " No Address" } });
  ok("H4d an address-less wizard create still succeeds, with the gap explained",
    wizNoAddr.status === 201 && wizNoAddr.body.canonical_key === null
      && wizNoAddr.body.canonical_key_absent_reason === "no_address_supplied_at_creation",
    JSON.stringify(wizNoAddr.body));

  // ══════════════════════════════════════════════════════════════════
  console.log("\n  ── H5 · CONTAINMENT AT THE HTTP BOUNDARY ──");
  // ══════════════════════════════════════════════════════════════════
  const r5 = await request(port, "POST", "/bank/onboard-property",
    { headers: withSession(sMember), body: { name: TAG + " member", canonical_key: TAG + "-MEMBER" } });
  ok("H5  a member's real session is refused 403 over HTTP",
    r5.status === 403 && r5.body.reason === "insufficient_platform_role", JSON.stringify(r5));

  // ══════════════════════════════════════════════════════════════════
  console.log("\n  ── H6–H8 · EACH DOOR KEEPS WHAT IT CONTRIBUTED ──");
  // ══════════════════════════════════════════════════════════════════
  const b1 = await request(port, "POST", "/bank/onboard-property",
    { headers: withSession(sAdminA), body: { name: TAG + " Tower", canonical_key: TAG + "-TOWER" } });
  const b2 = await request(port, "POST", "/bank/onboard-property",
    { headers: withSession(sAdminA), body: { name: TAG + " Tower again", canonical_key: TAG + "-TOWER" } });
  ok("H6  bank intake's idempotency is intact over HTTP (same key → same property)",
    b1.status === 200 && b2.status === 200 && b1.body.created === true && b2.body.created === false
      && b1.body.property.id === b2.body.property.id,
    JSON.stringify({ a: b1.body && b1.body.created, b: b2.body && b2.body.created }));

  const ow = await request(port, "POST", "/owner/properties/create-from-upload", {
    headers: withSession(sAdminA),
    body: { name: TAG + " Owner Bldg", address: `${N + 800} Vine Street`,
            resolve_value: TAG + " vine rent roll", source: "rent_roll" } });
  ok("H7a owner.js still returns its owner-facing CARD shape",
    ow.status === 201 && ow.body.status === "created" && ow.body.property
      && ow.body.property.property_id && ow.body.property.identity === "Recognized"
      && ow.body.property.next_action,
    JSON.stringify(ow).slice(0, 300));
  ok("H7b the card now carries the absent-identity reason it could not explain before",
    Object.prototype.hasOwnProperty.call(ow.body.property._details, "canonical_key_absent_reason")
      && ow.body.property._details.canonical_key === `${N + 800}-VINE`,
    JSON.stringify(ow.body.property._details));

  //  Two files on one intake, both labelled — dealintake's teach + resolve.
  await pool.query(
    `insert into deal_intake_files (intake_id, original_filename, identity_label)
     values ($1,'roll.xlsx',$2), ($1,'t12.pdf',$2)`, [intake, TAG + " uno label"]);
  const di = await request(port, "POST", `/deal-intakes/${intake}/create-property`, {
    headers: withSession(sAdminA),
    body: { name: TAG + " Deal Bldg", address: `${N + 4125} Chestnut Street`, leasing_basis: "unit" } });
  ok("H8a dealintake still teaches its observed labels and re-resolves its files",
    di.status === 201 && di.body.aliases_taught === 1 && di.body.files_resolved === 2,
    JSON.stringify(di.body));
  ok("H8b and it now stores the identity its own 'address is identity' rule implied",
    di.body.canonical_key === `${N + 4125}-CHESTNUT`, "got " + JSON.stringify(di.body.canonical_key));

  //  Every property made over HTTP in this run has a client and a history.
  const orphaned = (await pool.query(
    `select count(*)::int n from properties p
      join property_creation_events e on e.property_id = p.id
     where p.name like $1 and p.organization_id is null`, [TAG + "%"])).rows[0].n;
  ok("H3c no property created over HTTP in this run is an orphan", orphaned === 0);

  console.log("");
  const code = receipt.complete({ harness: __filename, passed: pass, failed: fail, expectedAtLeast: 16 });
  server.close();
  await pool.end();
  process.exit(code);
})().catch(async (e) => {
  console.error("\n  " + (e && e.stack || e));
  const code = receipt.died(__filename, e, pass + fail);
  try { await pool.end(); } catch (_) {}
  process.exit(code);
});
