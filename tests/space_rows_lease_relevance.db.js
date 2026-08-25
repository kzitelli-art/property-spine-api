/* ════════════════════════════════════════════════════════════════════
   space_rows_lease_relevance.db.js — WHICH LEASES DOES THE POSITION
   READ ACTUALLY NEED?

   `loadSpaceRows()` in src/tenancy/space_position.js carries a correlated
   json_agg pulling EVERY lease ever recorded on a space, unbounded. The
   standing-projection cost gate declares it a HISTORY_WALK and it is one:
   it grows with tenancy turnover forever.

   ── WHY IT IS NOT BOUNDED, AND WHY THAT IS MEASURED HERE ────────────
   The receipt in docs/TENANCY_STANDING_COST_RECEIPT.md argues from
   source that a RECENCY or COUNT bound changes output, because
   position_classifier.js consumes the array at an ARBITRARY asOf
   (datesSpan / isFuture), for the successor search, and for the
   double-let contest guard.

   An argument from source is a claim, not proof (§33: prose is a claim).
   This harness turns it into an observation, in both directions:

     B1  REMOVING A LEASE THAT ENDED BEFORE asOf CHANGES NOTHING.
         So a DATE-RELEVANCE predicate is a real candidate — unlike a
         recency bound — and a future thread does not have to rediscover
         that.

     B2  REMOVING A LEASE THAT SPANS asOf CHANGES THE ANSWER, and
         changes it in the dangerous direction: the bed stops reading as
         contractually occupied. That is the double-let this classifier
         exists to prevent, and it is what a "keep the newest N leases"
         bound would have bought to make a cost gate green.

     B3  REMOVING A FUTURE LEASE CHANGES THE FORWARD ANSWER.
         The interval read is a separate consumer of the same loader, so
         "latest" is wrong for it in the opposite direction from B2.

   B2 and B3 are the ones that must be able to go red for B1 to mean
   anything. A harness that only shows the safe deletion is safe has
   demonstrated nothing.

   ⚠ THIS HARNESS DOES NOT ENDORSE THE DATE BOUND. B1 establishes that
   past leases are not read at a single asOf. It does NOT establish that
   threading asOf into the shared loader is safe — see the receipt's
   second reason, the unfiltered `ins[ins.length - 1]` possession read.

   ── THIS HARNESS USED TO CREATE NOTHING ─────────────────────────────
   It read a property that opening_truth_standing_bound.db.js had built
   and left behind, and it hand-copied that file's lease dates, statuses
   and rents into its own restore path. Two consequences, both measured
   on a freshly migrated database rather than argued:

       alone on a clean database            → FAIL, exit 1, 0 passed
       after the other harness had run      → PASS, 5/5
       delete the retained leases, re-run   → FAIL, exit 1

   It was not an independent proof. It was an echo, and it would have
   gone red for a reason that has nothing to do with lease relevance —
   which is the worst kind of red, because someone would go looking in
   the classifier.

   It now seeds and cleans up for itself through the shared definition in
   tests/tenancy_position_fixture.js, and the restore path reads the
   lease values from there instead of carrying a copy that could drift.

   CLASS 3 — test infrastructure. REMOVAL CONDITION: none.
   Creates, mutates and removes ONLY the ids the fixture owns.
   Local database only.

     SLICE1_DATABASE_URL=postgres://postgres@127.0.0.1:55434/spine_slice1 \
       node tests/space_rows_lease_relevance.db.js
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const path = require("path");
const { Pool } = require("pg");

const URL = process.env.SLICE1_DATABASE_URL
  || "postgres://postgres@127.0.0.1:55434/spine_slice1";
if (!/@(127\.0\.0\.1|localhost)[:/]/.test(URL)) {
  console.error("\n  ✗ REFUSED: local disposable database only.\n");
  process.exit(2);
}

const ROOT = path.join(__dirname, "..");
const { spacePosition } = require(path.join(ROOT, "src/tenancy/space_position.js"));
const { intervalPropertyPositions } = require(path.join(ROOT, "src/tenancy/dated_positions.js"));
const { readTenancyTermStanding } = require(path.join(ROOT, "src/tenancy/tenancy_position_read.js"));
const { forwardLeasingPosition } = require(path.join(ROOT, "src/leasing/forward_leasing_read.js"));
const { forwardRent, _internal: frInternal } = require(path.join(ROOT, "src/leasing/forward_rent.js"));
const fixture = require(path.join(__dirname, "tenancy_position_fixture.js"));

const PROPERTY      = fixture.IDS.PROPERTY;
const LEASE_PAST    = fixture.IDS.LEASE_PAST;    // 2024-01-01 → 2024-12-31, ended
const LEASE_CURRENT = fixture.IDS.LEASE_CURRENT; // 2025-01-01 → 2026-12-31, active
const LEASE_FUTURE  = fixture.IDS.LEASE_FUTURE;  // 2027-01-01 → 2027-12-31, signed
const AS_OF = "2026-08-24";

let pass = 0, fail = 0;
const ok  = (l) => { pass++; console.log(`  ok    ${l}`); };
const bad = (l, d) => { fail++; console.log(`  FAIL  ${l}${d ? "\n        " + d : ""}`); };

/*  Hide a lease by deleting it and putting it back from the fixture's own
    definition. The space_id is read off the row FIRST, because the bed it
    sits on may be a trigger-minted space whose id the fixture did not
    choose — restoring it to a guessed space would put the lease somewhere
    it never was and quietly change what the next probe measures. */
async function withLeaseHidden(pool, leaseId, fn) {
  const saved = (await pool.query(`select space_id from leases where id=$1`, [leaseId])).rows[0];
  if (!saved) throw new Error(`fixture lease ${leaseId} missing after seed — the fixture did not build`);
  await pool.query(`delete from leases where id=$1`, [leaseId]);
  try { return await fn(); }
  finally { await fixture.restoreLease(pool, leaseId, saved.space_id); }
}

const asOfShape = async (pool) =>
  JSON.stringify((await spacePosition(pool, { property_id: PROPERTY, as_of: AS_OF })).positions);
const forwardShape = async (pool) =>
  JSON.stringify((await intervalPropertyPositions(pool, {
    property_id: PROPERTY, requested_start: "2027-03-01", requested_end: "2027-06-30",
  })).positions);

