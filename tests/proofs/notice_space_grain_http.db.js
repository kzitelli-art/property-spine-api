#!/usr/bin/env node
/* ════════════════════════════════════════════════════════════════════
   notice_space_grain_http.db.js — CLASS 3 (test infrastructure).

   PROVES: a notice is given on a TENANCY, and on a by-bed unit each bed
   holds its own. Drives the REAL HTTP door against a REAL Postgres.

   Run:
     BASE=http://127.0.0.1:3111 OPERATOR_KEY=... \
     DATABASE_URL=postgresql://... node tests/notice_space_grain_http.db.js
   ════════════════════════════════════════════════════════════════════ */
"use strict";
const { Pool } = require("pg");
const receipt = require("../_run_receipt");

const HARNESS = __filename;
const EXPECTED = 37;
const BASE = process.env.BASE || "http://127.0.0.1:3111";
const KEY = process.env.OPERATOR_KEY || "proofkey";
//  This harness COMMITS fixtures and never cleans up, so it takes the
//  disposable-database guard every other DB harness here takes rather than
//  reading DATABASE_URL directly. gate_harness_isolation.js caught this file
//  as a new unguarded write-capable consumer on its first run; the gate was
//  right, and the fix is the existing guard, not an entry in the register.
const HARNESS_URL = receipt.harnessConnectionString();
const pool = new Pool({ connectionString: HARNESS_URL, ssl: false });

const P1 = "11111111-1111-1111-1111-111111111111";
const P2 = "11111111-1111-1111-1111-1111111111f2";
const UBED = "22222222-2222-2222-2222-222222222222";   // by-bed unit, P1
const UWHOLE = "22222222-2222-2222-2222-2222222222f0"; // whole-unit, P1
const UOTHER = "22222222-2222-2222-2222-2222222222f2"; // unit at P2
const A = "aaaaaaaa-0000-0000-0000-00000000000a";
const B = "bbbbbbbb-0000-0000-0000-00000000000b";
const SWHOLE = "dddddddd-0000-0000-0000-0000000000d0";
const SOTHER = "dddddddd-0000-0000-0000-0000000000f2";

let pass = 0, fail = 0; const failures = [];
function ok(name, cond, detail) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; failures.push(name); console.log(`  ✗ ${name}\n      ${detail || ""}`); }
}
const post = (p, body, hdrs) => fetch(BASE + p, {
  method: "POST",
  headers: Object.assign({ "content-type": "application/json", "x-operator-key": KEY }, hdrs || {}),
  body: JSON.stringify(body),
}).then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) }));
const get = (p, hdrs) => fetch(BASE + p, { headers: Object.assign({ "x-operator-key": KEY }, hdrs || {}) })
  .then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) }));

