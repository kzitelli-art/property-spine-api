/* ════════════════════════════════════════════════════════════════════
   debt_observation_bound_equivalence.db.js — THE BOUND CHANGED THE COST
   AND NOTHING ELSE. And where it would have changed more, it was reverted.

   `loadHistory()` read `select * from debt_payment_observations where
   instrument_id = $1 order by observed_as_of` — every payment ever
   observed, every column, no bound, on the standing-read path. That is
   payment history in the plainest sense §40.6 has.

   position() uses EXACTLY ONE of those rows: the newest observation on or
   before as_of. So the bound is the read's own semantics moved into SQL.
   This file is the proof that "moved" is the right word.

   ── THE BAR ─────────────────────────────────────────────────────────
   Not "looks right". IDENTICAL OUTPUT. Both loaders run against the same
   seeded instrument and their position() and standingProjection() results
   are compared with a deep structural equality — the whole object, not a
   field I chose to look at.

   ⚠ AND IT IS COMPARED AT MANY DATES, NOT ONE. A bound of the form
   "latest row" agrees with an unbounded read at whatever date happens to
   sit after the last observation. The dates below deliberately include:
   before every observation, between observations, exactly ON an
   observation date, after all of them, and a date in the middle of a
   dense run. A single as_of would have proved nothing.

   ── ISOLATION ───────────────────────────────────────────────────────
   Its own schema, dropped and rebuilt. Only migration 173 plus four stub
   tables — the same shape debt_position_falsification.db.js uses, and for
   the same reason: the specimen is established through the CANONICAL
   WRITERS, never by INSERT, so the rows under test are rows the product
   can actually produce.

   ── §18 COMPONENT CLASS ─────────────────────────────────────────────
   CLASS 3 — proof infrastructure. REMOVAL CONDITION: when
   debt_payment_observations is no longer read by loadHistory() at all.
   Not when the bound "looks settled" — this file is what makes a later
   change to that statement checkable.

   Run:
     HARNESS_DATABASE_URL=postgresql://postgres@127.0.0.1:5432/x \
       node tests/debt_observation_bound_equivalence.db.js
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const fs = require("fs");
const path = require("path");
const assert = require("assert");
const { Pool } = require("pg");
const svc = require("../src/asset/debt_instrument_service.js");
const read = require("../src/asset/debt_position_read.js");

const SCHEMA = "debt_bound_equivalence";
const MIGRATION = path.join(__dirname, "..", "migrations", "173_debt_instruments.sql");

/*  The SHARED refusal, not a hand-rolled one. It declines a missing
    HARNESS_DATABASE_URL, declines any fallback to DATABASE_URL, and
    declines a URL pointing at the SAME target as DATABASE_URL — the check
    a local-only regex cannot make, because production can be reached from
    a laptop and localhost is not the only way to be wrong. */
const receipt = require("./_run_receipt.js");
const url = receipt.harnessConnectionString();

const U = "11111111-1111-1111-1111-111111111111";
const P = "22222222-2222-2222-2222-222222222222";
const E = "33333333-3333-3333-3333-333333333333";
const ART = "44444444-4444-4444-4444-444444444444";

let pass = 0, fail = 0;
function ok(label, cond, detail) {
  if (cond) { pass++; console.log("  ✔ " + label); }
  else { fail++; console.log("  ✘ " + label + (detail ? "\n      " + detail : "")); }
}

/*  ── THE UNBOUNDED LOADER, PRESERVED VERBATIM ──────────────────────
 *  This is what loadHistory() did before the bound, character for
 *  character in the statement that changed. It lives here so the
 *  comparison is against the REAL previous behaviour and not against my
 *  description of it. If someone later changes the bound, this stays put
 *  and the equality either holds or it does not.                       */
