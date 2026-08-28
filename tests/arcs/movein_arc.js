// ════════════════════════════════════════════════════════════════════
//  movein_arc.js — walk the EXISTING QA person from application → occupied.
//
//  Builds on the person the live-200 arc already created:
//    person ede3fe95-457f-4100-a505-d8fae6390013
//    conversion 82ceab01-... (active, tour_followup, intent recorded)
//
//  CHAIN (each rung a real canonical route; halts at first non-2xx):
//    1. application create → POST /properties/:propertyId/applications
//    2. approve            → POST /operator/leasing/applications/:id/approve
//    3. sign               → POST /applications/:id/sign
//    4. countersign        → POST /operator/leasing/applications/:id/countersign
//    5. confirm-term       → POST /operator/leasing/applications/:id/confirm-term
//                            (writes person-keyed pending lease + spawns move-in)
//    6. read the spawned move-in obligation from the DB
//    7. satisfy ops gates  → POST /movein/:obligationId/satisfy   (per gate)
//    8. approve rent-ready → POST /movein/:obligationId/approve   → occupied
//    9. verify: units.occupancy_status='occupied' + lease.tenant_ids has our person
//               + rent roll would read this person (unnest(tenant_ids))
//
//  CLASS 3 test/demo infra. Drives canonical routes; hand-injects nothing.
//  Reads every id from the DB — never types a UUID (tonight's lesson).
//  Dual-auth: x-operator-key (legacy leasing_leads routes) + x-staff-session
//  (canonical operator.js routes) — the arc crosses both regimes.
//
//  RUN (Render Web Shell, by PATH):
//    cd ~/project/src
//    STAFF_SESSION="<fresh token from establish_qa_staff_session.js>" node movein_arc.js
//  OPERATOR_KEY is read from the shell env (already set).
//
//  ── EXPECTED HALTS (not bugs — contracts to satisfy, like the 200 arc) ──
//   • countersign/confirm-term run behind dormantWriteGuard + activationPerimeter.
//     If they 403/409 "dormant"/"not activated", they need an activation env
//     (check: ACTIVATION_PROPERTY_IDS / COMMITMENT_LEDGER_MODE — verify live,
//     same shape as APPLICATION_INTENT_PREPARE_ENABLED was). This is a KNOWN gate,
//     not a defect. Read the halt body; set the env; re-run (idempotent).
//   • confirm-term needs start_date/end_date/rent/security_deposit (set below).
//   • move-in approve needs approved_by_person_id (we pass the QA operator user).
//   • the app needs a unit_id for the move-in event to spawn (confirm-term's
//     Slice-D block is `if (app.unit_id)`) — we resolve an available unit below.
// ════════════════════════════════════════════════════════════════════
const http = require("http");
const { Pool } = require("pg");

const BASE = "http://localhost:10000";
const PROPERTY_ID = "a50fbdd0-3642-431e-b532-0dcd6ab8a4fe";
const PERSON_ID = "ede3fe95-457f-4100-a505-d8fae6390013";
const QA_OPERATOR_USER = "e9a7659f-ee1a-4bde-9e0c-02c6632ff066";
const STAFF_SESSION = process.env.STAFF_SESSION || "";
const OPERATOR_KEY = process.env.OPERATOR_KEY || "";

function call(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const u = new URL(BASE + path);
    const req = http.request(
      { method, hostname: u.hostname, port: u.port, path: u.pathname,
        headers: { "content-type": "application/json",
          ...(data ? { "content-length": Buffer.byteLength(data) } : {}),
          "x-staff-session": STAFF_SESSION, "x-operator-key": OPERATOR_KEY } },
      (res) => { let raw = ""; res.on("data", c => raw += c);
        res.on("end", () => { let j = null; try { j = raw ? JSON.parse(raw) : null; } catch { j = { _raw: raw }; }
          resolve({ status: res.statusCode, json: j }); }); });
    req.on("error", reject); if (data) req.write(data); req.end();
  });
}
const ok = s => s >= 200 && s < 300;