(async () => {
  const pool = new Pool({ connectionString: URL });
  console.log("\nLEASE RELEVANCE — what loadSpaceRows' unbounded array is actually read for\n");
  try {
    await fixture.seed(pool);

    const baseAsOf = await asOfShape(pool);
    const baseFwd  = await forwardShape(pool);
    console.log(`  baseline captured at as_of=${AS_OF} and forward 2027-03-01..2027-06-30\n`);

    // ── B1 · the safe deletion ────────────────────────────────────────
    await withLeaseHidden(pool, LEASE_PAST, async () => {
      const now = await asOfShape(pool);
      if (now === baseAsOf) ok("B1 · a lease that ENDED before as_of changes nothing — date relevance is a real candidate");
      else bad("B1 · removing a past lease CHANGED the as-of answer", "the date-relevance bound is not viable either");
    });

    // ── B2 · the deletion that must break it ──────────────────────────
    await withLeaseHidden(pool, LEASE_CURRENT, async () => {
      const now = await asOfShape(pool);
      if (now !== baseAsOf) {
        const before = JSON.parse(baseAsOf).find((p) => p.economic_tenancy_state === "active");
        const after  = JSON.parse(now).find((p) => String(p.space_id) === String(before.space_id));
        ok(`B2 · removing the SPANNING lease changes the answer — ${before.economic_tenancy_state} → ${after.economic_tenancy_state}`);
        /*  ⚠ I PREDICTED "none" AND THE DATABASE SAID "forward". Kept as
         *  the assertion because the corrected answer is the sharper one:
         *  the 2027 lease is still on the bed, so the classifier falls
         *  through to `future` and the bed reads as EMPTY NOW WITH SOMEONE
         *  COMING LATER. A bed someone is living in today, presented as
         *  available today, is a more plausible-looking double-let than a
         *  blank would be — it comes with a story. What matters is not
         *  which label replaces `active`; it is that
         *  `current_lease_position` goes null. */
        if (after.current_lease_position === null && after.economic_tenancy_state !== "active")
          ok("B2 · and in the dangerous direction: current_lease_position → null, the bed reads as not occupied NOW");
        else bad("B2 · expected the bed to lose its CURRENT lease position",
                 JSON.stringify({ state: after.economic_tenancy_state, current: after.current_lease_position }));
      } else bad("B2 · removing the spanning lease changed NOTHING", "this probe has no teeth; B1 proves nothing");
    });

    // ── B3 · the forward consumer disagrees about which lease matters ─
    await withLeaseHidden(pool, LEASE_FUTURE, async () => {
      const now = await forwardShape(pool);
      if (now !== baseFwd) ok("B3 · removing the FUTURE lease changes the forward answer — 'latest' is wrong for the interval read too");
      else bad("B3 · removing the future lease changed nothing in the forward read", "check the interval window against the fixture dates");
    });

    // ── restoration is part of the proof ──────────────────────────────
    if (await asOfShape(pool) === baseAsOf && await forwardShape(pool) === baseFwd)
      ok("restored — both reads match the baseline again");
    else bad("restoration failed", "a probe put the fixture back wrong; the B-results above are not trustworthy");

    /* ══ C · THE INTERVAL DATE CONTRACT ═════════════════════════════════
     *
     *  This harness already drives intervalPropertyPositions against real
     *  Postgres, which makes it the right place to hold the BOUNDARY
     *  contract honest too. Everything below is about what a requested term
     *  may look like — not about which leases matter, which is B above.
     *
     *  ── WHAT WAS MEASURED BEFORE THE REPAIR ─────────────────────────
     *  Through intervalPropertyPositions AND readTenancyTermStanding, on
     *  this fixture, identical through both:
     *
     *    requested_end 2026-99-99     ANSWERED, term echoed "2026-99-99"
     *    requested_end 20260920       ANSWERED, term echoed "20260920"
     *    requested_end …garbage       ANSWERED, silently truncated
     *    requested_start …garbage     refused "requested_end is before
     *                                 requested_start" — a FALSE reason
     *    2026-09-20 → 2026-09-3       ANSWERED — a REVERSED term
     *    …T23:00:00Z → 2026-09-20     refused as reversed, though both
     *                                 boundaries name the same day
     *
     *  requested_end had NO validator at any layer: it never reaches
     *  Postgres (only start does, via openingBaselineAsOf) and never
     *  reaches classifyPosition (only start does, as asOf). So an
     *  impossible date could be handed to an operator inside an
     *  ESTABLISHED term contract.
     *
     *  ── THE TWO THINGS THESE ASSERT ─────────────────────────────────
     *  That malformed boundaries are REFUSED, and that the refusal is
     *  TRUE — it names the field that is actually wrong. A refusal that
     *  blames the other date sends someone to fix a date that was never
     *  broken, which is worse than a blank (§5).                        */
    const TERM_OK_START = "2026-01-01", TERM_OK_END = "2026-12-31";

    const tryInterval = async (s_, e_) => {
      try {
        const iv = await intervalPropertyPositions(pool, {
          property_id: PROPERTY, requested_start: s_, requested_end: e_ });
        return { answered: true, start: iv.requested_start, end: iv.requested_end, count: iv.count };
      } catch (err) { return { answered: false, code: err.code || "(none)", message: String(err.message) }; }
    };

    /*  MALFORMED, EACH BOUNDARY INDEPENDENTLY. The end column is the one
     *  that used to answer every single time.                            */
    const MALFORMED = [
      ["trailing garbage",      "2026-09-20garbage"],
      ["bare T",                "2026-09-20T"],
      ["junk after T",          "2026-09-20Tgarbage"],
      ["leading whitespace",    " 2026-09-20"],
      ["trailing whitespace",   "2026-09-20 "],
      ["unpadded",              "2026-9-20"],
      ["locale form",           "09/20/2026"],
      ["compact numeric",       "20260920"],
      ["impossible day",        "2026-02-31"],
      ["impossible month",      "2026-99-99"],
      ["clock out of range",    "2026-09-20T99:99Z"],
      ["offset out of range",   "2026-09-20T13:45:00+99:00"],
      ["ISO timestamp",         "2026-09-20T13:45:00Z"],
    ];
    let startBad = 0, endBad = 0;
    for (const [label, v] of MALFORMED) {
      const a = await tryInterval(v, TERM_OK_END);
      if (a.answered) { bad(`C1 · requested_start ${label} (${v}) ANSWERED`, `term ${a.start} → ${a.end}`); startBad++; }
      else if (a.code !== "INVALID_INTERVAL") { bad(`C1 · requested_start ${label} refused ${a.code}`, "not the interval contract — a lower layer answered for it"); startBad++; }
      else if (!/requested_start/.test(a.message)) { bad(`C1 · requested_start ${label} refused WITHOUT naming requested_start`, a.message); startBad++; }

      const b = await tryInterval(TERM_OK_START, v);
      if (b.answered) { bad(`C2 · requested_end ${label} (${v}) ANSWERED`, `term ${b.start} → ${b.end}`); endBad++; }
      else if (b.code !== "INVALID_INTERVAL") { bad(`C2 · requested_end ${label} refused ${b.code}`, "not the interval contract"); endBad++; }
      else if (!/requested_end/.test(b.message)) { bad(`C2 · requested_end ${label} refused WITHOUT naming requested_end`, b.message); endBad++; }
    }
    if (!startBad) ok(`C1 · all ${MALFORMED.length} malformed requested_start forms refused INVALID_INTERVAL, each naming requested_start`);
    if (!endBad)   ok(`C2 · all ${MALFORMED.length} malformed requested_end forms refused INVALID_INTERVAL, each naming requested_end`);

    // ── C3 · the four named counterexamples ──────────────────────────
    const rev = await tryInterval("2026-09-20", "2026-09-3");
    if (!rev.answered && rev.code === "INVALID_INTERVAL")
      ok(`C3 · 2026-09-20 → 2026-09-3 is REFUSED, not answered as a term`);
    else bad("C3 · the reversed/malformed-end term was ANSWERED", JSON.stringify(rev));

    /*  THE FALSE-REASON CASE. The start is malformed; the end is a real
     *  day. It must be refused FOR THE START, and must NOT be described as
     *  reversed — that was the old lie.                                  */
    const mis = await tryInterval("2026-09-20T23:00:00Z", "2026-09-20");
    if (!mis.answered && mis.code === "INVALID_INTERVAL"
        && /requested_start/.test(mis.message) && !/precedes/.test(mis.message))
      ok("C3 · a timestamp start with a same-day end is refused FOR requested_start, not falsely called reversed");
    else bad("C3 · malformed start not named truthfully", JSON.stringify(mis));

    const echoed = await tryInterval(TERM_OK_START, "2026-99-99");
    if (!echoed.answered) ok("C3 · 2026-99-99 can no longer be returned as requested_end");
    else bad("C3 · an impossible date came back INSIDE the term", `end=${echoed.end}`);

    const laundered = await tryInterval("2026-09-20garbage", TERM_OK_END);
    if (!laundered.answered) ok("C3 · 2026-09-20garbage can no longer become 2026-09-20");
    else bad("C3 · trailing garbage was truncated into a valid day", `start=${laundered.start}`);

    // ── C4 · a genuinely reversed CANONICAL term says so ─────────────
    const trueRev = await tryInterval("2026-12-31", "2026-01-01");
    if (!trueRev.answered && trueRev.code === "INVALID_INTERVAL" && /precedes/.test(trueRev.message))
      ok("C4 · a reversed CANONICAL term is refused and says the end precedes the start");
    else bad("C4 · reversed canonical term not refused truthfully", JSON.stringify(trueRev));

    // ── C5 · legitimate terms still answer ───────────────────────────
    const fwd = await tryInterval(TERM_OK_START, TERM_OK_END);
    if (fwd.answered && fwd.start === TERM_OK_START && fwd.end === TERM_OK_END)
      ok(`C5 · an ordinary forward term still answers — ${fwd.start} → ${fwd.end}, count=${fwd.count}`);
    else bad("C5 · a valid forward term stopped answering", JSON.stringify(fwd));

    const sameDay = await tryInterval("2026-09-20", "2026-09-20");
    if (sameDay.answered && sameDay.start === sameDay.end)
      ok("C5 · a legitimate same-day term still answers");
    else bad("C5 · the same-day term was refused", JSON.stringify(sameDay));

    // ── C6 · the canonical TERM READ inherits all of it ──────────────
    /*  readTenancyTermStanding is the governed term contract an entitled
     *  reader receives. The malformed end used to arrive there as
     *  state=ESTABLISHED with the junk echoed in `term`.                 */
    const termTry = async (s_, e_) => {
      try {
        const t = await readTenancyTermStanding(pool, {
          property_id: PROPERTY, requested_start: s_, requested_end: e_ });
        return { answered: true, term: t.term, state: t.standing && t.standing.truth_state };
      } catch (err) { return { answered: false, code: err.code || "(none)" }; }
    };
    const tBad = await termTry(TERM_OK_START, "2026-99-99");
    if (!tBad.answered && tBad.code === "INVALID_INTERVAL")
      ok("C6 · readTenancyTermStanding refuses the impossible end — no ESTABLISHED contract carrying junk");
    else bad("C6 · the term contract answered with a malformed end",
             JSON.stringify({ term: tBad.term, state: tBad.state }));
    const tOk = await termTry(TERM_OK_START, TERM_OK_END);
    if (tOk.answered && tOk.term.requested_start === TERM_OK_START && tOk.term.requested_end === TERM_OK_END)
      ok(`C6 · and a valid term still answers — ${tOk.term.requested_start} → ${tOk.term.requested_end}, ${tOk.state}`);
    else bad("C6 · a valid term stopped answering through the term read", JSON.stringify(tOk));

    /* ══ D · A CLAIM WITH NO PLACE IN TIME IS NOT CONTRACTUAL FREEDOM ═══
     *
     *  leases.start_date is NULLABLE and leaseIsValid checks only the
     *  status, so a NON-TERMINAL lease with no usable start date reaches
     *  the interval classifier and can never collide — rangesOverlap opens
     *  `if (!a.start_date || !b.start_date) return false`, which is correct
     *  for a geometric predicate over two ranges and is also called from
     *  src/leasing/tracker_intake.js, outside this lane.
     *
     *  Measured before the repair: an ACTIVE lease with a named resident
     *  and start_date NULL produced interval_state `contractually_free` —
     *  the exact value leasing_inventory filters on to build PROSPECT
     *  inventory. So the bed was offerable to a real person on the strength
     *  of a lease Spine could not read.
     *
     *  D2/D3 ARE THE CONTROLS AND THEY CARRY THE DESIGN. A repair that
     *  caught the undated claim by widening the collision test would turn
     *  a genuinely free future term unfree (D2) and would flatten a
     *  definite block into `unresolved` (D3). Both must hold.            */
    const FREE_S = "2028-01-01", FREE_E = "2028-06-30";   // beyond every fixture lease
    const UNDATED = "51ce0001-0000-4000-8000-0000000009f1";
    const anchorSpace = (await pool.query(
      `select space_id from leases where id=$1`, [LEASE_CURRENT])).rows[0].space_id;

    const ivState = async (s_, e_) => {
      const iv = await intervalPropertyPositions(pool, {
        property_id: PROPERTY, requested_start: s_, requested_end: e_ });
      const p = iv.positions.find((x) => String(x.space_id) === String(anchorSpace));
      return p && p.interval_state;
    };

    const freeBefore = await ivState(FREE_S, FREE_E);
    if (freeBefore === "contractually_free")
      ok(`D1 · baseline — ${FREE_S}→${FREE_E} is genuinely contractually_free on this bed`);
    else bad("D1 · baseline term is not free; the rest of D cannot mean anything", String(freeBefore));

    await pool.query(
      `insert into leases (id, property_id, space_id, tenant_ids, rent, balance,
                           start_date, end_date, lease_status)
       values ($1,$2,$3,$4::uuid[],1000,0,NULL,NULL,'active')`,
      [UNDATED, PROPERTY, anchorSpace, [fixture.IDS.PERSON]]);
    try {
      const withUndated = await ivState(FREE_S, FREE_E);
      if (withUndated !== "contractually_free")
        ok(`D1 · an undated non-terminal lease leaves contractually_free — now ${withUndated}`);
      else bad("D1 · an ACTIVE lease with start_date NULL still reads contractually_free",
               "leasing_inventory filters on exactly this value to build prospect inventory");

      // ── D2 · a genuinely free future term must STAY free ─────────────
      /*  Same undated lease still present. If the repair keyed on anything
       *  wider than unplaceability it would take this away too.          */
      const stillBlockedNear = await ivState("2026-06-01", "2026-09-30");
      if (stillBlockedNear === "term_blocked" || stillBlockedNear === "term_partially_blocked")
        ok(`D3 · CONTROL — a dated lease still blocks its own term definitely (${stillBlockedNear}), not flattened to unresolved`);
      else bad("D3 · a definite collision lost its specific answer", String(stillBlockedNear));
    } finally {
      await pool.query(`delete from leases where id=$1`, [UNDATED]);
    }

    // ── D2 · controls with the undated claim REMOVED ──────────────────
    const freeAfter = await ivState(FREE_S, FREE_E);
    if (freeAfter === "contractually_free")
      ok("D2 · CONTROL — with the undated claim gone the term is free again; nothing was made permanently unfree");
    else bad("D2 · the free term did not recover after removing the undated lease", String(freeAfter));

    /*  The fixture's PAST lease is terminal (ended) and its FUTURE lease is
     *  dated: neither may be mistaken for an unplaceable claim.          */
    const endedAndFutureOk = await ivState("2028-07-01", "2028-12-31");
    if (endedAndFutureOk === "contractually_free")
      ok("D2 · CONTROL — ended and dated-future fixture leases still leave a later term free");
    else bad("D2 · an ended or dated future lease was treated as unplaceable", String(endedAndFutureOk));

    /* ══ E · A PARTIAL BLOCK PLUS AN UNPLACEABLE CLAIM IS NOT PARTIAL ═══
     *
     *  freeSpans() computes the gaps the DATED collisions leave. Those gaps
     *  are only trustworthy if EVERY right on the bed is dated. An undated
     *  non-terminal claim could sit anywhere in the requested term —
     *  including inside a span about to be published as free — and Spine
     *  cannot know which. Publishing spans it cannot stand behind is worse
     *  than publishing none: a caller reads dates it can act on and nothing
     *  in the payload says they are guesses.
     *
     *  Every branch below has a NAMED control, because the danger of this
     *  correction is over-suppression: turning a legitimate partial answer
     *  or a certain complete block into a vague refusal would tell an
     *  operator LESS than Spine knows.                                    */
    const ivFull = async (s_, e_) => {
      const iv = await intervalPropertyPositions(pool, {
        property_id: PROPERTY, requested_start: s_, requested_end: e_ });
      return iv.positions.find((x) => String(x.space_id) === String(anchorSpace));
    };
    const UND2 = "51ce0001-0000-4000-8000-0000000009f2";
    const addUndated = (id, status) => pool.query(
      `insert into leases (id, property_id, space_id, tenant_ids, rent, balance,
                           start_date, end_date, lease_status)
       values ($1,$2,$3,$4::uuid[],1000,0,NULL,NULL,$5)`,
      [id, PROPERTY, anchorSpace, [fixture.IDS.PERSON], status]);

    /*  A term the fixture's dated leases only PARTIALLY block. My first
     *  window was 2026-12-01 → 2027-06-30 and it went red honestly: the
     *  fixture's 2025-01-01→2026-12-31 and 2027-01-01→2027-12-31 leases are
     *  CONSECUTIVE, so that window has no gap and is term_blocked. This one
     *  straddles the END of the 2027 lease, leaving a real free span in
     *  2028 for freeSpans() to compute.                                   */
    const PS = "2027-10-01", PE = "2028-03-31";

    // ── E1 · CONTROL — partial WITHOUT an undated claim stays partial ──
    const partialAlone = await ivFull(PS, PE);
    if (partialAlone.interval_state === "term_partially_blocked" && (partialAlone.free_spans || []).length)
      ok(`E1 · CONTROL — a partial dated collision alone stays term_partially_blocked with ${partialAlone.free_spans.length} legitimate free span(s)`);
    else bad("E1 · the baseline partial term is not partial; E2 cannot mean anything",
             JSON.stringify({ state: partialAlone.interval_state, spans: partialAlone.free_spans }));

    // ── E2 · partial + undated claim → unresolved, NO free spans ──────
    await addUndated(UND2, "active");
    try {
      const partialPlus = await ivFull(PS, PE);
      if (partialPlus.interval_state === "unresolved")
        ok("E2 · a partial dated collision PLUS an unplaceable claim is unresolved, not partially blocked");
      else bad(`E2 · still ${partialPlus.interval_state} with an unplaceable claim present`,
               "free spans computed from dated rights alone are not trustworthy here");
      if ((partialPlus.free_spans || []).length === 0)
        ok("E2 · and it publishes NO free_spans — Spine does not offer dates it cannot stand behind");
      else bad("E2 · untrustworthy free_spans were published", JSON.stringify(partialPlus.free_spans));

      // ── E3 · the explanatory collection names the unplaceable right ──
      const up = partialPlus.unplaceable_rights || [];
      if (up.length && String(up[0].lease_id) === UND2 && "lease_status" in up[0])
        ok(`E3 · unplaceable_rights names the claim in the existing right shape — ${up[0].lease_id.slice(0,8)} / ${up[0].lease_status}`);
      else bad("E3 · the refusal does not say WHICH claim could not be placed", JSON.stringify(up));

      // ── E4 · CONTROL — dated colliding_rights are preserved ─────────
      if ((partialPlus.colliding_rights || []).length === (partialAlone.colliding_rights || []).length
          && (partialPlus.colliding_rights || []).length > 0)
        ok(`E4 · CONTROL — the dated colliding_rights are preserved (${partialPlus.colliding_rights.length})`);
      else bad("E4 · dated collision evidence was lost", JSON.stringify({
        before: (partialAlone.colliding_rights || []).length,
        after: (partialPlus.colliding_rights || []).length }));

      // ── E5 · CONTROL — a COMPLETE dated block stays term_blocked ────
      /*  2027-02-01 → 2027-06-30 sits entirely inside the 2027 lease. The
       *  term is taken whatever the undated claim turns out to be, so the
       *  certain answer must survive.                                     */
      const fullBlock = await ivFull("2027-02-01", "2027-06-30");
      if (fullBlock.interval_state === "term_blocked")
        ok("E5 · CONTROL — a COMPLETE dated block stays term_blocked; certainty is not downgraded to unresolved");
      else bad(`E5 · a certain complete block became ${fullBlock.interval_state}`,
               "this tells an operator less than Spine knows");
    } finally {
      await pool.query(`delete from leases where id=$1`, [UND2]);
    }

    // ── E6 · CONTROL — a TERMINAL undated row does not poison anything ─
    const TERM_UND = "51ce0001-0000-4000-8000-0000000009f3";
    await addUndated(TERM_UND, "cancelled");
    try {
      const withTerminal = await ivFull(PS, PE);
      if (withTerminal.interval_state === "term_partially_blocked"
          && (withTerminal.free_spans || []).length)
        ok("E6 · CONTROL — a TERMINAL undated row does not poison the answer; the partial term is still partial");
      else bad(`E6 · a terminal undated lease changed the answer to ${withTerminal.interval_state}`,
               "leaseIsValid excludes terminal statuses; they are not unplaceable claims");
      if ((withTerminal.unplaceable_rights || []).length === 0)
        ok("E6 · and it is not listed as an unplaceable right");
      else bad("E6 · a terminal row was reported as an unplaceable claim", JSON.stringify(withTerminal.unplaceable_rights));
    } finally {
      await pool.query(`delete from leases where id=$1`, [TERM_UND]);
    }

    // ── E7 · CONTROL — a clean free term is still free, with no rights ─
    const cleanFree = await ivFull("2028-01-01", "2028-06-30");
    if (cleanFree.interval_state === "contractually_free"
        && (cleanFree.unplaceable_rights || []).length === 0)
      ok("E7 · CONTROL — a genuinely free term is still contractually_free with no unplaceable rights");
    else bad("E7 · a free term was disturbed", JSON.stringify({
      state: cleanFree.interval_state, up: cleanFree.unplaceable_rights }));

    /* ══ F · THE REFUSAL MUST TRAVEL, NOT JUST THE WORD ════════════════
     *
     *  E proved the CLASSIFIER now knows why an interval is unresolved.
     *  This proves the first consumer above it does not throw that away.
     *
     *  forwardLeasingPosition reduced every such bed to
     *  `commitment_state: unresolved` and stopped. Measured on this
     *  fixture before the change: the ledger row carried no
     *  unplaceable_rights, no reason, and the payload had no collection of
     *  unresolved beds at all — so "why is 101A a question?" was
     *  answerable only by re-running the classifier by hand.
     *
     *  Three reasons are produced SEPARATELY, because a single fixture
     *  that happens to trigger all three at once would not show that the
     *  precedence picks the right one:
     *
     *      unplaceable_rights        an undated non-terminal claim
     *      overlapping_rights        two dated rights contesting the term
     *      unrecognized_lease_status a status this read does not know
     *
     *  F1 is the control and it runs FIRST: if the baseline cycle already
     *  contained an unresolved bed, every assertion below would pass
     *  without the change meaning anything.                              */
    const CYC_S = "2027-10-01", CYC_E = "2028-03-31";
    const cycleLedger = () => forwardLeasingPosition(pool, {
      property_id: PROPERTY, cycle_start: CYC_S, cycle_end: CYC_E,
      //  The tracker overlay is a different layer with its own proof and
      //  its own failure mode. Excluding it keeps this measuring carriage
      //  from the classifier and not the claim join.
      include_claims: false,
    });
    const rowOf = (f, unit, label) =>
      f.ledger.find((r) => r.unit_number === unit && r.space_label === label);
    /*  READ THE COLLECTION DEFENSIVELY, for the same reason carriesWhy
     *  does: if it is ever removed, every assertion below must report what
     *  is missing on its own line rather than one of them killing the run
     *  and hiding the other five.                                        */
    const entryOf = (f, unit, label) => (f.unresolved_positions || [])
      .find((x) => x.unit_number === unit && x.space_label === label);

    /*  ONE INVARIANT, CHECKED IN EVERY ARM. The collection must be exactly
     *  the unresolved rows — no more, no fewer — and no entry may be a
     *  refusal with nothing to act on. `unresolved_reason` alone cannot
     *  carry that: dated_positions also refuses for `opening_evidence_
     *  disagrees` and `opening_position_unreconciled`, which this read's
     *  four-value vocabulary has no word for, so the canonical
     *  `unresolved_because` rides along and either one satisfies it. */
    const carriesWhy = (f, tag) => {
      const n = f.ledger.filter((r) => r.commitment_state === "unresolved").length;
      /*  A MISSING COLLECTION IS A NAMED FAILURE, NOT A CRASH. The first
       *  version read `.length` straight off it, so removing the carriage
       *  killed the harness at this line and F2–F9 never ran — a red that
       *  reported one TypeError instead of the six things that had gone
       *  missing. Found by running the falsification locally before
       *  pushing it, which is the only reason this line reads this way. */
      if (!Array.isArray(f.unresolved_positions)) {
        bad(`F8 · ${tag} — the payload carries no unresolved_positions collection at all`,
            `typeof ${typeof f.unresolved_positions}`);
        return;
      }
      if (f.unresolved_positions.length === n && f.headline.unresolved === n)
        ok(`F8 · ${tag} — unresolved_positions is exactly the unresolved ledger rows (${n}) and ties to the headline`);
      else bad(`F8 · ${tag} — the collection and the ledger disagree`, JSON.stringify({
        collection: f.unresolved_positions.length, ledger: n, headline: f.headline.unresolved }));
      const mute = f.unresolved_positions
        .filter((x) => !x.unresolved_reason && !x.contract_unresolved_because);
      if (mute.length === 0) ok(`F8 · ${tag} — no unresolved bed is reported without a reason`);
      else bad(`F8 · ${tag} — ${mute.length} unresolved bed(s) carry no reason at all`, JSON.stringify(mute));
    };

    // ── F1 · CONTROL — the baseline cycle has nothing unresolved ───────
    /*  STRICTLY ABOUT THE POPULATION. An earlier version folded the
     *  key-presence check into this control, so removing the carriage made
     *  F1 announce "the baseline already carries an unresolved bed" — a
     *  true failure with a false cause, pointing whoever read it at the
     *  fixture instead of at the missing field.                          */
    const fBase = await cycleLedger();
    const base101A = rowOf(fBase, "101", "A");
    if (fBase.headline.unresolved === 0 && base101A && base101A.commitment_state === "signed")
      ok("F1 · CONTROL — the baseline cycle is signed on 101A with no unresolved beds; F2–F7 can mean something");
    else bad("F1 · the baseline already carries an unresolved bed", JSON.stringify({
      unresolved: fBase.headline.unresolved,
      row: base101A && { s: base101A.commitment_state } }));

    /*  ── F1b · THE CARRIAGE EXISTS AT ALL ─────────────────────────────
     *  Named separately and by key, because this is the assertion that
     *  must go red — and say WHY — if the carriage is ever removed. The
     *  three keys are on EVERY row, unresolved or not, so a payload where
     *  they appear only on questions has half-implemented the contract. */
    const KEYS = ["unresolved_reason", "unplaceable_rights", "contract_unresolved_because"];
    const missingKeys = KEYS.filter((k) => !fBase.ledger.every((r) => k in r));
    if (missingKeys.length === 0 && Array.isArray(fBase.unresolved_positions))
      ok(`F1b · every ledger row carries ${KEYS.join(", ")}, and the payload carries unresolved_positions`);
    else bad("F1b · the evidence carriage is absent from the payload", JSON.stringify({
      missing_row_keys: missingKeys,
      unresolved_positions: Array.isArray(fBase.unresolved_positions) ? "present" : "ABSENT" }));

    //  …and on a settled row it is explicitly null, not merely absent. A
    //  reader cannot tell "no reason" from "field never written" (§5).
    if (base101A && base101A.unresolved_reason === null
        && Array.isArray(base101A.unplaceable_rights) && base101A.unplaceable_rights.length === 0)
      ok("F1b · a settled row says null and an empty array, not undefined");
    else bad("F1b · a settled row does not state its emptiness", JSON.stringify(base101A && {
      r: base101A.unresolved_reason, up: base101A.unplaceable_rights }));
    carriesWhy(fBase, "baseline");

    // ── F2/F3/F4/F5 · an unplaceable claim reaches the ledger ──────────
    const UND3 = "51ce0001-0000-4000-8000-0000000009f7";
    await addUndated(UND3, "active");
    try {
      const f = await cycleLedger();
      const row = rowOf(f, "101", "A");
      if (row && row.commitment_state === "unresolved" && row.unresolved_reason === "unplaceable_rights")
        ok("F2 · the ledger row says WHY it is unresolved — unplaceable_rights");
      else bad("F2 · the reason did not reach the ledger row", JSON.stringify(row && {
        s: row.commitment_state, r: row.unresolved_reason }));

      const up = row && (row.unplaceable_rights || []);
      if (up && up.length === 1 && String(up[0].lease_id) === UND3 && up[0].lease_status === "active")
        ok(`F3 · and it names the claim itself — ${UND3.slice(0, 8)} / active, in the canonical right shape`);
      else bad("F3 · the unplaceable claim was not carried onto the row", JSON.stringify(up));

      const entry = entryOf(f, "101", "A");
      if ((f.unresolved_positions || []).length === 1 && entry
          && entry.unresolved_reason === "unplaceable_rights"
          && (entry.unplaceable_rights || []).length === 1)
        ok("F4 · the top-level collection names the bed, the reason and the claim");
      else bad("F4 · the collection does not carry the bed", JSON.stringify(f.unresolved_positions || null));

      /*  ⚠ ADDED, NOT SUBSTITUTED. The signed lease that partially blocks
       *  this term is still the reason the bed is not open, and an answer
       *  that shows only the unplaceable claim has traded one missing half
       *  of the story for the other. */
      if (entry && (entry.colliding_rights || []).length === 1
          && entry.colliding_rights[0].lease_status === "signed")
        ok("F5 · CONTROL — the dated signed right is carried BESIDE it, not replaced by it");
      else bad("F5 · the dated collision evidence was dropped from the collection",
               JSON.stringify(entry && entry.colliding_rights));
      carriesWhy(f, "unplaceable");
    } finally {
      await pool.query(`delete from leases where id=$1`, [UND3]);
    }

    /*  ── F6 · A STATUS THIS READ DOES NOT RECOGNISE ────────────────────
     *  On space B of unit 101, which carries no fixture lease, so the row
     *  is unresolved for exactly one reason. The interval itself is NOT
     *  unresolved here — it is term_partially_blocked — which is what
     *  proves the reason came from this read's own status path and was not
     *  copied off interval_state.                                        */
    const ODD = "51ce0001-0000-4000-8000-0000000009f8";
    const spaceB = fixture.IDS.SPACE_A2;
    await pool.query(
      `insert into leases (id, property_id, space_id, tenant_ids, rent, balance,
                           start_date, end_date, lease_status)
       values ($1,$2,$3,$4::uuid[],1200,0,'2027-11-01','2028-02-01','holdover_pending')`,
      [ODD, PROPERTY, spaceB, [fixture.IDS.PERSON]]);
    try {
      const f = await cycleLedger();
      const row = rowOf(f, "101", "B");
      if (row && row.commitment_state === "unresolved"
          && row.unresolved_reason === "unrecognized_lease_status"
          && row.contract_position === "term_partially_blocked")
        ok("F6 · an unrecognised status reads unrecognized_lease_status while the INTERVAL stays term_partially_blocked");
      else bad("F6 · the unrecognised-status arm did not resolve to its own reason", JSON.stringify(row && {
        s: row.commitment_state, r: row.unresolved_reason, c: row.contract_position }));
      carriesWhy(f, "unrecognised status");
    } finally {
      await pool.query(`delete from leases where id=$1`, [ODD]);
    }

    /*  ── F7 · TWO DATED RIGHTS CONTESTING THE SAME TERM ────────────────
     *  This arm carries the second half of the contract: dated_positions
     *  sets `unresolved_because: overlapping_claims`, and that canonical
     *  word must arrive verbatim rather than being re-derived or dropped. */
    const CON1 = "51ce0001-0000-4000-8000-0000000009f9";
    const CON2 = "51ce0001-0000-4000-8000-000000000a01";
    for (const [id, st, en] of [[CON1, "2027-11-01", "2028-02-01"], [CON2, "2027-12-01", "2028-03-01"]]) {
      await pool.query(
        `insert into leases (id, property_id, space_id, tenant_ids, rent, balance,
                             start_date, end_date, lease_status)
         values ($1,$2,$3,$4::uuid[],1200,0,$5,$6,'signed')`,
        [id, PROPERTY, spaceB, [fixture.IDS.PERSON], st, en]);
    }
    try {
      const f = await cycleLedger();
      const row = rowOf(f, "101", "B");
      if (row && row.unresolved_reason === "overlapping_rights")
        ok("F7 · a contested term reads overlapping_rights");
      else bad("F7 · the contested arm did not resolve to overlapping_rights",
               JSON.stringify(row && { s: row.commitment_state, r: row.unresolved_reason }));
      if (row && row.contract_unresolved_because === "overlapping_claims")
        ok("F7 · and the canonical unresolved_because arrives verbatim, not re-derived");
      else bad("F7 · the canonical reason was dropped on the way up",
               JSON.stringify(row && row.contract_unresolved_because));
      const entry = entryOf(f, "101", "B");
      if (entry && (entry.colliding_rights || []).length === 2)
        ok("F7 · the collection names BOTH contesting rights — a contest is unreadable without them");
      else bad("F7 · the contesting rights are not in the collection",
               JSON.stringify(entry && entry.colliding_rights));
      carriesWhy(f, "contested");
    } finally {
      await pool.query(`delete from leases where id = any($1::uuid[])`, [[CON1, CON2]]);
    }

    /*  ── F9 · CONTROL — the read is back where it started ──────────────
     *  Every arm above added rows and removed them. If the ledger does not
     *  return to the F1 answer, something above leaked and the greens are
     *  measuring a database nobody described.                            */
    const fEnd = await cycleLedger();
    if (fEnd.headline.unresolved === 0 && (fEnd.unresolved_positions || []).length === 0
        && JSON.stringify(fEnd.headline) === JSON.stringify(fBase.headline))
      ok("F9 · CONTROL — with every probe row removed the ledger is identical to F1");
    else bad("F9 · the fixture did not return to its baseline", JSON.stringify({
      before: fBase.headline, after: fEnd.headline,
      collection: (fEnd.unresolved_positions || []).length }));

    /* ══ G · THE EXPLANATION SURVIVES THE ECONOMIC READING ═════════════
     *
     *  F proved forwardLeasingPosition says WHY a bed is unresolved.
     *  forward_rent.js is the next consumer and the last one before the
     *  conversational reader, and it returned `forward_leasing:
     *  position.headline` — seven numbers. Measured on this fixture
     *  before the change: `unresolved: 2` with no way to learn which two
     *  beds or what would resolve them. The compact collection died one
     *  module short of the reader that needs it most.
     *
     *  WHAT THIS SECTION IS NOT. It is not a second proof that the
     *  reasons are right — F owns that, directly against the classifier's
     *  consumer. G proves PASS-THROUGH FIDELITY: that what arrives is
     *  the canonical object, unchanged, and that nothing else in the
     *  economic payload moved to make room for it.
     *
     *  THE POPULATION IS DELIBERATE. One genuinely SIGNED bed sits beside
     *  the two unresolved ones, so an implementation that turned the whole
     *  projection unresolved — or that carried a collection by rebuilding
     *  it from every row — cannot pass G1 and G5.                       */
    const cycleRent = () => forwardRent(pool, {
      property_id: PROPERTY, cycle_start: CYC_S, cycle_end: CYC_E });
    const spaceB1 = (await pool.query(
      `select s.id from spaces s join units u on u.id = s.unit_id
        where u.property_id = $1 and u.unit_number = '102'`, [PROPERTY])).rows[0].id;

    const UNP = "51ce0001-0000-4000-8000-000000000b01";
    const CN1 = "51ce0001-0000-4000-8000-000000000b02";
    const CN2 = "51ce0001-0000-4000-8000-000000000b03";
    const ODD2 = "51ce0001-0000-4000-8000-000000000b04";
    const addDated = (id, space, st, en, status) => pool.query(
      `insert into leases (id, property_id, space_id, tenant_ids, rent, balance,
                           start_date, end_date, lease_status)
       values ($1,$2,$3,$4::uuid[],1200,0,$5,$6,$7)`,
      [id, PROPERTY, space, [fixture.IDS.PERSON], st, en, status]);

    /*  ⚠ THE UNPLACEABLE CLAIM GOES ON SPACE B, NOT ON THE ANCHOR. Put on
     *  101A it would take the fixture's signed lease with it and leave the
     *  section with no resolved row at all — the exact vacuous shape G
     *  exists to rule out. */
    await pool.query(
      `insert into leases (id, property_id, space_id, tenant_ids, rent, balance,
                           start_date, end_date, lease_status)
       values ($1,$2,$3,$4::uuid[],1000,0,NULL,NULL,'active')`,
      [UNP, PROPERTY, fixture.IDS.SPACE_A2, [fixture.IDS.PERSON]]);
    await addDated(CN1, spaceB1, "2027-11-01", "2028-02-01", "signed");
    await addDated(CN2, spaceB1, "2027-12-01", "2028-03-01", "signed");

    /*  Every key that appears anywhere in the payload, at any depth. A
     *  substring search over the JSON would match the word inside a prose
     *  field and report a ledger that is not there — a mention is not a
     *  guard. */
    const allKeys = (v, into = new Set()) => {
      if (Array.isArray(v)) { v.forEach((x) => allKeys(x, into)); return into; }
      if (!v || typeof v !== "object") return into;
      for (const [k, child] of Object.entries(v)) { into.add(k); allKeys(child, into); }
      return into;
    };
    //  Fields that exist ONLY on a ledger row. If any of these reach the
    //  economic payload, the collection was built by copying rows.
    const LEDGER_ONLY = ["commitment_state", "contracted_rent", "rent_state", "claim_state",
                         "operating_state", "proof", "contract_position", "term_shape"];

    try {
      const pos = await cycleLedger();          // the canonical position
      const fr = await cycleRent();             // the economic reading of it

      // ── G1 · REQ 7 — a genuinely resolved positive row is present ────
      if (pos.headline.signed === 1 && pos.headline.unresolved === 2
          && fr.forward_leasing.signed === 1 && fr.forward_leasing.committed === 1)
        ok("G1 · CONTROL — one genuinely SIGNED bed beside two unresolved ones; an all-unresolved projection cannot pass G");
      else bad("G1 · the population is not mixed; the rest of G would be vacuous",
               JSON.stringify({ canonical: pos.headline, carried: fr.forward_leasing }));

      // ── G2 · REQ 1 — the count is the canonical count ────────────────
      if (fr.forward_leasing.unresolved === pos.headline.unresolved)
        ok(`G2 · forward_leasing.unresolved equals the canonical Forward Leasing count (${pos.headline.unresolved})`);
      else bad("G2 · the carried unresolved count is not the canonical one", JSON.stringify({
        canonical: pos.headline.unresolved, carried: fr.forward_leasing.unresolved }));

      // ── G3 · REQ 2 — the collection is the canonical object ──────────
      const canonical = JSON.stringify(pos.unresolved_positions);
      const carried = JSON.stringify(fr.forward_leasing.unresolved_positions);
      if (carried === canonical && pos.unresolved_positions.length === 2)
        ok("G3 · forward_leasing.unresolved_positions is DEEP-EQUAL to the canonical compact collection, across two different reasons");
      else bad("G3 · the carried collection is not the canonical one", JSON.stringify({
        canonical: canonical && canonical.slice(0, 200), carried: carried && carried.slice(0, 200) }));

      // ── G4 · REQ 3 — every named field survives, checked BY NAME ─────
      const REQUIRED = ["unit_number", "space_label", "unresolved_reason",
                        "contract_unresolved_because", "unplaceable_rights", "colliding_rights"];
      /*  ABSENT AND INCOMPLETE ARE DIFFERENT FAILURES. The first version
       *  read `(… || [])` and then checked the fields, so a missing
       *  collection reported "a carried position lost a named field" with
       *  an empty detail — a true failure naming a cause that did not
       *  happen. Found by dry-running the falsification before pushing it. */
      const positionsOut = fr.forward_leasing.unresolved_positions;
      if (!Array.isArray(positionsOut) || positionsOut.length !== 2) {
        bad("G4 · there is no carried collection to check fields on",
            `expected 2 carried positions, got ${Array.isArray(positionsOut) ? positionsOut.length : typeof positionsOut}`);
      } else {
        const short = positionsOut
          .map((x) => REQUIRED.filter((k) => !(k in x))).filter((m) => m.length);
        if (short.length === 0) ok(`G4 · every carried position preserves ${REQUIRED.join(", ")}`);
        else bad("G4 · a carried position lost a named field", JSON.stringify(short));
      }

      /*  …and the VALUES, not only the keys. A carriage that preserved the
       *  shape while blanking the causes would satisfy G4 and tell a
       *  reader nothing. Both reasons must arrive, and the canonical
       *  `overlapping_claims` must arrive with the one it belongs to. */
      const byBed = Object.fromEntries((fr.forward_leasing.unresolved_positions || [])
        .map((x) => [`${x.unit_number}${x.space_label}`, x]));
      const unp = byBed["101B"], con = byBed["102A"];
      if (unp && unp.unresolved_reason === "unplaceable_rights" && unp.unplaceable_rights.length === 1
          && con && con.unresolved_reason === "overlapping_rights"
          && con.contract_unresolved_because === "overlapping_claims"
          && con.colliding_rights.length === 2)
        ok("G4 · and the values arrive intact — unplaceable_rights on 101B, overlapping_rights + overlapping_claims with both rights on 102A");
      else bad("G4 · the carried causes are not the canonical causes", JSON.stringify({ unp, con }));

      // ── G5 · REQ 6 — the headline is untouched and nothing else added ─
      const { unresolved_positions: _carried, ...headlineOnly } = fr.forward_leasing;
      if (JSON.stringify(headlineOnly) === JSON.stringify(pos.headline))
        ok("G5 · forward_leasing MINUS the new key is deep-equal to the canonical headline — positions, signed, pending, committed, remaining, unresolved, committed_pct all unmoved");
      else bad("G5 · an existing headline field changed shape or meaning", JSON.stringify({
        canonical: pos.headline, carried: headlineOnly }));
      const added = Object.keys(fr.forward_leasing).filter((k) => !(k in pos.headline));
      if (added.length === 1 && added[0] === "unresolved_positions")
        ok("G5 · and exactly ONE key was added; nothing was renamed or smuggled in beside it");
      //  GAINED NOTHING and GAINED THE WRONG THING are different defects
      //  and must not share a sentence — the first is the carriage being
      //  absent, the second is this module inventing a field.
      else if (added.length === 0)
        bad("G5 · forward_leasing carries the headline and NOTHING else — the explanation never arrived",
            "unresolved_positions is not among its keys");
      else bad("G5 · forward_leasing gained a key that is not unresolved_positions", JSON.stringify(added));

      // ── G6 · REQ 4 — no ledger was copied ────────────────────────────
      const keys = allKeys(fr);
      const leaked = LEDGER_ONLY.filter((k) => keys.has(k));
      if (!keys.has("ledger") && leaked.length === 0)
        ok(`G6 · no ledger anywhere in the economic payload, and none of the ${LEDGER_ONLY.length} ledger-only row fields leaked into it`);
      else bad("G6 · ledger rows reached forward_rent's payload", JSON.stringify({
        ledger_key: keys.has("ledger"), leaked }));

      /*  ── G7 · REQ 5 — no second classification in forward_rent ───────
       *  Two statements, and neither is "I read the diff". G3 already
       *  shows the object is the canonical one rather than a re-derived
       *  look-alike. This adds that forward_rent grew no new internals:
       *  its exported surface is still exactly the two month helpers it
       *  had, so no date parser or status set was introduced beside them.
       *
       *  WHAT IT DOES NOT PROVE: a private unexported function. That is
       *  why it is stated alongside G3 and not instead of it.           */
      const internals = Object.keys(frInternal || {}).sort();
      if (JSON.stringify(internals) === JSON.stringify(["governsMonth", "monthsBetween"]))
        ok("G7 · forward_rent's internals are still exactly monthsBetween and governsMonth — no classifier appeared beside them");
      else bad("G7 · forward_rent gained an internal it did not have", JSON.stringify(internals));

      /*  ── G8 · REQ 6 — the economics did not move ─────────────────────
       *  Recomputed INDEPENDENTLY from the canonical position rather than
       *  compared to a snapshot this harness wrote, so a change that moved
       *  both at once still fails.                                       */
      const committedRows = pos.ledger.filter(
        (r) => r.operating_state === "signed" || r.operating_state === "pending");
      const expectRent = committedRows.filter((r) => r.contracted_rent != null)
        .reduce((a, r) => a + r.contracted_rent, 0);
      const okEcon = fr.coverage.committed_positions === committedRows.length
        && fr.committed_rent.contractual === expectRent
        && fr.committed_rent.decomposition.reconciles === true
        && JSON.stringify(fr.operating_position) === JSON.stringify(pos.operating_position);
      if (okEcon)
        ok(`G8 · economics unchanged — coverage.committed_positions=${fr.coverage.committed_positions}, contractual=${fr.committed_rent.contractual}, decomposition reconciles, operating_position deep-equal to the canonical one`);
      else bad("G8 · an economic figure moved", JSON.stringify({
        coverage: fr.coverage.committed_positions, expect_positions: committedRows.length,
        contractual: fr.committed_rent.contractual, expect_rent: expectRent,
        reconciles: fr.committed_rent.decomposition.reconciles }));

      //  The schedule spans the cycle's months and nothing about carrying
      //  an explanation touched it.
      if (fr.dated_schedule.months.length === 6
          && fr.dated_schedule.months[0].month === "2027-10"
          && fr.dated_schedule.months[5].month === "2028-03")
        ok("G8 · the dated schedule still spans the six cycle months, 2027-10 → 2028-03");
      else bad("G8 · the dated schedule moved", JSON.stringify({
        n: fr.dated_schedule.months.length,
        first: fr.dated_schedule.months[0] && fr.dated_schedule.months[0].month }));

      /*  ── G9 · the carriage is indifferent to WHICH reason ────────────
       *  Swap the contested pair on 102A for a single lease whose status
       *  this read does not recognise. A different cause, a different
       *  count of rights, same pass-through.                            */
      await pool.query(`delete from leases where id = any($1::uuid[])`, [[CN1, CN2]]);
      await addDated(ODD2, spaceB1, "2027-11-01", "2028-02-01", "holdover_pending");
      const pos2 = await cycleLedger();
      const fr2 = await cycleRent();
      const carried2 = JSON.stringify(fr2.forward_leasing.unresolved_positions);
      const reasons2 = (fr2.forward_leasing.unresolved_positions || [])
        .map((x) => x.unresolved_reason).sort();
      if (carried2 === JSON.stringify(pos2.unresolved_positions)
          && JSON.stringify(reasons2) === JSON.stringify(["unplaceable_rights", "unrecognized_lease_status"])
          && fr2.forward_leasing.signed === 1)
        ok("G9 · a different reason mix — unplaceable_rights + unrecognized_lease_status — carries identically, with the signed bed still signed");
      else if (!Array.isArray(fr2.forward_leasing.unresolved_positions))
        bad("G9 · nothing was carried on the second reason mix either",
            "unresolved_positions is absent, so reason-agnosticism cannot be measured");
      else bad("G9 · the pass-through is not reason-agnostic", JSON.stringify({
        reasons: reasons2, signed: fr2.forward_leasing.signed }));
    } finally {
      await pool.query(`delete from leases where id = any($1::uuid[])`,
        [[UNP, CN1, CN2, ODD2]]);
    }

    /*  ── G10 · CONTROL — EMPTY IS STATED, NOT ABSENT ──────────────────
     *  With every probe row gone the cycle has nothing unresolved. The key
     *  must still be there carrying `[]`: a reader cannot tell a missing
     *  collection from a genuinely empty one, and this is the assertion
     *  that would catch the carriage silently disappearing on the quiet
     *  path where nobody is looking.                                    */
    const frEnd = await cycleRent();
    if (frEnd.forward_leasing.unresolved === 0
        && Array.isArray(frEnd.forward_leasing.unresolved_positions)
        && frEnd.forward_leasing.unresolved_positions.length === 0)
      ok("G10 · CONTROL — with nothing unresolved the key is PRESENT and empty, not absent");
    else bad("G10 · an empty collection is not stated", JSON.stringify({
      unresolved: frEnd.forward_leasing.unresolved,
      collection: frEnd.forward_leasing.unresolved_positions }));
  } catch (e) {
    bad("harness died", e.message);
    console.error(e);
  } finally {
    /*  CLEANUP IS ADDITIVE, NEVER SUBSTITUTIVE. A cleanup failure adds a
        failure; it cannot clear or overwrite one the assertions already
        recorded, and it cannot turn a red run green. The residue sweep
        runs only if cleanup itself returned, because counting rows after
        a failed delete would report a leak whose cause is already known. */
    try {
      await fixture.cleanup(pool);
      const left = await fixture.residue(pool);
      if (left.total === 0) ok(`fixture removed — 0 rows across ${left.scanned} scanned tables`
                              + (left.skipped.length ? `, ${left.skipped.length} NOT SCANNED: ${left.skipped.join(", ")}` : ""));
      else bad(`fixture LEAKED ${left.total} row(s)`, JSON.stringify(left.byTable));
    } catch (e) {
      bad("fixture cleanup FAILED — the next run starts dirty", e.message);
    }
    await pool.end();
  }
  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  process.exit(fail === 0 ? 0 : 1);
})();
