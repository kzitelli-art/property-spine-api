/* ══════════════════════════════════════════════════════════════════════════
   rent_roll_status_not_identity.test.js — THE RENT ROLL'S `status` COLUMN
   WAS CARRYING THE RESIDENT'S IDENTIFIER.

   WHAT WAS WRONG
   --------------
   `normalizeRow` (src/shared/snapshot_loader.js) derived a position's
   lifecycle status like this:

       const status = cleanStatus(raw?.status || raw?.resident_raw
                                             || raw?.resident_id, section);

   and `cleanStatus` ended with:

       return s || "current";

   so an unrecognised string came back VERBATIM as the status. Put together,
   on a source with no status column the third fallback wins and a person's
   source record id becomes the position's status:

       status === "s0004577"

   MEASURED ON THE REAL BUILDING (CURRENT_STATE 134, signed in, owned
   Postgres, real HTTP): on GET /operator/rent-roll, 95 of The Greenery's
   105 positions carried a resident id in `row.status` — 96 distinct values —
   and only the 10 vacant rows held a lifecycle word.

   WHY IT MATTERED THREE TIMES OVER
   --------------------------------
     · `OCCUPIED_STATUSES.has("s0004577")` is false, so the route's own
       summary reported `occupied: 0` and `current_occupancy_pct: 0` beside
       94 canonical leased rows. A confident wrong number, which §5 forbids.
     · The lifecycle vocabulary was DEAD. Nothing that is not detectably
       vacant can ever read `current` or `notice`, so a position on notice
       counts as occupied — and a stale occupancy double-lets a bed (§42).
     · Any consumer reading `status` inherited an identifier from a field
       named like a state. That is how the desk's `total - vacant` occupancy
       looked right for so long: 105 - 10 happened to equal the truth.

   THE SOURCE ITSELF IS THE REASON, AND IT IS NOT A BUG IN THE SOURCE
   ------------------------------------------------------------------
   Greenery's Yardi export has NO status column at all. Its header is
   Unit · Room · Unit/Room Type · Resident · Total Beds · Sq Ft · Market Rent
   · Actual Rent · ... and its section header is literally
   "Current/Notice/Vacant Residents" — Yardi lumps the three together and
   the only signal is the Resident cell, which holds either "Name (id)" or
   the word VACANT.

   So for an occupied Greenery position the honest answer is that status is
   NOT A RECORDED FACT OF THIS SOURCE: occupancy is established by the
   LEASE, not by a status word, and NOTICE CANNOT BE EXPRESSED HERE AT ALL.
   Defaulting to "current" manufactures a status the document does not
   state, exactly as returning the resident id did.

   WHAT THE FIX MUST AND MUST NOT DO
   ---------------------------------
   MUST  · a resident identifier NEVER contributes a status. Ever.
   MUST  · an unrecognised value is `not_established`, never echoed, and
           never silently "current".
   MUST  · say where the status came from (`status_basis`), the same move
           `as_of_basis` (row 122) and `basis_state` (row 131) already make.
   MUST  · keep the raw value for provenance rather than dropping it.
   MUST NOT · break vacancy detection. VACANT arrives in the RESIDENT cell
           on this vendor, so a recognised lifecycle WORD there is genuine
           status information — it is the identifier that is not. Vacancy is
           evaluated last precisely because a stale vacancy double-lets a
           bed, so this regression is guarded below.
   MUST NOT · change what INGEST establishes. normalizeRow is shared by the
           read path and the commit path, so every assertion about a
           leased row also checks name, resident_id and non-revenue are
           untouched.

   Every function here is EXECUTED, not scanned, and every assertion is
   written to discriminate on BEHAVIOUR so it holds on any tree — a source
   scan is what let a missing require ship for five commits (row 125).

   Run:  node tests/unit/rent_roll_status_not_identity.test.js
   ══════════════════════════════════════════════════════════════════════════ */
"use strict";
const snap = require("../../src/shared/snapshot_loader");
const { normalizeRow, summarizeRows } = snap;

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("   PASS  " + m); } else { fail++; console.log("   FAIL  " + m); } };

/*  Real bytes from The Greenery's August 2026 roll, as the adapter hands
 *  them on: the Resident cell already split into name + source record id,
 *  and NO status key, because the document has no status column. */
