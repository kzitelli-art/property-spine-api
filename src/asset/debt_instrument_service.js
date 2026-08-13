/* ════════════════════════════════════════════════════════════════════
   debt_instrument_service.js — THE CANONICAL DEBT WRITERS.

   Deliberately boring. These functions establish governed Debt history
   and do nothing else:

       validate · attribute to a source · append · effective-date

   WHAT THEY DO NOT DO, ON PURPOSE:
     · they do not calculate position — that is debt_position_read.js
     · they do not answer questions
     · they do not infer a missing value, ever
     · they do not touch tax or insurance truth (gate_funding_boundary.js)

   WRITER WRITES TRUTH. READER DERIVES TRUTH. A writer that starts
   computing "current" is how a mutable status row grows back after the
   schema refused to have one.

   ── APPEND-ONLY MEANS POINTS BACKWARD ───────────────────────────────
   Superseding writers INSERT a row carrying `supersedes_*_id`. There is
   no update path here, and no `superseded_by` column to update. An
   earlier canonical record is never rewritten because a later fact
   arrived — which is the whole reason "what was the maturity before the
   modification" is a read rather than a reconstruction.

   ── UNKNOWN STAYS UNKNOWN ───────────────────────────────────────────
   Nothing here supplies a default for a governed economic value. No
   currency default, no zero-instead-of-null amount, no inferred date.
   PHILOSOPHY §5: an honest blank beats a confident wrong, and a writer
   is exactly where a confident wrong gets manufactured.

   CLASS 1 — permanent product primitive.
   ════════════════════════════════════════════════════════════════════ */
"use strict";

function required(v, name) {
  if (v === undefined || v === null || v === "") {
    const e = new Error(`debt writer: ${name} is required and was not supplied`);
    e.code = "DEBT_MISSING_FIELD";
    throw e;
  }
  return v;
}

//  Attribution is not optional. A governed fact that cannot say who
//  recorded it is not governed, and `source_artifact_id` is separately
//  encouraged because "why does Spine believe this" is the question the
//  whole domain exists to answer.
function actor(opts) {
  return required(opts && opts.recorded_by_user_id, "recorded_by_user_id");
}

async function establishInstrument(db, opts) {
  const o = opts || {};
  required(o.instrument_kind, "instrument_kind");
  required(o.original_principal_cents, "original_principal_cents");
  //  ⚠ NO DEFAULT. The repo has no governed currency context; Debt
  //  resolves it explicitly or refuses to record the instrument.
  required(o.currency, "currency");
  const r = await db.query(
    `insert into debt_instruments
       (instrument_kind, loan_number, original_principal_cents, currency,
        origination_date, first_payment_date, source_artifact_id,
        provenance_note, recorded_by_user_id)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning *`,
    [o.instrument_kind, o.loan_number || null, o.original_principal_cents, o.currency,
     o.origination_date || null, o.first_payment_date || null,
     o.source_artifact_id || null, o.provenance_note || null, actor(o)]);
  return r.rows[0];
}

//  Roles are effective-dated because an assignment is a dated event. ORIX
//  originated 4125 and the security instrument was assigned to Freddie
//  Mac; collapsing those into one `lender_name` loses the assignment.
async function addParty(db, opts) {
  const o = opts || {};
  required(o.instrument_id, "instrument_id");
  required(o.party_role, "party_role");
  required(o.effective_from, "effective_from");
  const hasEntity = !!o.legal_entity_id;
  const hasName = !!(o.party_name_text && o.party_name_text.trim());
  if (hasEntity === hasName) {
    const e = new Error(
      "debt writer: a party is a legal entity XOR an attributed name — " +
      "natural-person guarantors are recorded as names and never minted as durable people");
    e.code = "DEBT_PARTY_SUBJECT";
    throw e;
  }
  const r = await db.query(
    `insert into debt_instrument_parties
       (instrument_id, party_role, legal_entity_id, party_name_text,
        effective_from, effective_to, supersedes_party_id,
        source_artifact_id, provenance_note, recorded_by_user_id)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning *`,
    [o.instrument_id, o.party_role, o.legal_entity_id || null,
     hasName ? o.party_name_text.trim() : null,
     o.effective_from, o.effective_to || null, o.supersedes_party_id || null,
     o.source_artifact_id || null, o.provenance_note || null, actor(o)]);
  return r.rows[0];
}

//  The collateral link carries the EVIDENCE that established it. This
//  loan's own name is "LVL 4125" and a 4233 document has said "LVL 4125"
//  too, so a property is never resolved from a loan's name or number.
async function addCollateral(db, opts) {
  const o = opts || {};
  required(o.instrument_id, "instrument_id");
  required(o.property_id, "property_id");
  required(o.effective_from, "effective_from");
  const r = await db.query(
    `insert into debt_instrument_properties
       (instrument_id, property_id, lien_position, effective_from, effective_to,
        established_by_source_artifact_id, provenance_note, recorded_by_user_id)
     values ($1,$2,$3,$4,$5,$6,$7,$8) returning *`,
    [o.instrument_id, o.property_id, o.lien_position || null,
     o.effective_from, o.effective_to || null,
     o.established_by_source_artifact_id || null, o.provenance_note || null, actor(o)]);
  return r.rows[0];
}

