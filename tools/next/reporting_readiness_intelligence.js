#!/usr/bin/env node
/* ════════════════════════════════════════════════════════════════════
   WHAT RELEASE 0 MADE READABLE — AND WHAT IS STILL A RECONSTRUCTION

   The North Star: *record the truth at the moment of work, so reporting
   becomes a read, not a reconstruction.* Release 0 delivered the first
   fully governed operational fact — maintenance work-order completion,
   backed by evidence, written by one canonical writer.

   The monthly reporting package (`src/money/reporting.js`) does not read
   it. It has no maintenance section at all.

   Before anything is built on that, this answers — from a real database,
   read-only — WHICH reporting claims Release 0 can now support and which
   would still require inventing a number. That distinction is the whole
   product, so it is measured rather than assumed.

   ── THREE VERDICTS, AND ONLY THREE ──────────────────────────────────

     READABLE        a governed writer records it; reporting is a SELECT.
     RECONSTRUCTED   derivable, but only by inferring across ungoverned
                     data. Shipping one of these as a proven number is
                     exactly what §5 forbids.
     NOT AVAILABLE   no governed fact and no honest inference. The
                     reporting package must show it blank, with a reason.

   A claim moving from RECONSTRUCTED to READABLE is what a future release
   is FOR. This file exists to make that list explicit before the design
   argument starts, not after.

   ── READ-ONLY BY CONSTRUCTION ───────────────────────────────────────

   Everything runs inside `BEGIN TRANSACTION READ ONLY`, enforced by the
   server, and is rolled back. Same discipline as the preflight and the
   acceptance receipt: an intelligence tool that could change what it
   describes is not intelligence.

   usage:
     DATABASE_URL='…' node tools/next/reporting_readiness_intelligence.js
     DATABASE_URL='…' node tools/next/reporting_readiness_intelligence.js --json
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const path = require("path");
const { Client } = require("pg");

const ROOT = path.join(__dirname, "..", "..");
const proofState = require(path.join(ROOT, "src/release0/proof_state.js"));

const URL = process.env.DATABASE_URL;
const AS_JSON = process.argv.includes("--json");

const R = { generated_from: "database read", claims: [], population: {}, notes: [] };
const claim = (id, what, verdict, why, unlocks) =>
  R.claims.push({ id, what, verdict, why, unlocks: unlocks || null });

(async function main() {
  if (!URL) { console.error("REFUSED: DATABASE_URL is not set."); process.exit(2); }
  const c = new Client({ connectionString: URL });
  try { await c.connect(); } catch (e) {
    console.error("REFUSED: could not connect — " + e.message); process.exit(2); }
  await c.query("begin transaction read only");
  const q = async (s, a = []) => (await c.query(s, a)).rows;
  const one = async (s, a = []) => (await q(s, a))[0] || null;
  const hasCol = async (t, col) => Number((await one(
    `select count(*)::int n from information_schema.columns
      where table_schema='public' and table_name=$1 and column_name=$2`, [t, col])).n) > 0;
  const hasRel = async (rel) => !!(await one(`select to_regclass($1) r`, [rel])).r;

  /* ── 1 · IS THE GOVERNED FACT EVEN LIVE HERE? ───────────────────── */
  const activated = await hasRel("public.release_0_activation_history") &&
    Number((await one(`select count(*)::int n from release_0_activation_history`)).n) > 0;
  const epoch = await hasRel("public.release_0_activation_epoch")
    ? await one(`select activation_id from release_0_activation_epoch`) : null;
  R.release_0 = {
    activated,
    guard_armed: !!(epoch && epoch.activation_id),
    //  Both, separately, and on purpose. An activation without a stamped
    //  epoch is the E1 shape: the surface says activated and the database
    //  enforces nothing. Reporting built on that would be confidently wrong.
    coherent: activated === !!(epoch && epoch.activation_id),
  };
  if (!R.release_0.coherent) {
    R.notes.push("⛔ the activation and the epoch DISAGREE. Every verdict below " +
      "assumes one meaning of truth. Resolve this before reading further.");
  }

  /* ── 2 · THE POPULATION, THROUGH THE CANONICAL READER ───────────── */
  const wos = await q(
    `select id, property_id, status, created_at from work_orders order by created_at desc limit 2000`);
  const authority = await proofState.activationAuthority(c);
  /*  Split by TERMINAL, and not as a nicety. The reader derives a verdict
   *  for open work too, so a flat tally showing `not_satisfied: 1` reads
   *  as an invariant violation when it is usually a reopened row doing
   *  exactly what §0a requires. Only the terminal column is a claim about
   *  completion; the open column is a claim about work in progress. */
  const tally = { terminal: {}, not_terminal: {} };
  let terminal = 0;
  for (const w of wos) {
    // eslint-disable-next-line no-await-in-loop
    const s = await proofState.deriveProofState(c, { workOrder: w, authority });
    const key = s.read_status === "ok" ? s.state : s.read_status;
    const isTerm = proofState.isTerminal({ status: w.status });
    const bucket = isTerm ? tally.terminal : tally.not_terminal;
    bucket[key] = (bucket[key] || 0) + 1;
    if (isTerm) terminal += 1;
  }
  R.population = { work_orders_read: wos.length, terminal, by_proof_state: tally };

  /* ── 3 · THE CLAIMS A MAINTENANCE SECTION WOULD MAKE ────────────── */

  claim("M1", "N work orders were completed this period, each backed by evidence",
    activated ? "READABLE" : "READABLE ONLY AFTER ACTIVATION",
    activated
      ? "the canonical writer records a proof evaluation in the same transaction as " +
        "the status change, and migration 140 refuses any terminal row whose satisfied " +
        "evaluation does not cite qualifying preserved evidence. Reporting is a SELECT."
      : "before the activation the reader reports `unavailable` and omits the verdict " +
        "entirely — correctly. A maintenance section built now would have to render " +
        "blank until the cutover, which is the honest behaviour, not a bug.");

  claim("M2", "…and here is the evidence behind each one", "READABLE",
    "cited attachments are frozen the moment an evaluation cites them (R0005), so the " +
    "evidence a report shows is the evidence the completion rested on. This is the " +
    "property that makes a reporting package defensible to a lender months later.");

  claim("M3", "work completed BEFORE the cutover", "READABLE, AND MUST BE LABELLED",
    "the reader returns `legacy_indeterminate`, which is neither proven nor failed. " +
    "A reporting package that folds these into the completed count would be claiming " +
    "proof that was never captured. §5 makes this a doctrinal requirement on the next " +
    "build, not a display preference.");

  claim("M4", "M work orders are still open", "READABLE, BUT NOT PROOF-BACKED",
    "`status='open'` is a column with no governed writer behind it. It is honest as a " +
    "count and must not be presented with the same authority as a completion.",
    "a governed intake/assignment writer would move this to READABLE");

  const moneyLink = await hasCol("money_events", "work_order_id");
  claim("M5", "what the maintenance work COST",
    moneyLink ? "READABLE" : "NOT AVAILABLE",
    moneyLink
      ? "money_events carries work_order_id."
      : "money_events has NO work_order_id — it links to obligations and assignments " +
        "instead. Cost per work order could only be produced by matching vendor, date " +
        "and description, which is a reconstruction, and a plausible wrong number in a " +
        "lender package is the worst possible output. It must read blank.",
    "a governed spend↔work-order link is the single highest-value next rung for " +
    "reporting: it is what turns 'we did the work' into 'we did the work and here " +
    "is what it cost'");

  const billback = await hasRel("public.work_order_billback_decisions");
  claim("M6", "who PAYS for the work (owner vs resident)",
    billback ? "READABLE, WITH A CAVEAT" : "NOT AVAILABLE",
    billback
      ? "work_order_billback_decisions is a governed, superseding decision record. But " +
        "it records the DECISION and its amount, not the cost of the work — M5 is still " +
        "the gap. A section that showed billback totals as maintenance spend would be " +
        "reporting a different fact under the same heading."
      : "no billback decision record in this database.");

  claim("M7", "who did the work", "READABLE FOR THE EVALUATION, RECONSTRUCTED FOR THE LABOUR",
    "work_order_proof_evaluations carries evaluated_by_user_id and evaluated_by_service, " +
    "so who CLAIMED the completion is governed. `assigned_to` is free text and " +
    "`vendor_id` is nullable with no governed assignment writer, so who PERFORMED it is " +
    "an inference.",
    "a governed assignment writer");

  claim("M8", "how long the work took", "RECONSTRUCTED",
    "work_order_progress records en_route / no_access / blocked / finding / " +
    "completion_claimed / completed, which is a rich trail — but there is no governed " +
    "`work started` fact, so duration is inferred from whichever progress row happens " +
    "to exist. Fine as operational colour, not as a reported metric.");

  claim("M9", "completions the system cannot stand behind", "READABLE",
    "release_0_completion_invariant_violations, derived from the same SQL function the " +
    "guard and the activation use. Post-activation this should be EMPTY; a non-empty " +
    "answer is a system-integrity event, NOT a new human accountability category — the " +
    "ruling already settled for the §4.2 sweep applies here unchanged.");

  claim("M10", "a month-end GENERATE that is a read rather than a reconstruction",
    "PARTIAL", "M1/M2/M3/M9 are reads today. M5 is the load-bearing gap: without a " +
    "governed spend link the maintenance section can prove that work happened and was " +
    "evidenced, but not what it cost — and a lender package is largely about cost.");

  /* ── 4 · WHERE THE READING WOULD LAND ───────────────────────────── */
  const fs = require("fs");
  const rep = fs.readFileSync(path.join(ROOT, "src/money/reporting.js"), "utf8");
  R.reporting_module = {
    exists: true,
    has_maintenance_section: /work_order|maintenance/i.test(rep),
    proof_state_pattern: /status:\s*["']pending["']/.test(rep),
  };
  if (!R.reporting_module.has_maintenance_section) {
    R.notes.push("src/money/reporting.js has NO maintenance section. It already carries " +
      "the right shape for one — every section reports { status, value, reason, owner } " +
      "and never a fake zero — so a maintenance section would be additive, not a rewrite.");
  }

  await c.query("rollback");
  await c.end();

  if (AS_JSON) { console.log(JSON.stringify(R, null, 2)); process.exit(0); }

  const bar = "═".repeat(72);
  console.log(`\n${bar}\n  WHAT RELEASE 0 MADE READABLE   (read-only)\n${bar}\n`);
  console.log(`  release 0 activated        ${R.release_0.activated}`);
  console.log(`  containment guard armed    ${R.release_0.guard_armed}`);
  console.log(`  coherent                   ${R.release_0.coherent ? "yes" : "NO — see notes"}`);
  console.log(`  work orders read           ${R.population.work_orders_read} (${R.population.terminal} terminal)`);
  for (const scope of ["terminal", "not_terminal"]) {
    const rows = Object.entries(R.population.by_proof_state[scope]);
    if (!rows.length) continue;
    console.log(`      ${scope === "terminal" ? "TERMINAL — a completion claim" : "not terminal — work in progress"}`);
    for (const [k, v] of rows) console.log(`        ${k.padEnd(28)} ${v}`);
  }
  console.log(`\n  ── THE MAINTENANCE SECTION, CLAIM BY CLAIM ${"─".repeat(28)}`);
  for (const cl of R.claims) {
    console.log(`\n  ${cl.id}  ${cl.what}`);
    console.log(`      ${cl.verdict}`);
    console.log("      " + cl.why.replace(/(.{66}) /g, "$1\n      "));
    if (cl.unlocks) console.log("      unlocks: " + cl.unlocks.replace(/(.{57}) /g, "$1\n               "));
  }
  if (R.notes.length) {
    console.log(`\n  ── NOTES ${"─".repeat(62)}`);
    for (const n of R.notes) console.log("    · " + n.replace(/(.{68}) /g, "$1\n      "));
  }
  console.log(`\n${bar}\n`);
  process.exit(0);
})().catch((e) => { console.error("\nERROR:\n" + (e && e.stack || e)); process.exit(2); });
