#!/usr/bin/env node
/* ════════════════════════════════════════════════════════════════════
   GATE — EXACTLY THE EXPECTED WORK-ORDER COMPLETION WRITERS

   Release 0 turns completion into one governed transaction. That is only
   true if nothing else can put a work order into a terminal state.

     AUTHORIZED FUTURE WRITER   claimCompletion
     TEMPORARILY LEGACY         the app closeout route
     UNAUTHORIZED               anything else

   A THIRD writer is a stop condition, not a finding to note and move
   past: it would mean a work order can reach `complete` or `closed`
   without an evaluation, without a completed progress event, and without
   an attributable actor — which is the exact state this release exists
   to make impossible.

   ── WHY THE SCAN IS ABOUT TERMINAL STATUS, NOT ABOUT NAMES ──────────
   Writers do not announce themselves. This looks for any statement that
   updates `work_orders` and sets `status`, then asks whether the value
   can be terminal. A site that only ever writes `needs_followup`,
   `open`, `scheduled` or urgency fields is not a completion writer and
   is not registered as one.

   ── PARAMETERISED STATUS IS TREATED AS DANGEROUS UNTIL PROVEN ───────
   `set status = $1` could write anything. Such a site must demonstrate,
   in its own source, that it refuses terminal values — the tenant-line
   note route does exactly that ("Completion has its own gate"). A
   parameterised writer with no such refusal is UNAUTHORIZED.

   run:  node tests/gate_completion_writers.js
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const SRC = path.join(ROOT, "src");

/*  The register. Every entry carries WHY it may write a terminal status
 *  and, for anything temporary, exactly what removes it. */
const AUTHORIZED = [
  { file: "src/technician/lifecycle_service.js",
    role: "AUTHORIZED FUTURE WRITER",
    why: "claimCompletion — the one canonical completion transaction: claim, proof " +
         "evaluation, evaluation→attachment links, status, completed progress event, " +
         "obligation closure, receipt and actor attribution, all in one transaction",
    until: "never — this is the intended end state" },
  { file: "src/maintenance/maintenance.js",
    role: "TEMPORARILY LEGACY",
    why: "the app closeout route: status='closed' with completion_photo/completion_note. " +
         "It writes NO proof evaluation and its photo column holds a stub:// string with " +
         "no bytes, so it can never be converted into proof (§4.1)",
    until: "Step 6 retires the done-path of this route. The route itself survives — " +
           "closeoutNotDone shares it and is not a completion" },
];

const TERMINAL = ["complete", "closed"];

let pass = 0, fail = 0;
const ok = (l, c, d) => { if (c) { pass++; console.log("  ok    " + l); }
  else { fail++; console.log("  FAIL  " + l + (d ? "\n        " + d : "")); } return c; };

console.log("════════════════════════════════════════════════════════════════");
console.log("  GATE  gate_completion_writers.js");
console.log("  checks: exactly the expected work-order completion writers");
console.log("════════════════════════════════════════════════════════════════");
console.log("  ASSERTIONS STARTED\n");

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === ".git") continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith(".js")) out.push(p);
  }
  return out;
}

