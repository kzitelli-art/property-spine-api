/* ════════════════════════════════════════════════════════════════════
   equity_position_service.js — THE CANONICAL EQUITY & PREFERRED EQUITY
   WRITERS.

   Deliberately boring, same discipline as debt_instrument_service.js:

       validate · attribute to a source · append · effective-date

   WHAT THEY DO NOT DO, ON PURPOSE:
     · they do not calculate position — that is equity_position_read.js
     · they do not reconcile a conflict (E6/E7) — recording one is a
       writer's job; deciding which claim is correct is a human's
     · they do not compute an accrued preferred balance, ever — nothing
       accrues in any surveyed GL, and this repo does not manufacture
       what the real world has not recorded (E3)
     · they do not touch Debt truth — a member loan, however entangled
       with equity holders, is written in Debt's tables, never here (E5)

   WRITER WRITES TRUTH. READER DERIVES TRUTH.

   See docs/EQUITY_READ_CONTRACT_AND_SCHEMA.md for the walls (E1–E10)
   each of these functions exists to hold, and EQUITY_SURVEY.md for the
   real evidence that forced every one of them.

   CLASS 1 — permanent product primitive.
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

//  One row per TIER in a property's ownership chain. The tier itself is
//  always a named entity in every surveyed deal — no attributed-name
//  escape hatch, unlike positions below.
async function establishCapitalEntity(db, opts) {
  const o = opts || {};
  required(o.property_id, "property_id");
  required(o.entity_kind, "entity_kind");
  required(o.legal_entity_id, "legal_entity_id");
  required(o.effective_from, "effective_from");
  const r = await db.query(
    `insert into equity_capital_entities
       (property_id, entity_kind, legal_entity_id, tier_order,
        effective_from, effective_to, source_artifact_id, provenance_note,
        recorded_by_user_id)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning *`,
    [o.property_id, o.entity_kind, o.legal_entity_id,
     o.tier_order == null ? null : o.tier_order,
     o.effective_from, o.effective_to || null,
     o.source_artifact_id || null, o.provenance_note || null, actor(o)]);
  return r.rows[0];
}

//  ⚠ E1/E7 — a party row is superseded ONLY by another party row citing
//  an actual transfer/assignment instrument. A K-1 or tracker naming a
//  different holder with no assignment on file is NOT written as a
//  supersession here — record it with recordConflict() instead.
async function addPosition(db, opts) {
  const o = opts || {};
  required(o.capital_entity_id, "capital_entity_id");
  required(o.position_kind, "position_kind");
  required(o.effective_from, "effective_from");
  const hasEntity = !!o.legal_entity_id;
  const hasName = !!(o.party_name_text && o.party_name_text.trim());
  if (hasEntity === hasName) {
    const e = new Error(
      "equity writer: a position's holder is a legal entity XOR an attributed name — " +
      "reading an operating agreement or a K-1 filename must never mint a durable person");
    e.code = "EQUITY_POSITION_SUBJECT";
    throw e;
  }
  const r = await db.query(
    `insert into equity_positions
       (capital_entity_id, position_kind, legal_entity_id, party_name_text,
        effective_from, effective_to, supersedes_position_id,
        source_artifact_id, provenance_note, recorded_by_user_id)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning *`,
    [o.capital_entity_id, o.position_kind, o.legal_entity_id || null,
     hasName ? o.party_name_text.trim() : null,
     o.effective_from, o.effective_to || null, o.supersedes_position_id || null,
     o.source_artifact_id || null, o.provenance_note || null, actor(o)]);
  return r.rows[0];
}

//  ⚠ E9 — a dated fact, never a column on equity_positions. Absence of
//  a pledge row means NOT_ESTABLISHED, not "confirmed unencumbered".
async function addPledge(db, opts) {
  const o = opts || {};
  required(o.position_id, "position_id");
  required(o.pledgee_name_text, "pledgee_name_text");
  required(o.effective_from, "effective_from");
  const r = await db.query(
    `insert into equity_position_pledges
       (position_id, pledgee_name_text, pledge_description,
        effective_from, effective_to, source_artifact_id, provenance_note,
        recorded_by_user_id)
     values ($1,$2,$3,$4,$5,$6,$7,$8) returning *`,
    [o.position_id, o.pledgee_name_text, o.pledge_description || null,
     o.effective_from, o.effective_to || null,
     o.source_artifact_id || null, o.provenance_note || null, actor(o)]);
  return r.rows[0];
}

//  ⚠ E2/E8 — ONE ROW PER SOURCE'S STATEMENT of the terms, never an
//  update to a prior row when a second source disagrees. The OA saying
//  quarterly compounding and a tracker saying monthly are BOTH written,
//  distinguished by source_authority — this writer does not adjudicate
//  which one is right.
async function addPreferredTerms(db, opts) {
  const o = opts || {};
  required(o.position_id, "position_id");
  required(o.term_source, "term_source");
  required(o.source_authority, "source_authority");
  required(o.effective_from, "effective_from");
  const r = await db.query(
    `insert into equity_preferred_terms
       (position_id, term_source, rate_bp, rate_convention_as_stated, compounding,
        waterfall_priority_text, redemption_terms_text, make_whole_text,
        source_authority, effective_from, effective_to,
        source_artifact_id, provenance_note, recorded_by_user_id)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) returning *`,
    [o.position_id, o.term_source,
     o.rate_bp == null ? null : o.rate_bp,
     o.rate_convention_as_stated || null, o.compounding || null,
     o.waterfall_priority_text || null, o.redemption_terms_text || null,
     o.make_whole_text || null, o.source_authority,
     o.effective_from, o.effective_to || null,
     o.source_artifact_id || null, o.provenance_note || null, actor(o)]);
  return r.rows[0];
}

//  ⚠ E4 — ONE ROW PER SOURCE'S CLAIM of an amount contributed, never a
//  single contributed_amount column. This writer does not reconcile
//  Skyline's 43× GL/Exhibit-A gap or Greenery's $389,677 shortfall —
//  it records each source's number, dated and attributed.
async function addContributionClaim(db, opts) {
  const o = opts || {};
  required(o.position_id, "position_id");
  required(o.claim_source, "claim_source");
  required(o.amount_cents, "amount_cents");
  required(o.as_of_date, "as_of_date");
  const r = await db.query(
    `insert into equity_contribution_claims
       (position_id, claim_source, amount_cents, as_of_date,
        source_artifact_id, provenance_note, recorded_by_user_id)
     values ($1,$2,$3,$4,$5,$6,$7) returning *`,
    [o.position_id, o.claim_source, o.amount_cents, o.as_of_date,
     o.source_artifact_id || null, o.provenance_note || null, actor(o)]);
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
    `insert into equity_conflicts
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

//  ⚠ E10 — CLAUDE.md's Exposure contract. magnitude_cents is NULLABLE
//  on purpose: "if known", never zero. A writer supplying 0 here to
//  mean "unknown" would be exactly the confident-wrong this table
//  exists to refuse.
async function recordExposure(db, opts) {
  const o = opts || {};
  required(o.property_id, "property_id");
  required(o.what_text, "what_text");
  required(o.why_unresolved_text, "why_unresolved_text");
  required(o.as_of_date, "as_of_date");
  const r = await db.query(
    `insert into equity_exposure
       (property_id, capital_entity_id, what_text, magnitude_cents,
        magnitude_basis_text, why_unresolved_text, resolution_text,
        as_of_date, owner_user_id, source_artifact_id, provenance_note,
        recorded_by_user_id)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning *`,
    [o.property_id, o.capital_entity_id || null, o.what_text,
     o.magnitude_cents == null ? null : o.magnitude_cents,
     o.magnitude_basis_text || null, o.why_unresolved_text,
     o.resolution_text || null, o.as_of_date,
     //  Null reads as UNASSIGNED at the read layer, never as silently missing.
     o.owner_user_id || null,
     o.source_artifact_id || null, o.provenance_note || null, actor(o)]);
  return r.rows[0];
}

/*  Which capital-stack entities does this PROPERTY have?
 *
 *  Route authority is a property; position() reads every entity tied to
 *  it. This is the join and it is the whole of it — a query, not a
 *  derivation, exactly like Debt's listInstrumentsForProperty(). */
