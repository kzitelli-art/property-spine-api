#!/usr/bin/env node
/* ════════════════════════════════════════════════════════════════════
   RELEASE 0 — WHICH BOUNDARY IS PRODUCTION AT?

   The runbook (docs/archive/RELEASE_0_ACTIVATION_RUNBOOK.md) is the plan. This
   is the instrument: it READS production and says which boundaries have
   actually landed, which one is next, and what that one requires.

   ── WHY AN INSTRUMENT AND NOT JUST A CHECKLIST ──────────────────────

   A checklist records what somebody believes. This release has already
   paid for that twice: a PR reported as merged whose later commits never
   landed, and a deploy whose running SHA was not the one the release
   assumed. Every line below is derived from the database or from the
   checkout this is running in — never from a note.

   ── IT DECIDES NOTHING AND CHANGES NOTHING ──────────────────────────

   Proven read-only before it reads. It does not deploy, migrate,
   activate or sweep. It answers one question and stops.

   ── WHAT IS NEVER PRINTED ───────────────────────────────────────────
   phone numbers · media URLs · credentials · secret VALUES. Secret
   presence is computed in JS as a boolean, never a shell expansion.

   usage (Render shell):  node tools/release0/where_are_we.js
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const fs = require("fs");
const path = require("path");
const { Client } = require("pg");
const { beginProvenReadOnly, refuseNotReadOnly } = require("../step4/_ro.js");

const ROOT = path.join(__dirname, "..", "..");
const sec = (t) => console.log(`\n${"═".repeat(68)}\n  ${t}\n${"═".repeat(68)}`);
const row = (state, name, detail) =>
  console.log(`  ${state.padEnd(9)} ${name.padEnd(38)} ${detail || ""}`);

//  Source facts. `landed` is a property of THIS CHECKOUT — the code that
//  is actually running — not of a PR's merge status.
const srcHas = (file, needle) => {
  try { return fs.readFileSync(path.join(ROOT, file), "utf8").includes(needle); }
  catch (_) { return false; }
};

(async function main() {
  if (!process.env.DATABASE_URL) { console.error("REFUSED: DATABASE_URL is not set."); process.exit(1); }
  const c = new Client({ connectionString: process.env.DATABASE_URL,
                         ssl: { rejectUnauthorized: false } });
  await c.connect();
  const ro = await beginProvenReadOnly(c, "release0_where");
  if (!ro.ok) process.exit(await refuseNotReadOnly(c, ro.reason));

  const q = async (sql, vals) => (await c.query(sql, vals)).rows;
  const ledger = (await q(`select max(version) v from schema_migrations`))[0].v;
  const tbl = async (n) => (await q(
    `select 1 from information_schema.tables where table_schema='public' and table_name=$1`, [n])).length > 0;

  // ── the observable state ──────────────────────────────────────────
  const has137 = await tbl("work_order_proof_evaluations");
  const has138 = (await q(`select 1 from pg_indexes where schemaname='public'
                            and indexname='uq_obl_proof_eval_missing_open'`)).length > 0;
  const has139 = (await q(`select pg_get_constraintdef(oid) d from pg_constraint
                            where conname='ck_oblig_resolution_code'`))
                   .some((r) => /no_longer_applicable/.test(r.d));
  const activation = has137
    ? ((await q(`select id, activated_at from release_0_activation_current`))[0] || null) : null;
  //  The guard is a TRIGGER, and a trigger can be dropped by anyone holding
  //  the privilege — deliberately, since the alternative is a control nobody
  //  can remove when it is wrong. That makes it auditable rather than
  //  absolute, so its presence has to be READ, never assumed.
  /*  PRESENT is not the same as WORKING. Each of these looks correct in a
   *  trigger listing and protects nothing:
   *    · DISABLED    (tgenabled='D') — exists, never fires
   *    · IMMEDIATE   — judges each statement, not the committed state
   *    · a permissive FUNCTION BODY behind the right name
   *    · the EPOCH gone, so the boundary is answerable from a stale snapshot
   *  So the instrument reads all four, the same way the activation does. */
  const trg = await q(
    `select t.tgname, t.tgenabled, t.tgdeferrable, t.tginitdeferred
       from pg_trigger t join pg_class c on c.oid = t.tgrelid
      where not t.tgisinternal
        and t.tgname in ('assert_completion_truth_ins','assert_completion_truth_upd',
                         'assert_completion_truth_eval','assert_completion_truth_attach')`);
  /*  ALL overloads, not the first row. A second function with the same
   *  name and a different signature does not replace the first — it sits
   *  beside it, and reading `[0]` could report the safe one while a
   *  trigger calls the permissive one. Every definition carrying this
   *  name must enforce the invariant. */
  const bodies = await q(
    `select p.prosrc from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname='public' and p.proname='release_0_assert_completion_truth'`);
  const epochRows = (await q(
    `select count(*)::int n from public.release_0_activation_epoch`).catch(() => []));
  const stamper = (await q(
    `select 1 from pg_trigger t join pg_class c on c.oid = t.tgrelid
      where not t.tgisinternal and t.tgname='stamp_activation_epoch'
        and t.tgenabled <> 'D'`));

  const guardFaults = [];
  if (trg.length !== 4) guardFaults.push(`${trg.length}/4 triggers present`);
  if (trg.some((t) => t.tgenabled === "D")) guardFaults.push("a trigger is DISABLED");
  if (trg.some((t) => !t.tgdeferrable || !t.tginitdeferred))
    guardFaults.push("a trigger is not DEFERRABLE INITIALLY DEFERRED");
  if (!bodies.length) guardFaults.push("the predicate function is missing");
  else {
    if (bodies.length > 1) {
      guardFaults.push(`${bodies.length} functions named release_0_assert_completion_truth — ` +
        "an overload does not replace the original, and a trigger may call either");
    }
    for (const b of bodies) {
      for (const cl of ["release_0_activation_epoch", "for share", "status_at_cutover",
                        "'satisfied'", "R0002", "R0003", "R0004"]) {
        if (!b.prosrc.includes(cl)) guardFaults.push(`a predicate does not enforce ${cl}`);
      }
    }
  }
  if (!epochRows.length || epochRows[0].n !== 1)
    guardFaults.push("the activation epoch row is missing — a stale snapshot has nothing to fail on");
  if (!stamper.length) guardFaults.push("nothing stamps the epoch on activation");
  const guard = guardFaults.length === 0;
  const inventory = has137
    ? Number((await q(`select count(*) n from release_0_legacy_cutover_inventory`))[0].n) : 0;
  const evaluations = has137
    ? Number((await q(`select count(*) n from work_order_proof_evaluations`))[0].n) : 0;
  const defects = has138
    ? Number((await q(`select count(*) n from obligations where type='proof_evaluation_missing'`))[0].n) : 0;

  //  Source-side facts about the RUNNING checkout.
  const writerLive = srcHas("src/technician/lifecycle_service.js", "recordEvaluation");
  const legacyClosed = srcHas("src/maintenance/maintenance.js", "legacy_completion_retired");
  const readerFourState = srcHas("src/surfaces/work_order_status_read.js", "deriveProofState");
  const nextActionFixed = srcHas("src/surfaces/work_order_status_read.js",
                                 "Proof state unavailable — retry");
  const sweepPresent = fs.existsSync(path.join(ROOT, "src/maintenance/proof_defect_sweep.js"));
  const transport = !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN);

  console.log("\nRELEASE 0 — WHERE IS PRODUCTION?");
  console.log("  ledger " + ledger + "   ·   read-only, proven before any read");

  sec("LANDED / NOT LANDED  (derived, never from a note)");
  const B = [
    { k: "b2", n: "Step 2 · migration 137", done: has137,
      d: has137 ? "proof chain present" : "APPLY IT FIRST — nothing else can run" },
    { k: "b3", n: "Step 3 · canonical writer", done: writerLive,
      d: writerLive ? "claimCompletion records an evaluation" : "the running source has no writer" },
    { k: "tx", n: "Transport · Twilio configured", done: transport,
      d: transport ? "credentials present" : "BLOCKER — the webhook refuses at the door" },
    { k: "b4", n: "Step 4 · handset completion proven", done: evaluations > 0,
      d: evaluations > 0 ? `${evaluations} evaluation(s) exist` : "no evaluation has ever been written" },
    { k: "b5", n: "Step 5 · app completion control removed", done: null,
      d: "APP-SIDE — browser-verify; this tool cannot see the app" },
    { k: "b6", n: "Step 6 · legacy done-path fails closed", done: legacyClosed,
      d: legacyClosed ? "the route refuses done=true" : "the legacy writer can still close work" },
    { k: "b7", n: "Step 7 · activation + inventory", done: !!activation,
      d: activation ? `activated ${activation.activated_at.toISOString()} · ${inventory} legacy row(s)`
                    : "no activation — the reader must report unavailable" },
    { k: "b8", n: "Step 8 · four-state reader", done: readerFourState,
      d: readerFourState ? (nextActionFixed ? "four-state, next_action fixed"
                                            : "⚠ four-state WITHOUT the next_action fix")
                         : "the old boolean reader is running" },
    { k: "gd", n: "migration 140 · completion guard", done: guard,
      d: guard ? (activation ? "installed and ARMED" : "installed, inert until activation")
        //  "not installed" would be a lie for a trigger that exists and is
        //  disabled, which is the more dangerous case: it reads as present.
        : guardFaults.length && !guardFaults[0].startsWith("0/4")
          ? "PRESENT BUT NOT PROTECTING — " + guardFaults.join(" · ")
          : "NOT INSTALLED — a work order can commit terminal with no satisfied proof" },
    { k: "b9", n: "migrations 138 + 139", done: has138 && has139,
      d: `138 ${has138 ? "applied" : "absent"} · 139 ${has139 ? "applied" : "absent"}` },
    { k: "b10", n: "§4.2 defect sweep available", done: sweepPresent,
      d: sweepPresent ? `${defects} defect obligation(s) exist` : "not in this checkout" },
  ];
  for (const b of B) {
    row(b.done === null ? "  ?" : b.done ? "  LANDED" : "  --", b.n, b.d);
  }

  // ── the ordering rules that actually bite ─────────────────────────
  sec("STOP CONDITIONS — checked, not recited");
  let stops = 0;
  const stop = (cond, what, why) => {
    if (cond) { stops++; console.log("  ⛔ " + what + "\n       " + why); }
  };

  stop(readerFourState && !activation,
    "THE FOUR-STATE READER IS LIVE WITH NO ACTIVATION",
    "§5.1: the reader deploys ONLY after activation and inventory exist. Every " +
    "terminal work order now reads `unavailable`, and the release cannot tell " +
    "legacy history from a writer defect.");

  stop(readerFourState && !nextActionFixed,
    "THE READER IS LIVE WITHOUT THE next_action FIX",
    "On a failed proof read, next_action answers 'Obtain repair photo before " +
    "completion' — the surface says it cannot determine the proof condition and " +
    "tells the operator to go do fieldwork about it. Ship the HTTP-acceptance fix.");

  stop(!!activation && !legacyClosed,
    "AN ACTIVATION EXISTS WHILE THE LEGACY DONE-PATH IS STILL OPEN",
    "§5.4: the instant may only be captured once the legacy writer can no longer " +
    "create `closed` rows. Any row it writes now is terminal, uninventoried, and " +
    "becomes a defect the system caused itself.");

  stop(has138 && !has139,
    "138 IS APPLIED AND 139 IS NOT",
    "The defect obligation can be raised but cannot close as 'no_longer_applicable'. " +
    "They are one boundary; apply both.");

  stop(guard === false && guardFaults.length > 0 && !!activation,
    "THE GUARD IS PRESENT IN NAME ONLY",
    "Each of these looks correct in a trigger listing and protects nothing: " +
    guardFaults.join(" · ") + ". Re-apply migration 140 and confirm before " +
    "trusting any completion written since.");

  stop(!!activation && !guard,
    "THE CUTOVER IS ACTIVE AND THE COMPLETION GUARD IS NOT INSTALLED",
    "Any of the 67 write-capable unguarded scripts, or a psql session, can now " +
    "make a work order terminal with no evaluation. Every such row becomes a " +
    "missing_evaluation_defect — an obligation against a named role for something " +
    "the system did. Apply migration 140.");

  /*  THE AUDIT, FROM THE DATABASE'S OWN DEFINITION. Not a fourth
   *  handwritten interpretation of the invariant — the same
   *  release_0_completion_proof_status the deferred guard and the
   *  activation call. If this instrument disagreed with the guard about
   *  what a violation is, the disagreement would be invisible. */
  const violations = await q(
    `select work_order_id, status, proof_status, violation
       from public.release_0_completion_invariant_violations limit 50`).catch(() => null);

  stop(Array.isArray(violations) && violations.length > 0,
    "COMMITTED WORK ORDERS VIOLATE THE COMPLETION INVARIANT",
    `${violations && violations.length} post-cutover work order(s) are terminal in a state ` +
    "the database's own completion invariant refuses: " +
    (violations || []).slice(0, 5).map((v) => `${v.work_order_id} ${v.violation}`).join(" · ") +
    ". This population should be EMPTY. A row means the guard was dropped, deployed " +
    "late, or bypassed by privileged DDL. INVESTIGATE before completing anything else.");

  stop(guard && defects > 0,
    "THE GUARD IS INSTALLED AND DEFECT OBLIGATIONS EXIST",
    "With the guard armed, ordinary DML cannot add to this population: the census " +
    "inventoried every pre-cutover terminal row, and the guard refuses the rest. " +
    "That is a claim about the GUARD, not a fact about the data — a non-empty " +
    "result means it was dropped, deployed late, or bypassed by DDL. " +
    "INVESTIGATE — do not just resolve them.");

  stop(defects > 0 && !activation,
    "DEFECT OBLIGATIONS EXIST WITH NO ACTIVATION",
    "Without an inventory nothing separates legacy history from a real defect. " +
    "These may be accusations against work nobody got wrong.");

  stop(evaluations === 0 && !!activation,
    "ACTIVATED BEFORE ANY COMPLETION WAS EVER PROVEN",
    "§7.4 is the load-bearing gate and Step 4 gates Step 5. Activating first " +
    "inventories a legacy set nobody has proven the writer can add to.");

  if (stops === 0) console.log("  none. The observable state is internally consistent.");

  // ── what is next ──────────────────────────────────────────────────
  sec("NEXT BOUNDARY");
  const next =
    !has137 ? ["Step 2", "apply migration 137 as a deliberate migration release"] :
    !writerLive ? ["Step 3", "deploy the canonical writer, then VERIFY the running source"] :
    !transport ? ["Transport", "configure Twilio. Everything downstream waits here."] :
    evaluations === 0 ? ["Step 4", "run tools/step4/preflight.js, send one MMS, then prove_completion.js"] :
    !legacyClosed ? ["Step 6", "deploy the legacy-done-path refusal, then CAPTURE THE ACTIVATION INSTANT"] :
    !activation ? ["Step 7", "fresh authorized census, then the activation transaction — RUN ONCE"] :
    !readerFourState ? ["Step 8", "deploy the four-state reader WITH the next_action fix"] :
    !guard ? ["140", "apply the completion guard — it is inert until activation, so it is safe NOW and must not wait until after Step 7"] :
    !(has138 && has139) ? ["138+139", "merge the sweep branch WITH the migration release variables set"] :
    ["§4.2 sweep", "dry run first; --raise only after reading what it would do"];
  console.log(`  ${next[0]} — ${next[1]}`);
  console.log("\n  The runbook has this boundary's preconditions, verification, stop");
  console.log("  conditions and what is reversible: docs/archive/RELEASE_0_ACTIVATION_RUNBOOK.md\n");

  await c.end();
  //  Stop conditions are a FINDING, not a crash. Non-zero so a script
  //  cannot chain past one without noticing.
  process.exit(stops === 0 ? 0 : 1);
})().catch((e) => { console.error("\nERROR: " + (e && e.message)); process.exit(1); });
