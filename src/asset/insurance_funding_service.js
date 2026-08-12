/* ════════════════════════════════════════════════════════════════════
   insurance_funding_service.js — THE canonical writer for HOW insurance
   is paid for. It never touches WHAT it costs.

   ── IT LIVES ON THE FUNDING SIDE OF AN EXECUTABLE WALL ──────────────
   `tests/gate_funding_boundary.js` asserts, structurally:

       the economic chain may never import this file, transitively
       this file may REFERENCE the coverage it funds — reads, joins, FKs
       this file may never INSERT/UPDATE/DELETE an economic table

   That is the whole architecture in three lines. Premium financing may
   FUND the obligation; it never DEFINES it. The insurance accrual keeps
   dividing an allocated annual cost by a coverage term and cannot see
   anything written here.

   ── FINANCE CHARGE IS NOT INSURANCE EXPENSE ─────────────────────────
   It is the cost of borrowing to pay a premium early. If it ever reaches
   the accrual, the property's insurance looks more expensive because of
   how it was financed — which is the June 2026 workpaper defect, and the
   reason migration 161 exists.

   ── ABSENCE IS UNKNOWN, NOT `direct` ────────────────────────────────
   No arrangement means Spine does not know how this is paid. `direct` is
   a POSITIVE finding somebody established. Defaulting to it would invent
   a healthy state from missing information (§5).

   ── A SLICE AND A CORRECTION ARE DIFFERENT VERBS ────────────────────
   Same distinction the allocation service draws, for the same reason:

       openArrangement    the WORLD changed — financed this year, direct
                          last year. Moves only the future; last year's
                          answer stays true.
       correctArrangement the CLAIM was wrong. The predecessor is
                          preserved and stays readable.

   CLASS 1 — permanent product primitive.
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const FUNDING_METHODS = Object.freeze(["direct", "lender_escrow", "premium_financed"]);

function fundingError(code, message, extra = {}) {
  const e = new Error(message); e.code = code; Object.assign(e, extra); return e;
}

function requireCents(name, v, { positive = false } = {}) {
  if (v === null || v === undefined) return null;
  if (!Number.isInteger(v) || v < 0 || (positive && v <= 0)) {
    throw fundingError("BAD_INPUT",
      `${name} must be a ${positive ? "positive" : "non-negative"} integer of cents`);
  }
  return v;
}

/*  Which mechanism's detail may accompany which method. A direct payment
 *  with an installment schedule is not a direct payment, and accepting
 *  the contradiction would leave a row nobody can read honestly. */
function validateShape({ funding_method, finance, escrow }) {
  if (!FUNDING_METHODS.includes(funding_method)) {
    throw fundingError("BAD_INPUT",
      `funding_method must be one of ${FUNDING_METHODS.join(", ")}`);
  }
  if (funding_method === "premium_financed") {
    if (!finance || !(finance.finance_provider && String(finance.finance_provider).trim())) {
      throw fundingError("FINANCE_PROVIDER_REQUIRED",
        "premium financing requires the finance provider. Who lent the premium is the " +
        "first thing this arrangement has to be able to say.");
    }
    if (escrow) {
      throw fundingError("BAD_INPUT",
        "a premium-financed arrangement cannot also carry escrow detail");
    }
  }
  if (funding_method === "lender_escrow" && finance) {
    throw fundingError("BAD_INPUT",
      "an escrowed arrangement cannot also carry premium-finance detail");
  }
  if (funding_method === "direct" && (finance || escrow)) {
    throw fundingError("DIRECT_HAS_NO_INSTRUMENT",
      "a directly-paid arrangement has no finance agreement and no escrow account. " +
      "If either exists, the funding method is not direct.");
  }
}

/*  ── OPEN A NEW FUNDING SLICE ───────────────────────────────────────
 *  The prior live slice for this (coverage, property) is closed at
 *  effective_from. Its facts are never touched — that is what keeps last
 *  year's answer explainable after this year's arrangement changes.
 */
