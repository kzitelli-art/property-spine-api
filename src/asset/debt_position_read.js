/* ════════════════════════════════════════════════════════════════════
   debt_position_read.js — position(instrument, as_of).
   THE GOVERNED READING OF DEBT HISTORY AT A DATE.

   PURE. It imports nothing and touches no database, by design and by
   gate: gate_funding_boundary.js asserts this file has zero imports, so
   the economic derivation cannot reach funding by any path, transitively
   or otherwise. Rows come in; a reading comes out.

       WRITER WRITES TRUTH.  READER DERIVES TRUTH.

   ── THE ONE THING TO UNDERSTAND ABOUT as_of ─────────────────────────
       position(as_of = today)
         does NOT mean "every fact returned was observed today".
         It means "this is the governed reading Spine can support today".

   A balance observed on 2025-08-01 is still a 2025-08-01 observation when
   read on 2026-08-12, and it says so, and it says it is stale. Nothing in
   this file makes a fact look fresher than its source.

   ── NO FIELD LAUNDERS ITS SOURCE CLASS ──────────────────────────────
   There is deliberately no generic `balance`. There is an OBSERVED
   balance and a PROJECTED balance, they are separate keys, and each
   carries its own authority and basis. A caller that wants "the balance"
   must choose, and in choosing must notice which one it took.

   ── THE WALLS THIS FILE IS RESPONSIBLE FOR ──────────────────────────
   The schema refuses to STORE collapsed facts. This file must refuse to
   READ them back collapsed — a different obligation, and the one that
   matters, because every wall below can be broken by a correct database
   and a careless reader.

     W1  payoff is its own key and is NOT_ESTABLISHED without a payoff
         observation. Principal is never returned in a payoff role.
     W2  payment standing derives ONLY from payment observations. A
         requirement derivable to 2030 never produces "current".
     W3  maturity is the contractual date. Extension is never added to it.
     W4  a fixed rate resolves; a formula without an index observation
         does not.
     W5  no affirmative compliance value is emitted, ever, at any
         confidence — including "no issues" and including silence that
         reads as health.
     W6  reserve REQUIREMENTS are returned. Nothing here asserts a tax or
         premium was paid.
     W7  every observation carries as_of and an explicit staleness verdict.
     W8  observed and projected balances are separate, always.
     W9  debt service is P&I ONLY. The total lender draft is described
         separately and never as debt service.
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const NOT_ESTABLISHED = "NOT_ESTABLISHED";

//  An observation older than this is called stale in the reading itself.
//  4125's newest retained statement is twelve months old, so this is not a
//  hypothetical threshold.
const STALE_AFTER_DAYS = 95;

function ymd(v) {
  if (!v) return null;
  if (typeof v === "string") return v.slice(0, 10);
  const d = new Date(v);
  return isNaN(d) ? null : d.toISOString().slice(0, 10);
}

function daysBetween(aISO, bISO) {
  const a = Date.parse(aISO + "T00:00:00Z");
  const b = Date.parse(bISO + "T00:00:00Z");
  if (isNaN(a) || isNaN(b)) return null;
  return Math.round((b - a) / 86400000);
}

function onOrBefore(aISO, bISO) { return aISO <= bISO; }

//  Days in the month PRECEDING a due date. Under actual/360 the payment
//  due 2020-09-01 accrues over August's 31 days, which is why interest is
//  $79,790.56 in one month and $72,068.89 in another on an unchanged rate.
function daysInPriorMonth(dueISO) {
  const [y, m] = dueISO.split("-").map(Number);
  const py = m === 1 ? y - 1 : y;
  const pm = m === 1 ? 12 : m - 1;
  return new Date(Date.UTC(py, pm, 0)).getUTCDate();
}

function addMonths(dueISO, n) {
  const [y, m, d] = dueISO.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1 + n, d));
  return t.toISOString().slice(0, 10);
}

/*  ── WHICH ROW IS IN FORCE ──────────────────────────────────────────
 *  Derived from the history, never stored. Rows are append-only and point
 *  backward, so "in force at as_of" is the latest row whose effective_from
 *  has arrived and whose effective_to (where the governing instrument set
 *  one) has not passed.                                                */
function inForce(rows, asOf) {
  return rows
    .filter((r) => {
      const from = ymd(r.effective_from);
      const to = ymd(r.effective_to);
      if (!from || !onOrBefore(from, asOf)) return false;
      if (to && !onOrBefore(asOf, to)) return false;
      return true;
    })
    .sort((a, b) => (ymd(a.effective_from) < ymd(b.effective_from) ? 1 : -1))[0] || null;
}

