#!/usr/bin/env node
/* ════════════════════════════════════════════════════════════════════
   WHAT HAPPENS WHEN BOUNDARY X SUCCEEDS AND BOUNDARY Y FAILS?

   Every Release 0 candidate is green on its own. That is a statement
   about functions. A release is a SEQUENCE, and the failures that hurt
   are the ones between its steps: a migration that lands while the deploy
   does not, an activation that commits while the reader deploy fails, an
   old client against a new API.

   None of those are function bugs. Every component behaves exactly as
   specified in all of them.

   ── WHAT THIS FILE PRODUCES ─────────────────────────────────────────

   For each transition, three things, and the third is the point:

     OBSERVED    what the system actually does — measured, not reasoned
     STATE       the honest operating state, in the words an operator
                 would need to hear
     RECOVERY    the action. "Roll back" is not an answer when the
                 boundary is irreversible.

   A transition whose recovery is "you cannot" is not a failure of this
   file. It is the thing the runbook must prevent, stated before the day
   rather than discovered on it.

   ⚠ ISOLATED POSTGRES ONLY. Ledger 137, virgin activation history.

   usage:
     TRANSITION_DATABASE_URL='…' node tools/step13/falsify_release_transitions.js
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { Client } = require("pg");

const ROOT = path.join(__dirname, "..", "..");
const activation = require(path.join(ROOT, "src/release0/activation_service.js"));
const reader = require(path.join(ROOT, "src/surfaces/work_order_status_read.js"));
const lifecycle = require(path.join(ROOT, "src/technician/lifecycle_service.js"));
const guardWindow = require("../step12/guard_window.js");
const grounded = require("../step12/grounded_evaluation.js");
const URL = process.env.TRANSITION_DATABASE_URL;

let pass = 0, fail = 0;
const findings = [];
const ok = (l, c, d) => { if (c) { pass++; console.log("  ok    " + l); }
  else { fail++; console.log("  FAIL  " + l + (d ? "\n          → " + d : "")); } return c; };
const sec = (t) => console.log(`\n${"═".repeat(72)}\n  ${t}\n${"═".repeat(72)}`);
const report = (id, state, recovery) => {
  findings.push({ id, state, recovery });
  console.log(`        STATE     ${state}`);
  console.log(`        RECOVERY  ${recovery}`);
};

const ID = (n) => crypto.createHash("md5").update("trans:" + n).digest("hex")
  .replace(/^(.{8})(.{4})(.{4})(.{4})(.{12}).*$/, "$1-$2-$3-$4-$5");
const ORG = ID("org"), PROP = ID("prop"), TECH = ID("tech");
const CUTOVER = new Date(Date.parse("2026-08-08T09:15:00.000Z"));

(async function main() {
  if (!URL) { console.error("REFUSED: TRANSITION_DATABASE_URL is not set."); process.exit(1); }
  const open = async () => { const x = new Client({ connectionString: URL }); await x.connect(); return x; };
  const c = await open();
  if (Number((await c.query(
    `select count(*) n from release_0_scale_harness_guard where purpose like 'ISOLATED RELEASE 0%'`
  ).catch(() => ({ rows: [{ n: 0 }] }))).rows[0].n) !== 1) {
    console.error("REFUSED: not the isolated baseline."); process.exit(2);
  }
  if (Number((await c.query(`select count(*) n from release_0_activation_history`)).rows[0].n) > 0) {
    console.error("REFUSED: activation history is not empty. Rebuild the baseline."); process.exit(3);
  }

  console.log("RELEASE TRANSITIONS — what happens between the boundaries\n");

  await c.query(`insert into organizations (id,name) values ($1,'TX Org') on conflict (id) do nothing`, [ORG]);
  await c.query(`insert into properties (id,name,organization_id) values ($1,'TX Property',$2)
                 on conflict (id) do nothing`, [PROP, ORG]);
  await c.query(`insert into users (id,name,phone,role,is_active,status)
                 values ($1,'Tex Trans','+15415559981','maintenance',true,'active')
                 on conflict (id) do nothing`, [TECH]);
  await c.query(`insert into property_team_assignments
                   (user_id,property_id,role_title,allowed_modules,active)
                 values ($1,$2,'Maintenance Tech',array['maintenance'],true)`, [TECH, PROP]);

  let seq = 0;
  const mkWo = async (status = "open") => {
    const wo = ID("wo" + (++seq));
    await c.query(`insert into work_orders (id,property_id,title,status,source)
                   values ($1,$2,'trans',$3,'transproof')`, [wo, PROP, status]);
    return wo;
  };
  const readOf = async (wo) => reader.readWorkOrderStatus(c, { propertyId: PROP, workOrderId: wo });
  const statusOf = async (wo) => (await c.query(
    `select status from work_orders where id=$1`, [wo])).rows[0]?.status ?? null;

  /* ═══ T1 · MIGRATION LANDS, DEPLOY DOES NOT ═══════════════════════ */
  sec("T1 · MIGRATION 140 APPLIED, THE DEPLOY CARRYING IT NEVER SHIPS");
  {
    await guardWindow.installGuard(c);
    //  The old application code is still running: it knows nothing about
    //  the epoch, the guard or the four states. It just completes work.
    const wo = await mkWo("open");
    //  Real preserved evidence: the writer's gate refuses without it, and a
    //  refusal here would be the FIXTURE failing, not the transition.
    await grounded.preserveQualifyingEvidence(c,
      { work_order_id: wo, property_id: PROP, uploaded_by_user_id: TECH });
    await c.query("begin");
    const done = await lifecycle.claimCompletion(c, {
      work_order_id: wo, user_id: TECH, organization_id: ORG, idempotency_key: "t1" });
    await c.query("commit");
    ok("T1.1 the canonical writer still completes work with 140 applied and no activation",
       done.closed === true, JSON.stringify({ o: done.outcome, missing: done.missing }));
    const s = await readOf(wo);
    ok("T1.2 …and the reader reports `unavailable`, not a verdict",
       s.proof.read_status === "unavailable" && !("state" in s.proof),
       JSON.stringify(s.proof));
    report("T1",
      "SAFE AND INERT. 140 is applied and asleep: no activation row means the guard " +
      "returns immediately and nothing changes for any writer. This is the DESIGNED " +
      "ordering, not a lucky one — 7b is meant to sit ahead of 8 exactly like this.",
      "None. Deploy when ready. The migration may sit applied indefinitely; the only " +
      "rule is that it must not be applied AFTER the activation.");
  }

  /* ═══ T2 · DEPLOY LANDS, MIGRATION DOES NOT ══════════════════════ */
  sec("T2 · THE BUILD SHIPS CARRYING A MIGRATION THE DATABASE HAS NOT APPLIED");
  {
    const migrate = fs.readFileSync(path.join(ROOT, "migrations/migrate.js"), "utf8");
    ok("T2.1 prestart runs the migration runner in VERIFY-ONLY mode",
       /REFUSING TO START/i.test(migrate),
       "the boot path does not refuse on an unapplied migration");
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
    ok("T2.2 …and it is wired to prestart, so it is not optional",
       /migrate/.test(pkg.scripts.prestart || ""), JSON.stringify(pkg.scripts.prestart));
    report("T2",
      "OUTAGE, LOUD AND IMMEDIATE. The service does not come up: prestart verifies the " +
      "ledger and exits 1 with `REFUSING TO START`. No partial state, no half-migrated " +
      "runtime — the instance simply never serves.",
      "Run the migration release, then redeploy:\n" +
      "                  MIGRATION_RELEASE=1 EXPECTED_LEDGER_CEILING=<current> \\\n" +
      "                    EXPECTED_SHA=<the sha actually deploying> node migrations/migrate.js --apply\n" +
      "                  EXPECTED_SHA must be the SHA DEPLOYING, not the one you expected.");
  }

  /* ═══ T3 · ACTIVATION ATTEMPTED WHILE A WRITER IS ACTIVE ══════════ */
  sec("T3 · ACTIVATION ATTEMPTED WITH A WORK-ORDER WRITER IN FLIGHT");
  {
    const holder = await open();
    await holder.query("begin");
    await holder.query(`update work_orders set updated_at=now() where property_id=$1`, [PROP]);

    const census = await activation.readLegacyTerminalSet(c);
    let err = null;
    const t0 = Date.now();
    try {
      await c.query("begin");
      await activation.recordActivation(c, {
        activated_at: CUTOVER, captured_by: "T3", expected: census });
      await c.query("commit");
    } catch (e) { err = e; await c.query("rollback").catch(() => {}); }
    const waited = Date.now() - t0;
    await holder.query("rollback"); await holder.end();

    ok("T3.1 the activation REFUSES rather than serializing behind the writer",
       !!err && err.code === "WRITERS_IN_FLIGHT", err ? err.code : "IT ACTIVATED");
    ok("T3.2 …immediately, so it never queues in front of production",
       waited < 1500, waited + " ms");
    ok("T3.3 …and nothing was recorded",
       Number((await c.query(
         `select count(*) n from release_0_activation_history`)).rows[0].n) === 0);
    report("T3",
      `SAFE. Refused in ${waited} ms with WRITERS_IN_FLIGHT. Nothing partial exists. ` +
      "NOWAIT is deliberate: a WAITING lock request queues every new work-order writer " +
      "behind it, so a patient activation would stall production while holding nothing.",
      "Find the transaction (pg_stat_activity: state='idle in transaction' or an active " +
      "writer), wait for it to finish, RE-RUN THE CENSUS, and try again. Do not reduce " +
      "the lock and do not retry in a loop — a census taken before the wait is stale.");
  }

  /* ═══ T4 · ACTIVATION COMMITS, THE READER DEPLOY FAILS ════════════ */
  sec("T4 · ACTIVATION SUCCEEDS, THEN THE FOUR-STATE READER DEPLOY FAILS");
  {
    const legacy = await mkWo("closed");
    const census = await activation.readLegacyTerminalSet(c);
    await c.query("begin");
    await activation.recordActivation(c, {
      activated_at: CUTOVER, captured_by: "T4", expected: census });
    await c.query("commit");
    ok("T4.1 the activation committed", Number((await c.query(
      `select count(*) n from release_0_activation_history`)).rows[0].n) === 1);

    //  The OLD reader is what is running. It is not in this checkout, so
    //  what is measured is the DATABASE state the old reader would see —
    //  which is the honest question: is the data harmed?
    const s = await readOf(legacy);
    ok("T4.2 the inventoried legacy row reads `legacy_indeterminate`, not a defect",
       s.proof.state === "legacy_indeterminate", JSON.stringify(s.proof.state));
    const wo = await mkWo("open");
    await grounded.preserveQualifyingEvidence(c,
      { work_order_id: wo, property_id: PROP, uploaded_by_user_id: TECH });
    await c.query("begin");
    const done = await lifecycle.claimCompletion(c, {
      work_order_id: wo, user_id: TECH, organization_id: ORG, idempotency_key: "t4" });
    await c.query("commit");
    ok("T4.3 completions keep working through the canonical writer",
       done.closed === true, JSON.stringify(done.outcome));
    const v = (await c.query(
      `select count(*) n from release_0_completion_invariant_violations`)).rows[0].n;
    ok("T4.4 …and the invariant audit stays empty", Number(v) === 0, String(v));

    report("T4",
      "DEGRADED, NOT DAMAGED — and this is the IRREVERSIBLE side of the release. The " +
      "activation and inventory are append-only and cannot be undone. The guard is now " +
      "ARMED and correct; completions still work; the data is right. What is missing is " +
      "the SURFACE: the old reader cannot render the four states, so operators see the " +
      "pre-Release-0 rendering of rows the database now classifies precisely.",
      "ROLL FORWARD ONLY. Fix the deploy and ship the reader (#60), then #61/#62. Do NOT " +
      "attempt to reverse the activation — the tables refuse UPDATE and DELETE by " +
      "trigger, and a 'compensating' second activation is refused by uq_r0ah_genesis. " +
      "Nothing is losing data while you fix the pipeline.");
  }

  /* ═══ T5 · API RESTART BETWEEN BOUNDARIES ════════════════════════ */
  sec("T5 · THE API RESTARTS MID-SEQUENCE (autoscale, redeploy, crash)");
  {
    //  A restart is a new connection with a fresh snapshot. The question
    //  is whether any Release 0 state lives in process memory.
    const fresh = await open();
    const epochSeen = (await fresh.query(
      `select activation_id from release_0_activation_epoch`)).rows[0].activation_id;
    ok("T5.1 a brand-new connection sees the activation immediately",
       epochSeen !== null, "the epoch is null on a fresh connection");
    const wo = await mkWo("open");
    await grounded.preserveQualifyingEvidence(fresh,
      { work_order_id: wo, property_id: PROP, uploaded_by_user_id: TECH });
    await fresh.query("begin");
    const done = await lifecycle.claimCompletion(fresh, {
      work_order_id: wo, user_id: TECH, organization_id: ORG, idempotency_key: "t5" });
    await fresh.query("commit");
    ok("T5.2 …and completes work correctly with no warm-up",
       done.closed === true, JSON.stringify(done.outcome));
    await fresh.end();

    const src = fs.readFileSync(path.join(ROOT, "src/release0/proof_state.js"), "utf8");
    ok("T5.3 the activation authority is READ, never cached in process memory",
       !/global\.|module\.exports\.__cache|let\s+cached/i.test(src),
       "a cached activation would make the boundary depend on which instance answers, " +
       "and a restart would change behaviour");
    report("T5",
      "SAFE. Release 0 carries no process state. The activation, the epoch, the guard " +
      "and the inventory are all database facts, read per transaction, so a restart, an " +
      "autoscale event or a crash changes nothing. Instances at different SHAs disagree " +
      "about RENDERING, never about what is true.",
      "None required. This is why the preflight refuses to report the local SHA as " +
      "production's: instance identity matters for the surface, not for the invariant.");
  }

  /* ═══ T6 · OLD APP AGAINST NEW API ═══════════════════════════════ */
  sec("T6 · OLD APP AGAINST NEW API — the contract, both directions");
  {
    const wo = await mkWo("open");
    await grounded.preserveQualifyingEvidence(c,
      { work_order_id: wo, property_id: PROP, uploaded_by_user_id: TECH });
    await c.query("begin");
    await lifecycle.claimCompletion(c, {
      work_order_id: wo, user_id: TECH, organization_id: ORG, idempotency_key: "t6" });
    await c.query("commit");
    const s = await readOf(wo);

    /*  The cleanup release removed `satisfied` from the wire. An OLD app
     *  reads that field. What does it get? */
    ok("T6.1 the new API omits `satisfied` entirely", !("satisfied" in s.proof),
       JSON.stringify(Object.keys(s.proof)));
    ok("T6.2 …and still publishes `state`, which the old app ignores",
       s.proof.state === "satisfied", JSON.stringify(s.proof.state));

    const mapping = require(path.join(ROOT, "src/release0/proof_state.js")).SATISFIED_FOR;
    ok("T6.3 the §3.4 mapping is still exported, so the value is DERIVABLE",
       mapping.satisfied === true && mapping.legacy_indeterminate === null,
       JSON.stringify(mapping));
    report("T6",
      "BROKEN SURFACE, INTACT TRUTH — and this is why the runbook orders the cleanup " +
      "release app-first. An OLD app reading `proof.satisfied` gets `undefined`, which " +
      "JavaScript renders as neither true nor false: the proof block degrades to blank " +
      "or 'unknown' depending on the component. No wrong claim is made — an honest blank " +
      "beats a confident wrong — but the operator loses the proof column.",
      "STRICT ORDER, and it is already in the runbook as 13a → 13b → 13c: ship the app " +
      "consumers onto `state` FIRST (#39), then the post-removal app contract (#40), and " +
      "only then remove the field from the API (#63). Reversing that order produces this " +
      "state. If it happens: redeploy the app; no data is affected and nothing needs " +
      "repair.");
  }

  /* ═══ T7 · NEW APP AGAINST OLD API ═══════════════════════════════ */
  sec("T7 · NEW APP AGAINST OLD API — can this even exist?");
  {
    /*  The new app reads `state`. An old API — pre-#60 — publishes the
     *  boolean reader and no `state` at all. The app's normalizer already
     *  has a documented answer for that shape, and §3.4 calls it a
     *  CONTRACT FAILURE rather than a state to render. */
    const appNorm = path.join(ROOT, "..", "property-spine-app", "proof-normalizer.js");
    const has = fs.existsSync(appNorm);
    ok("T7.1 the app's normalizer is available to inspect", has, appNorm);
    if (has) {
      const src = fs.readFileSync(appNorm, "utf8");
      ok("T7.2 it treats an absent `state` with read_status ok as a CONTRACT FAILURE",
         /contract/i.test(src) && /state/.test(src),
         "the app would render an absent state as though it were a verdict");
    }
    report("T7",
      "REACHABLE ONLY BY DEPLOYING OUT OF ORDER, and it fails SAFE. The new app asks " +
      "for `state`; an old API does not publish it. The normalizer classifies that as a " +
      "contract failure — logged as a bug on the API side — and renders the proof block " +
      "as unavailable rather than inventing a verdict. The operator sees a gap, not a " +
      "wrong answer.",
      "Deploy the API side of a contract change BEFORE the app side that consumes it " +
      "(#60/#62 precede #38), and the app-first rule applies only to REMOVALS (#39/#40 " +
      "precede #63). Add-then-consume, consume-then-remove. If it happens: redeploy the " +
      "API; no data is affected.");
  }

  /* ═══ T8 · GUARD PRESENT, APPLICATION STALE ══════════════════════ */
  sec("T8 · THE GUARD IS ARMED AND AN OLD INSTANCE IS STILL SERVING");
  {
    /*  The dangerous version of this: an instance predating Step 6, whose
     *  legacy done-path still writes `closed`. It is the exact reason the
     *  runbook requires a DRAINED rollout before the instant is captured. */
    const wo = await mkWo("open");
    let err = null;
    try {
      await c.query("begin");
      await c.query(`update work_orders set status='closed', completion_photo='stub://x',
                       completion_note='did it' where id=$1`, [wo]);
      await c.query("commit");
    } catch (e) { err = e; await c.query("rollback").catch(() => {}); }
    ok("T8.1 a surviving legacy `closed` write is REFUSED by the database",
       !!err && err.code === "R0003", err ? err.code + " " + err.message : "IT COMMITTED");
    ok("T8.2 …and the work order is untouched", await statusOf(wo) === "open");
    const v = Number((await c.query(
      `select count(*) n from release_0_completion_invariant_violations`)).rows[0].n);
    ok("T8.3 …so the invariant audit is still empty", v === 0, String(v));
    report("T8",
      "CONTAINED — the old instance fails, the data does not. A pre-Step-6 instance that " +
      "survives the rollout gets R0003 on its closing UPDATE: `closed` is historical " +
      "vocabulary after the cutover. The operator's request errors; nothing is written; " +
      "no defect obligation is manufactured against anyone. This is the case migration " +
      "140 was built for, and it is why the guard is worth having even though Step 6 " +
      "already closed the path in code.",
      "Complete the rollout so no pre-Step-6 instance is serving. The failed request " +
      "must be re-done through the technician's operations line, which is the canonical " +
      "path. Nothing to repair in the database.");
  }

  /* ═══ T9 · ROLLBACK, WHERE IT IS ACTUALLY ALLOWED ════════════════ */
  sec("T9 · ROLLBACK — where it works, and where the word does not apply");
  {
    let dropErr = null;
    try { await c.query(`drop trigger assert_completion_truth_upd on work_orders`); }
    catch (e) { dropErr = e; }
    ok("T9.1 the guard CAN be dropped by the table owner — measured, not assumed",
       dropErr === null, dropErr ? dropErr.code + " " + dropErr.message : "");
    const wo = await mkWo("open");
    const after = await (async () => {
      try {
        await c.query("begin");
        await c.query(`update work_orders set status='complete' where id=$1`, [wo]);
        await c.query("commit"); return null;
      } catch (e) { await c.query("rollback").catch(() => {}); return e; }
    })();
    ok("T9.2 …and with it gone, a hollow completion COMMITS",
       after === null && await statusOf(wo) === "complete",
       after ? after.code : "");
    const v = (await c.query(
      `select work_order_id, violation from release_0_completion_invariant_violations`)).rows;
    ok("T9.3 …but the invariant AUDIT still names it — the audit is not the guard",
       v.some((r) => r.work_order_id === wo),
       JSON.stringify(v) + " — if dropping the guard also silenced the audit, nothing " +
       "would ever report the bypass");
    await guardWindow.installGuard(c);
    ok("T9.4 re-applying migration 140 restores the guard",
       await guardWindow.guardInstalled(c));

    report("T9",
      "MIGRATION 140 IS REVERSIBLE. THE ACTIVATION IS NOT. Dropping the guard is a " +
      "deliberate, auditable DDL act by the table owner — it works, it was measured, and " +
      "the invariant AUDIT VIEW keeps reporting violations afterwards because it derives " +
      "from a function, not from the triggers. That separation is what makes the escape " +
      "auditable rather than silent.",
      "Rolling BACK 140: drop the five triggers; re-apply the migration to restore. " +
      "Rolling back the ACTIVATION: NOT POSSIBLE — history and inventory are append-only " +
      "by trigger and a second genesis is refused by uq_r0ah_genesis. Everything upstream " +
      "of boundary 8 is revertible; nothing downstream of it is. Any row the audit view " +
      "names while the guard was down must be resolved by hand — record a grounded " +
      "satisfied evaluation, or take it out of the terminal state.");
  }

  // ── the sheet ─────────────────────────────────────────────────────
  sec("THE OPERATING STATES, IN ONE PLACE");
  for (const f of findings) {
    console.log(`\n  ${f.id}  ${f.state.split(".")[0]}.`);
  }

  sec("VERDICT");
  console.log(`  passed ${pass}   failed ${fail}   ·   ${findings.length} transitions characterised`);
  await c.end();
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error("\nERROR:\n" + (e && e.stack || e)); process.exit(1); });
