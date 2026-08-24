#!/usr/bin/env node
/* ════════════════════════════════════════════════════════════════════
   gate_current_state.js — docs/CURRENT_STATE.md CANNOT GO QUIETLY STALE.

   CURRENT_STATE.md exists because threads kept rebuilding things that
   already existed. It only works if it stays true, and until now the only
   thing keeping it true was people remembering to update it. That is
   exactly what docs/CODEBASE_STATE.md (5 Aug) relied on — it was stamped to
   one commit and was silently wrong two weeks later.

   This gate is the difference between a convention and a rule.

   ── WHAT IT CHECKS, AND WHY EACH ONE EARNED ITS PLACE ───────────────
   1. THE FILE EXISTS and carries its own required sections. A gate that
      cannot find the thing it guards must go red, not skip.
   2. EVERY src/ DIRECTORY IS NAMED. A whole domain landing with no row is
      the original failure. This is deliberately coarse — naming a
      directory is a low bar, and the point is that crossing it requires a
      human to have looked.
   3. NO BANNED VOCABULARY in a proof rung. "done", "working", "live" blend
      intent with evidence, which is the failure the file exists to end.
   4. DEFECT NUMBERING IS SEQUENTIAL. Two rows sharing a number, or a gap,
      means an edit collided — this file is edited by more than one thread.
   5. THE SNAPSHOT PARSES and names a real commit.

   ── WHAT IT DELIBERATELY DOES NOT CHECK ─────────────────────────────
   It does not verify that any row is TRUE. It cannot — truth needs a human
   opening a test. This gate proves the file has not silently lost coverage,
   not that its contents are accurate. Saying so plainly matters: a gate
   that implies more than it measures launders a gap into evidence, which
   this repo has been bitten by before.
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const STATE = path.join(ROOT, "docs", "CURRENT_STATE.md");

let pass = 0, fail = 0;
const ok  = (l) => { pass++; console.log(`  ok    ${l}`); };
const bad = (l, d) => { fail++; console.log(`  FAIL  ${l}${d ? "\n        " + d : ""}`); };

console.log("\nGATE — docs/CURRENT_STATE.md coverage\n");

if (!fs.existsSync(STATE)) {
  console.log("  FAIL  docs/CURRENT_STATE.md does not exist.");
  console.log("\n  This gate guards the file that tells a thread what already exists.");
  console.log("  Its absence is not a skip — it is the failure it exists to catch.\n");
  process.exit(1);
}
const doc = fs.readFileSync(STATE, "utf8");

// ── 1 · REQUIRED SECTIONS ────────────────────────────────────────────
for (const heading of [
  "## STATE SNAPSHOT",
  "## THE VOCABULARY",
  "## ⛔ KNOWN LIVE DEFECTS",
  "## ⛔ CLOSING A THREAD",
]) {
  if (doc.includes(heading)) ok(`section present: ${heading.replace(/^#+ /, "")}`);
  else bad(`section MISSING: ${heading}`,
    "Removing a section removes the thing that makes this file usable.");
}

// ── 2 · EVERY src/ DIRECTORY IS NAMED ────────────────────────────────
//  Coarse on purpose. The bar is "a human looked at this directory", not
//  "every file is catalogued".
const srcDirs = fs.readdirSync(path.join(ROOT, "src"), { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name)
  .sort();

const unnamed = srcDirs.filter((d) => !doc.includes(d));
if (!unnamed.length) {
  ok(`all ${srcDirs.length} src/ directories are named somewhere in the file`);
} else {
  bad(`${unnamed.length} src/ director${unnamed.length === 1 ? "y is" : "ies are"} named nowhere: ${unnamed.join(", ")}`,
    "A domain that exists in src/ and in nobody's map is the original failure this file exists to prevent.\n" +
    "        Add a row — even one that honestly says NOT_FOUND or BUILT_BUT_DORMANT.");
}

// ── 3 · BANNED VOCABULARY IN A RUNG ──────────────────────────────────
//  Only inside a rung cell, never in prose — the file legitimately
//  discusses these words when explaining why they are banned.
const BANNED = /\|\s*`?(done|working|live|mostly done|complete)`?\s*\|/i;
const rungViolations = doc.split("\n")
  .map((line, i) => ({ line, n: i + 1 }))
  .filter(({ line }) => BANNED.test(line));
if (!rungViolations.length) {
  ok("no banned vocabulary used as a proof rung");
} else {
  bad(`${rungViolations.length} row(s) use a banned word as a rung`,
    rungViolations.slice(0, 3).map((v) => `line ${v.n}: ${v.line.slice(0, 90)}`).join("\n        ") +
    "\n        Those words blend intent with evidence. Use the controlled vocabulary.");
}

// ── 4 · DEFECT NUMBERING IS SEQUENTIAL ───────────────────────────────
//  More than one thread edits this file. A collision shows up here first.
const nums = [...doc.matchAll(/^\|\s*(\d+)\s*\|/gm)].map((m) => Number(m[1]));
if (nums.length === 0) {
  bad("no numbered defect rows found", "The defects table is the operational half of this file.");
} else {
  const dupes = nums.filter((n, i) => nums.indexOf(n) !== i);
  const sorted = [...new Set(nums)].sort((a, b) => a - b);
  const gaps = sorted.filter((n, i) => i > 0 && n !== sorted[i - 1] + 1);
  if (dupes.length) {
    bad(`duplicate defect number(s): ${[...new Set(dupes)].join(", ")}`,
      "Two rows sharing a number means two edits collided. Renumber before merging.");
  } else if (gaps.length) {
    bad(`gap(s) in defect numbering before: ${gaps.join(", ")}`,
      "A missing number usually means a row was deleted. Resolved defects are KEPT and marked RESOLVED,\n" +
      "        never removed — the fact that something was once broken is itself current-state information.");
  } else {
    ok(`${nums.length} defect rows, numbered 1..${sorted[sorted.length - 1]}, no gaps or duplicates`);
  }
}

// ── 5 · THE SNAPSHOT NAMES A REAL COMMIT ─────────────────────────────
const snap = doc.match(/API verified against\s+([0-9a-f]{7,40})/);
if (!snap) {
  bad("STATE SNAPSHOT does not name an API commit",
    "Without it, the staleness check in the file cannot be run at all.");
} else {
  ok(`snapshot names an API commit (${snap[1]})`);
}

// ── RESULT ───────────────────────────────────────────────────────────
console.log(`\n  ${pass} passed, ${fail} failed`);
if (fail) {
  console.log("\n  This gate proves the file has not silently lost coverage.");
  console.log("  It does NOT prove any row is true — that still needs a human opening a test.\n");
  process.exit(1);
}
console.log("  (Coverage only. This gate does not verify that any row is TRUE.)\n");
