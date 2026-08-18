/* ══════════════════════════════════════════════════════════════════════════
   dated_conflict_scope.test.js — A CONFLICT IS A CONFLICT *ON A DATE*.

   Production found this one. The Rent Roll reported beds as Needs Review /
   OVERLAPPING_OPERATIVE_LEASES while the canonical writer's own overlap
   wall saw exactly ONE operative lease on the same bed and the same date.

   The reader's conflict loop ran over every non-retired lease on the bed
   and asked whether any two overlapped EACH OTHER. `asOf` never entered
   the computation. Every other axis was date-scoped — `current` and
   `activationPending` use datesSpan, `future` uses isFuture — so two
   leases that overlapped in April made the bed read contested in August,
   long after the earlier one had ended.

       CURRENT CONFLICT @ D
         = >= 2 DISTINCT operative leases
           that BOTH span D
           on the same canonical bed

   Historical overlap stays historical truth. It is not erased: read at a
   date both leases span, the conflict is still reported. The rule is
   date-scoped, not amnesiac — and this file asserts BOTH halves, because
   a fix that simply stopped reporting conflicts would pass a one-sided
   test and lose a real double-booking.

   Pure classifier assertions. No database: the defect is in a decision,
   not in a query, and a DB fixture would only make it slower to falsify.

   Run:  node tests/dated_conflict_scope.test.js
   ══════════════════════════════════════════════════════════════════════════ */
"use strict";
const { classifyPosition } = require("../src/tenancy/position_classifier");

let pass = 0, fail = 0; const failures = [];
const ok = (c, m, d) => {
  if (c) { pass++; console.log("   PASS  " + m); }
  else { fail++; failures.push(m); console.log("   FAIL  " + m + (d ? "\n         " + d : "")); }
};

const lease = (id, start, end, over) => Object.assign({
  id, lease_status: "active", start_date: start, end_date: end,
  rent: 900, tenant_ids: [], source_type: "opening_import", confidence: "confirmed",
  executed_verified: false, move_in_funds_cleared: false,
}, over || {});

const bed = (leases) => ({
  space_id: "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa",
  unit_id: "u1", unit_number: "1417-105", space_label: "Room1",
  leases, unit_events: [], opening_space_claim: null,
});

const read = (leases, asOf) =>
  classifyPosition(bed(leases), { asOf, personNames: new Map() });

console.log("\n" + "═".repeat(72));
console.log("  DATED CONFLICT SCOPE — a conflict is a conflict ON A DATE");
console.log("═".repeat(72) + "\n");

/*  THE EXACT CASE THE RULING NAMES.
 *      A  Apr 1 – Jun 30
 *      B  May 1 – Jul 31
 *  They genuinely overlap, in May and June. */
const A = lease("11111111-1111-4111-8111-111111111111", "2026-04-01", "2026-06-30");
const B = lease("22222222-2222-4222-8222-222222222222", "2026-05-01", "2026-07-31");

console.log("  ── 1 · read INSIDE the overlap ──");
{
  const p = read([A, B], "2026-05-15");
  ok(p.conflict_state === "conflicted",
    "May 15: both leases span the date — the bed IS contested", p.conflict_state);
  ok(new Set(p.conflicting_lease_ids).size === 2,
    "…and both sides are named", JSON.stringify(p.conflicting_lease_ids));
}

console.log("\n  ── 2 · read AFTER the earlier lease ended ──");
{
  const p = read([A, B], "2026-07-15");
  ok(p.conflict_state === "clear",
    "Jul 15: Lease A ended Jun 30 — it cannot contest this date", p.conflict_state);
  ok((p.conflicting_lease_ids || []).length === 0,
    "…and no conflicting id is reported", JSON.stringify(p.conflicting_lease_ids));
  //  The historical lease is not erased — it is simply not a CURRENT contest.
  ok(p.current_lease_position && p.current_lease_position.lease_id === B.id,
    "…and B governs the date, read normally", JSON.stringify(p.current_lease_position));
}

console.log("\n  ── 3 · history is not erased, only dated ──");
{
  const early = read([A, B], "2026-04-15");
  ok(early.conflict_state === "clear",
    "Apr 15: only A spans — one lease is not a contest", early.conflict_state);
  const mid = read([A, B], "2026-06-01");
  ok(mid.conflict_state === "conflicted",
    "Jun 1: still inside the overlap — still contested", mid.conflict_state);
  //  Read the SAME data at three dates and get three honest answers.
  ok(early.conflict_state === "clear" && mid.conflict_state === "conflicted"
     && read([A, B], "2026-07-15").conflict_state === "clear",
    "the same two leases read clear / contested / clear across three dates");
}

