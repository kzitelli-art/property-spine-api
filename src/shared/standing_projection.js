// ════════════════════════════════════════════════════════════════════
//  standing_projection.js — THE ONE SHAPE EVERY GOVERNED DOMAIN ANSWERS IN
//
//  PHILOSOPHY §40.6 names the standing projection and says what it is
//  for, in one sentence that decides this whole file:
//
//      "The standing projection is deliberately small so that many
//       entitled domains can be gathered on every question, which is
//       what lets Ask Spine answer cross-domain questions WITHOUT a
//       classifier or an intent router."
//
//  ── WHY THIS MODULE EXISTS, MEASURED RATHER THAN ASSUMED ─────────────
//  Seven governed reads existed. TWO had a `standingProjection()` and
//  they did not agree with each other:
//
//      debt    as_of · current_position · important_unknowns
//              · next_milestone            ← the §40.6 triple, named
//      equity  five counts · ownership_reconciliation
//              · next_milestone            ← no as_of, no unknowns
//
//  The other five had none at all. So "normalise against the reference
//  implementation" had no reference to normalise against: the two
//  candidates disagree, and the one closer to §40.6 is DEBT, not equity.
//  This module is the declaration neither of them was.
//
//  ── THE CONTRACT ─────────────────────────────────────────────────────
//      domain               which governed domain asserted it
//      as_of                when it was true
//      read_state           OK | READ_FAILED | READ_TIMED_OUT   (§40.7)
//      truth_state          ESTABLISHED | NOT_ESTABLISHED       (§40.7)
//      current_position     §40.6 — small, and about the PROPERTY
//      important_unknowns   §40.6 — array; [] means "none", not "unknown"
//      next_milestone       §40.6 — or null when nothing is pending
//
//  ── THE TWO AXES NEVER COLLAPSE (§40.7) ──────────────────────────────
//  `read_state` is a fact about SPINE. `truth_state` is a fact about the
//  PROPERTY. They are separate axes, not one ladder, and `validate()`
//  refuses a projection that conflates them — a read that failed may not
//  also claim the property has nothing, because "we could not look" and
//  "we looked and there is nothing" are different answers and only one
//  of them is safe to act on.
//
//  QUIET — the fourth silence — is deliberately NOT a field here. §40.7:
//  "Composite silence may only mean 'nothing needs attention' when every
//  required reader successfully returned — computed from reader outcomes
//  in code, never asked of the model." Quiet is a property of the
//  GATHERED SET, so it is computed by the composer over many projections
//  and can never be self-declared by one domain.
//
//  ── WHY THE PER-DOMAIN MAPPINGS ARE NOT IN THE READS ─────────────────
//  They were, first. `tests/gate_funding_boundary.js` refused it, and it
//  was right: it asserts that equity, insurance, tax and debt's economic
//  derivation reads IMPORT NOTHING — "it cannot reach funding by any
//  path." A read that imports nothing provably cannot reach the funding
//  side of Tax and Insurance, which is the boundary CLAUDE.md names as
//  never bypassable.
//
//  Adding `require("../shared/standing_projection.js")` to those four
//  broke that invariant for the sake of tidiness. A boundary gate is not
//  weakened to fit a refactor, so the mapping moved OUT to
//  `domain_standing_projections.js`, which may import freely because it
//  authors nothing. The reads stayed import-free.
//
//  ── §18 CLASSIFICATION — CLASS 1 ─────────────────────────────────────
//  A permanent product primitive. It owns no domain truth; it owns the
//  SHAPE in which domain truth is said, which is why §7 lets it exist
//  once rather than seven times.
// ════════════════════════════════════════════════════════════════════
"use strict";

const READ_STATES = Object.freeze(["OK", "READ_FAILED", "READ_TIMED_OUT"]);
const TRUTH_STATES = Object.freeze(["ESTABLISHED", "NOT_ESTABLISHED"]);

const FIELDS = Object.freeze([
  "domain", "as_of", "read_state", "truth_state",
  "current_position", "important_unknowns", "next_milestone",
]);

/**
 * Build a standing projection for a domain that read successfully.
 *
 * @param domain              string
 * @param as_of               ISO date the reading is true as of
 * @param current_position    small object — the domain's position NOW
 * @param important_unknowns  array of strings; [] is a real answer
 * @param next_milestone      string or null
 */
function established(domain, { as_of, current_position, important_unknowns = [], next_milestone = null }) {
  return freeze({
    domain, as_of,
    read_state: "OK",
    truth_state: "ESTABLISHED",
    current_position: current_position || {},
    important_unknowns: important_unknowns.slice(),
    next_milestone,
  });
}

