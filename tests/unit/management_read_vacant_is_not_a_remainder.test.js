/* ══════════════════════════════════════════════════════════════════════════
   management_read_vacant_is_not_a_remainder.test.js — THE FOURTH OCCUPANCY
   DEFINITION COUNTED VACANCY AS A LEFTOVER.

   WHAT WAS WRONG
   --------------
   src/surfaces/management_read.js classified every space like this:

       const hasCurrent = !!r.cur_lease_id && !isDownModel;
       ...
       if (hasCurrent) { occupied++; ... }
       else            { vacant++; vacantList.push({...}); }

   `occupied` is "has a current lease id". `vacant` is EVERYTHING ELSE. That
   is the subtraction §42 forbids and that the canonical reader was corrected
   for — its own comment says so in as many words:

       "And NOT `positions.length - occupied`. That subtraction was the
        defect: it swept committed, contested and unreconciled beds into
        Open because they were not Occupied. Open is now a state a position
        is classified INTO, so it can never absorb a bed nobody classified."

   This file still did it. A position with a FUTURE lease and no current one
   is spoken for — somebody has signed for it — and it landed in `vacant`
   AND in `vacantList`, which the same read renders as

       "Empty beds are the fastest revenue to recover."

   So the surface that tells an operator where to chase revenue was pointing
   at beds that are already let. That is the expensive mistake the canonical
   reader's comment names, made in a different file.

   WHY GREENERY COULD NOT CATCH IT
   -------------------------------
   Measured over real HTTP on the governed Greenery establishment:
   occupied 95 · vacant 10 · 90.5% · vacant list empty. Correct — because
   Greenery has ZERO future commitments, ZERO needs-review and ZERO
   unestablished positions, so the remainder happens to contain only genuine
   vacancies. A remainder is not wrong until something lands in it. That is
   exactly why this is a constructed test and not a fixture read.

   WHAT IS ASSERTED
   ----------------
   The REAL express handler runs against a stub pool, so a missing binding
   fails here rather than in production (CURRENT_STATE 125). `commercial`,
   `down` and `model` keep their existing meanings; the only change is that
   a committed position is counted as committed instead of falling through,
   and that the leasable denominator and the percentage stay arithmetically
   consistent with the buckets that now exist.

   Run:  node tests/unit/management_read_vacant_is_not_a_remainder.test.js
   ══════════════════════════════════════════════════════════════════════════ */
"use strict";
const assert = require("assert");
const managementRead = require("../../src/surfaces/management_read");

let pass = 0, fail = 0;
const ok = (c, m, d) => { if (c) { pass++; console.log("   PASS  " + m); } else { fail++; console.log("   FAIL  " + m + (d ? "  →  " + d : "")); } };

//  The columns the route's own query selects.
const row = (o) => ({
  unit_id: o.unit_id || "u1", unit_number: o.unit_number || "101",
  space_id: o.space_id || "s1", space_label: o.space_label || "Room1",
  market_rent: o.market_rent == null ? "900.00" : o.market_rent,
  cur_lease_id: o.cur_lease_id || null, cur_rent: o.cur_rent == null ? null : o.cur_rent,
  cur_balance: o.cur_balance == null ? null : o.cur_balance,
  cur_status: o.cur_status || null, cur_tenant: o.cur_tenant || null,
  fut_lease_id: o.fut_lease_id || null,
});

const LEASED    = (n) => row({ space_id: "leased" + n,    unit_number: n, cur_lease_id: "L" + n, cur_rent: "900.00", cur_tenant: "Resident " + n });
const COMMITTED = (n) => row({ space_id: "committed" + n, unit_number: n, fut_lease_id: "F" + n });
const OPEN      = (n) => row({ space_id: "open" + n,      unit_number: n });
const DOWN      = (n) => row({ space_id: "down" + n,      unit_number: n, space_label: "DOWN" });

function stubPool(rows, leasingBasis = "bed") {
  return { connect: async () => ({
    query: async (sql) => (/from properties/.test(sql)
      ? { rows: [{ leasing_basis: leasingBasis }] }
      : { rows }),
    release: () => {},
  }) };
}

async function read(rows) {
  const router = managementRead({ pool: stubPool(rows) });
  const layer = router.stack.find(l => l.route && /management-read/.test(l.route.path));
  assert(layer, "the /management-read route was not found");
  let body = null;
  const res = { json: (b) => { body = b; }, status: () => res };
  layer.route.stack[0].handle({ params: { id: "p1" }, query: {} }, res, () => {});
  for (let i = 0; i < 200 && body === null; i++) await new Promise(r => setImmediate(r));
  assert(body, "the handler produced no body");
  return body;
}