//  One mechanism for the original instrument's two regimes, any later
//  amendment, and any extension exercise. `effective_to` is passed ONLY
//  where the governing instrument itself established the end — 4125's
//  interest-only period legitimately carries 2024-08-01.
async function addTerm(db, opts) {
  const o = opts || {};
  required(o.instrument_id, "instrument_id");
  required(o.effective_from, "effective_from");
  required(o.term_source, "term_source");
  required(o.rate_kind, "rate_kind");
  required(o.day_count_convention, "day_count_convention");
  required(o.payment_frequency, "payment_frequency");
  required(o.amortization_kind, "amortization_kind");
  const r = await db.query(
    `insert into debt_terms
       (instrument_id, effective_from, effective_to, term_source,
        rate_kind, fixed_rate_bp, rate_index_name, spread_bp, rate_floor_bp, rate_cap_bp,
        day_count_convention, payment_frequency, amortization_kind, level_payment_cents,
        fully_amortizing, maturity_date, supersedes_term_id,
        source_artifact_id, provenance_note, recorded_by_user_id)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
     returning *`,
    [o.instrument_id, o.effective_from, o.effective_to || null, o.term_source,
     o.rate_kind, o.fixed_rate_bp == null ? null : o.fixed_rate_bp,
     o.rate_index_name || null, o.spread_bp == null ? null : o.spread_bp,
     o.rate_floor_bp == null ? null : o.rate_floor_bp,
     o.rate_cap_bp == null ? null : o.rate_cap_bp,
     o.day_count_convention, o.payment_frequency, o.amortization_kind,
     o.level_payment_cents == null ? null : o.level_payment_cents,
     o.fully_amortizing === true, o.maturity_date || null, o.supersedes_term_id || null,
     o.source_artifact_id || null, o.provenance_note || null, actor(o)]);
  return r.rows[0];
}

//  What the instrument REQUIRES. There is no balance parameter and no
//  balance column: a tax escrow balance is the Tax domain's funding truth
//  and an insurance escrow balance is Insurance's. Debt states the
//  requirement; it never holds or implies what is in the account.
async function addReserveRequirement(db, opts) {
  const o = opts || {};
  required(o.instrument_id, "instrument_id");
  required(o.reserve_kind, "reserve_kind");
  required(o.effective_from, "effective_from");
  const r = await db.query(
    `insert into debt_reserve_requirements
       (instrument_id, reserve_kind, amount_cents, amount_basis,
        effective_from, effective_to, supersedes_requirement_id,
        source_artifact_id, provenance_note, recorded_by_user_id)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning *`,
    [o.instrument_id, o.reserve_kind,
     //  Null is legitimate. A reserve may be established without a governed
     //  amount; unknown stays unknown and never becomes zero.
     o.amount_cents == null ? null : o.amount_cents,
     o.amount_basis || null, o.effective_from, o.effective_to || null,
     o.supersedes_requirement_id || null,
     o.source_artifact_id || null, o.provenance_note || null, actor(o)]);
  return r.rows[0];
}

//  ⚠ OBSERVATIONS ONLY. There is no enum value for a schedule projection
//  and this writer must never acquire one: a projected balance parked here
//  would later be read back as though someone had observed it. Projections
//  are derived in debt_position_read.js and carry their own basis.
async function recordBalanceObservation(db, opts) {
  const o = opts || {};
  required(o.instrument_id, "instrument_id");
  required(o.observed_balance_cents, "observed_balance_cents");
  //  The as-of is part of the truth, not metadata. An observation without
  //  one cannot be aged, and an un-ageable observation reads as current.
  required(o.as_of_date, "as_of_date");
  required(o.observation_source, "observation_source");
  const r = await db.query(
    `insert into debt_balance_observations
       (instrument_id, observed_balance_cents, as_of_date, observation_source,
        source_authority, source_artifact_id, provenance_note, recorded_by_user_id)
     values ($1,$2,$3,$4,$5,$6,$7,$8) returning *`,
    [o.instrument_id, o.observed_balance_cents, o.as_of_date, o.observation_source,
     o.source_authority || "governed_read", o.source_artifact_id || null,
     o.provenance_note || null, actor(o)]);
  return r.rows[0];
}

//  What a lender or servicer OBSERVED about payment standing — not a cash
//  settlement. The servicer's own statement separates AMT DUE / AMT
//  RECEIVED / AMT REMAINING plus the application split, and this stores
//  exactly that rather than a normalised invention.
async function recordPaymentObservation(db, opts) {
  const o = opts || {};
  required(o.instrument_id, "instrument_id");
  required(o.observed_as_of, "observed_as_of");
  required(o.observation_source, "observation_source");
  const r = await db.query(
    `insert into debt_payment_observations
       (instrument_id, observed_as_of, period_start, period_end,
        amount_due_cents, amount_received_cents, amount_remaining_cents,
        applied_principal_cents, applied_interest_cents, applied_escrow_cents,
        applied_other_cents, observation_source, source_authority,
        source_artifact_id, provenance_note, recorded_by_user_id)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) returning *`,
    [o.instrument_id, o.observed_as_of, o.period_start || null, o.period_end || null,
     o.amount_due_cents == null ? null : o.amount_due_cents,
     o.amount_received_cents == null ? null : o.amount_received_cents,
     o.amount_remaining_cents == null ? null : o.amount_remaining_cents,
     o.applied_principal_cents == null ? null : o.applied_principal_cents,
     o.applied_interest_cents == null ? null : o.applied_interest_cents,
     o.applied_escrow_cents == null ? null : o.applied_escrow_cents,
     o.applied_other_cents == null ? null : o.applied_other_cents,
     o.observation_source, o.source_authority || "governed_read",
     o.source_artifact_id || null, o.provenance_note || null, actor(o)]);
  return r.rows[0];
}

//  Fetches the governed history for one instrument. It composes NOTHING —
//  it hands rows to debt_position_read.position(), which is pure and
//  imports nothing so the economic derivation cannot reach funding.
async function loadHistory(db, instrumentId) {
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

module.exports = {
  establishInstrument, addParty, addCollateral, addTerm,
  addReserveRequirement, recordBalanceObservation, recordPaymentObservation,
  loadHistory,
};
