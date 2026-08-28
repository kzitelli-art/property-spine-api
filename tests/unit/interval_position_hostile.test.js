#!/usr/bin/env node
/* ══════════════════════════════════════════════════════════════════════════
   interval_position_hostile.test.js — THE SLICE 2 PRIMITIVE, ADVERSARIALLY

       Does this rentable position carry a governed dated right that
       conflicts with the requested interval?

   That is the ONLY question classifyPositionForInterval answers. It does
   not decide whether the position is ready to show, physically ready,
   down, marketable, priced, or something to offer a prospect. Those are
   operating availability and they compose ABOVE this read.

   ── WHY IT IS TESTABLE WITH NO DATABASE ─────────────────────────────────
   Because the primitive is PURE, and it is pure because the interval
   question turned out to need no new predicate: rangesOverlap already
   detects two leases colliding, and this is that test with one side being
   a requested span. Every case below is a hand-built lease set, so the
   whole edge-case surface costs milliseconds and runs in the standard
   suite rather than behind a Postgres.

   The DB rung (interval_positions.db.js) proves the same states against
   160 real beds. This proves the arithmetic.

   ── THE CONVENTION THIS PINS ────────────────────────────────────────────
   Closed intervals. `end_date` is the LAST day a lease governs — the same
   convention datesSpan already uses (end_date >= asOf) and rangesOverlap
   already enforces. So a lease ending 07-31 and a request starting 07-31
   DO collide. Slice 2 did not choose that; it inherited it, and this file
   is where it stops being inheritable by accident.

   Run:  node tests/unit/interval_position_hostile.test.js
   ══════════════════════════════════════════════════════════════════════════ */
"use strict";

const pc = require("../../src/tenancy/position_classifier.js");

let pass = 0, fail = 0; const failures = [];
function ok(label, cond, detail) {
  if (cond) { pass++; console.log("  ok    " + label); }
  else { fail++; failures.push(label); console.log("  FAIL  " + label + (detail ? "\n          " + detail : "")); }
}

const L = (id, start, end, status, over) => Object.assign({
  id, lease_status: status || "active", start_date: start, end_date: end,
  rent: 900, tenant_ids: [], source_type: null, confidence: null,
  executed_verified: false, move_in_funds_cleared: false,
}, over || {});

const ROW = (leases, over) => Object.assign({
  space_id: "sp-1", unit_id: "un-1", unit_number: "1417-101", space_label: "Room1",
  leases, possession_events: [], notice_date: null, turn_status: null,
  compat_occupancy: "unknown",
}, over || {});

//  The interval Skyline is actually selling.
const START = "2026-08-01", END = "2027-07-31";
const call = (leases, s, e) => pc.classifyPositionForInterval(
  ROW(leases), { start_date: s || START, end_date: e === undefined ? END : e, personNames: new Map() });
const state = (leases, s, e) => call(leases, s, e).interval_state;

console.log("\n" + "═".repeat(74));
console.log("  THE INTERVAL PRIMITIVE — hostile, pure, no database");
console.log("═".repeat(74) + "\n");

// ── H · INTERVAL ARITHMETIC ───────────────────────────────────────────────
console.log("  ── H · interval arithmetic ──");
ok("H1  exact adjacent terms, no overlap → contractually_free",
   state([L("a", "2027-08-01", "2028-07-31")]) === "contractually_free");
/*  The closed-interval convention, pinned. A lease whose last governed day
 *  IS the requested start collides — inherited from datesSpan, not chosen
 *  here, and the successor rule agrees (a successor must start strictly
 *  after, because `!rangesOverlap` filters the equal-date case out).  */
ok("H2  a prior lease ending ON the requested start DOES collide",
   state([L("a", "2025-08-01", "2026-08-01")]) === "term_partially_blocked",
   state([L("a", "2025-08-01", "2026-08-01")]));
