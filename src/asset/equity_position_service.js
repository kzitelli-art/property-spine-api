/* ════════════════════════════════════════════════════════════════════
   equity_position_service.js — THE CANONICAL EQUITY & PREFERRED EQUITY
   WRITERS. Rebuilt around migration 174's Round-4 shape: one shared
   capital_stack_positions identity, with Common and Preferred
   economics written to separate tables underneath it.

   Deliberately boring, same discipline as debt_instrument_service.js:

       validate · attribute to a source · append · effective-date

   WHAT THEY DO NOT DO, ON PURPOSE:
     · they do not calculate position — that is equity_position_read.js
     · they do not reconcile a conflict (E6/E7) — recording one is a
       writer's job; deciding which claim is correct is a human's
     · they do not compute an accrued preferred balance, ever — nothing
       accrues in any surveyed GL, and this repo does not manufacture
       what the real world has not recorded (E3)
     · they do not decide whether an override is settled — they record
       execution_status exactly as stated; equity_position_read.js is
       the only place that decides whether to APPLY one
     · they do not touch Debt truth — a member loan, however entangled
       with equity holders, is written in Debt's tables, never here (E5)

   WRITER WRITES TRUTH. READER DERIVES TRUTH.

   See docs/EQUITY_READ_CONTRACT_AND_SCHEMA.md for the walls (E1–E10)
   and the Round-4 structural rulings these writers now hold.

   CLASS 1 — permanent product primitive. NOT YET RELEASED — no route
   calls these writers; see migration 174's own header.
   ════════════════════════════════════════════════════════════════════ */
"use strict";

function required(v, name) {
  if (v === undefined || v === null || v === "") {
    const e = new Error(`equity writer: ${name} is required and was not supplied`);
    e.code = "EQUITY_MISSING_FIELD";
    throw e;
  }
  return v;
}

//  Attribution is not optional — same reasoning as Debt's actor().
function actor(opts) {
  return required(opts && opts.recorded_by_user_id, "recorded_by_user_id");
}

//  ── THE SHARED IDENTITY (Round-4 Ruling 1) ───────────────────────────
//  One row per holder-at-an-issuer, whether that holder is common or
//  preferred, and whether the "tier" it represents is the property's
//  first entity or one several levels up. There is no separate
//  entities table: a tier is just another position row whose HOLDER
//  becomes the next row's ISSUER. tier_order does not exist — the
//  chain is data, never a display column standing in for it.
//
//  ⚠ E1/E7 — a position row is superseded ONLY by another position row
//  citing an actual transfer/assignment instrument. A K-1 or tracker
//  naming a different holder with no assignment on file is NOT written
//  as a supersession here — record it with recordConflict() instead.
async function addPosition(db, opts) {
  const o = opts || {};
  required(o.property_id, "property_id");
  required(o.issuer_legal_entity_id, "issuer_legal_entity_id");
  required(o.position_class, "position_class");
  required(o.effective_from, "effective_from");
  const hasEntity = !!o.holder_legal_entity_id;
  const hasName = !!(o.holder_name_text && o.holder_name_text.trim());
  if (hasEntity === hasName) {
    const e = new Error(
      "equity writer: a position's holder is a legal entity XOR an attributed name — " +
      "reading an operating agreement or a K-1 filename must never mint a durable person");
    e.code = "EQUITY_POSITION_SUBJECT";
    throw e;
  }
  const r = await db.query(
    `insert into capital_stack_positions
       (property_id, issuer_legal_entity_id, position_class,
        holder_legal_entity_id, holder_name_text,
        effective_from, effective_to, supersedes_position_id,
        source_artifact_id, provenance_note, recorded_by_user_id)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning *`,
    [o.property_id, o.issuer_legal_entity_id, o.position_class,
     o.holder_legal_entity_id || null,
     hasName ? o.holder_name_text.trim() : null,
     o.effective_from, o.effective_to || null, o.supersedes_position_id || null,
     o.source_artifact_id || null, o.provenance_note || null, actor(o)]);
  return r.rows[0];
}

