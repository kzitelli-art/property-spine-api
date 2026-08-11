/* ════════════════════════════════════════════════════════════════════
   insurance_program_service.js — THE canonical writer for insurance
   programs, coverages and their sourced identifiers.

   One place establishes an insurance term. Every surface that ever
   offers these verbs calls this.

   ── IT KNOWS NOTHING ABOUT FINANCING, AND THAT IS THE POINT ─────────
   No down payment, no principal financed, no finance charge, no
   installment, no escrow, no payment. This service can establish what a
   property's insurance costs without knowing IPFS exists, which is the
   exact seam the June 2026 Skyline workpaper reveals: it reconstructs
   the annual cost from the financing stream, making the payment
   instrument the source of the economic fact.

   Premium financing may FUND the obligation. It never DEFINES it.

   ── CURRENCY IS REFUSED, NEVER DEFAULTED ───────────────────────────
   There is no governed property/deal currency primitive in this repo.
   Insurance does not invent one. Currency is an explicit governed fact
   of the program, and establishment is REFUSED without it. The only
   other currency in the repo carries `default 'USD'` (migration 105) —
   the silent default this must not repeat.

   ── POLICY NUMBER IS EVIDENCE, NOT IDENTITY ────────────────────────
   The same Ally policy already appears under three different textual
   numbers across systems. Identity is the Spine uuid; renderings
   accumulate as sourced identifiers, all true at once, and Spine never
   picks a favourite.

   CLASS 1 — permanent product primitive.
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const COVERAGE_TYPES = Object.freeze([
  "property", "general_liability", "umbrella_excess", "other",
]);
const IDENTIFIER_ISSUERS = Object.freeze([
  "carrier", "broker", "lender", "internal", "other",
]);

function insuranceError(code, message, extra = {}) {
  const e = new Error(message); e.code = code; Object.assign(e, extra); return e;
}

/*  ── ESTABLISH A PROGRAM ────────────────────────────────────────────
 *  A placement term with a durable Spine identity and an explicit
 *  currency. Nothing about who pays for it or how.
 */
async function establishProgram(client, {
  program_name, term_start, term_end, currency_code, user_id,
} = {}) {
  if (!program_name || !String(program_name).trim()) {
    throw insuranceError("BAD_INPUT", "program_name is required");
  }
  if (!term_start || !term_end) {
    throw insuranceError("BAD_INPUT", "term_start and term_end are required");
  }
  if (!user_id) throw insuranceError("BAD_INPUT", "user_id is required");

  //  THE CURRENCY REFUSAL. Named, so the operator learns what is missing
  //  rather than receiving a constraint violation — and so nobody is
  //  tempted to make it default.
  if (!currency_code) {
    throw insuranceError("CURRENCY_NOT_ESTABLISHED",
      "currency_code is required to establish an insurance term. Spine has no governed " +
      "property or deal currency to fall back on, and will not assume one.");
  }
  if (!/^[A-Z]{3}$/.test(String(currency_code))) {
    throw insuranceError("BAD_INPUT",
      `currency_code must be a three-letter ISO code, received ${JSON.stringify(currency_code)}`);
  }

  const { rows } = await client.query(
    `insert into insurance_programs
       (program_name, term_start, term_end, currency_code, established_by_user_id)
     values ($1,$2,$3,$4,$5) returning *`,
    [String(program_name).trim(), term_start, term_end, currency_code, user_id]);
  return rows[0];
}

/*  ── ESTABLISH A COVERAGE ───────────────────────────────────────────
 *  Its own period, its own carrier, its own economics. `total_cents` is
 *  a generated column, so the parts and the total cannot drift.
 *
 *  Broker fee is a NAMED COMPONENT rather than something recovered from
 *  a payment stream — which is what makes the prior-year concept
 *  ("allocated annual insurance cost + brokerage fee") expressible
 *  without reference to how the premium was funded.
 */
