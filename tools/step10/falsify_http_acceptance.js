#!/usr/bin/env node
/* ════════════════════════════════════════════════════════════════════
   FALSIFY THE HTTP ACCEPTANCE PROOF

   `prove_http_acceptance.js` is 57 green assertions. That is worth
   nothing until the mutations it exists to catch actually turn it red.

   Every variant here is a defect that lives ENTIRELY IN THE HTTP LAYER —
   the projection, the route's failure handler, the authority gate. The
   service-level proofs cannot see any of them, which is the whole reason
   this step exists:

     list-drops-state       the list stops carrying `state` (§3.3 undone)
     swallow-read-failure   a thrown read becomes a confident 200
     property-from-query    the browser gets to choose the building (§21)

   The files on disk are NEVER edited. Each variant is compiled in
   memory, installed in `require.cache` so the real router picks it up,
   and every source digest is re-checked at the end.

   A mutation that matches nothing is a REFUSAL, not a pass — a
   falsification whose target has moved proves only that the string moved.

   ⚠ ISOLATED POSTGRES ONLY. Needs 137. Rebuild the baseline between
     variants: each one activates.

   usage:
     bash tools/steps23/baseline_136.sh
     PROVE_DATABASE_URL='...' node tools/steps23/apply_137.js
     FALSIFY10_DATABASE_URL='...' node tools/step10/falsify_http_acceptance.js \
       --variant list-drops-state
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const http = require("http");
const Module = require("module");
const express = require("express");
const { Pool } = require("pg");

const ROOT = path.join(__dirname, "..", "..");
const MAINT = path.join(ROOT, "src/maintenance/maintenance.js");
const READER = path.join(ROOT, "src/surfaces/work_order_status_read.js");
const PROOF_STATE = path.join(ROOT, "src/release0/proof_state.js");
const URL = process.env.FALSIFY10_DATABASE_URL;
const DIGEST = (f) => crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");
const MAINT_DIGEST = DIGEST(MAINT), READER_DIGEST = DIGEST(READER);
const PS_DIGEST = DIGEST(PROOF_STATE);

const argIdx = process.argv.indexOf("--variant");
const VARIANT = argIdx > -1 ? process.argv[argIdx + 1] : null;

const VARIANTS = {
  /*  §3.3 / §19 Ruling 2 — "the list carries `state` too", because a
   *  legacy row and a writer defect are both `satisfied: null` and only
   *  `state` tells them apart. Undo it and the BOARD goes back to showing
   *  two different situations as one. */
  "list-drops-state": {
    file: READER,
    what: "the list projection stops carrying `state`",
    breaks: "L1/L2/L4 — the board and the detail disagree again",
    edits: [{
      from: `                 ...(s.proof.read_status === "ok"
                   ? { state: s.proof.state }
                   : { reason_code: s.proof.reason_code }),`,
      to: `                 ...(s.proof.read_status === "ok"
                   ? {}
                   : { reason_code: s.proof.reason_code }),`,
    }],
  },

  /*  THE CLEANUP RELEASE, UNDONE. Putting `satisfied` back on the wire is
   *  not harmless: it re-creates the second source of truth the removal
   *  exists to end, and every consumer that has moved to `state` now has
   *  a field it must ignore but can still be tempted to read. */
  "satisfied-back-on-the-wire": {
    file: PROOF_STATE,
    what: "the retired compatibility field is emitted again",
    breaks: "H·retired + H·<state> — `satisfied` must appear nowhere",
    edits: [{
      from: `    return { read_status: "ok", state: head.state };`,
      to: `    return { read_status: "ok", state: head.state, satisfied: SATISFIED_FOR[head.state] };`,
    }],
  },

  /*  THE OTHER DIRECTION, AND THE WORSE ONE. Removing the FIELD is the
   *  release; removing the MEANING destroys the contract. If the mapping
   *  stops being exported, every consumer deriving a boolean from `state`
   *  has nothing to derive it from. */
  "mapping-deleted": {
    file: PROOF_STATE,
    what: "the frozen §3.4 mapping stops being exported",
    breaks: "the consumer contract itself — `state` becomes underivable",
    edits: [{
      from: `  PROOF_STATES, TERMINAL_STATUSES, SATISFIED_FOR,`,
      to: `  PROOF_STATES, TERMINAL_STATUSES,`,
    }],
  },

  /*  THE DEFECT THIS STEP ACTUALLY FOUND, restored. `nextActionFor` read
   *  `proof.satisfied`, which Step 8 made ABSENT when the read fails —
   *  `undefined` is falsy, so a failed read became "go take a photo" on the
   *  same screen that said the proof state was unavailable. It survived
   *  every service-level proof because none of them look at next_action. */
  "next-action-from-satisfied": {
    file: READER,
    what: "next_action is derived from `satisfied` again, as it was before this step",
    breaks: "U11/U12 — a failed read must not become a field instruction",
    edits: [{
      from: `    case "completion_claimed":
      if (!proof || proof.read_status !== "ok") return "Proof state unavailable — retry";
      return proof.state === "satisfied"
        ? "Close out the work order"
        : "Obtain repair photo before completion";`,
      to: `    case "completion_claimed":  return proof.satisfied ? "Close out the work order" : "Obtain repair photo before completion";`,
    }],
  },

  /*  §5 — honest blank beats confident wrong. A live read that failed and
   *  answers 200 with a proof block is the exact false green this release
   *  exists to end, and NO service-level proof can see it: the service
   *  threw correctly. The defect is entirely in the handler. */
  "swallow-read-failure": {
    file: MAINT,
    what: "a thrown live read is answered 200 with a fabricated proof block",
    breaks: "F1–F4 — a broken read must be 503 unavailable",
    edits: [{
      from: `      console.error("operator work-order status:", e.message);
      res.status(503).json({ error: "unavailable", detail: "The live work-order read is unavailable. Retry." });`,
      to: `      console.error("operator work-order status:", e.message);
      res.status(200).json({ work_order: { id: req.params.id },
        proof: { required: true, read_status: "ok", state: "satisfied", satisfied: true } });`,
    }],
  },

  /*  §21 — the browser requests; the server decides. Two edits, because
   *  two things stand in the way: the refusal in the gate, and the
   *  session being the only source of scope. Removing either alone is not
   *  a leak, which is itself worth showing. */
  "property-from-query": {
    file: MAINT,
    what: "a client-supplied property_id selects the property the board reads",
    breaks: "A4/A5/A7 + M2 — server-derived authority",
    edits: [
      { from: `    if (claimed && String(claimed) !== String(req.operator.property_id)) {
      return res.status(403).json({
        error: "property authority is server-derived; a client-supplied property_id cannot select a different property.",
        acting_on: req.operator.property_id,
      });
    }
    return next();`,
        to: `    return next();` },
      { from: `      const rows = await workOrderStatusRead.readPropertyWorkOrderStatuses(pool, {
        propertyId: req.operator.property_id,`,
        to: `      const rows = await workOrderStatusRead.readPropertyWorkOrderStatuses(pool, {
        propertyId: (req.query && req.query.property_id) || req.operator.property_id,` },
    ],
  },
};

