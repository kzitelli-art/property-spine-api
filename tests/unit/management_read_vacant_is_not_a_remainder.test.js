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
  cur_end_date: o.cur_end_date || null,
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
   *  THEY AGREE on the coarse count — ON GREENERY. On the claim-backed fixture
   *  (availability_uncorroborated_claim.db.js) this surface reads occupied 2
   *  and the canonical reader occupied 4, so agrees_with_canonical is FALSE
   *  there; observed over real HTTP, because the stub pool below cannot serve
   *  the canonical reader and only the `null` branch runs in this file.
   *  What I had called "a disagreement of
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

console.log("\n== a renewal is ONE bed, so upcoming may not exceed the building ==");
{
  /*  `upcoming_pct = (occupied + commercial + futureCount) / revenueSpaces`,
   *  and `futureCount` counts every row carrying a fut_lease_id — INCLUDING
   *  a bed that also has a current lease, which is what a renewal is. So a
   *  fully renewed building counts each of its beds twice and reports more
   *  than 100% of itself as upcoming.
   *
   *  I first filed this as needing a product ruling on what "upcoming"
   *  means. It does not. Under EITHER reading — "beds with someone in them
   *  or coming" or "beds spoken for" — a renewed bed is ONE bed. The
   *  semantics are open; the arithmetic is not, and a percentage above 100%
   *  of the leasable denominator is wrong under both. Fixed without taking
   *  the ruling, and `future_leases` is deliberately left alone because it
   *  counts LEASES and is correct as a lease count.                       */
  const RENEWED = (n) => row({ space_id: "renewed" + n, unit_number: n,
    cur_lease_id: "L" + n, cur_rent: "900.00", cur_tenant: "Resident " + n, fut_lease_id: "F" + n });

  const b = await read([RENEWED("101"), RENEWED("102")]);
  const o = b.occupancy || {}, up = b.upcoming || {};
  const d = JSON.stringify({ occupancy: o, upcoming: up });

  ok(o.occupied === 2, "both beds are occupied now", d);
  ok(o.committed === 0, "neither is committed-and-empty — somebody is already in", d);
  ok(o.vacant === 0, "and nothing is vacant", d);
  ok(up.future_leases === 2, "two future leases exist, and that count is about LEASES", d);
  ok(up.upcoming_pct === 100,
    "upcoming is 100%, not 200% — a renewed bed is counted once (got " + up.upcoming_pct + ")", d);
  ok(up.upcoming_pct <= 100,
    "and no reading of 'upcoming' permits more than the whole building", d);

  //  The mixed control, so the cap is not achieved by clamping: one renewal,
  //  one bed committed but empty, two open. Upcoming should be 2 of 4.
  const c = await read([RENEWED("201"), COMMITTED("202"), OPEN("203"), OPEN("204")]);
  const cu = c.upcoming || {}, co = c.occupancy || {};
  const cd = JSON.stringify({ occupancy: co, upcoming: cu });
  ok(co.occupied === 1 && co.committed === 1 && co.vacant === 2, "1 in, 1 signed, 2 open", cd);
  ok(cu.upcoming_pct === 50,
    "upcoming counts the renewed bed once and the committed bed once: 2 of 4 = 50% (got " + cu.upcoming_pct + ")", cd);
}

console.log("\n== leasing-risk coverage must compare beds to the beds it covers ==");
{
  /*  `coverage = futureCount / (vacant + expiringSoon)` drives `riskLevel`,
   *  which drives a focus card's SEVERITY and the line "turn is outrunning
   *  leasing". So this is a published judgement, not only prose.
   *
   *  ⚠ AND MY OWN ROW 146 CHANGE MADE IT INCONSISTENT. Before that change a
   *  committed bed sat in `vacant`, so it was in BOTH the numerator (its
   *  future lease, via futureCount) and the denominator — self-cancelling.
   *  Making `committed` its own bucket took it out of the denominator and
   *  left its lease in the numerator, so a future lease can now "cover" a
   *  bed that is not in the gap being measured.
   *
   *  The visible consequence: one committed bed beside one genuinely open
   *  bed. The open bed has NO coverage, but the committed bed's lease is
   *  counted against it, so coverage reads 1/1 and the card says leasing is
   *  fine while a bed sits unlet with nothing signed for it.
   *
   *  The fix is a units correction, not a semantic one — the same argument
   *  as row 148: count future leases ON THE BEDS IN THE DENOMINATOR.       */
  const soon = new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10);
  const EXPIRING = (n) => row({ space_id: "exp" + n, unit_number: n,
    cur_lease_id: "L" + n, cur_rent: "900.00", cur_tenant: "Resident " + n, cur_end_date: soon });
  const RENEWING = (n) => row({ space_id: "ren" + n, unit_number: n,
    cur_lease_id: "L" + n, cur_rent: "900.00", cur_tenant: "Resident " + n,
    cur_end_date: soon, fut_lease_id: "F" + n });

  //  THE DEFECT: a committed bed's lease must not cover a different open bed.
  const b = await read([COMMITTED("101"), OPEN("102")]);
  const r = (b.upcoming || {}).risk || {};
  const d = JSON.stringify({ upcoming: b.upcoming, occupancy: b.occupancy });
  ok(r.level === "high",
    "one open bed with nothing signed for it is HIGH risk, not low (got " + r.level + ")", d);
  ok(/only 0 future leases signed/.test(r.reason || ""),
    "and the reason says ZERO future leases cover it — the committed bed's lease is not credited here",
    JSON.stringify(r.reason));

  //  THE CONTROL: a genuine renewal DOES cover its own expiring bed, so the
  //  fix must not simply stop counting future leases.
  const c = await read([RENEWING("201"), EXPIRING("202")]);
  const cr = (c.upcoming || {}).risk || {};
  const cd = JSON.stringify({ upcoming: c.upcoming, occupancy: c.occupancy });
  ok(cr.level === "watch" || cr.level === "high",
    "two beds expiring with one renewal signed is not 'low' — half the gap is uncovered (got " + cr.level + ")", cd);
  ok(/1 future/.test(cr.reason || "") || /only 1 future/.test(cr.reason || ""),
    "and exactly one future lease is credited, because it covers an expiring bed", JSON.stringify(cr.reason));

  //  And fully renewed is genuinely covered: every expiring bed has a future.
  const e = await read([RENEWING("301"), RENEWING("302")]);
  const er = (e.upcoming || {}).risk || {};
  ok(er.level === "low",
    "every expiring bed renewed is low risk (got " + er.level + ")",
    JSON.stringify({ upcoming: e.upcoming, occupancy: e.occupancy }));
}

console.log("\n== " + pass + " passed, " + fail + " failed ==\n");
process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("HARNESS ERROR:", e && e.stack || e); process.exit(2); });
