/* ════════════════════════════════════════════════════════════════════
   debt_position_falsification.db.js — W1–W9 AGAINST THE READ.

   The schema harness proved the database refuses to STORE a collapsed
   distinction. This file proves the READ does not hand one back — the
   half no constraint can provide, and the half that matters, because
   every wall here can be broken by a correct database and a careless
   reader.

       STRUCTURAL DEFENSE  ≠  SEMANTIC PROOF

   ── IT ESTABLISHES THE REAL SPECIMEN ────────────────────────────────
   4125 is established through the CANONICAL WRITERS, not by INSERT:
   ORIX originated → assigned to Freddie Mac → serviced by Lument; five
   individual guarantors; the original instrument's two regimes; the four
   governing reserve requirements; the 2025-08-01 observed balance; and
   the servicer's payment observations.

   ⚠ THE 2026 SCHEDULED BALANCE IS NEVER RECORDED AS AN OBSERVATION.
   That substitution is the thing being tested, not a nuisance to route
   around.

   ── THE 120-ROW PROOF PROVES ARITHMETIC, NOT THE WORLD ──────────────
   Reproducing the servicer's published schedule proves the contractual
   term logic. It proves nothing about whether a payment occurred, a
   balance was observed, or the loan is current. The schedule proves the
   calculation; the statement proves the world. That separation is held
   inside the tests themselves.

   ISOLATION: HARNESS_DATABASE_URL, refused if it matches DATABASE_URL.

   Run:
     HARNESS_DATABASE_URL=postgresql://postgres@127.0.0.1:5433/postgres \
       node tests/debt_position_falsification.db.js
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");
const receipt = require("./_run_receipt.js");
const svc = require("../src/asset/debt_instrument_service.js");
const read = require("../src/asset/debt_position_read.js");

const SCHEMA = "debt_position_proof";
const MIGRATION = path.join(__dirname, "..", "migrations", "173_debt_instruments.sql");
const NE = read.NOT_ESTABLISHED;

const url = receipt.harnessConnectionString();
receipt.begin(__filename, { url, expected: 35 });

let pass = 0, fail = 0, ran = 0;
function ok(label, cond, detail) {
  ran++;
  if (cond) { pass++; console.log("  ok    " + label); }
  else { fail++; console.log("  FAIL  " + label + (detail ? "\n          " + detail : "")); }
}

const U = "11111111-1111-1111-1111-111111111111";
const P = "22222222-2222-2222-2222-222222222222";
const E = "33333333-3333-3333-3333-333333333333";
const ART = "44444444-4444-4444-4444-444444444444";

/*  ── THE SERVICER'S PUBLISHED SCHEDULE, ALL 120 ROWS ────────────────
 *  Pinned on the tax precedent — philadelphia_tax_rules.js pins the
 *  City's U&O calendar rather than trusting a derivation to be
 *  self-evidently right, because a published value must never be able to
 *  mask a broken rule.
 *
 *  ⚠ ALL 120, NOT A SAMPLE. An earlier revision pinned thirteen
 *  well-chosen rows and called the result "the 120-row proof". It was a
 *  thirteen-row sample wearing a larger claim. The derivation COMPOUNDS —
 *  each row's interest is a function of the balance the previous row left
 *  — so a defect at row 67 survives a sample checking rows 1, 49 and 120,
 *  and the endpoints still agree. Sampling a compounding series proves
 *  precisely the thing a broken middle can also do.                     */