async function listCapitalEntitiesForProperty(db, propertyId, asOf) {
  const at = asOf || new Date().toISOString().slice(0, 10);
  const r = await db.query(
    `select id from equity_capital_entities
      where property_id = $1
        and effective_from <= $2
        and (effective_to is null or effective_to >= $2)
      order by tier_order nulls last, effective_from`,
    [propertyId, at]);
  return r.rows.map((row) => row.id);
}

//  Fetches the governed history for one property. Composes NOTHING —
//  hands rows to equity_position_read.position(), which is pure.
async function loadHistory(db, propertyId) {
  const entities = await db.query(
    `select * from equity_capital_entities where property_id = $1 order by tier_order nulls last, effective_from`,
    [propertyId]);
  const entityIds = entities.rows.map((r) => r.id);

  const positions = entityIds.length
    ? await db.query(
        `select * from equity_positions where capital_entity_id = any($1::uuid[]) order by effective_from`,
        [entityIds])
    : { rows: [] };
  const positionIds = positions.rows.map((r) => r.id);

  const q = async (table, col, ids, order) => (ids.length
    ? (await db.query(
        `select * from ${table} where ${col} = any($1::uuid[]) order by ${order}`,
        [ids])).rows
    : []);

  return {
    capital_entities: entities.rows,
    positions: positions.rows,
    pledges: await q("equity_position_pledges", "position_id", positionIds, "effective_from"),
    preferred_terms: await q("equity_preferred_terms", "position_id", positionIds, "effective_from"),
    contribution_claims: await q("equity_contribution_claims", "position_id", positionIds, "as_of_date"),
    conflicts: (await db.query(
      `select * from equity_conflicts where property_id = $1 order by noted_as_of`, [propertyId])).rows,
    exposure: (await db.query(
      `select * from equity_exposure where property_id = $1 order by as_of_date`, [propertyId])).rows,
  };
}

/*  ── ROOM-LEVEL ESTABLISHMENT, FOR THE CAPITAL STACK HOME CARD ────────
 *  Cheap by construction: one COUNT, never position(). Same discipline
 *  as Debt's establishmentForProperty() — a presence check, not a
 *  detail read.
 *
 *  ⚠ "Established" here means only "this property has at least one
 *  governed capital-stack entity recorded" — never "the cap table is
 *  complete", which for every surveyed deal it is not. The room stays
 *  capped at partially_established regardless, same reason Debt's own
 *  probe is capped: Reserves & Escrows remains unbuilt.               */
async function establishmentForProperty(db, propertyId, asOf) {
  const ids = await listCapitalEntitiesForProperty(db, propertyId, asOf);
  return {
    established: ids.length > 0,
    entity_count: ids.length,
    note: ids.length > 0
      ? `${ids.length} governed capital-stack ${ids.length === 1 ? "entity" : "entities"}`
      : "No governed equity or preferred terms yet",
  };
}

module.exports = {
  establishCapitalEntity, addPosition, addPledge, addPreferredTerms,
  addContributionClaim, recordConflict, recordExposure,
  listCapitalEntitiesForProperty, loadHistory, establishmentForProperty,
};
