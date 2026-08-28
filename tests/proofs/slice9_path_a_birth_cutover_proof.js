/* ══════════════════════════════════════════════════════════════════════════
   slice9_path_a_birth_cutover_proof.js — PATH A through real HTTP.

   Both application-birth doors now insert through the canonical lifecycle
   authority instead of their own raw SQL:

     application_submission.js  submitApplicationService  (public + internal)
     applications.js           POST /properties/:id/applications

   A syntax check proves nothing about a cutover. What must hold is that the
   routes still behave exactly as before EXCEPT that submitted_at is now
   authored in the same statement as the status. So this mounts the real
   routers on a real express app, sends real HTTP, and asserts on the STORED
   row — never on the service's return value.

   Preserved contract under test:
     · person_id required (the birth guard), unknown property refused
     · leasing-lead lineage resolved and verified; mismatch refused
     · source and captured survive the cutover
     · the application_submitted event is still written
     · the application_approval gate is still born and linked
     · a failure inside the transaction rolls the whole birth back
     · the response shape is unchanged
   New behaviour under test:
     · submitted_at is non-null and equals the row's transaction timestamp
     · no caller can name a lifecycle column through the route body

   SAFETY: every row this creates is deleted in the finally block.
   Run: DATABASE_URL=... node tests/proofs/slice9_path_a_birth_cutover_proof.js
   ══════════════════════════════════════════════════════════════════════════ */
"use strict";
const express = require("express");
const http = require("http");
const crypto = require("crypto");
const { Pool } = require("pg");

let pass = 0, fail = 0;
const ok = (m, c, d) => {
  if (c) { pass++; console.log("   PASS  " + m); }
  else { fail++; console.log("   FAIL  " + m + (d ? "\n           " + d : "")); }
};
const section = (t) => console.log("\n── " + t + " " + "─".repeat(Math.max(0, 54 - t.length)));

if (!process.env.DATABASE_URL) { console.error("\nDATABASE_URL is required.\n"); process.exit(1); }
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// ── the engine shim: mirrors server.js's spawn/complete, against the SAME
//    transaction client the route is using. Not a stub of the code under
//    test — the code under test is the two routers.
async function spawnObligationFromEvent(client, s) {
  return (await client.query(
    `insert into obligations
       (property_id, person_id, unit_id, source_event_id, related_id, related_type,
        module, type, label, owner_type, assigned_role, status, priority, severity)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) returning *`,
    [s.property_id, s.person_id || null, s.unit_id || null, s.source_event_id || null,
     s.related_id || null, s.related_type || null, s.module || "applications",
     s.type, s.label || null, s.owner_type || "human", s.assigned_role || null,
     s.status || "open", s.priority || "normal", s.severity || "normal"])).rows[0];
}
async function completeObligation(client, { obligation_id, completed_by = null }) {
  const r = await client.query(
    `update obligations set status='complete', completed_at=now(), updated_at=now()
      where id=$1 and status <> 'complete' returning *`, [obligation_id]);
  if (!r.rows[0]) { const e = new Error("already complete"); e.code = "ALREADY_COMPLETE"; throw e; }
  return r.rows[0];
}
const satisfyObligation = async () => { throw new Error("not exercised by this proof"); };

