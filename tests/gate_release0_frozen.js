#!/usr/bin/env node
/* ════════════════════════════════════════════════════════════════════
   gate_release0_frozen.js — THE FALSIFICATION PACKAGE IS ABOUT THESE BYTES

   Migration 140 reached revision 4 after seven measured attacks broke
   revisions 1–3. `tools/step12/*` is not a test suite in the ordinary
   sense — it is EVIDENCE ABOUT THESE EXACT ARTIFACTS. A comment edit to
   the migration does not invalidate the argument; a changed predicate
   does, silently, and every green run afterwards would be evidence about
   something else.

   So the digests are pinned. This gate is not change control for its own
   sake:

       IF YOU CHANGE A FROZEN ARTIFACT, THE FALSIFICATION PACKAGE MUST BE
       RE-RUN AND THE DIGEST DELIBERATELY UPDATED IN THE SAME COMMIT.

   Updating the digest is easy and is meant to be. Updating it WITHOUT
   re-running the package is the thing this makes impossible to do by
   accident.

   ── WHY NOT PIN THE DIGEST IN THE ACTIVATION PRECONDITION TOO ───────

   Deliberately not. `assertContainmentGuardPresent` checks SUBSTANCE —
   the clauses the invariant needs — because a digest there would make a
   comment edit a production incident at the one irreversible boundary.
   Different jobs: that one is a safety gate, this one is change control.

   DB-free. Source only.
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ROOT = path.join(__dirname, "..");
const FROZEN = path.join(ROOT, "docs/release0/FROZEN_ARTIFACTS.json");

let pass = 0, fail = 0;
const ok = (l, c, d) => { if (c) { pass++; console.log("  ok    " + l); }
  else { fail++; console.log("  FAIL  " + l + (d ? "\n          → " + d : "")); } return c; };

console.log("\n══════════════════════════════════════════════════════════════════");
console.log("  RELEASE 0 — FROZEN ARTIFACTS");
console.log("══════════════════════════════════════════════════════════════════\n");

if (!fs.existsSync(FROZEN)) {
  console.error("  FAIL  the frozen manifest is missing: docs/release0/FROZEN_ARTIFACTS.json");
  console.error("        Without it nothing pins what the falsification package was about.\n");
  process.exit(1);
}
const frozen = JSON.parse(fs.readFileSync(FROZEN, "utf8"));

ok("F0  the manifest names artifacts at all",
   Object.keys(frozen.digests || {}).length >= 5,
   JSON.stringify(Object.keys(frozen.digests || {})));

const drifted = [];
for (const [rel, want] of Object.entries(frozen.digests)) {
  const p = path.join(ROOT, rel);
  if (!fs.existsSync(p)) { drifted.push({ rel, got: "MISSING" }); continue; }
  const got = crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
  if (got !== want) drifted.push({ rel, want: want.slice(0, 12), got: got.slice(0, 12) });
}

ok("F1  every frozen artifact matches its pinned digest",
   drifted.length === 0,
   drifted.map((d) => `${d.rel}\n              pinned ${d.want}  now ${d.got}`).join("\n            ") +
   "\n\n          → THE FALSIFICATION PACKAGE NO LONGER DESCRIBES THIS CODE." +
   "\n            Re-run it against an isolated ledger-137 baseline:" +
   "\n" + (frozen.reopens_the_package || []).map((x) => "              node " + x).join("\n") +
   "\n            …then update docs/release0/FROZEN_ARTIFACTS.json IN THE SAME COMMIT," +
   "\n            with the new evidence in the commit message. Updating the digest" +
   "\n            alone is the one thing this gate exists to prevent.");

//  The manifest must stay a statement about the CODE, not about its past.
ok("F2  the manifest records which commit froze it",
   typeof frozen.frozen_at_commit === "string" && frozen.frozen_at_commit.length >= 7,
   JSON.stringify(frozen.frozen_at_commit));
ok("F3  …and names the package that must be re-run",
   Array.isArray(frozen.reopens_the_package) && frozen.reopens_the_package.length >= 4,
   "a freeze that does not say what re-opening it costs is just a checksum");

/*  The error-code vocabulary is part of the contract: operators read these
 *  in production, the runbook names them, and the harnesses assert on
 *  them. A code that exists in the manifest and not in the migration —
 *  or the reverse — means the frozen description and the artifact have
 *  come apart. */
const sql = fs.readFileSync(
  path.join(ROOT, "migrations/140_post_activation_completion_guard.sql"), "utf8");
const inSql = new Set((sql.match(/R000\d/g) || []));
const inManifest = new Set(Object.keys(frozen.error_codes || {}));
ok("F4  every error code the manifest documents is raised by the migration",
   [...inManifest].every((c) => inSql.has(c)),
   [...inManifest].filter((c) => !inSql.has(c)).join(", "));
ok("F5  …and every code the migration raises is documented",
   [...inSql].every((c) => inManifest.has(c)),
   [...inSql].filter((c) => !inManifest.has(c)).join(", ") +
   " — an undocumented refusal is one an operator meets for the first time in production");

console.log(`\n  frozen at ${frozen.frozen_at_commit}`);
for (const rel of Object.keys(frozen.digests)) console.log("    " + rel);
console.log("\n══════════════════════════════════════════════════════════════════");
console.log(`  passed ${pass}   failed ${fail}`);
console.log("══════════════════════════════════════════════════════════════════\n");
process.exit(fail === 0 ? 0 : 1);
