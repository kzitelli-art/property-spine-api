#!/usr/bin/env node
/* ════════════════════════════════════════════════════════════════════
   run_proof_defect_sweep.js — one pass of the §4.2 defect sweep.

     node tools/run_proof_defect_sweep.js                  DRY RUN, writes nothing
     node tools/run_proof_defect_sweep.js --raise          actually raises obligations
     node tools/run_proof_defect_sweep.js --property <id>  scope to one property
     node tools/run_proof_defect_sweep.js --limit 200      bound one pass

   Dry run is the default and `--raise` must be typed, exactly as
   run_followups.js requires `--send`. That is the cadence §4.2 names, and
   this deliberately follows its shape rather than introducing a scheduler
   — inventing one would be new architecture, and the manual trigger is
   what the rail currently is.

   ── IT IS A TRIGGER, NOT A DECISION ─────────────────────────────────

   Every rule lives in the service: the four-state predicate, the two
   refusals, the idempotency. This file parses arguments, opens a pool and
   prints what happened. If it ever starts deciding which rows qualify,
   there are two predicates again and §3.2.0 is broken.

   Class 3. Removal condition: delete when a scheduled runner with an
   operator-facing preview replaces the manual trigger — the same removal
   condition run_followups.js carries, and it should go at the same time.
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const path = require("path");
const fs = require("fs");
const { Pool } = require("pg");

//  .env is loaded the way run_followups.js loads it, and its ABSENCE is not
//  fatal: this tool is exercised against the isolated harness with
//  DATABASE_URL supplied directly, and a missing .env there is normal.
const ENV = path.join(__dirname, "..", ".env");
if (fs.existsSync(ENV)) {
  for (const line of fs.readFileSync(ENV, "utf8").split(/\r?\n/)) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const value = (name, dflt) => {
  const i = argv.indexOf(name);
  return i > -1 && argv[i + 1] ? argv[i + 1] : dflt;
};

const RAISE = flag("--raise");
//  NOT defaulted to a hardcoded property. A hardcoded id that silently
//  matched nothing already cost this release a day; null means "every
//  property", which is a decision the operator makes by omission.
const PROPERTY = value("--property", null);
const LIMIT = Number(value("--limit", "500"));

(async () => {
  if (!process.env.DATABASE_URL) {
    console.error("REFUSED: DATABASE_URL is not set.");
    process.exit(1);
  }
  if (!Number.isFinite(LIMIT) || LIMIT <= 0) {
    console.error(`REFUSED: --limit must be a positive number, got ${JSON.stringify(value("--limit"))}.`);
    process.exit(1);
  }

  const insecureLocal = /sslmode=disable/.test(process.env.DATABASE_URL);
  const pool = new Pool({ connectionString: process.env.DATABASE_URL,
                          ssl: insecureLocal ? false : { rejectUnauthorized: false } });
  const { runProofDefectSweep } = require(
    path.join(__dirname, "..", "src", "maintenance", "proof_defect_sweep.js"));

  try {
    const out = await runProofDefectSweep(pool, {
      propertyId: PROPERTY, limit: LIMIT, dryRun: !RAISE,
      detectedBy: "tools/run_proof_defect_sweep.js",
    });

    console.log(`\n=== PROOF DEFECT SWEEP ${out.dry_run ? "(DRY RUN, nothing written)" : "(LIVE)"} ===`);
    console.log(`scope:      ${PROPERTY || "every property"}`);
    console.log(`candidates: ${out.candidates}   (prefilter)`);
    console.log(`confirmed:  ${out.confirmed}    (missing_evaluation_defect, via the reader's predicate)`);
    console.log(`skipped:    ${out.skipped_not_defect}   (the reader disagreed with the prefilter)`);

    if (out.dry_run) {
      console.log(`\nWOULD RAISE: ${out.confirmed}`);
      console.log("\nNothing was written. Re-run with --raise to raise the obligations.\n");
    } else {
      console.log(`\nRAISED:       ${out.raised}`);
      console.log(`ALREADY OPEN: ${out.already_open}   (idempotent — not an error)`);
    }

    if (out.failed.length) {
      //  Reported, never thrown away. §4.2: a partial run leaves the rows
      //  that succeeded and the next pass re-derives the rest.
      console.log(`\nFAILED: ${out.failed.length}  (the next pass re-attempts these)`);
      for (const f of out.failed) console.log(`  ${f.work_order_id}: ${f.error}`);
      process.exitCode = 1;
    }
    console.log("");
  } catch (e) {
    //  The two refusals are the guards doing their job, not crashes, and
    //  they are worth explaining where the operator is already reading.
    if (e.code === "ACTIVATION_ABSENT") {
      console.error("\nREFUSED — no cutover activation exists.\n");
      console.error("  Without the inventory there is nothing separating legitimate legacy");
      console.error("  history from a real defect, so this sweep would raise an obligation");
      console.error("  against EVERY terminal work order. Step 7 comes first.\n");
      process.exit(2);
    }
    if (e.code === "IDEMPOTENCY_INDEX_MISSING") {
      console.error("\nREFUSED — migration 138 has not been applied.\n");
      console.error("  Without uq_obl_proof_eval_missing_open a duplicate obligation is");
      console.error("  merely unlikely rather than impossible, and every run would add");
      console.error("  another one silently.\n");
      process.exit(2);
    }
    console.error("RUN ERROR:", e.message);
    process.exitCode = 1;
  } finally { await pool.end(); }
})();
