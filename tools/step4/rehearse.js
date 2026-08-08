#!/usr/bin/env node
/* ════════════════════════════════════════════════════════════════════
   STEP 4 — REHEARSE THE PRODUCTION PROOF, IN ISOLATION

   On the day, `prove_completion.js` runs against PRODUCTION, once, over
   rows a human generated with a phone. There is no second attempt.

   So the assertions are proven FIRST. This drives a real completion
   through the canonical service against isolated PostgreSQL, runs the
   very same fact functions, and then MUTATES EACH FACT AWAY to prove the
   matching check goes red.

   ── AN ASSERTION THAT HAS NEVER FAILED IS NOT A CONTROL ─────────────

   Eight green facts over a genuine completion proves the happy path can
   be recognised. It does not prove a HOLLOW completion would be caught,
   and the hollow completion is the entire subject of Release 0. So every
   fact has a variant that removes exactly it.

   ⚠ ISOLATED POSTGRES ONLY. Needs 137 (+138/139 for the defect facts).

   usage:
     bash tools/steps23/baseline_136.sh
     PROVE_DATABASE_URL='...' node tools/steps23/apply_137.js
     STEP4_DATABASE_URL='postgresql://postgres@127.0.0.1:5433/r0scale?sslmode=disable' \
       node tools/step4/rehearse.js
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { Pool } = require("pg");

const ROOT = path.join(__dirname, "..", "..");
const lifecycle = require(path.join(ROOT, "src/technician/lifecycle_service.js"));
const reader = require(path.join(ROOT, "src/surfaces/work_order_status_read.js"));
const activation = require(path.join(ROOT, "src/release0/activation_service.js"));
const F = require("./completion_facts.js");
//  migration 140 REFUSES to let recordActivation run without it, so a
//  harness that activates must install it. States the guard forbids are
//  then built inside an explicit withGuardOff() window.
const guardWindow = require("../step12/guard_window.js");
const URL = process.env.STEP4_DATABASE_URL;

let pass = 0, fail = 0;
const ok = (l, c, d) => { if (c) { pass++; console.log("  ok    " + l); }
  else { fail++; console.log("  FAIL  " + l + (d ? "\n          → " + d : "")); } return c; };
const sec = (t) => console.log(`\n${"═".repeat(66)}\n  ${t}\n${"═".repeat(66)}`);

const ID = (n) => crypto.createHash("md5").update("s4reh:" + n).digest("hex")
  .replace(/^(.{8})(.{4})(.{4})(.{4})(.{12}).*$/, "$1-$2-$3-$4-$5");
const ORG = ID("org"), PROP = ID("prop"), TECH = ID("tech");
const CUTOVER = new Date(Date.parse("2026-08-08T09:15:00.000Z"));

(async function main() {
  if (!URL) { console.error("REFUSED: STEP4_DATABASE_URL is not set."); process.exit(1); }
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

  console.log("STEP 4 — REHEARSAL: the production assertions, proven and falsified\n");
  for (const m of ["138_proof_evaluation_defect_obligation.sql",
                   "139_no_longer_applicable_resolution.sql"]) {
    await c.query(fs.readFileSync(path.join(ROOT, "migrations", m), "utf8"));
  }

  await c.query(`insert into organizations (id,name) values ($1,'S4 Org') on conflict (id) do nothing`, [ORG]);
  await c.query(`insert into properties (id,name,organization_id) values ($1,'S4 Property',$2)
                 on conflict (id) do nothing`, [PROP, ORG]);
  await c.query(`insert into users (id,name,phone,role,is_active,status)
                 values ($1,'Tess Handset','+15415559401','maintenance',true,'active')
                 on conflict (id) do nothing`, [TECH]);
  await c.query(`insert into property_team_assignments (user_id,property_id,role_title,allowed_modules,active)
                 values ($1,$2,'Maintenance Tech',array['maintenance'],true)`, [TECH, PROP]);

  /*  The rehearsal runs with production's own containment in place. Every
   *  genuine completion below therefore also demonstrates that the
   *  canonical writer commits cleanly UNDER migration 140 — and section H,
   *  the hollow completion, is the one thing here that has to be built
   *  with it explicitly off. */
  await guardWindow.installGuard(c);
  const forbidden = (why, fn) => guardWindow.withGuardOff(c, why, fn);

  const census = await activation.readLegacyTerminalSet(c);
  await c.query("begin");
  await activation.recordActivation(c, {
    activated_at: CUTOVER, captured_by: "step 4 rehearsal", expected: census });
  await c.query("commit");

  let seq = 0;
  /*  A work order completed exactly the way the handset will do it: an
   *  inbound message, a preserved attachment carrying that message's id,
   *  then the canonical service. No shortcut writes anywhere. */
  const completeOne = async (label) => {
    const n = ++seq;
    const wo = ID("wo" + n), att = ID("att" + n), ce = ID("ce" + n);
    await c.query(`insert into work_orders (id,property_id,title,status,source)
                   values ($1,$2,$3,'open','s4rehearsal')`, [wo, PROP, label]);
    await c.query(`insert into obligations (property_id,related_id,related_type,module,type,label,status)
                   values ($1,$2,'work_order','maintenance','work_order_routing','r','open')`, [PROP, wo]);
    await c.query(`insert into comm_events
                     (id,property_id,channel,direction,body,occurred_at,classification,
                      created_object_type,created_object_id)
                   values ($1,$2,'sms','inbound','done',now(),'work_order_update','work_order',$3)`,
                  [ce, PROP, wo]);
    const b = Buffer.from([9, 9, 9, 9, 9]);
    await c.query(`insert into work_order_proof_attachments
      (id,work_order_id,property_id,uploaded_by_user_id,provider,provider_media_id,mime_type,
       storage_state,proof_classification,content,byte_size,sha256,stored_at,source_comm_event_id)
      values ($1,$2,$3,$4,'twilio',$5,'image/jpeg','stored','repair_photo',$6,$7,$8,now(),$9)`,
      [att, wo, PROP, TECH, "ME" + att.slice(0, 8), b, b.length,
       crypto.createHash("sha256").update(b).digest("hex"), ce]);
    await c.query("begin");
    const out = await lifecycle.claimCompletion(c, {
      work_order_id: wo, user_id: TECH, organization_id: ORG,
      source_comm_event_id: ce, idempotency_key: "s4-" + n });
    await c.query("commit");
    return { wo, att, ce, out };
  };

  const bind = (x) => ({ work_order_id: x.wo, property_id: PROP,
                         actor_user_id: TECH, source_comm_event_id: x.ce });

  // ══ P — A GENUINE COMPLETION SATISFIES EVERY FACT ══════════════════
  sec("P · THE HAPPY PATH — EIGHT FACTS OVER A REAL GOVERNED COMPLETION");
  const good = await completeOne("rehearsal happy path");
  ok("P0  the canonical service actually completed it", good.out.closed === true,
     JSON.stringify({ outcome: good.out.outcome, missing: good.out.missing }));
  {
    const r = await F.checkCompletionFacts(c, bind(good));
    for (const f of r.facts) {
      ok(`P·${f.id.padEnd(4)} ${f.name}`, f.held,
         f.detail + "  " + JSON.stringify(f.observed).slice(0, 220));
    }
    ok("P·all  every named fact held", r.allHeld);
    ok("P·A1x  the A1 capstone was CONCLUSIVE, not skipped", r.capstoneIndeterminate === false,
       "xmin could not answer — the parent-side assertion did not actually run");
    //  A2 is EXPECTED to be indeterminate here: track_commit_timestamp is off
    //  by default. Recorded rather than hidden, because "green" and "the
    //  server was never asked" must never look the same.
    console.log("        A2 atomicity capstone: " +
      (r.atomicityIndeterminate ? "INDETERMINATE — " + r.atomicityReason : "conclusive"));

    const n = await F.checkNoParallelWriter(c, bind(good));
    for (const f of n.facts) ok(`P·${f.id.padEnd(4)} ${f.name}`, f.held,
      f.detail + "  " + JSON.stringify(f.observed).slice(0, 200));
  }

  // ══ V — EVERY FACT CAN FAIL ════════════════════════════════════════
  //  Each variant removes EXACTLY ONE fact from a genuine completion and
  //  asserts the matching check — and only it — goes red. A check that
  //  cannot go red is decoration; a check that takes its neighbours down
  //  with it cannot tell you what actually broke.
  sec("V · EVERY FACT HAS A MUTATION THAT KILLS IT");
  /*  `alsoExpected` names the facts that LEGITIMATELY fall with the
   *  target. Deleting the claim really does make "the claim traces to its
   *  message" and "the completed row is distinct from the claim"
   *  unanswerable — those are dependencies, not collateral damage.
   *
   *  Declaring them beats either alternative: demanding surgical isolation
   *  everywhere would be false, and dropping the check would let one
   *  mutation quietly redden half the set. */
  const variants = [
    { id: "F1", what: "delete the completion claim", alsoExpected: ["F1b", "F6"],
      run: async (x) => c.query(
        `delete from work_order_progress where work_order_id=$1 and kind='completion_claimed'`, [x.wo]) },
    { id: "F1b", what: "unlink the claim from its inbound message", alsoExpected: [],
      run: async (x) => c.query(
        `update work_order_progress set source_comm_event_id=null
          where work_order_id=$1 and kind='completion_claimed'`, [x.wo]) },
    { id: "F2", what: "un-classify the evaluated attachment", alsoExpected: [],
      run: async (x) => c.query(
        `update work_order_proof_attachments set proof_classification='unclassified'
          where work_order_id=$1`, [x.wo]) },
    /*  `ck_wopa_stored_is_complete` refuses a half-un-stored row — the
     *  four durable fields move together with the state or not at all. An
     *  earlier attempt cleared only sha256 and the DATABASE refused it,
     *  which is the constraint doing exactly its job and is why the
     *  mutation has to clear all four. */
    { id: "F2", what: "un-preserve the evaluated attachment entirely", alsoExpected: [],
      run: async (x) => c.query(
        `update work_order_proof_attachments
            set storage_state='not_preserved', content=null, byte_size=null,
                sha256=null, stored_at=null
          where work_order_id=$1`, [x.wo]) },
    { id: "F5", what: "leave the work order open", alsoExpected: ["A1"],
      run: async (x) => c.query(`update work_orders set status='open' where id=$1`, [x.wo]) },
    { id: "F6", what: "delete the distinct `completed` progress row", alsoExpected: ["F8"],
      run: async (x) => c.query(
        `delete from work_order_progress where work_order_id=$1 and kind='completed'`, [x.wo]) },
    { id: "F7", what: "reopen the owning obligation", alsoExpected: ["A1"],
      run: async (x) => c.query(
        `update obligations set status='open', completed_at=null, resolution_code=null
          where related_id=$1 and type='work_order_routing'`, [x.wo]) },
    { id: "F8", what: "delete the action receipt", alsoExpected: [],
      run: async (x) => c.query(
        `delete from events where type='work_order_completed'
          and note::jsonb->>'work_order_id' = $1`, [x.wo]) },
    { id: "A1", what: "touch the work order in a LATER transaction", alsoExpected: [],
      //  The hollow completion in its purest form at the row level: every
      //  fact exists and they were not written together.
      run: async (x) => c.query(
        `update work_orders set updated_at = updated_at where id=$1`, [x.wo]) },
  ];

  for (const v of variants) {
    // eslint-disable-next-line no-await-in-loop
    const x = await completeOne("variant " + v.id);
    // eslint-disable-next-line no-await-in-loop
    const before = await F.checkCompletionFacts(c, bind(x));
    if (!before.allHeld) {
      ok(`V·${v.id.padEnd(4)} the control started green`, false,
         "the variant's own completion was already broken: " +
         before.facts.filter((f) => !f.held).map((f) => f.id).join(","));
      continue;
    }
    // eslint-disable-next-line no-await-in-loop
    await v.run(x);
    // eslint-disable-next-line no-await-in-loop
    const after = await F.checkCompletionFacts(c, bind(x));
    const broke = after.facts.filter((f) => !f.held).map((f) => f.id);
    ok(`V·${v.id.padEnd(4)} ${v.what} → ${v.id} goes RED`,
       broke.includes(v.id), "red facts: [" + broke.join(", ") + "]");
    const allowed = new Set([v.id, ...v.alsoExpected]);
    const unexpected = broke.filter((b) => !allowed.has(b));
    ok(`V·${v.id.padEnd(4)} …and reddens only what genuinely depends on it`,
       unexpected.length === 0,
       "unexpectedly red: " + unexpected.join(", ") +
       "  (declared dependents: " + (v.alsoExpected.join(", ") || "none") + ")");
  }

  // ══ H — THE HOLLOW COMPLETION ══════════════════════════════════════
  //  THE SCENARIO RELEASE 0 EXISTS FOR. Not a mutation of a good
  //  completion — a work order that carries every OUTWARD sign of being
  //  completed and has NO EVALUATION BEHIND IT. That is what a surviving
  //  legacy writer, or a hand-run UPDATE, actually produces.
  //
  //  It has to be built rather than mutated: `work_order_proof_evaluations`
  //  is append-only, so a genuine evaluation cannot be deleted or edited.
  //  The schema refusing the mutation is itself worth recording.
  sec("H · THE HOLLOW COMPLETION — EVERY SIGN, NO EVALUATION");
  {
    const wo = ID("hollow"), ce = ID("hollowce");
    /*  Post-activation this insert is exactly what migration 140 refuses,
     *  so the scenario Release 0 exists for now has to be manufactured
     *  with the guard off. That is the strongest single statement of what
     *  the guard is for — the fact set below still refuses it, and the
     *  database now refuses it one layer earlier. */
    await forbidden(
      "H IS the hollow completion; post-activation the guard makes it uncommittable",
      () => c.query(`insert into work_orders (id,property_id,title,status,source)
                     values ($1,$2,'hollow','complete','legacy')`, [wo, PROP]));
    await c.query(`insert into obligations
                     (property_id,related_id,related_type,module,type,label,status,
                      completed_at,resolution_code)
                   values ($1,$2,'work_order','maintenance','work_order_routing','r',
                           'complete',now(),'satisfied')`, [PROP, wo]);
    await c.query(`insert into comm_events
                     (id,property_id,channel,direction,body,occurred_at,classification,
                      created_object_type,created_object_id)
                   values ($1,$2,'sms','inbound','done',now(),'work_order_update','work_order',$3)`,
                  [ce, PROP, wo]);
    for (const kind of ["completion_claimed", "completed"]) {
      // eslint-disable-next-line no-await-in-loop
      const r = (await c.query(`insert into work_order_progress
        (work_order_id,property_id,kind,reported_by_user_id,source_comm_event_id,occurred_at)
        values ($1,$2,$3,$4,$5,now()) returning id`, [wo, PROP, kind, TECH, ce])).rows[0];
      // eslint-disable-next-line no-await-in-loop
      await c.query(`insert into events (property_id,type,note) values ($1,$2,$3)`,
        [PROP, `work_order_${kind}`,
         JSON.stringify({ work_order_id: wo, progress_id: r.id, reported_by_user_id: TECH })]);
    }

    const h = await F.checkCompletionFacts(c,
      { work_order_id: wo, property_id: PROP, actor_user_id: TECH, source_comm_event_id: ce });
    const red = h.facts.filter((f) => !f.held).map((f) => f.id);
    ok("H1  it LOOKS complete — status, both progress rows, obligation, receipt",
       ["F1", "F1b", "F5", "F6", "F7", "F8"].every((id) =>
         h.facts.find((f) => f.id === id).held),
       "red: " + red.join(","));
    ok("H2  …and the evaluation facts REFUSE it",
       red.includes("F3") && red.includes("F3b") && red.includes("F2") && red.includes("F4"),
       "red: " + red.join(",") + " — a completion with nothing behind it passed");
    ok("H3  …so the receipt cannot be written", h.allHeld === false);
    console.log("        red facts: " + red.join(" · "));

    //  And the schema itself refuses to let a real evaluation be erased,
    //  which is why H had to be built rather than mutated.
    let refused = false;
    try {
      await c.query("begin");
      await c.query(`delete from work_order_proof_evaluations where work_order_id=$1`, [good.wo]);
      await c.query("rollback");
    } catch (e) { refused = /append-only/.test(e.message); await c.query("rollback").catch(() => {}); }
    ok("H4  a real evaluation cannot be deleted at all — append-only, enforced", refused,
       "the evaluation chain is editable; every proof above rests on it not being");
  }

  // ══ W — THE PARALLEL-WRITER CHECKS CAN FAIL TOO ════════════════════
  sec("W · THE NO-PARALLEL-WRITER CHECKS ARE NOT DECORATION");
  {
    const x = await completeOne("parallel writer");
    await c.query(
      `insert into events (property_id, type, note)
       values ($1,'work_order_closed',$2)`,
      [PROP, JSON.stringify({ work_order_id: x.wo })]);
    const n = await F.checkNoParallelWriter(c, bind(x));
    const red = n.facts.filter((f) => !f.held).map((f) => f.id);
    ok("W1  a legacy closeout event turns N1 RED", red.includes("N1"), red.join(","));

    const y = await completeOne("second completion");
    await c.query(`insert into work_order_progress
      (work_order_id,property_id,kind,reported_by_user_id,occurred_at)
      values ($1,$2,'completed',$3,now())`, [y.wo, PROP, TECH]);
    const n2 = await F.checkNoParallelWriter(c, bind(y));
    ok("W2  a second `completed` row turns N3 RED",
       n2.facts.filter((f) => !f.held).map((f) => f.id).includes("N3"),
       JSON.stringify(n2.facts.filter((f) => !f.held).map((f) => f.id)));
  }

  // ══ S — AND THE OPERATOR SURFACE REFLECTS IT (§7.4) ════════════════
  sec("S · THE SURFACE REFLECTS IT WITHOUT OPERATOR ACTION");
  {
    const s = await reader.readWorkOrderStatus(c, { propertyId: PROP, workOrderId: good.wo });
    ok("S1  the reader reports the work as completed", s.current.state === "completed",
       JSON.stringify(s.current.state));
    /*  `state`, never `satisfied`. §3.4's compatibility field is being
     *  retired by the cleanup release, and a Step 4 tool that reads it
     *  would work today and break the day the removal lands — on the one
     *  gate that gets exactly one attempt. `state` is correct in both
     *  worlds. */
    ok("S2  …with proof state `satisfied`, derived and not stored",
       s.proof.read_status === "ok" && s.proof.state === "satisfied",
       JSON.stringify({ rs: s.proof.read_status, state: s.proof.state }));
    ok("S3  …and nobody had to do anything for that to be true",
       s.current.completed_at !== null && s.next_action === null,
       JSON.stringify({ completed_at: s.current.completed_at, next: s.next_action }));
    ok("S4  …the preserved evidence is visible as evidence",
       s.proof.preserved_count === 1 && s.proof.not_preserved_count === 0,
       JSON.stringify({ p: s.proof.preserved_count, np: s.proof.not_preserved_count }));
  }

  sec("VERDICT");
  console.log(`  passed ${pass}   failed ${fail}`);
  c.release();
  await pool.end();
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error("\nERROR:\n" + (e && e.stack || e)); process.exit(1); });
