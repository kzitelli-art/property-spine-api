// ════════════════════════════════════════════════════════════════════
//  turn_scope_interpreter.js — A COMPLETE TURN SCOPE, STRUCTURED
//
//  Class 1, permanent product primitive. PURE: no database, no I/O, no
//  clock. Sibling of unit_triage_interpreter.js (BUILD 1) and bound by the
//  same rule: it PROPOSES, the human CONFIRMS, and nothing here is truth.
//
//  ── WHAT IT DOES THAT BUILD 1 DOES NOT ──────────────────────────────
//  BUILD 1 answered "is this unit empty and is anything alarming". BUILD 2
//  answers "what is the complete normal-turn scope, and in what order does it
//  happen". So this file's real job is SEPARATION: one sentence naming three
//  repairs must become three findings and three work items, never one
//  generic "repairs needed" note. A merged repair note is what forces a
//  manager to reconstruct a unit's condition from prose later.
//
//  ── WHAT IT MAY NEVER PROPOSE ───────────────────────────────────────
//  cause · cost · vendor · delivery or completion date · resident
//  responsibility or billback · that the inspection was complete · that any
//  work is done · that the unit is or will be ready.
//
//  `ready` is not in this file's vocabulary.
// ════════════════════════════════════════════════════════════════════

"use strict";

const { STAGE } = require("./turn_sequence");

// ── CLOSED VOCABULARIES (mirrored by CHECK constraints in migration 113) ──
const PAINT = Object.freeze({ NONE: "none", TOUCH_UP: "touch_up", PARTIAL: "partial", FULL: "full", UNKNOWN: "unknown" });
const CLEANING = Object.freeze({ NONE: "none", TOUCH_UP: "touch_up", FULL: "full", DEEP: "deep", UNKNOWN: "unknown" });
const KEYS = Object.freeze({ ACCOUNTED_FOR: "accounted_for", ITEMS_MISSING: "items_missing", UNKNOWN: "unknown" });
const APPLIANCE = Object.freeze({
  WORKING: "working", NEEDS_REPAIR: "needs_repair", NEEDS_REPLACEMENT: "needs_replacement",
  MISSING: "missing", UNKNOWN: "unknown",
});
const INSPECTION = Object.freeze({ COMPLETE: "complete_turn_scope", PARTIAL: "partial" });

const PAINT_VALUES = Object.freeze(Object.values(PAINT));
const CLEANING_VALUES = Object.freeze(Object.values(CLEANING));
const KEYS_VALUES = Object.freeze(Object.values(KEYS));
const APPLIANCE_VALUES = Object.freeze(Object.values(APPLIANCE));
const INSPECTION_VALUES = Object.freeze(Object.values(INSPECTION));

const PAINT_LABEL = Object.freeze({
  none: "None", touch_up: "Touch-up", partial: "Partial", full: "Full unit", unknown: "Unknown",
});
const CLEANING_LABEL = Object.freeze({
  none: "None", touch_up: "Touch-up clean", full: "Full clean", deep: "Deep clean", unknown: "Unknown",
});
const KEYS_LABEL = Object.freeze({
  accounted_for: "All expected keys and access devices accounted for",
  items_missing: "Items missing", unknown: "Unknown / not checked",
});
const APPLIANCE_LABEL = Object.freeze({
  working: "Working", needs_repair: "Needs repair", needs_replacement: "Needs replacement",
  missing: "Missing", unknown: "Unknown / not checked",
});
const INSPECTION_LABEL = Object.freeze({
  complete_turn_scope: "Complete turn-scope inspection", partial: "Partial inspection",
});

// ── THE STANDARD APPLIANCE CANDIDATE LIST ───────────────────────────
//  No per-unit appliance inventory exists anywhere in the schema today. This
//  is a CANDIDATE list, not a claim about what is in any particular unit, and
//  every read that uses it says so. When a real inventory arrives, this list
//  is replaced by it and nothing else changes.
//
//  Every appliance the operator does not answer for stays `unknown`. It never
//  becomes `working` to make a form look finished.
const STANDARD_APPLIANCES = Object.freeze([
  { key: "refrigerator", label: "Refrigerator" },
  { key: "range_oven", label: "Range / oven" },
  { key: "dishwasher", label: "Dishwasher" },
  { key: "microwave", label: "Microwave" },
  { key: "washer", label: "Washer" },
  { key: "dryer", label: "Dryer" },
  { key: "water_heater", label: "Water heater" },
  { key: "hvac_unit", label: "HVAC unit" },
  { key: "garbage_disposal", label: "Garbage disposal" },
]);

