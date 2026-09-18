/* ══════════════════════════════════════════════════════════════════════════
   rent_roll_occupied_is_not_contractual.test.js — "OCCUPIED" COLLAPSED TWO
   TENANCY STATES INTO ONE WORD, AND THE COLLAPSE HID A DATED MOVE.

   THIS ROW CORRECTS AN EARLIER FINDING OF MY OWN
   ----------------------------------------------
   CURRENT_STATE 134 and 138 both record that GET /operator/rent-roll/units
   "is not a dated read" because it returns occupied 95 / open 10 at every
   as_of while /canonical moves. The NUMBERS were measured correctly. The
   DIAGNOSIS was wrong, and it was wrong in the most ordinary way: a frozen
   number looks exactly like a read that ignores its date.

   It does not ignore its date. Measured on the governed Greenery
   establishment, through the real dated service at four dates:

       as_of         bucket    contractually   terms_not
                     occupied  occupied        established
       2026-09-18       95        94              1
       2026-12-01       95        94              1
       2027-02-01       95        85             10
       2027-08-01       95         0             95

   `datedPropertyPositions` is correct and moves. `current_lease_position`
   goes present -> present -> present -> null. `tenancy_state` goes
   contractually_occupied -> ... -> occupied_terms_not_established. The
   bucket sits at 95 at every date because THE TWO SUB-STATES ALWAYS SUM TO
   95 — the split moves and the total does not.

   WHY THAT IS WORSE THAN A STALE READ, NOT BETTER
   ----------------------------------------------
   A stale read is wrong and eventually obvious. This one is a TRUE number
   under a word that means something else. At 2027-08-01 not one Greenery
   position has established contractual terms, and the read says
   "occupied: 95". A lender or an owner reading that is not slightly
   misinformed; they have been told the building is full when Spine cannot
   stand behind a single term on it. This is PHILOSOPHY §40.5's truth wall
   in the rent roll's own vocabulary:

       occupied  !=  contractually occupied

   and the same family as `escrow funded != City paid` and `filed != paid`.
   The word is a collapsing word, so the collapse has to be visible.

   WHAT THE FIX DOES, AND WHAT IT REFUSES TO DO
   --------------------------------------------
   `rentRollBuckets` is deliberately a TALLY: "tally the decision, do not
   re-make it". That contract is kept. The bucket decision is untouched and
   `occupied` still counts exactly what it counted, so every existing
   consumer and every existing total is unchanged.

   What is added is a SUB-TALLY of a DIFFERENT recorded field —
   `tenancy_state`, which the canonical position already carries — so the
   coarse word can be read alongside the distinction it collapses:

       occupied_contractual              terms established at this date
       occupied_terms_not_established    somebody is there, terms are not
       occupied_state_unknown            the row did not carry tenancy_state

   The third is not padding. The same comment in rentRollBuckets records
   that the Rent Roll once handed it PROJECTED rows with `basis_state`
   dropped, and every basis-less bed was silently re-bucketed. A projection
   that drops `tenancy_state` must therefore report UNKNOWN, never zero —
   zero would say "none of these lack terms", which is a claim the data
   cannot support (§5).

   Run:  node tests/unit/rent_roll_occupied_is_not_contractual.test.js
   ══════════════════════════════════════════════════════════════════════════ */
"use strict";
const { rentRollBuckets } = require("../../src/tenancy/dated_positions");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("   PASS  " + m); } else { fail++; console.log("   FAIL  " + m); } };

//  Canonical-shaped positions: the bucket already decided, tenancy_state
//  carried alongside it, exactly as datedPropertyPositions returns them.
const occ = (tenancy_state) => ({ bucket: "occupied", tenancy_state });
const open = () => ({ bucket: "open", tenancy_state: "vacant" });

console.log("\n== Greenery today: 94 contractual + 1 without terms, both 'occupied' ==");
{
  const rows = [];
  for (let i = 0; i < 94; i++) rows.push(occ("contractually_occupied"));
  rows.push(occ("occupied_terms_not_established"));
  for (let i = 0; i < 10; i++) rows.push(open());
  const t = rentRollBuckets(rows);

  ok(t.total === 105, "105 positions");
  ok(t.occupied === 95, "the coarse bucket is UNCHANGED at 95 — no existing total moves");
  ok(t.open === 10, "open is unchanged");
  ok(t.occupied_contractual === 94, "and 94 of those 95 have established terms");
  ok(t.occupied_terms_not_established === 1, "one does not, and it is counted, not absorbed");
  ok(t.occupied_contractual + t.occupied_terms_not_established + t.occupied_state_unknown === t.occupied,
    "the sub-tally reconciles to the bucket exactly — no position is lost or double-counted");
}

