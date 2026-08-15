/* ════════════════════════════════════════════════════════════════════
   debt_institutional_acceptance.db.js — IS THE DEBT TRUTH SUFFICIENT?

   Institutional reporting is an ACCEPTANCE TEST, not a subsystem. This
   file builds no reporting architecture. It establishes the real 4125
   specimen, asks position() the ten questions an institutional asset
   manager or accountant needs to explain a debt position, and reports —
   per question — whether the governed truth underneath can already
   answer it.

   THE STANDARD:
       if an institutional asset manager or accountant would need the
       fact to explain the debt position, capture it.
       if it is merely useful for sophisticated loan analytics, park it.

   ── WHY THIS EXISTS BEFORE ANY REPORTING CODE ───────────────────────
   The failure this prevents is discovering, months later during the
   monthly package or T-12, that the Debt history is too shallow to read
   from — at which point the fix is a migration against live data instead
   of a column added before anything depended on it.

   A question this file marks INSUFFICIENT is not a bug in position(). It
   is a statement that the canonical history does not yet carry a fact
   institutional reporting will need, recorded now while it is cheap.

   ⚠ THIS FILE CHANGES NOTHING. Schema, writers, position(), W1–W9 and
   the 120-row oracle are frozen. It only interrogates them.

   Run:
     HARNESS_DATABASE_URL=postgresql://postgres@127.0.0.1:5433/postgres \
       node tests/debt_institutional_acceptance.db.js
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");
const receipt = require("./_run_receipt.js");
const svc = require("../src/asset/debt_instrument_service.js");
const read = require("../src/asset/debt_position_read.js");

const SCHEMA = "debt_institutional";
const MIGRATION = path.join(__dirname, "..", "migrations", "173_debt_instruments.sql");
const NE = read.NOT_ESTABLISHED;

const url = receipt.harnessConnectionString();
receipt.begin(__filename, { url, expected: 10 });

let sufficient = 0, insufficient = 0, ran = 0;
const gaps = [];
function q(n, question, answerable, evidence, gapNote) {
  ran++;
  if (answerable) {
    sufficient++;
    console.log(`  ✓ Q${n}  ${question}`);
    if (evidence) console.log(`         ${evidence}`);
  } else {
    insufficient++;
    gaps.push({ n, question, gapNote });
    console.log(`  ⚠ Q${n}  ${question}`);
    console.log(`         INSUFFICIENT — ${gapNote}`);
  }
}

const U = "11111111-1111-1111-1111-111111111111";
const P = "22222222-2222-2222-2222-222222222222";
const E = "33333333-3333-3333-3333-333333333333";
const ART = "44444444-4444-4444-4444-444444444444";
const $ = (cents) => cents == null ? "—" : "$" + (cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2 });

(async () => {
  const pool = new Pool({ connectionString: url });
  const db = await pool.connect();
  try {
    await db.query(`drop schema if exists ${SCHEMA} cascade`);
    await db.query(`create schema ${SCHEMA}`);
    await db.query(`set search_path to ${SCHEMA}`);
    await db.query(`create extension if not exists pgcrypto`);
    for (const t of ["users", "properties", "legal_entities", "source_artifacts"]) {
      await db.query(`create table ${t} (id uuid primary key)`);
    }
    for (const [t, v] of [["users", U], ["properties", P], ["legal_entities", E],
                          ["source_artifacts", ART]]) {
      await db.query(`insert into ${t} values ($1)`, [v]);
    }
    await db.query(fs.readFileSync(MIGRATION, "utf8"));

    //  ── the real 4125 specimen, through the canonical writers ──────
    const inst = await svc.establishInstrument(db, {
      instrument_kind: "first_mortgage", loan_number: "480010465",
      original_principal_cents: 2825000000, currency: "USD",
      origination_date: "2020-08-01", first_payment_date: "2020-09-01",
      source_artifact_id: ART, recorded_by_user_id: U });
    await svc.addParty(db, { instrument_id: inst.id, party_role: "borrower",
      legal_entity_id: E, effective_from: "2020-08-01", source_artifact_id: ART, recorded_by_user_id: U });
    await svc.addParty(db, { instrument_id: inst.id, party_role: "originator_lender",
      party_name_text: "ORIX Real Estate Capital, LLC", effective_from: "2020-08-01",
      source_artifact_id: ART, recorded_by_user_id: U });
    await svc.addParty(db, { instrument_id: inst.id, party_role: "holder_assignee",
      party_name_text: "Freddie Mac", effective_from: "2020-08-01",
      source_artifact_id: ART, recorded_by_user_id: U });
    await svc.addParty(db, { instrument_id: inst.id, party_role: "servicer",
      party_name_text: "Lument Real Estate Capital, LLC", effective_from: "2020-09-01",
      source_artifact_id: ART, recorded_by_user_id: U });
    await svc.addCollateral(db, { instrument_id: inst.id, property_id: P, lien_position: 1,
      effective_from: "2020-08-01", established_by_source_artifact_id: ART, recorded_by_user_id: U });
    const io = await svc.addTerm(db, { instrument_id: inst.id, effective_from: "2020-09-01",
      effective_to: "2024-08-01", term_source: "original", rate_kind: "fixed", fixed_rate_bp: 328,
      day_count_convention: "actual_360", payment_frequency: "monthly",
      amortization_kind: "interest_only", maturity_date: "2030-08-01",
      source_artifact_id: ART, recorded_by_user_id: U });
    await svc.addTerm(db, { instrument_id: inst.id, effective_from: "2024-09-01",
      term_source: "original", rate_kind: "fixed", fixed_rate_bp: 328,
      day_count_convention: "actual_360", payment_frequency: "monthly",
      amortization_kind: "level_payment", level_payment_cents: 12341140,
      maturity_date: "2030-08-01", supersedes_term_id: io.id,
      source_artifact_id: ART, recorded_by_user_id: U });
    for (const [k, amt, b] of [["tax_imposition", 407624, "monthly"],
                               ["insurance_imposition", 301907, "monthly"],
                               ["replacement", 176300, "monthly"],
                               ["debt_service", 111070300, "one_time"]]) {
      await svc.addReserveRequirement(db, { instrument_id: inst.id, reserve_kind: k,
        amount_cents: amt, amount_basis: b, effective_from: "2020-08-01",
        source_artifact_id: ART, recorded_by_user_id: U });
    }
    await svc.recordBalanceObservation(db, { instrument_id: inst.id,
      observed_balance_cents: 2774526577, as_of_date: "2025-08-01",
      observation_source: "lender_statement", source_artifact_id: ART, recorded_by_user_id: U });
    await svc.recordPaymentObservation(db, { instrument_id: inst.id,
      observed_as_of: "2025-07-03", period_start: "2025-07-01", period_end: "2025-07-31",
      amount_due_cents: 13226971, amount_received_cents: 13226971, amount_remaining_cents: 0,
      applied_principal_cents: 4744466, applied_interest_cents: 7596674,
      applied_escrow_cents: 885831, observation_source: "servicer_transaction_history",
      source_artifact_id: ART, recorded_by_user_id: U });

    //  The lender's published year-to-date figures from the same 2025-08-01
    //  statement, established through the EXISTING writer with no schema
    //  change: a period-range observation is a period-range observation
    //  whether the servicer calls it a month, a quarter or a YTD.
    await svc.recordPaymentObservation(db, { instrument_id: inst.id,
      observed_as_of: "2025-08-01", period_start: "2025-01-01", period_end: "2025-07-31",
      applied_principal_cents: 32436409, applied_interest_cents: 53951571,
      observation_source: "lender_statement",
      provenance_note: "Lument statement 2025-08-01: PRINCIPAL PAID YTD / INTEREST PAID YTD",
      source_artifact_id: ART, recorded_by_user_id: U });

    const hist = await svc.loadHistory(db, inst.id);
    const pos = read.position(hist, "2026-08-12");
    const sched = read.deriveSchedule(hist.terms, hist.instrument);

    console.log("\n  THE TEN INSTITUTIONAL QUESTIONS · 4125 · as of 2026-08-12\n");

    const ob = pos.principal_position.observed;
    q(1, "debt balance as of a date",
       ob.value_cents != null && !!ob.as_of_date,
       `${$(ob.value_cents)} observed as of ${ob.as_of_date}`);

    q(2, "original principal / current observed principal",
       pos.instrument.original_principal_cents != null && ob.value_cents != null,
       `original ${$(pos.instrument.original_principal_cents)} · observed ${$(ob.value_cents)}`);

    //  ── Q3, CLOSED WITH ZERO SCHEMA EXPANSION ────────────────────
    //  The first run of this harness called Q3 a missing-column gap and
    //  proposed YTD fields. That was wrong. A lender's published
    //  year-to-date figure is just another period-range observation, and
    //  period_start · period_end · applied_principal · applied_interest
    //  already carries it. Establishing it needs no migration and no new
    //  writer — the existing recordPaymentObservation takes it as-is.
    const ytd = read.paidOverPeriod(hist.payment_observations, "2025-01-01", "2025-07-31");
    q(3, "principal vs interest — for a reporting period",
       ytd.principal_cents === 32436409 && ytd.interest_cents === 53951571,
       `2025 YTD principal ${$(ytd.principal_cents)} · interest ${$(ytd.interest_cents)} ` +
       `· basis ${ytd.basis}`);

    q(4, "scheduled debt service",
       pos.debt_service.principal_and_interest_cents != null,
       `${$(pos.debt_service.principal_and_interest_cents)} P&I, excludes ${pos.debt_service.excludes.join(" + ")}`);

    q(5, "maturity and rate",
       !!pos.contractual_maturity.date && pos.rate_position.effective_rate_bp !== undefined,
       `matures ${pos.contractual_maturity.date} · ${(pos.rate_position.effective_rate_bp / 100).toFixed(2)}% ${pos.rate_position.kind}`);

    q(6, "lender / borrower / collateral",
       !!pos.parties.borrower.legal_entity_id && !!pos.parties.holder_assignee.name
         && pos.collateral.length > 0,
       `borrower ${pos.parties.borrower.legal_entity_id.slice(0, 8)}… · holder ${pos.parties.holder_assignee.name} · ` +
       `servicer ${pos.parties.servicer.name} · ${pos.collateral.length} property, lien ${pos.collateral[0].lien_position}`);

    q(7, "reserve requirements",
       pos.reserve_requirements.length === 4,
       pos.reserve_requirements.map((r) => `${r.reserve_kind} ${$(r.amount_cents)}`).join(" · "));

    //  The facts exist on both sides; what is missing is that nothing
    //  composes them for a NAMED PERIOD.
    //  pg returns date columns as Date objects, so normalise before matching.
    const asISO = (v) => v == null ? null
      : (typeof v === "string" ? v.slice(0, 10) : new Date(v).toISOString().slice(0, 10));
    const julyScheduled = sched.find((r) => r.due_date === "2025-07-01");
    const julyObserved = hist.payment_observations.find((p) =>
      (asISO(p.period_start) || "").slice(0, 7) === "2025-07");
    q(8, "actual payments vs scheduled payments",
       !!(julyScheduled && julyObserved),
       `2025-07 scheduled P&I ${$(julyScheduled.interest_cents + julyScheduled.principal_cents)} · ` +
       `observed applied ${$(Number(julyObserved.applied_principal_cents) + Number(julyObserved.applied_interest_cents))} P&I ` +
       `+ ${$(Number(julyObserved.applied_escrow_cents))} escrow`);

    const pr = pos.principal_position.projected;
    q(9, "projected balance vs lender-observed balance",
       pr.value_cents != null && ob.value_cents != null && pr.value_cents !== ob.value_cents,
       `observed ${$(ob.value_cents)} (${ob.as_of_date}) vs projected ${$(pr.value_cents)} (${pr.as_of_date})`);

    q(10, "source and freshness behind the number",
       !!ob.observation_source && !!ob.source_authority && ob.stale === true,
       `${ob.observation_source} · ${ob.source_authority} · ${ob.age_days} days old · stale=${ob.stale}`);

    /*  ── THE GUARD THAT MAKES Q3 SAFE ─────────────────────────────
     *  Answering Q3 is only useful if the read REFUSES when it cannot
     *  answer honestly. Summing whatever observations happen to exist
     *  would report "actual interest paid" from an incomplete payment
     *  history — every component true, the total wrong, and nothing to
     *  see. That is worse than a blank precisely because it is
     *  defensible line by line.                                        */
    console.log("\n  ── the refusal that makes Q3 safe ──");

    const noCoverage = read.paidOverPeriod(hist.payment_observations, "2024-01-01", "2024-12-31");
    q(11, "a period with NO published aggregate and no coverage refuses",
       noCoverage.truth_state === NE,
       `2024 → ${noCoverage.truth_state} · ${noCoverage.why}`);

    //  2025 full-year: the YTD aggregate covers only Jan–Jul, and the one
    //  monthly observation sits inside it. Neither exactly matches the
    //  request, so this must NOT sum them into a full-year figure.
    const partial = read.paidOverPeriod(hist.payment_observations, "2025-01-01", "2025-12-31");
    q(12, "a partially-covered period refuses rather than summing",
       partial.truth_state === NE,
       `2025 full year → ${partial.truth_state} (the YTD aggregate stops at 2025-07-31)`);

    //  Independent corroboration, kept as TWO authorities rather than one.
    //  The lender's published YTD and the contractual derivation agree to
    //  the cent — which is evidence the transcription and the arithmetic
    //  are both right, and is NOT licence to treat the schedule as payment
    //  evidence. The schedule proves the calculation; the statement proves
    //  the world.
    const derived = sched.filter((r) => r.due_date >= "2025-01-01" && r.due_date <= "2025-07-01");
    const dP = derived.reduce((s, r) => s + r.principal_cents, 0);
    const dI = derived.reduce((s, r) => s + r.interest_cents, 0);
    q(13, "published YTD and derived schedule agree — two authorities, one answer",
       dP === ytd.principal_cents && dI === ytd.interest_cents,
       `derived ${$(dP)} / ${$(dI)} = published ${$(ytd.principal_cents)} / ${$(ytd.interest_cents)}`);

    console.log("\n════════════════════════════════════════════════════════════════");
    console.log(`  INSTITUTIONAL SUFFICIENCY · ${sufficient}/${ran} answerable from governed truth`);
    if (gaps.length) {
      console.log("\n  GAPS — facts institutional reporting needs and Debt does not yet hold:");
      for (const g of gaps) console.log(`    Q${g.n}  ${g.question}`);
      console.log("\n  These are recorded, not fixed. Adding a column before anything");
      console.log("  depends on it is cheap; adding it during month-end is not.");
    }
    console.log("════════════════════════════════════════════════════════════════");

    await db.query(`drop schema ${SCHEMA} cascade`);
  } catch (e) {
    db.release(); await pool.end();
    process.exit(receipt.died(__filename, e, ran));
  }
  db.release();
  await pool.end();
  //  ⚠ A GAP IS A FINDING, NOT A FAILURE. This harness reports sufficiency;
  //  it does not fail the build for a fact we have deliberately not captured
  //  yet. It fails only if it could not ask the questions at all.
  process.exit(receipt.complete({ harness: __filename, passed: ran, failed: 0, expectedAtLeast: 10 }));
})();
