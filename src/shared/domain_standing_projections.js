// ════════════════════════════════════════════════════════════════════
//  domain_standing_projections.js — EIGHT DOMAINS, ONE SHAPE
//
//  Every governed domain already answers "where does this property
//  stand". Eight of them, in eight vocabularies:
//
//      as_of            five domains
//      period           insurance
//      term{start,end}  tenancy's term variant
//
//      next_milestone       tenancy, contracted_service
//      next                 compliance
//      next_due             tax
//      next_due_statement   utility
//      next_renewal         insurance
//
//      truth_state · setup_state · standing.code · overall · established
//                                    — five words for "is it established"
//
//  All of those mean the same thing to a composer, and none of them
//  agreed. This module maps each domain's OWN read into the one contract
//  in `standing_projection.js`. It authors no truth: every value is
//  copied from what the canonical read already returned, and the rich
//  read remains the DETAIL projection §40.6 calls for as a second read.
//
//  ── WHY THIS IS A SEPARATE FILE AND NOT EIGHT METHODS ────────────────
//  The mappings lived inside the reads first. `gate_funding_boundary.js`
//  refused that and was right: equity, insurance, tax and debt's
//  economic derivation reads must IMPORT NOTHING — "it cannot reach
//  funding by any path" — which is how the Tax and Insurance funding
//  boundary is guaranteed structurally rather than by review. A read
//  that imports nothing cannot reach funding whatever anyone later adds
//  to a shared module.
//
//  So the reads stayed import-free and the shaping moved here. This file
//  may import freely because it is a mapping, not a derivation: it never
//  computes a position, only restates one.
//
//  ── §18 CLASSIFICATION — CLASS 1 ─────────────────────────────────────
//  Permanent. It owns the SHAPE in which domain truth is said, once,
//  rather than eight times (§7).
// ════════════════════════════════════════════════════════════════════
"use strict";

const c = require("./standing_projection.js");

const asOfOr = (v) => v || c.today();

/*  Each mapper takes what its domain's canonical read RETURNED and
    restates it. None of them queries, and none of them decides. */
