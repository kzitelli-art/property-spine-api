#!/usr/bin/env node
/* ════════════════════════════════════════════════════════════════════
   notice_concurrency_challenge.db.js — CLASS 3 (test infrastructure).

   Adversarial follow-up to notice_space_grain_http.db.js. Three questions
   the space-scoped guard does NOT answer on its own:

     A  give-notice racing SUPERSEDE and CANCEL on the same bed.
        These writers lock DIFFERENT objects — give-notice locks the
        `spaces` row, supersede and cancel lock `unit_events` rows — so the
        row lock serializes give-notice against itself and NOT against them.
     B  supersession AFTER a lease transition on the same bed. The notice
        belongs to the tenancy that gave it; a new lease is a new tenancy.
     C  the notices board rendering two beds of one unit distinguishably.
   ════════════════════════════════════════════════════════════════════ */
"use strict";
const { Pool } = require("pg");
const receipt = require("../_run_receipt");

const HARNESS = __filename;
const EXPECTED = 16;
const BASE = process.env.BASE || "http://127.0.0.1:3111";
const KEY = process.env.OPERATOR_KEY || "proofkey";
const HARNESS_URL = receipt.harnessConnectionString();
const pool = new Pool({ connectionString: HARNESS_URL, ssl: false });

const P1 = "11111111-1111-1111-1111-111111111111";
const UBED = "22222222-2222-2222-2222-222222222222";
const A = "aaaaaaaa-0000-0000-0000-00000000000a";
const B = "bbbbbbbb-0000-0000-0000-00000000000b";
const L1A = "cccccccc-0000-0000-0000-00000000000a";
const L2A = "cccccccc-0000-0000-0000-0000000000a2";   // successor tenancy on bed A

let pass = 0, fail = 0; const failures = [];
function ok(name, cond, detail) {
  if (cond) { pass++; console.log(`  ok    ${name}`); }
  else { fail++; failures.push(name); console.log(`  FAIL  ${name}${detail ? "\n        " + detail : ""}`); }
}
const post = (p, body) => fetch(BASE + p, {
  method: "POST", headers: { "content-type": "application/json", "x-operator-key": KEY },
  body: JSON.stringify(body),
}).then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) }));
const get = (p) => fetch(BASE + p, { headers: { "x-operator-key": KEY } })
  .then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) }));

async function reseed() {
  const c = await pool.connect();
  try {
    await c.query("begin");
    await c.query("delete from unit_events where property_id=$1", [P1]);
    await c.query("delete from leases where property_id=$1", [P1]);
    await c.query("delete from spaces where unit_id=$1", [UBED]);
    await c.query("delete from units where id=$1", [UBED]);
    await c.query("insert into properties (id,name) values ($1,'Proof P1') on conflict (id) do nothing", [P1]);
    await c.query("insert into units (id,property_id,unit_number) values ($1,$2,'4125')", [UBED, P1]);
    await c.query(`insert into spaces (id,unit_id,space_label,created_at) values
        ($1,$3,'4125-A', now() - interval '2 day'),
        ($2,$3,'4125-B', now() - interval '1 day')`, [A, B, UBED]);
    await c.query("delete from spaces where unit_id=$1 and id <> all($2)", [UBED, [A, B]]);
    await c.query(`insert into leases (id,property_id,space_id,start_date,end_date,lease_status) values
        ($1,$3,$4,'2026-01-01','2026-12-31','active'),
        ($2,$3,$5,'2026-01-01','2026-12-31','active')`,
      [L1A, "cccccccc-0000-0000-0000-00000000000b", P1, A, B]);
    await c.query("commit");
  } catch (e) { await c.query("rollback"); throw e; } finally { c.release(); }
}
const ymd = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d || "").slice(0, 10));
const scheduled = (space) => pool.query(
  `select id, effective_date, payload from unit_events
    where space_id=$1 and event_type='notice_given' and status='scheduled'`, [space]).then(r => r.rows);