ok("H3  one-day overlap at the front is a collision",
   state([L("a", "2026-07-01", "2026-08-01")]) !== "contractually_free");
ok("H4  one-day overlap at the back is a collision",
   state([L("a", "2027-07-31", "2028-06-30")]) !== "contractually_free");
{
  const r = call([L("a", "2027-01-01", "2027-03-31")]);
  ok("H5  a commitment INSIDE the interval is term_partially_blocked",
     r.interval_state === "term_partially_blocked", r.interval_state);
  //  THE OPERATING ANSWER. "This bed is yours Aug 1 – Dec 31" is what a
  //  leasing agent can act on; a bare false is not.
  ok("H5b …and the free sub-spans are reported, both of them",
     JSON.stringify(r.free_spans) === JSON.stringify([
       { from: "2026-08-01", to: "2026-12-31" }, { from: "2027-04-01", to: "2027-07-31" }]),
     JSON.stringify(r.free_spans));
}
ok("H6  the request sitting inside a longer lease is term_blocked",
   state([L("a", "2026-01-01", "2028-01-01")]) === "term_blocked");
ok("H7  a lease ending the day BEFORE the request is free",
   state([L("a", "2025-08-01", "2026-07-31")]) === "contractually_free");
ok("H8  an open-ended lease running from before the request is term_blocked",
   state([L("a", "2020-01-01", null)]) === "term_blocked");
ok("H9  an open-ended REQUEST against a future commitment is not free",
   state([L("a", "2027-01-01", "2027-12-31")], START, null) !== "contractually_free");
ok("H10 an interval whose end precedes its start is REFUSED, not answered",
   (() => { try { call([], "2027-01-01", "2026-01-01"); return false; }
            catch (e) { return e.code === "INVALID_INTERVAL"; } })());
ok("H11 a one-day interval is answered like any other",
   state([], "2026-08-01", "2026-08-01") === "contractually_free"
   && state([L("a", "2026-08-01", "2026-08-01")], "2026-08-01", "2026-08-01") === "term_blocked");
ok("H12 a missing start is refused",
   (() => { try { pc.classifyPositionForInterval(ROW([]), { end_date: END }); return false; }
            catch (_) { return true; } })());

// ── R · WHICH RIGHTS COUNT ────────────────────────────────────────────────
console.log("\n  ── R · which recorded rights count as a right ──");
const TERMINAL = ["cancelled", "terminated", "rescinded", "void", "expired", "superseded"];
ok("R1  every terminal status is not a right — all six",
   TERMINAL.every((s) => state([L("a", "2026-01-01", "2028-01-01", s)]) === "contractually_free"),
   TERMINAL.map((s) => `${s}:${state([L("a", "2026-01-01", "2028-01-01", s)])}`).join(" "));
/*  THE UNIT-530 SHAPE. A `pending` lease is a real dated claim on the
 *  position even though it is not current economic tenancy. Narrowing this
 *  to CURRENT_ECONOMIC_STATUSES would re-open the exact hole that quoted a
 *  committed unit to nine prospects.  */
ok("R2  a PENDING lease is a real dated right",
   state([L("a", "2026-09-01", "2027-06-30", "pending")]) === "term_partially_blocked");
ok("R3  an unrecognised status FAILS CLOSED — it withholds the position",
   state([L("a", "2026-01-01", "2028-01-01", "some_status_nobody_anticipated")]) === "term_blocked");
{
  const proven = call([L("a", "2027-01-01", "2027-03-31", "active",
    { executed_verified: true, move_in_funds_cleared: true })]);
  const imported = call([L("b", "2027-01-01", "2027-03-31", "active",
    { source_type: "historical_snapshot", confidence: "confirmed" })]);
  const unproven = call([L("c", "2027-01-01", "2027-03-31", "active")]);
  ok("R4  a collision is a collision at every proof level",
     [proven, imported, unproven].every((r) => r.interval_state === "term_partially_blocked"));
  //  …and HOW WELL each is known travels with it, unflattened. Whether an
  //  unproven right may be written over is a human decision, made through
  //  the governing writer. This read never makes it.
  ok("R4b …and each carries its own proof basis, not a boolean",
     proven.colliding_rights[0].proof_basis === "native_verified"
     && imported.colliding_rights[0].proof_basis === "confirmed_opening_import"
     && unproven.colliding_rights[0].proof_basis === "unproven",
     JSON.stringify([proven, imported, unproven].map((r) => r.colliding_rights[0].proof_basis)));
}
ok("R5  a sitting lease that expires BEFORE the request is not reported as colliding",
   call([L("a", "2025-08-01", "2026-07-15")]).colliding_rights.length === 0);