// ── DOES THIS REPAIR DISTURB PAINTED SURFACES? ──────────────────────
//  This is the ONE input that decides whether paint waits for a repair. Not
//  every repair blocks paint: a leaking faucet under a sink does not require
//  repainting a bedroom, and treating every repair as paint-blocking would
//  stall the whole turn on unrelated work.
//
//  Anything not recognised returns NULL — not assessed — which the sequence
//  reader treats as BLOCKING. Conservative on purpose: the cost of guessing
//  "does not disturb" wrongly is painting over work that must be reopened,
//  and paying for the paint twice.
//  ⚠ EVERY PATTERN CARRIES ITS OWN PLURAL. This is the second time this exact
//  bug class has appeared in this codebase — BUILD 1's interpreter silently
//  failed to match "cockroaches" because `\bcockroach\b` cannot match inside
//  "cockroaches". Here `\boutlet\b` failed on "two outlets are loose", which
//  returned "not assessed" and would have blocked paint for the wrong reason.
//  A word-boundary pattern against operator prose must always spell the plural.
const DISTURBS_PAINT = [
  { re: /\b(wall(s)?|drywall|sheetrock|plaster|ceiling(s)?|hole(s)?|patch(es)?|crack(s)?)\b/i, v: true },
  { re: /\b(outlet(s)?|switch(es)?|receptacle(s)?|electrical box(es)?|light fixture(s)?|fixture(s)?)\b/i, v: true },
  { re: /\b(trim|baseboard(s)?|moulding(s)?|molding(s)?|casing(s)?|door ?frame(s)?|window ?frame(s)?)\b/i, v: true },
  { re: /\b(door(s)?|closet(s)?)\b/i, v: true },
  { re: /\b(faucet(s)?|sink(s)?|toilet(s)?|shower(s)?|tub(s)?|drain(s)?|plumbing|valve(s)?|supply line(s)?)\b/i, v: false },
  { re: /\b(refrigerator(s)?|fridge|stove(s)?|range(s)?|oven(s)?|dishwasher(s)?|microwave(s)?|washer(s)?|dryer(s)?|disposal)\b/i, v: false },
  { re: /\b(smoke detector(s)?|carbon monoxide|co detector(s)?|thermostat(s)?|blind(s)?|screen(s)?)\b/i, v: false },
];

function disturbsPaintedSurfaces(text) {
  for (const d of DISTURBS_PAINT) if (d.re.test(text)) return d.v;
  return null;   // not assessed → treated as blocking downstream
}

// ── SPLITTING A REPAIR SENTENCE INTO SEPARATE FINDINGS ──────────────
//
//  "Bathroom faucet leaks, bedroom door does not latch, and two outlets are
//   loose."  →  three findings, three work items.
//
//  Strategy, deliberately conservative:
//    · split on sentence and list punctuation first  (. ; ,)
//    · strip a leading "and"/"also" from each fragment
//    · split on a bare " and " ONLY when the text had no commas, so
//      "A, B, and C" is handled by the comma pass and a phrase like
//      "the AC and heat are both out" is not torn apart mid-clause
//    · drop fragments too short to carry a finding
//
//  When in doubt this UNDER-splits. An operator adding a missed item costs one
//  tap; an operator not noticing that Spine invented a repair costs a wrong
//  durable fact with their name on it.
function splitRepairClauses(text) {
  const raw = String(text || "").trim();
  if (!raw) return [];

  const hasCommas = /,/.test(raw);
  let parts = raw.split(/[.;]+|,/g);

  if (!hasCommas) {
    parts = parts.flatMap((p) => p.split(/\s+and\s+/i));
  }

  return parts
    .map((p) => p.replace(/^\s*(?:and|also|plus)\s+/i, "").trim())
    .map((p) => p.replace(/\s+/g, " "))
    .filter((p) => p.length >= 4)
    // a fragment with no letters is punctuation noise, not a finding
    .filter((p) => /[a-z]/i.test(p));
}