const LEASED = {
  unit_number: "1325-101", room: "Room1", unit_type: "STU00011",
  name: "Zenia Mitchell", resident_id: "s0004577",
  market_rent: 950, actual_rent: 1050,
  lease_from: "2026-07-27", lease_to: "2026-12-31", balance: 3945,
};
/*  The same vendor's vacant row: the word arrives in the RESIDENT cell. */
const VACANT = {
  unit_number: "1325-110", room: "Room2", unit_type: "STU00011",
  resident_raw: "VACANT", market_rent: 950,
};

console.log("\n== a resident identifier is not a lifecycle state ==");
{
  const r = normalizeRow(LEASED);
  ok(r.status !== "s0004577",
    "the resident id is NOT the status (got " + JSON.stringify(r.status) + ")");
  ok(!/^[a-z]\d{3,}$/i.test(String(r.status || "")),
    "and no resident-id-shaped value reaches status at all");
  ok(r.status !== "current",
    "nor is a status invented for a document that states none (got " + JSON.stringify(r.status) + ")");
  ok(r.status === "not_established",
    "an unstated status is not_established");
  ok(r.status_basis === "not_established",
    "and the row says WHY, rather than leaving the reader to guess");
}

console.log("\n== the fix may not cost the leased row its person or its money ==");
{
  const r = normalizeRow(LEASED);
  ok(r.name === "Zenia Mitchell", "the name survives");
  ok(r.resident_id === "s0004577", "the source record id survives, in its own field");
  ok(r.actual_rent === 1050, "the rent survives");
  ok(r.lease_to === "2026-12-31", "the lease end survives");
}

console.log("\n== vacancy detection must NOT regress: the word is in the resident cell ==");
{
  const v = normalizeRow(VACANT);
  ok(v.status === "vacant", "VACANT in the resident cell still reads vacant");
  ok(v.status_basis === "resident_cell_lifecycle_word",
    "and names that cell as the basis, so the reading is auditable");
  ok(v.name === null && v.resident_id === null,
    "a vacant position carries no person");
  //  the other non-revenue words travel the same cell on this vendor
  ok(normalizeRow({ unit_number: "u", resident_raw: "MODEL" }).status === "model", "MODEL too");
  ok(normalizeRow({ unit_number: "u", resident_raw: "DOWN" }).status === "down", "DOWN too");
}

console.log("\n== an explicit status column still wins, and still normalizes ==");
{
  ok(normalizeRow({ unit_number: "u", status: "Notice", resident_id: "s1" }).status === "notice",
    "a real Notice column is honoured");
  ok(normalizeRow({ unit_number: "u", status: "Notice", resident_id: "s1" }).status_basis === "source_status_column",
    "and is named as the basis");
  ok(normalizeRow({ unit_number: "u", status: "Occupied", resident_id: "s1" }).status === "current",
    "Occupied still maps to current");
  ok(normalizeRow({ unit_number: "u", section: "future", resident_id: "s1" }).status === "future",
    "the future section still decides future");
}

console.log("\n== an unrecognised status word is not echoed as if it were one ==");
{
  //  This is the general protection. Yardi vocabulary changes; a word this
  //  build has never seen must not become a status by being passed through.
  const r = normalizeRow({ unit_number: "u", status: "Holdover-Pending-Review" });
  ok(r.status === "not_established",
    "an unknown word is not_established (got " + JSON.stringify(r.status) + ")");
  ok(r.status_source_value === "Holdover-Pending-Review",
    "but it is KEPT verbatim for provenance, not discarded");
  ok(r.status_basis === "unrecognised_source_value",
    "and the basis distinguishes 'said something we cannot read' from 'said nothing'");
}

console.log("\n== an identifier WE stored in the status field is not the document's fault ==");
{
  /*  The shape actually on disk for all 95 of Greenery's leased rows, because
   *  `raw` is stored normalizeRow-shaped and the old normalizer wrote the id
   *  into `status` before re-reading it. Confirmed by SQL on the governed
   *  establishment: status = resident_id = resident_raw = "s0004577". */
  const CONTAMINATED = { unit_number: "1325-101", name: "Zenia Mitchell",
    status: "s0004577", resident_id: "s0004577", resident_raw: "s0004577" };
  const r = normalizeRow(CONTAMINATED);
  ok(r.status === "not_established", "it is still not a status");
  ok(r.status_basis === "identifier_in_status_field",
    "and the basis names SPINE as the author, not the rent roll (got " + JSON.stringify(r.status_basis) + ")");
  ok(r.status_basis !== "unrecognised_source_value",
    "it must NOT read as 'the document said something we cannot parse' — the document said nothing");
  ok(r.status_source_value === "s0004577", "the offending value is kept, so the row is diagnosable");
  ok(r.resident_id === "s0004577", "and the identifier still does its real job");

  //  Equality is the evidence. A vendor status that merely LOOKS id-shaped
  //  but is not this row's resident is still just unrecognised.
  const lookalike = normalizeRow({ unit_number: "u", status: "x9999", resident_id: "s0004577" });
  ok(lookalike.status_basis === "unrecognised_source_value",
    "an id-SHAPED value that is not this row's resident stays unrecognised — shape is not evidence");
}

