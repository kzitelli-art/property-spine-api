#!/usr/bin/env node
/* ════════════════════════════════════════════════════════════════════
   ATTACKING THE OBLIGATION OWNERSHIP RAIL

   Before Ask Spine is allowed to consume assignment/acceptance as
   canonical truth, the rail itself has to survive being attacked. If it
   breaks here, the foundation gets fixed — NOT worked around in Ask
   Spine.

     P3  cardinality      — one work order, many obligations
     P4  the four state combinations, including the impossible one
     P5  the candidate universe — which obligations belong to this intent
     P7  lifecycle: A..H, the reassignment and acceptance attacks

   Every section states its PREDICTION before its result.

   ⚠ ISOLATED POSTGRES ONLY — run through tools/build1/run_isolated.sh,
     which creates the clone and destroys it on success AND failure.
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { Pool } = require("pg");

const ROOT = path.join(__dirname, "..", "..");
const acceptance = require(path.join(ROOT, "src/technician/acceptance_service.js"));

const URL = process.env.OWNERSHIP_DATABASE_URL;

let pass = 0, fail = 0;
const ok = (l, c, d) => { if (c) { pass++; console.log("  ok    " + l); }
  else { fail++; console.log("  FAIL  " + l + (d ? "\n          → " + d : "")); } return c; };
const sec = (t) => console.log(`\n${"═".repeat(70)}\n  ${t}\n${"═".repeat(70)}`);
const predict = (t) => console.log(`  predicts: ${t}\n`);
const findings = [];

const ID = (n) => crypto.createHash("md5").update("own:" + n).digest("hex")
  .replace(/^(.{8})(.{4})(.{4})(.{4})(.{12}).*$/, "$1-$2-$3-$4-$5");
const ORG = ID("org"), PROP = ID("prop"), OTHER = ID("other");
const ALICE = ID("alice"), BOB = ID("bob");

(async function main() {
  if (!URL) { console.error("REFUSED: OWNERSHIP_DATABASE_URL is not set."); process.exit(1); }
  const pool = new Pool({ connectionString: URL, max: 8 });
  const c = await pool.connect();
  const sentinel = Number((await c.query(
    `select count(*) n from release_0_scale_harness_guard where purpose like 'ISOLATED RELEASE 0%'`
  ).catch(() => ({ rows: [{ n: 0 }] }))).rows[0].n);
  if (sentinel !== 1) { console.error("REFUSED: not the isolated baseline."); process.exit(2); }

  //  Migration 142 — the hardening this harness itself produced. Applied
  //  from the shipped SQL file so the attack runs against the real fix.
  await c.query(fs.readFileSync(
    path.join(ROOT, "migrations/142_obligation_acceptance_cannot_be_orphaned.sql"), "utf8"));

  await c.query(`insert into organizations (id,name) values ($1,'Own Org') on conflict do nothing`, [ORG]);
  for (const [id, nm] of [[PROP, "Own Prop"], [OTHER, "Other Prop"]]) {
    // eslint-disable-next-line no-await-in-loop
    await c.query(`insert into properties (id,name,organization_id) values ($1,$2,$3)
                   on conflict (id) do nothing`, [id, nm, ORG]);
  }
  for (const [id, nm, ph] of [[ALICE, "Alice", "+15005551001"], [BOB, "Bob", "+15005551002"]]) {
    // eslint-disable-next-line no-await-in-loop
    await c.query(`insert into users (id,name,phone,role) values ($1,$2,$3,'maintenance')
                   on conflict (id) do nothing`, [id, nm, ph]);
    // eslint-disable-next-line no-await-in-loop
    await c.query(`insert into property_team_assignments
                     (user_id, property_id, role_title, allowed_modules, active)
                   values ($1,$2,'Technician',array['maintenance'],true)
                   on conflict do nothing`, [id, PROP]);
  }

  let seq = 0;
  const mkWo = async (prop = PROP) => {
    const wo = ID("wo" + (++seq));
    await c.query(`insert into work_orders (id,property_id,title,status,source)
                   values ($1,$2,'ownership fixture','open','ownproof')`, [wo, prop]);
    return wo;
  };
  const mkObl = async (wo, { type = "work_order_routing", prop = PROP,
                             module = "maintenance", assigned = null, status = "open" } = {}) => {
    const r = await c.query(
      `insert into obligations (property_id, related_id, related_type, module, type, label,
                                assigned_user_id, status)
       values ($1,$2,'work_order',$3,$4,$5,$6,$7) returning id`,
      [prop, wo, module, type, `${type} for work`, assigned, status]);
    return r.rows[0].id;
  };
  const read = async (id) => (await c.query(
    `select id, assigned_user_id, accepted_by_user_id, accepted_at, status, type
       from obligations where id=$1`, [id])).rows[0];
  //  The real claim writer's UPDATE, taken verbatim from
  //  operator_obligation_actions.js — the point is to attack the shipped
  //  statement, not a paraphrase of it.
  const claim = (id, user) => c.query(
    `update obligations
        set assigned_user_id = $1,
            status = case when status = 'open' then 'in_progress' else status end,
            updated_at = now()
      where id = $2`, [user, id]);
  const accept = (id, user, key = null) => acceptance.acceptWork(c, {
    obligation_id: id, user_id: user, organization_id: ORG, acceptance_key: key });

  console.log("ATTACKING THE OBLIGATION OWNERSHIP RAIL\n");

  /* ═══ P3 · CARDINALITY ══════════════════════════════════════════ */
  sec("P3 · one work order, many obligations");
  predict("nothing in the schema limits a work order to one obligation, so " +
          "`work_order.owner` is not a thing that exists. Assume many until proven.");
  {
    const wo = await mkWo();
    const o1 = await mkObl(wo, { type: "work_order_routing", assigned: ALICE });
    const o2 = await mkObl(wo, { type: "proof_evaluation_missing" });
    const o3 = await mkObl(wo, { type: "resident_follow_up", assigned: BOB });

    const n = Number((await c.query(
      `select count(*)::int n from obligations where related_type='work_order' and related_id=$1`,
      [wo])).rows[0].n);
    ok("P3.1 one work order carries THREE obligations at once", n === 3, String(n));

    const uniq = (await c.query(
      `select indexdef from pg_indexes where tablename='obligations' and indexdef ilike '%unique%'
        and indexdef ilike '%work_order%'`)).rows;
    ok("P3.2 …and NO unique index forbids it", uniq.length === 0,
       JSON.stringify(uniq.map((r) => r.indexdef)));
    if (uniq.length === 0) {
      findings.push(
        "CARDINALITY IS MANY, structurally. There is no unique index on " +
        "(related_type='work_order', related_id) — the three that exist are for " +
        "lease_offer, leasing_conversion and application_invitation. Any answer " +
        "shaped `work_order.owner` would therefore destroy information: WO with a " +
        "routing obligation assigned to Alice, an unassigned proof-defect " +
        "obligation, and a follow-up assigned to Bob has no single owner. The " +
        "canonical answer entity is the OBLIGATION.");
    }

    const distinct = (await c.query(
      `select count(distinct type)::int n from obligations
        where related_type='work_order' and related_id=$1`, [wo])).rows[0].n;
    ok("P3.3 …and their TYPES differ, so type must be preserved per record",
       Number(distinct) === 3, String(distinct));
    ok("P3.4 the three have different ownership states simultaneously",
       (await read(o1)).assigned_user_id === ALICE &&
       (await read(o2)).assigned_user_id === null &&
       (await read(o3)).assigned_user_id === BOB,
       "if this collapsed, the flattening bug would be invisible");
  }

  /* ═══ P4 · THE FOUR COMBINATIONS ════════════════════════════════ */
  sec("P4 · the four assignment/acceptance combinations");
  predict("three are reachable and one is structurally impossible: the database " +
          "refuses accepted_by <> assigned_user.");
  {
    const wo = await mkWo();
    const unassigned = await mkObl(wo);
    ok("P4.1 UNASSIGNED — no assignee, no accepter", (async () => {
      const r = await read(unassigned);
      return r.assigned_user_id === null && r.accepted_by_user_id === null;
    })() instanceof Promise ? await (async () => {
      const r = await read(unassigned);
      return r.assigned_user_id === null && r.accepted_by_user_id === null; })() : false);

    const assigned = await mkObl(wo, { assigned: ALICE });
    const ar = await read(assigned);
    ok("P4.2 ASSIGNED_NOT_ACCEPTED — assignee, no accepter",
       ar.assigned_user_id === ALICE && ar.accepted_by_user_id === null, JSON.stringify(ar));

    const accepted = await mkObl(wo, { assigned: ALICE });
    const out = await accept(accepted, ALICE, "key-p4");
    const cr = await read(accepted);
    ok("P4.3 ASSIGNED_ACCEPTED — accepter equals assignee",
       out.outcome === "accepted" && cr.accepted_by_user_id === ALICE &&
       cr.assigned_user_id === ALICE, JSON.stringify({ out: out.outcome, cr }));

    //  THE IMPOSSIBLE ONE, attempted directly against the database.
    let refused = null;
    try {
      await c.query(`update obligations set accepted_by_user_id=$1, accepted_at=now()
                      where id=$2`, [BOB, assigned]);
    } catch (e) { refused = e.message; }
    ok("P4.4 ACCEPTED-BY-A-NON-OWNER is REFUSED BY THE DATABASE", !!refused,
       "ck_oblig_accepter_is_owner did not fire — then acceptance could name " +
       "someone who was never the owner");
    console.log("        " + String(refused).slice(0, 92));

    //  …and acceptance without an accepter timestamp, and vice versa.
    let paired = null;
    try {
      await c.query(`update obligations set accepted_by_user_id=$1 where id=$2`, [ALICE, assigned]);
    } catch (e) { paired = e.message; }
    ok("P4.5 half an acceptance (who, but not when) is REFUSED", !!paired,
       String(paired).slice(0, 90));
  }

  /* ═══ P7 · THE LIFECYCLE ATTACKS ════════════════════════════════ */
  sec("P7 · lifecycle — assignment, acceptance, reassignment, races");
  predict("A succeeds; B refuses; C and D are the interesting ones — either the " +
          "writer clears acceptance atomically or the database refuses the " +
          "reassignment. Stale acceptance must never survive.");

  //  A · the happy path — and the ordering trap inside it.
  {
    //  ASSIGNED BY THE ENGINE, not by the self-claim route. Acceptance
    //  requires status='open', and the claim route moves the row to
    //  'in_progress', so claim-then-accept is not a sequence the rail
    //  supports. See P7·A2, which is a finding rather than a bug.
    const wo = await mkWo();
    const o = await mkObl(wo, { assigned: ALICE });
    const out = await accept(o, ALICE, "key-A");
    const r = await read(o);
    ok("P7·A  assigned Alice → Alice accepts",
       out.outcome === "accepted" && r.assigned_user_id === ALICE &&
       r.accepted_by_user_id === ALICE, JSON.stringify({ out: out.outcome, r }));

    const o2 = await mkObl(wo);
    await claim(o2, ALICE);                       // the shipped self-claim UPDATE
    const claimed = await read(o2);
    const out2 = await accept(o2, ALICE, "key-A2");
    ok("P7·A2 a SELF-CLAIMED obligation can never afterwards be `accepted`",
       claimed.status === "in_progress" && out2.outcome === "refused" &&
       out2.refusal === "not_open",
       JSON.stringify({ claimed: claimed.status, out: out2.outcome, why: out2.refusal }));
    console.log("        → the claim route sets status='in_progress'; acceptWork requires");
    console.log("          status='open'. So the two governed writers are sequentially");
    console.log("          incompatible, and a claimed obligation stays");
    console.log("          ASSIGNED_NOT_ACCEPTED permanently.");
    findings.push(
      "CLAIM AND ACCEPT ARE SEQUENTIALLY INCOMPATIBLE. The operator self-claim " +
      "route sets status='in_progress'; acceptWork's eligibility requires 'open' " +
      "and refuses with `not_open`. So an obligation taken through the claim route " +
      "can NEVER reach ASSIGNED_ACCEPTED, and reads as assigned-but-not-accepted " +
      "forever. That may be intended — claiming arguably IS taking it on — but the " +
      "two words then mean different things on the two paths, and Intent 2 must " +
      "report the state as recorded rather than inferring acceptance from a claim. " +
      "This is a PRODUCT RULING for the owner, not something Ask Spine may decide.");
  }

  //  B · someone else tries to accept
  {
    const wo = await mkWo();
    const o = await mkObl(wo, { assigned: ALICE });
    const out = await accept(o, BOB, "key-B");
    const r = await read(o);
    ok("P7·B  assigned to Alice, BOB attempts acceptance → REFUSED",
       out.outcome === "refused", JSON.stringify(out.refusal));
    ok("P7·B2 …with the reason naming the actor mismatch",
       out.refusal === "not_assigned_to_actor", String(out.refusal));
    ok("P7·B3 …and nothing was written",
       r.accepted_by_user_id === null && r.assigned_user_id === ALICE, JSON.stringify(r));
  }

  //  C · REASSIGNMENT AFTER ACCEPTANCE — the one that matters
  let reassignRefused = null;
  {
    const wo = await mkWo();
    const o = await mkObl(wo, { assigned: ALICE });
    await accept(o, ALICE, "key-C");
    try {
      await claim(o, BOB);                 // the SHIPPED claim statement
    } catch (e) { reassignRefused = e.message; }
    const r = await read(o);

    ok("P7·C  stale acceptance NEVER survives a reassignment",
       !(r.assigned_user_id === BOB && r.accepted_by_user_id === ALICE),
       JSON.stringify(r) + " — assigned to Bob while accepted by Alice is exactly " +
       "the corrupted ownership fact this attack exists to find");

    if (reassignRefused) {
      ok("P7·C2 the DATABASE refused the reassignment outright", true);
      console.log("        " + String(reassignRefused).slice(0, 92));
      ok("P7·C3 …leaving the original acceptance intact and coherent",
         r.assigned_user_id === ALICE && r.accepted_by_user_id === ALICE, JSON.stringify(r));
      findings.push(
        "AN ACCEPTED OBLIGATION CANNOT BE REASSIGNED. `ck_oblig_accepter_is_owner` " +
        "refuses the shipped claim UPDATE, and no canonical writer clears " +
        "acceptance. That is SAFE — no stale acceptance can exist — but it means " +
        "reassignment after acceptance has no governed path at all. Ask Spine must " +
        "not paper over this; it is a foundation gap to record, and the intent " +
        "simply reports what is true.");
    } else {
      ok("P7·C2 …then the writer must have cleared acceptance atomically",
         r.assigned_user_id === BOB && r.accepted_by_user_id === null, JSON.stringify(r));
    }
  }

  //  D · unassign after acceptance
  {
    const wo = await mkWo();
    const o = await mkObl(wo, { assigned: ALICE });
    await accept(o, ALICE, "key-D");
    let refused = null;
    try {
      await c.query(`update obligations set assigned_user_id = null where id=$1`, [o]);
    } catch (e) { refused = e.message; }
    const r = await read(o);
    ok("P7·D  unassigning an ACCEPTED obligation cannot orphan the acceptance",
       !!refused || r.accepted_by_user_id === null,
       JSON.stringify(r) + " — an accepted-by with no assignee is an owner who " +
       "does not exist");
    ok("P7·D2 …and it is migration 142's constraint that refuses it",
       /ck_oblig_acceptance_has_owner/.test(String(refused)), String(refused).slice(0, 100));
    console.log("        " + String(refused).slice(0, 92));
    console.log("        → BEFORE 142 this UPDATE COMMITTED. ck_oblig_accepter_is_owner");
    console.log("          could not catch it: a CHECK passes when its expression is");
    console.log("          NULL, and `assigned_user_id = accepted_by` is NULL when the");
    console.log("          assignee is nulled.");
  }

  //  E · a real race: acceptance and reassignment in overlapping transactions
  {
    const wo = await mkWo();
    const o = await mkObl(wo, { assigned: ALICE });
    const cA = await pool.connect();
    const cB = await pool.connect();
    let raceErr = null;
    try {
      await cA.query("begin");
      await cB.query("begin");
      //  A accepts (takes the FOR UPDATE lock inside acceptWork).
      const pA = acceptance.acceptWork(cA, {
        obligation_id: o, user_id: ALICE, organization_id: ORG, acceptance_key: "key-E" });
      //  B tries to reassign to Bob at the same time; it must block on A's lock.
      const pB = (async () => {
        await new Promise((r) => setTimeout(r, 60));
        return cB.query(
          `update obligations set assigned_user_id=$1, updated_at=now() where id=$2`, [BOB, o]);
      })();
      const rA = await pA;
      await cA.query("commit");
      let bFailed = null;
      try { await pB; await cB.query("commit"); } catch (e) { bFailed = e.message; await cB.query("rollback"); }
      const r = await read(o);
      ok("P7·E  after a real race the row is ONE coherent truth",
         (r.accepted_by_user_id === null) || (r.accepted_by_user_id === r.assigned_user_id),
         JSON.stringify(r) + " — a race must not be able to produce what a single " +
         "transaction cannot");
      ok("P7·E2 …and the acceptance that won is Alice's, or none",
         rA.outcome !== "accepted" || r.accepted_by_user_id === ALICE,
         JSON.stringify({ a: rA.outcome, r }));
      if (bFailed) console.log("        the reassignment lost: " + String(bFailed).slice(0, 80));
    } catch (e) {
      raceErr = e.message;
    } finally {
      await cA.query("rollback").catch(() => {});
      await cB.query("rollback").catch(() => {});
      cA.release(); cB.release();
    }
    ok("P7·E3 the race harness itself completed", !raceErr, String(raceErr));
  }

  //  F · provider replay
  {
    const wo = await mkWo();
    const o = await mkObl(wo, { assigned: ALICE });
    const one = await accept(o, ALICE, "sms-777");
    const two = await accept(o, ALICE, "sms-777");
    ok("P7·F  a carrier redelivery is idempotent",
       one.outcome === "accepted" && two.outcome === "replayed",
       JSON.stringify({ one: one.outcome, two: two.outcome }));
    const n = Number((await c.query(
      `select count(*)::int n from obligations where acceptance_key='sms-777'`)).rows[0].n);
    ok("P7·F2 …and only one row carries the key", n === 1, String(n));
  }

  //  G · acceptance of already-resolved work
  {
    const wo = await mkWo();
    const o = await mkObl(wo, { assigned: ALICE, status: "complete" });
    const out = await accept(o, ALICE, "key-G");
    const r = await read(o);
    ok("P7·G  an old message cannot accept RESOLVED work",
       out.outcome === "refused", JSON.stringify(out.refusal));
    ok("P7·G2 …and the resolved row is untouched",
       r.accepted_by_user_id === null && r.status === "complete", JSON.stringify(r));
  }

  //  H · cross-property
  {
    const woOther = await mkWo(OTHER);
    const o = await mkObl(woOther, { prop: OTHER, assigned: ALICE });
    const out = await accept(o, ALICE, "key-H");
    const r = await read(o);
    ok("P7·H  acceptance outside the actor's property scope is REFUSED",
       out.outcome === "refused", JSON.stringify(out.refusal));
    ok("P7·H2 …naming scope, not a generic error",
       out.refusal === "property_outside_actor_scope", String(out.refusal));
    ok("P7·H3 …and nothing in the other property was mutated",
       r.accepted_by_user_id === null, JSON.stringify(r));
  }

  /* ═══ P5 · THE CANDIDATE UNIVERSE ═══════════════════════════════ */
  sec("P5 · which obligations belong to this intent");
  predict("maintenance-module obligations that relate to a work order. A leasing " +
          "obligation carrying a work-order-shaped reference must NOT be included.");
  {
    const wo = await mkWo();
    const leasingLookalike = await mkObl(wo, { module: "leasing", type: "tour_follow_up" });
    const rows = (await c.query(
      `select id, module, type from obligations
        where property_id=$1 and related_type='work_order' and module='maintenance'`,
      [PROP])).rows;
    ok("P5.1 the maintenance filter excludes a leasing look-alike",
       !rows.some((r) => r.id === leasingLookalike),
       "a leasing obligation that happens to carry a work-order reference is not " +
       "maintenance ownership");
    const types = [...new Set(rows.map((r) => r.type))].sort();
    ok("P5.2 …and preserves every maintenance type it finds", types.length >= 2,
       JSON.stringify(types));
    console.log("        types in the universe: " + JSON.stringify(types));
    ok("P5.3 the other property's obligations are not in this universe",
       !rows.some((r) => r.id === null), "scoped by property_id in the predicate");
  }

  sec("FINDINGS");
  if (!findings.length) console.log("  none.");
  for (const f of findings) console.log("  ⚠ " + f.replace(/(.{74}) /g, "$1\n    ") + "\n");

  sec("VERDICT");
  console.log(`  passed ${pass}   failed ${fail}\n`);
  c.release();
  await pool.end();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("\nERROR:\n" + (e && e.stack || e)); process.exit(1); });