(async () => {
  receipt.begin(HARNESS, { url: HARNESS_URL, expected: EXPECTED });
  console.log("\nNOTICE — ADVERSARIAL: CROSS-WRITER RACES, TENANCY TRANSITION, BOARD\n");

  // ── A1. give-notice racing CANCEL on the same bed ──
  console.log("A1. give-notice racing cancel-notice on the same bed");
  let dupSeen = 0, roundsA = 12;
  for (let i = 0; i < roundsA; i++) {
    await reseed();
    const first = await post(`/units/${UBED}/notice`, { move_out_date: "2026-10-31", space_id: A });
    const evId = first.body?.unit_event?.id;
    await Promise.all([
      post(`/unit-events/${evId}/cancel-notice`, { reason: "resident retracted" }),
      post(`/units/${UBED}/notice`, { move_out_date: "2026-11-15", space_id: A }),
    ]);
    const open = await scheduled(A);
    if (open.length > 1) dupSeen++;
  }
  ok(`no bed ever held 2 open notices across ${roundsA} give/cancel races (saw ${dupSeen})`, dupSeen === 0);

  // ── A2. give-notice racing SUPERSEDE on the same bed ──
  console.log("A2. give-notice racing supersede on the same bed");
  let dupSeenB = 0, roundsB = 12;
  for (let i = 0; i < roundsB; i++) {
    await reseed();
    await post(`/units/${UBED}/notice`, { move_out_date: "2026-10-31", space_id: A });
    await Promise.all([
      post(`/units/${UBED}/notice/supersede`, { move_out_date: "2026-10-15", space_id: A }),
      post(`/units/${UBED}/notice`, { move_out_date: "2026-11-15", space_id: A }),
    ]);
    const open = await scheduled(A);
    if (open.length > 1) dupSeenB++;
  }
  ok(`no bed ever held 2 open notices across ${roundsB} give/supersede races (saw ${dupSeenB})`, dupSeenB === 0);

  // ── A3. a race on bed A never touches bed B ──
  console.log("A3. a race on one bed never disturbs its sibling");
  await reseed();
  const nB = await post(`/units/${UBED}/notice`, { move_out_date: "2026-12-20", space_id: B });
  await post(`/units/${UBED}/notice`, { move_out_date: "2026-10-31", space_id: A });
  await Promise.all([
    post(`/units/${UBED}/notice/supersede`, { move_out_date: "2026-10-15", space_id: A }),
    post(`/units/${UBED}/notice`, { move_out_date: "2026-11-15", space_id: A }),
    post(`/units/${UBED}/notice`, { move_out_date: "2026-11-16", space_id: A }),
  ]);
  const bOpen = await scheduled(B);
  ok("bed B still holds exactly its own one notice", bOpen.length === 1);
  ok("bed B's vacate date is untouched by bed A's race",
    ymd(bOpen[0]?.effective_date) === "2026-12-20", ymd(bOpen[0]?.effective_date));
  ok("bed B's notice is still the record it started as", bOpen[0]?.id === nB.body?.unit_event?.id);
  ok("bed A ends the race with exactly one open notice", (await scheduled(A)).length === 1);

  // ── B. SUPERSESSION AFTER A LEASE TRANSITION ──
  console.log("B. supersession after a lease transition on the same bed");
  await reseed();
  const orig = await post(`/units/${UBED}/notice`, { move_out_date: "2026-10-31", space_id: A });
  ok("original tenancy gives notice", orig.status === 201);
  const origLease = orig.body?.unit_event?.payload?.lease_id;
  ok("the notice records the tenancy that gave it", origLease === L1A, `got ${origLease}`);

  // the tenancy turns over: L1 ends, a NEW lease becomes active on the SAME bed
  await pool.query("update leases set lease_status='ended', end_date='2026-10-31' where id=$1", [L1A]);
  await pool.query(`insert into leases (id,property_id,space_id,start_date,end_date,lease_status)
                    values ($1,$2,$3,'2026-11-01','2027-10-31','active')`, [L2A, P1, A]);

  const supAfter = await post(`/units/${UBED}/notice/supersede`, { move_out_date: "2026-11-20", space_id: A });
  ok("supersession is REFUSED after the tenancy changed", supAfter.status === 409,
    `got ${supAfter.status} ${JSON.stringify(supAfter.body)}`);
  ok("the refusal names the tenancy mismatch, not a date problem",
    /lease_identity_mismatch|different tenancy/.test(JSON.stringify(supAfter.body)), JSON.stringify(supAfter.body));
  const stillA = await scheduled(A);
  ok("the ORIGINAL notice survives unchanged", stillA.length === 1 && stillA[0].id === orig.body.unit_event.id);
  ok("the original notice still points at the ORIGINAL lease",
    stillA[0]?.payload?.lease_id === L1A, JSON.stringify(stillA[0]?.payload?.lease_id));
  ok("the successor tenancy did NOT inherit the old notice's date",
    ymd(stillA[0]?.effective_date) === "2026-10-31", ymd(stillA[0]?.effective_date));

  // ── C. THE NOTICES BOARD ──
  console.log("C. the notices board shows separate beds correctly");
  await reseed();
  const bA = await post(`/units/${UBED}/notice`, { move_out_date: "2026-10-31", space_id: A });
  const bB = await post(`/units/${UBED}/notice`, { move_out_date: "2026-11-30", space_id: B });
  const board = await get(`/notices?property_id=${P1}`);
  ok("board reachable", board.status === 200, `got ${board.status}`);
  const rows = (board.body.notices || []).filter(n => n.unit_id === UBED);
  ok("board lists BOTH beds' notices", rows.length === 2, `got ${rows.length}`);
  ok("each board row carries its own space_id",
    rows.some(r => r.space_id === A) && rows.some(r => r.space_id === B),
    JSON.stringify(rows.map(r => r.space_id)));
  ok("each board row carries its own vacate date",
    new Set(rows.map(r => String(r.move_out_date))).size === 2, JSON.stringify(rows.map(r => r.move_out_date)));
  ok("a human can tell the two rows apart without decoding a uuid",
    new Set(rows.map(r => String(r.space_label ?? r.unit_number))).size === 2,
    `rendered labels: ${JSON.stringify(rows.map(r => r.space_label ?? r.unit_number))}`);

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) console.log("FAILED: " + failures.join(" | "));
  await pool.end();
  process.exit(receipt.complete({ harness: HARNESS, passed: pass, failed: fail, expectedAtLeast: EXPECTED }));
})().catch(e => { console.error("HARNESS ERROR", e); process.exit(2); });