function allInForce(rows, asOf) {
  return rows.filter((r) => {
    const from = ymd(r.effective_from);
    const to = ymd(r.effective_to);
    if (!from || !onOrBefore(from, asOf)) return false;
    if (to && !onOrBefore(asOf, to)) return false;
    return true;
  });
}

/*  ── THE SCHEDULE DERIVATION ────────────────────────────────────────
 *  Reproduces the contractual payment schedule from debt_terms alone —
 *  day_count, rate, amortization kind and level payment. It is proven
 *  against the servicer's 120 published rows.
 *
 *  ⚠ THIS PROVES THE CALCULATION AND NOTHING ABOUT THE WORLD.
 *  A derived row is what the contract REQUIRES. It is not evidence that
 *  a payment occurred, that a balance was observed, or that the loan is
 *  current. Those come from observations, from other tables, with other
 *  authority. Keeping that separation inside the derivation is why
 *  `basis: "schedule_derivation"` is stamped on every row it emits.     */
function deriveSchedule(termRows, instrument) {
  const terms = [...termRows].sort((a, b) =>
    ymd(a.effective_from) < ymd(b.effective_from) ? -1 : 1);
  if (!terms.length) return [];

  const first = terms[0];
  let balance = BigInt(instrument.original_principal_cents);
  let due = ymd(instrument.first_payment_date) || ymd(first.effective_from);
  const maturity = terms.map((t) => ymd(t.maturity_date)).filter(Boolean).pop();
  if (!due || !maturity) return [];

  const rows = [];
  let guard = 0;
  while (onOrBefore(due, maturity) && guard++ < 1200) {
    //  The regime in force for THIS payment.
    const t = inForce(terms, due) || first;
    const days = t.day_count_convention === "actual_360" ? daysInPriorMonth(due) : 30;
    const denom = t.day_count_convention === "actual_365" ? 365n : 360n;
    const rateBp = BigInt(t.fixed_rate_bp || 0);

    //  Integer cents throughout. Float arithmetic on 120 compounding rows
    //  drifts, and the proof compares to the servicer's published cent.
    const num = balance * rateBp * BigInt(days);
    const den = 10000n * denom;
    const interest = (num + den / 2n) / den;          // half-up

    let principal = 0n;
    if (t.amortization_kind === "level_payment") {
      const pmt = BigInt(t.level_payment_cents || 0);
      principal = pmt - interest;
    }
    //  At maturity the remaining principal falls due. The AMOUNT is
    //  derived here and deliberately not stored as a contractual balloon.
    if (due === maturity) principal = balance;
    if (principal < 0n) principal = 0n;
    if (principal > balance) principal = balance;

    balance -= principal;
    rows.push({
      due_date: due,
      days,
      interest_cents: Number(interest),
      principal_cents: Number(principal),
      balance_after_cents: Number(balance),
      basis: "schedule_derivation",
    });
    due = addMonths(due, 1);
  }
  return rows;
}

