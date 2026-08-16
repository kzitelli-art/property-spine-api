/* ════════════════════════════════════════════════════════════════════
   equity_position_read.js — position(property_history, as_of).
   THE GOVERNED READING OF EQUITY & PREFERRED EQUITY HISTORY AT A DATE.
   Rebuilt around migration 174's Round-4 shape.

   PURE. It imports nothing and touches no database — same gate
   discipline as debt_position_read.js: the economic derivation cannot
   reach funding (or Debt) by any path, transitively or otherwise. Rows
   come in; a reading comes out.

       WRITER WRITES TRUTH.  READER DERIVES TRUTH.

   ── ONE SHARED IDENTITY, TWO SEPARATE READINGS UNDERNEATH ───────────
   Every position is read once, from capital_stack_positions — the
   shared identity Round 4 froze. What hangs off it diverges by
   position_class: a `common` position reads its issuer's class terms
   plus any holder-specific overrides (gated by execution_status); a
   `preferred` position reads its own preferred_equity_terms rows.
   Common and Preferred are never the same reading wearing a different
   label — this file keeps them structurally separate the whole way to
   the response, exactly the shape Round 3/4 settled on.

   ── AN UNEXECUTED OVERRIDE IS SURFACED, NEVER APPLIED (Ruling 3) ────
   The Lincoln side letter exists as a real, dated, sourced fact the
   moment a row is written for it. Whether it currently GOVERNS
   Lincoln's economics is a different question, and this file answers
   both without conflating them: `overrides.applied` holds only rows
   whose execution_status is 'executed'; `overrides.surfaced_not_
   applied` holds every other in-force row, each carrying WHY it is not
   applied. A caller reading only `overrides.applied` sees the current
   settled economics; a caller reading the whole `overrides` object
   sees everything Spine knows, including what is still pending.

   ── ACCRUAL IS NEVER COMPUTED HERE (E3) ─────────────────────────────
   Unlike debt_position_read.js's projected balance, this file does NOT
   derive an accrued preferred return from rate × time — not from
   current_pay_rate_bp, not from accrued_rate_bp, not from a Minimum
   Dividend schedule. accrued_preferred_return is always NOT_ESTABLISHED
   for every preferred position, unconditionally, for Build 1.

   ── THE MSC DEFERRAL, RENDERED EXACTLY AS FROZEN ─────────────────────
   A preferred position's terms are returned as separate, individually
   sourced fields — never collapsed into one summary number — so a
   caller can render precisely:

       MSC Return                 12.5% — established (governed_read)
       Minimum Dividend schedule  8%→9%→10%→11%→12%→12.5% — observed
                                  from survey, source clause pending
       Relationship between them  NOT ESTABLISHED
       Accrued preferred balance  NOT ESTABLISHED

   minimum_dividend_relationship_to_preferred_return is passed through
   exactly as stored — 'not_established' unless a real governing-
   document read has changed it — never inferred here from the
   schedule text or the pay rate.

   ── NO capital_stack_exposure TABLE. COVERAGE GAPS ARE DERIVED ───────
   Round 3 withdrew the Exposure table for this domain: a manually
   maintained ledger of "what's missing" drifts from what the rest of
   the schema actually holds. Instead, coverageGaps() below looks at
   the SAME rows position() already resolved and states what is absent
   — an issuer whose common tier has terms but no named holder; a named
   common holder with no recorded ownership percentage; a preferred
   position whose Minimum-Dividend-shaped fields are present but whose
   relationship to the stated return is not established. Every gap is
   computed from presence/absence of real rows, never authored by hand.

   ── THE WALLS THIS FILE IS RESPONSIBLE FOR ───────────────────────────
     E1  a holder is returned only if a position row names them.
         Absence is a derived coverage gap, never an inferred name.
     E2  every common-class / preferred-terms row is returned with its
         own source_authority. No single "the rate" is ever emitted.
     E3  no accrued balance is computed or returned. Ever, for Build 1.
     E4  every capital amount claim is returned per claim_source, and
         amount vs. ownership_percent are kept as separate lists — no
         reconciliation, no average, no winner.
     E5  this file has zero knowledge of debt_* tables — nothing here
         can even represent a member loan.
     E6  characterization conflicts are surfaced, not resolved.
     E7  a K-1/tracker-only holder claim without an assignment on file
         reads as a conflict against the standing party, never a
         silent replacement of it.
     E8  a side-letter override is returned ALONGSIDE the issuer's
         class terms for the same position — layered, never
         substituted — AND gated by execution_status (Ruling 3).
     E9  encumbrance is returned only when a pledge row exists.
         Absence is NOT_ESTABLISHED, never "confirmed unencumbered".
     E10 what could not be named is a DERIVED coverage gap, never
         synthesized into a completed cap table.
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
//  issuer, many source_authority rows per position). Unlike Debt's
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

//  A transfer is append-only: the successor points backward, so the
//  reader retires the prior holder once the successor becomes effective.
//  The old row does not need an in-place effective_to update, and it must
//  never reappear merely because a later successor has itself ended.
function positionsInForce(rows, asOf) {
  const supersededIds = new Set(
    rows.filter((r) => {
      const from = ymd(r.effective_from);
      return r.supersedes_position_id && from && onOrBefore(from, asOf);
    }).map((r) => r.supersedes_position_id)
  );
  return allInForce(rows, asOf).filter((r) => !supersededIds.has(r.id));
}

//  ── E4 · LATEST CLAIM PER SOURCE, AT OR BEFORE as_of, PER VALUE KIND ─
//  A source can restate its number over time (a GL balance grows with
//  each capital call) without any row being wrong. This picks the
//  newest claim FROM EACH SOURCE that does not look into the future,
//  never merges sources together — and amount_cents / ownership_percent
//  are tracked as separate lanes, because they are separate facts even
//  when the same source states both (as two rows).
function latestClaimsPerSource(claims, asOf, valueKey) {
  const bySource = {};
  for (const c of claims) {
    if (c[valueKey] == null) continue;
    const asOfDate = ymd(c.as_of_date);
    if (!asOfDate || !onOrBefore(asOfDate, asOf)) continue;
    const cur = bySource[c.claim_source];
    if (!cur || ymd(cur.as_of_date) < asOfDate) bySource[c.claim_source] = c;
  }
  return Object.keys(bySource).sort().map((k) => bySource[k]);
}

function holderOf(row) {
  return row.holder_legal_entity_id
    ? {
        legal_entity_id: row.holder_legal_entity_id,
        legal_name: row.holder_legal_name || null,
      }
    : { party_name_text: row.holder_name_text };
}

function commonClassTermReading(t) {
  return {
    term_source: t.term_source,
    rate_bp: t.rate_bp == null ? null : Number(t.rate_bp),
    rate_convention_as_stated: t.rate_convention_as_stated || null,
    compounding: t.compounding || null,
    waterfall_priority_text: t.waterfall_priority_text || null,
    source_authority: t.source_authority,
    effective_from: ymd(t.effective_from),
  };
}

//  ⚠ Ruling 3 — THE GATE. An override is APPLIED only when its
//  execution_status is 'executed'. Everything else in force is still
//  returned, under surfaced_not_applied, with an explicit reason.
function overrideReading(o) {
  return {
    override_kind: o.override_kind,
    override_text: o.override_text,
    execution_status: o.execution_status,
    execution_date: ymd(o.execution_date),
    term_source: o.term_source,
    source_authority: o.source_authority,
    effective_from: ymd(o.effective_from),
  };
}

function overridesReading(overrides) {
  const applied = [];
  const surfacedNotApplied = [];
  for (const o of overrides) {
    const reading = overrideReading(o);
    if (o.execution_status === "executed") {
      applied.push(reading);
    } else {
      surfacedNotApplied.push({
        ...reading,
        why_not_applied: o.execution_status === "draft_unexecuted"
          ? "this override is recorded as drafted but not executed — it is not applied to the current economic read"
          : "this override's execution status is not established — it is not applied to the current economic read",
      });
    }
  }
  return { applied, surfaced_not_applied: surfacedNotApplied };
}

function preferredTermReading(t) {
  return {
    term_source: t.term_source,
    source_authority: t.source_authority,
    current_pay_rate_bp: t.current_pay_rate_bp == null ? null : Number(t.current_pay_rate_bp),
    accrued_rate_bp: t.accrued_rate_bp == null ? null : Number(t.accrued_rate_bp),
    rate_convention_as_stated: t.rate_convention_as_stated || null,
    compounding: t.compounding || null,
    step_schedule_text: t.step_schedule_text || null,
    //  ⚠ THE MSC DEFERRAL — passed through exactly as stored, never
    //  inferred from the schedule text or the pay rate.
    minimum_dividend_schedule_text: t.minimum_dividend_schedule_text || null,
    minimum_dividend_relationship_to_preferred_return:
      t.minimum_dividend_relationship_to_preferred_return || "not_established",
    waterfall_priority_text: t.waterfall_priority_text || null,
    redemption_terms_text: t.redemption_terms_text || null,
    make_whole_text: t.make_whole_text || null,
    control_rights_text: t.control_rights_text || null,
    redemption_or_maturity_date: ymd(t.redemption_or_maturity_date),
    effective_from: ymd(t.effective_from),
  };
}

function amountClaimsReading(claims, asOf) {
  return {
    //  ⚠ E4 — never merged, never a winner picked.
    contribution: latestClaimsPerSource(claims, asOf, "amount_cents").map((c) => ({
      claim_source: c.claim_source,
      asserted_by_text: c.asserted_by_text || null,
      amount_cents: Number(c.amount_cents),
      as_of_date: ymd(c.as_of_date),
    })),
    ownership_percent: latestClaimsPerSource(claims, asOf, "ownership_percent").map((c) => ({
      claim_source: c.claim_source,
      asserted_by_text: c.asserted_by_text || null,
      ownership_percent: Number(c.ownership_percent),
      as_of_date: ymd(c.as_of_date),
    })),
  };
}

function ownershipReading(claims, asOf) {
  const rows = latestClaimsPerSource(claims, asOf, "ownership_percent");
  if (!rows.length) {
    return {
      truth_state: NOT_ESTABLISHED,
      value_percent: null,
      sources: [],
      why: "no source has recorded an ownership percentage for this position",
    };
  }
  const values = [...new Set(rows.map((r) => Number(r.ownership_percent).toFixed(4)))];
  if (values.length > 1) {
    return {
      truth_state: "CONFLICTED",
      value_percent: null,
      sources: rows.map((r) => r.claim_source),
      why: "current source claims disagree on this position's ownership percentage",
    };
  }
  return {
    truth_state: "ESTABLISHED",
    value_percent: Number(values[0]),
    sources: rows.map((r) => r.claim_source),
    why: null,
  };
}

function positionReading(pos, history, asOf) {
  //  ⚠ NOT allInForce — capital_amount_claims is dated by as_of_date,
  //  not effective_from/effective_to (it states what a source claimed
  //  AS OF a date, not a term in force over a period). Filtering it
  //  through allInForce would silently drop every claim, since the
  //  column it looks for does not exist on this table.
  //  latestClaimsPerSource() below does the as_of filtering itself.
  const claims = history.amount_claims.filter((c) => c.position_id === pos.id);
  const pledgeRows = allInForce(
    history.pledges.filter((p) => p.position_id === pos.id), asOf);

  const base = {
    position_id: pos.id,
    position_class: pos.position_class,
    issuer_legal_entity_id: pos.issuer_legal_entity_id,
    holder: holderOf(pos),
    effective_from: ymd(pos.effective_from),

    //  ⚠ E4 — amount and ownership-percent claims stay separate lists,
    //  each per source, never merged into one figure.
    capital_amounts: amountClaimsReading(claims, asOf),
    ownership: ownershipReading(claims, asOf),

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

  if (pos.position_class === "common") {
    const classTerms = allInForce(
      history.common_class_terms.filter((t) => t.issuer_legal_entity_id === pos.issuer_legal_entity_id),
      asOf);
    const overrides = allInForce(
      history.position_overrides.filter((o) => o.position_id === pos.id), asOf);
    return {
      ...base,
      common: {
        //  ⚠ E2/Ruling 2 — the issuer's class terms, never copied per
        //  holder. Every in-force row, each with its own source_authority.
        class_terms: classTerms.map(commonClassTermReading),
        //  ⚠ Ruling 3 — applied vs. surfaced_not_applied, never merged.
        overrides: overridesReading(overrides),
      },
      preferred: null,
    };
  }

  const terms = allInForce(
    history.preferred_terms.filter((t) => t.position_id === pos.id), asOf);
  return {
    ...base,
    common: null,
    preferred: {
      //  ⚠ E2/E8 — every in-force terms row, each with its own
      //  source_authority. Never collapsed into one "the terms are X".
      terms: terms.map(preferredTermReading),
      //  ⚠ E3 — always NOT_ESTABLISHED. See the file header.
      accrued_preferred_return: { truth_state: NOT_ESTABLISHED,
        why: "no accrued preferred return is booked in any surveyed source; Spine does not " +
             "compute one from a stated rate, a stepped schedule, or a Minimum Dividend " +
             "schedule whose relationship to the preferred return is not established" },
    },
  };
}

function ownershipReconciliation(positionReadings) {
  if (!positionReadings.length) {
    return {
      truth_state: NOT_ESTABLISHED,
      target_percent: 100,
      current_total_percent: null,
      issuer_groups: [],
      why: "no current capital-stack positions are established",
    };
  }

  const byIssuer = {};
  for (const p of positionReadings) {
    (byIssuer[p.issuer_legal_entity_id] = byIssuer[p.issuer_legal_entity_id] || []).push(p);
  }
  const issuerGroups = Object.keys(byIssuer).sort().map((issuerId) => {
    const positions = byIssuer[issuerId];
    const established = positions.filter((p) => p.ownership.truth_state === "ESTABLISHED");
    const conflicted = positions.filter((p) => p.ownership.truth_state === "CONFLICTED");
    const total = Math.round(established.reduce(
      (sum, p) => sum + Number(p.ownership.value_percent), 0) * 10000) / 10000;
    let truthState, why;
    if (conflicted.length) {
      truthState = "CONFLICTED";
      why = "one or more positions carry disagreeing current ownership claims";
    } else if (!established.length) {
      truthState = NOT_ESTABLISHED;
      why = "no current position at this issuer has an established ownership percentage";
    } else if (established.length < positions.length) {
      truthState = "INCOMPLETE";
      why = "not every current position at this issuer has an established ownership percentage";
    } else if (Math.abs(total - 100) <= 0.0001) {
      truthState = "RECONCILED";
      why = null;
    } else {
      truthState = "DOES_NOT_RECONCILE";
      why = "the established current ownership percentages do not total 100%";
    }
    return {
      issuer_legal_entity_id: issuerId,
      truth_state: truthState,
      target_percent: 100,
      current_total_percent: conflicted.length || !established.length ? null : total,
      position_count: positions.length,
      positions_with_established_percentage: established.length,
      why,
    };
  });

  let truthState, why;
  if (issuerGroups.some((g) => g.truth_state === "CONFLICTED")) {
    truthState = "CONFLICTED";
    why = "at least one issuer carries disagreeing ownership claims";
  } else if (issuerGroups.some((g) => g.truth_state === "DOES_NOT_RECONCILE")) {
    truthState = "DOES_NOT_RECONCILE";
    why = "at least one issuer's established ownership does not total 100%";
  } else if (issuerGroups.every((g) => g.truth_state === "RECONCILED")) {
    truthState = "RECONCILED";
    why = null;
  } else if (issuerGroups.every((g) => g.truth_state === NOT_ESTABLISHED)) {
    truthState = NOT_ESTABLISHED;
    why = "no issuer has an established ownership schedule";
  } else {
    truthState = "INCOMPLETE";
    why = "one or more issuer ownership schedules are incomplete";
  }

  return {
    truth_state: truthState,
    target_percent: 100,
    current_total_percent: issuerGroups.length === 1
      ? issuerGroups[0].current_total_percent : null,
    issuer_groups: issuerGroups,
    why,
  };
}

//  ── DERIVED COVERAGE GAPS — REPLACES capital_stack_exposure ─────────
//  Computed from the SAME rows position() already resolved. Never
//  hand-authored, never allowed to drift from what the rest of the
//  reading actually holds (Round 3's ruling against a parallel table).
function coverageGaps(positionReadings, history, asOf) {
  const gaps = [];
  const commonByIssuer = {};
  for (const r of positionReadings) {
    if (r.position_class !== "common") continue;
    (commonByIssuer[r.issuer_legal_entity_id] = commonByIssuer[r.issuer_legal_entity_id] || []).push(r);
  }

  //  A pro-rata class term (or waterfall default) exists for an issuer
  //  whose common tier has NO named holder on record — the class term
  //  proves the tier is real; the absence of any holder proves it is
  //  unnamed.
  const issuersWithClassTerms = new Set(
    allInForce(history.common_class_terms, asOf).map((t) => t.issuer_legal_entity_id));
  for (const issuerId of issuersWithClassTerms) {
    if (!(commonByIssuer[issuerId] || []).length) {
      gaps.push({
        kind: "unnamed_common_tier",
        issuer_legal_entity_id: issuerId,
        what: "this issuer's common class carries governed pro-rata or waterfall terms, " +
              "but no common holder is on record",
        why_unresolved: "no capital_stack_positions row names a common holder for this issuer as of " + asOf,
      });
    }
  }

  //  A named holder with no settled ownership percentage from ANY source —
  //  "who holds it" is answered; "how much" is not. Preferred positions
  //  are included: the operating snapshot cannot reconcile to 100% by
  //  silently dropping the class whose percentage is missing.
  for (const r of positionReadings) {
    if (r.ownership.truth_state === NOT_ESTABLISHED) {
      gaps.push({
        kind: "unrecorded_ownership_percent",
        position_id: r.position_id,
        holder: r.holder,
        what: "this holder is named, but no source has recorded its ownership percentage",
        why_unresolved: "no capital_amount_claims row states ownership_percent for this position as of " + asOf,
      });
    } else if (r.ownership.truth_state === "CONFLICTED") {
      gaps.push({
        kind: "ownership_percent_conflict",
        position_id: r.position_id,
        holder: r.holder,
        what: "current sources disagree on this holder's ownership percentage",
        why_unresolved: r.ownership.why,
      });
    }
  }

  //  ⚠ THE MSC-SHAPED GAP, GENERALIZED. A preferred position carries an
  //  observed Minimum-Dividend-style schedule whose relationship to the
  //  stated preferred return is not established — this is exactly the
  //  frozen MSC deferral, surfaced as a gap rather than silently
  //  dropped.
  for (const r of positionReadings) {
    if (r.position_class !== "preferred") continue;
    for (const t of r.preferred.terms) {
      if (t.minimum_dividend_schedule_text
          && t.minimum_dividend_relationship_to_preferred_return === "not_established") {
        gaps.push({
          kind: "minimum_dividend_relationship_not_established",
          position_id: r.position_id,
          holder: r.holder,
          what: "a Minimum Dividend schedule is observed for this position, but its " +
                "relationship to the stated preferred return (additive, offset, or other) " +
                "is not established",
          why_unresolved: "the schedule is recorded as observed from a secondary source " +
                           "(source_authority: " + t.source_authority + "); the governing " +
                           "clause itself has not been read",
        });
      }
    }
  }

  return gaps;
}

function position(history, asOfInput) {
  const asOf = ymd(asOfInput);
  const positions = history.positions || [];
  const conflicts = history.conflicts || [];

  //  ── EVERY POSITION IN FORCE, ONE SHARED IDENTITY, TWO READINGS ────
  const positionReadings = positionsInForce(positions, asOf)
    .map((p) => positionReading(p, history, asOf));

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

  return {
    as_of: asOf,
    positions: positionReadings,
    conflicts: conflictReadings,
    ownership_reconciliation: ownershipReconciliation(positionReadings),
    //  ⚠ Round 3 — DERIVED, never read from a stored exposure table.
    coverage_gaps: coverageGaps(positionReadings, history, asOf),
  };
}

/*  ── COMPACT STANDING PROJECTION (§40.6) ───────────────────────────
 *  Cheap — no derivation beyond counting what position() already
 *  resolved. Current position, important unknowns, next milestone. */
function standingProjection(reading) {
  const named = reading.positions.filter(
    (p) => p.holder.legal_entity_id || p.holder.party_name_text);
  const preferredPositions = reading.positions.filter((p) => p.position_class === "preferred");

  return {
    position_count: reading.positions.length,
    named_holder_count: named.length,
    preferred_position_count: preferredPositions.length,
    open_conflict_count: reading.conflicts.length,
    coverage_gap_count: reading.coverage_gaps.length,
    ownership_reconciliation: reading.ownership_reconciliation,
    //  Never "complete" — the portfolio-wide finding is that no deal's
    //  cap table is ever fully named. This says what IS named, plainly.
    next_milestone: reading.coverage_gaps.length
      ? "resolve the largest recorded coverage gap"
      : (reading.conflicts.length
          ? "resolve the oldest open conflict"
          : "no open coverage gaps or conflicts recorded"),
  };
}

module.exports = { position, standingProjection, ownershipReconciliation, NOT_ESTABLISHED };
