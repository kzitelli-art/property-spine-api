#!/usr/bin/env node
/* ════════════════════════════════════════════════════════════════════
   HTTP ACCEPTANCE — THE FOUR-STATE CONTRACT AS A CONSUMER SEES IT

   Everything proven so far calls functions. A consumer does not. It
   sends a request with a session header and reads JSON off a socket, and
   between the reader and that JSON sit an Express mount, an authority
   gate, a projection, and JSON.stringify — each of which can quietly
   change the contract.

   The one that matters most is the last: §3.2.1 requires `state` and
   `satisfied` to be ABSENT when the read is unavailable, and `absent`
   versus `null` is a distinction only the WIRE can settle. An in-process
   assertion cannot tell them apart; `JSON.parse` can.

     M   the mount is real — the anti-stub control
     H   all four states, over a real socket
     L   the list and the detail CANNOT disagree
     U   a failed read is `unavailable` — never a fabricated state
     A   authority is server-derived, over HTTP
     D   the defect lifecycle through the governed rail and the canonical
         service, observed through the routes

   ── WHY U IS THE LOAD-BEARING SECTION ───────────────────────────────

   If the read fails and the surface answers `missing_evaluation_defect`,
   every terminal work order in the property is accused of a writer
   defect at once. That is the single worst thing this release can do, so
   it is asserted against the raw response body, not the parsed one.

   ⚠ ISOLATED POSTGRES ONLY. Needs 137 + 138 + 139.

   usage:
     bash tools/steps23/baseline_136.sh
     PROVE_DATABASE_URL='...' node tools/steps23/apply_137.js
     STEP10_DATABASE_URL='postgresql://postgres@127.0.0.1:5433/r0scale?sslmode=disable' \
       node tools/step10/prove_http_acceptance.js
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
const MAINT = path.join(ROOT, "src/maintenance/maintenance.js");
const RUNNER = path.join(ROOT, "tools/run_proof_defect_sweep.js");
const activation = require(path.join(ROOT, "src/release0/activation_service.js"));
const proofState = require(path.join(ROOT, "src/release0/proof_state.js"));
const lifecycle = require(path.join(ROOT, "src/technician/lifecycle_service.js"));
const staffSessions = require(path.join(ROOT, "src/identity/staff_session_service.js"));
const URL = process.env.STEP10_DATABASE_URL;

let pass = 0, fail = 0;
const ok = (l, c, d) => { if (c) { pass++; console.log("  ok    " + l); }
  else { fail++; console.log("  FAIL  " + l + (d ? "\n          → " + d : "")); } return c; };
const sec = (t) => console.log(`\n${"═".repeat(66)}\n  ${t}\n${"═".repeat(66)}`);

const ID = (n) => crypto.createHash("md5").update("s10http:" + n).digest("hex")
  .replace(/^(.{8})(.{4})(.{4})(.{4})(.{12}).*$/, "$1-$2-$3-$4-$5");
const ORG = ID("org"), PROP = ID("prop"), OTHER = ID("other");
const OPER = ID("oper"), TECH = ID("tech");
const CUTOVER = new Date(Date.parse("2026-08-08T09:15:00.000Z"));

/*  The app, built exactly as server.js builds it — the real dependency
 *  graph, not a convenient stub. A proof against a stubbed mount is a
 *  proof about the stub, and this release has already been bitten by a
 *  router that refused a module where it wanted a service instance. */