let pass = 0, fail = 0;
const ok = (l, c, d) => { if (c) { pass++; console.log("  ok    " + l); }
  else { fail++; console.log("  FAIL  " + l + (d ? "\n          → " + d : "")); } return c; };

/*  Compile a mutated copy and INSTALL it where the real router will find
 *  it. The disk is untouched; `require.cache` is the only thing that
 *  moves, and it moves before anything has required the real module. */
function installVariant(file, edits) {
  let src = fs.readFileSync(file, "utf8");
  for (const { from, to } of edits) {
    if (!src.includes(from)) {
      throw new Error("FALSIFICATION TARGET NOT FOUND — the mutation matched nothing, " +
                      "so it proves nothing:\n" + from.slice(0, 160));
    }
    src = src.split(from).join(to);
  }
  const m = new Module(file, null);
  m.filename = file;
  m.paths = Module._nodeModulePaths(path.dirname(file));
  m._compile(src, file);
  m.loaded = true;
  require.cache[require.resolve(file)] = m;
  return m.exports;
}

const ID = (n) => crypto.createHash("md5").update("s10fals:" + n).digest("hex")
  .replace(/^(.{8})(.{4})(.{4})(.{4})(.{12}).*$/, "$1-$2-$3-$4-$5");
const ORG = ID("org"), PROP = ID("prop"), OTHER = ID("other"), OPER = ID("oper");
const CUTOVER = new Date(Date.parse("2026-08-08T09:15:00.000Z"));