async function reseed() {
  const c = await pool.connect();
  try {
    await c.query("begin");
    await c.query("delete from unit_events where property_id = any($1)", [[P1, P2]]);
    await c.query("delete from leases where property_id = any($1)", [[P1, P2]]);
    await c.query("delete from spaces where unit_id = any($1)", [[UBED, UWHOLE, UOTHER]]);
    await c.query("delete from units where id = any($1)", [[UBED, UWHOLE, UOTHER]]);
    await c.query(`insert into properties (id,name) values ($1,'Proof P1'),($2,'Proof P2')
                   on conflict (id) do nothing`, [P1, P2]);
    await c.query(`insert into units (id,property_id,unit_number) values
                   ($1,$4,'4125'),($2,$4,'200'),($3,$5,'900')`, [UBED, UWHOLE, UOTHER, P1, P2]);
    await c.query(`insert into spaces (id,unit_id,space_label,created_at) values
                   ($1,$5,'4125-A', now() - interval '2 day'),
                   ($2,$5,'4125-B', now() - interval '1 day'),
                   ($3,$6,'200',    now() - interval '2 day'),
                   ($4,$7,'900',    now() - interval '2 day')`,
                  [A, B, SWHOLE, SOTHER, UBED, UWHOLE, UOTHER]);
    await c.query(`insert into leases (id,property_id,space_id,start_date,end_date,lease_status) values
        ('cccccccc-0000-0000-0000-00000000000a',$1,$3,'2026-01-01','2026-12-31','active'),
        ('cccccccc-0000-0000-0000-00000000000b',$1,$4,'2026-01-01','2026-12-31','active'),
        ('cccccccc-0000-0000-0000-0000000000d0',$1,$5,'2026-01-01','2026-12-31','active'),
        ('cccccccc-0000-0000-0000-0000000000f2',$2,$6,'2026-01-01','2026-12-31','active')`,
                  [P1, P2, A, B, SWHOLE, SOTHER]);
    // trg_unit_space auto-provisions a "(whole unit)" space on unit insert.
    // Leaving it in would make the by-bed fixture a THREE-space unit and the
    // whole-unit fixture a TWO-space one — neither is what these tests claim.
    await c.query("delete from spaces where unit_id = any($1) and id <> all($2)",
      [[UBED, UWHOLE, UOTHER], [A, B, SWHOLE, SOTHER]]);
    await c.query("commit");
  } catch (e) { await c.query("rollback"); throw e; } finally { c.release(); }
}

async function staffSession() {
  const svc = require("../../src/identity/staff_session_service");
  const c = await pool.connect();
  try {
    await c.query(`insert into users (id,name,is_active,status) values
      ('99999999-0000-0000-0000-000000000001','Proof Operator',true,'active')
      on conflict (id) do update set is_active=true, status='active'`);
    await c.query(`insert into property_team_assignments
       (property_id,user_id,role_title,allowed_modules,active)
       values ($1,'99999999-0000-0000-0000-000000000001','Leasing',
               array['leasing','management'],true)
       on conflict do nothing`, [P1]);
    await c.query("commit").catch(() => {});
  } finally { c.release(); }
  const out = await svc.issueStaffSession(pool, {
    userId: "99999999-0000-0000-0000-000000000001", propertyId: P1, purpose: "bootstrap_invite",
  });
  return out.token || out.raw_token || out.session_token;
}

const openNotices = (space) => pool.query(
  `select id from unit_events where space_id=$1 and event_type='notice_given' and status='scheduled'`,
  [space]).then(r => r.rows);