//  Every `update work_orders … set …` statement, with the text that
//  follows it up to the closing backtick — enough to see what it sets.
const STMT = /update\s+work_orders\b[\s\S]{0,400}?`/gi;

const found = [];
for (const file of walk(SRC)) {
  const text = fs.readFileSync(file, "utf8");
  const rel = path.relative(ROOT, file);
  for (const m of text.matchAll(STMT)) {
    const stmt = m[0];
    if (!/\bstatus\s*=/i.test(stmt)) continue;          // not a status writer at all
    const line = text.slice(0, m.index).split("\n").length;

    const literals = [...stmt.matchAll(/status\s*=\s*'([a-z_]+)'/gi)].map((x) => x[1].toLowerCase());
    const parameterised = /status\s*=\s*\$\d/i.test(stmt);
    const writesTerminal = literals.some((v) => TERMINAL.includes(v));

    if (!writesTerminal && !parameterised) continue;    // only non-terminal literals
    found.push({ rel, line, literals, parameterised, stmt });
  }
}

ok("S1  the scan found work-order status writers at all", found.length > 0,
   "zero found — the scan is broken and would pass anything");
console.log("        " + found.length + " site(s) that write a terminal or parameterised status\n");

const unauthorized = [];
for (const f of found) {
  const entry = AUTHORIZED.find((a) => a.file === f.rel);

  if (f.parameterised && !f.literals.some((v) => TERMINAL.includes(v))) {
    //  A parameterised writer is acceptable ONLY if its own file refuses
    //  terminal values. Proven by reading that file, not by assuming.
    const src = fs.readFileSync(path.join(ROOT, f.rel), "utf8");
    const refuses = /status\s*===\s*["']complete["']/.test(src)
                 && /\[\s*["']open["']\s*,\s*["']scheduled["']\s*\]/.test(src);
    if (refuses) {
      console.log("  ok    " + f.rel + ":" + f.line +
                  "  parameterised, but the route refuses terminal values");
      pass++;
      continue;
    }
    unauthorized.push(f.rel + ":" + f.line + "  parameterised status with no terminal refusal");
    continue;
  }

  if (!entry) { unauthorized.push(f.rel + ":" + f.line + "  writes " + JSON.stringify(f.literals)); continue; }
  console.log("  ok    " + f.rel + ":" + f.line + "  " + entry.role + "  " + JSON.stringify(f.literals));
  pass++;
}

ok("S2  NO unauthorized completion writer exists",
   unauthorized.length === 0,
   unauthorized.join("\n        ") +
   "\n        → a third writer means a work order can reach a terminal state with no " +
   "\n          proof evaluation and no attributable actor. STOP.");

//  The register cannot rot: an entry naming a file that no longer writes
//  a terminal status is stale and must be removed rather than left as
//  decoration implying a control that is not there.
const stale = AUTHORIZED.filter((a) => !found.some((f) => f.rel === a.file));
ok("S3  the writer register is still accurate", stale.length === 0,
   stale.map((s) => "no longer a terminal-status writer: " + s.file).join("\n        "));

//  The canonical writer must actually be canonical: it is the only one
//  that writes a proof evaluation.
const lifecycle = fs.readFileSync(path.join(ROOT, "src/technician/lifecycle_service.js"), "utf8");
ok("S4  the authorized writer records a proof evaluation",
   /recordEvaluation\(/.test(lifecycle),
   "claimCompletion must write the evaluation, or completion is unproven");
const legacy = fs.readFileSync(path.join(ROOT, "src/maintenance/maintenance.js"), "utf8");
ok("S5  the legacy writer records NO proof evaluation (it is not canonical)",
   !/recordEvaluation\(/.test(legacy));
ok("S6  no module outside the evaluation service inserts evaluations directly",
   walk(SRC).filter((p) => !p.endsWith("proof_evaluation_service.js"))
     .every((p) => !/insert\s+into\s+work_order_proof_evaluations/i.test(fs.readFileSync(p, "utf8"))),
   "the chain contract must have exactly one writer");

console.log("\n  ── REGISTER ──");
for (const a of AUTHORIZED) {
  console.log("    " + a.role + "  " + a.file);
  console.log("      why:   " + a.why);
  console.log("      until: " + a.until);
}

console.log("\n════════════════════════════════════════════════════════════════");
console.log(`  ASSERTIONS COMPLETE · ${pass + fail} run · ${pass} passed · ${fail} failed`);
console.log("  " + (fail === 0 ? "✓ PASS" : "✗ FAIL") + " — gate_completion_writers.js");
console.log("  EXIT      " + (fail === 0 ? 0 : 1));
console.log("════════════════════════════════════════════════════════════════\n");
process.exit(fail === 0 ? 0 : 1);