const MAPPERS = {

  insurance(reading) {
    if (!reading || !reading.established) {
      return c.notEstablished("insurance", {
        as_of: asOfOr(reading && reading.period),
        why: "no insurance coverage allocation is established for this property in Spine",
      });
    }
    const unknowns = [];
    if (reading.mixed_currency) unknowns.push("coverages are recorded in more than one currency");
    if (reading.annual_cost_cents == null) unknowns.push("annual cost is not established");
    return c.established("insurance", {
      as_of: asOfOr(reading.period),
      current_position: {
        coverage_count: (reading.coverages || []).length,
        annual_cost_cents: reading.annual_cost_cents,
        period_accrual_cents: reading.period_accrual_cents,
        currency_code: reading.currency_code,
      },
      important_unknowns: unknowns,
      next_milestone: reading.next_renewal || null,
    });
  },

  tax(reading) {
    if (!reading || reading.overall === "not_established" || !reading.obligation_count) {
      return c.notEstablished("tax", {
        as_of: asOfOr(reading && reading.as_of),
        why: (reading && reading.overall_why)
          || "no tax obligation is established for this property in Spine",
      });
    }
    const unknowns = [];
    for (const r of reading.rows || []) {
      if (r.applicability === "not_established") {
        unknowns.push(`applicability not confirmed: ${r.label || r.tax_type || "an obligation"}`);
      }
    }
    if ((reading.schedule_disagreements || []).length) {
      unknowns.push(`${reading.schedule_disagreements.length} recorded schedule disagreement(s)`);
    }
    return c.established("tax", {
      as_of: asOfOr(reading.as_of),
      current_position: {
        overall: reading.overall,
        why: reading.overall_why,
        obligation_count: reading.obligation_count,
        clearance: reading.clearance || null,
      },
      important_unknowns: unknowns,
      next_milestone: reading.next_due_label || reading.next_due || null,
    });
  },

  //  utility and contracted_service share a projection family: the read
  //  returns { setup_state, unresolved, next_* } under `.standing`.
  utility(standing) { return familyOfTwo("utility", standing, "next_due_statement"); },
  contracted_service(standing) { return familyOfTwo("contracted_service", standing, "next_milestone"); },

  compliance(reading) {
    const items = (reading && reading.items) || [];
    if (!items.length) {
      return c.notEstablished("compliance", {
        as_of: asOfOr(reading && reading.as_of),
        why: (reading && reading.coverage && reading.coverage.meaning)
          || "no compliance item is established for this property in Spine",
      });
    }
    const unknowns = [];
    if (reading.coverage && reading.coverage.state !== "established") {
      unknowns.push(reading.coverage.meaning || "compliance coverage is not established");
    }
    for (const it of items) {
      for (const un of it.unresolved || []) {
        unknowns.push(typeof un === "string" ? un : (un && (un.why || un.what)) || "unresolved");
      }
    }
    const nexts = items.map((i) => i.next).filter((n) => n && n.date)
      .sort((a, b) => String(a.date).localeCompare(String(b.date)));
    return c.established("compliance", {
      as_of: asOfOr(reading.as_of),
      current_position: {
        item_count: items.length,
        attention_count: items.filter((i) => i.attention).length,
        coverage_state: reading.coverage ? reading.coverage.state : null,
      },
      important_unknowns: unknowns,
      next_milestone: nexts.length ? nexts[0] : null,
    });
  },

  tenancy(reading) {
    if (!reading || !reading.standing || reading.standing.truth_state === "NOT_ESTABLISHED") {
      return c.notEstablished("tenancy", {
        as_of: asOfOr(reading && reading.as_of),
        why: (reading && reading.standing && reading.standing.why)
          || "no rentable position is recorded for this property in Spine",
      });
    }
    const u = reading.unknowns || {};
    return c.established("tenancy", {
      as_of: asOfOr(reading.as_of),
      current_position: { ...(reading.position || {}), truth_state: reading.standing.truth_state },
      important_unknowns: Object.entries(u)
        .filter(([, v]) => typeof v === "number" && v > 0)
        .map(([k, v]) => `${k.replace(/_/g, " ")}: ${v}`),
      next_milestone: reading.next_milestone || null,
    });
  },

  //  equity and debt already had a standingProjection(), and the two
  //  DISAGREED — which is why "normalise against the reference" had no
  //  reference. Those richer objects are preserved verbatim as
  //  current_position: nothing is lost, and the envelope is added.
  equity(rich, reading) {
    if (!rich || !reading || !reading.positions || !reading.positions.length) {
      return c.notEstablished("equity", {
        as_of: asOfOr(reading && reading.as_of),
        why: "no capital-stack position is established for this property in Spine",
      });
    }
    const unknowns = [];
    if (rich.coverage_gap_count) unknowns.push(`${rich.coverage_gap_count} recorded coverage gap(s)`);
    if (rich.open_conflict_count) unknowns.push(`${rich.open_conflict_count} open conflict(s)`);
    if (rich.position_count > rich.named_holder_count) {
      unknowns.push(`${rich.position_count - rich.named_holder_count} position(s) with no named holder`);
    }
    return c.established("equity", {
      as_of: asOfOr(reading.as_of),
      current_position: rich,
      important_unknowns: unknowns,
      next_milestone: rich.next_milestone || null,
    });
  },

  debt(rich) {
    if (!rich || !rich.current_position) {
      return c.notEstablished("debt", {
        as_of: asOfOr(rich && rich.as_of),
        why: "no debt instrument is established for this property in Spine",
      });
    }
    return c.established("debt", {
      as_of: asOfOr(rich.as_of),
      current_position: rich,
      important_unknowns: Array.isArray(rich.important_unknowns)
        ? rich.important_unknowns
        : (rich.important_unknowns ? [rich.important_unknowns] : []),
      next_milestone: rich.next_milestone || null,
    });
  },
};

function familyOfTwo(domain, standing, nextKey) {
  if (!standing || standing.setup_state === "not_established") {
    return c.notEstablished(domain, {
      as_of: asOfOr(standing && standing.as_of),
      why: `no ${domain.replace(/_/g, " ")} truth is established for this property in Spine`,
    });
  }
  const unresolved = standing.unresolved || [];
  return c.established(domain, {
    as_of: asOfOr(standing.as_of),
    current_position: {
      setup_state: standing.setup_state,
      unresolved_count: standing.unresolved_count != null ? standing.unresolved_count : unresolved.length,
    },
    important_unknowns: unresolved.map(
      (u) => (typeof u === "string" ? u : (u && (u.why || u.label || u.what)) || "unresolved")),
    next_milestone: standing[nextKey] || null,
  });
}

/**
 * Restate one domain's reading in the contract shape.
 * Throws on an unknown domain rather than returning something shaped
 * like an answer — a composer must not silently drop a domain it was
 * asked for.
 */
function project(domain, reading, extra) {
  const m = MAPPERS[domain];
  if (!m) throw new Error(`no standing-projection mapping for domain "${domain}"`);
  return m(reading, extra);
}

const DOMAINS = Object.freeze(Object.keys(MAPPERS).sort());

module.exports = { project, DOMAINS, MAPPERS };
