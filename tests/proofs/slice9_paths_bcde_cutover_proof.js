/* ══════════════════════════════════════════════════════════════════════════
   slice9_paths_bcde_cutover_proof.js — PATHS B–E.

   The four remaining raw status writers now go through the canonical
   authority:

     B  applications.js          approve      → lease_ready
     C  application_submission.js deny         → declined|withdrawn|expired
     D  executed_lease_service   admission    → accepted_term_required
     E  tenancy_anchor_service   activation   → active

   COVERAGE, STATED HONESTLY — B and C are exercised end-to-end through real
   HTTP against real Postgres. D and E are NOT: their services sit behind
   activation gates and multi-table admission fixtures (verified execution
   record + acknowledged proposed terms + lease anchor) that this harness
   does not build. For those two, what is proven here is the CALLER's half —
   that the raw write is gone, that the authority is invoked with the correct
   arguments, and that the call is correctly ORDERED after the facts it
   verifies. The writers themselves are proven separately and in full by
   slice9_lifecycle_authority_proof.js (96/96 under staged 125), which
   already asserts that admission writes status only and leaves
   countersigned_at byte-identical, and that activation refuses a foreign
   lease or an incomplete term obligation.

   That split is the honest statement of what this run establishes. It is not
   a claim that D and E are browser- or service-path verified.

   Run: DATABASE_URL=... node tests/proofs/slice9_paths_bcde_cutover_proof.js
   ══════════════════════════════════════════════════════════════════════════ */
"use strict";
const express = require("express");
const http = require("http");
const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

let pass = 0, fail = 0;
const ok = (m, c, d) => {
  if (c) { pass++; console.log("   PASS  " + m); }
  else { fail++; console.log("   FAIL  " + m + (d ? "\n           " + d : "")); }
};
const section = (t) => console.log("\n── " + t + " " + "─".repeat(Math.max(0, 56 - t.length)));

if (!process.env.DATABASE_URL) { console.error("\nDATABASE_URL is required.\n"); process.exit(1); }
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function spawnObligationFromEvent(client, s) {
  return (await client.query(
    `insert into obligations
       (property_id, person_id, unit_id, source_event_id, related_id, related_type,
        module, type, label, owner_type, assigned_role, status, priority, severity, required_inputs)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) returning *`,
    [s.property_id, s.person_id || null, s.unit_id || null, s.source_event_id || null,
     s.related_id || null, s.related_type || null, s.module || "applications",
     s.type, s.label || null, s.owner_type || "human", s.assigned_role || null,
     s.status || "open", s.priority || "normal", s.severity || "normal",
     s.required_inputs || []])).rows[0];
}
async function completeObligation(client, { obligation_id, completed_by = null }) {
  const r = await client.query(
    `update obligations set status='complete', completed_at=now(), updated_at=now()
      where id=$1 and status <> 'complete' returning *`, [obligation_id]);
  if (!r.rows[0]) { const e = new Error("already complete"); e.code = "ALREADY_COMPLETE"; throw e; }
  return r.rows[0];
}
const satisfyObligation = async () => ({});

