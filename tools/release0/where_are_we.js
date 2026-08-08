#!/usr/bin/env node
/* ════════════════════════════════════════════════════════════════════
   RELEASE 0 — WHICH BOUNDARY IS PRODUCTION AT?

   The runbook (docs/RELEASE_0_ACTIVATION_RUNBOOK.md) is the plan. This
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
    !(has138 && has139) ? ["138+139", "merge the sweep branch WITH the migration release variables set"] :
    ["§4.2 sweep", "dry run first; --raise only after reading what it would do"];
  console.log(`  ${next[0]} — ${next[1]}`);
  console.log("\n  The runbook has this boundary's preconditions, verification, stop");
  console.log("  conditions and what is reversible: docs/RELEASE_0_ACTIVATION_RUNBOOK.md\n");

  await c.end();
  //  Stop conditions are a FINDING, not a crash. Non-zero so a script
  //  cannot chain past one without noticing.
  process.exit(stops === 0 ? 0 : 1);
})().catch((e) => { console.error("\nERROR: " + (e && e.message)); process.exit(1); });
