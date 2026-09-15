// ════════════════════════════════════════════════════════════════════
//  debt_vocabulary_subject.test.js — widening Debt's vocabulary must not
//  STEAL a sentence from another domain.
//
//  WHAT THIS PROTECTS
//  ------------------
//  DEBT_TERMS held only the literal `loan maturity`, `maturity date` and
//  `principal balance`, so three sentences a lender-facing asset manager
//  types without thinking routed to `work`:
//
//      when does the loan mature          → work
//      when does the debt mature          → work
//      what is the outstanding principal  → work
//
//  The repair is morphology — the inflections of `mature`, and both orders
//  of `principal`. The obvious way to write it is a bare
//  `matur(e|es|ed|ity)`, and that is WRONG: it takes "when does the lease
//  mature", which is tenancy's. So the maturity verb is bound to a debt
//  noun, and this file is the wall that keeps it bound.
//
//  A widening is only correct if the sentences it gains are matched by the
//  sentences it does not gain. Both halves are asserted here; the gained
//  half is also asserted by the reachability detector in
//  tests/gates/gate_ask_spine_readers.js, which calls the same function on
//  debt's declared `reached_by`. This file owns the half that gate cannot
//  see, because a gate that checks reachability cannot check theft.
//
//  CLASS 1 — permanent. It outlives any particular phrasing of DEBT_TERMS.
// ════════════════════════════════════════════════════════════════════
const { questionSubject } = require("../../src/agent/ask_spine_answer.js");

let passed = 0, failed = 0;
const lines = [];
function ok(name, cond, detail) {
  if (cond) { passed++; lines.push(`  ok    ${name}`); }
  else { failed++; lines.push(`  FAIL  ${name}`); if (detail) lines.push(`          ${detail}`); }
}
function subjectIs(question, expected) {
  const actual = String(questionSubject(question));
  ok(`${JSON.stringify(question)} → ${expected}`, actual === expected,
    `produced ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
}

//  ── A. GAINED — the FOUND item, now reaching its own domain ──────────
subjectIs("when does the loan mature", "debt");
subjectIs("when does the debt mature", "debt");
subjectIs("what is the outstanding principal", "debt");
//  Morphology, not a sentence list: these were never enumerated anywhere.
subjectIs("when does the mortgage mature", "debt");
subjectIs("what is the principal outstanding", "debt");
subjectIs("when did the loan matured", "debt");
subjectIs("what is the maturity of the loan", "debt");

//  ── B. UNCHANGED — debt vocabulary that already worked ───────────────
subjectIs("what is our debt service", "debt");
subjectIs("when is the maturity date on our debt", "debt");
subjectIs("what do we owe on the mortgage", "debt");
subjectIs("who is the lender", "debt");
subjectIs("what is the interest rate on the loan", "debt");
subjectIs("is there an extension option", "debt");

//  ── C. NOT STOLEN — the controls. THIS IS THE POINT OF THE FILE. ─────
//  A bare maturity verb would take this one. It is tenancy's: a lease
//  maturing is an occupancy fact, and answering it from the Debt reader
//  would be a confident wrong answer about the wrong instrument.
subjectIs("when does the lease mature", "tenancy");
subjectIs("what work is outstanding", "work");
subjectIs("which work orders are open", "work");
subjectIs("what is the rent roll", "tenancy");
subjectIs("how many beds are open", "tenancy");
subjectIs("are our licenses current", "compliance");
subjectIs("what is the water bill", "utility");
subjectIs("who holds common equity", "equity");

//  ── D. THE COMPOSITION GUARD SURVIVES THE WIDENING ───────────────────
//  §40.8: two domains in one sentence is not an answer Spine may compose.
//  A wider debt vocabulary must not let debt WIN such a sentence; it must
//  still be seen beside the other domain and refused.
subjectIs("how many beds are open, and when does the loan mature",
  "composition_unavailable");

const bar = "─".repeat(66);
console.log(`\n${bar}\nDEBT VOCABULARY — WIDENED BY MORPHOLOGY, WITHOUT THEFT\n${bar}`);
console.log(lines.join("\n"));
console.log(`\n${bar}`);
console.log(`${passed}/${passed + failed} passed` + (failed ? `  —  ${failed} failure(s)` : ""));
console.log(failed
  ? "Fix the failures above."
  : "Debt gained the sentences it owns. It took none that it does not.");
console.log(`${bar}\n`);
process.exitCode = failed ? 1 : 0;
