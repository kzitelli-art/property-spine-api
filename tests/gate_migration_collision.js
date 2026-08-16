#!/usr/bin/env node
/* ════════════════════════════════════════════════════════════════════
   gate_migration_collision.js — TWO FILES MAY NOT SHARE A NUMBER

   A duplicate migration number is NOT a merge conflict. Git takes both
   files happily, every gate stays green, and the failure surfaces as a
   FAILED PRODUCTION DEPLOY — because a release applies every pending
   file and the ledger refuses the collision. Render then keeps the old
   instance live, so the API looks fine while the schema is absent.

   This has now happened twice on the meeting branch:

     · written as 168, which Debt then took
     · renumbered to 169, which Utilities had ALREADY taken on main
       while the renumber was being discussed

   Both times it was found by hand. `migrate.js` carries its own
   duplicate guard, but it only runs against a database — so the failure
   is discovered at release, which is the most expensive place to learn
   it. This gate is source-only and runs on every `npm run verify`.

   IT CANNOT SEE OTHER BRANCHES. A number free here may be taken by
   unmerged work elsewhere, which is exactly how 169 was lost. Rebasing
   onto current main before merge is still required; this gate catches
   the collision once main has it, not before.

       node tests/gate_migration_collision.js
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const fs = require("fs");
const path = require("path");

const DIR = path.join(__dirname, "..", "migrations");
const files = fs.readdirSync(DIR).filter((f) => /^\d{3}_.*\.sql$/.test(f)).sort();

const byNumber = new Map();
for (const f of files) {
  const n = f.slice(0, 3);
  if (!byNumber.has(n)) byNumber.set(n, []);
  byNumber.get(n).push(f);
}

const collisions = [...byNumber.entries()].filter(([, v]) => v.length > 1);

console.log("\n" + "═".repeat(64));
console.log("  MIGRATION COLLISION GATE");
console.log("═".repeat(64));
console.log(`  ${files.length} migration files · ceiling ${files[files.length - 1] || "none"}`);

if (collisions.length === 0) {
  console.log("\n  ✓ PASS — every migration number is unique in this tree.");
  console.log("    NOTE: this proves nothing about unmerged branches. Rebase onto");
  console.log("    current main before merging and re-run.\n");
  process.exit(0);
}

console.error("\n  ✗ FAIL — migration numbers are shared:\n");
for (const [n, v] of collisions) {
  console.error(`      ${n}  →  ${v.join("  ·  ")}`);
}
console.error("\n    Renumber the NEWER file to the next free slot above the ceiling.");
console.error("    Do this before merge, never during a release.\n");
process.exit(1);
