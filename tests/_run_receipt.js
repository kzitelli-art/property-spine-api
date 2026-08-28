// ════════════════════════════════════════════════════════════════════
//  _run_receipt.js — TEST-ONLY. The standard proof preamble/postamble,
//  and the FAIL-CLOSED database guard every DB harness must pass through.
//
//  WHY THE RECEIPT EXISTS. tests/proofs/test_conversion_rail.db.js threw at
//  construction and ran zero assertions for 204 commits. It produced no failing
//  assertion — it produced an ABSENCE. Absence of red was read as green.
//
//  WHY THE GUARD EXISTS. Every DB harness used to read DATABASE_URL directly.
//  On Render that is PRODUCTION, and each harness commits (its tx() ends in
//  `commit`, not `rollback`) and never cleans up. So running the proof suite
//  wrote synthetic properties, users, persons, prospects, assignments, sessions,
//  conversions, obligations and events into the live operating database. See
//  docs/DB_HARNESS_ISOLATION.md for the manifest.
//
//  The rule, permanently: a harness that needs a database refuses to start
//  unless HARNESS_DATABASE_URL is present. Production DATABASE_URL is NEVER an
//  accepted default for automated proof. There is no fallback — a missing
//  harness URL is a refusal, not a reason to reach for the other variable.
// ════════════════════════════════════════════════════════════════════
"use strict";
const { execSync } = require("child_process");
const path = require("path");

function commit() {
  // The Render shell has no .git — RENDER_GIT_COMMIT is the authority there.
  if (process.env.RENDER_GIT_COMMIT) return process.env.RENDER_GIT_COMMIT + " (RENDER_GIT_COMMIT)";
  try { return execSync("git rev-parse HEAD", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim(); }
  catch { return "unknown (no .git and no RENDER_GIT_COMMIT)"; }
}
function branch() {
  if (process.env.RENDER_GIT_BRANCH) return process.env.RENDER_GIT_BRANCH;
  try { return execSync("git rev-parse --abbrev-ref HEAD", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim(); }
  catch { return "unknown"; }
}

//  IDENTITY WITHOUT THE SECRET. Never print the connection string: it carries a
//  password, and a proof receipt is something people paste into chat. Host,
//  database and user are enough to prove WHICH database ran, and on Neon the
//  host embeds the endpoint/branch id (ep-xxxx-...), which is the branch
//  identity the isolation requirement asks for.
function dbIdentity(url) {
  try {
    const u = new URL(url);
    return {
      host: u.hostname,
      port: u.port || "5432",
      database: u.pathname.replace(/^\//, "") || "(none)",
      user: u.username || "(none)",
      // Neon endpoint id is the leading label of the hostname.
      endpoint: (u.hostname.match(/^(ep-[a-z0-9-]+)/i) || [null, "(not a Neon endpoint host)"])[1],
    };
  } catch {
    return { host: "(unparseable)", port: "?", database: "(unparseable)", user: "?", endpoint: "?" };
  }
}

//  Same TARGET, not merely same string. A trailing sslmode or a different
//  password must not be enough to slip past the guard — host + port + database
//  is what decides which rows get written.
function sameTarget(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  const x = dbIdentity(a), y = dbIdentity(b);
  if (x.host === "(unparseable)" || y.host === "(unparseable)") return false;
  return x.host === y.host && x.port === y.port && x.database === y.database;
}

function refuse(lines) {
  console.error("\n════════════════════════════════════════════════════════════════");
  console.error("  ✗ REFUSED TO START — no assertions executed.");
  lines.forEach((l) => console.error("    " + l));
  console.error("════════════════════════════════════════════════════════════════\n");
  process.exit(1);
}

//  THE GUARD. Call this instead of reading process.env.DATABASE_URL.
//  Exits non-zero rather than returning on refusal — a harness must not be able
//  to continue past this by ignoring a return value.
function harnessConnectionString() {
  const url = process.env.HARNESS_DATABASE_URL;
  if (!url) {
    refuse([
      "HARNESS_DATABASE_URL is not set.",
      "DB harnesses COMMIT their fixtures and never clean up, so they must run",
      "against a disposable proof database — never production.",
      "",
      "There is deliberately NO fallback to DATABASE_URL.",
      "Run:  HARNESS_DATABASE_URL=\"postgres://...\" node <harness>",
      "See docs/DB_HARNESS_ISOLATION.md",
    ]);
  }
  if (sameTarget(url, process.env.DATABASE_URL)) {
    const id = dbIdentity(url);
    refuse([
      "HARNESS_DATABASE_URL points at the SAME target as DATABASE_URL.",
      `  host=${id.host}  database=${id.database}`,
      "That is the production database for this service. Create a disposable",
      "Neon branch from it and point the harness at the branch instead.",
    ]);
  }
  return url;
}

function begin(harnessPath, { url = null, expected = null } = {}) {
  const name = path.basename(harnessPath);
  console.log("\n════════════════════════════════════════════════════════════════");
  console.log(`  HARNESS   ${name}`);
  console.log(`  COMMIT    ${commit()}`);
  console.log(`  BRANCH    ${branch()}`);
  if (url) {
    const id = dbIdentity(url);
    console.log(`  DATABASE  ${id.database}  @  ${id.host}:${id.port}  (user ${id.user})`);
    console.log(`  ENDPOINT  ${id.endpoint}`);
    console.log(`  ISOLATED  yes — target differs from DATABASE_URL${process.env.DATABASE_URL ? "" : " (which is unset here)"}`);
  } else {
    console.log("  DATABASE  (none — this harness needs no database)");
  }
  if (expected != null) console.log(`  EXPECTED  ${expected} assertions`);
  console.log("════════════════════════════════════════════════════════════════");
  console.log("  ASSERTIONS STARTED");
  return Date.now();
}

// Returns the exit code so the caller stays in control of process exit.
function complete({ harness, passed, failed, expectedAtLeast = 1 }) {
  const run = passed + failed;
  const code = run < expectedAtLeast ? 1 : (failed === 0 ? 0 : 1);
  console.log("\n════════════════════════════════════════════════════════════════");
  console.log(`  ASSERTIONS COMPLETE · ${run} run · ${passed} passed · ${failed} failed`);
  if (run < expectedAtLeast) {
    console.error(`  ✗ RUN INVALID — expected at least ${expectedAtLeast} assertions, ${run} executed.`);
    console.error("    A harness that executes no assertions has proven nothing.");
  } else {
    console.log(`  ${failed === 0 ? "✓ PASS" : "✗ FAIL"} — ${path.basename(harness)}`);
  }
  console.log(`  EXIT      ${code}`);
  console.log("════════════════════════════════════════════════════════════════\n");
  return code;
}

//  A crash before/among the assertions must report itself in the same
//  vocabulary as a failed run, and say plainly how little executed.
function died(harness, e, ran) {
  console.error("\n════════════════════════════════════════════════════════════════");
  console.error("  ✗ RUN INVALID — the harness died before completing its assertions.");
  console.error(`    Harness: ${path.basename(harness)}`);
  console.error(`    Assertions executed: ${ran}  (a run that proves nothing)`);
  console.error("    Cause: " + (e && e.message ? e.message : e));
  console.error("  EXIT      1");
  console.error("════════════════════════════════════════════════════════════════\n");
  return 1;
}

module.exports = { begin, complete, died, harnessConnectionString, dbIdentity, sameTarget };