(async function main() {
  receipt.begin(HARNESS, { url: HARNESS_URL, expected: EXPECTED });
  console.log("\nNOTICE SPACE-GRAIN — REAL HTTP + REAL POSTGRES\n");

  // ── 1. SEPARATE BEDS EACH GET A VALID NOTICE ──
  await reseed();
  console.log("1. separate beds can each hold a valid notice");
  const nA = await post(`/units/${UBED}/notice`, { move_out_date: "2026-10-31", space_id: A });
  ok("bed A notice accepted", nA.status === 201, `got ${nA.status} ${JSON.stringify(nA.body)}`);
  const nB = await post(`/units/${UBED}/notice`, { move_out_date: "2026-11-30", space_id: B });
  ok("bed B notice accepted while A is open", nB.status === 201, `got ${nB.status} ${JSON.stringify(nB.body)}`);
  ok("the two notices are distinct records",
    nA.body?.unit_event?.id && nB.body?.unit_event?.id && nA.body.unit_event.id !== nB.body.unit_event.id);
  ok("each notice carries its own bed in the space_id COLUMN",
    nA.body?.unit_event?.space_id === A && nB.body?.unit_event?.space_id === B,
    `A=${nA.body?.unit_event?.space_id} B=${nB.body?.unit_event?.space_id}`);
  ok("each notice keeps its own vacate date",
    String(nA.body?.unit_event?.effective_date).startsWith("2026-10-31")
    && String(nB.body?.unit_event?.effective_date).startsWith("2026-11-30"));
  ok("each notice binds its own lease",
    nA.body?.unit_event?.payload?.lease_id !== nB.body?.unit_event?.payload?.lease_id);

  // ── 2. DUPLICATE ON THE SAME BED STAYS BLOCKED ──
  console.log("2. a duplicate notice on the SAME bed stays blocked");
  const dupA = await post(`/units/${UBED}/notice`, { move_out_date: "2026-12-01", space_id: A });
  ok("second notice on bed A refused 409", dupA.status === 409, `got ${dupA.status}`);
  ok("refusal names the space, not the unit",
    dupA.body?.space_id === A && /space already has an open notice/.test(dupA.body?.error || ""),
    JSON.stringify(dupA.body));
  ok("refusal points at the existing event", dupA.body?.unit_event_id === nA.body.unit_event.id);
  ok("still exactly one open notice on bed A", (await openNotices(A)).length === 1);

  // ── 3. CONCURRENT DUPLICATES ON ONE BED ──
  console.log("3. concurrent duplicate notices on one bed");
  await reseed();
  const N = 8;
  const burst = await Promise.all(Array.from({ length: N }, () =>
    post(`/units/${UBED}/notice`, { move_out_date: "2026-10-31", space_id: A })));
  const created = burst.filter(r => r.status === 201).length;
  const refused = burst.filter(r => r.status === 409).length;
  ok(`exactly one of ${N} concurrent notices created (got ${created})`, created === 1,
    JSON.stringify(burst.map(r => r.status)));
  ok(`the other ${N - 1} refused 409 (got ${refused})`, refused === N - 1);
  ok("database holds exactly one open notice for bed A", (await openNotices(A)).length === 1);

  // ── 4. AMBIGUITY AND AUTHORITY STILL REFUSED ──
  console.log("4. ambiguous beds and unauthorized access remain refused");
  await reseed();
  const amb = await post(`/units/${UBED}/notice`, { move_out_date: "2026-10-31" });
  ok("by-bed unit with no space named is refused 409", amb.status === 409, `got ${amb.status}`);
  ok("the refusal names ambiguity, not a duplicate",
    /multiple spaces/.test(amb.body?.error || ""), JSON.stringify(amb.body));
  ok("the refusal lists the beds to choose from", Array.isArray(amb.body?.spaces) && amb.body.spaces.length === 2);
  const foreign = await post(`/units/${UBED}/notice`, { move_out_date: "2026-10-31", space_id: SOTHER });
  ok("a space from another property is refused 400", foreign.status === 400, `got ${foreign.status}`);
  ok("refusal says the space is not in this unit",
    /does not belong to this unit/.test(foreign.body?.error || ""), JSON.stringify(foreign.body));
  const noKey = await fetch(`${BASE}/units/${UBED}/notice`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ move_out_date: "2026-10-31", space_id: A }),
  });
  ok("no operator key is refused 401", noKey.status === 401, `got ${noKey.status}`);
  const badKey = await post(`/units/${UBED}/notice`, { move_out_date: "2026-10-31", space_id: A },
    { "x-operator-key": "wrong" });
  ok("a wrong operator key is refused 401", badKey.status === 401, `got ${badKey.status}`);
  ok("no notice was written by any refused call", (await openNotices(A)).length === 0);

  // ── 5. EACH NOTICE REACHES THE CORRECT BED'S CANONICAL AVAILABILITY READ ──
  console.log("5. each notice reaches the correct bed's canonical availability read");
  await reseed();
  const token = await staffSession();
  const H = { "x-staff-session": token };
  await post(`/units/${UBED}/notice`, { move_out_date: "2026-10-31", space_id: A });
  let av = await get(`/operator/leasing/availability-canonical?horizon_days=400`, H);
  ok("availability read reachable with a real staff session", av.status === 200,
    `got ${av.status} ${JSON.stringify(av.body).slice(0, 200)}`);
  const rowsOf = (r) => (r.body.positions || r.body.rows || r.body.spaces || []);
  let byId = Object.fromEntries(rowsOf(av).map(r => [String(r.space_id), r]));
  ok("bed A reads as on notice / upcoming",
    byId[A] && /upcoming|on_notice/.test(JSON.stringify(byId[A])), JSON.stringify(byId[A] || {}).slice(0, 300));
  ok("bed B is NOT dragged onto notice by its sibling",
    byId[B] && !/upcoming|on_notice/.test(JSON.stringify(byId[B])), JSON.stringify(byId[B] || {}).slice(0, 300));
  ok("bed A carries ITS OWN vacate date, not a sibling's",
    JSON.stringify(byId[A] || {}).includes("2026-10-31"), JSON.stringify(byId[A] || {}).slice(0, 300));
  await post(`/units/${UBED}/notice`, { move_out_date: "2026-11-30", space_id: B });
  av = await get(`/operator/leasing/availability-canonical?horizon_days=400`, H);
  byId = Object.fromEntries(rowsOf(av).map(r => [String(r.space_id), r]));
  ok("with both beds on notice each keeps its own date",
    JSON.stringify(byId[A] || {}).includes("2026-10-31")
    && JSON.stringify(byId[B] || {}).includes("2026-11-30"),
    `A=${JSON.stringify(byId[A] || {}).slice(0, 200)} B=${JSON.stringify(byId[B] || {}).slice(0, 200)}`);

  // ── 6. WHOLE-UNIT BEHAVIOUR UNCHANGED ──
  console.log("6. whole-unit behaviour unchanged");
  await reseed();
  const w1 = await post(`/units/${UWHOLE}/notice`, { move_out_date: "2026-10-31" });
  ok("single-space unit still needs no space_id", w1.status === 201, `got ${w1.status} ${JSON.stringify(w1.body)}`);
  ok("server still derives the sole space", w1.body?.unit_event?.space_id === SWHOLE);
  const w2 = await post(`/units/${UWHOLE}/notice`, { move_out_date: "2026-12-01" });
  ok("a second notice on a whole unit is still refused", w2.status === 409, `got ${w2.status}`);
  ok("whole unit still holds exactly one open notice", (await openNotices(SWHOLE)).length === 1);

  // ── 7. SUPERSESSION STAYS PER BED ──
  console.log("7. supersession stays per bed");
  await reseed();
  const sA = await post(`/units/${UBED}/notice`, { move_out_date: "2026-10-31", space_id: A });
  const sB = await post(`/units/${UBED}/notice`, { move_out_date: "2026-11-30", space_id: B });
  const sup = await post(`/units/${UBED}/notice/supersede`, { move_out_date: "2026-10-15", space_id: A });
  ok("bed A's notice can be superseded while B holds one", sup.status === 201,
    `got ${sup.status} ${JSON.stringify(sup.body)}`);
  ok("supersession replaced A's notice", sup.body?.superseded_event_id === sA.body.unit_event.id);
  ok("bed B's notice is untouched", (await openNotices(B)).map(r => r.id).includes(sB.body.unit_event.id));
  ok("bed A has exactly one open notice again", (await openNotices(A)).length === 1);
  const supAmb = await post(`/units/${UBED}/notice/supersede`, { move_out_date: "2026-10-20" });
  ok("supersede with no space on a unit holding two is refused", supAmb.status === 409, `got ${supAmb.status}`);
  ok("that refusal names which beds are open",
    Array.isArray(supAmb.body?.spaces) && supAmb.body.spaces.length === 2, JSON.stringify(supAmb.body));
  const supWrong = await post(`/units/${UBED}/notice/supersede`, { move_out_date: "2026-10-20", space_id: SOTHER });
  ok("supersede cannot target a space outside the unit", supWrong.status === 409, `got ${supWrong.status}`);

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) console.log("FAILED: " + failures.join(" | "));
  await pool.end();
  process.exit(receipt.complete({ harness: HARNESS, passed: pass, failed: fail, expectedAtLeast: EXPECTED }));
})().catch(e => { console.error("HARNESS ERROR", e); process.exit(2); });
