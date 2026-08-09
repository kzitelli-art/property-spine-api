#!/usr/bin/env node
/* ════════════════════════════════════════════════════════════════════
   THE RELEASE TRAIN — the exact production sequence, in order, once

   Every Release 0 candidate is green alone. This runs them AS A TRAIN, on
   ONE clean database, in the order the runbook deploys them, with the
   real modules and no simulated substitute paths.

     B3   Step 3 · the canonical writer is live
     B5   Step 4 · a real governed completion (the handset fixture)
     B6   Step 5 · the app's completion control is gone
     B7   Step 6 · the legacy done-path fails closed, over REAL HTTP
     B7b  migration 140 · the containment guard, applied and INERT
     B8   Step 7 · census, inventory, activation      ⚠ IRREVERSIBLE
     B9   Step 8 · the four-state reader
     B10  migrations 138+139 · the defect rail
     B11  HTTP acceptance · the contract as a consumer receives it
     B12  the app's own normalizer, over live bodies
     B13  cleanup · `satisfied` leaves the wire

   ── THE THING IT IS ACTUALLY LOOKING FOR ────────────────────────────

   Not "is each step green". After EVERY boundary it runs the same three
   questions and requires the same answer:

       the DATABASE invariant audit
       the CANONICAL READER, row by row
       the OPERATOR-visible status

   If those ever disagree, the release has produced TWO MEANINGS OF TRUTH,
   and that matters more than any individual service being green. A
   boundary that leaves them disagreeing is a boundary that must not ship,
   even if every assertion inside it passed.

   ⚠ ISOLATED POSTGRES ONLY. Ledger 137, virgin activation history.
   ⚠ #57 MUST BE IN THE TREE. A train missing Step 6 rehearses a
     different release; the run refuses rather than proving the wrong
     sequence beautifully.

   usage:
     TRAIN_DATABASE_URL='…' node tools/step13/rehearse_release_train.js
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const http = require("http");
const express = require("express");
const { Pool } = require("pg");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..", "..");
const APP = path.join(ROOT, "..", "property-spine-app");
const MAINT = path.join(ROOT, "src/maintenance/maintenance.js");

const lifecycle = require(path.join(ROOT, "src/technician/lifecycle_service.js"));
const activation = require(path.join(ROOT, "src/release0/activation_service.js"));
const reader = require(path.join(ROOT, "src/surfaces/work_order_status_read.js"));
const proofState = require(path.join(ROOT, "src/release0/proof_state.js"));
const staffSessions = require(path.join(ROOT, "src/identity/staff_session_service.js"));
const FACTS = require("../step4/completion_facts.js");
const guardWindow = require("../step12/guard_window.js");
const grounded = require("../step12/grounded_evaluation.js");
const URL = process.env.TRAIN_DATABASE_URL;

let pass = 0, fail = 0;
const boundaries = [];
const ok = (l, c, d) => { if (c) { pass++; console.log("  ok    " + l); }
  else { fail++; console.log("  FAIL  " + l + (d ? "\n          → " + d : "")); } return c; };
const sec = (t) => console.log(`\n${"═".repeat(72)}\n  ${t}\n${"═".repeat(72)}`);

const ID = (n) => crypto.createHash("md5").update("train:" + n).digest("hex")
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
  return new Promise((r) => {
    const s = http.createServer(app);
    s.listen(0, "127.0.0.1", () => r({ server: s, port: s.address().port }));
  });
}
const req = (port, method, p, { session, body } = {}) => new Promise((res, rej) => {
  const payload = body ? JSON.stringify(body) : null;
  const r = http.request({ host: "127.0.0.1", port, method, path: p, headers: Object.assign(
    session ? { "x-staff-session": session } : {},
    payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {}) },
    (x) => { let raw = ""; x.on("data", (d) => { raw += d; });
      x.on("end", () => { let j = null; try { j = JSON.parse(raw); } catch (_) {}
        res({ status: x.statusCode, body: j, raw }); }); });
  r.on("error", rej); if (payload) r.write(payload); r.end();
});

(async function main() {
  if (!URL) { console.error("REFUSED: TRAIN_DATABASE_URL is not set."); process.exit(1); }

  /*  ── THE TREE MUST BE THE ONE WE SHIP ─────────────────────────────
   *  #57 was cut from main in parallel with the API stack and the stack
   *  never picked it up. A rehearsal without Step 6 would prove a
   *  different release, beautifully. */
  const maintSrc = fs.readFileSync(MAINT, "utf8");
  const iRefusal = maintSrc.indexOf("legacy_completion_retired");
  const iWrite = maintSrc.search(/update\s+work_orders[\s\S]{0,120}?status\s*=\s*'closed'/i);
  if (!(iRefusal >= 0 && (iWrite < 0 || iRefusal < iWrite))) {
    console.error("REFUSED: Step 6 (#57) is not in this tree — maintenance.js has no");
    console.error("         `legacy_completion_retired` refusal ahead of its closing UPDATE.");
    console.error("         Rehearsing without it rehearses a different release sequence.");
    process.exit(4);
  }

  const pool = new Pool({ connectionString: URL });
  const c = await pool.connect();
  if (Number((await c.query(
    `select count(*) n from release_0_scale_harness_guard where purpose like 'ISOLATED RELEASE 0%'`
  ).catch(() => ({ rows: [{ n: 0 }] }))).rows[0].n) !== 1) {
    console.error("REFUSED: not the isolated baseline."); process.exit(2);
  }
  if (Number((await c.query(`select count(*) n from release_0_activation_history`)).rows[0].n) > 0) {
    console.error("REFUSED: activation history is not empty. Rebuild the baseline."); process.exit(3);
  }

  console.log("RELEASE 0 — THE TRAIN, IN PRODUCTION ORDER\n");
  console.log("  Step 6 (#57) present in the tree — rehearsing the real sequence.\n");

  await c.query(`insert into organizations (id,name) values ($1,'TR8') on conflict (id) do nothing`, [ORG]);
  await c.query(`insert into properties (id,name,organization_id) values ($1,'Train Property',$2)
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
                   values ($1,$2,'train',$3,'trainproof')`, [wo, PROP, status]);
    await c.query(`insert into obligations (property_id,related_id,related_type,module,type,label,status)
                   values ($1,$2,'work_order','maintenance','work_order_routing','r','open')`, [PROP, wo]);
    return wo;
  };
  /*  ── THE LEDGER IS PART OF THE BOUNDARY ───────────────────────────
   *
   *  The train applies migration DDL directly rather than through
   *  `migrate.js`, because the runner applies every pending file in the
   *  tree and this rehearsal deliberately splits 140 (before the
   *  activation) from 138/139 (after it). But a production migration
   *  release also WRITES THE LEDGER, and leaving that out produced a
   *  rehearsed database that the acceptance receipt correctly called a
   *  contradiction: DDL present, ledger silent — which in production means
   *  someone applied schema by hand and the next deploy will refuse to
   *  boot. The rehearsal has to leave behind the state production leaves
   *  behind, or the receipt is describing a database that will never exist.
   *
   *  `prove_migration_sequencing.js` covers what the runner itself does. */
  const recordLedger = (version, name) => c.query(
    `insert into schema_migrations (version, name) values ($1, $2)
     on conflict (version) do nothing`, [version, name]);

  const completeGoverned = async (wo, key) => {
    await grounded.preserveQualifyingEvidence(c,
      { work_order_id: wo, property_id: PROP, uploaded_by_user_id: TECH, seed: key });
    await c.query("begin");
    const out = await lifecycle.claimCompletion(c, {
      work_order_id: wo, user_id: TECH, organization_id: ORG, idempotency_key: key });
    await c.query("commit");
    return out;
  };

  /*  ── ONE MEANING OF TRUTH — run after EVERY boundary ──────────────
   *
   *  The database's own invariant audit, the canonical reader, and the
   *  status an operator would see, compared row by row. Two meanings of
   *  truth is the failure that matters more than any service being green,
   *  so it is checked at every step rather than once at the end.
   *
   *  Before activation the reader reports `unavailable` and the audit view
   *  is empty by construction — that agreement is real and is asserted as
   *  such, not skipped.  */
  const oneTruth = async (label) => {
    const rows = (await c.query(
      `select id, property_id, status from work_orders where source='trainproof'`)).rows;
    const viewRows = (await c.query(
      `select work_order_id from release_0_completion_invariant_violations`)
      .catch(() => ({ rows: null }))).rows;
    const activated = Number((await c.query(
      `select count(*) n from release_0_activation_history`)).rows[0].n) > 0;

    const readerSays = {};
    for (const r of rows) {
      // eslint-disable-next-line no-await-in-loop
      const s = await reader.readWorkOrderStatus(c,
        { propertyId: r.property_id, workOrderId: r.id });
      readerSays[r.id] = s.proof.read_status === "ok" ? s.proof.state : s.proof.read_status;
    }
    const readerBad = Object.entries(readerSays)
      .filter(([, v]) => v === "missing_evaluation_defect").map(([k]) => k);

    if (!activated) {
      ok(`§T  ${label}: no activation — the reader says \`unavailable\` for EVERY row`,
         rows.length === 0 || Object.values(readerSays).every((v) => v === "unavailable"),
         JSON.stringify(readerSays) +
         " — before the cutover a proof verdict is not derivable, and claiming one " +
         "would be the second meaning of truth arriving early");
      return;
    }
    ok(`§T  ${label}: the DB audit and the canonical reader name the same rows`,
       viewRows !== null &&
       JSON.stringify(viewRows.map((v) => v.work_order_id).sort()) ===
       JSON.stringify(readerBad.sort()),
       `audit ${JSON.stringify((viewRows || []).map((v) => v.work_order_id))} vs reader ` +
       JSON.stringify(readerBad) +
       " — TWO MEANINGS OF TRUTH. The database and the surface disagree about which " +
       "work orders are wrong, which is worse than either being wrong alone.");
    /*  …and the operator-visible status agrees with the row.
     *
     *  TERMINAL, not `complete`. A first version tested `status ===
     *  'complete'` and reported the inventoried legacy `closed` row as a
     *  mismatch — the harness conflating "the canonical completion status"
     *  with "terminal", which is precisely the distinction Release 0 spent
     *  the day drawing. `closed` is terminal AND historical; both are true.
     *
     *  The predicate uses the READER'S OWN isTerminal so the train cannot
     *  disagree with the thing it is auditing. */
    const TERMINAL_VERDICTS = ["satisfied", "not_satisfied",
                               "legacy_indeterminate", "missing_evaluation_defect"];
    const mismatched = rows.filter((r) => {
      const isTerm = proofState.isTerminal({ status: r.status });
      const hasVerdict = TERMINAL_VERDICTS.includes(readerSays[r.id]);
      //  A non-terminal row may still carry a verdict (the reader derives
      //  one from current evidence); what must never happen is a TERMINAL
      //  row with no verdict at all.
      return isTerm && !hasVerdict;
    });
    ok(`§T  ${label}: every terminal row carries one of the four proof verdicts`,
       mismatched.length === 0,
       JSON.stringify(mismatched.map((r) => ({ id: r.id, st: r.status, p: readerSays[r.id] }))));
    boundaries.push({ label, rows: rows.length, violations: (viewRows || []).length });
  };

  // ══ B3 · STEP 3 — THE CANONICAL WRITER ═════════════════════════════
  sec("B3 · STEP 3 — the canonical writer is live");
  {
    const life = fs.readFileSync(path.join(ROOT, "src/technician/lifecycle_service.js"), "utf8");
    ok("B3.1 claimCompletion records a proof evaluation", /recordEvaluation\(/.test(life));
    const wo = await mkWo("open");
    const out = await completeGoverned(wo, "b3");
    ok("B3.2 …and it completes real work", out.closed === true, JSON.stringify(out.outcome));
    await oneTruth("after B3");
  }

  // ══ B5 · STEP 4 — THE EIGHT FACTS OVER A REAL COMPLETION ═══════════
  sec("B5 · STEP 4 — the eight completion facts over a governed completion");
  {
    const wo = await mkWo("open");
    await completeGoverned(wo, "b5");
    const f = await FACTS.checkCompletionFacts(c,
      { work_order_id: wo, property_id: PROP, actor_user_id: TECH });
    ok("B5.1 every named completion fact holds", f.allHeld,
       "red: " + f.facts.filter((x) => !x.held).map((x) => x.id).join(","));
    const n = await FACTS.checkNoParallelWriter(c, { work_order_id: wo, property_id: PROP });
    ok("B5.2 …and no parallel writer touched it", n.facts.every((x) => x.held),
       JSON.stringify(n.facts.filter((x) => !x.held).map((x) => x.id)));
    await oneTruth("after B5");
  }

  // ══ B6 · STEP 5 — THE APP'S COMPLETION CONTROL IS GONE ═════════════
  sec("B6 · STEP 5 — the app cannot complete a work order");
  {
    /*  ⚠ RUN THE APP'S OWN PROOF, do not re-derive it here.
     *
     *  A first version grepped work-lifecycle-door.js for `done: true` and
     *  for the word "closeout". The door is a RENDERING file — the closeout
     *  control lives elsewhere — so the absence check passed for the wrong
     *  reason and the paired presence check failed for the wrong reason.
     *  A second implementation of somebody else's contract is exactly the
     *  drift this release keeps refusing.
     *
     *  `no_operator_completion_proof.test.js` is the app's own governed
     *  proof: it asserts the ABSENCE of every completion control and pairs
     *  each one with the PRESENCE of the not-done path, because a file that
     *  lost both would pass an absence-only check while being far more
     *  broken. The train runs it and inherits its verdict. */
    const proofPath = path.join(APP, "no_operator_completion_proof.test.js");
    ok("B6.0 the app repo and its Step 5 proof are present — REFUSED, not skipped",
       fs.existsSync(proofPath), proofPath +
       " — a train that silently omits the app half is not rehearsing the release");
    if (fs.existsSync(proofPath)) {
      const r = spawnSync(process.execPath, [proofPath], { encoding: "utf8", cwd: APP });
      const line = (r.stdout || "").trim().split("\n").pop();
      ok("B6.1 the app's own no-operator-completion proof passes",
         r.status === 0, `exit ${r.status} :: ${line}`);
      console.log("        " + line.trim());
    }
    await oneTruth("after B6");
  }

  // ══ B7 · STEP 6 — THE LEGACY DONE-PATH, OVER REAL HTTP ═════════════
  sec("B7 · STEP 6 — the legacy done-path fails closed, over a real socket");
  const { server, port } = await serve(pool);
  {
    const victim = await mkWo("open");
    const r = await req(port, "PATCH", `/work-orders/${victim}/closeout`,
      { session: SESSION, body: { done: true, completion_photo: "stub://x", completion_note: "done" } });
    ok("B7.1 the legacy done path answers 409, not 200",
       r.status === 409, `${r.status} ${JSON.stringify(r.body).slice(0, 160)}`);
    ok("B7.2 …naming the canonical path",
       r.body && /claimCompletion/.test(JSON.stringify(r.body)),
       JSON.stringify(r.body));
    ok("B7.3 …and it WROTE NOTHING",
       (await c.query(`select status from work_orders where id=$1`, [victim])).rows[0].status === "open");
    //  The paired control: not-done still works, so this is a governed
    //  refusal of one verb rather than a broken route.
    const nd = await req(port, "PATCH", `/work-orders/${victim}/closeout`,
      { session: SESSION, body: { done: false, reason: "no_access" } });
    ok("B7.4 …while the NOT-DONE path on the same route still succeeds",
       nd.status >= 200 && nd.status < 300, `${nd.status} ${JSON.stringify(nd.body).slice(0, 140)}`);
    await oneTruth("after B7");
    console.log("        ⏱  THE ACTIVATION INSTANT IS CAPTURED HERE AND ONLY HERE (§5.4)");
  }

  // ══ B7b · MIGRATION 140 — APPLIED, AND INERT ═══════════════════════
  sec("B7b · MIGRATION 140 — the containment guard, applied BEFORE the activation");
  {
    await guardWindow.installGuard(c);
    await recordLedger("140", "140_post_activation_completion_guard.sql");
    //  The count comes from the list the window actually drops, not from
    //  a number typed into a label. The old text said "five" three
    //  revisions after the migration had grown to seven.
    ok(`B7b.1 all ${guardWindow.TRIGGERS.length} guard triggers are installed`,
       await guardWindow.guardInstalled(c));
    const wo = await mkWo("open");
    const out = await completeGoverned(wo, "b7b");
    ok("B7b.2 …and it is INERT: the canonical writer is unaffected",
       out.closed === true, JSON.stringify(out.outcome));
    const epoch = (await c.query(`select activation_id from release_0_activation_epoch`)).rows[0];
    ok("B7b.3 the epoch row exists and is UNSTAMPED — the boundary has not moved",
       epoch && epoch.activation_id === null, JSON.stringify(epoch));
    await oneTruth("after B7b");
  }

  // ══ B8 · STEP 7 — THE IRREVERSIBLE BOUNDARY ════════════════════════
  sec("B8 · STEP 7 — census, inventory, activation   ⚠ IRREVERSIBLE");
  let CENSUS = null;
  {
    //  One pre-cutover legacy row so the inventory is real, created the
    //  only way it now can be: through a window, because after B7 the
    //  legacy writer cannot make one and the guard is installed.
    const legacy = await guardWindow.withGuardOff(c,
      "the train needs one pre-cutover legacy row; Step 6 has already closed the " +
      "path that used to create them, which is the point of running B7 first",
      async () => { const w = await mkWo("closed"); return w; });

    CENSUS = await activation.readLegacyTerminalSet(c);
    ok("B8.1 the census finds exactly the pre-cutover terminal rows",
       CENSUS.length === 1 && CENSUS[0].work_order_id === legacy,
       JSON.stringify(CENSUS.map((r) => r.work_order_id)));
    await c.query("begin");
    const act = await activation.recordActivation(c, {
      activated_at: CUTOVER, captured_by: "release train", expected: CENSUS });
    await c.query("commit");
    ok("B8.2 the activation committed", !!act);
    const epoch = (await c.query(`select activation_id from release_0_activation_epoch`)).rows[0];
    //  `recordActivation` returns { activation, inventory, comparison } —
    //  the row is on `.activation`, not the envelope. Reading `.id` off the
    //  envelope gave undefined and the comparison failed for a reason that
    //  had nothing to do with the epoch.
    ok("B8.3 …and the epoch moved with it, in the same transaction",
       !!act.activation &&
       String(epoch.activation_id) === String(act.activation.id),
       JSON.stringify({ epoch: epoch.activation_id, activation: act.activation && act.activation.id }));
    ok("B8.4 the inventory holds exactly the census",
       Number((await c.query(
         `select count(*) n from release_0_legacy_cutover_inventory`)).rows[0].n) === CENSUS.length);
    await oneTruth("after B8 — the guard is now ARMED");
  }

  // ══ B9 · STEP 8 — THE FOUR-STATE READER ════════════════════════════
  sec("B9 · STEP 8 — the four-state reader, over the post-cutover population");
  {
    const list = await reader.readPropertyWorkOrderStatuses(c, { propertyId: PROP, limit: 100 });
    ok("B9.1 every row now carries a real proof verdict, not `unavailable`",
       list.every((r) => r.proof.read_status === "ok"),
       JSON.stringify(list.filter((r) => r.proof.read_status !== "ok").map((r) => r.proof)));
    ok("B9.2 …drawn from the four states and nothing else",
       list.every((r) => proofState.PROOF_STATES.includes(r.proof.state)),
       JSON.stringify([...new Set(list.map((r) => r.proof.state))]));
    ok("B9.3 the inventoried legacy row reads legacy_indeterminate, not a defect",
       list.some((r) => r.proof.state === "legacy_indeterminate"),
       JSON.stringify(list.map((r) => r.proof.state)));
    await oneTruth("after B9");
  }

  // ══ B10 · MIGRATIONS 138+139 AND THE DEFECT RAIL ═══════════════════
  sec("B10 · migrations 138 + 139 — the §4.2 defect rail");
  {
    for (const m of ["138_proof_evaluation_defect_obligation.sql",
                     "139_no_longer_applicable_resolution.sql"]) {
      // eslint-disable-next-line no-await-in-loop
      await c.query(fs.readFileSync(path.join(ROOT, "migrations", m), "utf8"));
      // eslint-disable-next-line no-await-in-loop
      await recordLedger(m.slice(0, 3), m);
    }
    const sweep = require(path.join(ROOT, "src/maintenance/proof_defect_sweep.js"));
    const clean = await sweep.runProofDefectSweep(pool, { dryRun: true });
    ok("B10.1 a dry sweep over a correctly-composed train finds NOTHING to raise",
       clean.confirmed === 0, JSON.stringify(clean) +
       " — after a clean train the defect population is empty, and a non-empty one " +
       "would mean a boundary produced a state the guard should have refused");
    await oneTruth("after B10");
  }

  // ══ B11 · HTTP ACCEPTANCE ══════════════════════════════════════════
  sec("B11 · the contract as a consumer receives it, over the socket");
  let LIVE_BODY = null;
  {
    /*  OVER THE SOCKET B7 ALREADY OPENED. A first version required a
     *  `work_order_status_routes.js` that does not exist — the status
     *  route lives on the maintenance router, which is already mounted and
     *  already serving. Standing up a second server to reach the same
     *  handler would have been a proof about the second server. */
    const row = (await c.query(
      `select id from work_orders where source='trainproof' and status='complete' limit 1`)).rows[0];
    const r = await req(port, "GET", `/operator/work-orders/${row.id}/status`,
      { session: SESSION });
    ok("B11.0 the status route answers over a real socket, authenticated",
       r.status === 200, `${r.status} ${JSON.stringify(r.body).slice(0, 160)}`);
    LIVE_BODY = r.body;
    ok("B11.1 a completed row carries state=satisfied",
       r.body && r.body.proof && r.body.proof.state === "satisfied",
       JSON.stringify(r.body && r.body.proof));
    ok("B11.2 …and `satisfied` is NOT on the wire (the cleanup release)",
       r.body && r.body.proof && !("satisfied" in r.body.proof),
       JSON.stringify(Object.keys((r.body && r.body.proof) || {})));
    ok("B11.3 …and next_action derives from `state`, not from a retired boolean",
       r.body && r.body.next_action === null, JSON.stringify(r.body && r.body.next_action));

    //  ANONYMOUS is refused: the surface is server-derived authority (§21).
    const anon = await req(port, "GET", `/operator/work-orders/${row.id}/status`, {});
    ok("B11.4 …and the same route refuses an unauthenticated read",
       anon.status === 401 || anon.status === 403, String(anon.status));
    await oneTruth("after B11");
  }

  // ══ B12 · THE APP'S OWN NORMALIZER, OVER A LIVE BODY ═══════════════
  sec("B12 · the app's normalizer, over a body this run produced");
  {
    /*  THE APP'S REAL NORMALIZER, over a body THIS RUN produced over a
     *  real socket — no capture file between the two repos.
     *
     *  A first version guessed the export shape (`normalizeProof || default
     *  || module`) and called whatever came back. The module exports
     *  `normalize`, so the guess returned the module object, calling it
     *  produced null, and B12 reported a contract failure that did not
     *  exist. Guessing another team's interface is the same class of
     *  mistake as restating their predicate. */
    const normPath = path.join(APP, "proof-normalizer.js");
    ok("B12.0 the app's normalizer is present — REFUSED rather than skipped",
       fs.existsSync(normPath), normPath +
       " — this is the only place the two repos meet with no artifact between them");
    if (fs.existsSync(normPath)) {
      // eslint-disable-next-line global-require, import/no-dynamic-require
      const P = require(normPath);
      ok("B12.0a …and it exports the interface the app actually uses",
         typeof P.normalize === "function", JSON.stringify(Object.keys(P)));
      const quiet = (fn) => { const e = console.error; console.error = () => {};
        try { return fn(); } finally { console.error = e; } };

      const out = quiet(() => P.normalize(LIVE_BODY.proof));
      ok("B12.1 the app reads a LIVE body cleanly — no contract failure",
         out && out.status === "ok",
         "status=" + (out && out.status) + " reason=" + (out && out.reasonCode));
      ok("B12.2 …and renders it as the satisfied completion the API meant",
         out && out.state === "satisfied", JSON.stringify(out));

      //  The BOARD projection too: a detail page that works while the list
      //  renders unavailable is a half-shipped surface.
      const list = await req(port, "GET", "/operator/work-orders/status",
        { session: SESSION });
      const rows = (list.body && list.body.work_orders) || [];
      const bad = rows.map((w) => quiet(() => P.normalize(w.proof)))
        .filter((x) => !x || x.status !== "ok");
      ok("B12.3 …and every row of the live BOARD normalizes cleanly too",
         rows.length > 0 && bad.length === 0,
         `${rows.length} row(s), ${bad.length} rejected :: ` + JSON.stringify(bad.slice(0, 2)));

      //  THE POINT OF THE RELEASE, composed: legacy and defect must reach
      //  the app as DIFFERENT renderings, not one collapsed "proof failed".
      const legacyRow = rows.find((w) => w.proof.state === "legacy_indeterminate");
      ok("B12.4 the inventoried legacy row reaches the app as legacy, not as a failure",
         !!legacyRow && quiet(() => P.normalize(legacyRow.proof)).state === "legacy_indeterminate",
         JSON.stringify(legacyRow && legacyRow.proof));
    }
    await oneTruth("after B12");
  }

  // ══ B13 · CLEANUP ══════════════════════════════════════════════════
  sec("B13 · cleanup — `satisfied` has left the wire, `state` is the field of record");
  {
    const list = await reader.readPropertyWorkOrderStatuses(c, { propertyId: PROP, limit: 100 });
    ok("B13.1 no shape on any row carries `satisfied`",
       list.every((r) => !("satisfied" in r.proof)),
       JSON.stringify(list.find((r) => "satisfied" in r.proof) || null));
    ok("B13.2 …and the §3.4 mapping is still exported for consumers to derive from",
       proofState.SATISFIED_FOR.satisfied === true &&
       proofState.SATISFIED_FOR.legacy_indeterminate === null,
       JSON.stringify(proofState.SATISFIED_FOR));
    await oneTruth("after B13 — the train is complete");
  }

  server.close();

  // ══ THE TRAIN, END TO END ══════════════════════════════════════════
  sec("THE TRAIN — one meaning of truth at every boundary");
  for (const b of boundaries) {
    console.log(`    ${b.label.padEnd(34)} ${String(b.rows).padStart(3)} work orders · ` +
                `${b.violations} invariant violation(s)`);
  }
  const finalV = (await c.query(
    `select * from release_0_completion_invariant_violations`)).rows;
  ok("Z1  the completed train leaves ZERO invariant violations",
     finalV.length === 0, JSON.stringify(finalV));
  ok("Z2  …and every work order it created is explainable",
     boundaries.every((b) => b.violations === 0),
     JSON.stringify(boundaries.filter((b) => b.violations > 0)));

  sec("VERDICT");
  console.log(`  passed ${pass}   failed ${fail}`);
  c.release();
  await pool.end();
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error("\nERROR:\n" + (e && e.stack || e)); process.exit(1); });