// Turn a clause into a work instruction without inventing a method.
//   "Bathroom faucet leaks" → "Diagnose and repair bathroom faucet leaks"
// We deliberately say "diagnose and repair" rather than naming a fix: the
// observation established a symptom, not a remedy.
function workTextForRepair(clause) {
  const c = clause.trim();
  const lead = c.charAt(0).toLowerCase() + c.slice(1);
  return "Diagnose and repair " + lead;
}

function capitalize(s) {
  const t = String(s || "").trim();
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : t;
}

/**
 * interpretRepairs — one repair sentence → SEPARATE findings and work.
 */
function interpretRepairs(text) {
  return splitRepairClauses(text).map((clause) => ({
    finding: capitalize(clause),
    evidence: clause,
    work: workTextForRepair(clause),
    stage: STAGE.REPAIR,
    disturbs_painted_surfaces: disturbsPaintedSurfaces(clause),
  }));
}

// ── STRUCTURED CHOICE → REQUIRED WORK ───────────────────────────────
//  `none` produces no work. `unknown` produces NO WORK EITHER, and instead
//  records an unresolved unknown — inventing work from an unknown would be
//  guessing, and inventing nothing silently would read as "no work needed".
function workForPaint(level, areas) {
  if (level === PAINT.FULL) return [{ work: "Paint full unit", stage: STAGE.PAINT }];
  if (level === PAINT.TOUCH_UP) return [{ work: "Touch up paint", stage: STAGE.PAINT }];
  if (level === PAINT.PARTIAL) {
    const where = String(areas || "").trim();
    return [{ work: where ? `Paint partial — ${where}` : "Paint partial areas", stage: STAGE.PAINT }];
  }
  return [];
}

function workForCleaning(level) {
  if (level === CLEANING.FULL) return [{ work: "Complete final full clean", stage: STAGE.FINAL_CLEAN }];
  if (level === CLEANING.DEEP) return [{ work: "Complete final deep clean", stage: STAGE.FINAL_CLEAN }];
  if (level === CLEANING.TOUCH_UP) return [{ work: "Complete final touch-up clean", stage: STAGE.FINAL_CLEAN }];
  return [];
}

//  Appliance work is REPAIR stage: it happens before paint and cleaning.
//  No cause, no cost, no vendor, no delivery date, no resident responsibility.
function workForAppliance(key, label, condition) {
  const name = label || key;
  if (condition === APPLIANCE.NEEDS_REPAIR)
    return [{ work: `Diagnose and repair ${name.toLowerCase()}`, stage: STAGE.REPAIR, disturbs_painted_surfaces: false }];
  if (condition === APPLIANCE.NEEDS_REPLACEMENT || condition === APPLIANCE.MISSING)
    return [{ work: `Source and install ${name.toLowerCase()}`, stage: STAGE.REPAIR, disturbs_painted_surfaces: false }];
  return [];
}

/**
 * proposeScope — the full BUILD 2 proposal. Writes nothing.
 *
 * Returns findings, required work with stages, and every unresolved unknown
 * stated out loud rather than left to be inferred from an absence.
 */
