/* ════════════════════════════════════════════════════════════════════
   equity_position_read.js — position(property_history, as_of).
   THE GOVERNED READING OF EQUITY & PREFERRED EQUITY HISTORY AT A DATE.

   PURE. It imports nothing and touches no database — same gate
   discipline as debt_position_read.js: the economic derivation cannot
   reach funding (or Debt) by any path, transitively or otherwise. Rows
   come in; a reading comes out.

       WRITER WRITES TRUTH.  READER DERIVES TRUTH.

   ── NO FIELD LAUNDERS ITS SOURCE CLASS (E2, E4) ─────────────────────
   There is deliberately no generic `preferred_rate` or `contributed_
   amount`. Every rate is returned WITH the source that stated it, and
   when two sources disagree — which, per EQUITY_SURVEY.md, is the norm
   rather than the exception — BOTH are returned, never merged, never a
   silently-chosen "winner".

   ── ACCRUAL IS NEVER COMPUTED HERE (E3) ─────────────────────────────
   Unlike debt_position_read.js's projected balance, this file does NOT
   derive an accrued preferred return from rate × time. Debt could do
   that safely because its schedule math was proven against 120 real
   published rows from one authoritative source. Equity's own specimen
   shows the compounding convention itself disputed between sources at
   the SAME deal (4125: OA says quarterly, tracker says monthly) — so
   accrued_preferred_return is always NOT_ESTABLISHED here, and the raw
   dated terms are returned instead, for a human to read.

   ── THE WALLS THIS FILE IS RESPONSIBLE FOR — docs/EQUITY_READ_
      CONTRACT_AND_SCHEMA.md HAS THE FULL SPECIMEN FOR EACH ────────────
     E1  a holder is returned only if a position row names them.
         Absence is NOT_ESTABLISHED, never inferred from a tracker.
     E2  every preferred-terms row is returned with its own
         source_authority. No single "the rate" is ever emitted.
     E3  no accrued balance is computed or returned. Ever, for Build 1.
     E4  every contribution claim is returned per claim_source. No
         reconciliation, no average, no winner.
     E5  this file has zero knowledge of debt_* tables — nothing here
         can even represent a member loan.
     E6  characterization conflicts are surfaced, not resolved.
     E7  a K-1/tracker-only holder claim without an assignment on file
         reads as a conflict against the standing party, never a
         silent replacement of it.
     E8  a side-letter term row is returned ALONGSIDE the deal-level
         term row for the same position — layered, never substituted.
     E9  encumbrance is returned only when a pledge row exists.
         Absence is NOT_ESTABLISHED, never "confirmed unencumbered".
     E10 exposure items are returned as the 6-part CLAUDE.md contract,
         never synthesized into a completed cap table.
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const NOT_ESTABLISHED = "NOT_ESTABLISHED";

function ymd(v) {
  if (!v) return null;
  if (typeof v === "string") return v.slice(0, 10);
  const d = new Date(v);
  return isNaN(d) ? null : d.toISOString().slice(0, 10);
}

function onOrBefore(aISO, bISO) { return aISO <= bISO; }

//  All rows in force at asOf — MULTIPLE may coexist (many holders per
//  entity, many source_authority rows per position). Unlike Debt's
//  singular per-role slots, plurality is the normal case here.
function allInForce(rows, asOf) {
  return rows.filter((r) => {
    const from = ymd(r.effective_from);
    const to = ymd(r.effective_to);
    if (!from || !onOrBefore(from, asOf)) return false;
    if (to && !onOrBefore(asOf, to)) return false;
    return true;
  });
}

//  ── E4 · LATEST CLAIM PER SOURCE, AT OR BEFORE as_of ────────────────
//  contribution_claims are not effective-dated the way terms are — a
//  source can restate its number over time (a GL balance grows with
//  each capital call) without any row being wrong. This picks the
//  newest claim FROM EACH SOURCE that does not look into the future,
//  never merges sources together.
function latestClaimPerSource(claims, asOf) {
  const bySource = {};
  for (const c of claims) {
    const asOfDate = ymd(c.as_of_date);
    if (!asOfDate || !onOrBefore(asOfDate, asOf)) continue;
    const cur = bySource[c.claim_source];
    if (!cur || ymd(cur.as_of_date) < asOfDate) bySource[c.claim_source] = c;
  }
  return Object.keys(bySource).sort().map((k) => bySource[k]);
}

function holderOf(row) {
  return row.legal_entity_id
    ? { legal_entity_id: row.legal_entity_id }
    : { party_name_text: row.party_name_text };
}

function positionReading(pos, allTerms, allPledges, allClaims, asOf) {
  const terms = allInForce(
    allTerms.filter((t) => t.position_id === pos.id), asOf);
  const pledgeRows = allInForce(
    allPledges.filter((p) => p.position_id === pos.id), asOf);
  const claims = latestClaimPerSource(
    allClaims.filter((c) => c.position_id === pos.id), asOf);

  return {
    position_id: pos.id,
    position_kind: pos.position_kind,
    holder: holderOf(pos),
    effective_from: ymd(pos.effective_from),

    //  ⚠ E2/E8 — every in-force terms row, each with its own
    //  source_authority. Never collapsed into one "the terms are X".
    preferred_terms: terms.map((t) => ({
      term_source: t.term_source,
      rate_bp: t.rate_bp == null ? null : Number(t.rate_bp),
      rate_convention_as_stated: t.rate_convention_as_stated || null,
      compounding: t.compounding || null,
      waterfall_priority_text: t.waterfall_priority_text || null,
      redemption_terms_text: t.redemption_terms_text || null,
      make_whole_text: t.make_whole_text || null,
      source_authority: t.source_authority,
      effective_from: ymd(t.effective_from),
    })),

    //  ⚠ E3 — always NOT_ESTABLISHED. See the file header.
    accrued_preferred_return: { truth_state: NOT_ESTABLISHED,
      why: "no accrued preferred return is booked in any surveyed source; " +
           "Spine does not compute one from a disputed compounding convention" },

    //  ⚠ E4 — one entry per source, never merged, never a winner picked.
    contribution_claims: claims.map((c) => ({
      claim_source: c.claim_source,
      amount_cents: Number(c.amount_cents),
      as_of_date: ymd(c.as_of_date),
    })),

    //  ⚠ E9 — absence of a pledge row is NOT_ESTABLISHED, never
    //  "confirmed unencumbered".
    encumbrance: pledgeRows.length
      ? pledgeRows.map((p) => ({
          pledgee_name_text: p.pledgee_name_text,
          pledge_description: p.pledge_description || null,
          effective_from: ymd(p.effective_from),
        }))
      : { truth_state: NOT_ESTABLISHED,
          why: "no pledge has been recorded for this position — not evidence it is unencumbered" },
  };
}

function position(history, asOfInput) {
  const asOf = ymd(asOfInput);
  const entities = history.capital_entities || [];
  const positions = history.positions || [];
  const terms = history.preferred_terms || [];
  const pledges = history.pledges || [];
  const claims = history.contribution_claims || [];
  const conflicts = history.conflicts || [];
  const exposure = history.exposure || [];

  //  ── E1 · ENTITIES IN FORCE, EACH WITH ITS OWN POSITIONS ───────────
  const entityReadings = allInForce(entities, asOf).map((e) => {
    const entityPositions = allInForce(
      positions.filter((p) => p.capital_entity_id === e.id), asOf)
      .map((p) => positionReading(p, terms, pledges, claims, asOf));

    return {
      capital_entity_id: e.id,
      entity_kind: e.entity_kind,
      legal_entity_id: e.legal_entity_id,
      tier_order: e.tier_order == null ? null : Number(e.tier_order),
      effective_from: ymd(e.effective_from),
      //  ⚠ E1/E10 — an entity established with zero position rows is the
      //  common, expected shape at this portfolio, not an edge case.
      //  Never inferred, never backfilled.
      positions: entityPositions,
    };
  });

  //  ── E6/E7 · CONFLICTS, SURFACED NEVER RESOLVED ────────────────────
  const conflictReadings = conflicts
    .filter((c) => onOrBefore(ymd(c.noted_as_of), asOf))
    .map((c) => ({
      conflict_kind: c.conflict_kind,
      position_id: c.position_id || null,
      claim_a: c.claim_a_text,
      claim_b: c.claim_b_text,
      noted_as_of: ymd(c.noted_as_of),
    }));

  //  ── E10 · THE SIX-PART EXPOSURE CONTRACT, VERBATIM ────────────────
  const exposureReadings = exposure
    .filter((x) => onOrBefore(ymd(x.as_of_date), asOf))
    .map((x) => ({
      what: x.what_text,
      magnitude_cents: x.magnitude_cents == null ? null : Number(x.magnitude_cents),
      magnitude_basis: x.magnitude_basis_text || null,
      why_unresolved: x.why_unresolved_text,
      resolution: x.resolution_text || null,
      as_of_date: ymd(x.as_of_date),
      //  §Exposure's own rule: UNASSIGNED is a value, not an absence.
      owner_user_id: x.owner_user_id || "UNASSIGNED",
    }));

  return {
    as_of: asOf,
    capital_entities: entityReadings,
    conflicts: conflictReadings,
    exposure: exposureReadings,
  };
}

/*  ── COMPACT STANDING PROJECTION (§40.6) ───────────────────────────
 *  Cheap — no derivation beyond counting what position() already
 *  resolved. Current position, important unknowns, next milestone. */
function standingProjection(reading) {
  const allPositions = reading.capital_entities.flatMap((e) => e.positions);
  const namedHolders = allPositions.filter(
    (p) => p.holder.legal_entity_id || p.holder.party_name_text);
  const preferredPositions = allPositions.filter((p) => p.position_kind === "preferred_class");

  return {
    capital_entity_count: reading.capital_entities.length,
    position_count: allPositions.length,
    named_holder_count: namedHolders.length,
    preferred_class_position_count: preferredPositions.length,
    open_conflict_count: reading.conflicts.length,
    exposure_item_count: reading.exposure.length,
    //  Never "complete" — the portfolio-wide finding is that no deal's
    //  cap table is ever fully named. This says what IS named, plainly.
    next_milestone: reading.exposure.length
      ? "resolve the largest recorded Exposure item"
      : (reading.conflicts.length
          ? "resolve the oldest open conflict"
          : "no open Exposure or conflicts recorded"),
  };
}

module.exports = { position, standingProjection, NOT_ESTABLISHED };