console.log("\n== the summary may not report occupancy of zero when it cannot tell ==");
{
  //  Greenery's real shape: 95 leased positions, 10 vacant, no status column.
  const rows = [];
  for (let i = 0; i < 95; i++) rows.push(normalizeRow({ ...LEASED, unit_number: "u" + i, resident_id: "s" + (4000 + i) }));
  for (let i = 0; i < 10; i++) rows.push(normalizeRow({ ...VACANT, unit_number: "v" + i }));
  const s = summarizeRows(rows);

  ok(s.inventory === 105, "the row spine is 105, as the building is");
  ok(s.vacant === 10, "vacancy is still counted from a positive classification");
  ok(s.occupied !== 0,
    "occupied is NOT 0 beside 95 leased rows (got " + JSON.stringify(s.occupied) + ")");
  ok(s.occupied === null,
    "it is null — unknown, which is a different fact from zero");
  ok(s.current_occupancy_pct === null,
    "and no percentage is computed from an unknown numerator");
  //  NOT "not_established": the 10 vacant positions ARE classified, so this
  //  building is genuinely PARTIAL. Getting this wrong in the first draft of
  //  this test is the reason the distinction is asserted rather than assumed.
  ok(s.occupancy_basis === "partially_established",
    "the summary names it partial — vacancy is known, occupancy is not");
  ok(s.status_not_established === 95,
    "and counts exactly how many positions it could not classify");
  //  §18, applied at the SOURCE rather than only at the desk: a floor of
  //  zero is not a floor. Nothing here is recognisably occupied, so there
  //  is no floor to offer, and offering 0 would read as "nothing is leased".
  ok(s.occupied_at_least === null,
    "no floor is offered when nothing at all is classified — a floor of zero is not a floor");
}

console.log("\n== where a source DOES state status, the summary still answers ==");
{
  const rows = [
    normalizeRow({ unit_number: "a", status: "Current", name: "A", resident_id: "s1" }),
    normalizeRow({ unit_number: "b", status: "Notice",  name: "B", resident_id: "s2" }),
    normalizeRow({ unit_number: "c", status: "Vacant" }),
    normalizeRow({ unit_number: "d", status: "Down" }),
  ];
  const s = summarizeRows(rows);
  ok(s.occupied === 2, "current + notice are occupied");
  ok(s.vacant === 1, "vacant is vacant");
  ok(s.non_revenue === 1, "down is non-revenue");
  ok(s.occupancy_basis === "source_status", "and the basis says the source stated it");
  ok(s.current_occupancy_pct === 50, "a percentage is fine when nothing is unknown");
  ok(s.status_not_established === 0, "nothing unclassified");
  ok(s.occupied_at_least === 2, "with nothing unknown the floor equals the total");
}

console.log("\n== partial knowledge is partial, not rounded up or down ==");
{
  const rows = [
    normalizeRow({ unit_number: "a", status: "Current", name: "A", resident_id: "s1" }),
    normalizeRow({ unit_number: "b", name: "B", resident_id: "s2" }),   // unstated
    normalizeRow({ unit_number: "c", status: "Vacant" }),
  ];
  const s = summarizeRows(rows);
  ok(s.status_not_established === 1, "the one unclassifiable row is counted");
  ok(s.occupied === null, "and one unknown is enough to withhold the TOTAL");
  ok(s.occupancy_basis === "partially_established", "named as partial, not as either extreme");
  //  §18's floor, and WHY it may not be called `occupied`. The bare name is
  //  what a naive consumer reads and treats as complete — that is exactly
  //  the `total - vacant` class of error this row is fixing. So the floor
  //  gets its own unambiguous key and the bare key stays honest.
  ok(s.occupied_at_least === 1,
    "the floor IS published, so a consumer can render >=X% per §18");
  ok(s.occupied === null,
    "but the floor is never served under the bare name `occupied`");
}

console.log("\n== " + pass + " passed, " + fail + " failed ==\n");
process.exit(fail ? 1 : 0);