function proposeScope({
  repairs_text = "",
  paint_level = PAINT.UNKNOWN,
  paint_areas = null,
  cleaning_level = CLEANING.UNKNOWN,
  appliances = [],
  keys_status = KEYS.UNKNOWN,
  keys_note = null,
  inspection_completeness = INSPECTION.PARTIAL,
} = {}) {
  const findings = [];
  const required_work = [];
  const unknowns = [];

  // ── repairs: separate, always ──
  for (const r of interpretRepairs(repairs_text)) {
    findings.push({
      finding: r.finding, evidence: r.evidence, origin: "proposed",
      is_severe: false, long_lead_kind: null,
    });
    required_work.push({
      work: r.work, stage: r.stage,
      disturbs_painted_surfaces: r.disturbs_painted_surfaces,
      from_finding_index: findings.length - 1, origin: "proposed",
    });
  }

  // ── appliances ──
  for (const a of appliances) {
    if (!a || !a.key) continue;
    const cond = APPLIANCE_VALUES.includes(a.condition) ? a.condition : APPLIANCE.UNKNOWN;
    const label = a.label || a.key;
    if (cond === APPLIANCE.UNKNOWN) {
      unknowns.push(`${label} was not checked — its condition is unknown, not working.`);
      continue;
    }
    if (cond === APPLIANCE.WORKING) continue;
    findings.push({
      finding: `${label}: ${APPLIANCE_LABEL[cond]}`, evidence: null, origin: "proposed",
      is_severe: false, long_lead_kind: null,
    });
    for (const w of workForAppliance(a.key, label, cond)) {
      required_work.push({ ...w, from_finding_index: findings.length - 1, origin: "proposed" });
    }
  }

  // ── paint ──
  if (paint_level === PAINT.UNKNOWN) {
    unknowns.push("Paint level is unknown — the paint scope has not been established.");
  } else {
    for (const w of workForPaint(paint_level, paint_areas)) {
      required_work.push({ ...w, disturbs_painted_surfaces: null, origin: "proposed" });
    }
  }

  // ── cleaning ──
  //  Plain deep cleaning is NORMAL TURN WORK. It is not severe, it is not
  //  long-lead, and it must not raise a manager decision on its own. Nothing
  //  in this function marks any cleaning level as severe.
  if (cleaning_level === CLEANING.UNKNOWN) {
    unknowns.push("Cleaning level is unknown — the cleaning scope has not been established.");
  } else {
    for (const w of workForCleaning(cleaning_level)) {
      required_work.push({ ...w, disturbs_painted_surfaces: null, origin: "proposed" });
    }
  }

  // ── keys and access ──
  //  Recorded as a fact about keys. NOT a resident charge, NOT a legal
  //  conclusion, NOT a lock-change instruction — those are separate decisions
  //  with their own owners and none of them belong to a scope capture.
  if (keys_status === KEYS.UNKNOWN) {
    unknowns.push("Keys and access devices were not checked.");
  } else if (keys_status === KEYS.ITEMS_MISSING) {
    findings.push({
      finding: keys_note && String(keys_note).trim()
        ? `Keys or access devices missing: ${String(keys_note).trim()}`
        : "Keys or access devices missing",
      evidence: keys_note || null, origin: "proposed", is_severe: false, long_lead_kind: null,
    });
    unknowns.push("A missing key is recorded as a fact only — no resident charge, lock decision, or legal conclusion is implied.");
  }

  // ── inspection completeness ──
  if (inspection_completeness !== INSPECTION.COMPLETE) {
    unknowns.push("This is a PARTIAL inspection. Areas not inspected remain unknown, and final readiness cannot be reached.");
  }

  return {
    paint_level, paint_areas: paint_level === PAINT.PARTIAL ? paint_areas : null,
    cleaning_level, keys_status, keys_note, inspection_completeness,
    findings, required_work, unknowns,
    labels: {
      paint: PAINT_LABEL[paint_level], cleaning: CLEANING_LABEL[cleaning_level],
      keys: KEYS_LABEL[keys_status], inspection: INSPECTION_LABEL[inspection_completeness],
    },
    interpreted_from: repairs_text,
  };
}

module.exports = {
  proposeScope, interpretRepairs, splitRepairClauses, disturbsPaintedSurfaces,
  workForPaint, workForCleaning, workForAppliance,
  PAINT, CLEANING, KEYS, APPLIANCE, INSPECTION,
  PAINT_VALUES, CLEANING_VALUES, KEYS_VALUES, APPLIANCE_VALUES, INSPECTION_VALUES,
  PAINT_LABEL, CLEANING_LABEL, KEYS_LABEL, APPLIANCE_LABEL, INSPECTION_LABEL,
  STANDARD_APPLIANCES,
};
