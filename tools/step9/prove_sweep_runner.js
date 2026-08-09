#!/usr/bin/env node
/* ════════════════════════════════════════════════════════════════════
   §4.2 — PROVE THE GOVERNED MANUAL RUNNER

   The service is proven. This proves the THING AN OPERATOR ACTUALLY
   TYPES: a real process, real argv, real exit codes.

   That distinction has already cost this release once — a tool that was
   correct in source carried a hardcoded id that matched nothing, and
   nobody found out until it was run. So every assertion here spawns the
   runner as a child process and reads what came back.

     R   dry run is the DEFAULT; --raise must be typed
     G   both refusals surface as clear exits, not stack traces
     I   re-running is idempotent through the CLI too
     B   bad arguments are refused rather than coerced

   ⚠ ISOLATED POSTGRES ONLY. Needs 137 + 138.

   usage:
     bash tools/steps23/baseline_136.sh
     PROVE_DATABASE_URL='...' node tools/steps23/apply_137.js
     STEP9_DATABASE_URL='postgresql://postgres@127.0.0.1:5433/r0scale?sslmode=disable' \
       node tools/step9/prove_sweep_runner.js
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawnSync } = require("child_process");
const { Client } = require("pg");

const ROOT = path.join(__dirname, "..", "..");
const RUNNER = path.join(ROOT, "tools/run_proof_defect_sweep.js");
const activation = require(path.join(ROOT, "src/release0/activation_service.js"));
//  migration 140 REFUSES to let recordActivation run without it, so a
//  harness that activates must install it. States the guard forbids are
//  then built inside an explicit withGuardOff() window.
const guardWindow = require("../step12/guard_window.js");
const URL = process.env.STEP9_DATABASE_URL;

let pass = 0, fail = 0;
const ok = (l, c, d) => { if (c) { pass++; console.log("  ok    " + l); }
  else { fail++; console.log("  FAIL  " + l + (d ? "\n          → " + d : "")); } return c; };
const sec = (t) => console.log(`\n${"═".repeat(66)}\n  ${t}\n${"═".repeat(66)}`);

//  A real process, with a real environment and real arguments.
const run = (args = []) => spawnSync(process.execPath, [RUNNER, ...args],
  { encoding: "utf8", env: { ...process.env, DATABASE_URL: URL } });

const ID = (n) => crypto.createHash("md5").update("s9run:" + n).digest("hex")
  .replace(/^(.{8})(.{4})(.{4})(.{4})(.{12}).*$/, "$1-$2-$3-$4-$5");
const ORG = ID("org"), PROP = ID("prop"), PROP_B = ID("propB");
const STEP6_INSTANT = new Date(Date.parse("2026-08-08T09:15:00.000Z"));

(async function main() {
  if (!URL) { console.error("REFUSED: STEP9_DATABASE_URL is not set."); process.exit(1); }
  const c = new Client({ connectionString: URL });
  await c.connect();
  const sentinel = Number((await c.query(
    `select count(*) n from release_0_scale_harness_guard where purpose like 'ISOLATED RELEASE 0%'`
  ).catch(() => ({ rows: [{ n: 0 }] }))).rows[0].n);
  if (sentinel !== 1) { console.error("REFUSED: not the isolated baseline."); process.exit(2); }
  if (Number((await c.query(`select count(*) n from release_0_activation_history`)).rows[0].n) > 0) {
    console.error("REFUSED: activation history is not empty — rebuild the baseline.");
    process.exit(3);
  }

  /*  Inert until the activation below, and then the reason every defect
   *  population in this file has to be built in a named window. */
  await guardWindow.installGuard(c);
  const forbidden = (why, fn) => guardWindow.withGuardOff(c, why, fn);

  console.log("§4.2 — SWEEP RUNNER (the thing an operator types)\n");

  await c.query(`insert into organizations (id,name) values ($1,'R9 Org') on conflict (id) do nothing`, [ORG]);
  for (const [p, n] of [[PROP, "R9 Property"], [PROP_B, "R9 Property B"]]) {
    await c.query(`insert into properties (id,name,organization_id) values ($1,$2,$3)
                   on conflict (id) do nothing`, [p, n, ORG]);
  }
  let seq = 0;
  const mkWo = async (status = "closed", property = PROP) => {
    const wo = ID("wo" + (++seq));
    await c.query(`insert into work_orders (id,property_id,title,status,source)
                   values ($1,$2,'s9run',$3,'s9runproof')`, [wo, property, status]);
    return wo;
  };
  const defects = async () => Number((await c.query(
    `select count(*) n from obligations where type='proof_evaluation_missing'`)).rows[0].n);

  // ══ G — THE GUARDS SURFACE AS EXITS, NOT STACK TRACES ══════════════
  sec("G · THE TWO REFUSALS REACH THE OPERATOR IN WORDS");
  {
    const noIndex = run();
    ok("G1  with no migration 138, the runner exits 2 and explains",
       noIndex.status === 2 && /migration 138 has not been applied/i.test(noIndex.stderr),
       "exit " + noIndex.status + " :: " + (noIndex.stderr || noIndex.stdout).slice(0, 200));
    ok("G2  …and does not spill a stack trace at the operator",
       !/at Object\.|at async |node:internal/.test(noIndex.stderr),
       noIndex.stderr.slice(0, 200));

    await c.query(fs.readFileSync(
      path.join(ROOT, "migrations/138_proof_evaluation_defect_obligation.sql"), "utf8"));

    await mkWo("closed");
    const noAct = run();
    ok("G3  with no activation, the runner exits 2 and names Step 7",
       noAct.status === 2 && /no cutover activation/i.test(noAct.stderr) &&
       /Step 7 comes first/i.test(noAct.stderr),
       "exit " + noAct.status + " :: " + (noAct.stderr || "").slice(0, 200));
    ok("G4  …and wrote nothing", await defects() === 0, String(await defects()));

    const census = await activation.readLegacyTerminalSet(c);
    await c.query("begin");
    await activation.recordActivation(c, {
      activated_at: STEP6_INSTANT, captured_by: "runner proof", expected: census });
    await c.query("commit");
    console.log(`\n  (activated; ${census.length} row(s) inventoried as legacy)`);
  }

  // ══ R — DRY RUN IS THE DEFAULT ═════════════════════════════════════
  sec("R · DRY RUN BY DEFAULT — --raise MUST BE TYPED");
  {
    //  After activation → a real defect, and a state the guard refuses.
    const post = await forbidden(
      "R needs one real defect for the runner to report",
      () => mkWo("closed"));
    const dry = run();
    ok("R1  a bare invocation is a DRY RUN", dry.status === 0 &&
       /DRY RUN, nothing written/.test(dry.stdout),
       "exit " + dry.status + " :: " + dry.stdout.slice(-300));
    ok("R2  …it says what it WOULD do", /WOULD RAISE: 1/.test(dry.stdout),
       dry.stdout.slice(-400));
    ok("R3  …and wrote NOTHING", await defects() === 0, String(await defects()));
    ok("R4  …and tells the operator how to actually run it",
       /--raise/.test(dry.stdout));

    const live = run(["--raise"]);
    ok("R5  --raise actually raises", live.status === 0 && /RAISED:\s+1/.test(live.stdout),
       "exit " + live.status + " :: " + live.stdout.slice(-300));
    ok("R6  …and the obligation exists", await defects() === 1, String(await defects()));
    console.log("        " + live.stdout.split("\n").filter((l) => /RAISED|ALREADY/.test(l)).join(" | "));
    global.__post = post;
  }

  // ══ I — IDEMPOTENT THROUGH THE CLI ═════════════════════════════════
  sec("I · RE-RUNNING IS SAFE — THE CADENCE DEPENDS ON IT");
  {
    const again = run(["--raise"]);
    ok("I1  a second --raise run adds nothing", await defects() === 1,
       String(await defects()));
    ok("I2  …and reports it as ALREADY OPEN rather than as a failure",
       again.status === 0 && /ALREADY OPEN: 1/.test(again.stdout),
       "exit " + again.status + " :: " + again.stdout.slice(-300));
  }

  // ══ S — SCOPE ══════════════════════════════════════════════════════
  sec("S · --property SCOPES THE PASS");
  {
    const other = await forbidden(
      "S needs a defect in a SECOND property to prove --property scopes",
      () => mkWo("closed", PROP_B));
    const scoped = run(["--raise", "--property", PROP]);
    const inOther = Number((await c.query(
      `select count(*) n from obligations where type='proof_evaluation_missing' and related_id=$1`,
      [other])).rows[0].n);
    ok("S1  a scoped pass leaves the other property alone", inOther === 0, String(inOther));
    ok("S2  …and says which scope it used",
       new RegExp("scope:\\s+" + PROP).test(scoped.stdout), scoped.stdout.split("\n")[2]);

    const all = run(["--raise"]);
    const inOther2 = Number((await c.query(
      `select count(*) n from obligations where type='proof_evaluation_missing' and related_id=$1`,
      [other])).rows[0].n);
    ok("S3  an unscoped pass reaches it", inOther2 === 1, String(inOther2));
    ok("S4  …and says so", /scope:\s+every property/.test(all.stdout), all.stdout.split("\n")[2]);
  }

  // ══ B — BAD ARGUMENTS ══════════════════════════════════════════════
  sec("B · A BAD ARGUMENT IS REFUSED, NEVER COERCED");
  {
    const bad = run(["--limit", "banana"]);
    ok("B1  a non-numeric --limit is refused", bad.status === 1 &&
       /must be a positive number/.test(bad.stderr), "exit " + bad.status + " " + bad.stderr.slice(0, 120));
    const zero = run(["--limit", "0"]);
    ok("B2  --limit 0 is refused rather than sweeping nothing silently",
       zero.status === 1, "exit " + zero.status);

    const noDb = spawnSync(process.execPath, [RUNNER],
      { encoding: "utf8", env: { ...process.env, DATABASE_URL: "" } });
    ok("B3  a missing DATABASE_URL is refused", noDb.status === 1 &&
       /DATABASE_URL is not set/.test(noDb.stderr), "exit " + noDb.status);
  }

  // ══ T — IT IS A TRIGGER, NOT A DECISION ════════════════════════════
  sec("T · THE RUNNER DECIDES NOTHING");
  {
    const src = fs.readFileSync(RUNNER, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    ok("T0  the stripper left real code, so T1/T2 are not vacuous",
       src.includes("runProofDefectSweep") && src.length > 500);
    ok("T1  the runner contains no work_orders query of its own",
       !/from\s+work_orders/i.test(src),
       "the runner has grown its own idea of which rows qualify — two predicates again");
    ok("T2  …and no obligation write of its own",
       !/insert\s+into\s+obligations/i.test(src));
    ok("T3  the property default is NULL, not a hardcoded id",
       /value\("--property",\s*null\)/.test(src),
       "a hardcoded id that silently matches nothing already cost this release a day");
  }

  sec("VERDICT");
  console.log(`  passed ${pass}   failed ${fail}`);
  await c.end();
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error("\nERROR:\n" + (e && e.stack || e)); process.exit(1); });