const { PUBLISHED, PUBLISHED_TOTALS } = require("./fixtures/lument_480010465_published_schedule.js");
const c = (d) => Math.round(d * 100);

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

    /*  ══ ESTABLISH THE REAL 4125 SPECIMEN, THROUGH THE WRITERS ══════ */
    console.log("\n  ── establishing 4125 through the canonical writers ──");

    const inst = await svc.establishInstrument(db, {
      instrument_kind: "first_mortgage",
      loan_number: "480010465",
      original_principal_cents: 2825000000,
      currency: "USD",
      origination_date: "2020-08-01",
      first_payment_date: "2020-09-01",
      source_artifact_id: ART,
      provenance_note: "ORIX/Freddie 2020 closing binder; Lument amortization schedule",
      recorded_by_user_id: U,
    });
    ok("instrument established with explicit currency", inst.currency === "USD");

    //  Three roles, not one. The assignment is a dated event.
    await svc.addParty(db, { instrument_id: inst.id, party_role: "borrower",
      legal_entity_id: E, effective_from: "2020-08-01",
      provenance_note: "4125 Chestnut LLC, a Delaware LLC — org chart defines Borrower",
      source_artifact_id: ART, recorded_by_user_id: U });
    const orix = await svc.addParty(db, { instrument_id: inst.id, party_role: "originator_lender",
      party_name_text: "ORIX Real Estate Capital, LLC", effective_from: "2020-08-01",
      source_artifact_id: ART, recorded_by_user_id: U });
    await svc.addParty(db, { instrument_id: inst.id, party_role: "holder_assignee",
      party_name_text: "Freddie Mac", effective_from: "2020-08-01",
      supersedes_party_id: orix.id,
      provenance_note: "security instrument assigned by ORIX to Freddie Mac",
      source_artifact_id: ART, recorded_by_user_id: U });
    await svc.addParty(db, { instrument_id: inst.id, party_role: "servicer",
      party_name_text: "Lument Real Estate Capital, LLC", effective_from: "2020-09-01",
      source_artifact_id: ART, recorded_by_user_id: U });
    for (const g of ["Kameron Zitelli", "Lee Silpe", "Asher Shafran",
                     "Joseph Rigazio", "Robert Vernicek"]) {
      await svc.addParty(db, { instrument_id: inst.id, party_role: "guarantor",
        party_name_text: g, effective_from: "2020-08-01",
        source_artifact_id: ART, recorded_by_user_id: U });
    }
    ok("five individual guarantors recorded as attributed names, not durable people",
       (await db.query(`select count(*)::int n from debt_instrument_parties
                        where party_role='guarantor' and legal_entity_id is null`)).rows[0].n === 5);

    await svc.addCollateral(db, { instrument_id: inst.id, property_id: P,
      lien_position: 1, effective_from: "2020-08-01",
      established_by_source_artifact_id: ART,
      provenance_note: "Mortgage granting clause + Exhibit A legal description — NOT the loan name",
      recorded_by_user_id: U });

    //  The original instrument's two regimes. Both term_source 'original'.
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
    ok("two original regimes established from one governing document",
       (await db.query(`select count(*)::int n from debt_terms where term_source='original'`)).rows[0].n === 2);

    for (const [k, amt, basis] of [
      ["tax_imposition", 407624, "monthly"],
      ["insurance_imposition", 301907, "monthly"],
      ["replacement", 176300, "monthly"],
      ["debt_service", 111070300, "one_time"],   // COVID-19 DSR, $1,110,703
    ]) {
      await svc.addReserveRequirement(db, { instrument_id: inst.id, reserve_kind: k,
        amount_cents: amt, amount_basis: basis, effective_from: "2020-08-01",
        source_artifact_id: ART, recorded_by_user_id: U });
    }
    ok("four governing reserve requirements, including the COVID-19 DSR",
       (await db.query(`select count(*)::int n from debt_reserve_requirements`)).rows[0].n === 4);

    //  ⚠ THE OBSERVED BALANCE, AND ONLY THE OBSERVED ONE.
    await svc.recordBalanceObservation(db, { instrument_id: inst.id,
      observed_balance_cents: 2774526577, as_of_date: "2025-08-01",
      observation_source: "lender_statement", source_authority: "governed_read",
      source_artifact_id: ART,
      provenance_note: "Lument statement, billing due date 2025-08-01",
      recorded_by_user_id: U });

    await svc.recordPaymentObservation(db, { instrument_id: inst.id,
      observed_as_of: "2025-07-03", period_start: "2025-07-01", period_end: "2025-07-31",
      amount_due_cents: 13226971, amount_received_cents: 13226971, amount_remaining_cents: 0,
      applied_principal_cents: 4744466, applied_interest_cents: 7596674,
      applied_escrow_cents: 885831, observation_source: "servicer_transaction_history",
      source_artifact_id: ART, recorded_by_user_id: U });

    const noProjection = await db.query(
      `select count(*)::int n from debt_balance_observations where as_of_date > '2025-08-01'`);
    ok("the 2026 SCHEDULED balance was never recorded as an observation",
       noProjection.rows[0].n === 0);

    /*  ══ THE 120-ROW DERIVATION PROOF ═══════════════════════════════ */
    console.log("\n  ── the derivation reproduces the servicer's published schedule ──");
    //  as_of is required now: the payment-observation series is bounded at
    //  it. "2026-08-12" is the same AS_OF the W1–W9 block below reads at.
    const hist = await svc.loadHistory(db, inst.id, "2026-08-12");
    const sched = read.deriveSchedule(hist.terms, hist.instrument);

    ok("the derivation produces exactly 120 payments", sched.length === 120,
       `produced ${sched.length}`);
    //  The oracle must actually BE the whole schedule. A fixture that
    //  quietly shrinks turns this back into a sample without the claim
    //  changing, which is the failure this assertion exists to catch.
    ok("the pinned oracle contains all 120 published rows",
       PUBLISHED.length === 120, `oracle holds ${PUBLISHED.length}`);

    //  ── THE TRANSCRIPTION ITSELF IS CROSS-CHECKED ────────────────
    //  These sums are published on the servicer's schedule independently
    //  of the individual rows, so a typo in any single transcribed row
    //  fails here. Without this, the oracle could be wrong in exactly the
    //  way the derivation is wrong and both would agree.
    const oracleInt = PUBLISHED.reduce((s, r) => s + c(r[3]), 0);
    const oraclePrin = PUBLISHED.reduce((s, r) => s + c(r[4]), 0);
    ok("transcribed interest sums to the published grand total",
       oracleInt === c(PUBLISHED_TOTALS.grand_total_interest),
       `${oracleInt} ≠ ${c(PUBLISHED_TOTALS.grand_total_interest)}`);
    ok("transcribed principal sums to the published grand total",
       oraclePrin === c(PUBLISHED_TOTALS.grand_total_principal),
       `${oraclePrin} ≠ ${c(PUBLISHED_TOTALS.grand_total_principal)}`);
    //  Every amortizing row except the balloon must sum to the level P&I.
    const lvl = c(PUBLISHED_TOTALS.level_payment_p_and_i);
    const offLevel = PUBLISHED.filter((r) => r[0] >= 49 && r[0] <= 119)
      .filter((r) => c(r[3]) + c(r[4]) !== lvl).map((r) => `#${r[0]}`);
    ok("every amortizing published row splits the level P&I exactly",
       offLevel.length === 0, offLevel.join(", "));

    //  ── ALL 120, FIELD BY FIELD, IN INTEGER CENTS ────────────────
    let matched = 0; const mismatch = [];
    for (const [n, due, days, int$, prin$, bal$] of PUBLISHED) {
      const row = sched[n - 1];
      if (!row) { mismatch.push(`#${n} missing`); continue; }
      const bad = [];
      if (row.due_date !== due) bad.push(`due ${row.due_date}≠${due}`);
      if (row.days !== days) bad.push(`days ${row.days}≠${days}`);
      if (row.interest_cents !== c(int$)) bad.push(`int ${row.interest_cents}≠${c(int$)}`);
      if (row.principal_cents !== c(prin$)) bad.push(`prin ${row.principal_cents}≠${c(prin$)}`);
      if (row.balance_after_cents !== c(bal$)) bad.push(`bal ${row.balance_after_cents}≠${c(bal$)}`);
      //  P&I is compared as its own field, not inferred from the two
      //  components agreeing — the published schedule authorises the split.
      if (row.interest_cents + row.principal_cents !== c(int$) + c(prin$)) bad.push("p&i");
      if (bad.length) mismatch.push(`#${n} ${bad.join(" ")}`); else matched++;
    }
    ok(`ALL 120 published rows reproduced to the cent (${matched}/120)`,
       matched === 120,
       mismatch.length > 8
         ? `${mismatch.length} rows differ — first 8: ${mismatch.slice(0, 8).join(" | ")}`
         : mismatch.join(" | "));

    //  The opening balance of each row must be the previous row's close.
    //  This is what makes the series a chain rather than 120 independent
    //  calculations that happen to be checked.
    const chainBreaks = [];
    for (let i = 1; i < sched.length; i++) {
      const opening = sched[i].balance_after_cents + sched[i].principal_cents;
      if (opening !== sched[i - 1].balance_after_cents) chainBreaks.push(`#${i + 1}`);
    }
    ok("each row opens on the previous row's closing balance",
       chainBreaks.length === 0, chainBreaks.slice(0, 8).join(", "));
    ok("the interest-only regime pays down no principal (payments 1–48)",
       sched.slice(0, 48).every((r) => r.principal_cents === 0));
    ok("amortization begins at payment 49, on 2024-09-01",
       sched[48].due_date === "2024-09-01" && sched[48].principal_cents > 0);
    ok("actual/360 makes interest vary by day count on an unchanged rate",
       sched[0].interest_cents !== sched[1].interest_cents);
    ok("the final payment retires the remaining principal",
       sched[119].balance_after_cents === 0);
    //  The schedule proves arithmetic. It is not evidence of payment.
    ok("no derived row claims to be an observation",
       sched.every((r) => r.basis === "schedule_derivation"));

    /*  ══ W1–W9 AGAINST THE READ ═════════════════════════════════════ */
    console.log("\n  ── W1–W9 · hostile proofs against position() ──");
    const AS_OF = "2026-08-12";
    const pos = read.position(hist, AS_OF);
    const blob = JSON.stringify(pos);

    //  W1 — principal exists; payoff does not; neither is aliased.
    ok("W1 · payoff is NOT_ESTABLISHED with no payoff statement",
       pos.payoff.truth_state === NE && pos.payoff.value_cents === undefined);
    ok("W1 · the principal observation is established and is NOT the payoff",
       pos.principal_position.observed.value_cents === 2774526577
       && pos.payoff.value_cents !== pos.principal_position.observed.value_cents);

    //  W2 — requirements run to 2030; evidence stops 2025-07-03.
    ok("W2 · payment standing does not claim current from the schedule",
       pos.payment_standing.current_through === NE);
    ok("W2 · payment standing is anchored to the observation, not today",
       pos.payment_standing.latest_observation_as_of === "2025-07-03"
       && pos.payment_standing.observation_age_days > 300);
    ok("W2 · no affirmative paid/current token anywhere in the payload",
       !/"(paid|current|up_to_date)"\s*:\s*true/i.test(blob)
       && !/"status"\s*:\s*"(paid|current)"/i.test(blob));

    //  W3 — maturity is contractual; an unexercised option moves nothing.
    ok("W3 · contractual maturity is 2030-08-01",
       pos.contractual_maturity.date === "2030-08-01");
    ok("W3 · extension is NOT_ESTABLISHED and no other maturity date appears",
       pos.extension.truth_state === NE && !/203[1-9]-/.test(blob));

    //  W4 — fixed resolves. The hostile floating case must not.
    ok("W4 · a fixed rate resolves to an effective rate",
       pos.rate_position.kind === "fixed" && pos.rate_position.effective_rate_bp === 328);
    const f = await svc.establishInstrument(db, { instrument_kind: "mezzanine",
      original_principal_cents: 500000000, currency: "USD",
      first_payment_date: "2021-01-01", recorded_by_user_id: U });
    await svc.addTerm(db, { instrument_id: f.id, effective_from: "2021-01-01",
      term_source: "original", rate_kind: "floating", rate_index_name: "SOFR",
      spread_bp: 300, rate_floor_bp: 400, day_count_convention: "actual_360",
      payment_frequency: "monthly", amortization_kind: "interest_only",
      maturity_date: "2026-01-01", recorded_by_user_id: U });
    const fpos = read.position(await svc.loadHistory(db, f.id, AS_OF), AS_OF);
    ok("W4 · a formula with no index observation yields NOT_ESTABLISHED",
       fpos.rate_position.effective_rate_bp === NE
       && fpos.rate_position.index_name === "SOFR" && fpos.rate_position.spread_bp === 300);

    //  W5 — the semantic half no schema can give.
    ok("W5 · covenant standing is NOT_ESTABLISHED",
       pos.covenant_standing.truth_state === NE);
    ok("W5 · no affirmative compliance token anywhere in the payload",
       !/(compliant|in_compliance|covenants?\W+(ok|okay|good|satisfied|healthy))/i.test(blob));

    //  W6 — the reserve exists; the obligation's status does not.
    const taxReq = pos.reserve_requirements.find((r) => r.reserve_kind === "tax_imposition");
    ok("W6 · the tax escrow REQUIREMENT is returned",
       !!taxReq && taxReq.amount_cents === 407624);
    ok("W6 · and its underlying obligation status stays NOT_ESTABLISHED",
       taxReq.underlying_obligation_status === NE
       && !/tax(es)?_?paid|premium_?paid/i.test(blob));

    //  W7 — the real 4125 staleness case.
    ok("W7 · the observation keeps its own as_of when read at 2026-08-12",
       pos.principal_position.observed.as_of_date === "2025-08-01");
    ok("W7 · and is explicitly marked stale, not merely dated",
       pos.principal_position.observed.stale === true
       && pos.principal_position.observed.age_days > 300);

    //  W8 — two keys, always, and no generic `balance`.
    ok("W8 · observed and projected are separate keys with different values",
       pos.principal_position.observed.value_cents === 2774526577
       && pos.principal_position.projected.value_cents === 2713187412);
    ok("W8 · the projection says what it assumes",
       /every scheduled payment occurred/.test(pos.principal_position.projected.assumes));
    ok("W8 · there is no generic `balance` key for a caller to guess at",
       !/"balance"\s*:/.test(blob));

    //  W9 — the specimen's own hostile case.
    ok("W9 · debt service is the $123,411.40 P&I, not the $132,269.71 draft",
       pos.debt_service.principal_and_interest_cents === 12341140);
    ok("W9 · and the lender draft never appears as debt service",
       !new RegExp(`"(debt_service|principal_and_interest_cents)"[^}]*13226971`).test(blob));

    //  The parties, which the binder corrected.
    console.log("\n  ── the party roles the binder established ──");
    ok("originator, holder and servicer are three distinct roles",
       pos.parties.originator_lender.name === "ORIX Real Estate Capital, LLC"
       && pos.parties.holder_assignee.name === "Freddie Mac"
       && pos.parties.servicer.name === "Lument Real Estate Capital, LLC");
    ok("five guarantors are read back", pos.parties.guarantors.length === 5);

    //  as_of is a reading, not a freshness claim.
    console.log("\n  ── as_of is a reading, not a freshness claim ──");
    const past = read.position(hist, "2024-06-01");
    ok("reading in the past sees the interest-only regime",
       past.terms_in_force.amortization_kind === "interest_only");
    ok("reading in the past does NOT see a later observation",
       past.principal_position.observed.truth_state === NE);
    ok("reading today sees the amortizing regime",
       pos.terms_in_force.amortization_kind === "level_payment");

    await db.query(`drop schema ${SCHEMA} cascade`);
  } catch (e) {
    db.release(); await pool.end();
    process.exit(receipt.died(__filename, e, ran));
  }
  db.release();
  await pool.end();
  process.exit(receipt.complete({ harness: __filename, passed: pass, failed: fail, expectedAtLeast: 35 }));
})();
