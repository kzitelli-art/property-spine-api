/* ════════════════════════════════════════════════════════════════════
   tax_funding_service.js — THE canonical writer for HOW a tax is paid
   for. It never touches WHAT is owed, WHETHER it was filed, or WHETHER
   the City was paid.

   ── IT LIVES ON THE FUNDING SIDE OF AN EXECUTABLE WALL ──────────────
   `tests/gates/gate_funding_boundary.js` asserts, structurally:

       the tax economic chain may never import this file, transitively
       this file may REFERENCE the obligation it funds — reads, FKs
       this file may never INSERT/UPDATE/DELETE an economic tax table,
       and `tax_payments` is one of them

   That last clause is the whole domain in one line. An escrow may pay a
   bill; only City payment evidence may say the bill is paid, and only
   `tax_obligation_service.recordPayment` writes that. No function here
   can reach it.

   ── THE TWO SENTENCES THIS FILE MAKES UNWRITEABLE ───────────────────
       "the escrow is healthy, so the taxes are paid"
       "the escrow contribution went up, so the tax went up"

   Both are cash mistaken for economics. The monthly contribution is what
   the property sends a servicer; the accrual is the governed annual
   liability over the obligation's own period, computed in
   `tax_position_read.js`, which imports nothing and cannot see this
   module by any path.

   ── ABSENCE IS UNKNOWN, NOT `direct` ────────────────────────────────
   No arrangement means Spine does not know how this tax is paid.
   `direct` is a POSITIVE finding somebody established. Defaulting to it
   would invent a settled answer from missing information (§5) — and it
   is the more dangerous default, because a property everyone assumed was
   paying its own Real Estate Tax is how a bill goes unpaid for a year.

   ── A SLICE AND A CORRECTION ARE DIFFERENT VERBS ────────────────────
       openArrangement     the WORLD changed — the loan was refinanced,
                           the servicer changed, escrow was waived. Moves
                           only the future; last year's answer stays true.
       correctArrangement  the CLAIM was wrong. The predecessor is
                           preserved and stays readable.

   CLASS 1 — permanent product primitive.
   ════════════════════════════════════════════════════════════════════ */
"use strict";

//  The jurisdiction's own rules, not a second copy of them. Funding may
//  reference the economic side; the reverse is the defect. One statement
//  of "which subject owes which tax" serves both (§17).
const rules = require("./philadelphia_tax_rules.js");

const FUNDING_METHODS = Object.freeze(["direct", "lender_escrow"]);

function fundingError(code, message, extra = {}) {
  const e = new Error(message); e.code = code; Object.assign(e, extra); return e;
}

function requireCents(name, v, { positive = false, required = false } = {}) {
  if (v === null || v === undefined) {
    if (required) throw fundingError("BAD_INPUT", `${name} is required`);
    return null;
  }
  if (!Number.isInteger(v) || v < 0 || (positive && v <= 0)) {
    throw fundingError("BAD_INPUT",
      `${name} must be a ${positive ? "positive" : "non-negative"} integer of cents`);
  }
  return v;
}

function requireProvenance(artifact, note, what) {
  if (!artifact && !(note && String(note).trim())) {
    throw fundingError("PROVENANCE_REQUIRED",
      `${what} requires provenance: a document, or a note recording where this came from.`);
  }
}

