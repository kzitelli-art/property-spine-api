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
    role: "RETIRED — UNREACHABLE DEAD CODE",
    why: "the app closeout route's done-path. It wrote status='closed' with NO proof " +
         "evaluation, and its photo column holds a stub:// string with no bytes, so it " +
         "could never be converted into proof (§4.1). STEP 6 retired it: the route now " +
         "returns 409 before pool.connect(), so no transaction is opened and no row is " +
         "locked. The statement below the guard is unreachable, and D1/D2 assert that " +
         "the guard is still in front of it",
    until: "Step 9's separate cleanup release deletes the dead branch. It is left in " +
           "place until then deliberately — unreachable code is recoverable, deleted " +
           "code is not, and Release 0 keeps the option until the replacement rail is " +
           "PROVEN in production, not merely deployed (§5.5). The route itself survives " +
           "permanently — closeoutNotDone shares it and is not a completion" },
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
/*  ── THE NAME `claimCompletion` IS NOT UNIQUE IN THIS CODEBASE ───────
 *
 *  maintenance/work_acceptance_service.js exports a function with the
 *  SAME NAME, reached from the staff agent and the work-acceptance route.
 *  It is a different domain entirely — unit-turn work items — and it
 *  never touches `work_orders`: it writes work_completion_claims,
 *  obligations, events and unit_triage_required_work.
 *
 *  It is therefore NOT a third work-order completion writer. But the
 *  collision is a real hazard: "the canonical completion writer is
 *  claimCompletion" is ambiguous prose, and a future caller could import
 *  the wrong one and satisfy a code review by name alone.
 *
 *  This asserts the distinction rather than trusting it: if the unit-turn
 *  function ever starts writing work_orders, S2 above fails; if the
 *  canonical one gains an unexpected caller, C2 below fails. */
const CANONICAL_CALLERS = ["src/technician/conversation.js"];
const UNIT_TURN_OWNER = "src/maintenance/work_acceptance_service.js";

{
  const unitTurn = fs.readFileSync(path.join(ROOT, UNIT_TURN_OWNER), "utf8");
  ok("C1  the same-named unit-turn claimCompletion never writes work_orders",
     !/update\s+work_orders/i.test(unitTurn),
     "it now writes work_orders — that IS a third completion writer. STOP.");

  //  Callers of the CANONICAL one, found by the module they import from.
  const callers = [];
  for (const file of walk(SRC)) {
    const text = fs.readFileSync(file, "utf8");
    const rel = path.relative(ROOT, file);
    if (rel === "src/technician/lifecycle_service.js") continue;
    if (!/claimCompletion\s*\(/.test(text)) continue;
    //  Distinguish by what the file imports, not by the bare verb.
    const usesLifecycle = /require\(["'][^"']*lifecycle_service["']?[^"']*\)/.test(text)
                       || /lifecycle\.claimCompletion/.test(text);
    if (usesLifecycle) callers.push(rel);
  }
  const unexpected = callers.filter((c) => !CANONICAL_CALLERS.includes(c));
  ok("C2  the canonical claimCompletion has exactly the expected callers",
     unexpected.length === 0 && callers.length === CANONICAL_CALLERS.length,
     "found: " + JSON.stringify(callers) + " expected: " + JSON.stringify(CANONICAL_CALLERS) +
     "\n        → a new caller must also persist the action receipt (fact 7), which the " +
     "\n          SERVICE does not enforce — conversation.js writes it, not claimCompletion.");
  console.log("        canonical callers: " + JSON.stringify(callers));
}

/*  ── STEP 6 — THE RETIRED PATH MUST STAY RETIRED ────────────────────
 *
 *  `legacy.role` above is prose. Prose does not stop a writer. The dead
 *  `update work_orders set status='closed'` is still in the file by
 *  design (Step 9 deletes it), so the ONLY thing standing between it and
 *  production is the guard — and a guard that a refactor could quietly
 *  move below `pool.connect()` would still read as present while a
 *  transaction opened in front of it.
 *
 *  So POSITION is asserted, not just presence. */
{
  //  Scoped to THIS route. The first version searched the whole file and
  //  compared the guard against some other route's pool.connect(), which
  //  made a correctly-placed guard look misplaced. Same defect as an
  //  information_schema walk that answered a question nobody asked: the
  //  search has to be over the region the claim is about.
  const routeAt = legacy.search(/router\.patch\(["']\/work-orders\/:id\/closeout["']/);
  const region = routeAt > -1 ? legacy.slice(routeAt) : "";
  ok("D0  the closeout route is still findable by the gate", routeAt > -1,
     "the route was renamed or moved — every assertion below is vacuous until this " +
     "is fixed, so it is checked first rather than reported as four passes");

  const doneGuard = /if \(done !== false\) \{[\s\S]{0,900}?legacy_completion_retired/;
  ok("D1  the legacy done-path refuses with legacy_completion_retired",
     doneGuard.test(region),
     "the retired done-path can write a terminal status again. STOP.");

  const guardAt = region.search(/if \(done !== false\) \{/);
  const connectAt = region.search(/const client = await pool\.connect\(\)/);
  ok("D2  …and it refuses BEFORE any connection is opened",
     guardAt > -1 && connectAt > -1 && guardAt < connectAt,
     "the guard sits after pool.connect(), so 'writes nothing' is a claim about " +
     "ordering rather than a property of the path. Move it back in front.");

  //  The paired control. A 409 from a route that no longer works at all
  //  proves nothing; the not-done path is what makes the refusal legible
  //  as a governed refusal of ONE verb.
  ok("D3  the NOT-done path is untouched and still writes its follow-up",
     /if \(done === false\) \{/.test(region) &&
     /status='needs_followup'/.test(region) &&
     /spawnObligationFromEvent\(/.test(region),
     "closeoutNotDone is not a completion and must keep working — without it the " +
     "409 is indistinguishable from a dead route");
}

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
