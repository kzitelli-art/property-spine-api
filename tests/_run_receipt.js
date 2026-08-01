// ════════════════════════════════════════════════════════════════════
//  _run_receipt.js — TEST-ONLY. The standard proof preamble/postamble.
//
//  WHY THIS EXISTS. tests/test_conversion_rail.db.js threw at construction
//  and ran zero assertions for 204 commits. It produced no failing assertion —
//  it produced an ABSENCE. Absence of red was read as green.
//
//  A run receipt is only trustworthy if it proves the assertions actually
//  BEGAN and COMPLETED, not merely that a process exited. So every critical
//  harness prints:
//     · the commit and branch it is executing
//     · the harness file by name
//     · an ASSERTIONS BEGIN marker
//     · a final count: run / passed / failed
//  A run missing the BEGIN marker, or reporting 0 assertions run, is a FAILED
//  run regardless of exit code.
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

function begin(harnessPath) {
  const name = path.basename(harnessPath);
  console.log("\n════════════════════════════════════════════════════════════════");
  console.log(`  HARNESS   ${name}`);
  console.log(`  COMMIT    ${commit()}`);
  console.log(`  BRANCH    ${branch()}`);
  console.log(`  DATABASE  ${process.env.DATABASE_URL ? "set" : "NOT SET"}`);
  console.log("════════════════════════════════════════════════════════════════");
  console.log("  ASSERTIONS BEGIN");
  return Date.now();
}

// Returns the exit code so the caller stays in control of process exit.
function complete({ harness, passed, failed, expectedAtLeast = 1 }) {
  const run = passed + failed;
  console.log("\n════════════════════════════════════════════════════════════════");
  console.log(`  ASSERTIONS COMPLETE · ${run} run · ${passed} passed · ${failed} failed`);
  if (run < expectedAtLeast) {
    console.error(`  ✗ RUN INVALID — expected at least ${expectedAtLeast} assertions, ${run} executed.`);
    console.error("    A harness that executes no assertions has proven nothing.");
    console.log("════════════════════════════════════════════════════════════════\n");
    return 1;
  }
  console.log(`  ${failed === 0 ? "✓ PASS" : "✗ FAIL"} — ${path.basename(harness)}`);
  console.log("════════════════════════════════════════════════════════════════\n");
  return failed === 0 ? 0 : 1;
}

module.exports = { begin, complete };