(async () => {
console.log("\n== a bed somebody has signed for is not an empty bed ==");
{
  //  One leased, one committed (future lease, no current), one genuinely open.
  const b = await read([LEASED("101"), COMMITTED("102"), OPEN("103")]);
  const o = b.occupancy || {};
  const d = JSON.stringify(o);

  ok(o.occupied === 1, "the leased bed is occupied", d);
  ok(o.vacant === 1,
    "vacancy counts ONLY the genuinely open bed — not the committed one (got " + o.vacant + ")", d);
  ok(typeof o.committed === "number" && o.committed === 1,
    "the committed bed is counted under its own name", d);
  ok(o.occupied + o.committed + o.vacant + o.down + o.model + o.commercial === o.total_spaces,
    "every space lands in exactly one bucket and they sum to the total", d);

  /*  THE SURFACE THE OPERATOR ACTUALLY SEES. The read emits a `focus` entry
   *  of kind "vacancy" whose title is "N vacant beds — ~$X/mo at market" and
   *  whose detail says "Empty beds are the fastest revenue to recover."
   *  `dollars` is the market rent of the beds in the remainder, so a
   *  committed bed both inflates the count and overstates the money that
   *  could be recovered by leasing it — it is already leased.
   *
   *  Asserted against `focus` by name rather than against a guessed key: an
   *  earlier draft of this test looked for `vacant_units`/`vacancies`, got
   *  `[]` because no such key exists, and one of its assertions PASSED
   *  vacuously on the empty array. Fourth time that shape appeared today.  */
  const vacancyFocus = (b.focus || []).find(f => f.kind === "vacancy") || null;
  ok(vacancyFocus && /^1 vacant /.test(vacancyFocus.title),
    "the operator is told 1 vacant bed, not 2 — offering 102 is the expensive mistake",
    JSON.stringify(vacancyFocus));
  ok(vacancyFocus && vacancyFocus.dollars === 900,
    "and the recoverable market rent is the open bed's 900, not 1800 with a let bed's rent added",
    JSON.stringify(vacancyFocus));
}

console.log("\n== the percentage may not be computed off a remainder either ==");
{
  const b = await read([LEASED("101"), COMMITTED("102"), OPEN("103"), OPEN("104")]);
  const o = b.occupancy || {};
  const d = JSON.stringify(o);
  //  4 leasable, 1 occupied now. The current percentage is about NOW, so a
  //  committed bed is not in the numerator — but it must not be silently
  //  inflating the vacancy story either.
  ok(o.leasable === 4, "all four are leasable", d);
  ok(o.occupied === 1 && o.committed === 1 && o.vacant === 2,
    "1 occupied, 1 committed, 2 open", d);
  ok(o.current_pct === 25, "current occupancy is 1 of 4 = 25%", d);
  //  The forward number already existed and already counted the future
  //  lease; it must not now double-count it.
  //  `upcoming_pct` lives under `upcoming`, not `occupancy` — read by name
  //  from the real payload rather than assumed.
  ok((b.upcoming || {}).upcoming_pct === 50,
    "upcoming counts the committed bed once: 2 of 4 = 50%", JSON.stringify(b.upcoming));
}

console.log("\n== down and model still behave exactly as before ==");
{
  const b = await read([LEASED("101"), DOWN("102"), OPEN("103")]);
  const o = b.occupancy || {};
  const d = JSON.stringify(o);
  ok(o.down === 1, "the DOWN bed is counted down", d);
  ok(o.leasable === 2, "and excluded from leasable", d);
  ok(o.vacant === 1, "vacancy is the one open bed", d);
  ok(o.committed === 0, "nothing is committed here", d);
  ok(o.current_pct === 50, "1 occupied of 2 leasable = 50%", d);
}

console.log("\n== an all-committed building reads 0% now and 100% upcoming, never 'empty' ==");
{
  const b = await read([COMMITTED("101"), COMMITTED("102")]);
  const o = b.occupancy || {};
  const d = JSON.stringify(o);
  ok(o.occupied === 0, "nobody is in yet", d);
  ok(o.vacant === 0,
    "and NOTHING is vacant — every bed is signed for (got " + o.vacant + ")", d);
  ok(o.committed === 2, "both are committed", d);
  ok(o.current_pct === 0, "current occupancy is honestly 0%", d);
  ok((b.upcoming || {}).upcoming_pct === 100, "upcoming is 100%", JSON.stringify(b.upcoming));
  //  And no vacancy focus at all: there is no revenue to recover here, so the
  //  read must not raise the card. Asserted on `focus` by name, and
  //  non-vacuous because the same array carries other kinds.
  ok(!(b.focus || []).some(f => f.kind === "vacancy"),
    "no 'fastest revenue to recover' card is raised, because there is none to recover",
    JSON.stringify((b.focus || []).map(f => f.kind)));
}

console.log("\n== the canonical occupancy rides alongside, and a disagreement is VISIBLE ==");
{
  /*  TWO DERIVATIONS — AND MEASURING THEM DISPROVED MY OWN FRAMING.
   *
   *  I expected a contradiction: this read counts `cur_lease_id` presence,
   *  the canonical reader counts `tenancy_state`, so surely they disagree.
   *  Measured on the governed Greenery establishment over real HTTP:
   *
   *      management-read   occupied 95
   *      canonical         occupied 95   ->  agrees_with_canonical: true
   *                        occupied_contractual 94
   *                        occupied_terms_not_established 1
   *
   *  THEY AGREE on the coarse count. What I had called "a disagreement of
   *  one bed" was me comparing `occupied` against `contractually_occupied`
   *  — the exact category error `occupied != contractually occupied` names,
   *  committed in my own description of the defect while fixing it
   *  elsewhere. Recorded because it is the whole reason the truth wall
   *  exists: the two words are so easy to slide between that they slid in
   *  the sentence explaining why they must not.
   *
   *  So this is NOT a contradictory second definition. It is a MISSING
   *  DISTINCTION: the surface had no contractual number at all. Row 142 measured the lender-facing report
   *  already doing this correctly — it passes the canonical number through
   *  under `confirmed_contractual_occupancy` and reports the coarser bucket
   *  beside it under `positions_occupied_all_bases`. Same move here rather
   *  than a new one: NO existing number changes, the canonical answer is
   *  published beside it, and when the two disagree the payload SAYS SO
   *  instead of leaving a reader to discover it.
   *
   *  A failed canonical read is `null` with a reason, never a silent
   *  omission and never zero (§40.7: READ_FAILED is not NOT_ESTABLISHED).  */
  const b = await read([LEASED("101"), COMMITTED("102"), OPEN("103")]);
  const o = b.occupancy || {};
  ok(Object.prototype.hasOwnProperty.call(o, "canonical"),
    "the payload carries a `canonical` block, present or explicitly null", JSON.stringify(Object.keys(o)));
  ok(Object.prototype.hasOwnProperty.call(o, "agrees_with_canonical"),
    "and says whether the two derivations agree", JSON.stringify(Object.keys(o)));
  //  The stub pool answers the canonical reader's queries with the same
  //  space rows, which is not a canonical position set — so the read cannot
  //  establish one. That must read as UNAVAILABLE with a reason, not as 0
  //  and not as silent agreement.
  ok(o.canonical === null || typeof o.canonical === "object",
    "canonical is an object or null — never undefined", JSON.stringify(o.canonical));
  //  Guarded so an ABSENT block reports red instead of throwing: a harness
  //  error is a worse outcome than a failing assertion, because it stops the
  //  remaining checks from running at all.
  if (o.canonical === undefined) {
    ok(false, "canonical block absent — nothing further can be checked", "undefined");
  } else if (o.canonical === null) {
    ok(typeof o.canonical_unavailable_reason === "string" && o.canonical_unavailable_reason.length > 0,
      "an unavailable canonical read NAMES why, rather than disappearing", JSON.stringify(o.canonical_unavailable_reason));
    ok(o.agrees_with_canonical === null,
      "and agreement is null, not true — Spine did not compare anything (READ_FAILED is not agreement)",
      JSON.stringify(o.agrees_with_canonical));
  } else {
    ok(typeof o.canonical.occupied_contractual === "number",
      "a canonical block carries the contractual count", JSON.stringify(o.canonical));
    ok(typeof o.agrees_with_canonical === "boolean",
      "and agreement is a decided boolean", JSON.stringify(o.agrees_with_canonical));
  }
}

console.log("\n== " + pass + " passed, " + fail + " failed ==\n");
process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("HARNESS ERROR:", e && e.stack || e); process.exit(2); });
