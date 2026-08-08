#!/usr/bin/env node
/* ════════════════════════════════════════════════════════════════════
   gate_proof_compatibility_field.js — `satisfied` IS PUBLISHED, NOT READ.

   §3.4 freezes a compatibility mapping so consumers that have not moved
   to `state` keep working:

     satisfied → true · not_satisfied → false
     legacy_indeterminate → null · missing_evaluation_defect → null

   It exists FOR CONSUMERS. The moment this API reads it back, the two
   halves of the four-state contract can disagree with each other — and
   they already did once: `nextActionFor` read `proof.satisfied`, which
   Step 8 made ABSENT on a failed read, so a read that did not complete
   became "Obtain repair photo before completion".

   THIS GATE MAKES "zero internal consumers" A RULE RATHER THAN A
   SNAPSHOT. The cleanup release could only remove the field once every
   consumer was proven on `state`, and that inventory stays true only if
   something refuses to let a new one appear.

   ── THE REMOVAL HAS NOW BEEN BUILT, AND G6 INVERTED ─────────────────

   G6 asserted the field was STILL PUBLISHED, because removing it early
   hands every consumer `undefined` — which is falsy, and therefore the
   same shape as the defect this release just fixed, in all of them at
   once. That assertion was right up to the moment the consumers moved.
   It now asserts the opposite, and G8/G9 hold the line that matters:
   `state` is still emitted, and the frozen mapping is still exported.

   ── WHAT IT DOES NOT GOVERN ─────────────────────────────────────────

   `proof_satisfied` — snake_case, a COLUMN on work_completion_claims
   from migration 115 — is the WORK ACCEPTANCE domain and has nothing to
   do with the Release 0 proof block. It is named here so a future
   cleanup does not mistake one for the other and delete the wrong thing.

   Source-only. No database, no credentials.
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const READER = path.join(ROOT, "src/surfaces/work_order_status_read.js");

let pass = 0, fail = 0;
const ok = (l, c, d) => { if (c) { pass++; console.log("  ok    " + l); }
  else { fail++; console.log("  FAIL  " + l + (d ? "\n          → " + d : "")); } return c; };

//  Comments are stripped everywhere. Both the reader and the normalizer
//  DISCUSS this field on purpose, and a gate that matches an explanation
//  of the rule reports the compliant file as the offender. That has
//  already happened twice in this release.
const codeOf = (p) => fs.readFileSync(p, "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name.startsWith(".")) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith(".js")) out.push(p);
  }
  return out;
}

console.log("\n══════════════════════════════════════════════════════════════════");
console.log("  `satisfied` IS THE COMPATIBILITY FIELD — PUBLISHED, NEVER READ");
console.log("══════════════════════════════════════════════════════════════════\n");

const shipped = [...walk(path.join(ROOT, "src")), path.join(ROOT, "server.js")];
ok("G0  the sweep found the shipped source to search", shipped.length >= 20,
   shipped.length + " files");

/*  The proof block's own key. Anchored to `proof.satisfied` and to
 *  `<something>.proof.satisfied`, never to the bare word: `satisfied` is
 *  heavily overloaded in this codebase (obligations are satisfied,
 *  readiness is satisfied, a delivery is satisfied) and a gate that cried
 *  wolf about those would be deleted within a week. */
const READ = /(^|[^_\w])proof\s*\??\s*\.\s*satisfied\b/;

const offenders = [];
for (const f of shipped) {
  const code = codeOf(f);
  if (!READ.test(code)) continue;
  //  The ONE legitimate occurrence: the list projection EMITTING it.
  //  A producer, not a consumer.
  const lines = code.split("\n").filter((l) => READ.test(l));
  for (const l of lines) {
    const emitting = f === READER && /satisfied:\s*s\.proof\.satisfied/.test(l);
    if (!emitting) offenders.push(path.relative(ROOT, f) + "  ::  " + l.trim().slice(0, 110));
  }
}

ok("G1  nothing in this API READS the compatibility field", offenders.length === 0,
   offenders.join("\n          ") +
   "\n          → a reader of `satisfied` cannot tell legacy from a writer defect " +
   "(both null) and cannot tell either from an unavailable read (absent). " +
   "Read `proof.state` and `proof.read_status` instead.");