//  ⚠ Round-4 Ruling 2 — ISSUER-SCOPED, NEVER POSITION-SCOPED. "The
//  entity/waterfall level" names two facts in one breath: a pro-rata
//  preferred return shared by every common holder of one issuer
//  (Skyline's 7.5%, Greenery's 7%) AND that issuer's default waterfall
//  priority. Both are recorded ONCE here, never copied onto each
//  holder's own position row.
async function addCommonClassTerms(db, opts) {
  const o = opts || {};
  required(o.property_id, "property_id");
  required(o.issuer_legal_entity_id, "issuer_legal_entity_id");
  required(o.term_source, "term_source");
  required(o.source_authority, "source_authority");
  required(o.effective_from, "effective_from");
  const r = await db.query(
    `insert into common_equity_class_terms
       (property_id, issuer_legal_entity_id, term_source, source_authority,
        rate_bp, rate_convention_as_stated, compounding, waterfall_priority_text,
        effective_from, effective_to, source_artifact_id, provenance_note,
        recorded_by_user_id)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) returning *`,
    [o.property_id, o.issuer_legal_entity_id, o.term_source, o.source_authority,
     o.rate_bp == null ? null : o.rate_bp,
     o.rate_convention_as_stated || null, o.compounding || null,
     o.waterfall_priority_text || null,
     o.effective_from, o.effective_to || null,
     o.source_artifact_id || null, o.provenance_note || null, actor(o)]);
  return r.rows[0];
}

//  ⚠ Round-4 Ruling 3 — POSITION-SCOPED, THE OPPOSITE OF ABOVE. A side
//  letter overrides ONE holder's terms, never the deal's or the
//  class's. execution_status is recorded EXACTLY as the source states
//  it — this writer never infers 'executed' from the mere existence of
//  a side-letter document. The reader, never this writer, decides
//  whether an override is applied to the current economic read.
async function addPositionOverride(db, opts) {
  const o = opts || {};
  required(o.position_id, "position_id");
  required(o.override_kind, "override_kind");
  required(o.override_text, "override_text");
  required(o.execution_status, "execution_status");
  required(o.source_authority, "source_authority");
  required(o.effective_from, "effective_from");
  if (o.execution_status === "executed" && !o.execution_date) {
    const e = new Error(
      "equity writer: an override recorded as executed must carry its execution_date");
    e.code = "EQUITY_OVERRIDE_EXECUTION_DATE";
    throw e;
  }
  if (o.execution_status !== "executed" && o.execution_date) {
    const e = new Error(
      "equity writer: an override that is not executed must not carry an execution_date");
    e.code = "EQUITY_OVERRIDE_EXECUTION_DATE";
    throw e;
  }
  const r = await db.query(
    `insert into common_equity_position_overrides
       (position_id, override_kind, override_text, execution_status, execution_date,
        term_source, source_authority, effective_from, effective_to,
        source_artifact_id, provenance_note, recorded_by_user_id)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning *`,
    [o.position_id, o.override_kind, o.override_text, o.execution_status,
     o.execution_date || null, o.term_source || "side_letter", o.source_authority,
     o.effective_from, o.effective_to || null,
     o.source_artifact_id || null, o.provenance_note || null, actor(o)]);
  return r.rows[0];
}

//  ⚠ ONLY valid against a position_class = 'preferred' position — this
//  writer trusts the caller to have picked the right position the same
//  way debt_instrument_service.js trusts an instrument id; the check
//  constraint on capital_stack_positions.position_class is the wall
//  behind it, not a query here.
//
//  ⚠ Round-4 Ruling 4 — current_pay_rate_bp and accrued_rate_bp are
//  separate arguments, never merged, because Tower Place proves a
//  preferred position can carry a genuinely stepped paid/accrued
//  structure. Neither this writer nor any fixture built from it writes
//  Tower's own specific numbers — the columns exist for the SHAPE.
//
//  ⚠ THE MSC DEFERRAL. minimum_dividend_relationship_to_preferred_
//  return defaults to 'not_established' in the schema itself. A caller
//  may only pass 'additive' | 'offset' | 'other' once the actual
//  governing clause (MSC's OA §1.49) has been read — never from a
//  survey paraphrase, however specific the paraphrase reads.
async function addPreferredTerms(db, opts) {
  const o = opts || {};
  required(o.position_id, "position_id");
  required(o.term_source, "term_source");
  required(o.source_authority, "source_authority");
  required(o.effective_from, "effective_from");
  const r = await db.query(
    `insert into preferred_equity_terms
       (position_id, term_source, source_authority,
        current_pay_rate_bp, accrued_rate_bp, rate_convention_as_stated,
        compounding, step_schedule_text,
        minimum_dividend_schedule_text, minimum_dividend_relationship_to_preferred_return,
        waterfall_priority_text, redemption_terms_text, make_whole_text,
        control_rights_text, redemption_or_maturity_date,
        effective_from, effective_to, source_artifact_id, provenance_note,
        recorded_by_user_id)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
     returning *`,
    [o.position_id, o.term_source, o.source_authority,
     o.current_pay_rate_bp == null ? null : o.current_pay_rate_bp,
     o.accrued_rate_bp == null ? null : o.accrued_rate_bp,
     o.rate_convention_as_stated || null, o.compounding || null,
     o.step_schedule_text || null,
     o.minimum_dividend_schedule_text || null,
     o.minimum_dividend_relationship_to_preferred_return || "not_established",
     o.waterfall_priority_text || null, o.redemption_terms_text || null,
     o.make_whole_text || null, o.control_rights_text || null,
     o.redemption_or_maturity_date || null,
     o.effective_from, o.effective_to || null,
     o.source_artifact_id || null, o.provenance_note || null, actor(o)]);
  return r.rows[0];
}