ok("R6  current occupant + successor, both ending before the request → free",
   state([L("a", "2024-08-01", "2025-07-31"), L("b", "2025-08-01", "2026-07-31")])
     === "contractually_free");
ok("R7  a successor sitting inside the request is term_partially_blocked",
   state([L("a", "2025-08-01", "2026-09-30"), L("b", "2026-10-01", "2027-02-28")])
     === "term_partially_blocked");

// ── U · WHEN IT MUST REFUSE TO ANSWER ─────────────────────────────────────
console.log("\n  ── U · the honest refusals ──");
{
  const r = call([L("a", "2026-08-01", "2027-07-31"), L("b", "2026-09-01", "2027-01-01")]);
  ok("U1  overlapping claims TOUCHING the interval → unresolved",
     r.interval_state === "unresolved", r.interval_state);
  ok("U1b …and both conflicting leases are NAMED, never resolved to the first",
     r.conflicting_lease_ids.length === 2 && r.conflicting_lease_ids.includes("a")
     && r.conflicting_lease_ids.includes("b"), JSON.stringify(r.conflicting_lease_ids));
}
/*  A contest in 2029 does not stop Spine answering about 2026. Refusing
 *  there would be a different kind of wrong — a refusal with no basis.  */
ok("U2  overlapping claims OUTSIDE the interval are still answerable",
   state([L("a", "2029-01-01", "2030-01-01"), L("b", "2029-06-01", "2030-06-01")])
     === "contractually_free");
ok("U3  a position with no leases at all is contractually_free",
   state([]) === "contractually_free");
ok("U4  …and its free span is the whole requested interval",
   JSON.stringify(call([]).free_spans) === JSON.stringify([{ from: START, to: END }]));

// ── C · WHAT IT REFUSES TO DECIDE ─────────────────────────────────────────
console.log("\n  ── C · the line it does not cross ──");
{
  const r = call([]);
  const keys = Object.keys(r);
  //  Operating availability is availability_read's answer. If any of these
  //  words appears here, the two truths have started merging.
  const forbidden = ["marketable", "marketing_state", "ready", "readiness", "turnover",
                     "possession", "offerable", "available", "is_down", "operating_use", "rent", "price"];
  const leaked = keys.filter((k) => forbidden.some((f) => k.toLowerCase().includes(f)));
  ok("C1  the classifier decides NOTHING about marketability or readiness",
     leaked.length === 0, `leaked: ${leaked.join(", ")}`);
  //  And the states are named so nobody has to remember what they mean.
  ok("C2  the free state is `contractually_free`, never a generic `available`",
     r.interval_state === "contractually_free");
  ok("C3  every state is one of the four, and only those four",
     ["contractually_free", "term_blocked", "term_partially_blocked", "unresolved"]
       .includes(r.interval_state));
  ok("C4  the requested interval is echoed back, so an answer is never orphaned",
     r.requested.start_date === START && r.requested.end_date === END);
  ok("C5  stable position identity travels with the answer",
     r.space_id === "sp-1" && r.unit_id === "un-1");
}

