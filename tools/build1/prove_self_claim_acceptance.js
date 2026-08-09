#!/usr/bin/env node
/* ════════════════════════════════════════════════════════════════════
   SELF-CLAIM IS ACCEPTANCE — proven under migration 142

   The ruling and the invariant are developed and proven TOGETHER, not
   composed later: every section below runs against a database with 142
   already applied.

     C  the claim path — assignment and acceptance, atomically
     D  the 142 preflight — reports, never repairs
     E  Ask Spine reads ASSIGNED_ACCEPTED from the resulting state
     F  the adversarial pass on the facts Capability 2 consumes

   ⚠ ISOLATED POSTGRES ONLY — run through tools/build1/run_isolated.sh.
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const fs = require("fs");
const path = require("path");
const http = require("http");
const crypto = require("crypto");
const express = require("express");
const { spawnSync } = require("child_process");
const { Pool } = require("pg");

const ROOT = path.join(__dirname, "..", "..");
const executor = require(path.join(ROOT, "src/askspine/intent_executor.js"));
const acceptance = require(path.join(ROOT, "src/technician/acceptance_service.js"));

const URL = process.env.CLAIM_DATABASE_URL;
const C2 = "maintenance.ownership_and_acceptance";

let pass = 0, fail = 0;
const ok = (l, c, d) => { if (c) { pass++; console.log("  ok    " + l); }
  else { fail++; console.log("  FAIL  " + l + (d ? "\n          → " + d : "")); } return c; };
const sec = (t) => console.log(`\n${"═".repeat(70)}\n  ${t}\n${"═".repeat(70)}`);
const findings = [];

const ID = (n) => crypto.createHash("md5").update("claim:" + n).digest("hex")
  .replace(/^(.{8})(.{4})(.{4})(.{4})(.{12}).*$/, "$1-$2-$3-$4-$5");
const ORG = ID("org"), PROP = ID("prop"), OTHER = ID("other");
const ALICE = ID("alice"), BOB = ID("bob");

(async function main() {
  if (!URL) { console.error("REFUSED: CLAIM_DATABASE_URL is not set."); process.exit(1); }
  const pool = new Pool({ connectionString: URL, max: 8 });
  const c = await pool.connect();
  const sentinel = Number((await c.query(
    `select count(*) n from release_0_scale_harness_guard where purpose like 'ISOLATED RELEASE 0%'`
  ).catch(() => ({ rows: [{ n: 0 }] }))).rows[0].n);
  if (sentinel !== 1) { console.error("REFUSED: not the isolated baseline."); process.exit(2); }

  //  142 FIRST. The ruling and the invariant are proven composed.
  await c.query(fs.readFileSync(
    path.join(ROOT, "migrations/142_obligation_acceptance_cannot_be_orphaned.sql"), "utf8"));

  await c.query(`insert into organizations (id,name) values ($1,'Claim') on conflict do nothing`, [ORG]);
  for (const [id, nm] of [[PROP, "Claim Prop"], [OTHER, "Other Prop"]]) {
    // eslint-disable-next-line no-await-in-loop
    await c.query(`insert into properties (id,name,organization_id) values ($1,$2,$3)
                   on conflict (id) do nothing`, [id, nm, ORG]);
  }
  for (const [id, nm, ph] of [[ALICE, "Alice", "+15005556001"], [BOB, "Bob", "+15005556002"]]) {
    // eslint-disable-next-line no-await-in-loop
    await c.query(`insert into users (id,name,phone,role) values ($1,$2,$3,'maintenance')
                   on conflict (id) do nothing`, [id, nm, ph]);
    // eslint-disable-next-line no-await-in-loop
    await c.query(`insert into property_team_assignments
        (user_id,property_id,role_title,allowed_modules,active)
        values ($1,$2,'Manager',array['maintenance'],true) on conflict do nothing`, [id, PROP]);
  }

  let seq = 0;
  const mkWo = async (prop = PROP) => {
    const wo = ID("wo" + (++seq));
    await c.query(`insert into work_orders (id,property_id,title,status,source)
                   values ($1,$2,'claim fixture','open','claimproof')`, [wo, prop]);
    return wo;
  };
  const mkObl = async (wo, { prop = PROP, assigned = null, status = "open",
                             type = "work_order_routing", module = "maintenance" } = {}) =>
    (await c.query(
      `insert into obligations (property_id,related_id,related_type,module,type,label,
                                assigned_user_id,status)
       values ($1,$2,'work_order',$3,$4,$5,$6,$7) returning id`,
      [prop, wo, module, type, type, assigned, status])).rows[0].id;
  const read = async (id) => (await c.query(
    `select id, assigned_user_id, accepted_by_user_id, accepted_at, status,
            ownership_origin, acceptance_key from obligations where id=$1`, [id])).rows[0];

  //  THE REAL ROUTE, over a real socket.
  const app = express();
  app.use(express.json());
  app.use("/", require(path.join(ROOT, "src/obligations/operator_obligation_actions.js"))({ pool }));
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const port = server.address().port;
  const staffSessions = require(path.join(ROOT, "src/identity/staff_session_service.js"));
  const tok = {};
  for (const [who, id] of [["alice", ALICE], ["bob", BOB]]) {
    // eslint-disable-next-line no-await-in-loop
    tok[who] = (await staffSessions.issueStaffSession(pool, {
      userId: id, propertyId: PROP, purpose: "bootstrap_invite" })).session_token;
  }
  const claim = (oblId, who) => new Promise((resolve) => {
    const req = http.request({ host: "127.0.0.1", port, method: "POST",
      path: `/operator/obligations/${oblId}/claim`,
      headers: { "content-type": "application/json", "content-length": 2,
                 "x-staff-session": tok[who] } }, (r) => {
      let b = ""; r.on("data", (d) => { b += d; });
      r.on("end", () => { let j = null; try { j = JSON.parse(b); } catch (e) { /* */ }
        resolve({ status: r.statusCode, json: j }); });
    });
    req.on("error", () => resolve({ status: 0, json: null }));
    req.write("{}"); req.end();
  });

  console.log("SELF-CLAIM IS ACCEPTANCE — under migration 142\n");

  /* ═══ C · THE CLAIM PATH ════════════════════════════════════════ */
  sec("C · a self-claim records assignment AND acceptance, atomically");
  {
    const wo = await mkWo();
    const o = await mkObl(wo);
    const before = await read(o);
    ok("C1  it starts UNASSIGNED", before.assigned_user_id === null &&
       before.accepted_by_user_id === null, JSON.stringify(before));

    const r1 = await claim(o, "alice");
    const after = await read(o);
    ok("C2  the claim succeeds", r1.status === 200, `${r1.status} ${JSON.stringify(r1.json)}`);
    ok("C3  Alice is the assignee", after.assigned_user_id === ALICE, String(after.assigned_user_id));
    ok("C4  …and the ACCEPTER — the claim was the acceptance",
       after.accepted_by_user_id === ALICE && !!after.accepted_at, JSON.stringify(after));
    ok("C5  assigned_user can never differ from accepted_by",
       after.assigned_user_id === after.accepted_by_user_id);
    ok("C6  history says CLAIMED, not merely assigned",
       after.ownership_origin === "self_claimed", after.ownership_origin);
    ok("C7  …and the receipt says so too",
       /claimed and accepted/i.test(r1.json.receipt) && !!r1.json.accepted_at,
       JSON.stringify(r1.json.receipt));

    const ev = (await c.query(
      `select note from events where type='work_accepted'
        order by occurred_at desc limit 1`)).rows[0];
    ok("C8  the governed acceptance EVENT was written",
       ev && /self_claimed/.test(JSON.stringify(ev.note)) &&
       /operator_self_claim/.test(JSON.stringify(ev.note)),
       JSON.stringify(ev && ev.note).slice(0, 180));

    //  REPLAY
    const r2 = await claim(o, "alice");
    const after2 = await read(o);
    ok("C9  a replayed claim is idempotent", r2.status === 200 && r2.json.replayed === true,
       JSON.stringify({ s: r2.status, replayed: r2.json && r2.json.replayed }));
    ok("C10 …and changed nothing", after2.accepted_at.getTime() === after.accepted_at.getTime(),
       `${after.accepted_at} vs ${after2.accepted_at}`);
    const n = Number((await c.query(
      `select count(*)::int n from events where type='work_accepted'`)).rows[0].n);
    ok("C11 …and wrote no second acceptance event", n === 1, String(n));

    //  BOB CANNOT TAKE IT
    const r3 = await claim(o, "bob");
    const after3 = await read(o);
    ok("C12 Bob cannot claim what Alice already owns", r3.status === 409,
       `${r3.status} ${JSON.stringify(r3.json)}`);
    ok("C13 …and nothing moved", after3.assigned_user_id === ALICE &&
       after3.accepted_by_user_id === ALICE);
  }

  /* ═══ ASSIGNMENT BY ANOTHER IS STILL NOT ACCEPTANCE ═════════════ */
  sec("C· assignment by someone else is still NOT acceptance");
  {
    const wo = await mkWo();
    const o = await mkObl(wo, { assigned: BOB });      // assigned by manager/system
    const r = await read(o);
    ok("C14 an obligation assigned BY ANOTHER has no acceptance",
       r.assigned_user_id === BOB && r.accepted_by_user_id === null, JSON.stringify(r));
    const e = await executor.execute(pool, {
      intent_slug: C2, property_id: PROP, allowed_modules: ["maintenance"] });
    const rec = e.supporting_records.find((x) => x.obligation_id === o);
    ok("C15 …and Ask Spine reads ASSIGNED_NOT_ACCEPTED",
       rec && rec.ownership_state === "assigned_not_accepted", rec && rec.ownership_state);
    console.log("        → the distinction the ruling preserves: being handed work is");
    console.log("          not the same as saying you have taken it.");
  }

  /* ═══ CROSS-PROPERTY ════════════════════════════════════════════ */
  sec("C· property scope holds on the claim path");
  {
    const woOther = await mkWo(OTHER);
    const o = await mkObl(woOther, { prop: OTHER });
    const r = await claim(o, "alice");
    const after = await read(o);
    ok("C16 an obligation in another property is NOT FOUND, not forbidden",
       r.status === 404, String(r.status));
    ok("C17 …and was not mutated", after.assigned_user_id === null &&
       after.accepted_by_user_id === null, JSON.stringify(after));
  }

  /* ═══ E · ASK SPINE READS IT ════════════════════════════════════ */
  sec("E · Ask Spine reads the resulting canonical state immediately");
  {
    const wo = await mkWo();
    const o = await mkObl(wo);
    await claim(o, "alice");
    const e = await executor.execute(pool, {
      intent_slug: C2, property_id: PROP, allowed_modules: ["maintenance"] });
    const rec = e.supporting_records.find((x) => x.obligation_id === o);
    ok("E1  a self-claimed obligation reads ASSIGNED_ACCEPTED",
       rec && rec.ownership_state === "assigned_accepted", rec && rec.ownership_state);
    ok("E2  …with the acceptance instant", rec && !!rec.accepted_at);
    ok("E3  …and Ask Spine changed nothing to learn it",
       (await read(o)).ownership_origin === "self_claimed");
  }

  /* ═══ D · THE 142 PREFLIGHT ═════════════════════════════════════ */
  sec("D · the VALIDATE preflight reports, and never repairs");
  {
    const run = () => spawnSync(process.execPath,
      [path.join(ROOT, "tools/build1/preflight_142_orphaned_acceptance.js"), "--json"],
      { env: { ...process.env, DATABASE_URL: URL }, encoding: "utf8" });

    const clean = run();
    ok("D1  a clean database exits 0", clean.status === 0, String(clean.status));
    const cj = JSON.parse(clean.stdout);
    ok("D2  …reports zero violations", cj.violations === 0, JSON.stringify(cj.violations));
    ok("D3  …and names the exact VALIDATE statement",
       /validate constraint ck_oblig_acceptance_has_owner/.test(cj.next_step), cj.next_step);

    //  And VALIDATE actually succeeds on that clean database.
    let validated = null;
    try { await c.query(cj.next_step); } catch (e) { validated = e.message; }
    ok("D4  …and VALIDATE succeeds", validated === null, String(validated));

    //  Now manufacture a legacy orphan the only way one can now exist:
    //  the constraint has to be dropped to create what it forbids.
    await c.query(`alter table obligations drop constraint ck_oblig_acceptance_has_owner`);
    const wo = await mkWo();
    const o = await mkObl(wo);
    await claim(o, "alice");
    await c.query(`update obligations set assigned_user_id = null where id = $1`, [o]);
    await c.query(fs.readFileSync(
      path.join(ROOT, "migrations/142_obligation_acceptance_cannot_be_orphaned.sql"), "utf8"));

    const dirty = run();
    ok("D5  with a legacy orphan present the preflight exits 1", dirty.status === 1,
       String(dirty.status));
    const dj = JSON.parse(dirty.stdout);
    ok("D6  …reporting the exact row", dj.violations === 1 &&
       dj.rows[0].obligation_id === o, JSON.stringify(dj.rows[0] || {}).slice(0, 150));
    ok("D7  …with the fields needed to judge it",
       ["obligation_id", "property_id", "assigned_user_id", "accepted_by_user_id", "status"]
         .every((k) => k in dj.rows[0]), JSON.stringify(Object.keys(dj.rows[0])));
    ok("D8  …and REFUSES to guess how history should be corrected",
       /STOP/.test(dj.next_step) && /does not choose/.test(dj.next_step), dj.next_step);
    ok("D9  …and repaired nothing", (await read(o)).accepted_by_user_id !== null,
       "a preflight that fixed the row would be writing history, not reporting it");

    //  VALIDATE must refuse while the orphan stands.
    let refused = null;
    try { await c.query(`alter table obligations validate constraint ck_oblig_acceptance_has_owner`); }
    catch (e) { refused = e.message; }
    ok("D10 VALIDATE is refused while the orphan exists", !!refused,
       String(refused).slice(0, 100));
    ok("D11 …but NEW writes are still protected, because 142 is NOT VALID", await (async () => {
      const wo2 = await mkWo(); const o2 = await mkObl(wo2);
      await claim(o2, "alice");
      try { await c.query(`update obligations set assigned_user_id=null where id=$1`, [o2]); return false; }
      catch (e) { return /ck_oblig_acceptance_has_owner/.test(e.message); }
    })(), "NOT VALID protects the future without pretending history is reconciled");

    //  Clean the orphan up the honest way — restore the assignment — so
    //  later sections run on a coherent population.
    await c.query(`update obligations set assigned_user_id = accepted_by_user_id where id=$1`, [o]);
  }

  /* ═══ F · THE ADVERSARIAL PASS ══════════════════════════════════ */
  sec("F · attacking only the facts Capability 2 consumes");
  {
    const wo = await mkWo();
    const o = await mkObl(wo);
    await claim(o, "alice");

    const attacks = [
      ["raw SQL unassign of an accepted obligation",
       `update obligations set assigned_user_id=null where id='${o}'`],
      ["raw SQL reassign of an accepted obligation",
       `update obligations set assigned_user_id='${BOB}' where id='${o}'`],
      ["duplicate acceptance under a second key",
       `update obligations set accepted_by_user_id='${BOB}', accepted_at=now() where id='${o}'`],
    ];
    for (const [what, sql] of attacks) {
      let refused = null;
      // eslint-disable-next-line no-await-in-loop
      try { await c.query(sql); } catch (e) { refused = e.message; }
      ok(`F·  ${what} → REFUSED`, !!refused, "it COMMITTED — " + sql);
      if (refused) console.log("        " + refused.split("\n")[0].slice(0, 88));
    }

    //  Replay of an old acceptance against resolved work.
    await c.query(`update obligations set status='complete', completed_at=now() where id=$1`, [o]);
    const late = await acceptance.acceptWork(c, { obligation_id: o, user_id: ALICE,
      organization_id: ORG, acceptance_key: `self_claim:${o}:${ALICE}` });
    ok("F4  replaying an old acceptance on RESOLVED work is a no-op",
       late.outcome === "replayed" || late.outcome === "refused", JSON.stringify(late.outcome));

    //  A resolved obligation leaves the current-state population — by
    //  design, and worth asserting rather than assuming.
    const e = await executor.execute(pool, {
      intent_slug: C2, property_id: PROP, allowed_modules: ["maintenance"] });
    ok("F5  a resolved obligation leaves the CURRENT population",
       !e.supporting_records.some((x) => x.obligation_id === o),
       "this intent answers what somebody currently has to do");

    //  An obligation whose work order reference is broken.
    const ghost = (await c.query(
      `insert into obligations (property_id,related_id,related_type,module,type,label,status)
       values ($1,$2,'work_order','maintenance','work_order_routing','ghost','open') returning id`,
      [PROP, ID("nonexistent-wo")])).rows[0].id;
    const e2 = await executor.execute(pool, {
      intent_slug: C2, property_id: PROP, allowed_modules: ["maintenance"] });
    ok("F6  an obligation with a dangling work-order reference is EXCLUDED, not crashed",
       e2.coverage_state === "decisive" &&
       !e2.supporting_records.some((x) => x.obligation_id === ghost),
       e2.coverage_state);
    findings.push(
      "An obligation whose related_id names no existing work order is silently " +
      "absent from this intent's population — the candidate predicate INNER JOINs " +
      "work_orders. That is the right answer for a question about work-order " +
      "maintenance ownership, and there is no FK on (related_type, related_id) to " +
      "prevent such a row, so it is worth knowing it is excluded rather than " +
      "assuming it cannot exist. It is not a state that reads as the WRONG " +
      "ownership; it reads as absent.");

    //  THE CONTRACT CONTRADICTION TEST: can any representable row be
    //  none of the three states?
    const rogue = (await c.query(
      `select count(*)::int n from obligations
        where not (
          (assigned_user_id is null and accepted_by_user_id is null)
          or (assigned_user_id is not null and accepted_by_user_id is null)
          or (assigned_user_id is not null and accepted_by_user_id = assigned_user_id))`
    )).rows[0].n;
    ok("F7  NO row is outside the three ownership states", Number(rogue) === 0,
       `${rogue} rows are none of unassigned / assigned-not-accepted / assigned-accepted ` +
       "— that would be a contract contradiction");

    //  A deactivated accepter: the FACT must survive.
    const wo3 = await mkWo();
    const o3 = await mkObl(wo3);
    await claim(o3, "bob");
    await c.query(`update property_team_assignments set active=false
                    where user_id=$1 and property_id=$2`, [BOB, PROP]);
    const e3 = await executor.execute(pool, {
      intent_slug: C2, property_id: PROP, allowed_modules: ["maintenance"] });
    const rec3 = e3.supporting_records.find((x) => x.obligation_id === o3);
    ok("F8  a deactivated accepter stays ACCEPTED",
       rec3 && rec3.ownership_state === "assigned_accepted", rec3 && rec3.ownership_state);
    ok("F9  …with the display identity honestly absent, not the fact",
       rec3 && rec3.assignee_display === null && rec3.assigned_user_id === BOB,
       JSON.stringify(rec3));
    await c.query(`update property_team_assignments set active=true
                    where user_id=$1 and property_id=$2`, [BOB, PROP]);
  }

  sec("FINDINGS");
  if (!findings.length) console.log("  none.");
  for (const f of findings) console.log("  ⚠ " + f.replace(/(.{74}) /g, "$1\n    ") + "\n");

  sec("VERDICT");
  console.log(`  passed ${pass}   failed ${fail}\n`);
  server.close();
  c.release();
  await pool.end();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("\nERROR:\n" + (e && e.stack || e)); process.exit(1); });
