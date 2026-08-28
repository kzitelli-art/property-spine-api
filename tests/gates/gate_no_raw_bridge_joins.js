// ════════════════════════════════════════════════════════════════════
//  gate_no_raw_bridge_joins.js — STATIC GATE (Identity Bridge contract, Part 3)
//
//  DOCTRINE: staff_identity_resolver.js is the ONLY module allowed to join
//  users.person_id to assignments (or read users.person_id for eligibility
//  at all). Without this gate, a 4th, 5th, 6th raw join WILL appear.
//
//  Scans every top-level .js module for the forbidden patterns. Exits 1
//  with the offending file:line list on any hit outside the allowlist.
//
//  Run:  node tests/gates/gate_no_raw_bridge_joins.js   (part of the proof suite)
// ════════════════════════════════════════════════════════════════════
"use strict";
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..", "..");
const ALLOW = new Set(["staff_identity_resolver.js"]); // the one canonical home

// Patterns that constitute a raw bridge read/join. Deliberately broad:
//   • any `<alias>.person_id = <alias>.person_id` equi-join touching users
//   • any `join users ... person_id` in one statement window
//   • any select of users.person_id for eligibility outside the resolver
const PATTERNS = [
  /join\s+users\s+\w+\s+on\s+\w+\.person_id\s*=\s*\w+\.person_id/i,
  /join\s+assignments\s+\w+\s+on\s+\w+\.person_id\s*=\s*\w+\.person_id/i,
  /u\.person_id\s*=\s*a\.person_id/i,
  /a\.person_id\s*=\s*u\.person_id/i,
];

let violations = [];
for (const f of fs.readdirSync(ROOT)) {
  if (!f.endsWith(".js") || ALLOW.has(f)) continue;
  const full = path.join(ROOT, f);
  if (!fs.statSync(full).isFile()) continue;
  const lines = fs.readFileSync(full, "utf8").split("\n");
  lines.forEach((line, i) => {
    for (const p of PATTERNS) {
      if (p.test(line)) violations.push(`${f}:${i + 1}  ${line.trim().slice(0, 100)}`);
    }
  });
}

if (violations.length) {
  console.error("GATE FAILED — raw users↔persons↔assignments joins outside the canonical resolver:");
  for (const v of violations) console.error("  " + v);
  console.error("\nEvery staff identity/eligibility read must go through staff_identity_resolver.js.");
  process.exit(1);
}
console.log("GATE PASS — no raw bridge joins outside staff_identity_resolver.js.");