//  ⚠ E9 — a dated fact, never a column on capital_stack_positions.
//  Absence of a pledge row means NOT_ESTABLISHED, not "confirmed
//  unencumbered".
async function addPledge(db, opts) {
  const o = opts || {};
  required(o.position_id, "position_id");
  required(o.pledgee_name_text, "pledgee_name_text");
  required(o.effective_from, "effective_from");
  const r = await db.query(
    `insert into capital_stack_pledges
       (position_id, pledgee_name_text, pledge_description,
        effective_from, effective_to, source_artifact_id, provenance_note,
        recorded_by_user_id)
     values ($1,$2,$3,$4,$5,$6,$7,$8) returning *`,
    [o.position_id, o.pledgee_name_text, o.pledge_description || null,
     o.effective_from, o.effective_to || null,
     o.source_artifact_id || null, o.provenance_note || null, actor(o)]);
  return r.rows[0];
}

//  ⚠ E4 + the Vernicek fix. ONE ROW PER SOURCE'S CLAIM of EITHER an
//  amount OR an ownership percentage — never both in one row, because
//  they are kept as separate economic facts even when the same source
//  states both (the caller writes two rows). claim_source
//  'internal_note' plus asserted_by_text exists so a spoken/internal
//  estimate carries who said it, not just that it was said.
async function addCapitalAmountClaim(db, opts) {
  const o = opts || {};
  required(o.position_id, "position_id");
  required(o.claim_source, "claim_source");
  required(o.as_of_date, "as_of_date");
  const hasAmount = o.amount_cents != null;
  const hasPercent = o.ownership_percent != null;
  if (hasAmount === hasPercent) {
    const e = new Error(
      "equity writer: a capital amount claim states EXACTLY ONE of amount_cents or " +
      "ownership_percent — they are separate economic facts, never merged into one row");
    e.code = "EQUITY_CLAIM_EXACTLY_ONE_VALUE";
    throw e;
  }
  const r = await db.query(
    `insert into capital_amount_claims
       (position_id, claim_source, asserted_by_text, amount_cents, ownership_percent,
        as_of_date, source_artifact_id, provenance_note, recorded_by_user_id)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning *`,
    [o.position_id, o.claim_source, o.asserted_by_text || null,
     hasAmount ? o.amount_cents : null, hasPercent ? o.ownership_percent : null,
     o.as_of_date, o.source_artifact_id || null, o.provenance_note || null, actor(o)]);
  return r.rows[0];
}

//  ⚠ E6/E7 — two recorded claims about the same fact, disagreeing, both
//  retained. Recording a conflict is not resolving it: a human decides
//  which claim governs, and that decision is out of scope for a writer.
async function recordConflict(db, opts) {
  const o = opts || {};
  required(o.property_id, "property_id");
  required(o.conflict_kind, "conflict_kind");
  required(o.claim_a_text, "claim_a_text");
  required(o.claim_b_text, "claim_b_text");
  required(o.noted_as_of, "noted_as_of");
  const r = await db.query(
    `insert into capital_stack_conflicts
       (property_id, position_id, conflict_kind,
        claim_a_text, claim_a_source_artifact_id,
        claim_b_text, claim_b_source_artifact_id,
        noted_as_of, provenance_note, recorded_by_user_id)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning *`,
    [o.property_id, o.position_id || null, o.conflict_kind,
     o.claim_a_text, o.claim_a_source_artifact_id || null,
     o.claim_b_text, o.claim_b_source_artifact_id || null,
     o.noted_as_of, o.provenance_note || null, actor(o)]);
  return r.rows[0];
}