function request(port, method, urlPath, session) {
  return new Promise((resolve, reject) => {
    const headers = session ? { "x-staff-session": session } : {};
    const req = http.request({ host: "127.0.0.1", port, method, path: urlPath, headers }, (res) => {
      let raw = "";
      res.on("data", (d) => { raw += d; });
      res.on("end", () => {
        let json = null;
        try { json = JSON.parse(raw); } catch (_) { /* a finding, not a crash */ }
        resolve({ status: res.statusCode, body: json, raw });
      });
    });
    req.on("error", reject);
    req.end();
  });
}

(async function main() {
  if (!URL) { console.error("REFUSED: FALSIFY10_DATABASE_URL is not set."); process.exit(1); }
  if (!VARIANT || !VARIANTS[VARIANT]) {
    console.error("REFUSED: --variant is required. One of:\n  " +
      Object.keys(VARIANTS).join("\n  "));
    process.exit(1);
  }
  const V = VARIANTS[VARIANT];

  const pool = new Pool({ connectionString: URL });
  const c = await pool.connect();
  const sentinel = Number((await c.query(
    `select count(*) n from release_0_scale_harness_guard where purpose like 'ISOLATED RELEASE 0%'`
  ).catch(() => ({ rows: [{ n: 0 }] }))).rows[0].n);
  if (sentinel !== 1) { console.error("REFUSED: not the isolated baseline."); process.exit(2); }
  if (Number((await c.query(`select count(*) n from release_0_activation_history`)).rows[0].n) > 0) {
    console.error("REFUSED: activation history is not empty — rebuild the baseline.");
    process.exit(3);
  }

  console.log(`FALSIFY HTTP ACCEPTANCE — variant: ${VARIANT}`);
  console.log(`  mutation : ${V.what}`);
  console.log(`  must break: ${V.breaks}\n`);

  //  Installed BEFORE anything requires the real module.
  installVariant(V.file, V.edits);

  // ── population ────────────────────────────────────────────────────
  await c.query(`insert into organizations (id,name) values ($1,'F10 Org') on conflict (id) do nothing`, [ORG]);
  for (const [p, n] of [[PROP, "F10 Property"], [OTHER, "F10 Other"]]) {
    await c.query(`insert into properties (id,name,organization_id) values ($1,$2,$3)
                   on conflict (id) do nothing`, [p, n, ORG]);
  }
  await c.query(`insert into users (id,name,phone,role,is_active,status)
                 values ($1,'Fal Operator','+15415559901','property_manager',true,'active')
                 on conflict (id) do nothing`, [OPER]);
  await c.query(`insert into property_team_assignments
                   (user_id,property_id,role_title,allowed_modules,active)
                 values ($1,$2,'Property Manager',array['maintenance'],true)`, [OPER, PROP]);

  const staffSessions = require(path.join(ROOT, "src/identity/staff_session_service.js"));
  const SESSION = (await staffSessions.issueStaffSession(pool, {
    userId: OPER, propertyId: PROP, purpose: "bootstrap_invite" })).session_token;

  let seq = 0;
  const mkWo = async (status, property = PROP) => {
    const wo = ID("wo" + (++seq));
    await c.query(`insert into work_orders (id,property_id,title,status,source)
                   values ($1,$2,'f10',$3,'f10proof')`, [wo, property, status]);
    return wo;
  };
  const WO_LEGACY = await mkWo("closed");
  const WO_SAT = await mkWo("open");
  await c.query(`insert into work_order_proof_evaluations
     (work_order_id,property_id,state,evaluated_by_service,rule_version)
     values ($1,$2,'satisfied','f10proof','x')`, [WO_SAT, PROP]);
  const WO_ELSEWHERE = await mkWo("open", OTHER);
  const WO_CLAIMED = await mkWo("open");
  await c.query(`insert into work_order_progress
                   (work_order_id,property_id,kind,note,reported_by_user_id,occurred_at)
                 values ($1,$2,'completion_claimed','done',$3,now())`, [WO_CLAIMED, PROP, OPER]);

  /*  ONE VARIANT DELIBERATELY DOES NOT ACTIVATE. `next-action-from-satisfied`
   *  is about what the surface says when the proof read CANNOT COMPLETE, and
   *  the honest way to produce that is to leave the cutover unactivated —
   *  the same condition §U proves against. Faking it any other way would be
   *  a falsification of the fake. */
  const NEEDS_ACTIVATION = VARIANT !== "next-action-from-satisfied";
  let WO_DEFECT = null;
  if (NEEDS_ACTIVATION) {
    const activation = require(path.join(ROOT, "src/release0/activation_service.js"));
    const census = await activation.readLegacyTerminalSet(c);
    await c.query("begin");
    await activation.recordActivation(c, {
      activated_at: CUTOVER, captured_by: "falsify http", expected: census });
    await c.query("commit");
    WO_DEFECT = await mkWo("closed");   // post-cutover → a real defect
  }

  // ── the real dependency graph, with the mutation inside it ────────
  const { spawnObligationFromEvent, satisfyObligation } =
    require(path.join(ROOT, "src/shared/obligation_engine.js"));
  const { transitionObligation } =
    require(path.join(ROOT, "src/shared/obligation_transitions.js"));
  const { makeWorkOrderService } = require(path.join(ROOT, "src/maintenance/work_order_service.js"));
  const app = express();
  app.use(express.json());
  app.use("/", require(MAINT)({ pool, spawnObligationFromEvent,
    workOrderService: makeWorkOrderService({
      spawnObligationFromEvent, satisfyObligation, transitionObligation }) }));
  const { server, port } = await new Promise((resolve) => {
    const s = http.createServer(app);
    s.listen(0, "127.0.0.1", () => resolve({ server: s, port: s.address().port }));
  });

  //  Every variant first proves the mount is ALIVE. A red assertion from a
  //  dead router is not a caught mutation, it is a broken harness.
  const alive = await request(port, "GET", "/operator/work-orders/status", SESSION);
  ok("V0  the mutated app still serves the route (the break is not a dead mount)",
     alive.status === 200, "status " + alive.status + " :: " + alive.raw.slice(0, 200));

  if (VARIANT === "list-drops-state") {
    const l = alive.body.work_orders;
    ok("V1  the list no longer carries `state` — L1 goes RED",
       l.length > 0 && l.every((w) => !("state" in w.proof)),
       JSON.stringify(l.map((w) => Object.keys(w.proof))));
    const legacyRow = l.find((w) => w.work_order.id === WO_LEGACY);
    const defectRow = l.find((w) => w.work_order.id === WO_DEFECT);
    /*  Post-removal the list has NOTHING left once `state` goes: the
     *  compatibility field it used to fall back on is retired. So the
     *  board cannot distinguish legacy from a writer defect, and cannot
     *  describe either one at all. */
    ok("V2  …and the board is left with no proof verdict whatsoever",
       legacyRow.proof.state === undefined && defectRow.proof.state === undefined &&
       !("satisfied" in legacyRow.proof) && !("satisfied" in defectRow.proof),
       JSON.stringify({ legacy: legacyRow.proof, defect: defectRow.proof }));
    const d = await request(port, "GET", `/operator/work-orders/${WO_DEFECT}/status`, SESSION);
    ok("V3  …while the DETAIL still knows — the two routes now disagree, so L2 goes RED",
       d.body.proof.state === "missing_evaluation_defect" && defectRow.proof.state === undefined,
       JSON.stringify({ detail: d.body.proof.state, list: defectRow.proof.state }));
  }

  if (VARIANT === "satisfied-back-on-the-wire") {
    const d = await request(port, "GET", `/operator/work-orders/${WO_SAT}/status`, SESSION);
    ok("V1  the retired field is on the wire again — H·retired goes RED",
       "satisfied" in d.body.proof && /"satisfied"\s*:/.test(d.raw),
       JSON.stringify(d.body.proof));
    ok("V2  …so there are two sources of truth for one verdict again",
       d.body.proof.state === "satisfied" && d.body.proof.satisfied === true,
       JSON.stringify({ state: d.body.proof.state, satisfied: d.body.proof.satisfied }) +
       " — a consumer can now read either, and they can drift");
  }

  if (VARIANT === "mapping-deleted") {
    const ps = require(PROOF_STATE);
    ok("V1  the frozen mapping is no longer exported", ps.SATISFIED_FOR === undefined,
       JSON.stringify(ps.SATISFIED_FOR));
    const d = await request(port, "GET", `/operator/work-orders/${WO_SAT}/status`, SESSION);
    ok("V2  …the wire still carries `state`, so the API looks fine",
       d.status === 200 && d.body.proof.state === "satisfied",
       JSON.stringify(d.body.proof));
    ok("V3  …but nothing can derive the boolean from it any more",
       (ps.SATISFIED_FOR || {})[d.body.proof.state] === undefined,
       "the removal took the MEANING with the FIELD — that is not this release");
  }

  if (VARIANT === "next-action-from-satisfied") {
    const d = await request(port, "GET", `/operator/work-orders/${WO_CLAIMED}/status`, SESSION);
    ok("V1  the proof read is genuinely unavailable (the condition is real, not staged)",
       d.body.proof.read_status === "unavailable" && !("satisfied" in d.body.proof),
       JSON.stringify(d.body.proof));
    ok("V2  …and next_action tells the operator to go take a photo — U11 goes RED",
       /photo/i.test(String(d.body.next_action)), JSON.stringify(d.body.next_action));
    ok("V3  …on the same response that says the proof state is unavailable — U12 goes RED",
       !/unavailable/i.test(String(d.body.next_action)),
       JSON.stringify({ read_status: d.body.proof.read_status, next_action: d.body.next_action }) +
       " — one payload, two answers, and the operator only sees the instruction");
  }

  if (VARIANT === "swallow-read-failure") {
    await c.query(`alter view work_order_proof_evaluation_head rename to _f10_head_parked`);
    let broke;
    try {
      broke = await request(port, "GET", `/operator/work-orders/${WO_SAT}/status`, SESSION);
    } finally {
      await c.query(`alter view _f10_head_parked rename to work_order_proof_evaluation_head`);
    }
    ok("V1  a THROWN live read is answered 200 — F1 goes RED", broke.status === 200,
       "status " + broke.status);
    ok("V2  …and the answer carries a proof state that no read produced — F3 goes RED",
       broke.body.proof && broke.body.proof.satisfied === true,
       JSON.stringify(broke.body.proof) +
       " — this is the confident wrong: the database refused and the surface said 'proven'");
  }

  if (VARIANT === "property-from-query") {
    const leaked = await request(port, "GET",
      `/operator/work-orders/status?property_id=${OTHER}`, SESSION);
    ok("V1  a client-supplied property_id is no longer refused — A4 goes RED",
       leaked.status === 200, "status " + leaked.status + " :: " + leaked.raw.slice(0, 150));
    ok("V2  …and it selected the OTHER property's work orders — A7 goes RED",
       leaked.body.work_orders.some((w) => w.work_order.id === WO_ELSEWHERE),
       JSON.stringify(leaked.body.work_orders.map((w) => w.work_order.id)));
    ok("V3  …while still SAYING it acted on the session property — M2 goes RED",
       leaked.body.property_id === PROP,
       JSON.stringify(leaked.body.property_id) +
       " — the caller is told one building and shown another; nothing on the page says so");
  }

  // ── the disk was never touched ────────────────────────────────────
  ok("Z1  maintenance.js is byte-identical to before this run",
     DIGEST(MAINT) === MAINT_DIGEST, "the falsification EDITED THE SOURCE. Restore it.");
  ok("Z2  work_order_status_read.js is byte-identical to before this run",
     DIGEST(READER) === READER_DIGEST, "the falsification EDITED THE SOURCE. Restore it.");
  ok("Z3  proof_state.js is byte-identical to before this run",
     DIGEST(PROOF_STATE) === PS_DIGEST, "the falsification EDITED THE SOURCE. Restore it.");

  console.log(`\n  passed ${pass}   failed ${fail}`);
  console.log(pass > 0 && fail === 0
    ? "\n  ✓ THE MUTATION WAS CAUGHT — the named assertions cannot pass over it.\n"
    : "\n  ✗ THE MUTATION SURVIVED — those assertions do not test what they claim.\n");
  server.close();
  c.release();
  await pool.end();
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error("\nERROR:\n" + (e && e.stack || e)); process.exit(1); });
