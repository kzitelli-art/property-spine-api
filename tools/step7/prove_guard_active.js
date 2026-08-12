#!/usr/bin/env node
/* ════════════════════════════════════════════════════════════════════
   BOUNDARY 8 CLOSEOUT — THE GUARD BITES, IN PRODUCTION

   The cutover is recorded. That is a claim about a row in
   release_0_activation_epoch. This is the claim that matters:

       a work order cannot reach a terminal state without proof,
       and the DATABASE is what refuses it.

   Reading the epoch proves an activation happened. It does not prove the
   guard fires. Only a refused write proves that.

       node tools/step7/prove_guard_active.js

   ── HOW THIS OBSERVES A DEFERRED TRIGGER WITHOUT COMMITTING ─────────

   The guard is a DEFERRED constraint trigger: it fires when the deferred
   queue drains, which is normally at COMMIT. The first draft of this tool
   concluded that a real commit was therefore the only way to see it, and
   that a probe row could simply be deleted afterwards.

   BOTH HALVES OF THAT WERE WRONG, and the second was dangerous:

     · `SET CONSTRAINTS ALL IMMEDIATE` drains that same queue on demand,
       mid-transaction. Same trigger, same function, same epoch, same
       rows — the identical check COMMIT would run, minus the durable
       write. Followed by ROLLBACK it leaves nothing behind at all.

     · The paired control CANNOT be committed and then cleaned up.
       work_order_proof_evaluations and …_evaluation_attachments carry
       `no_delete_*` (forbid_mutation) triggers, and the evaluation's FK
       to work_orders is ON DELETE RESTRICT. A committed grounded
       completion is therefore PERMANENT, and it makes the probe work
       order permanently undeletable too — a fabricated completed job,
       citing fabricated evidence, sitting in a real property's
       maintenance surface forever.

   So every state below is built, judged, and rolled back. The single
   exception is G, which attempts a real COMMIT — safe precisely because
   it creates no evaluation, so nothing blocks its removal.

   ── WHY A MATRIX AND NOT ONE REFUSAL ────────────────────────────────

   A refusal proves nothing alone: a database that refused EVERY
   completion would pass a one-sided test and be catastrophically broken.
   And a database that refused `closed` for the wrong reason would look
   identical to one enforcing proof. So the matrix varies ONE fact at a
   time and pins the ERROR CODE, not merely the fact that something threw.

   C3 and D1 are the sharpest pair: identical builders, identical calls,
   differing by a single UPDATE of one column on one attachment.
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const path = require("path");
const { Client } = require("pg");

//  The canonical helper. Seven harnesses each growing their own "make it
//  satisfied" is the drift this release exists to end, so this does not
//  grow an eighth: preserveQualifyingEvidence and groundedSatisfied read
//  the evidence arrays from src/technician/evidence_service.js and cannot
//  quietly disagree with the service the guard mirrors.
const { preserveQualifyingEvidence, groundedSatisfied } =
  require(path.join(__dirname, "..", "step12", "grounded_evaluation.js"));

const URL = process.env.DATABASE_URL;

let pass = 0, fail = 0;
const ok = (l, c, d) => {
  if (c) { pass++; console.log("  ok    " + l); }
  else { fail++; console.log("  FAIL  " + l + (d ? "\n        " + d : "")); }
  return c;
};
const bar = "═".repeat(70);
const PROBE_SOURCE = "boundary8_probe";

(async function main() {
  if (!URL) {
    console.error("\nREFUSED: DATABASE_URL is not set. Run this ON the instance.\n");
    process.exit(2);
  }

  console.log("\n" + bar);
  console.log("  BOUNDARY 8 CLOSEOUT — does the guard actually refuse?");
  console.log(bar + "\n");

  const c = new Client({ connectionString: URL, ssl: { rejectUnauthorized: false } });
  await c.connect();

  // ══ A · THE ACTIVATION IS RECORDED ════════════════════════════════
  console.log("  ── A · the epoch ─────────────────────────────────────────────────");
  const epoch = (await c.query(
    `select activation_id, activated_at from release_0_activation_epoch`)).rows[0];
  const history = Number((await c.query(
    `select count(*) n from release_0_activation_history`)).rows[0].n);

  const armed = ok("A1  the epoch names an activation — the guard is armed",
    !!(epoch && epoch.activation_id), JSON.stringify(epoch));
  ok("A2  activation history has exactly one row", history === 1, "history=" + history);
  if (epoch) {
    console.log("        activation   " + epoch.activation_id);
    console.log("        activated_at " + (epoch.activated_at && epoch.activated_at.toISOString
      ? epoch.activated_at.toISOString() : epoch.activated_at));
  }

  //  Everything below judges POST-cutover behaviour. With a null epoch the
  //  guard returns immediately BY DESIGN, so every variant would be
  //  "permitted" and the matrix would read as catastrophic failure while
  //  actually measuring a system that was never turned on.
  if (!armed) {
    console.error("\n  ⛔ The epoch carries no activation. The guard is inert by design,");
    console.error("     so the refusal matrix below could not mean anything. NOT RUN.\n");
    await c.end();
    process.exit(2);
  }

  // ══ B · THE TRIGGERS ARE PRESENT, DEFERRED AND ENABLED ════════════
  //  This guards the MECHANISM. A disabled trigger is not fired by
  //  SET CONSTRAINTS either — so without this, "permitted" in the control
  //  and "permitted" in a disarmed database are indistinguishable.
  console.log("\n  ── B · the triggers themselves ───────────────────────────────────");
  const trg = (await c.query(
    `select t.tgname, t.tgenabled, t.tgdeferrable, t.tginitdeferred
       from pg_trigger t
      where t.tgname like 'assert_completion_truth%' and not t.tgisinternal
      order by t.tgname`)).rows;
  const EXPECT = [
    "assert_completion_truth_attach",
    "assert_completion_truth_eval",
    "assert_completion_truth_ins",
    "assert_completion_truth_upd",
  ];
  ok("B1  all four completion-truth triggers exist",
    EXPECT.every((n) => trg.some((r) => r.tgname === n)),
    "found: " + trg.map((r) => r.tgname).join(", "));
  ok("B2  every one is ENABLED (a disabled trigger fires for nobody)",
    trg.length > 0 && trg.every((r) => r.tgenabled === "O"),
    trg.map((r) => r.tgname + "=" + r.tgenabled).join(", "));
  ok("B3  every one is DEFERRABLE INITIALLY DEFERRED",
    trg.length > 0 && trg.every((r) => r.tgdeferrable && r.tginitdeferred),
    trg.map((r) => r.tgname + " " + r.tgdeferrable + "/" + r.tginitdeferred).join(", "));

  // ── the scaffolding a probe needs ─────────────────────────────────
  //  The busiest property is the most representative. The fallback is not
  //  cosmetic: a database with zero work orders is exactly where the guard
  //  has never been exercised, so refusing to run there would withhold the
  //  proof from the only case that has no other evidence.
  const prop = (await c.query(
    `select property_id from work_orders group by 1 order by count(*) desc limit 1`)).rows[0]
    || (await c.query(`select id as property_id from properties limit 1`)).rows[0];
  const user = (await c.query(`select id from users limit 1`)).rows[0];
  if (!prop || !user) {
    console.error("\n  ⛔ no property, or no users — cannot build a probe.\n");
    await c.end();
    process.exit(2);
  }
  const P = prop.property_id, U = user.id;

  //  Captured BEFORE anything is built, so Z2 compares against what this
  //  database actually held rather than against a remembered production
  //  constant. A hardcoded expectation is how a harness ends up failing
  //  the fix instead of the defect.
  const invBefore = Number((await c.query(
    `select count(*) n from release_0_legacy_cutover_inventory`)).rows[0].n);

  /*  Build a state, force the deferred queue to drain, roll back.
   *
   *  Returns { threw, code, message }. NOTHING survives this call: the
   *  rollback is in a finally, and the probe work order is created inside
   *  the same transaction as the state under test.                      */
  async function variant(label, build) {
    let out = { threw: false, code: null, message: null };
    try {
      await c.query("begin");
      const wo = (await c.query(
        `insert into work_orders (property_id, title, status, source)
         values ($1, $2, 'open', $3) returning id`,
        [P, "BOUNDARY 8 PROBE — " + label, PROBE_SOURCE])).rows[0].id;
      await build(wo);
      //  THE MOMENT OF JUDGEMENT. Drains the same deferred queue COMMIT
      //  would drain — here, where we can still refuse the outcome.
      await c.query("set constraints all immediate");
    } catch (e) {
      out = { threw: true, code: e.code || null, message: String(e.message || e).split("\n")[0] };
    } finally {
      await c.query("rollback").catch(() => {});
    }
    return out;
  }

  const terminal = (wo, status) =>
    c.query(`update work_orders set status = $2 where id = $1`, [wo, status]);

  // ══ C · THE REFUSAL MATRIX ════════════════════════════════════════
  console.log("\n  ── C · what the guard refuses, and for which reason ──────────────");

  //  C1/C2 — the core case: terminal with no proof evaluation at all.
  const noProof = await variant("no proof", (wo) => terminal(wo, "complete"));
  ok("C1  `complete` with NO proof evaluation is REFUSED",
    noProof.threw, "IT WAS PERMITTED. Release 0's invariant is not being enforced.");
  ok("C2  …and refused as R0001 — for the proof, not for something else",
    noProof.code === "R0001", "errcode was " + noProof.code + ": " + noProof.message);
  if (noProof.message) console.log("        " + noProof.message.slice(0, 150));

  //  C3 — the trust root. A `satisfied` head whose cited evidence does not
  //  qualify. Built by the SAME calls as D1, then one column changed.
  const ungrounded = await variant("ungrounded", async (wo) => {
    const a = await preserveQualifyingEvidence(c,
      { work_order_id: wo, property_id: P, uploaded_by_user_id: U });
    //  ← THE ONE DIFFERENCE FROM D1. `unclassified` is deliberately absent
    //    from release_0_evidence_qualifies(): an unclassified photo is not
    //    proof of a repair. Everything else about this row is unchanged.
    await c.query(
      `update work_order_proof_attachments set proof_classification = 'unclassified'
        where id = $1`, [a]);
    await groundedSatisfied(c,
      { work_order_id: wo, property_id: P, uploaded_by_user_id: U, attachment_ids: [a] });
    await terminal(wo, "complete");
  });
  ok("C3  `satisfied` citing NON-qualifying evidence is REFUSED as R0004",
    ungrounded.threw && ungrounded.code === "R0004",
    "threw=" + ungrounded.threw + " code=" + ungrounded.code + " " + (ungrounded.message || ""));

  //  C4 — evaluated and FAILED. Valid data; not a completion. The helper
  //  only builds `satisfied` heads, correctly — this is the state it exists
  //  to avoid, so it is written here and named.
  const notSat = await variant("not_satisfied", async (wo) => {
    const a = await preserveQualifyingEvidence(c,
      { work_order_id: wo, property_id: P, uploaded_by_user_id: U });
    const ev = (await c.query(
      `insert into work_order_proof_evaluations
         (work_order_id, property_id, state, evaluated_by_user_id,
          evaluated_by_service, rule_version)
       values ($1,$2,'not_satisfied',$3,'tools/step7/prove_guard_active.js','boundary8')
       returning id`, [wo, P, U])).rows[0].id;
    await c.query(
      `insert into work_order_proof_evaluation_attachments
         (evaluation_id, attachment_id, work_order_id, property_id) values ($1,$2,$3,$4)`,
      [ev, a, wo, P]);
    await terminal(wo, "complete");
  });
  ok("C4  a `not_satisfied` evaluation cannot justify `complete` — R0001",
    notSat.threw && notSat.code === "R0001",
    "threw=" + notSat.threw + " code=" + notSat.code + " " + (notSat.message || ""));

  //  C5 — `closed` is retired vocabulary, refused EVEN when fully proven.
  //  Without pinning R0003 here, a guard that refused `closed` for any
  //  reason at all would be indistinguishable from one enforcing proof.
  const closed = await variant("closed", async (wo) => {
    await groundedSatisfied(c, { work_order_id: wo, property_id: P, uploaded_by_user_id: U });
    await terminal(wo, "closed");
  });
  ok("C5  `closed` is refused as R0003 even WITH grounded proof",
    closed.threw && closed.code === "R0003",
    "threw=" + closed.threw + " code=" + closed.code + " " + (closed.message || ""));

  // ══ D · THE PAIRED CONTROL ════════════════════════════════════════
  //  If this is refused, the guard is not enforcing an invariant — it is
  //  blocking the product.
  console.log("\n  ── D · what the guard must PERMIT ────────────────────────────────");
  const grounded = await variant("grounded", async (wo) => {
    const a = await preserveQualifyingEvidence(c,
      { work_order_id: wo, property_id: P, uploaded_by_user_id: U });
    await groundedSatisfied(c,
      { work_order_id: wo, property_id: P, uploaded_by_user_id: U, attachment_ids: [a] });
    await terminal(wo, "complete");
  });
  ok("D1  `complete` on a grounded `satisfied` evaluation is PERMITTED",
    !grounded.threw,
    "the guard refused a legitimate completion: " + grounded.code + " " + (grounded.message || ""));
  console.log("        D1 and C3 run the same builders with the same arguments.");
  console.log("        C3 adds one statement: proof_classification → 'unclassified'.");
  console.log("        That single column moved the verdict, so the guard is reading");
  console.log("        the evidence — not the shape of the transaction.");

  // ══ G · AND THE COMMIT ITSELF ═════════════════════════════════════
  //  Safe to attempt for real: this transaction creates no evaluation, so
  //  if the guard were broken the probe is still deletable. Every variant
  //  above would have been permanent.
  console.log("\n  ── G · the real COMMIT, end to end ───────────────────────────────");
  let committedId = null, commitErr = null;
  try {
    await c.query("begin");
    const wo = (await c.query(
      `insert into work_orders (property_id, title, status, source)
       values ($1,$2,'open',$3) returning id`,
      [P, "BOUNDARY 8 PROBE — real commit", PROBE_SOURCE])).rows[0].id;
    await c.query(`update work_orders set status = 'complete' where id = $1`, [wo]);
    await c.query("commit");
    committedId = wo;                       // the guard did NOT fire at commit
  } catch (e) {
    commitErr = e;
    await c.query("rollback").catch(() => {});
  }
  ok("G1  COMMIT of an unproven completion is refused by the database",
    !committedId && !!commitErr,
    "THE COMMIT SUCCEEDED. The deferred queue is not being drained at commit.");
  ok("G2  …with the same R0001 the in-transaction check gave",
    !!commitErr && commitErr.code === "R0001",
    "errcode was " + (commitErr && commitErr.code));
  if (committedId) {
    await c.query(`delete from work_orders where id = $1`, [committedId]).catch(() => {});
    console.log("        (the wrongly-committed probe was deleted)");
  }

  // ══ Z · NOTHING SURVIVED ══════════════════════════════════════════
  console.log("\n  ── Z · residue ───────────────────────────────────────────────────");
  const left = Number((await c.query(
    `select count(*) n from work_orders where source = $1`, [PROBE_SOURCE])).rows[0].n);
  ok("Z1  no probe work order remains in production", left === 0,
    left + " remain. Remove: delete from work_orders where source = '" + PROBE_SOURCE + "';");

  const inv = Number((await c.query(
    `select count(*) n from release_0_legacy_cutover_inventory`)).rows[0].n);
  ok("Z2  the frozen legacy inventory is unchanged (" + invBefore + " rows)",
    inv === invBefore, "inventory moved from " + invBefore + " to " + inv);

  const viol = Number((await c.query(
    `select count(*) n from release_0_completion_invariant_violations`)).rows[0].n);
  ok("Z3  zero post-cutover completion-invariant violations", viol === 0,
    viol + " violation(s) — read release_0_completion_invariant_violations.");

  await c.end();

  console.log("\n" + bar);
  console.log(`  ${fail === 0 ? "✓ PASS" : "✗ FAIL"} — ${pass} passed, ${fail} failed`);
  if (fail === 0) {
    console.log("");
    console.log("  The guard refuses an unproven completion — and refuses it for the");
    console.log("  stated reason — while permitting a grounded one. Both halves.");
    console.log("  Release 0's completion invariant is enforced by the database.");
  }
  console.log(bar + "\n");
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error("\n  ⛔ " + ((e && e.message) || e));
  console.error("\n  If any probe row remains: " +
    "delete from work_orders where source = 'boundary8_probe';\n");
  process.exit(2);
});
