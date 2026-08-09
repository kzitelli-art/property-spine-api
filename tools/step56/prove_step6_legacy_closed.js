#!/usr/bin/env node
/* ════════════════════════════════════════════════════════════════════
   STEP 6 — PROVE THE LEGACY DONE-PATH IS CLOSED, THROUGH REAL HTTP

   Step 6 leaves ONE future path to a terminal work-order status. That is
   a claim about a ROUTE, so it is proven by making real requests to a
   real Express app backed by a real PostgreSQL — not by reading source.
   `gate_completion_writers.js` asserts the guard exists and sits in front
   of `pool.connect()`; this asserts what actually happens when a legacy
   caller sends the request it has always sent.

   ── THE PAIRED CONTROL IS THE POINT ─────────────────────────────────

   A 409 from a route that no longer works at all proves nothing. Every
   refusal here is paired with the NOT-DONE path on the same route
   succeeding, which is what makes the 409 legible as a governed refusal
   of ONE VERB rather than a dead route, a broken mount or a lost
   database.

   ── AND "WROTE NOTHING" IS MEASURED, NOT ASSERTED ───────────────────

   A full census is taken before and after every refused request: work
   order status, events, progress rows, evaluations. "Writes nothing" is
   the difference between two counts, not a sentence in a comment.

   ⚠ ISOLATED POSTGRES ONLY. Needs schema 137 (the canonical writer runs
     here too, as the control that the real path still completes).

   usage:
     bash tools/steps23/baseline_136.sh
     PROVE_DATABASE_URL='...' node tools/steps23/apply_137.js
     STEP6_DATABASE_URL='postgresql://postgres@127.0.0.1:5433/r0scale?sslmode=disable' \
       node tools/step56/prove_step6_legacy_closed.js
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const Module = require("module");
const http = require("http");
const express = require("express");
const { Pool } = require("pg");

const ROOT = path.join(__dirname, "..", "..");
const MAINT = path.join(ROOT, "src/maintenance/maintenance.js");
const URL = process.env.STEP6_DATABASE_URL;
const MAINT_DIGEST = crypto.createHash("sha256").update(fs.readFileSync(MAINT)).digest("hex");

let pass = 0, fail = 0;
const ok = (l, c, d) => { if (c) { pass++; console.log("  ok    " + l); }
  else { fail++; console.log("  FAIL  " + l + (d ? "\n          → " + d : "")); } return c; };
const sec = (t) => console.log(`\n${"═".repeat(66)}\n  ${t}\n${"═".repeat(66)}`);

const ID = (n) => crypto.createHash("md5").update("step6:" + n).digest("hex")
  .replace(/^(.{8})(.{4})(.{4})(.{4})(.{12}).*$/, "$1-$2-$3-$4-$5");
const ORG = ID("org"), PROP = ID("prop"), TECH = ID("tech");

/*  Compile a variant of maintenance.js in memory for the falsification.
 *  The file on disk is never edited; its digest is re-checked at the end. */
function loadVariant(edits) {
  let src = fs.readFileSync(MAINT, "utf8");
  for (const { from, to } of edits) {
    if (!src.includes(from)) {
      throw new Error("FALSIFICATION TARGET NOT FOUND — the mutation matched nothing, " +
                      "so it proves nothing: " + from.slice(0, 70));
    }
    src = src.split(from).join(to);
  }
  const m = new Module(MAINT, null);
  m.filename = MAINT;
  m.paths = Module._nodeModulePaths(path.dirname(MAINT));
  m._compile(src, MAINT);
  return m.exports;
}