/*  ANTI-VACUITY. If the pattern matched nothing at all, G1 would be green
 *  because it is blind rather than because the API is clean.
 *
 *  It used to anchor on the list projection — the one place that PUBLISHED
 *  the field. That anchor is GONE now that the cleanup candidate retires
 *  it, and an anti-vacuity check that depends on the thing being removed
 *  stops working exactly when the removal lands. So it anchors on a
 *  literal instead, which cannot be refactored away:  */
const SAMPLES = ["return proof.satisfied ? 1 : 2;",
                 "const x = status.proof.satisfied;",
                 "if (d.proof ?. satisfied) {}"];
ok("G2  the pattern still detects a read — the check is not blind",
   SAMPLES.every((x) => READ.test(x)) && !READ.test("proof_satisfied = true"),
   "READ matches " + SAMPLES.filter((x) => READ.test(x)).length + "/3 known reads, and " +
   (READ.test("proof_satisfied = true") ? "WRONGLY matches the work-acceptance column" : "correctly ignores proof_satisfied"));

const readerCode = codeOf(READER);

/*  The specific regression, pinned. next_action is the one derived field
 *  that depends on the proof block, and it is what the app prints under
 *  "what happens next". */
const nafStart = readerCode.indexOf("function nextActionFor");
const naf = readerCode.slice(nafStart, readerCode.indexOf("\n}", nafStart));
ok("G3  nextActionFor exists and was found", nafStart > -1 && naf.length > 100,
   "the function was renamed — re-point G4 before trusting it");
/*  A PROPERTY READ, not the bare word. `state === "satisfied"` is the
 *  correct code — comparing `state` to one of the four literals is the
 *  whole point — and a `\bsatisfied\b` pattern condemned it. A gate that
 *  fails the fix is worse than no gate: the next person deletes the gate. */
ok("G4  …and derives nothing from the `satisfied` FIELD", !/\.\s*satisfied\b/.test(naf),
   naf.trim().slice(0, 200) +
   "\n          → this exact read answered 'Obtain repair photo before completion' " +
   "on a read that never completed");
ok("G4a …while the state LITERAL is still allowed, and still used",
   /["']satisfied["']/.test(naf),
   "nextActionFor stopped comparing state to a four-state literal — G4 may now be " +
   "green because the logic left, not because it moved");
ok("G5  …it switches on read_status and state instead",
   /read_status/.test(naf) && /proof\.state/.test(naf), naf.trim().slice(0, 200));

/*  ── THE CLEANUP RELEASE HAS RUN ──────────────────────────────────
 *  G6 used to assert the compatibility field was STILL PUBLISHED, and
 *  that was correct for as long as consumers depended on it. This
 *  candidate retires it, so the assertion INVERTS: `satisfied` must no
 *  longer be on the wire, and the four-state `state` must still be.
 *
 *  The mapping itself is KEPT and exported. It is the definition
 *  consumers derive from — the app's normalizer applies it to produce
 *  the same boolean from `state` — and deleting it would destroy the
 *  contract rather than retire the field.  */
const psCode = codeOf(path.join(ROOT, "src/release0/proof_state.js"));
ok("G6  the derivation no longer PUTS `satisfied` on the wire",
   !/satisfied:\s*SATISFIED_FOR/.test(psCode),
   "the compatibility field is still being emitted — this candidate has not landed");
ok("G7  …and the list projection does not either",
   !/satisfied:\s*s\.proof\.satisfied/.test(readerCode),
   "the list still emits it");
ok("G8  `state` IS still emitted on both shapes — the field of record",
   /read_status:\s*"ok",\s*state/.test(psCode) && /state:\s*s\.proof\.state/.test(readerCode),
   "the four-state contract itself was removed, not just its compatibility field");
ok("G9  the frozen mapping is KEPT and exported — it is the definition",
   /SATISFIED_FOR/.test(psCode) && /SATISFIED_FOR,/.test(psCode),
   "deleting the mapping destroys the contract rather than retiring the field");

console.log(`\n  passed ${pass}   failed ${fail}`);
console.log(fail === 0
  ? "\n  ✓ PASS — `satisfied` is retired from the wire; `state` is the field of record.\n"
  : "\n  ✗ FAIL — see above.\n");
process.exit(fail === 0 ? 0 : 1);