function isoDay(d) {
  if (!d) return null;
  if (typeof d === "string") return d.slice(0, 10);
  if (!(d instanceof Date)) return null;
  //  Built from LOCAL components. `toISOString()` shifts a DATE column
  //  backwards a day west of UTC, which is how a March 31 due date starts
  //  reading as March 30 in the browser.
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/*  The subject shape is decided by the tax type, exactly as it is on the
 *  economic side — one rule, one place. The refusal is SAYABLE so nobody
 *  meets a check-constraint violation while holding an escrow statement. */
function resolveSubject(tax_type, { property_id, legal_entity_id }) {
  const kind = rules.SUBJECT_KIND[tax_type];
  if (!kind) throw fundingError("BAD_INPUT", `unknown tax type ${JSON.stringify(tax_type)}`);
  if (kind === "property") {
    if (!property_id) {
      throw fundingError("SUBJECT_REQUIRED",
        `${rules.TAX_LABEL[tax_type]} is owed by the property, so its funding is recorded ` +
        "against a property.");
    }
    if (legal_entity_id) {
      throw fundingError("WRONG_SUBJECT",
        `${rules.TAX_LABEL[tax_type]} is owed by the property, not by a legal entity.`);
    }
    return { property_id, legal_entity_id: null };
  }
  if (!legal_entity_id) {
    throw fundingError("SUBJECT_REQUIRED",
      `${rules.TAX_LABEL[tax_type]} is owed by the taxpayer — a legal entity — so its ` +
      "funding is recorded against that entity.");
  }
  if (property_id) {
    throw fundingError("WRONG_SUBJECT",
      `${rules.TAX_LABEL[tax_type]} is owed by a legal entity, not by the property.`);
  }
  return { property_id: null, legal_entity_id };
}

/*  Which mechanism's detail may accompany which method. A directly-paid
 *  tax with a servicer and a monthly contribution is not directly paid,
 *  and accepting the contradiction leaves a row nobody can read honestly.
 */
function validateShape({ funding_method, escrow }) {
  if (!FUNDING_METHODS.includes(funding_method)) {
    throw fundingError("BAD_INPUT",
      `funding_method must be one of ${FUNDING_METHODS.join(", ")}`);
  }
  if (funding_method === "direct" && escrow) {
    throw fundingError("DIRECT_HAS_NO_ESCROW",
      "a directly-paid tax has no escrow account. If a lender or servicer holds funds " +
      "for it, the funding method is not direct.");
  }
  if (funding_method === "lender_escrow") {
    const who = escrow && (escrow.lender_name || escrow.servicer_name);
    if (!(who && String(who).trim())) {
      throw fundingError("ESCROW_HOLDER_REQUIRED",
        "an escrowed tax needs the lender or servicer holding the money. Who to ask when " +
        "the bill is not paid is the first thing this arrangement has to be able to say.");
    }
    requireCents("monthly_contribution_cents", escrow.monthly_contribution_cents ?? null);
  }
}

async function insertEscrowDetail(client, arrangement_id, escrow, user_id) {
  await client.query(
    `insert into tax_escrow_arrangements
       (arrangement_id, lender_name, servicer_name, escrow_account_reference,
        monthly_contribution_cents, recorded_by_user_id)
     values ($1,$2,$3,$4,$5,$6)`,
    [arrangement_id, escrow.lender_name || null, escrow.servicer_name || null,
     escrow.escrow_account_reference || null,
     escrow.monthly_contribution_cents ?? null, user_id]);
}

/*  ── OPEN A NEW FUNDING SLICE ───────────────────────────────────────
 *  The prior live slice for this (subject, tax_type) is closed at
 *  effective_from. Its facts are never touched — that is what keeps
 *  "who was supposed to pay the 2024 bill" answerable after a 2026
 *  refinance moved the escrow to a different servicer.
 */
async function openArrangement(client, spec = {}) {
  const {
    tax_type, property_id = null, legal_entity_id = null,
    funding_method, effective_from, effective_to = null,
    source_artifact_id = null, provenance_note = null,
    escrow = null, user_id,
  } = spec;

  if (!rules.TAX_TYPES.includes(tax_type)) {
    throw fundingError("BAD_INPUT", `tax_type must be one of ${rules.TAX_TYPES.join(", ")}`);
  }
  if (!effective_from) throw fundingError("BAD_INPUT", "effective_from is required");
  if (!user_id) throw fundingError("BAD_INPUT", "user_id is required");
  requireProvenance(source_artifact_id, provenance_note, "a tax funding arrangement");
  validateShape({ funding_method, escrow });

  const subject = resolveSubject(tax_type, { property_id, legal_entity_id });
  const subjectKey = String(subject.property_id || subject.legal_entity_id);

  //  ⚠ A SAME-DAY RESTATEMENT IS A CORRECTION, NOT A NEW SLICE.
  //  A slice cannot be closed at its own start date, so without this the
  //  prior arrangement stays live beside the new one and one screen says
  //  both "paid directly" and "paid from escrow". The applicability chain
  //  shipped without this guard and a proof caught exactly that.
  const live = (await client.query(
    `select id, effective_from, funding_method from tax_funding_arrangements
      where tax_type = $1
        and coalesce(subject_property_id::text, subject_legal_entity_id::text) = $2
        and effective_to is null and supersedes_id is null
      limit 1`, [tax_type, subjectKey])).rows[0];
  if (live) {
    const from = isoDay(live.effective_from);
    if (from >= String(effective_from)) {
      throw fundingError("CORRECTION_REQUIRED",
        `${rules.TAX_LABEL[tax_type]} funding is already recorded as ` +
        `"${live.funding_method === "direct" ? "paid directly" : "paid from lender escrow"}" ` +
        `from ${from}. Restating it for the same date is a CORRECTION — say why the earlier ` +
        "record was wrong, or date the new one from when the arrangement actually changed.");
    }
  }

  await client.query(
    `update tax_funding_arrangements
        set effective_to = $3
      where tax_type = $1
        and coalesce(subject_property_id::text, subject_legal_entity_id::text) = $2
        and effective_to is null and effective_from < $3
        and not exists (select 1 from tax_funding_arrangements s
                         where s.supersedes_id = tax_funding_arrangements.id)`,
    [tax_type, subjectKey, effective_from]);

  const arr = (await client.query(
    `insert into tax_funding_arrangements
       (jurisdiction, tax_type, subject_property_id, subject_legal_entity_id,
        funding_method, effective_from, effective_to,
        source_artifact_id, provenance_note, recorded_by_user_id)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning *`,
    [rules.JURISDICTION, tax_type, subject.property_id, subject.legal_entity_id,
     funding_method, effective_from, effective_to,
     source_artifact_id, provenance_note, user_id])).rows[0];

  if (funding_method === "lender_escrow") {
    await insertEscrowDetail(client, arr.id, escrow, user_id);
  }
  return arr;
}

/*  ── CORRECT AN ARRANGEMENT ─────────────────────────────────────────
 *  The same claim, restated. The predecessor is preserved and remains
 *  readable, and the reason is required by the database.
 *
 *  ⚠ THIS IS NOT HOW AN ESCROW ANALYSIS IS RECORDED. A servicer raising
 *  the monthly contribution is the WORLD changing — openArrangement, from
 *  the date the new contribution starts. Correcting instead would erase
 *  the fact that the old contribution was ever right, and the property
 *  would lose the ability to explain last year's cash.
 */
async function correctArrangement(client, {
  arrangement_id, funding_method = null, revision_reason,
  source_artifact_id = null, provenance_note = null,
  escrow = null, user_id,
} = {}) {
  if (!arrangement_id) throw fundingError("BAD_INPUT", "arrangement_id is required");
  if (!(revision_reason && String(revision_reason).trim())) {
    throw fundingError("REASON_REQUIRED",
      "a correction requires a reason. Without one the record cannot explain why the " +
      "earlier arrangement changed — a wrong servicer name and a refinance are very " +
      "different stories.");
  }
  if (!user_id) throw fundingError("BAD_INPUT", "user_id is required");

  const prior = (await client.query(
    `select * from tax_funding_arrangements where id = $1 for update`,
    [arrangement_id])).rows[0];
  if (!prior) throw fundingError("NOT_FOUND", "tax funding arrangement not found");

  const method = funding_method || prior.funding_method;
  //  A correction to an escrowed arrangement that does not restate the
  //  escrow detail carries the prior detail forward, so "fix the lender's
  //  name" does not silently drop the contribution.
  let detail = escrow;
  if (method === "lender_escrow" && !detail) {
    detail = (await client.query(
      `select lender_name, servicer_name, escrow_account_reference,
              monthly_contribution_cents
         from tax_escrow_arrangements where arrangement_id = $1`, [prior.id])).rows[0] || null;
    if (detail && detail.monthly_contribution_cents !== null) {
      detail.monthly_contribution_cents = Number(detail.monthly_contribution_cents);
    }
  }
  validateShape({ funding_method: method, escrow: detail });

  const arr = (await client.query(
    `insert into tax_funding_arrangements
       (jurisdiction, tax_type, subject_property_id, subject_legal_entity_id,
        funding_method, effective_from, effective_to,
        source_artifact_id, provenance_note, supersedes_id, revision_reason,
        recorded_by_user_id)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning *`,
    [prior.jurisdiction, prior.tax_type, prior.subject_property_id,
     prior.subject_legal_entity_id, method,
     //  A correction governs the SAME period the mistaken claim governed.
     prior.effective_from, prior.effective_to,
     source_artifact_id || prior.source_artifact_id,
     provenance_note || prior.provenance_note,
     prior.id, String(revision_reason).trim(), user_id])).rows[0];

  if (method === "lender_escrow" && detail) {
    await insertEscrowDetail(client, arr.id, detail, user_id);
  }
  return arr;
}

/*  Resolve the live arrangement for a subject and type, or refuse in a
 *  way that names the next step. Observations and disbursements are facts
 *  ABOUT an escrow, so there has to be one. */
async function liveEscrowArrangement(client, arrangement_id) {
  const arr = (await client.query(
    `select * from tax_funding_arrangements where id = $1`, [arrangement_id])).rows[0];
  if (!arr) throw fundingError("NOT_FOUND", "tax funding arrangement not found");
  if (arr.funding_method !== "lender_escrow") {
    throw fundingError("NOT_AN_ESCROW",
      "this tax is recorded as paid directly, so there is no escrow account to record " +
      "against. If a lender or servicer holds funds for it, record that arrangement first.");
  }
  return arr;
}

/*  ── WHAT A STATEMENT SAID, ON A DAY ────────────────────────────────
 *  An observation, not a term. It goes stale, and the read says how old
 *  it is rather than presenting it as current.
 *
 *  ⚠ RECORDING A BALANCE PROVES NOTHING ABOUT A BILL. Not that it will
 *  be paid, not that it was. It records what the servicer says they hold.
 */
async function recordEscrowObservation(client, {
  arrangement_id, observed_on, balance_cents, currency_code = "USD",
  source_artifact_id = null, provenance_note = null, user_id,
} = {}) {
  if (!observed_on) throw fundingError("BAD_INPUT", "observed_on is required");
  if (!user_id) throw fundingError("BAD_INPUT", "user_id is required");
  requireCents("balance_cents", balance_cents, { required: true });
  requireProvenance(source_artifact_id, provenance_note, "an escrow balance");

  await liveEscrowArrangement(client, arrangement_id);

  try {
    const { rows } = await client.query(
      `insert into tax_escrow_observations
         (arrangement_id, observed_on, balance_cents, currency_code,
          source_artifact_id, provenance_note, recorded_by_user_id)
       values ($1,$2,$3,$4,$5,$6,$7) returning *`,
      [arrangement_id, observed_on, balance_cents, currency_code,
       source_artifact_id, provenance_note, user_id]);
    return rows[0];
  } catch (e) {
    if (/uq_tax_escrow_obs_day/.test(e.message)) {
      throw fundingError("ALREADY_OBSERVED",
        `A balance is already recorded for this escrow on ${observed_on}. Two statements ` +
        "disagreeing about the same day is a correction to make, not a second fact to hold.");
    }
    throw e;
  }
}

/*  ── THE ESCROW SAYS IT SENT MONEY ──────────────────────────────────
 *  A funding event pointed at the bill it funds. The obligation
 *  reference is permitted and is the point of the record.
 *
 *  ⚠ IT DOES NOT PAY THE BILL. Nothing here writes `tax_payments`, and
 *  the position read will keep saying the obligation is unpaid until
 *  there is City payment evidence — with this disbursement shown beside
 *  it as the reason somebody believed otherwise.
 */
async function recordDisbursement(client, {
  arrangement_id, obligation_id, disbursed_on, amount_cents,
  currency_code = "USD", reference = null,
  source_artifact_id = null, provenance_note = null, user_id,
} = {}) {
  if (!obligation_id) throw fundingError("BAD_INPUT", "obligation_id is required");
  if (!disbursed_on) throw fundingError("BAD_INPUT", "disbursed_on is required");
  if (!user_id) throw fundingError("BAD_INPUT", "user_id is required");
  requireCents("amount_cents", amount_cents, { positive: true, required: true });
  requireProvenance(source_artifact_id, provenance_note, "an escrow disbursement");

  const arr = await liveEscrowArrangement(client, arrangement_id);

  //  ── THE DISBURSEMENT MUST BE POINTED AT THE RIGHT BILL ───────────
  //  A READ of the economic side, which the boundary permits. Without it
  //  a Real Estate Tax escrow could be recorded as disbursing toward a
  //  BIRT obligation, and the reconciliation the read performs would be
  //  comparing two unrelated numbers.
  const obl = (await client.query(
    `select id, tax_type, liable_property_id, liable_legal_entity_id
       from tax_obligations where id = $1`, [obligation_id])).rows[0];
  if (!obl) throw fundingError("NOT_FOUND", "tax obligation not found");
  if (obl.tax_type !== arr.tax_type) {
    throw fundingError("OBLIGATION_MISMATCH",
      `This escrow funds ${rules.TAX_LABEL[arr.tax_type]}, but that bill is ` +
      `${rules.TAX_LABEL[obl.tax_type]}. Record the disbursement against the escrow that ` +
      "actually pays it.");
  }
  const oblSubject = String(obl.liable_property_id || obl.liable_legal_entity_id);
  const arrSubject = String(arr.subject_property_id || arr.subject_legal_entity_id);
  if (oblSubject !== arrSubject) {
    throw fundingError("OBLIGATION_MISMATCH",
      "That bill belongs to a different subject than this escrow arrangement.");
  }

  const { rows } = await client.query(
    `insert into tax_escrow_disbursements
       (arrangement_id, obligation_id, disbursed_on, amount_cents, currency_code,
        reference, source_artifact_id, provenance_note, recorded_by_user_id)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning *`,
    [arrangement_id, obligation_id, disbursed_on, amount_cents, currency_code,
     reference, source_artifact_id, provenance_note, user_id]);
  return rows[0];
}

module.exports = {
  FUNDING_METHODS,
  openArrangement, correctArrangement,
  recordEscrowObservation, recordDisbursement,
  fundingError, isoDay,
};
