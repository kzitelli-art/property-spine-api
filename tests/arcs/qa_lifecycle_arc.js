// ════════════════════════════════════════════════════════════════════
//  qa_lifecycle_arc.js — build ONE internal_qa demo-lifecycle person
//  through the CANONICAL doors, end to end, and prove the live 200 birth.
//
//  ARC (halts at the first non-green step; every id is threaded internally,
//  never retyped):
//    1. intake   → POST /leasing/intake            (person + lead + conversation)
//    2. enroll   → enrollInternalQa() [canonical fn; no HTTP route exists yet —
//                  see the note below] → current internal_qa + opted_in consent
//    3. book     → POST /leasing/slots/:slotId/book (real open slot → tour)
//    4. complete → POST /operator/leasing/tours/:tourId/complete
//                  (spawns the open tour_followup rung — the birth hook)
//    5. birth    → POST /operator/leasing/application-intent  → EXPECT 200
//
//  CLASS: Class 3 test/demo infrastructure. It DRIVES the canonical services;
//  it hand-injects NOTHING (no manual classification row, no forced state).
//  The one in-process call (enrollInternalQa) is the SAME canonical function
//  the boundary uses — not a reimplementation — because there is no session-
//  authed enroll route yet. NAMED FOLLOW-UP (queued, not tonight): add
//  POST /operator/qa/enroll wrapping enrollInternalQa behind requireOperator,
//  so this becomes a route call like every other governed write.
//
//  RUN (from the Render Web Shell, by PATH so it finds node_modules):
//    cd ~/project/src
//    STAFF_SESSION="<token>" node qa_lifecycle_arc.js
//  (STAFF_SESSION = the x-staff-session token from establish_qa_staff_session.js;
//   12h lifetime. If omitted, the script tells you to mint one and stops before
//   any write.)
// ════════════════════════════════════════════════════════════════════
const http = require("http");

const BASE = process.env.ARC_BASE || "http://localhost:10000";
const PROPERTY_ID = "a50fbdd0-3642-431e-b532-0dcd6ab8a4fe";     // Demo Building
const QA_OPERATOR_USER = "e9a7659f-ee1a-4bde-9e0c-02c6632ff066"; // QA operator user
const QA_PHONE = process.env.QA_PHONE || "+17243098434";
const QA_NAME = process.env.QA_NAME || "QA Lifecycle Tester";
const INTAKE_SECRET = process.env.LEASING_INTAKE_SECRET || "2026letsgo";
const STAFF_SESSION = process.env.STAFF_SESSION || "";

