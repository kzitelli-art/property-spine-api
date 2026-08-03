#!/usr/bin/env node
/* ════════════════════════════════════════════════════════════════════
   slice_a_full_schema_suite.js — THE REQUIRED FULL-SCHEMA PROOF PATH.

   Five harnesses build NO schema of their own. They assume a complete
   database, so they cannot run against the scoped fixtures the Slice A
   harness builds, and they were therefore NOT executed when Slice A was
   written. Slice A changed resolveInboundSmsContext — the exact function
   resident_sms_route_proof.js exercises — so that harness's 31/0 predates
   the change and is not evidence for it.

       "Previously green before the resolver changed" is not evidence
       for the changed resolver.

   This runner exists so those five can be run as one governed act with a
   preserved receipt, against a provisioned disposable full-schema database.

   ── IT ORCHESTRATES. IT DOES NOT REINTERPRET. ───────────────────────

   Every harness runs as a child process with stdio INHERITED, so its own
   output reaches the terminal unmodified — this runner never captures,
   summarises, re-prints or rephrases another harness's evidence. It
   propagates the child's EXACT exit code and stops at the first failure.

   There is deliberately no --continue, no --allow-failures, and no path
   that turns a non-zero child into a zero suite. A runner that can make a
   red harness look green is not a runner, it is a suppressor.

   ── WHAT IT GUARANTEES BEFORE ANYTHING RUNS ─────────────────────────

     1. HARNESS_DATABASE_URL is present. No fallback, ever.
     2. It does not resolve to the same target as DATABASE_URL.
     3. Database identity is printed WITHOUT the password.
     4. Branch and exact SHA are printed — the artifact being proven.
     5. The harness database's ledger matches THIS tree, both directions.
     6. No real transport is reachable from any child.

   ── ⚠ THE ISOLATION GAP THIS RUNNER CLOSES ──────────────────────────

   work_order_authority_proof.js and work_order_canonical_path_proof.js
   read process.env.DATABASE_URL DIRECTLY. They carry no
   harnessConnectionString() guard and no run receipt, because the
   convention in DB_HARNESS_ISOLATION.md applies to *.db.js and these are
   named *_proof.js. Both COMMIT fixtures. On Render, DATABASE_URL is
   production.

   Run by hand on a box where DATABASE_URL is set, those two write to
   whatever it points at. This runner therefore DELETES DATABASE_URL from
   every child environment and injects the already-verified harness target
   under that name for the two harnesses that read it. That is not a
   fallback — the runner never reads an ambient DATABASE_URL for any
   purpose except refusing to match it.

   ⚠ THIS RUNNER IS TEMPORARY CONTAINMENT, NOT THE FIX.

   It does not remove the unsafe direct-execution path. Both harnesses
   remain dangerous when invoked by hand in any environment where
   DATABASE_URL may point at production. Safety that depends on remembering
   to launch through a wrapper is not structural safety, and this project
   does not accept "safe only when started the right way" — including in
   its own proof tooling.

   OWNER RULING 2026-08-03: repairing both harnesses is a MERGE REQUIREMENT
   for Slice A, not a future note. Once the provisioned full-schema database
   exists, and BEFORE Slice A merges, each must:

     · require HARNESS_DATABASE_URL;
     · have no fallback to DATABASE_URL;
     · refuse when the harness target matches production;
     · print safe database identity, branch and exact SHA;
     · print assertion-start and assertion-complete receipts;
     · preserve its own exit code;
     · use no real transport or reachable phone numbers.

   Then run each DIRECTLY and through this runner. This runner stays as
   useful orchestration; it stops being the thing that makes them safe.

   Not done in this session because it cannot execute them to verify the
   change, and shipping a guard that has never run is the failure this
   project keeps rediscovering.

   ── USAGE ───────────────────────────────────────────────────────────

     HARNESS_DATABASE_URL="postgres://…disposable full-schema branch…" \
       node tests/slice_a_full_schema_suite.js

   EXIT
     0   all five passed
     N   the exact exit code of the FIRST harness that failed
     2   refused to start — preconditions not met, nothing executed
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const { spawnSync, execSync } = require("child_process");
const path = require("path");
const fs = require("fs");
const { Client } = require("pg");
const { dbIdentity, sameTarget } = require("./_run_receipt");
const { classifyLedger } = require("../migrations/ledger_verdict");

const HARNESSES = [
  { file: "resident_sms_work_order_proof.js", ownReceipt: true,  readsDatabaseUrl: false },
  { file: "resident_sms_route_proof.js", ownReceipt: true,  readsDatabaseUrl: false },
  { file: "work_order_authority_proof.js", ownReceipt: false, readsDatabaseUrl: true },
  { file: "work_order_canonical_path_proof.js", ownReceipt: false, readsDatabaseUrl: true },
  { file: "operator_obligations_security_proof.db.js", ownReceipt: true,  readsDatabaseUrl: false },
];

const bar = "════════════════════════════════════════════════════════════════";

function refuse(lines) {
  console.error("\n" + bar);
  console.error("  ✗ SUITE REFUSED TO START — no harness executed.");
  lines.forEach((l) => console.error("    " + l));
  console.error("  EXIT      2");
  console.error(bar + "\n");
  process.exit(2);
}

function gitFact(cmd, fallback) {
  try { return execSync(cmd, { stdio: ["ignore", "pipe", "ignore"] }).toString().trim(); }
  catch { return fallback; }
}

(async () => {
  // ── 1. HARNESS_DATABASE_URL, with no fallback ────────────────────
  const harnessUrl = process.env.HARNESS_DATABASE_URL;
  if (!harnessUrl) {
    refuse([
      "HARNESS_DATABASE_URL is not set.",
      "These five harnesses COMMIT fixtures and build no schema of their own.",
      "They require a provisioned, disposable, FULL-SCHEMA database.",
      "",
      "There is deliberately NO fallback to DATABASE_URL.",
      "See docs/DB_HARNESS_ISOLATION.md",
    ]);
  }

  // ── 2. It must not be production ─────────────────────────────────
  if (sameTarget(harnessUrl, process.env.DATABASE_URL)) {
    const id = dbIdentity(harnessUrl);
    refuse([
      "HARNESS_DATABASE_URL resolves to the SAME target as DATABASE_URL.",
      `  host=${id.host}  database=${id.database}`,
      "That is this service's live database. Create a disposable branch",
      "from it and point the harness at the branch instead.",
    ]);
  }

  // ── 6. No real transport reachable from any child ────────────────
  const transportEnv = Object.keys(process.env)
    .filter((k) => /^TWILIO_|^SMS_ACCOUNT|^MESSAGING_SERVICE/i.test(k));
  if (transportEnv.length) {
    refuse([
      "Real SMS transport credentials are present in this environment:",
      "  " + transportEnv.join(", "),
      "These harnesses must be unable to reach a carrier at all. Unset them",
      "and re-run. A proof that COULD have sent is not a proof that did not.",
    ]);
  }
  const sendMode = (process.env.SMS_SEND_MODE || "disabled").trim();
  if (sendMode !== "disabled") {
    refuse([
      `SMS_SEND_MODE is '${sendMode}'. It must be 'disabled' for this suite.`,
      "This runner will not set it for you — silently disabling a send mode",
      "is the runner deciding what the evidence means.",
    ]);
  }

  // ── 3 + 4. Identity of the database and of the artifact ──────────
  const id = dbIdentity(harnessUrl);
  const sha = gitFact("git rev-parse HEAD", "unknown (no .git)");
  const branch = process.env.RENDER_GIT_BRANCH
    || gitFact("git rev-parse --abbrev-ref HEAD", "unknown");
  const dirty = gitFact("git status --porcelain", "");

  console.log("\n" + bar);
  console.log("  SLICE A — REQUIRED FULL-SCHEMA PROOF SUITE");
  console.log(bar);
  console.log(`  BRANCH    ${branch}`);
  console.log(`  SHA       ${sha}`);
  console.log(`  TREE      ${dirty ? "⚠ DIRTY — uncommitted changes present" : "clean"}`);
  console.log(`  DATABASE  ${id.database}  @  ${id.host}:${id.port}  (user ${id.user})`);
  console.log(`  ENDPOINT  ${id.endpoint}`);
  console.log(`  ISOLATED  yes — target differs from DATABASE_URL${process.env.DATABASE_URL ? "" : " (which is unset here)"}`);
  console.log(`  TRANSPORT no carrier credentials present · SMS_SEND_MODE=${sendMode}`);
  console.log(bar);

  if (dirty) {
    console.log("  ! The working tree is DIRTY. The receipt below proves the tree as it");
    console.log("    exists on disk, which is NOT the commit named above. Commit first if");
    console.log("    this receipt is meant to attach to a merge candidate.\n");
  }

  // ── 5. The harness database must match THIS tree ─────────────────
  const files = fs.readdirSync(path.join(__dirname, "..", "migrations"))
    .filter((f) => /^\d{3}_.*\.sql$/.test(f) && !f.startsWith("000_")).sort();

  const client = new Client({ connectionString: harnessUrl, ssl: { rejectUnauthorized: false } });
  try {
    await client.connect();
  } catch (e) {
    refuse(["Could not connect to HARNESS_DATABASE_URL: " + e.message]);
  }
  let rows;
  try {
    ({ rows } = await client.query("select version, name from schema_migrations"));
  } catch (e) {
    await client.end().catch(() => {});
    refuse([
      "Could not read schema_migrations on the harness database: " + e.message,
      "These harnesses require a FULL schema. A database without a ledger is",
      "not a full-schema database.",
    ]);
  }
  await client.end().catch(() => {});

  const verdict = classifyLedger({ files, ledgerRows: rows });
  console.log(`  MIGRATIONS ${files.length} in this tree · harness ledger ceiling ${verdict.ceiling}`);

  const problems = [];
  if (verdict.fileMissingFromLedger.length) {
    problems.push(`${verdict.fileMissingFromLedger.length} migration(s) in this tree are NOT applied to the harness database:`);
    verdict.fileMissingFromLedger.forEach((f) => problems.push("    · " + f));
    problems.push("  The proof would run against a schema this code does not match.");
  }
  if (verdict.ledgerVersionMissingFromRepo.length) {
    problems.push("The harness ledger holds version(s) this tree has no file for:");
    verdict.ledgerVersionMissingFromRepo.forEach((e) => problems.push(`    · ${e.version} '${e.ledgerName}'`));
  }
  if (verdict.versionNameConflicts.length) {
    problems.push("Version/name conflict(s) between this tree and the harness ledger.");
  }
  if (problems.length) {
    refuse([...problems, "", "Migrate the harness database to this tree, then re-run."]);
  }
  console.log("  ✓ harness ledger matches this tree in both directions");
  console.log(bar);
  console.log("  SUITE ASSERTIONS STARTED");
  console.log(`  ${HARNESSES.length} harnesses, run individually, first failure stops the suite.`);
  console.log("  Each harness prints its OWN evidence below, unmodified.\n");

  // ── 6. Run each individually. Inherit stdio. Preserve exit codes. ─
  const results = [];
  for (const h of HARNESSES) {
    const target = path.join(__dirname, h.file);
    if (!fs.existsSync(target)) {
      console.error(`\n  ✗ ${h.file} — NOT FOUND. The suite is incomplete; refusing to continue.\n`);
      process.exit(2);
    }

    //  A clean environment per child. DATABASE_URL is DELETED, then
    //  re-supplied from the already-verified harness target ONLY for the
    //  harnesses that read it. The ambient value is never passed through.
    const env = { ...process.env };
    delete env.DATABASE_URL;
    env.HARNESS_DATABASE_URL = harnessUrl;
    if (h.readsDatabaseUrl) env.DATABASE_URL = harnessUrl;

    console.log(bar);
    console.log(`  ▶ ${h.file}`);
    if (h.readsDatabaseUrl) {
      console.log("    (reads DATABASE_URL directly — supplied the verified harness target;");
      console.log("     see the isolation-gap note in this file's header)");
    }
    if (!h.ownReceipt) {
      console.log("    (carries no _run_receipt preamble — it prints its own format;");
      console.log("     this runner does not fabricate one on its behalf)");
    }
    console.log(bar);

    const started = Date.now();
    const r = spawnSync(process.execPath, [target], { env, stdio: "inherit" });
    const seconds = ((Date.now() - started) / 1000).toFixed(1);

    if (r.error) {
      console.error(`\n  ✗ ${h.file} — could not be executed: ${r.error.message}`);
      console.error("  EXIT      2\n");
      process.exit(2);
    }
    if (r.signal) {
      console.error(`\n  ✗ ${h.file} — killed by signal ${r.signal}. Not a pass.`);
      console.error("  EXIT      2\n");
      process.exit(2);
    }

    results.push({ file: h.file, code: r.status, seconds });

    if (r.status !== 0) {
      console.error("\n" + bar);
      console.error(`  ✗ SUITE STOPPED — ${h.file} exited ${r.status}.`);
      console.error("    Its output above is the evidence. This runner does not");
      console.error("    reinterpret it and does not continue past a failure.");
      console.error("");
      results.forEach((x) => console.error(`      ${String(x.code).padStart(3)}  ${x.file}  (${x.seconds}s)`));
      const remaining = HARNESSES.length - results.length;
      if (remaining > 0) console.error(`      ${remaining} harness(es) NOT RUN — the suite proves nothing about them.`);
      console.error(`\n  EXIT      ${r.status}   (the harness's own exit code, preserved)`);
      console.error(bar + "\n");
      process.exit(r.status);
    }
  }

  console.log("\n" + bar);
  console.log("  SUITE ASSERTIONS COMPLETE");
  results.forEach((x) => console.log(`      ${String(x.code).padStart(3)}  ${x.file}  (${x.seconds}s)`));
  console.log("");
  console.log(`  ✓ PASS — all ${results.length} required full-schema harnesses exited 0`);
  console.log(`  BRANCH    ${branch}`);
  console.log(`  SHA       ${sha}${dirty ? "   ⚠ TREE WAS DIRTY" : ""}`);
  console.log(`  DATABASE  ${id.database} @ ${id.host}:${id.port}`);
  console.log("  EXIT      0");
  console.log(bar + "\n");
  process.exit(0);
})().catch((e) => {
  console.error("\n  ✗ suite could not run: " + (e && e.message ? e.message : e));
  console.error("  EXIT      2\n");
  process.exit(2);
});