function request(port, method, p, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({ host: "127.0.0.1", port, method, path: p,
      headers: payload ? { "content-type": "application/json", "content-length": payload.length } : {} },
      (res) => {
        let raw = ""; res.on("data", (d) => { raw += d; });
        res.on("end", () => {
          let json = null; try { json = JSON.parse(raw); } catch (_) {}
          resolve({ status: res.statusCode, body: json, raw });
        });
      });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const props = [], persons = [];

(async () => {
  const app = express();
  app.use(express.json());
  const subRouter = require("../../src/applications/application_submission.js")({
    pool, spawnObligationFromEvent, completeObligation, conversionService: null });
  app.use("/", require("../../src/applications/applications.js")({
    pool, spawnObligationFromEvent, satisfyObligation, completeObligation,
    submissionService: subRouter._service }));
  app.use("/", subRouter);
  const server = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  const port = server.address().port;
  const prevKey = process.env.OPERATOR_KEY;
  delete process.env.OPERATOR_KEY;

  try {
    const prop = (await pool.query(
      `insert into properties (name) values ('BCDE Proof Property') returning id`)).rows[0].id;
    props.push(prop);
    const person = (await pool.query(
      `insert into persons (name) values ('BCDE Applicant') returning id`)).rows[0].id;
    persons.push(person);
    const row = async (id) => (await pool.query("select * from lease_applications where id=$1", [id])).rows[0];

    // birth through the (already cut over) Path A door
    const born = async (name) => {
      const r = await request(port, "POST", `/properties/${prop}/applications/internal`,
        { applicant_name: name, person_id: person, source: "staff" });
      if (r.status !== 200) throw new Error(`seed birth failed ${r.status}: ${r.raw.slice(0, 200)}`);
      return r.body.application.id;
    };

    // ══════════════════════════════════════════════════════════════
    section("B  approve → lease_ready authors the approval instant");
    const b1 = await born("Path B One");
    const beforeB = await row(b1);
    ok("seed sits at submitted with NO approval instant",
      beforeB.status === "submitted" && beforeB.approved_at === null);

    const rb = await request(port, "POST", `/applications/${b1}/approve`, { approved_by: "QA" });
    ok("approve returned 200", rb.status === 200, `got ${rb.status}: ${rb.raw.slice(0, 250)}`);
    const ab = await row(b1);
    ok("status is lease_ready", ab.status === "lease_ready", ab.status);
    ok("approved_at IS AUTHORED — the whole point of Path B", ab.approved_at != null);
    ok("submitted_at was NOT disturbed by approval",
      String(ab.submitted_at) === String(beforeB.submitted_at));
    ok("no terminal metadata invented", ab.terminal_at === null && ab.terminal_code === null);
    ok("the terms_review obligation is linked", ab.terms_review_obligation_id != null);
    const tr = (await pool.query("select * from obligations where id=$1",
      [ab.terms_review_obligation_id])).rows[0];
    ok("and it is a real open terms_review bound to THIS application",
      !!tr && tr.type === "terms_review" && tr.status === "open"
      && String(tr.related_id) === String(b1));
    ok("the response still carries the approved application",
      !!rb.body && !!rb.body.application && rb.body.application.id === b1);

    // The authority verifies the obligation it is handed; a lease_ready row
    // whose pointer does not match must not be blessed as an idempotent replay.
    const reB = await request(port, "POST", `/applications/${b1}/approve`, { approved_by: "QA" });
    ok("re-approving an already-approved application is refused (409), not silently redone",
      reB.status === 409, `got ${reB.status}`);
    const ab2 = await row(b1);
    ok("and the approval instant did NOT move on the refused re-approve",
      String(ab2.approved_at) === String(ab.approved_at));

    section("C  deny → terminal code AND instant, together");
    const c1 = await born("Path C One");
    const rc = await request(port, "POST", `/applications/${c1}/deny`,
      { reason: "declined", note: "not qualified" });
    ok("deny returned 200", rc.status === 200, `got ${rc.status}: ${rc.raw.slice(0, 250)}`);
    const ac = await row(c1);
    ok("status is declined", ac.status === "declined");
    ok("terminal_code IS AUTHORED and equals the status", ac.terminal_code === "declined");
    ok("terminal_at IS AUTHORED — a code with no instant cannot be placed in a window",
      ac.terminal_at != null);
    ok("decision_reason and decided_at survived the cutover",
      ac.decision_reason === "not qualified" && ac.decided_at != null);
    ok("submitted_at was preserved through the terminal write", ac.submitted_at != null);
    ok("approval was NOT invented for a never-approved application", ac.approved_at === null);
    ok("the response still carries the application", !!rc.body && !!rc.body.application);

    // TERMINAL IMMUTABILITY — the defect the raw write had no guard against.
    const reC = await request(port, "POST", `/applications/${c1}/deny`, { reason: "withdrawn" });
    ok("re-denying with a DIFFERENT disposition is refused (409)",
      reC.status === 409, `got ${reC.status}: ${reC.raw.slice(0, 200)}`);
    const ac2 = await row(c1);
    ok("the original decision was NOT overwritten",
      ac2.terminal_code === "declined" && ac2.status === "declined");
    ok("and its terminal instant did not move",
      String(ac2.terminal_at) === String(ac.terminal_at));

    // An approved application that is later withdrawn KEEPS its approval.
    const c2 = await born("Path C Two");
    await request(port, "POST", `/applications/${c2}/approve`, { approved_by: "QA" });
    const approvedAt = (await row(c2)).approved_at;
    ok("seed reached approval", approvedAt != null);
    const wc = await request(port, "POST", `/applications/${c2}/deny`, { reason: "withdrawn" });
    ok("withdrawing an approved application is allowed (200)", wc.status === 200,
      `got ${wc.status}: ${wc.raw.slice(0, 200)}`);
    const ac3 = await row(c2);
    ok("status is withdrawn", ac3.status === "withdrawn");
    ok("the application RETAINS its approval instant — it DID reach approval",
      String(ac3.approved_at) === String(approvedAt));
    ok("and carries its own terminal pair",
      ac3.terminal_code === "withdrawn" && ac3.terminal_at != null);

    // ══════════════════════════════════════════════════════════════
    section("D/E  caller-side cutover (writers proven separately)");
    const read = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");
    const elS = read("src/applications/executed_lease_service.js");
    const taS = read("src/tenancy/tenancy_anchor_service.js");

    ok("D: the raw admission status write is gone",
      !/update\s+lease_applications[\s\S]{0,200}?status\s*=\s*'accepted_term_required'/i.test(elS));
    ok("D: the fabricated countersigned_at write is gone from executable code",
      !/^\s*[^/\n]*countersigned_at\s*=\s*now\(\)/m.test(elS));
    ok("D: the authority is invoked with record id AND term obligation id",
      /markTermConfirmationRequiredFromExecutedLease\(client,\s*\{[\s\S]{0,240}?executedLeaseRecordId[\s\S]{0,240}?termRequiredObligationId/.test(elS));
    // ORDERING is the substance of D's cutover: the authority verifies the
    // term_required obligation, so it must run AFTER that obligation exists.
    ok("D: the authority call is ORDERED AFTER the term_required obligation spawn",
      elS.indexOf("markTermConfirmationRequiredFromExecutedLease(client")
        > elS.indexOf("type: \"term_required\""));
    ok("D: a transition refusal is reported as a blocker, preserving the never-throw contract",
      /transition_state === "refused"[\s\S]{0,200}?blockers\.push/.test(elS));

    ok("E: the raw activation status write is gone",
      !/update\s+lease_applications[\s\S]{0,200}?status\s*=\s*'active'/i.test(taS));
    ok("E: the authority is invoked with the lease anchor AND term obligation",
      /markActiveFromConfirmedTerm\(client,\s*\{[\s\S]{0,200}?leaseId[\s\S]{0,200}?termRequiredObligationId/.test(taS));
    ok("E: the authority call is ORDERED AFTER the term obligation is completed",
      taS.indexOf("markActiveFromConfirmedTerm(client")
        > taS.indexOf("completeObligation(client, { obligation_id: termObligation.id"));

    section("F  the authority is the ONLY status writer in the codebase");
    let raw = [];
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith(".js")) raw.push(p);
      }
    };
    walk(path.join(__dirname, "..", "..", "src"));
    const offenders = raw.filter((f) => !f.endsWith("application_lifecycle.js"))
      .filter((f) => /update\s+lease_applications[\s\S]{0,220}?\bstatus\s*=/i.test(fs.readFileSync(f, "utf8")))
      .map((f) => path.relative(path.join(__dirname, ".."), f));
    ok(`no module outside the authority writes lease_applications.status (${offenders.length})`,
      offenders.length === 0, offenders.join(", "));
  } finally {
    if (prevKey !== undefined) process.env.OPERATOR_KEY = prevKey;
    await new Promise((r) => server.close(r));
    for (const t of ["obligations", "events", "lease_applications"]) {
      await pool.query(`delete from ${t} where property_id = any($1)`, [props]).catch(() => {});
    }
    for (const id of props) await pool.query("delete from properties where id=$1", [id]).catch(() => {});
    for (const id of persons) await pool.query("delete from persons where id=$1", [id]).catch(() => {});
    await pool.end().catch(() => {});
  }

  console.log(`\n════ ${pass} passed, ${fail} failed ════\n`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error("\nPROOF CRASHED:", e.stack, "\n"); process.exit(1); });
