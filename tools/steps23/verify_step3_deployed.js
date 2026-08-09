#!/usr/bin/env node
/* ════════════════════════════════════════════════════════════════════
   STEP 3 — VERIFY THE RUNNING CHECKOUT.  (OWED SINCE THE MERGE.)

   Step 3 merged as b4e3104 (PR #54) and the deploy was never verified —
   the sandbox proxy denied the production host. Every boundary after it
   assumes the canonical writer is live. This closes that.

   Run it IN THE RENDER SHELL, on the deployed checkout.

   ── A GREEN DEPLOY EVENT IS NOT EVIDENCE ────────────────────────────

   It proves a build ran. It does not prove the running checkout is the
   reviewed one, and this release has already been bitten by exactly that
   gap once (EXPECTED_SHA named a commit that was not the one deploying).
   So this reads the BYTES THAT ARE RUNNING and compares them to the
   digests of the merge.

   ── AND A DIGEST IS NOT BEHAVIOUR ───────────────────────────────────

   Matching bytes proves the file is the reviewed file. It does not prove
   the writer does what Step 3 says. So the digest check is paired with
   assertions about the running source itself: the evaluation is written,
   it is written BEFORE the status, and the evidence gate uses the
   corrected classification array.

   Read-only. Opens no transaction it cannot prove is read-only, writes
   nothing, sends nothing, needs no Twilio credentials.

   usage (Render shell):  node tools/steps23/verify_step3_deployed.js
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { Client } = require("pg");
const { beginProvenReadOnly, refuseNotReadOnly } = require("../activation/_readonly.js");

/*  The digests of Step 3 as merged to main at b4e3104 (PR #54). These are
 *  the bytes the deploy must be running. Recorded here rather than
 *  computed at run time: a check that derives its own expectation from
 *  the thing it is checking cannot fail. */
const EXPECTED = {
  "src/technician/lifecycle_service.js":
    "06bb9633536282f48bb90957b3cd77e83a2303feecdbc3b4b7bcb48e7ffbc5b1",
  "src/maintenance/proof_evaluation_service.js":
    "bbdd3e4b5043e64ff92c2bfbad2e4c346d5d582f644844dd66af7a91e7060f11",
  "src/maintenance/work_proof.js":
    "de92e1707148828826a93b6a68298ee37e350bccc86167734f59872b44c058a4",
};
const MERGE_SHA = "b4e3104";
const ROOT = path.join(__dirname, "..", "..");

let pass = 0, fail = 0;
const ok = (l, c, d) => { if (c) { pass++; console.log("  ok    " + l); }
  else { fail++; console.log("  FAIL  " + l + (d ? "\n          → " + d : "")); } return c; };
const sec = (t) => console.log(`\n${"═".repeat(66)}\n  ${t}\n${"═".repeat(66)}`);

