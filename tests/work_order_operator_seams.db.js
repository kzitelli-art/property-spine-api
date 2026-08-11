#!/usr/bin/env node
/* ════════════════════════════════════════════════════════════════════
   THE OPERATOR SEAMS, AGAINST REAL ROWS AND REAL HTTP.

   `Still needs work` and `Take job` cross authority, routing, persistence
   and projection in one request each. Source tests prove the predicate;
   they cannot prove that an authenticated request reaches it, that the
   database accepts what the service writes, or that the read surface then
   describes what happened.

   ── WHAT THIS RUNS AGAINST ──────────────────────────────────────────
   A real PostgreSQL database and the REAL server.js over real HTTP, with
   real staff sessions resolved by identity/staff_session_service. Nothing
   is stubbed: the requests go through requireOperator,
   requireMaintenanceModuleAccess and refuseClientProperty exactly as a
   browser's would.

   ── THE ASSERTION THAT MATTERS MOST ─────────────────────────────────
   VIEWER-DEPENDENT RENDERING IS A SERVER FACT.

   One work order, assigned to KZ and not yet accepted. KZ's read must
   offer acceptance; the manager's read of THE SAME ROW must not — and
   the manager's attempt must be refused by the write, not merely hidden
   by the surface. A control that is only hidden is a control that a
   crafted request still reaches.

     HARNESS_DATABASE_URL=postgres://... node tests/work_order_operator_seams.db.js
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const crypto = require("crypto");
const { Pool } = require("pg");
const { spawn } = require("child_process");

//  NO FALLBACK TO PRODUCTION. docs/DB_HARNESS_ISOLATION.md §4: a harness
//  that can silently reach DATABASE_URL is how synthetic rows ended up in
//  the production database in the first place.
//
//  THE CANONICAL HELPER, not a local check. This file first compared the two
//  URLs as STRINGS, and gate_harness_isolation caught it with the right
//  reason: "requiring the variable is not the same as refusing the wrong
//  value." Two different strings can name one database — localhost against
//  127.0.0.1, a trailing parameter, a different sslmode — and a string
//  comparison waves every one of them through. harnessConnectionString()
//  resolves host, port and database and refuses on the TARGET.
const receipt = require("./_run_receipt.js");
const URL = receipt.harnessConnectionString();

const PORT = Number(process.env.HARNESS_PORT || 3998);
const BASE = `http://127.0.0.1:${PORT}`;
const pool = new Pool({ connectionString: URL });

let pass = 0, fail = 0;
const EXPECTED = 42;
const ok = (l, c, d) => {
  if (c) { pass++; console.log("  ok    " + l); }
  else { fail++; console.log("  FAIL  " + l + (d ? "\n        " + d : "")); }
  return c;
};
const section = (t) => console.log(`\n── ${t} ${"─".repeat(Math.max(0, 56 - t.length))}`);
const sha256 = (s) => crypto.createHash("sha256").update(s, "utf8").digest("hex");

async function req(method, path, token, body) {
  const r = await fetch(BASE + path, {
    method,
    headers: Object.assign({ "content-type": "application/json" },
      token ? { "x-staff-session": token } : {}),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await r.json(); } catch (e) { json = null; }
  return { status: r.status, body: json };
}

//  ── SEED ──────────────────────────────────────────────────────────
//  Written with plain SQL on purpose. The point of this harness is the
//  ROUTES; seeding through them would make a failure ambiguous.
async function seed() {
  const q = (s, v) => pool.query(s, v);
  const org = (await q("insert into organizations (name) values ('Harness Org') returning id")).rows[0].id;
  const prop = (await q("insert into properties (name, organization_id) values ('Solo on Chestnut', $1) returning id", [org])).rows[0].id;
  //  A SECOND PROPERTY IN THE SAME ORG. Cross-property scoping is only a
  //  real test when the other building is one the org genuinely owns.
  const other = (await q("insert into properties (name, organization_id) values ('Other Building', $1) returning id", [org])).rows[0].id;
  const unit = (await q("insert into units (property_id, unit_number) values ($1,'631') returning id", [prop])).rows[0].id;

  const kz = (await q("insert into users (name, role) values ('KZ','maintenance') returning id")).rows[0].id;
  const mgr = (await q("insert into users (name, role) values ('Morgan','property_manager') returning id")).rows[0].id;

  for (const u of [kz, mgr]) {
    await q(`insert into property_team_assignments (property_id, user_id, role_title, allowed_modules, active)
             values ($1,$2,'Maintenance','{maintenance}',true)`, [prop, u]);
    await q(`insert into property_team_assignments (property_id, user_id, role_title, allowed_modules, active)
             values ($1,$2,'Maintenance','{maintenance}',true)`, [other, u]);
  }

  const tok = {};
  for (const [name, u] of [["kz", kz], ["mgr", mgr]]) {
    const t = "harness-" + name + "-" + crypto.randomBytes(8).toString("hex");
    await q(`insert into staff_sessions (user_id, property_id, token, token_digest, expires_at)
             values ($1,$2,$3,$4, now() + interval '1 hour')`, [u, prop, t, sha256(t)]);
    tok[name] = t;
  }

  //  A — assigned to KZ, NOT accepted. The viewer-dependent case.
  const woA = (await q(`insert into work_orders (property_id, unit_id, title, work_order_ref, status)
                        values ($1,$2,'Broken toilet','1007','open') returning id`, [prop, unit])).rows[0].id;
  await q(`insert into obligations (property_id, unit_id, related_id, related_type, module, type,
                                    label, assigned_role, assigned_user_id, status)
           values ($1,$2,$3,'work_order','maintenance','wo_closeout','Fix toilet','maintenance',$4,'open')`,
          [prop, unit, woA, kz]);

  //  B — nobody assigned at all. The manager's case: Assign, never Take job.
  const woB = (await q(`insert into work_orders (property_id, unit_id, title, work_order_ref, status)
                        values ($1,$2,'Bedroom outlet not working','1012','open') returning id`, [prop, unit])).rows[0].id;
  await q(`insert into obligations (property_id, unit_id, related_id, related_type, module, type,
                                    label, assigned_role, status)
           values ($1,$2,$3,'work_order','maintenance','wo_closeout','Fix outlet','maintenance','open')`,
          [prop, unit, woB]);

  //  C — at the OTHER property. Must be invisible and untouchable here.
  const woC = (await q(`insert into work_orders (property_id, title, work_order_ref, status)
                        values ($1,'Roof leak','2001','open') returning id`, [other])).rows[0].id;

  //  D — no accountability obligation at all. Nothing to take.
  const woD = (await q(`insert into work_orders (property_id, unit_id, title, work_order_ref, status)
                        values ($1,$2,'Hallway light out','1099','open') returning id`, [prop, unit])).rows[0].id;

  return { org, prop, other, unit, kz, mgr, tok, woA, woB, woC, woD };
}

const findWo = (rows, id) => (rows || []).find((r) => r.work_order.id === id) || null;

(async () => {
  console.log("\n" + "═".repeat(68));
  console.log("  OPERATOR SEAMS — real Postgres, real server.js, real sessions");
  console.log("═".repeat(68));
  console.log("  target: " + URL.replace(/:[^:@/]*@/, ":***@"));
  console.log("  ASSERTIONS STARTED  (expecting " + EXPECTED + ")");

  const s = await seed();

  const srv = spawn(process.execPath, ["server.js"], {
    cwd: __dirname + "/..",
    env: Object.assign({}, process.env, {
      DATABASE_URL: URL, PORT: String(PORT), OPERATOR_KEY: "harness-key",
    }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  const srvLog = [];
  srv.stdout.on("data", (d) => srvLog.push(String(d)));
  srv.stderr.on("data", (d) => srvLog.push(String(d)));

  const stop = () => { try { srv.kill("SIGTERM"); } catch (e) {} };
  process.on("exit", stop);

  //  Wait for the real server rather than sleeping a guessed interval.
  let up = false;
  for (let i = 0; i < 60 && !up; i++) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 250));
    try {
      // eslint-disable-next-line no-await-in-loop
      const r = await fetch(BASE + "/operator/work-orders/status", { headers: { "x-staff-session": "x" } });
      up = r.status !== 0;
    } catch (e) { /* not listening yet */ }
  }
  if (!ok("S1  the real server.js is listening", up, srvLog.join("").slice(0, 400))) {
    console.log("\n  RUN INVALID — server never came up.\n"); stop(); process.exit(1);
  }

  try {
    // ── AUTHORITY ──────────────────────────────────────────────────
    section("authority");
    const anon = await req("GET", "/operator/work-orders/status", null);
    ok("A1  no session is refused 401", anon.status === 401, JSON.stringify(anon));
    const badTok = await req("GET", "/operator/work-orders/status", "not-a-real-token");
    ok("A2  an unknown session is refused 401", badTok.status === 401, JSON.stringify(badTok));

    const kzList = await req("GET", "/operator/work-orders/status", s.tok.kz);
    ok("A3  KZ's session resolves and reads the queue", kzList.status === 200, JSON.stringify(kzList).slice(0, 200));
    ok("A4  the queue is scoped to the session's property — the other " +
       "building's work order is absent",
       !findWo(kzList.body.work_orders, s.woC), "woC leaked into the list");

    const claimed = await req("POST", `/operator/work-orders/${s.woA}/accept`, s.tok.kz, { property_id: s.other });
    ok("A5  a client-supplied property_id is REFUSED, not ignored",
       claimed.status === 400 || claimed.status === 403, JSON.stringify(claimed).slice(0, 200));

    // ── THE VIEWER-DEPENDENT FACT ──────────────────────────────────
    section("one row, two viewers");
    const mgrList = await req("GET", "/operator/work-orders/status", s.tok.mgr);
    ok("B1  the manager reads the same queue", mgrList.status === 200);

    const aKz = findWo(kzList.body.work_orders, s.woA);
    const aMgr = findWo(mgrList.body.work_orders, s.woA);
    ok("B2  both viewers see the same work order", !!aKz && !!aMgr);
    ok("B3  both are told the SAME ownership fact — assigned to KZ, not accepted",
       aKz.current.assigned_to && aKz.current.assigned_to.name === "KZ"
       && aKz.current.accountable === "UNASSIGNED"
       && aMgr.current.assigned_to && aMgr.current.assigned_to.name === "KZ"
       && aMgr.current.accountable === "UNASSIGNED",
       JSON.stringify({ kz: aKz.current.assigned_to, mgr: aMgr.current.assigned_to }));
    ok("B4  KZ MAY accept it", aKz.current.viewer && aKz.current.viewer.may_accept === true,
       JSON.stringify(aKz.current.viewer));
    ok("B5  the manager MAY NOT — and is told why",
       aMgr.current.viewer && aMgr.current.viewer.may_accept === false
       && aMgr.current.viewer.refusal === "not_assigned_to_actor",
       JSON.stringify(aMgr.current.viewer));

    const bMgr = findWo(mgrList.body.work_orders, s.woB);
    ok("B6  an UNASSIGNED work order offers the manager no acceptance either",
       bMgr && bMgr.current.viewer && bMgr.current.viewer.may_accept === false,
       JSON.stringify(bMgr && bMgr.current.viewer));
    ok("B7  …and states it has nobody, so the surface offers Assign",
       bMgr.current.accountable === "UNASSIGNED" && bMgr.current.assigned_to === null);

    // ── THE WRITE REFUSES WHAT THE READ HID ────────────────────────
    section("hiding is not enforcing");
    const mgrTake = await req("POST", `/operator/work-orders/${s.woA}/accept`, s.tok.mgr);
    ok("C1  the manager's accept is REFUSED by the write, not merely hidden",
       mgrTake.status === 409, JSON.stringify(mgrTake).slice(0, 200));
    ok("C2  …with the canonical verdict", mgrTake.body.error === "not_assigned_to_actor",
       JSON.stringify(mgrTake.body));
    ok("C3  …and a refusal a human can act on, naming the next step",
       typeof mgrTake.body.receipt?.text === "string"
       && /assigned to someone else/i.test(mgrTake.body.receipt.text)
       && /assign/i.test(mgrTake.body.receipt.text),
       JSON.stringify(mgrTake.body.receipt));

    const stillOpen = await pool.query("select status, accepted_at from obligations where related_id=$1", [s.woA]);
    ok("C4  the refused attempt changed NOTHING in the database",
       stillOpen.rows[0].status === "open" && stillOpen.rows[0].accepted_at === null,
       JSON.stringify(stillOpen.rows[0]));

    const noOb = await req("POST", `/operator/work-orders/${s.woD}/accept`, s.tok.kz);
    ok("C5  a work order with no accountability obligation refuses honestly",
       noOb.status === 409 && noOb.body.error === "no_accountability_obligation",
       JSON.stringify(noOb).slice(0, 160));

    const crossProp = await req("POST", `/operator/work-orders/${s.woC}/accept`, s.tok.kz);
    ok("C6  a work order at another property is NOT FOUND, not refused",
       crossProp.status === 404, JSON.stringify(crossProp).slice(0, 160));

    // ── TAKE JOB, FOR REAL ─────────────────────────────────────────
    section("take job");
    const take = await req("POST", `/operator/work-orders/${s.woA}/accept`, s.tok.kz);
    ok("D1  KZ takes the job", take.status === 201, JSON.stringify(take).slice(0, 240));
    ok("D2  the receipt says accepting is not completing",
       /still outstanding/i.test(take.body.receipt?.text || ""), JSON.stringify(take.body.receipt));

    const acc = (await pool.query("select * from obligations where related_id=$1", [s.woA])).rows[0];
    ok("D3  the DATABASE accepted the row — all four 131 constraints held",
       acc.accepted_by_user_id === s.kz && acc.assigned_user_id === s.kz
       && acc.accepted_at !== null && acc.status !== "open",
       JSON.stringify({ acc: acc.accepted_by_user_id, asg: acc.assigned_user_id, st: acc.status }));

    //  Scoped to this work order for the same reason E9 is — `events` has no
    //  work_order_id column, so an unscoped count is a count of every run the
    //  harness database has ever seen, and "exactly one" stops meaning
    //  "accepted once" the second time anybody runs it.
    const evt = (await pool.query(
      `select * from events
        where type='work_accepted'
          and (note::jsonb ->> 'work_order_id') = $1`, [s.woA])).rows;
    ok("D4  an immutable acceptance event exists", evt.length === 1, String(evt.length));

    const afterTake = await req("GET", "/operator/work-orders/status", s.tok.kz);
    const aAfter = findWo(afterTake.body.work_orders, s.woA);
    ok("D5  the READ now names KZ accountable — the who-line changes without " +
       "anything re-deriving it",
       aAfter.current.accountable !== "UNASSIGNED" && aAfter.current.accountable.name === "KZ",
       JSON.stringify(aAfter.current.accountable));
    ok("D6  …and no longer offers acceptance to anyone",
       aAfter.current.viewer.may_accept === false
       && aAfter.current.viewer.refusal === "already_accepted_by_actor",
       JSON.stringify(aAfter.current.viewer));

    const again = await req("POST", `/operator/work-orders/${s.woA}/accept`, s.tok.kz);
    ok("D7  taking it twice is a replay, not an error or a second acceptance",
       again.status === 200 && again.body.outcome === "replayed", JSON.stringify(again).slice(0, 160));

    // ── STILL NEEDS WORK ───────────────────────────────────────────
    section("still needs work");
    const reasons = await req("GET", "/operator/work-orders/not-done-reasons", s.tok.kz);
    ok("E1  the field vocabulary is five plain answers, read live",
       reasons.status === 200 && reasons.body.reasons.length === 5,
       JSON.stringify(reasons.body).slice(0, 200));
    ok("E2  …and every one of them is a canonical routing key",
       reasons.body.reasons.every((r) => r.key && r.label)
       && reasons.body.reasons.map((r) => r.key).join(",")
          === "need_part,no_access,second_visit,need_vendor,other",
       JSON.stringify(reasons.body.reasons.map((r) => r.key)));

    const badReason = await req("POST", `/operator/work-orders/${s.woA}/not-done`, s.tok.kz,
      { not_done_reason: "because_i_said_so" });
    ok("E3  an unroutable reason is REFUSED, never coerced to 'other'",
       badReason.status === 400 && badReason.body.error === "invalid_not_done_reason",
       JSON.stringify(badReason).slice(0, 200));

    const noReason = await req("POST", `/operator/work-orders/${s.woA}/not-done`, s.tok.kz, {});
    ok("E4  a missing reason is refused here, unlike the legacy path",
       noReason.status === 400, JSON.stringify(noReason).slice(0, 160));

    const stall = await req("POST", `/operator/work-orders/${s.woA}/not-done`, s.tok.kz,
      { not_done_reason: "need_part", note: "Fill valve is the wrong size." });
    ok("E5  reporting a stall succeeds", stall.status === 200, JSON.stringify(stall).slice(0, 240));
    ok("E6  the receipt is a sentence, not an event name",
       /Got it\./.test(stall.body.receipt?.text || "")
       && /maintenance now owns getting the part/i.test(stall.body.receipt?.text || "")
       && !/needs_followup|event/i.test(stall.body.receipt?.text || ""),
       JSON.stringify(stall.body.receipt));

    const woRow = (await pool.query("select status, needs_pm_review, not_done_reason from work_orders where id=$1", [s.woA])).rows[0];
    ok("E7  the work order stays OPEN, flagged, with the reason in its own column",
       woRow.status === "needs_followup" && woRow.needs_pm_review === true
       && woRow.not_done_reason === "need_part", JSON.stringify(woRow));

    const follow = (await pool.query(
      `select * from obligations where related_id=$1 and type='supply_followup'`, [s.woA])).rows;
    ok("E8  a ROUTED follow-up obligation exists, owned by a named role",
       follow.length === 1 && follow[0].assigned_role === "maintenance" && follow[0].status === "open",
       JSON.stringify(follow.map((f) => ({ t: f.type, r: f.assigned_role, s: f.status }))));

    //  SCOPED TO THIS WORK ORDER, not to the type. `events` has no
    //  work_order_id column — the id lives in the JSON note — and an
    //  unscoped `where type='maintenance_followup'` counts every stall any
    //  earlier run left behind. It read as a product failure once, on a
    //  harness database that had simply been used twice: E9 saw two rows,
    //  and E10/F4 then compared against the OLDER one. A count is a claim
    //  about a search, so the search names the row it means.
    const stallEvt = (await pool.query(
      `select * from events
        where type='maintenance_followup'
          and (note::jsonb ->> 'work_order_id') = $1`, [s.woA])).rows;
    ok("E9  an immutable event records what was reported, and by whom",
       stallEvt.length === 1
       && JSON.parse(stallEvt[0].note).reason === "need_part"
       && JSON.parse(stallEvt[0].note).reported_by_user_id === s.kz,
       stallEvt.length ? stallEvt[0].note : "none");
    ok("E10 …and the follow-up traces back to that event",
       follow[0].source_event_id === stallEvt[0].id);

    // ── THE READ DESCRIBES IT ──────────────────────────────────────
    section("attention, read back");
    const afterStall = await req("GET", "/operator/work-orders/status", s.tok.kz);
    const aStall = findWo(afterStall.body.work_orders, s.woA);
    ok("F1  the physical lifecycle is UNCHANGED — KZ still accepted it",
       aStall.current.accountable.name === "KZ" && aStall.current.state === "accepted",
       JSON.stringify({ st: aStall.current.state, acc: aStall.current.accountable }));
    ok("F2  attention is a SECOND dimension beside it, naming the blocker",
       aStall.current.attention && aStall.current.attention.label === "Waiting on a part"
       && aStall.current.attention.reason === "need_part",
       JSON.stringify(aStall.current.attention));
    ok("F3  …routed to an accountable role, which is what keeps it out of " +
       "Needs action",
       aStall.current.attention.routed_to.assigned_role === "maintenance"
       && aStall.current.attention.routed_to.status === "open",
       JSON.stringify(aStall.current.attention.routed_to));
    ok("F4  …timed from the immutable event, not from work_orders.updated_at",
       new Date(aStall.current.attention.since).toISOString()
         === new Date(stallEvt[0].occurred_at).toISOString(),
       aStall.current.attention.since + " vs " + stallEvt[0].occurred_at);
    ok("F5  next_action is the blocker, not the lifecycle's generic step",
       aStall.next_action === "Waiting on a part", String(aStall.next_action));
    ok("F6  the ACCOUNTABILITY obligation is still the one reported as owner — " +
       "the routed follow-up did not become it",
       aStall.current.accountable.user_id === s.kz);
  } catch (e) {
    fail++;
    console.log("  FAIL  harness threw → " + e.message + "\n" + (e.stack || "").split("\n")[1]);
  } finally {
    stop();
    await pool.end();
  }

  console.log("\n" + "═".repeat(68));
  const ran = pass + fail;
  if (ran !== EXPECTED) {
    console.log(`  ✗ RUN INVALID — ${ran} assertions ran, ${EXPECTED} expected`);
    console.log("═".repeat(68) + "\n");
    process.exit(1);
  }
  console.log(`  ${fail === 0 ? "✓ PASS" : "✗ FAIL"} — ${pass} passed, ${fail} failed`);
  if (fail === 0) {
    console.log("  One row, two viewers, and the write refuses what the read hid.");
  }
  console.log("═".repeat(68) + "\n");
  process.exit(fail === 0 ? 0 : 1);
})();