console.log("\n  ── 4 · a genuine current double-booking still lands ──");
{
  const C = lease("33333333-3333-4333-8333-333333333333", "2026-05-01", "2027-07-26");
  const D = lease("44444444-4444-4444-8444-444444444444", "2026-06-01", "2027-06-30");
  const p = read([C, D], "2026-08-17");
  ok(p.conflict_state === "conflicted",
    "two operative leases both spanning Aug 17 — contested", p.conflict_state);
  ok(new Set(p.conflicting_lease_ids).size === 2,
    "…with two distinct lease ids", JSON.stringify(p.conflicting_lease_ids));
  //  A 'pending' lease is operative for double-booking purposes — the same
  //  ruling operative_overlap carries. Two uncommenced commitments on one
  //  bed is already a double-booking.
  const E = lease("55555555-5555-4555-8555-555555555555", "2026-06-01", "2027-06-30",
    { lease_status: "pending" });
  const q = read([C, E], "2026-08-17");
  ok(q.conflict_state === "conflicted",
    "an active and a pending lease both spanning the date are still a contest",
    q.conflict_state);
}

console.log("\n  ── 5 · a retired lease never contests anything ──");
{
  const C = lease("33333333-3333-4333-8333-333333333333", "2026-05-01", "2027-07-26");
  for (const status of ["cancelled", "terminated", "rescinded", "void", "expired", "superseded"]) {
    const dead = lease("66666666-6666-4666-8666-666666666666", "2026-06-01", "2027-06-30",
      { lease_status: status });
    ok(read([C, dead], "2026-08-17").conflict_state === "clear",
      `a ${status} lease spanning the date is not a contest`);
  }
}

console.log("\n  ── 6 · a lease can never conflict with itself ──");
{
  /*  The loader aggregates leases through a LEFT JOIN to
   *  executed_lease_records, whose lease_id index is NOT unique — two
   *  verified evidence rows for one lease emit that lease twice. Two array
   *  slots holding the same lease trivially "overlap", and `new Set` then
   *  collapsed the pair to a single id, so the position read contested
   *  with ONE conflicting lease. Defense in depth: malformed input must
   *  not become a tenancy claim. */
  const C = lease("33333333-3333-4333-8333-333333333333", "2026-05-01", "2027-07-26");
  const p = read([C, { ...C }], "2026-08-17");
  ok(p.conflict_state === "clear",
    "the same lease twice is not a contest", 
    `${p.conflict_state} ${JSON.stringify(p.conflicting_lease_ids)}`);
  ok((p.conflicting_lease_ids || []).length === 0,
    "…and reports no conflicting id at all", JSON.stringify(p.conflicting_lease_ids));
  ok(p.current_lease_position && p.current_lease_position.lease_id === C.id,
    "…and the lease still governs the date normally");
  //  Three copies, and one of them duplicated alongside a REAL second lease:
  //  the real contest must still be found.
  const D = lease("44444444-4444-4444-8444-444444444444", "2026-06-01", "2027-06-30");
  const r = read([C, { ...C }, D], "2026-08-17");
  ok(r.conflict_state === "conflicted" && new Set(r.conflicting_lease_ids).size === 2,
    "a duplicated lease beside a genuine second one still reports exactly two sides",
    JSON.stringify(r.conflicting_lease_ids));
}

console.log("\n  ── 7 · one distinct id is never reported as a contest ──");
{
  //  The invariant that makes the upstream bug visible instead of silent.
  const C = lease("33333333-3333-4333-8333-333333333333", "2026-05-01", "2027-07-26");
  for (const leases of [[C], [C, { ...C }], [C, { ...C }, { ...C }]]) {
    const p = read(leases, "2026-08-17");
    ok(new Set(p.conflicting_lease_ids || []).size !== 1,
      `${leases.length} array entr${leases.length === 1 ? "y" : "ies"} for one lease never yields a single-sided contest`,
      JSON.stringify(p.conflicting_lease_ids));
  }
}

console.log("\n" + "═".repeat(72));
if (fail) {
  console.log(`  ✗ FAIL — ${pass} passed, ${fail} failed`);
  failures.forEach((f) => console.log("      · " + f));
  console.log("═".repeat(72) + "\n");
  process.exit(1);
}
console.log(`  ✓ PASS — ${pass} passed, 0 failed`);
console.log("═".repeat(72) + "\n");
