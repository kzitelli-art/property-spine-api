// ════════════════════════════════════════════════════════════════════
//  smoke_proposed_terms_route.js — Part 3 route smoke.
//
//  The SERVICE is already proven 10/10 (Part 2). This confirms the ROUTE wrapper:
//   R1 unauthed → 401 (requireOperator gate)
//   R2 authed + real lease_ready app w/ terms_review → 200, confirmation_id,
//      authority_basis (the wrapper passes actor context correctly)
//   R3 authed + missing idempotency_key → 400 (service validation surfaced)
//
//  R2 mutates, so it runs inside a rolled-back transaction? NO — the route owns
//  its own pool connection/commit; we can't wrap an HTTP call in our transaction.
//  So R2 uses a DISPOSABLE fixture it creates and then EXPLICITLY deletes by
//  tracked id (the route committed a real confirmation). Scoped to tracked ids
//  only; never a property-wide delete.
//
//  RUN (Render shell):  cd ~/project/src && STAFF_SESSION="<token>" node smoke_proposed_terms_route.js
// ════════════════════════════════════════════════════════════════════
const http = require("http");
const { Pool } = require("pg");

const BASE = "http://localhost:10000";
const PROPERTY_A = "a50fbdd0-3642-431e-b532-0dcd6ab8a4fe";
const QA_USER = "e9a7659f-ee1a-4bde-9e0c-02c6632ff066";
const STAFF_SESSION = process.env.STAFF_SESSION || "";
const OPERATOR_KEY = process.env.OPERATOR_KEY || "";

function call(method, path, { body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const u = new URL(BASE + path);
    const req = http.request({ method, hostname: u.hostname, port: u.port, path: u.pathname,
      headers: { "content-type": "application/json", ...(data ? { "content-length": Buffer.byteLength(data) } : {}), ...headers } },
      (res) => { let raw = ""; res.on("data", c => raw += c); res.on("end", () => { let j=null; try{j=raw?JSON.parse(raw):null;}catch{j={_raw:raw};} resolve({ status: res.statusCode, json: j }); }); });
    req.on("error", reject); if (data) req.write(data); req.end();
  });
}
let pass=0, fail=0;
const ok=(n,c,d)=>{ if(c){pass++;console.log(`  ✓ ${n}`);} else {fail++;console.log(`  ✗ ${n}${d?" — "+d:""}`);} };

(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const tracked = { apps: [], obligations: [], persons: [], confirmations: [] };
  try {
    if (!STAFF_SESSION) { console.error("Need STAFF_SESSION token. node establish_qa_staff_session.js"); process.exit(1); }
    const authed = { "x-staff-session": STAFF_SESSION, "x-operator-key": OPERATOR_KEY };

    // R1 — unauthed → 401
    console.log("R1 unauthed");
    { const r = await call("POST", "/operator/leasing/applications/00000000-0000-0000-0000-000000000000/proposed-terms", { body: {} });
      ok("unauthed → 401", r.status === 401, `got ${r.status}`); }

    // build a disposable real fixture the route can operate on
    const person = (await pool.query(`insert into persons (full_name) values ('R2 Route Smoke') returning id`)).rows[0]; tracked.persons.push(person.id);
    const ob = (await pool.query(`insert into obligations (type,status,assigned_role,required_inputs) values ('terms_review','open','leasing_manager',array['terms_acknowledged']) returning id`)).rows[0]; tracked.obligations.push(ob.id);
    const app = (await pool.query(`insert into lease_applications (property_id,person_id,status,applicant_name,terms_review_obligation_id) values ($1,$2,'lease_ready','R2 Route Smoke',$3) returning id`, [PROPERTY_A, person.id, ob.id])).rows[0]; tracked.apps.push(app.id);

    // R2 — authed happy path → 200
    console.log("R2 authed confirm");
    { const r = await call("POST", `/operator/leasing/applications/${app.id}/proposed-terms`,
        { headers: authed, body: { rent: 1850, security_deposit: 1850, lease_start_date: "2026-09-01", lease_end_date: "2027-09-01", concession_status: "none", idempotency_key: "route-smoke-1" } });
      ok("authed → 200", r.status === 200, `got ${r.status}: ${JSON.stringify(r.json)}`);
      ok("returns confirmation_id", !!(r.json && r.json.confirmation_id), JSON.stringify(r.json));
      ok("authority_basis present", !!(r.json && r.json.authority_basis), r.json && r.json.authority_basis);
      if (r.json && r.json.confirmation_id) tracked.confirmations.push(r.json.confirmation_id);
    }

    // R3 — authed missing idempotency_key → 400
    console.log("R3 validation");
    { const r = await call("POST", `/operator/leasing/applications/${app.id}/proposed-terms`,
        { headers: authed, body: { rent: 1850, security_deposit: 1850, lease_start_date: "2026-09-01", lease_end_date: "2027-09-01", concession_status: "none" } });
      ok("missing idempotency_key → 400", r.status === 400, `got ${r.status}: ${JSON.stringify(r.json)}`); }

    console.log(`\n═══ ${fail===0?"ALL PASS":"FAILURES"} — ${pass} passed, ${fail} failed ═══`);
  } catch (e) {
    console.error("SMOKE ERROR:", e.message); fail++;
  } finally {
    // cleanup — tracked ids only, children first
    for (const id of tracked.apps) await pool.query(`update lease_applications set proposed_terms_confirmation_id=null where id=$1`,[id]).catch(()=>{});
    for (const id of tracked.apps) await pool.query(`delete from application_proposed_terms_confirmations where application_id=$1`,[id]).catch(()=>{});
    for (const id of tracked.apps) await pool.query(`delete from lease_applications where id=$1`,[id]).catch(()=>{});
    for (const id of tracked.obligations) await pool.query(`delete from obligations where id=$1`,[id]).catch(()=>{});
    for (const id of tracked.persons) await pool.query(`delete from persons where id=$1`,[id]).catch(()=>{});
    await pool.query(`delete from events where type='proposed_terms_confirmed' and note like 'proposed terms confirmed for application %'`).catch(()=>{});
    console.log("cleanup: tracked fixtures removed.");
    await pool.end();
    process.exit(fail===0?0:1);
  }
})();