/*  Which capital-stack positions does this PROPERTY have?
 *
 *  Route authority is a property; position() reads every position tied
 *  to it. This is the join and it is the whole of it — a query, not a
 *  derivation, exactly like Debt's listInstrumentsForProperty(). */
async function listPositionsForProperty(db, propertyId, asOf) {
  const at = asOf || new Date().toISOString().slice(0, 10);
  const r = await db.query(
    `select id from capital_stack_positions
      where property_id = $1
        and effective_from <= $2
        and (effective_to is null or effective_to >= $2)
      order by effective_from`,
    [propertyId, at]);
  return r.rows.map((row) => row.id);
}

//  Fetches the governed history for one property. Composes NOTHING —
//  hands rows to equity_position_read.position(), which is pure.
async function loadHistory(db, propertyId) {
  const positions = await db.query(
    `select * from capital_stack_positions where property_id = $1 order by effective_from`,
    [propertyId]);
  const positionIds = positions.rows.map((r) => r.id);

  const q = async (table, col, ids, order) => (ids.length
    ? (await db.query(
        `select * from ${table} where ${col} = any($1::uuid[]) order by ${order}`,
        [ids])).rows
    : []);

  return {
    positions: positions.rows,
    //  ⚠ SCOPED BY PROPERTY, NOT BY AN ISSUER SEEN IN positions. An
    //  issuer whose common tier carries governed class terms but ZERO
    //  named holders — Holdings LLC's own common membership, in the
    //  4125 specimen — would never appear in positions.issuer_legal_
    //  entity_id at all, and filtering this query to "issuers already
    //  seen in a position" would silently drop exactly the row
    //  coverageGaps() needs to detect that tier as unnamed.
    common_class_terms: (await db.query(
      `select * from common_equity_class_terms where property_id = $1 order by effective_from`,
      [propertyId])).rows,
    position_overrides: await q("common_equity_position_overrides", "position_id", positionIds, "effective_from"),
    preferred_terms: await q("preferred_equity_terms", "position_id", positionIds, "effective_from"),
    pledges: await q("capital_stack_pledges", "position_id", positionIds, "effective_from"),
    amount_claims: await q("capital_amount_claims", "position_id", positionIds, "as_of_date"),
    conflicts: (await db.query(
      `select * from capital_stack_conflicts where property_id = $1 order by noted_as_of`, [propertyId])).rows,
  };
}

/*  ── ROOM-LEVEL ESTABLISHMENT, FOR THE CAPITAL STACK HOME CARD ────────
 *  Cheap by construction: one grouped COUNT, never position(). Same
 *  discipline as Debt's establishmentForProperty() — a presence check,
 *  not a detail read.
 *
 *  ⚠ "Established" here means only "this property has at least one
 *  governed capital-stack position recorded" — never "the cap table is
 *  complete", which for every surveyed deal it is not.
 *
 *  ⚠ preferred_count / common_count exist so the Capital Stack room can
 *  show Preferred Equity and Common Equity as two DISTINCT compartments
 *  (product taxonomy, navigation only — see CLAUDE.md's Capital Stack
 *  room) without a second backend domain. Both compartments still read
 *  the same GET /operator/equity/standing and filter position_class in
 *  the UI; this probe only tells the room card which side, if either,
 *  has anything to show. Still one grouped COUNT — never position().  */
async function establishmentForProperty(db, propertyId, asOf) {
  const at = asOf || new Date().toISOString().slice(0, 10);
  const r = await db.query(
    `select position_class, count(*)::int as n from capital_stack_positions
      where property_id = $1
        and effective_from <= $2
        and (effective_to is null or effective_to >= $2)
      group by position_class`,
    [propertyId, at]);
  const byClass = { common: 0, preferred: 0 };
  for (const row of r.rows) byClass[row.position_class] = row.n;
  const total = byClass.common + byClass.preferred;
  return {
    established: total > 0,
    position_count: total,
    preferred_count: byClass.preferred,
    common_count: byClass.common,
    note: total > 0
      ? `${total} governed capital-stack ${total === 1 ? "position" : "positions"}`
      : "No governed equity or preferred terms yet",
  };
}

module.exports = {
  addPosition, addCommonClassTerms, addPositionOverride, addPreferredTerms,
  addPledge, addCapitalAmountClaim, recordConflict,
  listPositionsForProperty, loadHistory, establishmentForProperty,
};