// ── real HTTP, no supertest dependency ──────────────────────────────
function request(port, method, path, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({ host: "127.0.0.1", port, method, path,
      headers: payload
        ? { "content-type": "application/json", "content-length": payload.length }
        : {} },
      (res) => {
        let raw = "";
        res.on("data", (d) => { raw += d; });
        res.on("end", () => {
          let json = null;
          try { json = JSON.parse(raw); } catch (_) { /* honest null beats a bad parse */ }
          resolve({ status: res.statusCode, body: json, raw });
        });
      });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const made = { apps: [], persons: [], props: [], leads: [], units: [] };

(async () => {
  const app = express();
  app.use(express.json());
  app.use("/", require("../../src/applications/applications.js")({
    pool, spawnObligationFromEvent, satisfyObligation, completeObligation }));
  app.use("/", require("../../src/applications/application_submission.js")({
    pool, spawnObligationFromEvent, completeObligation, conversionService: null }));

  const server = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  const port = server.address().port;

  try {
    // ── seed, COMMITTED: the routes open their own transactions, so a
    //    fixture held open in one would be invisible to them.
    const prop = (await pool.query(
      `insert into properties (name) values ('Path A Proof Property') returning id`)).rows[0].id;
    made.props.push(prop);
    const person = (await pool.query(
      `insert into persons (name) values ('Path A Applicant') returning id`)).rows[0].id;
    made.persons.push(person);

    const track = (r) => { if (r && r.body && r.body.application && r.body.application.id) made.apps.push(r.body.application.id); return r; };
    const row = async (id) => (await pool.query("select * from lease_applications where id=$1", [id])).rows[0];

    // ══════════════════════════════════════════════════════════════
    section("A  applications.js door — POST /properties/:id/applications");
    const r1 = track(await request(port, "POST", `/properties/${prop}/applications`, {
      applicant_name: "Path A One", person_id: person, unit_label: "3B",
      rent: 1650, deposit: 1650, captured: { application_form_version: "legacy", note: "path a" },
    }));
    ok("route returned 200", r1.status === 200, `got ${r1.status}: ${r1.raw.slice(0, 200)}`);
    ok("response shape unchanged: receipt + application.id + application_position",
      !!r1.body && typeof r1.body.receipt === "string"
      && !!r1.body.application && !!r1.body.application.id
      && "application_position" in r1.body.application);

    const a1 = await row(r1.body.application.id);
    ok("stored status is submitted", a1.status === "submitted");
    ok("submitted_at IS AUTHORED — the whole point of the cutover", a1.submitted_at != null);
    ok("no approval milestone was invented", a1.approved_at === null);
    ok("no terminal metadata was invented", a1.terminal_at === null && a1.terminal_code === null);
    ok("captured survived the cutover",
      a1.captured && a1.captured.note === "path a", JSON.stringify(a1.captured));
    ok("rent/deposit/unit_label survived",
      Number(a1.rent) === 1650 && Number(a1.deposit) === 1650 && a1.unit_label === "3B");
    ok("person and property are the ones supplied",
      String(a1.person_id) === String(person) && String(a1.property_id) === String(prop));

    // submitted_at must be the row's OWN transaction instant, not a later
    // update. Equal-to-created_at within the same statement is the evidence.
    const sameTx = (await pool.query(
      `select (submitted_at = created_at) as same from lease_applications where id=$1`, [a1.id])).rows[0].same;
    ok("submitted_at was authored in the SAME statement as the row (= created_at)", sameTx === true);

    ok("the application_submitted event is still written",
      (await pool.query(
        `select count(*)::int n from events where property_id=$1 and type='application_submitted'`,
        [prop])).rows[0].n >= 1);

    section("B  the birth guard survives — identity is never inferred");
    const noPerson = await request(port, "POST", `/properties/${prop}/applications`, {
      applicant_name: "No Identity" });
    ok("person_id omitted → 400", noPerson.status === 400, `got ${noPerson.status}`);
    ok("and the refusal is the person_required contract",
      noPerson.body && noPerson.body.error === "person_required");
    ok("nothing was written for the refused birth",
      (await pool.query(
        `select count(*)::int n from lease_applications where applicant_name='No Identity'`)).rows[0].n === 0);

    const noName = await request(port, "POST", `/properties/${prop}/applications`,
      { person_id: person });
    ok("applicant_name omitted → 400", noName.status === 400);

    const badProp = await request(port, "POST",
      `/properties/${crypto.randomUUID()}/applications`,
      { applicant_name: "Ghost Property", person_id: person });
    ok("unknown property → 404, not a foreign-key 500", badProp.status === 404, `got ${badProp.status}`);

    section("C  a request body cannot reach a lifecycle column");
    // TWO DIFFERENT DEFENCES, asserted at the layer that actually owns each.
    //
    // At the ROUTE, the body is destructured into a fixed set of names, so
    // status/approved_at/terminal_code are never read at all — they are inert,
    // not refused. That is pre-existing route behaviour and this cutover did
    // not change it, so the honest assertion is that the injection has NO
    // EFFECT on the stored row, not that it returns 409.
    const inject = track(await request(port, "POST", `/properties/${prop}/applications`, {
      applicant_name: "Injector", person_id: person,
      status: "active", approved_at: "2020-01-01T00:00:00Z", terminal_code: "declined",
    }));
    ok("the route accepts the request (unknown body keys are not read)",
      inject.status === 200, `got ${inject.status}`);
    const inj = await row(inject.body.application.id);
    ok("the injected status had NO effect — row is 'submitted'", inj.status === "submitted");
    ok("the injected approved_at had NO effect — still null", inj.approved_at === null);
    ok("the injected terminal_code had NO effect — still null",
      inj.terminal_code === null && inj.terminal_at === null);

    // At the MODULE, the payload is a closed allowlist, so the same field
    // names ARE refused rather than silently dropped. This is what stops a
    // future caller from believing it set a milestone that never landed.
    const lifecycle = require("../../src/applications/application_lifecycle.js");
    const c = await pool.connect();
    let allowlistCode = null;
    try {
      await c.query("begin");
      try {
        await lifecycle.createSubmittedApplication(c, {
          property_id: prop, person_id: person, applicant_name: "Direct Injector",
          status: "active", approved_at: "2020-01-01T00:00:00Z",
        });
      } catch (e) { allowlistCode = e.code; }
    } finally { await c.query("rollback").catch(() => {}); c.release(); }
    ok("the authority REFUSES a payload naming lifecycle columns",
      allowlistCode === "birth_payload_unknown_field", String(allowlistCode));

    // ══════════════════════════════════════════════════════════════
    section("D  application_submission.js door — internal submit");
    const prevKey = process.env.OPERATOR_KEY;
    delete process.env.OPERATOR_KEY;   // requireOperator passes when unset
    const r2 = track(await request(port, "POST", `/properties/${prop}/applications/internal`, {
      applicant_name: "Path A Two", person_id: person, unit_label: "4C",
      rent: 1800, source: "staff", captured: { note: "internal path" },
    }));
    ok("route returned 200", r2.status === 200, `got ${r2.status}: ${r2.raw.slice(0, 300)}`);
    ok("response shape unchanged: receipt + application + approval_obligation_id",
      !!r2.body && typeof r2.body.receipt === "string" && !!r2.body.application
      && !!r2.body.approval_obligation_id);

    const a2 = await row(r2.body.application.id);
    ok("stored status is submitted", a2.status === "submitted");
    ok("submitted_at IS AUTHORED on the canonical service path", a2.submitted_at != null);
    ok("submitted_at authored in the same statement (= created_at)",
      (await pool.query(`select (submitted_at = created_at) as s from lease_applications where id=$1`,
        [a2.id])).rows[0].s === true);
    ok("no approval or terminal milestone invented",
      a2.approved_at === null && a2.terminal_at === null && a2.terminal_code === null);
    ok("source survived the cutover", a2.source === "staff", String(a2.source));
    ok("captured survived the cutover", a2.captured && a2.captured.note === "internal path");

    ok("the application_approval gate was born and LINKED to the application",
      String(a2.approval_obligation_id) === String(r2.body.approval_obligation_id));
    const gate = (await pool.query("select * from obligations where id=$1",
      [r2.body.approval_obligation_id])).rows[0];
    ok("the gate is an open application_approval owned by leasing_manager",
      !!gate && gate.type === "application_approval" && gate.status === "open"
      && gate.assigned_role === "leasing_manager",
      gate ? `${gate.type}/${gate.status}/${gate.assigned_role}` : "no gate");
    ok("the gate is bound to THIS application",
      !!gate && String(gate.related_id) === String(a2.id)
      && gate.related_type === "lease_application");

    section("E  leasing-lead lineage is resolved and verified");
    const lead = (await pool.query(
      `insert into leasing_leads (property_id, person_id, status)
       values ($1,$2,'new') returning id`, [prop, person])).rows[0].id;
    made.leads.push(lead);
    const r3 = track(await request(port, "POST", `/properties/${prop}/applications/internal`, {
      applicant_name: "Path A Three", person_id: person, source: "staff" }));
    ok("internal submit returned 200", r3.status === 200, `got ${r3.status}: ${r3.raw.slice(0, 200)}`);
    const a3 = await row(r3.body.application.id);
    ok("the open leasing lead was resolved onto the application",
      String(a3.leasing_lead_id) === String(lead), String(a3.leasing_lead_id));
    ok("and submitted_at is authored on the lead-linked birth too", a3.submitted_at != null);

    // A lead belonging to a DIFFERENT person must never become this
    // application's lineage.
    const otherPerson = (await pool.query(
      `insert into persons (name) values ('Path A Other') returning id`)).rows[0].id;
    made.persons.push(otherPerson);
    const foreignLead = (await pool.query(
      `insert into leasing_leads (property_id, person_id, status)
       values ($1,$2,'new') returning id`, [prop, otherPerson])).rows[0].id;
    made.leads.push(foreignLead);

    // The internal ROUTE does not forward a leasing_lead_id hint — it is not
    // among the destructured body keys — so the service always resolves the
    // lead itself. Passing a foreign id in the body is therefore inert, and
    // the assertion is that it is never attached, not that it 409s.
    const crossed = track(await request(port, "POST", `/properties/${prop}/applications/internal`, {
      applicant_name: "Crossed Lineage", person_id: person, source: "staff",
      leasing_lead_id: foreignLead }));
    ok("the route ignores a body-supplied lead hint (it is not forwarded)",
      crossed.status === 200, `got ${crossed.status}`);
    const ax = await row(crossed.body.application.id);
    ok("the FOREIGN lead was never attached", String(ax.leasing_lead_id) !== String(foreignLead));
    ok("the server-resolved lead for THIS person was used instead",
      String(ax.leasing_lead_id) === String(lead), String(ax.leasing_lead_id));

    // The lineage guard itself is real code with no HTTP caller today. Prove
    // it at the layer that owns it rather than claiming a route enforces it.
    const svc = require("../../src/applications/application_submission.js")({
      pool, spawnObligationFromEvent, completeObligation, conversionService: null })._service;
    const c2 = await pool.connect();
    let lineageStatus = null;
    try {
      await c2.query("begin");
      try {
        await svc.submitApplicationService(c2, {
          property_id: prop, person_id: person, applicant_name: "Direct Crossed",
          source: "staff", leasing_lead_id: foreignLead });
      } catch (e) { lineageStatus = e.httpStatus; }
    } finally { await c2.query("rollback").catch(() => {}); c2.release(); }
    ok("the service REFUSES (409) an explicit cross-person lead hint",
      lineageStatus === 409, String(lineageStatus));

    section("F  the internal door keeps its own guards");
    const badSource = await request(port, "POST", `/properties/${prop}/applications/internal`, {
      applicant_name: "Bad Source", person_id: person, source: "applicant" });
    ok("source outside staff|import refused (400)", badSource.status === 400);
    const intNoPerson = await request(port, "POST", `/properties/${prop}/applications/internal`, {
      applicant_name: "Internal No Identity", source: "staff" });
    ok("internal door still requires person_id (400)", intNoPerson.status === 400);
    ok("no row survived either internal refusal",
      (await pool.query(
        `select count(*)::int n from lease_applications
          where applicant_name in ('Bad Source','Internal No Identity')`)).rows[0].n === 0);

    if (prevKey !== undefined) process.env.OPERATOR_KEY = prevKey;

    section("G  the whole birth rolls back together");
    // The gate spawn happens AFTER the insert in the same transaction. Break
    // it, and the application must not survive — otherwise a birth could land
    // with no approval gate and no one would ever be asked to decide.
    const realSpawn = spawnObligationFromEvent;
    const brokenApp = express();
    brokenApp.use(express.json());
    brokenApp.use("/", require("../../src/applications/application_submission.js")({
      pool,
      spawnObligationFromEvent: async () => { throw new Error("engine failure during gate spawn"); },
      completeObligation, conversionService: null }));
    const bs = await new Promise((r) => { const s = brokenApp.listen(0, "127.0.0.1", () => r(s)); });
    const broken = await request(bs.address().port, "POST",
      `/properties/${prop}/applications/internal`,
      { applicant_name: "Rollback Probe", person_id: person, source: "staff" });
    await new Promise((r) => bs.close(r));
    ok("a failure after the insert returns an error, not a 200", broken.status >= 400,
      `got ${broken.status}`);
    ok("and the application row did NOT survive the rollback",
      (await pool.query(
        `select count(*)::int n from lease_applications where applicant_name='Rollback Probe'`)).rows[0].n === 0);
    void realSpawn;

    section("H  the authority is the ONLY birth writer left");
    const fs = require("fs");
    const raw = ["src/applications/applications.js", "src/applications/application_submission.js"]
      .map((f) => fs.readFileSync(require("path").join(__dirname, "..", f), "utf8"))
      .join("\n");
    ok("neither cut-over door still contains a raw lease_applications INSERT",
      !/insert\s+into\s+lease_applications/i.test(raw));
    ok("both doors require the canonical authority",
      (raw.match(/require\(["']\.\/application_lifecycle["']\)/g) || []).length === 2);
  } finally {
    await new Promise((r) => server.close(r));
    // Ordered teardown: children before parents.
    for (const id of made.apps) {
      await pool.query("delete from obligations where related_id=$1", [id]).catch(() => {});
      await pool.query("delete from lease_applications where id=$1", [id]).catch(() => {});
    }
    await pool.query(
      `delete from lease_applications where property_id = any($1)`, [made.props]).catch(() => {});
    await pool.query(`delete from obligations where property_id = any($1)`, [made.props]).catch(() => {});
    await pool.query(`delete from events where property_id = any($1)`, [made.props]).catch(() => {});
    for (const id of made.leads) await pool.query("delete from leasing_leads where id=$1", [id]).catch(() => {});
    for (const id of made.props) await pool.query("delete from properties where id=$1", [id]).catch(() => {});
    for (const id of made.persons) await pool.query("delete from persons where id=$1", [id]).catch(() => {});
    await pool.end().catch(() => {});
  }

  console.log(`\n════ ${pass} passed, ${fail} failed ════\n`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error("\nPROOF CRASHED:", e.stack, "\n"); process.exit(1); });