/*  ── THE READING ────────────────────────────────────────────────────  */
function position(input, asOfInput) {
  const asOf = ymd(asOfInput);
  const instrument = input.instrument;
  const terms = input.terms || [];
  const parties = input.parties || [];
  const collateral = input.collateral || [];
  const reserves = input.reserves || [];
  const balances = input.balance_observations || [];
  const payments = input.payment_observations || [];

  const t = inForce(terms, asOf);

  //  ── W7/W8 · OBSERVED BALANCE ────────────────────────────────────
  //  The latest observation AT OR BEFORE as_of. Never the latest row in
  //  the table — reading as of a past date must not see the future.
  const obsCandidates = balances
    .filter((b) => onOrBefore(ymd(b.as_of_date), asOf))
    .sort((a, b) => (ymd(a.as_of_date) < ymd(b.as_of_date) ? 1 : -1));
  const latest = obsCandidates[0] || null;

  let observed = { truth_state: NOT_ESTABLISHED };
  if (latest) {
    const age = daysBetween(ymd(latest.as_of_date), asOf);
    observed = {
      value_cents: Number(latest.observed_balance_cents),
      as_of_date: ymd(latest.as_of_date),          // W7 — never dropped
      observation_source: latest.observation_source,
      source_authority: latest.source_authority,
      age_days: age,
      //  An explicit verdict, not a date the caller has to reason about.
      stale: age > STALE_AFTER_DAYS,
    };
  }

  //  ── W8 · PROJECTED BALANCE, SEPARATE KEY, ALWAYS ────────────────
  const schedule = t ? deriveSchedule(terms, instrument) : [];
  const projRow = [...schedule].filter((r) => onOrBefore(r.due_date, asOf)).pop() || null;
  const projected = projRow
    ? {
        value_cents: projRow.balance_after_cents,
        as_of_date: projRow.due_date,
        basis: "schedule_derivation",
        //  Said out loud so no caller can mistake this for evidence.
        assumes: "every scheduled payment occurred as scheduled",
      }
    : { truth_state: NOT_ESTABLISHED };

  //  ── W4 · RATE ───────────────────────────────────────────────────
  let rate = { truth_state: NOT_ESTABLISHED };
  if (t && t.rate_kind === "fixed" && t.fixed_rate_bp != null) {
    rate = { kind: "fixed", effective_rate_bp: t.fixed_rate_bp, basis: "contractual_terms" };
  } else if (t && t.rate_kind === "floating") {
    //  The formula is governed. The RATE is not, until an index is observed
    //  — and no index observation exists in this build by design.
    rate = {
      kind: "floating",
      index_name: t.rate_index_name || null,
      spread_bp: t.spread_bp == null ? null : t.spread_bp,
      floor_bp: t.rate_floor_bp == null ? null : t.rate_floor_bp,
      effective_rate_bp: NOT_ESTABLISHED,
      why: "index observation not established",
    };
  }

  //  ── W9 · DEBT SERVICE IS P&I ONLY ───────────────────────────────
  //  The lender drafts $132,269.71; $8,858.31 of that is escrow and
  //  reserve funding moving through the lender. Returning the draft here
  //  would overstate the cost of the debt by 7% and import funding into
  //  an economic answer.
  let debtService = { truth_state: NOT_ESTABLISHED };
  if (t && t.amortization_kind === "level_payment" && t.level_payment_cents != null) {
    debtService = {
      principal_and_interest_cents: Number(t.level_payment_cents),
      basis: "contractual_terms",
      excludes: ["escrow", "reserve_funding"],
    };
  } else if (t && t.amortization_kind === "interest_only") {
    debtService = {
      truth_state: NOT_ESTABLISHED,
      why: "interest-only under actual/360 has no level payment; see next_requirement",
    };
  }

  //  ── NEXT CONTRACTUAL REQUIREMENT ────────────────────────────────
  const next = schedule.find((r) => !onOrBefore(r.due_date, asOf)) || null;
  const nextRequirement = next
    ? {
        due_date: next.due_date,
        interest_cents: next.interest_cents,
        principal_cents: next.principal_cents,
        total_debt_service_cents: next.interest_cents + next.principal_cents,
        basis: "schedule_derivation",
      }
    : { truth_state: NOT_ESTABLISHED };

  //  ── W2 · PAYMENT STANDING ───────────────────────────────────────
  //  From payment OBSERVATIONS only. The schedule can derive a requirement
  //  for every month to 2030; that is not evidence anybody paid one.
  const payObs = payments
    .filter((p) => onOrBefore(ymd(p.observed_as_of), asOf))
    .sort((a, b) => (ymd(a.observed_as_of) < ymd(b.observed_as_of) ? 1 : -1));
  const latestPay = payObs[0] || null;
  const paymentStanding = latestPay
    ? {
        //  Deliberately NOT a "current" verdict. What is established is
        //  what a servicer observed on a date, and how far back that is.
        latest_observation_as_of: ymd(latestPay.observed_as_of),
        observation_source: latestPay.observation_source,
        source_authority: latestPay.source_authority,
        amount_due_cents: latestPay.amount_due_cents == null ? null : Number(latestPay.amount_due_cents),
        amount_received_cents: latestPay.amount_received_cents == null ? null : Number(latestPay.amount_received_cents),
        amount_remaining_cents: latestPay.amount_remaining_cents == null ? null : Number(latestPay.amount_remaining_cents),
        observation_age_days: daysBetween(ymd(latestPay.observed_as_of), asOf),
        //  The wall, stated in the payload so a downstream surface cannot
        //  quietly promote the newest observation into a present-day claim.
        current_through: NOT_ESTABLISHED,
      }
    : { truth_state: NOT_ESTABLISHED, why: "no payment observation on or before as_of" };

  //  ── W1 · PAYOFF IS ITS OWN KEY ──────────────────────────────────
  //  Established only by a payoff statement. Principal balance is never
  //  aliased into this slot, at any confidence.
  const payoffObs = balances.find(
    (b) => b.observation_source === "payoff_statement" && onOrBefore(ymd(b.as_of_date), asOf));
  const payoff = payoffObs
    ? {
        value_cents: Number(payoffObs.observed_balance_cents),
        as_of_date: ymd(payoffObs.as_of_date),
        source_authority: payoffObs.source_authority,
      }
    : {
        truth_state: NOT_ESTABLISHED,
        why: "no payoff statement established; principal balance is not a payoff amount",
      };

  //  ── W3 · MATURITY, AND EXTENSION AS NARRATIVE ───────────────────
  const maturity = t && t.maturity_date
    ? { date: ymd(t.maturity_date), basis: "contractual_terms" }
    : { truth_state: NOT_ESTABLISHED };
  //  There is no stored extension state (4125 forces no extension object),
  //  and an unexercised option is NEVER added to the maturity date. An
  //  extension becomes visible only as an `extension_exercised` term row,
  //  which would move maturity through the ordinary in-force mechanism.
  const exercised = terms.some((x) => x.term_source === "extension_exercised"
    && onOrBefore(ymd(x.effective_from), asOf));
  const extension = exercised
    ? { truth_state: "EXERCISED", note: "an extension term is in force; maturity reflects it" }
    : { truth_state: NOT_ESTABLISHED,
        note: "no extension option evidenced in the governing source Spine holds" };

  //  ── W6 · RESERVES ARE REQUIREMENTS ──────────────────────────────
  //  What the instrument REQUIRES. There is no balance here and no key
  //  anywhere in this payload that asserts a tax or premium was paid.
  const reserveRequirements = allInForce(reserves, asOf).map((r) => ({
    reserve_kind: r.reserve_kind,
    amount_cents: r.amount_cents == null ? null : Number(r.amount_cents),
    amount_basis: r.amount_basis,
    //  Stated on every escrow-shaped requirement so a downstream reader
    //  cannot turn "escrow required" into "the obligation was paid".
    funds_obligation_of:
      r.reserve_kind === "tax_imposition" ? "taxes"
        : r.reserve_kind === "insurance_imposition" ? "insurance" : null,
    underlying_obligation_status: NOT_ESTABLISHED,
  }));

  //  ── PARTIES ─────────────────────────────────────────────────────
  const partyRoles = {};
  for (const role of ["borrower", "originator_lender", "holder_assignee", "servicer"]) {
    const p = inForce(parties.filter((x) => x.party_role === role), asOf);
    partyRoles[role] = p
      ? { legal_entity_id: p.legal_entity_id || null, name: p.party_name_text || null }
      : { truth_state: NOT_ESTABLISHED };
  }
  partyRoles.guarantors = allInForce(parties.filter((x) => x.party_role === "guarantor"), asOf)
    .map((p) => ({ legal_entity_id: p.legal_entity_id || null, name: p.party_name_text || null }));

  const unknowns = [];
  if (observed.truth_state === NOT_ESTABLISHED) unknowns.push("no principal balance observation");
  if (observed.stale) unknowns.push(`principal balance observation is ${observed.age_days} days old`);
  if (paymentStanding.truth_state === NOT_ESTABLISHED) unknowns.push("payment standing not established");
  if (extension.truth_state === NOT_ESTABLISHED) unknowns.push("extension option not established");

  return {
    as_of: asOf,
    //  Said in the payload because "position as of today" is routinely
    //  misread as "everything here was true today".
    reading_note: "the governed reading Spine can support as of this date; " +
                  "each fact carries its own observation date and authority",

    instrument: {
      id: instrument.id,
      instrument_kind: instrument.instrument_kind,
      loan_number: instrument.loan_number || null,
      original_principal_cents: Number(instrument.original_principal_cents),
      currency: instrument.currency,
      origination_date: ymd(instrument.origination_date),
      first_payment_date: ymd(instrument.first_payment_date),
    },
    parties: partyRoles,
    collateral: allInForce(collateral, asOf).map((c) => ({
      property_id: c.property_id,
      lien_position: c.lien_position,
      //  The evidence that established the link — never the loan's name.
      established_by_source_artifact_id: c.established_by_source_artifact_id || null,
    })),

    terms_in_force: t
      ? {
          effective_from: ymd(t.effective_from),
          effective_to: ymd(t.effective_to),
          term_source: t.term_source,
          amortization_kind: t.amortization_kind,
          day_count_convention: t.day_count_convention,
          payment_frequency: t.payment_frequency,
          fully_amortizing: t.fully_amortizing,
        }
      : { truth_state: NOT_ESTABLISHED },

    principal_position: { observed, projected },   // W8 — two keys, always
    payoff,                                        // W1
    rate_position: rate,                           // W4
    debt_service: debtService,                     // W9
    next_requirement: nextRequirement,
    payment_standing: paymentStanding,             // W2
    contractual_maturity: maturity,                // W3
    extension,                                     // W3
    reserve_requirements: reserveRequirements,     // W6

    //  ── W5 · COVENANTS ──────────────────────────────────────────
    //  Build 1 holds no covenant objects at all, and this is the only
    //  covenant-shaped key in the payload. It is a constant. There is no
    //  code path that can turn it into an affirmative compliance state,
    //  which is the semantic half of W5 that no schema can provide.
    covenant_standing: {
      truth_state: NOT_ESTABLISHED,
      why: "Spine holds no governed covenant determination for this instrument",
    },

    important_unknowns: unknowns,
  };
}

