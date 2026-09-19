// ════════════════════════════════════════════════════════════════════
//  rent_roll_source_reconciliation.js — DID WE READ THE FILE CORRECTLY?
//
//  PURE. No database, no I/O, no clock.
//
//  ── TWO RECONCILIATIONS, AND THEY ARE NOT THE SAME QUESTION ─────────
//
//    1. SOURCE EXTRACTION   did Spine reproduce what this file says?
//    2. CANONICAL POSITION  do the file's claims attach correctly to the
//                           property's established positions?
//
//  This module is ONLY (1). It is a parser checksum and nothing more.
//
//  A file passes (1) and fails (2) routinely, and that is correct: a
//  perfect parser faithfully extracts a stale claim. Greenery's August
//  rent roll shows unit 107 Room2 occupied with lease dates that ended in
//  2024 — reproducing that exactly is the parser doing its job, and the
//  canonical dated read is what exposes the contradiction afterwards.
//
//  ── WHY THE FOOTER IS NOT AN ORACLE ─────────────────────────────────
//  The stated totals come out of the same Yardi report as the detail
//  rows, so agreement proves EXTRACTION FIDELITY, never real-world
//  truth. If Yardi holds a stale lease, the row and the footer agree
//  perfectly and both are wrong about today's tenancy.
//
//  What the footer IS: the only independent check on our own parsing that
//  ships inside the file. A layout we read wrongly essentially never
//  lands on the source's own totals by accident. Concretely, it catches
//  subtotal rows read as residents, a skipped section, duplicated rows, a
//  mis-mapped column, and a future Yardi layout change — and it catches
//  them BEFORE an opening position is established, which is the only
//  moment the catch is cheap.
//
//  It is deliberately more valuable than a patch for two known files.
//
//  ── WHY IT REFUSES RATHER THAN WARNS ────────────────────────────────
//  A parser that derives 104 positions from a document whose own report
//  says 105 has not represented the source. Every individual row looking
//  parseable is not evidence that the set is complete — that is exactly
//  the "green is a claim about what was measured" trap. Nothing is
//  established on a mismatch, and the refusal names the number.
//
//  ── CENTS, NOT FLOATS ───────────────────────────────────────────────
//  113500.00 summed across 105 IEEE-754 doubles is not reliably
//  113500.00. Money compares as integers here or the checksum invents
//  its own mismatches.
// ════════════════════════════════════════════════════════════════════

"use strict";

//  Every field a rent-roll footer is observed to state. A field absent
//  from the footer is simply not checked — absence is no check, never a
//  failed one.
const CHECKED_FIELDS = Object.freeze([
  "market_rent", "actual_rent", "deposit", "other", "balance", "sqft",
]);

const READABLE = Object.freeze({
  bed_count: "bed count",
  market_rent: "market rent",
  actual_rent: "actual rent",
  deposit: "resident deposits",
  other: "other deposits",
  balance: "resident balances",
  sqft: "square footage",
});

const TOTALS_MISMATCH = "source_totals_mismatch";

//  Round half away from zero at the cent, matching how the source prints.
function cents(value) {
  if (value == null || value === "") return 0;
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100);
}

function money(c) {
  const sign = c < 0 ? "-" : "";
  const abs = Math.abs(c);
  return `${sign}$${(abs / 100).toLocaleString("en-US", {
    minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/*  mapped    canonical rows out of mapRows(), BOTH sections — a Yardi
 *            "Total:" footer covers current and future together.
 *  declared  parsed.source_declared_totals, or null.
 *
 *  Returns { checked, checks[], mismatches[], row_count }. `checked:false`
 *  means the layout stated no totals, which is not a failure. */
function reconcileToSourceTotals({ mapped = [], declared = null } = {}) {
  const rows = Array.isArray(mapped) ? mapped : [];
  if (!declared || typeof declared !== "object") {
    return { checked: false, checks: [], mismatches: [], row_count: rows.length };
  }

  const checks = [];

  //  POSITION COUNT FIRST — the check a person reads without converting
  //  anything. "The report states 105 beds; Spine read 104." Compared
  //  against the CURRENT section only: a footer bed count is the
  //  building's inventory, and future applicants hold no bed yet.
  const currentRows = rows.filter((r) => (r && r.section) !== "future");
  if (declared.bed_count != null && Number.isFinite(Number(declared.bed_count))) {
    const declaredBeds = Number(declared.bed_count);
    checks.push({
      field: "bed_count",
      declared: declaredBeds,
      parsed: currentRows.length,
      delta: currentRows.length - declaredBeds,
      agrees: currentRows.length === declaredBeds,
    });
  }

  for (const field of CHECKED_FIELDS) {
    if (!(field in declared) || declared[field] == null) continue;
    const declaredCents = cents(declared[field]);
    const parsedCents = rows.reduce((sum, r) => sum + cents(r && r[field]), 0);
    checks.push({
      field,
      declared: declaredCents / 100,
      parsed: parsedCents / 100,
      delta: (parsedCents - declaredCents) / 100,
      agrees: parsedCents === declaredCents,
    });
  }

  return {
    checked: checks.length > 0,
    checks,
    mismatches: checks.filter((c) => !c.agrees),
    row_count: rows.length,
  };
}

/*  One sentence a person can act on. Names the field, both numbers, and
 *  that nothing was established — a refusal without a next step is a
 *  dead end (PHILOSOPHY §5). */
function describeTotalsMismatch(result) {
  const worst = (result && result.mismatches) || [];
  if (!worst.length) return null;
  const parts = worst.map((c) => (c.field === "bed_count"
    ? `bed count: the report states ${c.declared} but Spine read ${c.parsed}`
    : `${READABLE[c.field] || c.field}: the report states ${money(cents(c.declared))} ` +
      `but the ${result.row_count} rows Spine read total ${money(cents(c.parsed))}`));
  return `${parts.join("; ")}. Nothing was established — review how this ` +
    `rent-roll layout was interpreted before continuing.`;
}

module.exports = {
  CHECKED_FIELDS,
  TOTALS_MISMATCH,
  reconcileToSourceTotals,
  describeTotalsMismatch,
};