console.log("\n== the date the collapse was hiding: Greenery at 2027-08-01 ==");
{
  //  Every lease has expired. The dated service says so: no position has a
  //  current lease and every tenancy_state is occupied_terms_not_established.
  const rows = [];
  for (let i = 0; i < 95; i++) rows.push(occ("occupied_terms_not_established"));
  for (let i = 0; i < 10; i++) rows.push(open());
  const t = rentRollBuckets(rows);

  ok(t.occupied === 95, "the coarse word STILL says 95 — which is why this looked like a stale read");
  ok(t.occupied_contractual === 0,
    "but ZERO positions have established contractual terms at that date");
  ok(t.occupied_terms_not_established === 95,
    "all 95 are occupied-without-terms, and the read now says so out loud");
  //  The discriminating assertion. Before the sub-tally, nothing in this
  //  payload could tell 2026-09-18 (94 contractual) from 2027-08-01 (0).
  //  Written so it CANNOT pass vacuously: on the unmodified tree
  //  occupied_contractual is `undefined`, and `undefined !== 95` would have
  //  reported green about a field that does not exist. It must be a NUMBER
  //  and it must differ from the coarse count.
  ok(typeof t.occupied_contractual === "number" && t.occupied_contractual !== t.occupied,
    "'occupied' and 'contractually occupied' are distinguishable AND both are real numbers — §40.5's truth wall");
}

console.log("\n== a projection that drops tenancy_state reports UNKNOWN, never zero ==");
{
  //  The exact hazard rentRollBuckets already documents: a surface hands it
  //  projected rows with a field dropped.
  const rows = [{ bucket: "occupied" }, { bucket: "occupied" }, { bucket: "open" }];
  const t = rentRollBuckets(rows);
  ok(t.occupied === 2, "the bucket still tallies");
  ok(t.occupied_state_unknown === 2, "both are unknown, because the row did not say");
  ok(t.occupied_contractual === 0, "none are claimed as contractual");
  ok(t.occupied_terms_not_established === 0,
    "and none are claimed as lacking terms either — 0 here would assert something unknown");
  ok(t.occupied_contractual + t.occupied_terms_not_established + t.occupied_state_unknown === t.occupied,
    "and it still reconciles");
}

console.log("\n== the tally contract is kept: the bucket decision is never re-made ==");
{
  //  A row whose recorded bucket disagrees with its tenancy_state. The
  //  bucket wins, because upstream decided it. The sub-tally only describes
  //  the occupied ones and never promotes or demotes anything.
  const t = rentRollBuckets([{ bucket: "open", tenancy_state: "contractually_occupied" }]);
  ok(t.open === 1, "the recorded bucket is honoured even against its own tenancy_state");
  ok(t.occupied === 0, "nothing is re-bucketed");
  ok(t.occupied_contractual === 0,
    "and a non-occupied row contributes nothing to the occupied sub-tally");
}

console.log("\n== unrelated states are not swept into either sub-count ==");
{
  const t = rentRollBuckets([
    occ("contractually_occupied"),
    occ("notice"),                 // occupied, on notice: terms exist
    occ("something_new_from_a_later_build"),
    { bucket: "needs_review", tenancy_state: "contested" },
    { bucket: "activation_pending", tenancy_state: "pending" },
  ]);
  ok(t.occupied === 3, "three occupied");
  ok(t.occupied_contractual === 1, "only the explicitly contractual one counts as contractual");
  ok(t.occupied_terms_not_established === 0, "and none claims to lack terms");
  ok(t.occupied_state_unknown === 2,
    "notice and an unrecognised state are UNKNOWN here, not quietly contractual");
  ok(t.needs_review === 1 && t.activation_pending === 1, "the other buckets are untouched");
}

console.log("\n== " + pass + " passed, " + fail + " failed ==\n");
process.exit(fail ? 1 : 0);