function serve(pool) {
  const { spawnObligationFromEvent, satisfyObligation } =
    require(path.join(ROOT, "src/shared/obligation_engine.js"));
  const { transitionObligation } =
    require(path.join(ROOT, "src/shared/obligation_transitions.js"));
  const { makeWorkOrderService } = require(path.join(ROOT, "src/maintenance/work_order_service.js"));
  const workOrderService = makeWorkOrderService({
    spawnObligationFromEvent, satisfyObligation, transitionObligation });
  const app = express();
  app.use(express.json());
  app.use("/", require(MAINT)({ pool, spawnObligationFromEvent, workOrderService }));
  app.use("/", require(path.join(ROOT, "src/obligations/operator_obligations.js"))({ pool }));
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

//  A real request over a real socket. `raw` is kept because the absence
//  assertions in U are about the bytes, not about the parsed object.
function request(port, method, urlPath, { session, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const headers = {};
    if (session) headers["x-staff-session"] = session;
    if (payload) { headers["content-type"] = "application/json"; headers["content-length"] = payload.length; }
    const req = http.request({ host: "127.0.0.1", port, method, path: urlPath, headers }, (res) => {
      let raw = "";
      res.on("data", (d) => { raw += d; });
      res.on("end", () => {
        let json = null;
        try { json = JSON.parse(raw); } catch (_) { /* non-JSON is a finding, not a crash */ }
        resolve({ status: res.statusCode, body: json, raw });
      });
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

(async function main() {
  if (!URL) { console.error("REFUSED: STEP10_DATABASE_URL is not set."); process.exit(1); }
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

  console.log("HTTP ACCEPTANCE — the four-state contract over a real socket\n");
  for (const m of ["138_proof_evaluation_defect_obligation.sql",
                   "139_no_longer_applicable_resolution.sql"]) {
    await c.query(fs.readFileSync(path.join(ROOT, "migrations", m), "utf8"));
  }

  // ── the population ────────────────────────────────────────────────
  await c.query(`insert into organizations (id,name) values ($1,'S10 Org') on conflict (id) do nothing`, [ORG]);
  for (const [p, n] of [[PROP, "S10 Property"], [OTHER, "S10 Other Property"]]) {
    await c.query(`insert into properties (id,name,organization_id) values ($1,$2,$3)
                   on conflict (id) do nothing`, [p, n, ORG]);
  }
  await c.query(`insert into users (id,name,phone,role,is_active,status)
                 values ($1,'Robin Operator','+15415559801','property_manager',true,'active')
                 on conflict (id) do nothing`, [OPER]);
  await c.query(`insert into users (id,name,phone,role,is_active,status)
                 values ($1,'Sam Tech','+15415559802','maintenance',true,'active')
                 on conflict (id) do nothing`, [TECH]);
  await c.query(`insert into property_team_assignments
                   (user_id,property_id,role_title,allowed_modules,active)
                 values ($1,$2,'Property Manager',array['maintenance'],true)`, [OPER, PROP]);
  await c.query(`insert into property_team_assignments
                   (user_id,property_id,role_title,allowed_modules,active)
                 values ($1,$2,'Maintenance Tech',array['maintenance'],true)`, [TECH, PROP]);

  //  A REAL session, minted by the one canonical issuer. No hand-written
  //  row: a session this proof forged would prove nothing about the gate.
  const minted = await staffSessions.issueStaffSession(pool, {
    userId: OPER, propertyId: PROP, purpose: "bootstrap_invite" });
  const SESSION = minted.session_token;

  let seq = 0;
  const mkWo = async (status, property = PROP) => {
    const wo = ID("wo" + (++seq));
    await c.query(`insert into work_orders (id,property_id,title,status,source)
                   values ($1,$2,'s10http',$3,'s10httpproof')`, [wo, property, status]);
    await c.query(`insert into obligations (property_id,related_id,related_type,module,type,label,status)
                   values ($1,$2,'work_order','maintenance','work_order_routing','r','open')`, [property, wo]);
    return wo;
  };
  const photo = async (wo) => {
    const att = ID("att" + wo.slice(0, 8)), b = Buffer.from([7, 7, 7, 7]);
    await c.query(`insert into work_order_proof_attachments
      (id,work_order_id,property_id,uploaded_by_user_id,provider,provider_media_id,mime_type,
       storage_state,proof_classification,content,byte_size,sha256,stored_at)
      values ($1,$2,$3,$4,'twilio',$5,'image/jpeg','stored','repair_photo',$6,$7,$8,now())`,
      [att, wo, PROP, TECH, "ME" + att.slice(0, 8), b, b.length,
       crypto.createHash("sha256").update(b).digest("hex")]);
  };
  const evaluate = async (wo, state) => c.query(
    `insert into work_order_proof_evaluations
       (work_order_id,property_id,state,evaluated_by_service,rule_version)
     values ($1,$2,$3,'s10httpproof','x')`, [wo, PROP, state]);

  //  Created BEFORE the cutover, so the census inventories it as legitimate
  //  legacy history. Its twin is created after, and is a defect.
  const WO_LEGACY = await mkWo("closed");
  const WO_SAT = await mkWo("open");
  const WO_NOT = await mkWo("open");
  await evaluate(WO_SAT, "satisfied");
  await evaluate(WO_NOT, "not_satisfied");
  const WO_ELSEWHERE = await mkWo("open", OTHER);

  //  A work order somebody has CLAIMED is done. It is the only lifecycle
  //  state whose next_action depends on the proof block, which makes it the
  //  only place a failed proof read can become a field instruction.
  const WO_CLAIMED = await mkWo("open");
  await c.query(`insert into work_order_progress (work_order_id,property_id,kind,note,reported_by_user_id,occurred_at)
                 values ($1,$2,'completion_claimed','done',$3,now())`, [WO_CLAIMED, PROP, TECH]);

  const { server, port } = await serve(pool);
  //  NOTE THE `null` DEFAULTS, NOT `SESSION`. An earlier revision defaulted
  //  these to the real session, so `list(undefined)` — the "no session"
  //  case — silently received one and A1/A2 reported a 200 as though the
  //  gate were open. A default that fills in the very thing under test is
  //  a test that cannot fail in the direction it is pointed.
  const detail = (wo, session = SESSION) =>
    request(port, "GET", `/operator/work-orders/${wo}/status`, { session: session || null });
  const list = (session = SESSION, qs = "") =>
    request(port, "GET", `/operator/work-orders/status${qs}`, { session: session || null });
  const anon = (urlPath) => request(port, "GET", urlPath, {});

  // ══ M — THE MOUNT IS REAL ══════════════════════════════════════════
  sec("M · THE ANTI-STUB CONTROL");
  {
    const r = await list();
    ok("M1  the list route answers 200 on the real mount", r.status === 200,
       "status " + r.status + " :: " + r.raw.slice(0, 200));
    ok("M2  …with the SESSION's property echoed, not a request value",
       r.body && r.body.property_id === PROP, JSON.stringify(r.body && r.body.property_id));
    const d = await detail(WO_SAT);
    ok("M3  the detail route answers 200 and returns THIS work order",
       d.status === 200 && d.body && d.body.work_order && d.body.work_order.id === WO_SAT,
       "status " + d.status + " :: " + d.raw.slice(0, 200));
    ok("M4  a route that does not exist still 404s — the mount is not a catch-all",
       (await request(port, "GET", "/operator/work-orders/status/not-a-route", { session: SESSION })).status === 404);
  }

  // ══ U — UNAVAILABLE, BEFORE ANY ACTIVATION EXISTS ══════════════════
  //  Run FIRST, while there genuinely is no activation. Faking the
  //  condition later would be a proof about the fake.
  sec("U · A FAILED READ IS `unavailable` — NEVER A FABRICATED STATE");
  {
    const d = await detail(WO_LEGACY);
    ok("U1  with no cutover activation the detail route still answers 200",
       d.status === 200, "status " + d.status +
       " — a read that cannot derive proof must still report the work order");
    ok("U2  …and says the READ was unavailable",
       d.body && d.body.proof && d.body.proof.read_status === "unavailable",
       JSON.stringify(d.body && d.body.proof));
    ok("U3  …naming why", d.body.proof.reason_code === "activation_absent",
       JSON.stringify(d.body.proof.reason_code));

    //  §3.2.1 — ABSENT, not null. Only the wire can settle this.
    ok("U4  `state` is ABSENT from the JSON, not null",
       !("state" in d.body.proof), "proof keys: " + Object.keys(d.body.proof).join(","));
    ok("U5  `satisfied` is ABSENT from the JSON, not null",
       !("satisfied" in d.body.proof), "proof keys: " + Object.keys(d.body.proof).join(","));
    ok("U6  …and the raw bytes carry neither key at all",
       !/"state"\s*:/.test(JSON.stringify(d.body.proof)) &&
       !/"satisfied"\s*:/.test(JSON.stringify(d.body.proof)),
       d.raw.slice(0, 400));

    //  THE FABRICATION THIS SECTION EXISTS TO STOP.
    ok("U7  a TERMINAL work order is NOT accused of a defect when the read failed",
       !/missing_evaluation_defect/.test(d.raw),
       "a failed read fell through to a writer-defect verdict — every terminal " +
       "work order in the property would be accused at once. STOP.");

    const l = await list();
    ok("U8  the LIST reports it the same way, and omits the same two keys",
       l.status === 200 && l.body.work_orders.length > 0 &&
       l.body.work_orders.every((w) => w.proof.read_status === "unavailable" &&
         !("state" in w.proof) && !("satisfied" in w.proof)),
       JSON.stringify(l.body.work_orders.map((w) => w.proof)));
    ok("U9  …and no row anywhere in the list fabricated a state",
       !/missing_evaluation_defect|legacy_indeterminate/.test(l.raw), l.raw.slice(0, 300));

    //  ── AND NOTHING DOWNSTREAM INVENTS AN INSTRUCTION ──────────────
    //  `next_action` is the one field derived FROM the proof block, and it
    //  is what the app prints under "what happens next". A read that did
    //  not complete must not become "go take a photo".
    //
    //  THIS WAS REAL. `nextActionFor` read `proof.satisfied`, which Step 8
    //  made ABSENT on a failed read; `undefined` is falsy, so the surface
    //  told the operator to obtain a repair photo on the same screen that
    //  said the proof state was unavailable.
    const claimed = await detail(WO_CLAIMED);
    ok("U10  a claimed completion still reports the claim",
       claimed.body.current.state === "completion_claimed",
       JSON.stringify(claimed.body.current.state));
    ok("U11  …and next_action does NOT invent a field instruction from a failed read",
       !/photo/i.test(String(claimed.body.next_action)),
       JSON.stringify(claimed.body.next_action) +
       " — the surface says the proof state is unavailable and simultaneously " +
       "tells the operator to go do fieldwork about it");
    ok("U12  …it says the read is what is unavailable",
       /unavailable/i.test(String(claimed.body.next_action)),
       JSON.stringify(claimed.body.next_action));
    ok("U13  …and the list says exactly the same thing",
       (await list()).body.work_orders.find((w) => w.work_order.id === WO_CLAIMED)
         .next_action === claimed.body.next_action);

    //  The OTHER failure — the read itself throwing — is asserted in §F
    //  below, AFTER activation. It has to be: with no activation the
    //  derivation returns `unavailable` before it ever touches the
    //  evaluation head, so breaking the head here would break nothing and
    //  the assertion would pass for the wrong reason.
  }

  // ── ACTIVATE. Everything terminal right now becomes legitimate legacy.
  {
    const census = await activation.readLegacyTerminalSet(c);
    await c.query("begin");
    await activation.recordActivation(c, {
      activated_at: CUTOVER, captured_by: "http acceptance proof", expected: census });
    await c.query("commit");
    console.log(`\n  (activated; ${census.length} row(s) inventoried as legitimate legacy)`);
  }
  //  Created AFTER the cutover: terminal, uninventoried, unevaluated.
  const WO_DEFECT = await mkWo("closed");

  // ══ H — ALL FOUR STATES, OVER A REAL SOCKET ════════════════════════
  sec("H · THE FOUR STATES, AS A CONSUMER RECEIVES THEM");
  const EXPECTED = [
    [WO_SAT, "satisfied", true],
    [WO_NOT, "not_satisfied", false],
    [WO_LEGACY, "legacy_indeterminate", null],
    [WO_DEFECT, "missing_evaluation_defect", null],
  ];
  {
    for (const [wo, state, satisfied] of EXPECTED) {
      // eslint-disable-next-line no-await-in-loop
      const d = await detail(wo);
      ok(`H·${state.padEnd(25)} arrives over HTTP with satisfied=${JSON.stringify(satisfied)}`,
         d.status === 200 && d.body.proof.read_status === "ok" &&
         d.body.proof.state === state && d.body.proof.satisfied === satisfied,
         "status " + d.status + " :: " + JSON.stringify(d.body && d.body.proof &&
           { rs: d.body.proof.read_status, s: d.body.proof.state, sat: d.body.proof.satisfied }));
    }

    //  §3.4 — the compatibility mapping is the point of the whole release.
    const leg = (await detail(WO_LEGACY)).body.proof;
    const def = (await detail(WO_DEFECT)).body.proof;
    ok("H5  legacy and defect are INDISTINGUISHABLE on `satisfied` alone",
       leg.satisfied === null && def.satisfied === null,
       JSON.stringify({ leg: leg.satisfied, def: def.satisfied }));
    ok("H6  …and `state` is the only thing that tells them apart",
       leg.state !== def.state, JSON.stringify({ leg: leg.state, def: def.state }) +
       " — if these matched, the release delivered nothing");
    ok("H7  neither was collapsed into `satisfied: false`",
       leg.satisfied !== false && def.satisfied !== false,
       "collapsing legacy or a writer defect into 'proof failed' is exactly the " +
       "conflation that made a hollow closed work order look like a real one");

    //  THE POSITIVE CONTROL for U11–U13. With the read WORKING, the field
    //  instruction comes back — so "no photo sentence" is a property of the
    //  failed read, not of a next_action that stopped saying anything.
    const claimedLive = await detail(WO_CLAIMED);
    ok("H10  with a LIVE read, the claimed completion gets its real instruction",
       claimedLive.body.proof.read_status === "ok" &&
       /photo/i.test(String(claimedLive.body.next_action)),
       JSON.stringify({ rs: claimedLive.body.proof.read_status,
                        next: claimedLive.body.next_action }));
    await photo(WO_CLAIMED);
    await evaluate(WO_CLAIMED, "satisfied");
    const closable = await detail(WO_CLAIMED);
    ok("H11  …and once proof is satisfied it says to close it out instead",
       closable.body.proof.state === "satisfied" &&
       /close out/i.test(String(closable.body.next_action)),
       JSON.stringify({ s: closable.body.proof.state, next: closable.body.next_action }));

    //  No fifth value, anywhere on the wire.
    const l = await list();
    const seen = new Set(l.body.work_orders.map((w) => w.proof.state).filter((s) => s !== undefined));
    for (const [wo] of EXPECTED) seen.add((await detail(wo)).body.proof.state);
    ok("H8  every `state` on the wire is one of the four — there is no fifth value",
       [...seen].every((s) => proofState.PROOF_STATES.includes(s)),
       [...seen].join(","));
    ok("H9  …and all four were actually observed, so H8 is not vacuous",
       proofState.PROOF_STATES.every((s) => seen.has(s)), [...seen].join(","));
    console.log("        states seen on the wire: " + [...seen].sort().join(" · "));
  }

  // ══ F — WHEN THE LIVE READ ITSELF BREAKS ═══════════════════════════
  //  §U proved the honest answer when there is nothing to derive FROM.
  //  This is the other failure: an activation exists, the derivation runs,
  //  and the query underneath it fails. It must reach the consumer as 503
  //  unavailable — never as a 200 carrying an optimistic proof block, and
  //  never as a short list that reads like a clean board.
  sec("F · A BROKEN LIVE READ IS 503, NOT A CONFIDENT 200");
  {
    //  A control first: these exact requests are green right now, so a 503
    //  below is the parking and not some unrelated breakage.
    ok("F0  the two routes are green before anything is broken",
       (await detail(WO_SAT)).status === 200 && (await list()).status === 200);

    await c.query(`alter view work_order_proof_evaluation_head rename to _s10_head_parked`);
    let broke, brokeList;
    try {
      broke = await detail(WO_SAT);
      brokeList = await list();
    } finally {
      await c.query(`alter view _s10_head_parked rename to work_order_proof_evaluation_head`);
    }
    ok("F1  when the live read THROWS, the detail route answers 503",
       broke.status === 503, "status " + broke.status + " :: " + broke.raw.slice(0, 200));
    ok("F2  …named `unavailable`, and carrying no work order at all",
       broke.body && broke.body.error === "unavailable" && !broke.body.work_order,
       broke.raw.slice(0, 300));
    ok("F3  …and no proof state was invented on the way out",
       !/"state"|"satisfied"|missing_evaluation_defect/.test(broke.raw), broke.raw.slice(0, 300));
    ok("F4  the LIST fails the same way rather than returning a short list",
       brokeList.status === 503 && brokeList.body.error === "unavailable" &&
       !Array.isArray(brokeList.body.work_orders),
       "status " + brokeList.status + " :: " + brokeList.raw.slice(0, 200) +
       " — an empty or partial 200 is the false green this release exists to stop");

    //  And the parking really was reversible, or everything below lies.
    ok("F5  the view was restored — every assertion below is about a live read",
       (await detail(WO_SAT)).status === 200);
  }

  // ══ L — THE LIST AND THE DETAIL CANNOT DISAGREE ════════════════════
  sec("L · ONE VERDICT PER WORK ORDER, WHICHEVER ROUTE ASKED");
  {
    const l = await list();
    ok("L1  the list carries `state`, not just `satisfied` (§3.3)",
       l.body.work_orders.every((w) => "state" in w.proof),
       "the board would show two hollow rows as identical and only the detail " +
       "could tell them apart");

    let compared = 0, disagreed = [];
    for (const row of l.body.work_orders) {
      // eslint-disable-next-line no-await-in-loop
      const d = (await detail(row.work_order.id)).body;
      compared += 1;
      const a = row.proof, b = d.proof;
      const same = a.read_status === b.read_status && a.state === b.state &&
        a.satisfied === b.satisfied &&
        JSON.stringify(a.legacy_evidence) === JSON.stringify(b.legacy_evidence);
      if (!same) disagreed.push({ id: row.work_order.id, list: a, detail: b });
    }
    ok("L2  every work order reports the SAME proof verdict on both routes",
       disagreed.length === 0, JSON.stringify(disagreed).slice(0, 500));
    ok("L3  …and the comparison covered every row the list returned",
       compared === l.body.work_orders.length && compared >= 4,
       `compared ${compared} of ${l.body.work_orders.length}`);

    const statesCompared = new Set(l.body.work_orders.map((w) => w.proof.state));
    ok("L4  …across all four states, so L2 is not a comparison of one shape",
       proofState.PROOF_STATES.every((s) => statesCompared.has(s)),
       [...statesCompared].join(","));

    //  And the two routes agree on the lifecycle state too — the same
    //  guarantee §3.3 makes about proof, for the field the board renders.
    const mismatch = [];
    for (const row of l.body.work_orders) {
      // eslint-disable-next-line no-await-in-loop
      const d = (await detail(row.work_order.id)).body;
      if (row.current.state !== d.current.state || row.next_action !== d.next_action) {
        mismatch.push(row.work_order.id);
      }
    }
    ok("L5  …and on lifecycle state and next action as well", mismatch.length === 0,
       mismatch.join(","));
  }

  // ══ A — AUTHORITY IS SERVER-DERIVED, OVER HTTP ═════════════════════
  sec("A · THE BROWSER REQUESTS; THE SERVER DECIDES (§21)");
  {
    const noSession = await anon("/operator/work-orders/status");
    ok("A1  no session → 401 on the list, not an empty 200",
       noSession.status === 401, "status " + noSession.status + " :: " + noSession.raw.slice(0, 150));
    ok("A2  no session → 401 on the detail too",
       (await anon(`/operator/work-orders/${WO_SAT}/status`)).status === 401);
    ok("A3  a forged session token is refused",
       (await detail(WO_SAT, "not-a-real-token")).status === 401);

    const claimed = await list(SESSION, `?property_id=${OTHER}`);
    ok("A4  a client-supplied property_id that differs is REFUSED, not substituted",
       claimed.status === 403, "status " + claimed.status + " :: " + claimed.raw.slice(0, 200));
    ok("A5  …and the refusal names the property actually being acted on",
       claimed.body && claimed.body.acting_on === PROP, JSON.stringify(claimed.body));

    const cross = await detail(WO_ELSEWHERE);
    ok("A6  a work order at ANOTHER property is 404, never a leaked row",
       cross.status === 404 && !/s10http/.test(cross.raw),
       "status " + cross.status + " :: " + cross.raw.slice(0, 200));

    const l = await list();
    ok("A7  the list contains only the session property's work orders",
       l.body.work_orders.every((w) => w.work_order.id !== WO_ELSEWHERE),
       "a work order from another property reached the board");
  }

  // ══ D — THE DEFECT LIFECYCLE, THROUGH THE RAIL AND THE ROUTES ══════
  sec("D · RAISE THROUGH THE GOVERNED RAIL, OBSERVE THROUGH THE ROUTES");
  {
    //  `?status=open` is the OUTSTANDING queue. The unfiltered read returns
    //  completed obligations too, and that is correct — a resolved
    //  accountability item is history, not something to erase — so
    //  "the defect is gone" has to mean gone from the OPEN queue.
    const defectItems = async (qs = "?status=open") => {
      const r = await request(port, "GET", "/operator/obligations" + qs, { session: SESSION });
      if (r.status !== 200) return { status: r.status, items: null, raw: r.raw };
      return { status: 200, items: r.body.items.filter((i) => i.type === "proof_evaluation_missing"), raw: r.raw };
    };

    const before = await defectItems();
    ok("D1  before the sweep, the operator surface shows no proof-evaluation defect",
       before.status === 200 && before.items.length === 0,
       JSON.stringify(before.items));

    //  THE GOVERNED RAIL — a real child process, real argv, real exit code.
    //  Calling runProofDefectSweep() here would prove the function, and the
    //  function is already proven; this proves the thing that runs.
    const dry = spawnSync(process.execPath, [RUNNER],
      { encoding: "utf8", env: { ...process.env, DATABASE_URL: URL } });
    ok("D2  a bare rail invocation is a DRY RUN and creates nothing",
       dry.status === 0 && /DRY RUN, nothing written/.test(dry.stdout) &&
       (await defectItems()).items.length === 0,
       "exit " + dry.status + " :: " + dry.stdout.slice(-200));

    const live = spawnSync(process.execPath, [RUNNER, "--raise", "--property", PROP],
      { encoding: "utf8", env: { ...process.env, DATABASE_URL: URL } });
    ok("D3  --raise through the rail exits 0", live.status === 0,
       "exit " + live.status + " :: " + (live.stderr || live.stdout).slice(-300));

    const after = await defectItems();
    ok("D4  the obligation is now VISIBLE on the operator surface over HTTP",
       after.status === 200 && after.items.length === 1,
       JSON.stringify(after.items && after.items.map((i) => i.type)));
    const item = (after.items || [])[0] || {};
    ok("D5  …linked to the work order the reader called a defect",
       item.related_type === "work_order" && item.related_id === WO_DEFECT,
       JSON.stringify({ t: item.related_type, id: item.related_id }));
    ok("D6  …UNASSIGNED — §4.2 freezes the ROLE and names no person",
       item.assigned_user_id === null && item.assigned_role === "property_manager",
       JSON.stringify({ user: item.assigned_user_id, role: item.assigned_role }) +
       " — resolving a human here would invent an ownership ruling nobody made");
    ok("D7  …scoped to the session's property",
       item.property_id === PROP, JSON.stringify(item.property_id));

    //  THE READER IS STILL A READ.
    const d = await detail(WO_DEFECT);
    ok("D8  raising the obligation did not change the reader's verdict",
       d.body.proof.state === "missing_evaluation_defect", JSON.stringify(d.body.proof.state));
    const l = await list();
    const listed = l.body.work_orders.find((w) => w.work_order.id === WO_DEFECT);
    ok("D9  …and the list still agrees with the detail",
       listed.proof.state === d.body.proof.state && listed.proof.satisfied === d.body.proof.satisfied);

    //  ── RESOLUTION, THROUGH THE CANONICAL SERVICE ──────────────────
    //  Not by updating the obligation. The only thing that closes this is
    //  the completion path producing a real evaluation.
    await c.query(`update work_orders set status='open' where id=$1`, [WO_DEFECT]);
    await photo(WO_DEFECT);
    await c.query("begin");
    const done = await lifecycle.claimCompletion(c, {
      work_order_id: WO_DEFECT, user_id: TECH, organization_id: ORG, idempotency_key: "s10-d" });
    await c.query("commit");
    ok("D10  the canonical service completes the work", done.closed === true,
       JSON.stringify({ o: done.outcome, closed: done.closed, missing: done.missing }));

    const resolved = await defectItems();
    ok("D11  …and it is GONE from the operator's OPEN queue",
       resolved.items.length === 0, JSON.stringify(resolved.items));
    const history = await defectItems("");
    ok("D12  …but still readable as history — a closed obligation is a fact, not an erasure",
       history.items.length === 1 && history.items[0].status === "complete",
       JSON.stringify(history.items && history.items.map((i) => i.status)));
    const closedRow = (await c.query(
      `select status, resolution_code from obligations
        where type='proof_evaluation_missing' and related_id=$1`, [WO_DEFECT])).rows[0];
    ok("D13  …closed as 'satisfied', because an evaluation now exists",
       closedRow.status === "complete" && closedRow.resolution_code === "satisfied",
       JSON.stringify(closedRow));

    const nowSat = await detail(WO_DEFECT);
    ok("D14  and the SAME route that reported the defect now reports satisfied",
       nowSat.body.proof.state === "satisfied" && nowSat.body.proof.satisfied === true,
       JSON.stringify(nowSat.body.proof.state) +
       " — one predicate, one verdict, read wherever you ask");

    //  Nothing else moved.
    const stillLegacy = await detail(WO_LEGACY);
    ok("D15  the legacy row was never touched by any of it",
       stillLegacy.body.proof.state === "legacy_indeterminate" &&
       (await c.query(`select count(*) n from obligations
                        where type='proof_evaluation_missing' and related_id=$1`,
                      [WO_LEGACY])).rows[0].n === "0",
       JSON.stringify(stillLegacy.body.proof.state));
  }

  // ══ W — THE READ SURFACES WROTE NOTHING ════════════════════════════
  sec("W · THE ROUTES THAT READ, READ");
  {
    const rows = Number((await c.query(
      `select count(*) n from work_order_progress where property_id=$1`, [PROP])).rows[0].n);
    const evs = Number((await c.query(
      `select count(*) n from work_order_proof_evaluations where property_id=$1`, [PROP])).rows[0].n);
    //  Every GET above, once more, then measured again.
    for (const [wo] of EXPECTED) await detail(wo);
    await list();
    await request(port, "GET", "/operator/obligations", { session: SESSION });
    const rows2 = Number((await c.query(
      `select count(*) n from work_order_progress where property_id=$1`, [PROP])).rows[0].n);
    const evs2 = Number((await c.query(
      `select count(*) n from work_order_proof_evaluations where property_id=$1`, [PROP])).rows[0].n);
    ok("W1  replaying every read route changed no progress row", rows === rows2, `${rows} → ${rows2}`);
    ok("W2  …and created no proof evaluation", evs === evs2, `${evs} → ${evs2}`);
  }

  sec("VERDICT");
  console.log(`  passed ${pass}   failed ${fail}`);
  server.close();
  c.release();
  await pool.end();
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error("\nERROR:\n" + (e && e.stack || e)); process.exit(1); });