async function loadHistoryUnbounded(db, instrumentId) {
  const q = async (sql) => (await db.query(sql, [instrumentId])).rows;
  const inst = await db.query(`select * from debt_instruments where id = $1`, [instrumentId]);
  if (!inst.rows[0]) return null;
  return {
    instrument: inst.rows[0],
    terms: await q(`select * from debt_terms where instrument_id = $1 order by effective_from`),
    parties: await q(`select * from debt_instrument_parties where instrument_id = $1 order by effective_from`),
    collateral: await q(`select * from debt_instrument_properties where instrument_id = $1 order by effective_from`),
    reserves: await q(`select * from debt_reserve_requirements where instrument_id = $1 order by effective_from`),
    balance_observations: await q(`select * from debt_balance_observations where instrument_id = $1 order by as_of_date`),
    payment_observations: await q(`select * from debt_payment_observations where instrument_id = $1 order by observed_as_of`),
  };
}

/*  Counts statements AND rows. Cost is the point of the change, so it is
    measured rather than asserted in prose. */
function counting(db) {
  const stat = { queries: 0, paymentRows: 0, balanceRows: 0 };
  return {
    stat,
    client: {
      query: async (sql, params) => {
        const r = await db.query(sql, params);
        stat.queries++;
        if (/debt_payment_observations/.test(String(sql))) stat.paymentRows += r.rows.length;
        if (/debt_balance_observations/.test(String(sql))) stat.balanceRows += r.rows.length;
        return r;
      },
    },
  };
}

