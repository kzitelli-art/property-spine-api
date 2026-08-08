#!/usr/bin/env node
/* ════════════════════════════════════════════════════════════════════
   gate_completion_guard_terminal_set.js — ONE TERMINAL SET, NOT THREE.

   Three things now decide what "terminal" means:

     release0/proof_state.js      the READER  — is this a defect?
     maintenance/proof_defect_sweep.js  the SWEEP — raise an obligation?
     migrations/140_...sql        the GUARD   — refuse the write?

   §3.2.0 already required the first two to agree, "so neither can
   consider a row a defect that the other treats as not-yet-due". Adding
   a database guard makes the same requirement sharper, and inverts the
   consequence of drift:

     guard NARROWER than reader   a status the reader calls terminal can
                                  still be written → the guard has a hole
                                  and the sweep raises the obligation
     guard WIDER than reader      a legitimate write is refused for a
                                  status nothing considers a completion

   Neither is discoverable at runtime — the first shows up as an
   obligation against a named role, the second as an outage. So it is
   checked here, in source, on the standard path.

   DB-free. It compares the executable SQL to the exported constant.
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const MIGRATION = path.join(ROOT, "migrations/140_post_activation_completion_guard.sql");
const SWEEP = path.join(ROOT, "src/maintenance/proof_defect_sweep.js");

let pass = 0, fail = 0;
const ok = (l, c, d) => { if (c) { pass++; console.log("  ok    " + l); }
  else { fail++; console.log("  FAIL  " + l + (d ? "\n          → " + d : "")); } return c; };

console.log("\n══════════════════════════════════════════════════════════════════");
console.log("  THE GUARD, THE READER AND THE SWEEP AGREE ON `TERMINAL`");
console.log("══════════════════════════════════════════════════════════════════\n");

//  Comments stripped: all three files DISCUSS the terminal set on purpose,
//  and a gate that reads an explanation of the rule as the rule itself is
//  the vacuity trap this release has hit twice.
const codeOf = (p) => fs.readFileSync(p, "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*(--|\/\/).*$/gm, " ");

const { TERMINAL_STATUSES } = require("../src/release0/proof_state.js");
const reader = [...TERMINAL_STATUSES].sort();

ok("G0  the reader still exports a terminal set", reader.length >= 1, JSON.stringify(reader));

//  Pull the literal set out of the migration's executable SQL rather than
//  asserting a hardcoded pair — a gate that restates the answer cannot
//  detect the answer changing.
const sql = codeOf(MIGRATION);
const guardSets = [...sql.matchAll(/status\s+(?:not\s+)?in\s*\(([^)]*)\)/gi)]
  .map((m) => m[1].split(",").map((x) => x.trim().replace(/^'|'$/g, "")).sort());

ok("G1  the guard's SQL declares a terminal set at all", guardSets.length >= 1,
   "no `status in (...)` found in the executable SQL — the trigger may have been " +
   "rewritten, and G2 would then be comparing nothing");

const disagreeing = guardSets.filter((s) => JSON.stringify(s) !== JSON.stringify(reader));
ok("G2  every terminal set in the guard equals the reader's",
   disagreeing.length === 0,
   "reader " + JSON.stringify(reader) + " vs guard " + JSON.stringify(disagreeing) +
   " — a guard NARROWER than the reader has a hole the sweep will bill to a human; " +
   "a guard WIDER than the reader refuses legitimate writes");

const sweep = codeOf(SWEEP);
const sweepSets = [...sweep.matchAll(/status\s+in\s*\(([^)]*)\)/gi)]
  .map((m) => m[1].split(",").map((x) => x.trim().replace(/^'|'$/g, "")).sort());
ok("G3  the sweep's prefilter declares one too", sweepSets.length >= 1, "none found");
ok("G4  …and it equals the reader's as well",
   sweepSets.every((s) => JSON.stringify(s) === JSON.stringify(reader)),
   "reader " + JSON.stringify(reader) + " vs sweep " + JSON.stringify(sweepSets));

//  The guard must stay INERT before activation, or it breaks the census
//  that the whole cutover depends on.
ok("G5  the guard is still gated on an activation existing",
   /release_0_activation_current/.test(sql),
   "the trigger no longer checks for an activation — it would now block the " +
   "pre-cutover terminal rows the census exists to inventory");
ok("G6  …and still exempts the cutover inventory",
   /release_0_legacy_cutover_inventory/.test(sql),
   "legitimate legacy history would be refused on any later update");
ok("G7  …and still admits a governed completion via the evaluation head",
   /work_order_proof_evaluation_head/.test(sql),
   "the canonical writer itself would be refused");

//  NO BYPASS. A session flag a utility script can set is not a guarantee.
ok("G8  the guard has no session-variable escape hatch",
   !/current_setting\s*\(/i.test(sql),
   "a bypass a caller can set turns the guarantee into a comment");

/*  ── THE DEFERRED PROPERTIES ────────────────────────────────────────
 *  The guard judges the COMMITTED state, not each statement. Two things
 *  make that true, and both are easy to lose in an edit that looks
 *  harmless. */