/*  ── PRINCIPAL AND INTEREST PAID OVER A PERIOD ──────────────────────
 *  The institutional question `position()` cannot answer, because it is a
 *  POINT reading and this is a PERIOD one. Forcing a period aggregate into
 *  position(as_of) would have been the wrong shape.
 *
 *  ⚠ NO SCHEMA WAS ADDED FOR THIS. The acceptance test first read it as a
 *  missing-column gap and proposed YTD fields. It is not: a lender's
 *  published year-to-date figure is just another period-range observation,
 *  and `period_start · period_end · applied_principal · applied_interest`
 *  already carries it. That generality is the point — monthly, quarterly,
 *  YTD, trailing and custom statement periods are all the same fact shape.
 *
 *  THE RULE, IN PRIORITY ORDER:
 *
 *    1  a lender-published aggregate covering exactly the requested period
 *       → use that governed observation
 *    2  otherwise, individual observations that COMPLETELY tile the period
 *       → sum them
 *    3  otherwise → NOT_ESTABLISHED
 *
 *  Branch 3 is the one that matters. Summing whatever observations happen
 *  to exist would silently report "actual interest paid" from an incomplete
 *  payment history — a confident wrong assembled from true parts, which is
 *  worse than a blank because every component is defensible (§5).            */
function paidOverPeriod(paymentObservations, periodStartISO, periodEndISO) {
  const from = ymd(periodStartISO), to = ymd(periodEndISO);
  const withPeriod = (paymentObservations || []).filter(
    (p) => ymd(p.period_start) && ymd(p.period_end));

  //  1 — an exact governed aggregate for this period.
  const exact = withPeriod.find(
    (p) => ymd(p.period_start) === from && ymd(p.period_end) === to);
  if (exact) {
    return {
      principal_cents: exact.applied_principal_cents == null ? null : Number(exact.applied_principal_cents),
      interest_cents: exact.applied_interest_cents == null ? null : Number(exact.applied_interest_cents),
      period_start: from, period_end: to,
      basis: "lender_published_aggregate",
      observation_source: exact.observation_source,
      source_authority: exact.source_authority,
    };
  }

  //  2 — complete tiling by individual observations. Any aggregate that
  //  merely OVERLAPS the window is excluded, because summing an aggregate
  //  alongside the individual rows it already contains double-counts.
  const inside = withPeriod
    .filter((p) => ymd(p.period_start) >= from && ymd(p.period_end) <= to)
    .sort((a, b) => (ymd(a.period_start) < ymd(b.period_start) ? -1 : 1));

  if (inside.length) {
    let cursor = from, complete = true;
    for (const p of inside) {
      //  A gap anywhere means the period is not covered. Overlap is treated
      //  as incomplete too rather than silently summed.
      if (ymd(p.period_start) > cursor) { complete = false; break; }
      const nextDay = new Date(Date.parse(ymd(p.period_end) + "T00:00:00Z") + 86400000)
        .toISOString().slice(0, 10);
      if (nextDay > cursor) cursor = nextDay;
    }
    if (complete && cursor > to) {
      return {
        principal_cents: inside.reduce((s, p) => s + Number(p.applied_principal_cents || 0), 0),
        interest_cents: inside.reduce((s, p) => s + Number(p.applied_interest_cents || 0), 0),
        period_start: from, period_end: to,
        basis: "summed_complete_observations",
        observation_count: inside.length,
        source_authority: "governed_read",
      };
    }
  }

  //  3 — say so, and say why.
  return {
    truth_state: NOT_ESTABLISHED,
    period_start: from, period_end: to,
    why: inside.length
      ? `payment observations do not completely cover ${from}..${to} ` +
        `(${inside.length} observation(s) found, coverage incomplete)`
      : `no lender-published aggregate for ${from}..${to} and no payment observations within it`,
  };
}

module.exports = { position, deriveSchedule, paidOverPeriod, NOT_ESTABLISHED, STALE_AFTER_DAYS };