async function establishCoverage(client, {
  program_id, coverage_type, carrier_name = null, broker_name = null,
  coverage_period_start, coverage_period_end,
  premium_cents, taxes_cents = 0, fees_cents = 0, broker_fee_cents = 0,
  user_id,
} = {}) {
  if (!program_id) throw insuranceError("BAD_INPUT", "program_id is required");
  if (!COVERAGE_TYPES.includes(coverage_type)) {
    throw insuranceError("BAD_INPUT",
      `coverage_type must be one of ${COVERAGE_TYPES.join(", ")}`);
  }
  if (!coverage_period_start || !coverage_period_end) {
    throw insuranceError("BAD_INPUT", "coverage_period_start and coverage_period_end are required");
  }
  if (!user_id) throw insuranceError("BAD_INPUT", "user_id is required");

  //  Cents, integer, never floating point. A premium arriving as 12345.67
  //  is a caller bug and is refused rather than silently rounded.
  for (const [k, v] of Object.entries({
    premium_cents, taxes_cents, fees_cents, broker_fee_cents,
  })) {
    if (!Number.isInteger(v) || v < 0) {
      throw insuranceError("BAD_INPUT", `${k} must be a non-negative integer of cents`);
    }
  }

  const prog = (await client.query(
    `select * from insurance_programs where id = $1`, [program_id])).rows[0];
  if (!prog) throw insuranceError("NOT_FOUND", "insurance program not found");

  const { rows } = await client.query(
    `insert into insurance_coverages
       (program_id, coverage_type, carrier_name, broker_name,
        coverage_period_start, coverage_period_end,
        premium_cents, taxes_cents, fees_cents, broker_fee_cents,
        established_by_user_id)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning *`,
    [program_id, coverage_type, carrier_name, broker_name,
     coverage_period_start, coverage_period_end,
     premium_cents, taxes_cents, fees_cents, broker_fee_cents, user_id]);
  return rows[0];
}

/*  ── RECORD A SOURCED IDENTIFIER ────────────────────────────────────
 *  An observation of how someone else names this coverage. Recording a
 *  second, differently-formatted number for the same coverage is NORMAL
 *  and creates no conflict: both rows are true, and neither becomes the
 *  identity.
 */
async function recordIdentifier(client, {
  coverage_id, identifier_value, issued_by,
  observed_in_artifact_id = null, observed_as_of = null, user_id,
} = {}) {
  if (!coverage_id) throw insuranceError("BAD_INPUT", "coverage_id is required");
  if (!identifier_value || !String(identifier_value).trim()) {
    throw insuranceError("BAD_INPUT", "identifier_value is required");
  }
  if (!IDENTIFIER_ISSUERS.includes(issued_by)) {
    throw insuranceError("BAD_INPUT", `issued_by must be one of ${IDENTIFIER_ISSUERS.join(", ")}`);
  }
  if (!user_id) throw insuranceError("BAD_INPUT", "user_id is required");

  //  Deliberately NOT normalised, trimmed-only. Stripping punctuation to
  //  make "01-CPK-104720-02" match "01CPK10472002" would be Spine
  //  deciding which rendering is canonical — the exact judgement this
  //  table exists to avoid making.
  const { rows } = await client.query(
    `insert into insurance_coverage_identifiers
       (coverage_id, identifier_value, issued_by, observed_in_artifact_id,
        observed_as_of, recorded_by_user_id)
     values ($1,$2,$3,$4,$5,$6)
     on conflict (coverage_id, identifier_value, issued_by) do nothing
     returning *`,
    [coverage_id, String(identifier_value).trim(), issued_by,
     observed_in_artifact_id, observed_as_of, user_id]);
  return rows[0] || null;
}

module.exports = {
  COVERAGE_TYPES, IDENTIFIER_ISSUERS,
  establishProgram, establishCoverage, recordIdentifier, insuranceError,
};