function serve(routerFactory, pool) {
  //  Built exactly as server.js builds it. An earlier revision passed the
  //  work-order MODULE where the router wanted a SERVICE INSTANCE, and the
  //  router refused — which is the mount contract doing its job, and is
  //  also why this proof constructs the real dependency graph rather than
  //  a convenient stub. A proof against a stubbed mount is a proof about
  //  the stub.
  const { spawnObligationFromEvent, satisfyObligation } =
    require(path.join(ROOT, "src/shared/obligation_engine.js"));
  const { transitionObligation } =
    require(path.join(ROOT, "src/shared/obligation_transitions.js"));
  const { makeWorkOrderService } = require(path.join(ROOT, "src/maintenance/work_order_service.js"));
  const workOrderService = makeWorkOrderService({
    spawnObligationFromEvent, satisfyObligation, transitionObligation });
  const app = express();
  app.use(express.json());
  app.use("/", routerFactory({ pool, spawnObligationFromEvent, workOrderService }));
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

//  A real request over a real socket.
function request(port, method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({ host: "127.0.0.1", port, method, path: urlPath,
      headers: payload ? { "content-type": "application/json", "content-length": payload.length } : {} },
      (res) => {
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
  if (!URL) { console.error("REFUSED: STEP6_DATABASE_URL is not set."); process.exit(1); }
  const pool = new Pool({ connectionString: URL });
  const c = await pool.connect();

  const sentinel = Number((await c.query(
    `select count(*) n from release_0_scale_harness_guard where purpose like 'ISOLATED RELEASE 0%'`
  ).catch(() => ({ rows: [{ n: 0 }] }))).rows[0].n);
  if (sentinel !== 1) { console.error("REFUSED: not the isolated baseline."); process.exit(2); }

  const ledger = (await c.query(`select max(version) v from schema_migrations`)).rows[0].v;
  if (ledger !== "137") {
    console.error(`REFUSED: ledger is ${ledger}, expected 137. Apply the migration first.`);
    process.exit(2);
  }

  console.log("STEP 6 — LEGACY DONE-PATH CLOSED, PROVEN THROUGH REAL HTTP\n");

  await c.query(`insert into organizations (id,name) values ($1,'Step6 Org') on conflict (id) do nothing`, [ORG]);
  await c.query(`insert into properties (id,name,organization_id) values ($1,'Step6 Property',$2)
                 on conflict (id) do nothing`, [PROP, ORG]);
  await c.query(`insert into users (id,name,phone,role,is_active)
                 values ($1,'Sal Step6','+15415559301','maintenance',true) on conflict (id) do nothing`, [TECH]);
  await c.query(`insert into property_team_assignments (user_id,property_id,role_title,active)
                 values ($1,$2,'Maintenance Tech',true)`, [TECH, PROP]).catch(() => {});

  let seq = 0;
  const mkWo = async () => {
    const wo = ID("wo" + (++seq));
    await c.query(`insert into work_orders (id,property_id,title,status,source)
                   values ($1,$2,'step6','open','step6proof')`, [wo, PROP]);
    await c.query(`insert into obligations (property_id,related_id,related_type,module,type,label,status)
                   values ($1,$2,'work_order','maintenance','work_order_routing','r','open')`, [PROP, wo]);
    return wo;
  };

  //  EVERYTHING a refused request must not have moved.
  const census = async (wo) => {
    const n = async (s, p = [wo]) => Number((await c.query(s, p)).rows[0].n);
    return {
      status: (await c.query(`select status from work_orders where id=$1`, [wo])).rows[0].status,
      photo:  (await c.query(`select completion_photo from work_orders where id=$1`, [wo])).rows[0].completion_photo,
      events: await n(`select count(*) n from events where note like '%'||$1||'%'`),
      progress: await n(`select count(*) n from work_order_progress where work_order_id=$1`),
      evals: await n(`select count(*) n from work_order_proof_evaluations where work_order_id=$1`),
      obligationsOpen: await n(`select count(*) n from obligations
                                 where related_type='work_order' and related_id=$1 and status='open'`),
    };
  };
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  const real = require(MAINT);
  const { server, port } = await serve(real, pool);

  // ══ R — THE REFUSALS ═══════════════════════════════════════════════
  sec("R · THE LEGACY DONE-PATH REFUSES, AND WRITES NOTHING");

  //  The request a legacy app has always sent: a stub photo and a note.
  {
    const wo = await mkWo();
    const before = await census(wo);
    const r = await request(port, "PATCH", `/work-orders/${wo}/closeout`,
      { done: true, completion_photo: `stub://closeout-photo/${wo}/1`, completion_note: "cleared the drain" });
    const after = await census(wo);

    ok("R1  the exact legacy request is REFUSED with 409", r.status === 409,
       "status " + r.status + " — the legacy path can still complete work. STOP.");
    ok("R2  …named as a retirement, not as missing proof",
       r.body && r.body.error === "legacy_completion_retired",
       JSON.stringify(r.body && r.body.error) +
       " — a caller cannot tell a retired path from a validation failure");
    ok("R3  …and it NAMES the canonical path",
       !!(r.body && r.body.canonical_path && /claimCompletion/.test(r.body.canonical_path)),
       "a refusal that does not say what to do instead is a dead end");
    ok("R4  …and it names what STILL works on this route",
       !!(r.body && r.body.still_available && /done=false/.test(r.body.still_available)));
    ok("R5  NOTHING WAS WRITTEN — full census identical before and after",
       same(before, after), JSON.stringify({ before, after }));
    console.log("        census: " + JSON.stringify(after));
  }

  //  A caller that omits `done` entirely. The route defaults it to true,
  //  so this is the same verb by another spelling and must refuse too.
  {
    const wo = await mkWo();
    const before = await census(wo);
    const r = await request(port, "PATCH", `/work-orders/${wo}/closeout`,
      { completion_photo: `stub://x/${wo}`, completion_note: "n" });
    const after = await census(wo);
    ok("R6  a caller that OMITS `done` is refused too (it defaults to true)",
       r.status === 409 && r.body && r.body.error === "legacy_completion_retired",
       "status " + r.status + " — an old client would still complete work");
    ok("R7  …and wrote nothing", same(before, after), JSON.stringify({ before, after }));
  }

  //  And the case that used to 409 for a DIFFERENT reason. It must now
  //  refuse for the retirement reason — otherwise the two are confusable
  //  and an operator is told to attach a photo that would not help.
  {
    const wo = await mkWo();
    const r = await request(port, "PATCH", `/work-orders/${wo}/closeout`, { done: true });
    ok("R8  a done-request with NO photo/note refuses as RETIRED, not as unproven",
       r.status === 409 && r.body && r.body.error === "legacy_completion_retired",
       JSON.stringify(r.body) +
       "\n          → telling an operator to attach a photo implies one would work");
  }

  // ══ P — THE PAIRED CONTROL ═════════════════════════════════════════
  sec("P · THE NOT-DONE PATH IS UNTOUCHED — the 409 is a verb, not an outage");
  {
    const wo = await mkWo();
    const r = await request(port, "PATCH", `/work-orders/${wo}/closeout`,
      { done: false, not_done_reason: "other", completion_note: "needs a part" });
    const after = await census(wo);
    ok("P1  done=false still SUCCEEDS on the same route", r.status === 200,
       "status " + r.status + " " + JSON.stringify(r.body) +
       "\n          → then the 409 above may be a dead route, not a governed refusal");
    ok("P2  …the work order is routed, not closed",
       after.status === "needs_followup", after.status);
    ok("P3  …and a follow-up obligation was actually created",
       !!(r.body && r.body.followup_created && r.body.followup_obligation),
       JSON.stringify(r.body && r.body.followup_created));

    const bad = await mkWo();
    const rb = await request(port, "PATCH", `/work-orders/${bad}/closeout`,
      { done: false, not_done_reason: "not_a_real_reason" });
    ok("P4  an invalid reason still refuses with 400 — unchanged behaviour",
       rb.status === 400 && rb.body && rb.body.error === "invalid not_done_reason",
       "status " + rb.status);
  }

  // ══ C — THE CANONICAL PATH STILL COMPLETES ═════════════════════════
  sec("C · THE ONE REMAINING PATH STILL WORKS");
  {
    //  Closing the legacy door is only correct if the canonical door is
    //  open. Proven in the same process, against the same database.
    const lifecycle = require(path.join(ROOT, "src/technician/lifecycle_service.js"));
    const wo = await mkWo();
    const att = ID("att" + wo.slice(0, 8)), bytes = Buffer.from([3, 3, 3, 3]);
    await c.query(`insert into work_order_proof_attachments
      (id,work_order_id,property_id,uploaded_by_user_id,provider,provider_media_id,mime_type,
       storage_state,proof_classification,content,byte_size,sha256,stored_at)
      values ($1,$2,$3,$4,'twilio',$5,'image/jpeg','stored','repair_photo',$6,$7,$8,now())`,
      [att, wo, PROP, TECH, "ME" + att.slice(0, 8), bytes, bytes.length,
       crypto.createHash("sha256").update(bytes).digest("hex")]);

    const cc = await pool.connect();
    let out = null, err = null;
    await cc.query("begin");
    try {
      out = await lifecycle.claimCompletion(cc, {
        work_order_id: wo, user_id: TECH, organization_id: ORG, idempotency_key: "step6-canon" });
      await cc.query("commit");
    } catch (e) { err = e; await cc.query("rollback").catch(() => {}); }
    cc.release();
    const after = await census(wo);

    ok("C1  the canonical writer still completes a work order",
       !err && out && out.closed === true && after.status === "complete",
       (err && err.message) || JSON.stringify({ closed: out && out.closed, st: after.status }));
    ok("C2  …with the proof evaluation the legacy path never wrote",
       after.evals === 1, String(after.evals));
    ok("C3  …and the obligation closed", after.obligationsOpen === 0, String(after.obligationsOpen));
  }

  // ══ F — FALSIFICATION ══════════════════════════════════════════════
  sec("F · FALSIFICATION — remove the guard and watch the old path complete");
  {
    /*  If removing the guard does NOT complete a work order, then the
     *  guard is not what is stopping it and R1–R8 prove something else.
     *  The variant is compiled in memory; the file on disk is untouched. */
    const variant = loadVariant([
      { from: "if (done !== false) {", to: "if (false) {" },
    ]);
    const v = await serve(variant, pool);
    const wo = await mkWo();
    const before = await census(wo);
    const r = await request(v.port, "PATCH", `/work-orders/${wo}/closeout`,
      { done: true, completion_photo: `stub://closeout-photo/${wo}/2`, completion_note: "note" });
    const after = await census(wo);
    v.server.close();

    ok("F1  WITHOUT the guard, the legacy request closes the work order",
       r.status === 200 && after.status === "closed",
       "status " + r.status + " wo=" + after.status +
       " — the guard is not what stops it, so R1–R8 prove something else");
    ok("F2  …and it does so with NO proof evaluation — the state Release 0 forbids",
       after.evals === 0 && after.progress === 0,
       JSON.stringify({ evals: after.evals, progress: after.progress }));
    ok("F3  …on a stub:// photo with no bytes behind it",
       typeof after.photo === "string" && after.photo.startsWith("stub://"),
       String(after.photo));
    console.log("        before: " + JSON.stringify(before));
    console.log("        after:  " + JSON.stringify(after));
  }

  sec("SOURCE");
  ok("Z1  maintenance.js is byte-identical to before this run",
     crypto.createHash("sha256").update(fs.readFileSync(MAINT)).digest("hex") === MAINT_DIGEST);

  sec("VERDICT");
  console.log(`  passed ${pass}   failed ${fail}`);
  server.close();
  c.release();
  await pool.end();
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error("\nERROR:\n" + (e && e.stack || e)); process.exit(1); });