ok("G9  it is a DEFERRABLE INITIALLY DEFERRED constraint trigger",
   /create\s+constraint\s+trigger/i.test(sql) &&
   /deferrable\s+initially\s+deferred/i.test(sql),
   "made immediate, it would judge each statement — and would then refuse a " +
   "transaction that writes the status before the evaluation, coupling a database " +
   "invariant to the canonical writer's statement order");

/*  The predicate takes a work-order id and RE-READS current state. The
 *  trigger wrappers pass `new.id` / `new.work_order_id` — identity only.
 *  What must never appear is a decision taken on `new.status`: NEW is the
 *  queued snapshot, and by commit time the row may have moved again.
 *  Judging it would judge an intermediate state, which is exactly what
 *  deferring exists to avoid. */
ok("G10 the predicate RE-READS the row rather than judging `NEW`",
   /from\s+public\.work_orders\s+where\s+id\s*=\s*p_work_order/i.test(sql),
   "the predicate no longer re-reads current status");
ok("G10a …and no decision is taken on `new.status` anywhere in the function bodies",
   !/if[^;]{0,80}new\.status/i.test(sql),
   "a branch on new.status judges the queued snapshot, not the committed state");

/*  ⚠ G11 ASSERTED THE OPPOSITE and was WRONG. It required the guard to
 *  accept ANY head, reasoning that a `not_satisfied` evaluation is "a
 *  judgement that was made". True, and beside the point: Release 0
 *  governs COMPLETION, not whether somebody made a judgement. A1 in
 *  falsify_containment.js showed the reader then reports a completed work
 *  order as `not_satisfied` — a completion nothing can stand behind,
 *  reached without ever touching missing_evaluation_defect. */
ok("G11 a terminal work order requires a SATISFIED head, not merely a head",
   /'satisfied'/.test(sql),
   "the guard accepts any evaluation, so terminal + not_satisfied commits");

/*  A2 — the invariant is CROSS-TABLE. A work_orders trigger cannot see an
 *  evaluation appended later that flips the head out from under a
 *  completed row. */
ok("G12 …and it is also enforced from work_order_proof_evaluations",
   /on\s+public\.work_order_proof_evaluations/i.test(sql),
   "only work_orders is guarded, so the proof head can be changed after the " +
   "completion has already passed the check");

/*  A3 — the immutable inventory must not become a reusable licence. */
ok("G13 …and inventoried legacy may not leave the terminal state",
   /R0002/.test(sql),
   "an inventoried row can be reopened and re-closed, laundering a NEW completion " +
   "into `legacy_indeterminate` with no evaluation");

/*  ── G14 · EVERY ACTIVATING HARNESS CARRIES THE GUARD ────────────────
 *
 *  `recordActivation` refuses without the guard (GUARD_ABSENT), so every
 *  proof and falsification harness that activates has to install it. When
 *  that precondition landed, ELEVEN harnesses needed the change and FOUR
 *  were missed by hand — and the way they failed is the dangerous part:
 *
 *    · a PROOF harness dies with GUARD_ABSENT — loud, obvious
 *    · a FALSIFICATION harness reports its variant as UNCAUGHT, because
 *      the activation was stopped by the guard precondition instead of by
 *      the assertion under test. It looks like a real finding.
 *
 *  The second is the failure this catches. A harness whose refusal comes
 *  from the wrong place proves nothing and says nothing. */
const toolsDir = path.join(ROOT, "tools");
const walk = (d, out = []) => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith(".js")) out.push(p);
  }
  return out;
};
const activating = walk(toolsDir).filter((f) => {
  const src = codeOf(f);
  return /\brecordActivation\s*\(/.test(src) && !/guard_window\.js/.test(f);
});
/*  Two ways to satisfy this, both real: use the shared `guard_window`
 *  helper, or apply migration 140 by name. The guard's OWN proofs do the
 *  latter — they install, drop and reinstall it as the thing under test,
 *  and routing that through a helper would put a layer between the proof
 *  and the artefact it is proving. */
const installsGuard = (src) =>
  /guard_window/.test(src) || /140_post_activation_completion_guard/.test(src);
const missing = activating
  .filter((f) => !installsGuard(fs.readFileSync(f, "utf8")))
  .map((f) => path.relative(ROOT, f));

ok("G14 the scan found the harnesses that activate at all",
   activating.length >= 5, activating.length + " file(s) call recordActivation");
ok("G15 …and every one of them installs the containment guard",
   missing.length === 0,
   missing.join(", ") + "\n          → each of these will now be refused by the " +
   "guard precondition rather than by whatever it is testing. Add " +
   "`guardWindow.installGuard(client)` before the activation, and build any state " +
   "the guard forbids inside `guardWindow.withGuardOff(...)`.");

console.log(`\n  passed ${pass}   failed ${fail}`);
console.log(fail === 0
  ? "\n  ✓ PASS — one terminal set, enforced in three places that cannot drift.\n"
  : "\n  ✗ FAIL — see above.\n");
process.exit(fail === 0 ? 0 : 1);