(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const halt = async (step, status, json, extra) => {
    console.error(`\n✗ HALTED at: ${step}\n  HTTP ${status}\n  body: ${JSON.stringify(json)}`);
    if (extra) console.error("  " + extra);
    await pool.end(); process.exit(1);
  };

  console.log("═══ MOVE-IN ARC (application → occupied) ═══");
  if (!STAFF_SESSION || !OPERATOR_KEY) {
    console.error("Need STAFF_SESSION (arg) and OPERATOR_KEY (env). Mint: node establish_qa_staff_session.js");
    await pool.end(); process.exit(1);
  }

  // ── PRE-FLIGHT: the countersign/confirm-term PERIMETER is fail-closed on two
  //    env vars. Its refusal is deliberately OPAQUE ("not permitted") and only
  //    audits the real reason server-side — so check here and fail LOUD before
  //    any write, turning a silent mid-arc 403 into a clear upfront fix.
  //    Gate 1: COMMITMENT_LEDGER_MODE must be exactly 'enabled' (default dormant).
  //    Gate 2: ACTIVATION_PROPERTY_IDS must contain this property (comma-sep).
  const ledgerMode = process.env.COMMITMENT_LEDGER_MODE || "(unset)";
  const activationIds = (process.env.ACTIVATION_PROPERTY_IDS || "").split(",").map(s => s.trim()).filter(Boolean);
  const modeOk = ledgerMode === "enabled";
  const propActivated = activationIds.includes(PROPERTY_ID);
  console.log(`preflight: COMMITMENT_LEDGER_MODE=${ledgerMode}  ${modeOk ? "✓" : "✗"}`);
  console.log(`preflight: ACTIVATION_PROPERTY_IDS has demo bldg = ${propActivated ? "✓" : "✗"}`);
  if (!modeOk || !propActivated) {
    console.error("\n✗ PERIMETER NOT OPEN — countersign/confirm-term will 403 opaquely. Set on Render, redeploy, re-run:");
    if (!modeOk) console.error("    COMMITMENT_LEDGER_MODE=enabled");
    if (!propActivated) console.error(`    ACTIVATION_PROPERTY_IDS=${[...activationIds, PROPERTY_ID].join(",")}`);
    console.error("  (Steps 1-3 would run, but the arc stops at countersign. Fixing now = one clean pass.)");
    console.error("  NOTE: these open the tenancy-anchor perimeter for the DEMO BUILDING only. Class-2 config.");
    await pool.end(); process.exit(1);
  }
  console.log("preflight: perimeter OPEN ✓");

  // ── resolve an available unit for this property (move-in needs app.unit_id) ──
  const unit = (await pool.query(
    `select id, unit_number from units
      where property_id=$1 and coalesce(occupancy_status,'') <> 'occupied'
      order by unit_number limit 1`, [PROPERTY_ID])).rows[0];
  if (!unit) await halt("resolve-unit", 0, {}, "No non-occupied unit on the property to move into.");
  console.log(`unit=${unit.id} (#${unit.unit_number})`);

  // dates: start 7 days out (inside a typical delivery window → real 'high' severity)
  const start = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
  const end = new Date(Date.now() + 372 * 86400000).toISOString().slice(0, 10);

  // ── 1. application create ──
  console.log("\n[1] application create");
  const appRes = await call("POST", `/properties/${PROPERTY_ID}/applications`, {
    applicant_name: "QA Lifecycle Tester", person_id: PERSON_ID, unit_id: unit.id, rent: 1850, deposit: 1850,
  });
  if (!ok(appRes.status)) await halt("application-create", appRes.status, appRes.json);
  // read the app id back from the DB (don't trust/​type it)
  const app = (await pool.query(
    `select id, status from lease_applications where person_id=$1 and property_id=$2 order by created_at desc limit 1`,
    [PERSON_ID, PROPERTY_ID])).rows[0];
  console.log(`  ✓ application=${app.id} status=${app.status}`);

  // ── 2. approve ──
  console.log("\n[2] approve");
  const appr = await call("POST", `/operator/leasing/applications/${app.id}/approve`, { note: "QA arc approve" });
  if (!ok(appr.status)) await halt("approve", appr.status, appr.json);
  console.log(`  ✓ ${appr.json.receipt || "approved"}`);

  // ── 3. sign ──
  console.log("\n[3] sign");
  const sign = await call("POST", `/applications/${app.id}/sign`, { signed_by: "QA Lifecycle Tester" });
  if (!ok(sign.status)) await halt("sign", sign.status, sign.json);
  console.log(`  ✓ ${sign.json.receipt || "signed"}`);

  // ── 4. countersign (perimeter — may need activation env; see header) ──
  console.log("\n[4] countersign");
  const cs = await call("POST", `/operator/leasing/applications/${app.id}/countersign`, { note: "QA arc countersign" });
  if (!ok(cs.status)) await halt("countersign", cs.status, cs.json,
    "If 'dormant'/'not activated': this is the KNOWN perimeter gate. Check ACTIVATION_PROPERTY_IDS / COMMITMENT_LEDGER_MODE live, set it, re-run.");
  console.log(`  ✓ ${cs.json.receipt || "countersigned"}`);

  // ── 5. confirm-term → pending lease + move-in spawn ──
  console.log("\n[5] confirm-term (writes person-keyed lease + spawns move-in)");
  const ct = await call("POST", `/operator/leasing/applications/${app.id}/confirm-term`, {
    start_date: start, end_date: end, rent: 1850, security_deposit: 1850, confirmed_by: QA_OPERATOR_USER,
  });
  if (!ok(ct.status)) await halt("confirm-term", ct.status, ct.json,
    "Same perimeter family as countersign if it gates. Otherwise check the body fields.");
  console.log(`  ✓ ${ct.json.receipt || JSON.stringify(ct.json)}`);
  const lease = (await pool.query(
    `select id, lease_status, tenant_ids, space_id from leases where application_id=$1 limit 1`, [app.id])).rows[0];
  console.log(`  lease=${lease.id} status=${lease.lease_status} tenant_ids=${JSON.stringify(lease.tenant_ids)}`);
  const bridgeOk = Array.isArray(lease.tenant_ids) && lease.tenant_ids.includes(PERSON_ID);
  console.log(`  PERSON→LEASE BRIDGE: ${bridgeOk ? "✓ person is on the lease" : "✗ person NOT on lease"}`);

  // ── 6. read the spawned move-in delivery obligation ──
  console.log("\n[6] locate move_in_delivery obligation");
  const mo = (await pool.query(
    `select id, status, required_inputs, unit_id from obligations
      where related_id=$1 and related_type='lease' and type='move_in_delivery'
      order by created_at desc limit 1`, [lease.id])).rows[0];
  if (!mo) await halt("find-movein-obligation", 0, {},
    "confirm-term did not spawn move_in_delivery. Check: did the app carry unit_id? (Slice-D block is `if(app.unit_id)`.)");
  console.log(`  ✓ obligation=${mo.id} status=${mo.status} required_inputs=${JSON.stringify(mo.required_inputs)}`);

  // ── 7. satisfy the 4 operational gates (maintenance clears readiness) ──
  //    Real contract (movein.js): body field is `gate` (not `input`); the 4 gates
  //    are fixed; the 5th (rent_ready_approval) is the approve step and is HARD-
  //    refused until all 4 are satisfied. Order matters.
  console.log("\n[7] satisfy 4 operational gates");
  const OPERATIONAL_GATES = ["readiness_checklist", "appliances_checked", "unit_condition_photos", "keys_access_ready"];
  for (const gate of OPERATIONAL_GATES) {
    const s = await call("POST", `/movein/${mo.id}/satisfy`, { gate, proof: { note: "QA arc: ops gate cleared" } });
    if (!ok(s.status)) await halt(`satisfy:${gate}`, s.status, s.json,
      "Gate name must be one of the 4 operational gates; body field is `gate`.");
    console.log(`  ✓ satisfied ${gate}`);
  }

  // ── 8. approve rent-ready → completes obligation → occupancy flip ──
  //    approved_by_person_id wants a PERSON id. The QA_OPERATOR_USER is a USER id;
  //    resolve its bridged person (users.person_id) if one exists, else fall back
  //    to the user id (approve passes it straight to completeObligation.completed_by,
  //    which doesn't hard-FK to persons — but use the honest person id when we have it).
  const bridged = (await pool.query(`select person_id from users where id=$1`, [QA_OPERATOR_USER])).rows[0];
  const approverId = (bridged && bridged.person_id) ? bridged.person_id : QA_OPERATOR_USER;
  console.log(`\n[8] approve rent-ready → occupied  (approver person=${approverId}${bridged && bridged.person_id ? " [bridged]" : " [user-id fallback, unbridged]"})`);
  const mvApprove = await call("POST", `/movein/${mo.id}/approve`, { approved_by_person_id: approverId, note: "QA arc rent-ready" });
  if (!ok(mvApprove.status)) await halt("movein-approve", mvApprove.status, mvApprove.json,
    "If 409 'operational readiness not complete': step 7 missed a gate — read operational_gates_outstanding in the body.");
  console.log(`  ✓ ${mvApprove.json.unit_note || mvApprove.json.receipt || JSON.stringify(mvApprove.json)}`);

  // ── 9. verify occupancy + bridge end to end ──
  console.log("\n[9] verify");
  const u2 = (await pool.query(`select occupancy_status from units where id=$1`, [unit.id])).rows[0];
  const poss = (await pool.query(
    `select count(*)::int n from unit_events where lease_id=$1 and event_type ilike '%move_in%'`, [lease.id])).rows[0];
  console.log(`  units.occupancy_status = ${u2.occupancy_status}`);
  console.log(`  move_in unit_events for lease = ${poss.n}`);
  console.log(`  rent roll reads this person via unnest(tenant_ids): ${bridgeOk ? "YES" : "NO"}`);

  const done = u2.occupancy_status === "occupied" && bridgeOk;
  console.log(`\n═══ ${done ? "ARC COMPLETE — occupied, person-keyed, bridge proven" : "ARC INCOMPLETE — see above"} ═══`);
  console.log(`person=${PERSON_ID} app=${app.id} lease=${lease.id} unit=${unit.id}`);
  await pool.end();
})().catch(e => { console.error("\n✗ UNCAUGHT:", e.message); process.exit(1); });
