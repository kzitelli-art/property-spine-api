#!/usr/bin/env node
/* ════════════════════════════════════════════════════════════════════
   RELEASE 0 — THE COMPOSED PATH, END TO END

   Every piece of this release has been proven separately. Separately is
   not the same as together: the writer proof stubs no reader, the reader
   proof performs no completion, the HTTP proof consumes a capture, and
   the app proof consumes a file. Each seam between them has been argued
   rather than executed.

   This runs the whole thing in one process, in order:

     W   the canonical writer completes real work orders
     F   the eight completion facts hold  (tools/step4/completion_facts.js)
     A   the cutover census and activation transaction  (Step 7)
     R   the four-state reader over REAL HTTP, all four states  (Step 8)
     S   the §4.2 defect sweep, through the governed MANUAL runner
     N   the APP'S OWN NORMALIZER over those LIVE HTTP BODIES
     P   the production-state invariants that must hold at the end

   ── NO NEW PRODUCT LOGIC ────────────────────────────────────────────

   Nothing here derives, decides or writes anything of its own. Every
   module is required from where it already lives; this file only puts
   them in a room together and reads what comes out.

   ── §N IS THE ONE THING NOTHING ELSE DOES ───────────────────────────

   The app harness reads a CAPTURE and the API proof writes one. A
   capture is a recording, and a recording goes stale. Here the live
   response body goes STRAIGHT INTO property-spine-app's real
   proof-normalizer.js, in the same process, with no artifact in
   between — so the two repos are exercised against each other rather
   than against a file they both agree to trust.

   If the app repo is not checked out, §N REFUSES. It does not skip: a
   composition proof that quietly omits the composition is worse than
   not running.

   ⚠ ISOLATED POSTGRES ONLY. Needs 137 + 138 + 139.

   usage:
     bash tools/steps23/baseline_136.sh
     PROVE_DATABASE_URL='...' node tools/steps23/apply_137.js
     STEP11_DATABASE_URL='postgresql://postgres@127.0.0.1:5433/r0scale?sslmode=disable' \
       node tools/step11/prove_release0_composed.js
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const http = require("http");
const express = require("express");
const { spawnSync } = require("child_process");
const { Pool } = require("pg");

const ROOT = path.join(__dirname, "..", "..");
const APP = path.join(ROOT, "..", "property-spine-app");
const MAINT = path.join(ROOT, "src/maintenance/maintenance.js");
const RUNNER = path.join(ROOT, "tools/run_proof_defect_sweep.js");

const lifecycle = require(path.join(ROOT, "src/technician/lifecycle_service.js"));
const activation = require(path.join(ROOT, "src/release0/activation_service.js"));
const proofState = require(path.join(ROOT, "src/release0/proof_state.js"));
const staffSessions = require(path.join(ROOT, "src/identity/staff_session_service.js"));
const FACTS = require("../step4/completion_facts.js");
const URL = process.env.STEP11_DATABASE_URL;

let pass = 0, fail = 0;
const ok = (l, c, d) => { if (c) { pass++; console.log("  ok    " + l); }
  else { fail++; console.log("  FAIL  " + l + (d ? "\n          → " + d : "")); } return c; };
const sec = (t) => console.log(`\n${"═".repeat(68)}\n  ${t}\n${"═".repeat(68)}`);

const ID = (n) => crypto.createHash("md5").update("s11:" + n).digest("hex")
  .replace(/^(.{8})(.{4})(.{4})(.{4})(.{12}).*$/, "$1-$2-$3-$4-$5");
const ORG = ID("org"), PROP = ID("prop"), OPER = ID("oper"), TECH = ID("tech");
const CUTOVER = new Date(Date.parse("2026-08-08T09:15:00.000Z"));

function serve(pool) {
  const { spawnObligationFromEvent, satisfyObligation } =
    require(path.join(ROOT, "src/shared/obligation_engine.js"));
  const { transitionObligation } = require(path.join(ROOT, "src/shared/obligation_transitions.js"));
  const { makeWorkOrderService } = require(path.join(ROOT, "src/maintenance/work_order_service.js"));
  const app = express();
  app.use(express.json());
  app.use("/", require(MAINT)({ pool, spawnObligationFromEvent,
    workOrderService: makeWorkOrderService({
      spawnObligationFromEvent, satisfyObligation, transitionObligation }) }));
  app.use("/", require(path.join(ROOT, "src/obligations/operator_obligations.js"))({ pool }));
  return new Promise((r) => {
    const s = http.createServer(app);
    s.listen(0, "127.0.0.1", () => r({ server: s, port: s.address().port }));
  });
}
const get = (port, p, session) => new Promise((res, rej) => {
  const req = http.request({ host: "127.0.0.1", port, method: "GET", path: p,
    headers: session ? { "x-staff-session": session } : {} }, (r) => {
    let raw = ""; r.on("data", (d) => { raw += d; });
    r.on("end", () => { let j = null; try { j = JSON.parse(raw); } catch (_) {}
      res({ status: r.statusCode, body: j, raw }); });
  });
  req.on("error", rej); req.end();
});

(async function main() {
  if (!URL) { console.error("REFUSED: STEP11_DATABASE_URL is not set."); process.exit(1); }
  const pool = new Pool({ connectionString: URL });
  const c = await pool.connect();
  if (Number((await c.query(
    `select count(*) n from release_0_scale_harness_guard where purpose like 'ISOLATED RELEASE 0%'`
  ).catch(() => ({ rows: [{ n: 0 }] }))).rows[0].n) !== 1) {
    console.error("REFUSED: not the isolated baseline."); process.exit(2);
  }
  if (Number((await c.query(`select count(*) n from release_0_activation_history`)).rows[0].n) > 0) {
    console.error("REFUSED: activation history is not empty — rebuild the baseline."); process.exit(3);
  }

  console.log("RELEASE 0 — THE COMPOSED PATH, END TO END\n");
  for (const m of ["138_proof_evaluation_defect_obligation.sql",
                   "139_no_longer_applicable_resolution.sql"]) {
    await c.query(fs.readFileSync(path.join(ROOT, "migrations", m), "utf8"));
  }

  await c.query(`insert into organizations (id,name) values ($1,'S11') on conflict (id) do nothing`, [ORG]);
  await c.query(`insert into properties (id,name,organization_id) values ($1,'S11 Property',$2)
                 on conflict (id) do nothing`, [PROP, ORG]);
  for (const [u, n, r] of [[OPER, "Robin Op", "property_manager"], [TECH, "Sam Tech", "maintenance"]]) {
    // eslint-disable-next-line no-await-in-loop
    await c.query(`insert into users (id,name,phone,role,is_active,status)
                   values ($1,$2,$3,$4,true,'active') on conflict (id) do nothing`,
                  [u, n, "+1541555" + u.slice(0, 4).replace(/\D/g, "0").padEnd(4, "0"), r]);
    // eslint-disable-next-line no-await-in-loop
    await c.query(`insert into property_team_assignments
                     (user_id,property_id,role_title,allowed_modules,active)
                   values ($1,$2,$3,array['maintenance'],true)`, [u, PROP, n]);
  }
  const SESSION = (await staffSessions.issueStaffSession(pool, {
    userId: OPER, propertyId: PROP, purpose: "bootstrap_invite" })).session_token;

  let seq = 0;
  const mkWo = async (status = "open") => {
    const wo = ID("wo" + (++seq));
    await c.query(`insert into work_orders (id,property_id,title,status,source)
                   values ($1,$2,'s11',$3,'s11')`, [wo, PROP, status]);
    await c.query(`insert into obligations (property_id,related_id,related_type,module,type,label,status)
                   values ($1,$2,'work_order','maintenance','work_order_routing','r','open')`, [PROP, wo]);
    return wo;
  };
  const photo = async (wo) => {
    const a = ID("att" + wo.slice(0, 8)), b = Buffer.from([1, 2, 3, 4, 5]);
    await c.query(`insert into work_order_proof_attachments
      (id,work_order_id,property_id,uploaded_by_user_id,provider,provider_media_id,mime_type,
       storage_state,proof_classification,content,byte_size,sha256,stored_at)
      values ($1,$2,$3,$4,'twilio',$5,'image/jpeg','stored','repair_photo',$6,$7,$8,now())`,
      [a, wo, PROP, TECH, "ME" + a.slice(0, 8), b, b.length,
       crypto.createHash("sha256").update(b).digest("hex")]);
  };
  const complete = async (wo, key) => {
    await c.query("begin");
    const out = await lifecycle.claimCompletion(c, {
      work_order_id: wo, user_id: TECH, organization_id: ORG, idempotency_key: key });
    await c.query("commit");
    return out;
  };

  // ══ W · THE WRITER ═════════════════════════════════════════════════
  sec("W · THE CANONICAL WRITER COMPLETES REAL WORK");
  const woLegacy = await mkWo("closed");              // pre-cutover → legacy
  const woSat = await mkWo("open");
  await photo(woSat);
  const done = await complete(woSat, "s11-sat");
  ok("W1  claimCompletion closed it", done.closed === true, JSON.stringify(done.outcome));
  const woNot = await mkWo("open");                   // claimed, no evidence
  const blocked = await complete(woNot, "s11-not");
  ok("W2  …and REFUSED to close one with no preserved evidence",
     blocked.closed === false && blocked.missing === "repair_photo",
     JSON.stringify({ closed: blocked.closed, missing: blocked.missing }));

  // ══ F · THE EIGHT FACTS ════════════════════════════════════════════
  sec("F · THE EIGHT COMPLETION FACTS (§4), REUSED NOT RESTATED");
  {
    const r = await FACTS.checkCompletionFacts(c, {
      work_order_id: woSat, property_id: PROP, actor_user_id: TECH });
    for (const f of r.facts) ok(`F·${f.id.padEnd(4)} ${f.name}`, f.held, f.detail);
    const n = await FACTS.checkNoParallelWriter(c, { work_order_id: woSat, property_id: PROP });
    for (const f of n.facts) ok(`F·${f.id.padEnd(4)} ${f.name}`, f.held, f.detail);
  }

  // ══ A · ACTIVATION ═════════════════════════════════════════════════
  sec("A · THE CENSUS AND THE ACTIVATION TRANSACTION (STEP 7)");
  {
    const census = await activation.readLegacyTerminalSet(c);
    ok("A1  the census found the pre-cutover terminal row",
       census.some((r) => String(r.work_order_id) === String(woLegacy)),
       JSON.stringify(census.map((r) => r.work_order_id)));
    ok("A2  …and did NOT include the one the writer completed",
       !census.some((r) => String(r.work_order_id) === String(woSat)),
       "a governed completion has an evaluation, so it is not legacy");
    await c.query("begin");
    const act = await activation.recordActivation(c, {
      activated_at: CUTOVER, captured_by: "composed proof", expected: census });
    await c.query("commit");
    ok("A3  the activation transaction accepted the exact set", !!act,
       "the both-direction comparison refused");
    ok("A4  …and the inventory holds exactly the census",
       Number((await c.query(
         `select count(*) n from release_0_legacy_cutover_inventory`)).rows[0].n) === census.length);
  }
  const woDefect = await mkWo("closed");   // post-cutover → a real defect

  /*  The census for P6, taken BEFORE any read happens. An earlier version
   *  of P6 compared the same query to itself and was therefore incapable
   *  of failing — the exact shape of decoration this release keeps
   *  rejecting elsewhere. */
  const readCensus = async () => ({
    progress: Number((await c.query(
      `select count(*) n from work_order_progress where property_id=$1`, [PROP])).rows[0].n),
    evaluations: Number((await c.query(
      `select count(*) n from work_order_proof_evaluations where property_id=$1`, [PROP])).rows[0].n),
    events: Number((await c.query(
      `select count(*) n from events where property_id=$1`, [PROP])).rows[0].n),
    workOrders: (await c.query(
      `select id, status from work_orders where property_id=$1 order by id`, [PROP])).rows,
  });
  const beforeReads = await readCensus();

  const { server, port } = await serve(pool);
  const detail = (wo) => get(port, `/operator/work-orders/${wo}/status`, SESSION);
  const list = () => get(port, "/operator/work-orders/status", SESSION);

  // ══ R · THE READER OVER REAL HTTP ══════════════════════════════════
  sec("R · THE FOUR-STATE READER, OVER A REAL SOCKET");
  const CASES = [[woSat, "satisfied"], [woNot, "not_satisfied"],
                 [woLegacy, "legacy_indeterminate"], [woDefect, "missing_evaluation_defect"]];
  const bodies = {};
  for (const [wo, state] of CASES) {
    // eslint-disable-next-line no-await-in-loop
    const d = await detail(wo);
    bodies[state] = d;
    ok(`R·${state.padEnd(26)} over HTTP`,
       d.status === 200 && d.body.proof.read_status === "ok" && d.body.proof.state === state,
       "status " + d.status + " :: " + JSON.stringify(d.body && d.body.proof && d.body.proof.state));
  }
  {
    const l = await list();
    const seen = new Set(l.body.work_orders.map((w) => w.proof.state));
    ok("R5  every one of the four appears on the list too, so R is not vacuous",
       proofState.PROOF_STATES.every((s) => seen.has(s)), [...seen].join(","));
    const disagree = [];
    for (const row of l.body.work_orders) {
      // eslint-disable-next-line no-await-in-loop
      const d = (await detail(row.work_order.id)).body;
      if (row.proof.state !== d.proof.state) disagree.push(row.work_order.id);
    }
    ok("R6  and the list and the detail agree on every row", disagree.length === 0,
       disagree.join(","));
    bodies.__list = l;
  }

  // ══ S · THE SWEEP, THROUGH THE GOVERNED MANUAL RUNNER ══════════════
  sec("S · THE §4.2 SWEEP — A COMMAND A HUMAN TYPES, NOT A SCHEDULER");
  {
    const openDefects = async () => Number((await c.query(
      `select count(*) n from obligations
        where type='proof_evaluation_missing' and status <> 'complete'`)).rows[0].n);
    const dry = spawnSync(process.execPath, [RUNNER],
      { encoding: "utf8", env: { ...process.env, DATABASE_URL: URL } });
    ok("S1  a bare run is a DRY RUN and writes nothing",
       dry.status === 0 && await openDefects() === 0, "exit " + dry.status);
    const live = spawnSync(process.execPath, [RUNNER, "--raise", "--property", PROP],
      { encoding: "utf8", env: { ...process.env, DATABASE_URL: URL } });
    ok("S2  --raise raises exactly one, for the post-cutover row",
       live.status === 0 && await openDefects() === 1, "exit " + live.status);
    const held = (await c.query(
      `select related_id, assigned_user_id, assigned_role from obligations
        where type='proof_evaluation_missing'`)).rows[0];
    ok("S3  …against the work order the READER called a defect",
       String(held.related_id) === String(woDefect), JSON.stringify(held.related_id));
    ok("S4  …UNASSIGNED, with the role §4.2 froze",
       held.assigned_user_id === null && held.assigned_role === "property_manager",
       JSON.stringify(held));
    ok("S5  …and NOT against the inventoried legacy row",
       String(held.related_id) !== String(woLegacy),
       "legitimate legacy history was accused of a writer defect");
  }

  // ══ N · THE APP'S OWN NORMALIZER, OVER THE LIVE BODIES ═════════════
  sec("N · THE APP'S REAL NORMALIZER, OVER THESE LIVE HTTP RESPONSES");
  {
    const NORM = path.join(APP, "proof-normalizer.js");
    if (!fs.existsSync(NORM)) {
      //  REFUSE, never skip. A composition proof that omits the
      //  composition is worse than one that did not run.
      ok("N0  the app repo is checked out so the two can be composed", false,
         "property-spine-app is absent — §N is the only place the two repos meet " +
         "without a capture between them, and it did not run");
    } else {
      // eslint-disable-next-line global-require, import/no-dynamic-require
      const P = require(NORM);
      ok("N0  the app's real normalizer loaded from the app repo",
         typeof P.normalize === "function");
      const quiet = (fn) => { const e = console.error; console.error = () => {};
        try { return fn(); } finally { console.error = e; } };

      for (const [, state] of CASES) {
        const proof = bodies[state].body.proof;
        const r = quiet(() => P.normalize(proof));
        ok(`N·${state.padEnd(26)} the app reads the LIVE body cleanly`,
           r.status === "ok" && r.state === state,
           "status=" + r.status + " reason=" + r.reasonCode + " state=" + r.state +
           " over " + JSON.stringify(proof));
      }
      //  The list projection is narrower. It must survive too, or the
      //  BOARD renders unavailable while the detail page is fine.
      for (const row of bodies.__list.body.work_orders) {
        const r = quiet(() => P.normalize(row.proof));
        ok(`N·list ${String(row.proof.state).padEnd(26)} the board reads it too`,
           r.status === "ok", "status=" + r.status + " reason=" + r.reasonCode);
      }
      //  THE POINT OF THE RELEASE, composed: two rows that are identical
      //  on every compatibility signal, rendered as different things.
      const leg = quiet(() => P.normalize(bodies.legacy_indeterminate.body.proof));
      const def = quiet(() => P.normalize(bodies.missing_evaluation_defect.body.proof));
      ok("N5  legacy and defect reach the app as DIFFERENT renderings",
         leg.renders !== def.renders && leg.label !== def.label,
         JSON.stringify({ leg: leg.renders, def: def.renders }));
      ok("N6  …and only the defect is flagged as an engineering fault",
         def.isDefect === true && leg.isDefect === false);
      ok("N7  …neither collapsed into 'proof failed'",
         leg.renders !== "not_satisfied" && def.renders !== "not_satisfied");
      console.log("        legacy → " + leg.label);
      console.log("        defect → " + def.label);
    }
  }

  // ══ P · THE INVARIANTS THAT MUST HOLD AT THE END ═══════════════════
  sec("P · PRODUCTION-STATE INVARIANTS");
  {
    const one = async (s, v) => Number((await c.query(s, v)).rows[0].n);
    ok("P1  exactly one activation, ever",
       await one(`select count(*) n from release_0_activation_history`) === 1);
    ok("P2  every completed work order has an evaluation head",
       await one(`select count(*) n from work_orders w
                   where w.property_id=$1 and w.status='complete'
                     and not exists (select 1 from work_order_proof_evaluation_head h
                                      where h.work_order_id=w.id)`, [PROP]) === 0,
       "a completed work order with nothing behind it — the state this release exists to end");
    ok("P3  no evaluation cites an attachment that is not preserved",
       await one(`select count(*) n from work_order_proof_evaluation_attachments l
                   join work_order_proof_attachments a on a.id=l.attachment_id
                  where a.storage_state <> 'stored'`) === 0);
    ok("P4  no work order is both inventoried as legacy AND evaluated",
       await one(`select count(*) n from release_0_legacy_cutover_inventory i
                   join work_order_proof_evaluations e on e.work_order_id=i.work_order_id`) === 0,
       "a row cannot be legitimate legacy history and have a governed evaluation");
    ok("P5  every open defect obligation names an uninventoried terminal row",
       await one(`select count(*) n from obligations o
                   join work_orders w on w.id=o.related_id
                  where o.type='proof_evaluation_missing' and o.status <> 'complete'
                    and (w.status not in ('complete','closed')
                         or exists (select 1 from release_0_legacy_cutover_inventory i
                                     where i.work_order_id=w.id))`) === 0,
       "an obligation is an accountability fact about a human — one against " +
       "legitimate history or open work is an accusation nobody earned");
    /*  Everything after `beforeReads` was HTTP reads plus one sweep. The
     *  sweep raises an OBLIGATION and writes its event, and nothing else
     *  in this release may have moved. Measured, not asserted. */
    const afterReads = await readCensus();
    ok("P6  no read route touched a progress row",
       afterReads.progress === beforeReads.progress,
       `${beforeReads.progress} → ${afterReads.progress}`);
    ok("P7  …nor created a proof evaluation",
       afterReads.evaluations === beforeReads.evaluations,
       `${beforeReads.evaluations} → ${afterReads.evaluations}`);
    ok("P8  …nor changed any work order's status",
       JSON.stringify(afterReads.workOrders) === JSON.stringify(beforeReads.workOrders),
       JSON.stringify({ before: beforeReads.workOrders, after: afterReads.workOrders }));
    ok("P9  the only new events are the sweep's, and it wrote exactly one",
       afterReads.events - beforeReads.events === 1,
       `${beforeReads.events} → ${afterReads.events} — the sweep raises one obligation ` +
       "and records WHY; anything else moved that should not have");
  }

  sec("VERDICT");
  console.log(`  passed ${pass}   failed ${fail}`);
  server.close();
  c.release();
  await pool.end();
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error("\nERROR:\n" + (e && e.stack || e)); process.exit(1); });