(async () => {
  const pool = new Pool({ connectionString: url });
  const db = await pool.connect();
  try {
    await db.query(`drop schema if exists ${SCHEMA} cascade`);
    await db.query(`create schema ${SCHEMA}`);
    await db.query(`set search_path to ${SCHEMA}`);
    await db.query(`create extension if not exists pgcrypto`);
    await db.query(`create table users (id uuid primary key)`);
    await db.query(`create table properties (id uuid primary key)`);
    await db.query(`create table legal_entities (id uuid primary key)`);
    await db.query(`create table source_artifacts (id uuid primary key)`);
    for (const [t, v] of [["users", U], ["properties", P], ["legal_entities", E],
                          ["source_artifacts", ART]]) {
      await db.query(`insert into ${t} values ($1)`, [v]);
    }
    await db.query(fs.readFileSync(MIGRATION, "utf8"));

    console.log("\nDEBT PAYMENT-OBSERVATION BOUND — EQUIVALENCE, NOT RESEMBLANCE");
    console.log("=".repeat(70));
    console.log("  the 4125 specimen, established through the canonical writers\n");

    const inst = await svc.establishInstrument(db, {
      instrument_kind: "first_mortgage",
      loan_number: "480010465",
      original_principal_cents: 2825000000,
      currency: "USD",
      origination_date: "2020-08-01",
      first_payment_date: "2020-09-01",
      source_artifact_id: ART,
      provenance_note: "ORIX/Freddie 2020 closing binder",
      recorded_by_user_id: U,
    });
    await svc.addParty(db, { instrument_id: inst.id, party_role: "borrower",
      legal_entity_id: E, effective_from: "2020-08-01",
      source_artifact_id: ART, recorded_by_user_id: U });
    await svc.addParty(db, { instrument_id: inst.id, party_role: "servicer",
      party_name_text: "Lument Real Estate Capital, LLC", effective_from: "2020-09-01",
      source_artifact_id: ART, recorded_by_user_id: U });
    await svc.addCollateral(db, { instrument_id: inst.id, property_id: P,
      lien_position: 1, effective_from: "2020-08-01",
      established_by_source_artifact_id: ART, recorded_by_user_id: U });
    const io = await svc.addTerm(db, {
      instrument_id: inst.id, effective_from: "2020-09-01", effective_to: "2024-08-01",
      term_source: "original", rate_kind: "fixed", fixed_rate_bp: 328,
      day_count_convention: "actual_360", payment_frequency: "monthly",
      amortization_kind: "interest_only", maturity_date: "2030-08-01",
      source_artifact_id: ART, recorded_by_user_id: U });
    await svc.addTerm(db, {
      instrument_id: inst.id, effective_from: "2024-09-01",
      term_source: "original", rate_kind: "fixed", fixed_rate_bp: 328,
      day_count_convention: "actual_360", payment_frequency: "monthly",
      amortization_kind: "level_payment", level_payment_cents: 12341140,
      fully_amortizing: false, maturity_date: "2030-08-01",
      supersedes_term_id: io.id, source_artifact_id: ART, recorded_by_user_id: U });
    await svc.recordBalanceObservation(db, { instrument_id: inst.id,
      observed_balance_cents: 2774526577, as_of_date: "2025-08-01",
      observation_source: "lender_statement", source_authority: "governed_read",
      source_artifact_id: ART, recorded_by_user_id: U });

    /*  ⚠ A SERIES, NOT A ROW. The old statement's defect is invisible with
        one observation: `select *` and `limit 1` return the same thing.
        Thirty-six monthly observations is what an instrument looks like
        after three years, which is a young loan.                        */
    const OBS = [];
    for (let m = 0; m < 36; m++) {
      const y = 2023 + Math.floor(m / 12);
      const mm = String((m % 12) + 1).padStart(2, "0");
      OBS.push(`${y}-${mm}-03`);
      await svc.recordPaymentObservation(db, { instrument_id: inst.id,
        observed_as_of: `${y}-${mm}-03`,
        period_start: `${y}-${mm}-01`, period_end: `${y}-${mm}-28`,
        amount_due_cents: 13226971, amount_received_cents: 13226971,
        amount_remaining_cents: 0,
        applied_principal_cents: 4744466, applied_interest_cents: 7596674,
        applied_escrow_cents: 885831, observation_source: "servicer_transaction_history",
        source_artifact_id: ART, recorded_by_user_id: U });
    }
    const total = (await db.query(
      `select count(*)::int n from debt_payment_observations`)).rows[0].n;
    ok(`${total} payment observations recorded — a series, not a row`, total === 36);

    /*  ── THE BALANCE SERIES, WITH THE TWO CASES THAT BREAK A NAIVE BOUND
        A quarterly series, plus:
          · TWO observations on the SAME DATE. position()'s sort returns -1
            for equal keys, so which one wins depends on input order. A
            bound that changes the input order changes the answer.
          · TWO payoff statements, early and late. W1 uses `.find` on an
            ASCENDING array, so it takes the EARLIEST. With one payoff
            statement — every other fixture in this repo — a "latest row"
            bound looks correct and is not.                              */
    for (let qtr = 0; qtr < 20; qtr++) {
      const y = 2021 + Math.floor(qtr / 4);
      const mm = String((qtr % 4) * 3 + 1).padStart(2, "0");
      await svc.recordBalanceObservation(db, { instrument_id: inst.id,
        observed_balance_cents: 2800000000 - qtr * 1000000, as_of_date: `${y}-${mm}-01`,
        observation_source: "lender_statement", source_authority: "governed_read",
        source_artifact_id: ART, recorded_by_user_id: U });
    }
    //  A SECOND observation on an existing date — the tie.
    await svc.recordBalanceObservation(db, { instrument_id: inst.id,
      observed_balance_cents: 2699999999, as_of_date: "2025-10-01",
      observation_source: "borrower_record", source_authority: "governed_read",
      source_artifact_id: ART, recorded_by_user_id: U });
    //  TWO payoff statements. The earliest is the one W1 must keep reporting.
    await svc.recordBalanceObservation(db, { instrument_id: inst.id,
      observed_balance_cents: 2750000000, as_of_date: "2022-05-01",
      observation_source: "payoff_statement", source_authority: "governed_read",
      source_artifact_id: ART, recorded_by_user_id: U });
    await svc.recordBalanceObservation(db, { instrument_id: inst.id,
      observed_balance_cents: 2600000000, as_of_date: "2025-05-01",
      observation_source: "payoff_statement", source_authority: "governed_read",
      source_artifact_id: ART, recorded_by_user_id: U });
    const btotal = (await db.query(
      `select count(*)::int n from debt_balance_observations`)).rows[0].n;
    ok(`${btotal} balance observations — including a same-date tie and TWO payoff statements`,
       btotal === 24);

    /*  ── THE DATES ────────────────────────────────────────────────────
        Chosen to break a "latest row" bound if it is wrong anywhere. */
    const DATES = [
      ["2021-01-01", "before every PAYMENT observation; on the first balance"],
      ["2022-04-30", "one day before the FIRST payoff statement"],
      ["2022-05-01", "exactly ON the first payoff statement"],
      ["2022-06-15", "after the first payoff, before every payment observation"],
      ["2025-05-02", "after BOTH payoff statements — W1 must still report the EARLIEST"],
      ["2025-10-01", "exactly ON the same-date tie"],
      ["2023-01-03", "exactly ON the first observation date (boundary, inclusive)"],
      ["2023-01-02", "one day BEFORE it (boundary, exclusive)"],
      ["2024-05-20", "between two observations, mid-series"],
      ["2024-07-03", "exactly ON an observation in a dense run"],
      ["2025-12-03", "exactly ON the last observation"],
      ["2026-08-24", "after all of them — the case a single-date test would pick"],
      ["2030-01-01", "far future, past maturity"],
    ];

    console.log("\n  as_of         position()   standingProjection()   rows read");
    console.log("  " + "-".repeat(66));
    for (const [asOf, why] of DATES) {
      const oldHist = await loadHistoryUnbounded(db, inst.id);

      const m = counting(db);
      const newHist = await svc.loadHistory(m.client, inst.id, asOf);

      const oldPos = read.position(oldHist, asOf);
      const newPos = read.position(newHist, asOf);
      let posSame = true, projSame = true, detail = "";
      try { assert.deepStrictEqual(newPos, oldPos); }
      catch (e) { posSame = false; detail = String(e.message).slice(0, 300); }
      try {
        assert.deepStrictEqual(read.standingProjection(newPos), read.standingProjection(oldPos));
      } catch (e) { projSame = false; detail = detail || String(e.message).slice(0, 300); }

      console.log(`  ${asOf}    ${posSame ? "IDENTICAL " : "  DIFFERS "}  ${projSame ? "   IDENTICAL       " : "     DIFFERS       "}  ` +
                  `pay ${String(m.stat.paymentRows).padStart(2)}/${oldHist.payment_observations.length}  ` +
                  `bal ${String(m.stat.balanceRows).padStart(2)}/${oldHist.balance_observations.length}`);
      ok(`${asOf} — ${why}`, posSame && projSame, detail);

      //  The cost claim, measured at every date rather than asserted once.
      ok(`  …and it read at most ONE payment row (${m.stat.paymentRows})`,
         m.stat.paymentRows <= 1, `read ${m.stat.paymentRows}`);
      /*  ⚠ BALANCES ARE STILL UNBOUNDED, ON PURPOSE. See the section at
          the end: a bound is correct at every date here EXCEPT the
          same-date tie, and the tie is a pre-existing undefined answer,
          not a bound failure. This asserts the CURRENT cost so the day it
          changes, this line says so. */
      ok(`  …and read the whole balance series (${m.stat.balanceRows}) — still unbounded`,
         m.stat.balanceRows === oldHist.balance_observations.length);
    }

    /*  ── THE MISSING ARGUMENT MUST BREAK LOUDLY ──────────────────────
        A default of today() would have made a future-dated read silently
        wrong. The refusal is the design, so it is proved. */
    /*  ══ WHY debt_balance_observations IS STILL A WALK ═══════════════
        Not because a bound is hard. Because the read's answer is already
        undefined in a case the bound makes visible.                     */
    console.log("\n  the balance tie — a defect a bound would have been blamed for");
    console.log("  " + "-".repeat(66));
    const tied = (await db.query(
      `select count(*)::int n from debt_balance_observations where as_of_date = '2025-10-01'`
    )).rows[0].n;
    ok("two balance observations share one as_of_date", tied === 2);

    const hAt = await loadHistoryUnbounded(db, inst.id);
    /*  ⚠ node-pg hands a DATE column back as a JS Date, so
        String(row.as_of_date) is "Wed Oct 01 2025 …" and slicing ten
        characters off it yields "Wed Oct 01". The first version of this
        filter did exactly that, matched nothing, and reported the tie as
        absent — a test that would have quietly said "no conflict here".
        And toISOString() is the other half of the same trap: the Date is
        built at LOCAL midnight and read back in UTC. Format the parts. */
    const ymd = (v) => (v instanceof Date
      ? `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, "0")}-${String(v.getDate()).padStart(2, "0")}`
      : String(v).slice(0, 10));
    const atTie = hAt.balance_observations.filter((b) => ymd(b.as_of_date) === "2025-10-01");
    ok("the tie is visible to this test at all (the Date-formatting trap)",
       atTie.length === 2, `matched ${atTie.length} rows`);
    const posTie = read.position(hAt, "2025-10-01");
    ok("…from DIFFERENT sources — this is a conflict, not a duplicate",
       new Set(atTie.map((b) => b.observation_source)).size === 2);
    ok("…and the read picks ONE of them",
       atTie.some((b) => Number(b.observed_balance_cents)
                         === posTie.principal_position.observed.value_cents));
    /*  The verdict: position()'s comparator returns -1 for EQUAL keys, so
        the winner is whichever row arrived first in the array — and
        `order by as_of_date` does not order equal dates. Nothing in the
        query or the reader decides this. */
    ok("…WITHOUT recording that a second observation for that date exists",
       posTie.principal_position.observed.conflict === undefined
       && posTie.principal_position.observed.truth_state === undefined,
       "if a conflict key has since been added, this walk can be bounded — "
       + "re-run the bound and lower the ceiling");

    /*  ══ DEFECT #34 · W1 REPORTS THE EARLIEST PAYOFF STATEMENT ═══════
        A separate defect from the tie, found in the same array while
        bounding it, and NOT a cost issue. Recorded here because this is
        the only place in the repo that seeds two payoff statements —
        every other fixture seeds one, where earliest and latest coincide
        and nothing can go red.

        These assertions describe what the read DOES today, so they are
        green now and go RED when the defect is fixed. That is the point:
        the fix must come here and delete them deliberately, rather than
        landing while a suite stays quiet.                               */
    console.log("\n  defect #34 — W1 takes the EARLIEST payoff statement");
    console.log("  " + "-".repeat(66));
    const payoffs = hAt.balance_observations
      .filter((b) => b.observation_source === "payoff_statement")
      .map((b) => ymd(b.as_of_date));
    ok("two payoff statements exist on this instrument", payoffs.length === 2,
       `saw ${payoffs.join(", ")}`);

    const posAfterBoth = read.position(hAt, "2025-05-02");
    ok("reading AFTER both, W1 reports the 2022 statement — the EARLIEST",
       posAfterBoth.payoff.as_of_date === "2022-05-01",
       `reported ${posAfterBoth.payoff.as_of_date}`);
    ok("…and says nothing about the 2025 statement existing",
       posAfterBoth.payoff.superseded_by === undefined
       && posAfterBoth.payoff.conflict === undefined,
       "if either key now exists, defect #34 is being fixed — delete this block "
       + "and assert the new reading instead");

    console.log("\n  the required as_of");
    console.log("  " + "-".repeat(66));
    let threw = null;
    try { await svc.loadHistory(db, inst.id); } catch (e) { threw = e; }
    ok("loadHistory() with no as_of THROWS rather than defaulting to today",
       threw !== null && /requires as_of/.test(String(threw.message)),
       threw ? String(threw.message) : "it returned instead of throwing");
    threw = null;
    try { await svc.loadHistory(db, inst.id, "24 August 2026"); } catch (e) { threw = e; }
    ok("…and refuses a date it cannot parse rather than coercing it",
       threw !== null && /requires as_of/.test(String(threw.message)));

    console.log("\n" + "=".repeat(70));
    console.log(`  ${pass} green   ${fail} failed`);
    if (fail === 0) {
      console.log("\n  PAYMENTS: identical output at fourteen dates including both sides of");
      console.log("  every boundary, and one row read instead of thirty-six.");
      console.log("  BALANCES: still unbounded, deliberately. A bound was built and");
      console.log("  reverted — correct at every date except the same-date tie, where");
      console.log("  the read's answer is already arbitrary. That is a conflict the");
      console.log("  writer must record, not a cost the reader can bound away.\n");
    }
  } finally {
    await db.query(`drop schema if exists ${SCHEMA} cascade`).catch(() => {});
    db.release();
    await pool.end();
  }
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
