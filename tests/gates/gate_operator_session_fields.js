#!/usr/bin/env node
/* ════════════════════════════════════════════════════════════════════
   GATE — NO CODE READS A SESSION FIELD THAT DOES NOT EXIST

   `req.operator` is whatever staff_session_service.resolveStaffSession
   returns. Reading a field it does not define yields `undefined`, and
   JavaScript will not say a word about it.

   ── THE DEFECT THAT CAUSED THIS GATE ────────────────────────────────
   src/maintenance/maintenance.js read `req.operator.user_id`. The
   session has no such field — the user id is `id`. So EVERY governed
   maintenance action received `operatorUserId: undefined`:

       assignWork        assigned_by_user_id on the assignment event
       askForPhoto       the actor on an outbound staff message
       coordinateEntry   the actor on an outbound staff message
       prepareRetry      the actor on a delivery retry

   Every one of them recorded WHAT happened and TO WHOM, and never BY
   WHOM. Worse than a null: `JSON.stringify` omits undefined keys, so
   the assignment receipt did not carry `assigned_by_user_id: null` — the
   key was simply absent, which reads as "this system never captured it"
   rather than "this value is unknown".

   It survived because 86 other call sites read `req.operator.id`
   correctly and one did not, and nothing compares a property read
   against the shape actually returned. A typo in a field name is
   silent in a way a typo in a function name is not.

   ── HOW THIS GATE WORKS ─────────────────────────────────────────────
   The allowed field list is PARSED FROM THE SOURCE of the resolver, not
   copied here. A list copied here would drift from the resolver the
   first time someone adds a field, and a gate that has to be manually
   kept in sync is a gate that eventually lies.

   run:  node tests/gates/gate_operator_session_fields.js
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..", "..");
const SESSION_SRC = path.join(ROOT, "src", "identity", "staff_session_service.js");

let pass = 0, fail = 0;
const ok = (l, c, d) => { if (c) { pass++; console.log("  ok    " + l); }
  else { fail++; console.log("  FAIL  " + l + (d ? "\n        " + d : "")); } return c; };

console.log("════════════════════════════════════════════════════════════════");
console.log("  GATE  gate_operator_session_fields.js");
console.log("  checks: no code reads a req.operator field the session lacks");
console.log("════════════════════════════════════════════════════════════════");
console.log("  ASSERTIONS STARTED\n");

// ── 1. DERIVE the session's real shape from the resolver's source ─────
const src = fs.readFileSync(SESSION_SRC, "utf8");
//  resolveStaffSession's return literal: the block after the `const row =
//  r.rows[0]; if (!row) return null;` guard. Anchored on that guard so a
//  different `return {` elsewhere in the file cannot be picked up.
const anchor = src.indexOf("if (!row) return null;");
ok("A1  the resolver's null-guard anchor is present", anchor > -1,
   "staff_session_service.js changed shape — this gate must be re-derived, not deleted");
const openBrace = src.indexOf("return {", anchor);
const closeBrace = src.indexOf("\n  };", openBrace);
ok("A2  the resolved-session return literal is locatable",
   openBrace > -1 && closeBrace > openBrace);

const literal = src.slice(openBrace, closeBrace);
const FIELDS = new Set(
  [...literal.matchAll(/^\s{4}([a-z_][a-z0-9_]*)\s*:/gim)].map((m) => m[1])
);
ok("A3  a non-trivial field list was derived (not an empty allowlist)",
   FIELDS.size >= 8, "derived only " + FIELDS.size + " fields — the parse is wrong, and an " +
   "empty allowlist would pass everything");
console.log("        session fields: " + [...FIELDS].sort().join(", "));

/*  KNOWN, MEASURED, UNREPAIRED — a debt entry, never an approval.
 *
 *  Presence here means "found, understood, and left alone deliberately",
 *  and each entry carries the condition that removes it. A bare allowlist
 *  would let the next one in silently. */
const KNOWN = new Map([
  ["src/identity/operator.js:property_name",
   { why: "guarded `|| null`, so it fails SAFE — the identity-context response has always " +
          "reported the property name as blank rather than wrong. A field that looks alive " +
          "and can never populate is still a defect, but it is not an authority or " +
          "attribution defect and does not belong in the same change as one.",
     until: "the response either reads the name from the properties row or drops the key" }],
]);