// ── G · GRAIN ─────────────────────────────────────────────────────────────
console.log("\n  ── G · by-bed and by-unit, one code path ──");
{
  //  A whole-unit property's position differs only in its label. There is
  //  no branch to take — §22 holds because there is nothing to branch on.
  const bed = pc.classifyPositionForInterval(
    ROW([L("a", "2027-01-01", "2027-03-31")]), { start_date: START, end_date: END, personNames: new Map() });
  const whole = pc.classifyPositionForInterval(
    ROW([L("a", "2027-01-01", "2027-03-31")], { space_label: "(whole unit)" }),
    { start_date: START, end_date: END, personNames: new Map() });
  ok("G1  a by-bed and a by-unit position with identical rights answer identically",
     bed.interval_state === whole.interval_state
     && JSON.stringify(bed.free_spans) === JSON.stringify(whole.free_spans),
     `${bed.interval_state} vs ${whole.interval_state}`);
  ok("G2  …and the source is free of any grain branch",
     !/whole\s*unit|space_label\s*===|position_kind/i.test(
       String(pc.classifyPositionForInterval)),
     "the interval classifier branches on grain");
}

// ── F · THE FREE-SPAN ARITHMETIC ITSELF ───────────────────────────────────
console.log("\n  ── F · free spans, directly ──");
const spans = (rights, s, e) => JSON.stringify(pc.freeSpans(s || START, e === undefined ? END : e, rights));
ok("F1  two separate commitments leave three gaps",
   spans([{ start_date: "2026-10-01", end_date: "2026-10-31" },
          { start_date: "2027-02-01", end_date: "2027-02-28" }]) ===
   JSON.stringify([{ from: "2026-08-01", to: "2026-09-30" },
                   { from: "2026-11-01", to: "2027-01-31" },
                   { from: "2027-03-01", to: "2027-07-31" }]),
   spans([{ start_date: "2026-10-01", end_date: "2026-10-31" },
          { start_date: "2027-02-01", end_date: "2027-02-28" }]));
ok("F2  adjacent commitments do not manufacture a zero-length gap between them",
   spans([{ start_date: "2026-10-01", end_date: "2026-10-31" },
          { start_date: "2026-11-01", end_date: "2026-11-30" }]) ===
   JSON.stringify([{ from: "2026-08-01", to: "2026-09-30" },
                   { from: "2026-12-01", to: "2027-07-31" }]),
   spans([{ start_date: "2026-10-01", end_date: "2026-10-31" },
          { start_date: "2026-11-01", end_date: "2026-11-30" }]));
ok("F3  overlapping commitments collapse into one blocked run",
   spans([{ start_date: "2026-10-01", end_date: "2027-01-31" },
          { start_date: "2026-12-01", end_date: "2027-03-31" }]) ===
   JSON.stringify([{ from: "2026-08-01", to: "2026-09-30" },
                   { from: "2027-04-01", to: "2027-07-31" }]),
   spans([{ start_date: "2026-10-01", end_date: "2027-01-31" },
          { start_date: "2026-12-01", end_date: "2027-03-31" }]));
ok("F4  a commitment covering the whole interval leaves nothing",
   spans([{ start_date: "2026-01-01", end_date: "2028-01-01" }]) === "[]");
ok("F5  an open-ended REQUEST reports its tail as open-ended, not as a fake date",
   spans([{ start_date: "2026-10-01", end_date: "2026-10-31" }], START, null) ===
   JSON.stringify([{ from: "2026-08-01", to: "2026-09-30" }, { from: "2026-11-01", to: null }]),
   spans([{ start_date: "2026-10-01", end_date: "2026-10-31" }], START, null));

console.log("\n" + "═".repeat(74));
console.log(`  ${fail === 0 ? "✓ PASS" : "✗ FAIL"} — ${pass} passed, ${fail} failed`);
if (fail) console.log("  FAILED: " + failures.join(" | "));
console.log("═".repeat(74) + "\n");
process.exit(fail === 0 ? 0 : 1);