async function openArrangement(client, spec = {}) {
  const {
    coverage_id, property_id, funding_method,
    effective_from, effective_to = null,
    source_artifact_id = null, provenance_note = null,
    finance = null, escrow = null, user_id,
  } = spec;

  if (!coverage_id || !property_id) {
    throw fundingError("BAD_INPUT", "coverage_id and property_id are required");
  }
  if (!effective_from) throw fundingError("BAD_INPUT", "effective_from is required");
  if (!user_id) throw fundingError("BAD_INPUT", "user_id is required");
  if (!source_artifact_id && !(provenance_note && String(provenance_note).trim())) {
    throw fundingError("PROVENANCE_REQUIRED",
      "a funding arrangement requires provenance: a source document, or a note " +
      "recording where this came from");
  }
  validateShape({ funding_method, finance, escrow });

  //  ── YOU CANNOT FUND A POLICY THIS PROPERTY IS NOT ON ─────────────
  //  A READ of the economic side, which the boundary permits and which
  //  gives a sayable refusal instead of a foreign-key violation.
  const named = (await client.query(
    `select 1 from insurance_coverage_properties
      where coverage_id = $1 and property_id = $2`, [coverage_id, property_id])).rows[0];
  if (!named) {
    throw fundingError("PARTICIPATION_REQUIRED",
      "this property is not recorded as named on this coverage, so there is nothing " +
      "here for it to be funding. Record that the property is on the policy first.");
  }

  //  Close the prior live slice for this scope before opening the next.
  await client.query(
    `update insurance_funding_arrangements a
        set effective_to = $3
      where a.coverage_id = $1 and a.property_id = $2
        and not exists (select 1 from insurance_funding_arrangements s
                         where s.supersedes_id = a.id)
        and a.effective_from < $3
        and (a.effective_to is null or a.effective_to > $3)`,
    [coverage_id, property_id, effective_from]);

  const arr = (await client.query(
    `insert into insurance_funding_arrangements
       (coverage_id, property_id, funding_method, effective_from, effective_to,
        source_artifact_id, provenance_note, recorded_by_user_id)
     values ($1,$2,$3,$4,$5,$6,$7,$8) returning *`,
    [coverage_id, property_id, funding_method, effective_from, effective_to,
     source_artifact_id, provenance_note, user_id])).rows[0];

  if (funding_method === "premium_financed") {
    //  EVERY AMOUNT HERE IS A FINANCING FACT. None of it is insurance
    //  expense and none of it can reach the accrual — the accrual reads
    //  the coverage, and nothing in this file is visible to it.
    await client.query(
      `insert into premium_finance_agreements
         (arrangement_id, finance_provider, agreement_reference,
          down_payment_cents, principal_financed_cents, finance_charge_cents,
          installment_count, installment_cents, first_payment_date, recorded_by_user_id)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [arr.id, String(finance.finance_provider).trim(),
       finance.agreement_reference || null,
       requireCents("down_payment_cents", finance.down_payment_cents ?? null),
       requireCents("principal_financed_cents", finance.principal_financed_cents ?? null,
                    { positive: true }),
       requireCents("finance_charge_cents", finance.finance_charge_cents ?? null),
       finance.installment_count ?? null,
       requireCents("installment_cents", finance.installment_cents ?? null, { positive: true }),
       finance.first_payment_date || null, user_id]);
  }

  if (funding_method === "lender_escrow" && escrow) {
    await client.query(
      `insert into insurance_escrow_arrangements
         (arrangement_id, lender_name, servicer_name, escrow_account_reference,
          recorded_by_user_id)
       values ($1,$2,$3,$4,$5)`,
      [arr.id, escrow.lender_name || null, escrow.servicer_name || null,
       escrow.escrow_account_reference || null, user_id]);
  }

  return arr;
}

/*  ── CORRECT AN ARRANGEMENT ─────────────────────────────────────────
 *  The same claim, restated. The predecessor is preserved and remains
 *  readable, and the reason is required by the database.
 *
 *  This is NOT how a mid-term change is recorded. If the world changed,
 *  openArrangement is the verb — otherwise the correction erases the
 *  fact that the earlier arrangement was ever true.
 */
async function correctArrangement(client, {
  arrangement_id, funding_method, revision_reason,
  source_artifact_id = null, provenance_note = null,
  finance = null, escrow = null, user_id,
} = {}) {
  if (!arrangement_id) throw fundingError("BAD_INPUT", "arrangement_id is required");
  if (!(revision_reason && String(revision_reason).trim())) {
    throw fundingError("REASON_REQUIRED",
      "a correction requires a reason. Without one the record cannot explain why the " +
      "earlier arrangement changed.");
  }
  if (!user_id) throw fundingError("BAD_INPUT", "user_id is required");

  const prior = (await client.query(
    `select * from insurance_funding_arrangements where id = $1 for update`,
    [arrangement_id])).rows[0];
  if (!prior) throw fundingError("NOT_FOUND", "funding arrangement not found");

  const method = funding_method || prior.funding_method;
  validateShape({ funding_method: method, finance, escrow });

  return openCorrection(client, { prior, method, revision_reason,
    source_artifact_id, provenance_note, finance, escrow, user_id });
}

async function openCorrection(client, {
  prior, method, revision_reason, source_artifact_id, provenance_note,
  finance, escrow, user_id,
}) {
  const arr = (await client.query(
    `insert into insurance_funding_arrangements
       (coverage_id, property_id, funding_method, effective_from, effective_to,
        source_artifact_id, provenance_note, supersedes_id, revision_reason,
        recorded_by_user_id)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning *`,
    [prior.coverage_id, prior.property_id, method,
     //  A correction governs the SAME period the mistaken claim governed.
     prior.effective_from, prior.effective_to,
     source_artifact_id || prior.source_artifact_id,
     provenance_note || prior.provenance_note,
     prior.id, String(revision_reason).trim(), user_id])).rows[0];

  if (method === "premium_financed" && finance) {
    await client.query(
      `insert into premium_finance_agreements
         (arrangement_id, finance_provider, agreement_reference,
          down_payment_cents, principal_financed_cents, finance_charge_cents,
          installment_count, installment_cents, first_payment_date, recorded_by_user_id)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [arr.id, String(finance.finance_provider).trim(), finance.agreement_reference || null,
       requireCents("down_payment_cents", finance.down_payment_cents ?? null),
       requireCents("principal_financed_cents", finance.principal_financed_cents ?? null,
                    { positive: true }),
       requireCents("finance_charge_cents", finance.finance_charge_cents ?? null),
       finance.installment_count ?? null,
       requireCents("installment_cents", finance.installment_cents ?? null, { positive: true }),
       finance.first_payment_date || null, user_id]);
  }
  if (method === "lender_escrow" && escrow) {
    await client.query(
      `insert into insurance_escrow_arrangements
         (arrangement_id, lender_name, servicer_name, escrow_account_reference,
          recorded_by_user_id)
       values ($1,$2,$3,$4,$5)`,
      [arr.id, escrow.lender_name || null, escrow.servicer_name || null,
       escrow.escrow_account_reference || null, user_id]);
  }
  return arr;
}

module.exports = { FUNDING_METHODS, openArrangement, correctArrangement, fundingError };