/**
 * The property has nothing established. This is a FACT ABOUT THE
 * PROPERTY and a successful read — read_state stays OK. `why` is
 * required, because "nothing here" without a reason is the honest blank
 * that reads as a healthy state (§5).
 */
function notEstablished(domain, { as_of, why, next_milestone = null }) {
  if (!why) throw new Error("notEstablished requires `why` — an unexplained blank reads as health (§5)");
  return freeze({
    domain, as_of,
    read_state: "OK",
    truth_state: "NOT_ESTABLISHED",
    current_position: { why },
    important_unknowns: [],
    next_milestone,
  });
}

/**
 * Spine could not read. This says NOTHING about the property, so
 * truth_state is null rather than NOT_ESTABLISHED — the distinction
 * §40.7 exists to protect.
 */
function readFailed(domain, { as_of = null, timed_out = false, detail = null } = {}) {
  return freeze({
    domain, as_of,
    read_state: timed_out ? "READ_TIMED_OUT" : "READ_FAILED",
    truth_state: null,
    current_position: null,
    important_unknowns: [],
    next_milestone: null,
    detail,
  });
}

function freeze(o) { return Object.freeze(o); }

/*  The read happened NOW, even when it found nothing. "Nothing is
    established" is still a claim with a date on it (§40.4), so a domain
    with no reading to take as_of from uses this rather than null — a
    dateless fact cannot be compared against a later one, which is how a
    stale blank outlives the thing it described. */
function today() { return new Date().toISOString().slice(0, 10); }

/**
 * Refuse a projection that breaks the contract. Returns an array of
 * problems — empty means valid. Used by the gate, and callable by any
 * composer that wants to refuse rather than render a malformed fact.
 */
function validate(p) {
  const problems = [];
  if (!p || typeof p !== "object") return ["not an object"];

  for (const f of FIELDS) {
    if (!(f in p)) problems.push(`missing field: ${f}`);
  }
  if (p.domain != null && typeof p.domain !== "string") problems.push("domain must be a string");
  if (!READ_STATES.includes(p.read_state)) {
    problems.push(`read_state must be one of ${READ_STATES.join("|")}, saw ${JSON.stringify(p.read_state)}`);
  }
  if (!Array.isArray(p.important_unknowns)) problems.push("important_unknowns must be an array");

  //  ── THE TWO AXES (§40.7) ───────────────────────────────────────────
  if (p.read_state === "OK") {
    if (!TRUTH_STATES.includes(p.truth_state)) {
      problems.push(`a successful read must state truth_state (${TRUTH_STATES.join("|")}), saw ${JSON.stringify(p.truth_state)}`);
    }
    if (!p.as_of) problems.push("a successful read must carry as_of");
  } else {
    if (p.truth_state !== null) {
      problems.push("a failed or timed-out read may NOT assert truth_state — " +
        "'we could not look' and 'we looked and there is nothing' are different answers (§40.7)");
    }
    if (p.current_position !== null) {
      problems.push("a failed or timed-out read may NOT carry a current_position");
    }
  }

  //  QUIET is never self-declared — it is computed over the gathered set.
  if ("quiet" in p) {
    problems.push("a domain may not declare `quiet`; composite silence is computed " +
      "from every required reader's outcome, in code, never per-domain (§40.7)");
  }
  return problems;
}

/**
 * Composite silence, computed over the gathered set — the ONLY place
 * QUIET is decided. Returns QUIET only when every required reader
 * returned successfully AND nothing needs attention. If any reader
 * failed, the answer is BLIND, which is not health.
 */
function compositeSilence(projections, { required = [] } = {}) {
  const byDomain = new Map(projections.map((p) => [p.domain, p]));
  const missing = required.filter((d) => !byDomain.has(d));
  const failed = projections.filter((p) => p.read_state !== "OK").map((p) => p.domain);

  if (missing.length || failed.length) {
    return { state: "BLIND", missing, failed,
      why: "at least one required reader did not return, so silence cannot mean health (§40.7)" };
  }
  const attention = projections.filter(
    (p) => p.truth_state === "ESTABLISHED" && (p.next_milestone || p.important_unknowns.length));
  return attention.length
    ? { state: "ATTENTION", domains: attention.map((p) => p.domain) }
    : { state: "QUIET", why: "every required reader returned and none reports anything pending" };
}

module.exports = {
  READ_STATES, TRUTH_STATES, FIELDS,
  established, notEstablished, readFailed, validate, compositeSilence, today,
};