//  Comments stripped before asserting on code: a check that matches the
//  comment EXPLAINING a rule reports the compliant file as the offender.
//  This repo has made that mistake three times now.
const codeOf = (p) => fs.readFileSync(path.join(ROOT, p), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");

(async function main() {
  if (!process.env.DATABASE_URL) { console.error("REFUSED: DATABASE_URL is not set."); process.exit(1); }

  console.log("\nSTEP 3 — IS THE CANONICAL WRITER ACTUALLY RUNNING?");
  console.log("  expecting the bytes merged at " + MERGE_SHA + " (PR #54)\n");

  // ── 1. THE BYTES ──────────────────────────────────────────────────
  sec("1 · THE RUNNING CHECKOUT IS THE REVIEWED ONE");
  for (const [file, want] of Object.entries(EXPECTED)) {
    const full = path.join(ROOT, file);
    if (!fs.existsSync(full)) { ok("1·" + file + " exists", false, "file absent"); continue; }
    const got = crypto.createHash("sha256").update(fs.readFileSync(full)).digest("hex");
    ok("1·" + file, got === want,
       "expected " + want.slice(0, 16) + "…  running " + got.slice(0, 16) + "…\n" +
       "          The deploy is NOT running the reviewed Step 3. Re-deploy before " +
       "anything below this line is trusted.");
  }

  // ── 2. THE BEHAVIOUR THE DIGEST CANNOT PROVE ──────────────────────
  sec("2 · AND IT DOES WHAT STEP 3 SAYS");
  const life = codeOf("src/technician/lifecycle_service.js");
  ok("2.1  claimCompletion records a proof evaluation", /recordEvaluation\(/.test(life),
     "the writer closes work without writing the evaluation that justifies it");

  //  §4: the evaluation is written FIRST and the status is contingent on
  //  it. That ordering is also what lets migration 140's guard admit the
  //  canonical writer, so it is load-bearing twice over.
  const iEval = life.indexOf("recordEvaluation(");
  const iStatus = life.indexOf("status = 'complete'");
  ok("2.2  …BEFORE it sets the status — the ordering §4 requires",
     iEval > -1 && iStatus > -1 && iEval < iStatus,
     "the status is set before the evaluation exists. A failure in between " +
     "leaves a completed work order with nothing behind it, and migration 140 " +
     "would refuse the canonical writer itself.");

  ok("2.3  …and the evidence gate is the CORRECTED classification array",
     /repair_photo/.test(life + codeOf("src/maintenance/work_proof.js")) &&
     !/['"]unclassified['"]/.test(codeOf("src/maintenance/work_proof.js")),
     "an unclassified photo is not proof of a repair (§3.1)");

  ok("2.4  the evaluation service refuses a state outside the writable two",
     /not_satisfied/.test(codeOf("src/maintenance/proof_evaluation_service.js")),
     "the chain contract is not enforced at the service");

  // ── 3. THE SCHEMA IT NEEDS ────────────────────────────────────────
  sec("3 · THE SCHEMA THE WRITER DEPENDS ON");
  const c = new Client({ connectionString: process.env.DATABASE_URL,
                         ssl: { rejectUnauthorized: false } });
  await c.connect();
  const ro = await beginProvenReadOnly(c, "step3_deployed");
  if (!ro.ok) process.exit(await refuseNotReadOnly(c, ro.reason));

  const ledger = (await c.query(`select max(version) v from schema_migrations`)).rows[0].v;
  ok("3.1  the ledger is at 137 or beyond", Number(ledger) >= 137, "ledger " + ledger);
  const objs = (await c.query(
    `select table_name from information_schema.tables
      where table_schema='public'
        and table_name in ('work_order_proof_evaluations',
                           'work_order_proof_evaluation_attachments')`)).rows.length;
  ok("3.2  the proof chain tables exist", objs === 2, objs + " of 2");

  // ── 4. HAS IT EVER RUN? ───────────────────────────────────────────
  //  Reported, never asserted. Zero evaluations is the EXPECTED state
  //  until Step 4 passes — Twilio is unconfigured, so no technician
  //  message can reach the writer. Calling that a failure would make this
  //  check red for a reason that is not about Step 3.
  sec("4 · HAS THE WRITER EVER RUN?  (reported, not asserted)");
  const evals = Number((await c.query(
    `select count(*) n from work_order_proof_evaluations`)).rows[0].n);
  console.log("  proof evaluations in production: " + evals);
  console.log(evals === 0
    ? "  → none yet. EXPECTED: Step 4 is blocked on Twilio, so nothing has\n" +
      "    reached the writer. Step 3 being deployed is a separate fact from\n" +
      "    Step 3 having been exercised, and only the first is checked here."
    : "  → the writer has produced real evaluations. Step 4 has been exercised.");

  sec("VERDICT");
  console.log(`  passed ${pass}   failed ${fail}`);
  console.log(fail === 0
    ? "\n  ✓ Step 3 is deployed and running the reviewed bytes.\n"
    : "\n  ✗ DO NOT PROCEED. Every boundary after Step 3 assumes this is true.\n");
  await c.end();
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error("\nERROR: " + (e && e.message)); process.exit(1); });