// ── 2. EVERY req.operator.<field> READ IN THE TREE ────────────────────
function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === ".git") continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith(".js")) out.push(p);
  }
  return out;
}

const offenders = [];
const known = [];
let reads = 0, skippedFiles = 0;
for (const file of walk(path.join(ROOT, "src"))) {
  const text = fs.readFileSync(file, "utf8");
  //  A FIELD A FILE ASSIGNS IS A FIELD THAT FILE MAY READ.
  //  super_admin.js and org_admin.js take the staff session and then
  //  augment it — `req.operator.platform_role = "super_admin"` — before
  //  reading it back. That is a definition, not a phantom read. Deriving
  //  this per file is better than naming those two: a third admin surface
  //  added later is covered without anyone remembering this gate exists.
  const assigned = new Set(
    [...text.matchAll(/req\.operator\.([a-z_][a-z0-9_]*)\s*=(?!=)/gi)].map((m) => m[1])
  );
  if (assigned.size) skippedFiles++;
  text.split("\n").forEach((line, i) => {
    //  Skip comment lines — the explanation of this very defect names
    //  `.user_id`, and a gate that flags its own documentation is the
    //  mistake this repo has already made twice.
    if (/^\s*(\/\/|\*)/.test(line)) return;
    //  Skip the assignment itself — `req.operator.x = ...` defines x.
    for (const m of line.matchAll(/req\.operator\.([a-z_][a-z0-9_]*)\s*(=(?!=))?/gi)) {
      if (m[2]) continue;
      reads++;
      const field = m[1];
      if (FIELDS.has(field) || assigned.has(field)) continue;
      const rel = path.relative(ROOT, file).replace(/\\/g, "/");
      const key = rel + ":" + field;
      if (KNOWN.has(key)) { known.push(key + "  (line " + (i + 1) + ")"); continue; }
      offenders.push(rel + ":" + (i + 1) + "  req.operator." + field);
    }
  });
}

ok("A4  the scan actually found req.operator reads", reads > 0,
   "zero reads found — the scan is broken and would pass anything");
console.log("        " + reads + " reads scanned · " + skippedFiles
  + " file(s) augment req.operator with their own fields");

ok("A5  every read names a field the session actually defines",
   offenders.length === 0,
   offenders.join("\n        ") +
   "\n        → undefined at runtime, silently. Use the real field name.");

//  The debt register cannot rot: an entry that no longer corresponds to
//  real code is removed, not left as decoration.
const stale = [...KNOWN.keys()].filter((k) => !known.some((s) => s.startsWith(k)));
ok("A5b the known-debt register is still accurate", stale.length === 0,
   stale.map((s) => "no longer present: " + s).join("\n        ")
   + "\n        → repaired or moved; delete the entry.");
if (known.length) {
  console.log("\n        KNOWN, UNREPAIRED (fails safe, tracked):");
  for (const k of known) {
    const e = KNOWN.get(k.split("  ")[0]);
    console.log("          " + k + "\n            why:   " + e.why + "\n            until: " + e.until);
  }
}

// ── 3. THE SPECIFIC REGRESSION, NAMED ─────────────────────────────────
//  A general rule can be satisfied while the exact defect returns under
//  a new spelling, so the original is pinned by name.
const maint = fs.readFileSync(path.join(ROOT, "src/maintenance/maintenance.js"), "utf8")
  .split("\n").filter((l) => !/^\s*(\/\/|\*)/.test(l)).join("\n");
ok("A6  governed maintenance actions receive operatorUserId from req.operator.id",
   /operatorUserId:\s*req\.operator\.id\b/.test(maint),
   "runAction must pass the real user id — this is the line that made every " +
   "governed assignment, photo request, entry coordination and retry anonymous");
ok("A7  and nothing in that file reads the non-existent .user_id",
   !/req\.operator\.user_id/.test(maint));

console.log("\n════════════════════════════════════════════════════════════════");
console.log(`  ASSERTIONS COMPLETE · ${pass + fail} run · ${pass} passed · ${fail} failed`);
console.log("  " + (fail === 0 ? "✓ PASS" : "✗ FAIL") + " — gate_operator_session_fields.js");
console.log("  EXIT      " + (fail === 0 ? 0 : 1));
console.log("════════════════════════════════════════════════════════════════\n");
process.exit(fail === 0 ? 0 : 1);