// ── tiny HTTP helper (localhost, in-shell — avoids the egress wall) ──
function call(method, path, { body = null, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const u = new URL(BASE + path);
    const req = http.request(
      { method, hostname: u.hostname, port: u.port, path: u.pathname + u.search,
        headers: { "content-type": "application/json", ...(data ? { "content-length": Buffer.byteLength(data) } : {}), ...headers } },
      (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => {
          let json = null; try { json = raw ? JSON.parse(raw) : null; } catch { json = { _raw: raw }; }
          resolve({ status: res.statusCode, json });
        });
      });
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

function ok(status) { return status >= 200 && status < 300; }
function halt(step, status, json) {
  console.error(`\n✗ HALTED at step: ${step}`);
  console.error(`  HTTP ${status}`);
  console.error(`  body: ${JSON.stringify(json)}`);
  console.error(`\nNothing after this ran. Fix this step, re-run — earlier steps are idempotent`);
  console.error(`(intake reuses the open opportunity for this phone; enroll supersedes append-only).`);
  process.exit(1);
}

(async () => {
  const { Pool } = require("pg");
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

  console.log("═══ QA DEMO-LIFECYCLE ARC ═══");
  console.log(`base=${BASE}  property=${PROPERTY_ID}  phone=${QA_PHONE}`);

  if (!STAFF_SESSION) {
    console.error("\n✗ No STAFF_SESSION token. Steps 4-5 (complete, birth) need an operator session.");
    console.error("  Mint one:  node establish_qa_staff_session.js");
    console.error("  Then:      STAFF_SESSION=<token> node qa_lifecycle_arc.js");
    console.error("  (Stopping BEFORE any write so the arc runs clean in one pass.)");
    await pool.end();
    process.exit(1);
  }
  // Two operator-auth regimes cross this arc: the leasing_leads.js routes
  // (book, complete) still use the LEGACY shared OPERATOR_KEY (x-operator-key);
  // the operator.js application-intent route uses the CANONICAL per-user
  // session (x-staff-session). Send both so each route finds what it needs.
  // (The legacy→canonical consolidation is a separate, known seam — not this arc.)
  const OPERATOR_KEY = process.env.OPERATOR_KEY || "";
  if (!OPERATOR_KEY) {
    console.error("\n✗ No OPERATOR_KEY in env. The leasing_leads book/complete routes need x-operator-key.");
    console.error("  It's already set in Render — run with it in scope:");
    console.error("  OPERATOR_KEY=\"$OPERATOR_KEY\" STAFF_SESSION=\"<token>\" node qa_lifecycle_arc.js");
    await pool.end(); process.exit(1);
  }
  const authed = { "x-staff-session": STAFF_SESSION, "x-operator-key": OPERATOR_KEY };

  // ── STEP 1: INTAKE ────────────────────────────────────────────────
  console.log("\n[1/5] intake → POST /leasing/intake");
  const intake = await call("POST", "/leasing/intake", {
    headers: { "x-intake-secret": INTAKE_SECRET },
    body: { property_id: PROPERTY_ID, phone: QA_PHONE, name: QA_NAME, source: "boardroom_demo", attempt_sms: false },
  });
  if (!ok(intake.status)) halt("intake", intake.status, intake.json);
  const { person_id, lead_id, conversation_id } = intake.json;
  console.log(`  ✓ person=${person_id}`);
  console.log(`    lead=${lead_id}  conversation=${conversation_id}`);
  console.log(`    reused_opportunity=${intake.json.reused_opportunity}  new_person=${intake.json.new_person}`);

  // ── STEP 2: ENROLL internal_qa (canonical fn; no route yet) ───────
  console.log("\n[2/5] enroll → enrollInternalQa() [canonical fn]");
  // The REAL boundary. tests/comm_boundary_harness.js was a duplicate of it
  // that had already drifted — it kept the retired internal_qa_autonomous mode
  // and the class checks removed on 2026-07-26. Deleted rather than updated:
  // a second copy of the module deciding who may be texted is a hazard, not a
  // convenience.
  const boundary = require("../../src/comms/communications_boundary.js")({ pool });
  let enroll;
  try {
    enroll = await boundary.enrollInternalQa({
      person_id, property_id: PROPERTY_ID, actor_user_id: QA_OPERATOR_USER,
      reason: "qa_demo_lifecycle_arc",
    });
  } catch (e) {
    console.error(`\n✗ HALTED at step: enroll\n  ${e.message}`);
    await pool.end(); process.exit(1);
  }
  console.log(`  ✓ ${enroll.receipt || "enrolled internal_qa + opted_in"}`);

  // ── STEP 3: BOOK a real open slot ─────────────────────────────────
  console.log("\n[3/5] book → pick an open slot → POST /leasing/slots/:slotId/book");
  const slot = (await pool.query(
    `select id, starts_at from tour_availability
      where property_id=$1 and status='open' and starts_at > now()
      order by starts_at limit 1`, [PROPERTY_ID])).rows[0];
  if (!slot) {
    console.error("\n✗ HALTED at step: book — no open future slot. (Boot seed should keep these; check the deploy log for '[slots] boot seed'.)");
    await pool.end(); process.exit(1);
  }
  console.log(`  slot=${slot.id}  starts_at=${slot.starts_at}`);
  const book = await call("POST", `/leasing/slots/${slot.id}/book`, { headers: authed, body: { lead_id } });
  if (!ok(book.status)) halt("book", book.status, book.json);
  const tour_id = book.json.tour_id;
  console.log(`  ✓ tour=${tour_id}  (funnel → tour_scheduled)`);

  // ── STEP 4: COMPLETE the tour → opens the conversion rail ────────
  //  tour_given defaults true; a real disposition ("start_application") is the
  //  honest read for a QA person heading to application. completeTourService
  //  RETURNS the conversion_id — which is exactly what the birth needs.
  console.log("\n[4/5] complete → POST /operator/leasing/tours/:tourId/complete");
  const complete = await call("POST", `/operator/leasing/tours/${tour_id}/complete`, {
    headers: authed,
    body: { feedback: { disposition: "start_application", notes: "QA lifecycle arc — tour given; heading to application." } },
  });
  if (!ok(complete.status)) halt("complete", complete.status, complete.json);
  const conversion_id = complete.json.conversion_id;
  console.log(`  ✓ tour completed → conversion=${conversion_id}`);
  console.log(`    ${complete.json.receipt || JSON.stringify(complete.json)}`);
  if (!conversion_id) halt("complete(no-conversion)", complete.status,
    { note: "completeTour returned no conversion_id — the rail didn't open. Birth needs it.", body: complete.json });

  // ── STEP 5: BIRTH the application intent → EXPECT 200 ─────────────
  //  The birth operates on the leasing_conversions row (conversion_id), NOT the
  //  conversation. An idempotency_key makes a re-run safe (already-recorded → still 200).
  console.log("\n[5/5] birth → POST /operator/leasing/application-intent (EXPECT 200)");
  const birth = await call("POST", "/operator/leasing/application-intent", {
    headers: authed,
    body: { conversion_id, idempotency_key: `qa-arc-${conversion_id}` },
  });
  if (!ok(birth.status)) halt("birth", birth.status, birth.json);
  console.log(`  ✓✓✓ LIVE 200 BIRTH`);
  console.log(`    recorded=${birth.json.recorded}  intent=${birth.json.intent_id}`);
  console.log(`    prepare_obligation=${birth.json.prepare_obligation_id}  parent=${birth.json.parent_obligation_id}`);
  console.log(`    ${birth.json.receipt || ""}`);

  console.log("\n═══ ARC COMPLETE — live 200 proven ═══");
  console.log(`person=${person_id}`);
  console.log(`lead=${lead_id}  conversation=${conversation_id}  tour=${tour_id}  conversion=${conversion_id}`);
  console.log("This is durable demo content: a real person, lead→tour→application, through the canonical doors.");
  await pool.end();
})().catch((e) => { console.error("\n✗ UNCAUGHT:", e.message); process.exit(1); });
