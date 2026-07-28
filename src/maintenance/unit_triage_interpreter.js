// ════════════════════════════════════════════════════════════════════
//  unit_triage_interpreter.js — WHAT A FIRST WALK SAID, STRUCTURED.
//
//  Class 1, permanent product primitive. PURE: no database, no I/O, no
//  writes, no clock, no randomness. Same shape and same reason as
//  tour_outcome.js and relationship_stage.js — one definition so four
//  surfaces cannot invent four slightly different answers.
//
//  ── WHAT THIS IS ─────────────────────────────────────────────────────
//  It turns one natural-language observation into a PROPOSAL. A proposal
//  is not truth. Nothing here writes, and nothing downstream may treat
//  this output as confirmed. The staff member who stood in the unit
//  confirms it, once, and THAT is what becomes durable.
//
//  ── WHAT THIS IS NOT ─────────────────────────────────────────────────
//  It is not a classifier that decides. tour_outcome.js states the rule
//  this file inherits verbatim:
//
//      "It may prepare, propose, and pre-stage everything around this
//       answer, and it may never supply the answer itself."
//
//  ── WHY IT REFUSES SO OFTEN ──────────────────────────────────────────
//  GET /maintenance/preview-category was DELETED (maintenance.js) because
//  a preview promised what the save would not do: an operator previewed
//  "tenant billback", pressed save, and got an ordinary resident repair.
//  That defect is the reason this file exists in this shape. A proposal
//  that over-reaches is worse than no proposal, because the operator is
//  now confirming something they did not say.
//
//  So the bias is severe and deliberate: WHEN IN DOUBT, PROPOSE UNCERTAIN.
//  An operator adding a missed item costs one tap. An operator failing to
//  notice an invented item costs a wrong durable fact with their name on it.
//
//  ── WHAT IT MAY NEVER PROPOSE ────────────────────────────────────────
//  resident-caused damage · legal surrender, eviction or squatter status
//  · cost · vendor · completion date · that the inspection was complete ·
//  that no other work exists · that the unit will be ready when the
//  listed items are done · that the unit is ready, ever.
//
//  `ready` is not in this file's vocabulary. Grep it: the string does not
//  appear as a proposable value anywhere below. A first walk cannot
//  establish readiness, so this resolver cannot express it.
// ════════════════════════════════════════════════════════════════════

"use strict";

// ── VOCABULARIES (closed; the DB mirrors these as CHECK constraints) ──

const VACANCY = Object.freeze({
  VACANT: "vacant",
  SOMEONE_REMAINS: "occupied_or_someone_remains",
  UNCERTAIN: "uncertain",
});

const CONDITION = Object.freeze({
  NORMAL_TURN: "normal_turn",
  SEVERE: "severe",
  UNCERTAIN: "uncertain",
});

const COMPLETENESS = Object.freeze({
  INITIAL_TRIAGE: "initial_triage",
  COMPLETE_INSPECTION: "complete_inspection",
});

// Long-lead kinds: things that plausibly CONTROL THE SCHEDULE. The operator
// is never asked for a duration — only whether the thing is of a kind that
// tends to need ordering, a specialist, or an uncertain cure time.
const LONG_LEAD = Object.freeze({
  APPLIANCE: "appliance_replacement",
  HVAC: "hvac_failure",
  PEST: "pest_treatment",
  ACCESS: "access_or_possession_problem",
  CLEANUP: "major_cleanup",
  MAJOR_REPAIR: "major_repair",
});

const VACANCY_VALUES = Object.freeze(Object.values(VACANCY));
const CONDITION_VALUES = Object.freeze(Object.values(CONDITION));
const COMPLETENESS_VALUES = Object.freeze(Object.values(COMPLETENESS));
const LONG_LEAD_VALUES = Object.freeze(Object.values(LONG_LEAD));

// ── PHRASE TABLE ─────────────────────────────────────────────────────
//  Each entry is one recognizable physical condition. Deliberately narrow:
//  a phrase earns a row only when the words carry the condition on their
//  own, without context. "Damage" alone does not qualify — damage by whom,
//  how bad, and whether it blocks anything are all things the sentence did
//  not say.
//
//  finding        the plain sentence proposed back to the operator
//  work           the required-work claim, when the finding clearly implies one
//  severe         does this alone make the turn abnormal
//  long_lead      schedule-controlling kind, when it clearly is one
//
//  `work: null` means the finding is real but what to DO about it is not
//  established by the words. That is a legitimate and common outcome — the
//  contract separates a finding from the work that answers it precisely so
//  this case has somewhere honest to land.
const PHRASES = [
  // ── infestation ────────────────────────────────────────────────────
  //  NOTE ON PLURALS — a real defect caught before this shipped. The first
  //  draft read /\b(cockroach|roaches|roach)\b/ and did NOT match the single
  //  most likely word an operator types: "cockroaches". `cockroach` is
  //  followed by `e`, so the trailing \b fails; `roaches` is preceded by `k`,
  //  so the leading \b fails. The infestation finding vanished silently while
  //  the rest of the sentence interpreted fine — a partial proposal reads as a
  //  complete one, which is the exact failure mode this file is built against.
  //  Every pattern below now carries its own plural.
  { re: /\bcockroach(es)?\b|\broach(es)?\b/i,    finding: "Cockroach infestation observed",       work: "Treat infestation",                 severe: true,  long_lead: LONG_LEAD.PEST },
  { re: /\bbed ?bug(s)?\b/i,                     finding: "Bed bug infestation observed",         work: "Treat infestation",                 severe: true,  long_lead: LONG_LEAD.PEST },
  { re: /\b(mice|mouse|rat(s)?|rodent(s)?)\b/i,  finding: "Rodent activity observed",             work: "Treat infestation",                 severe: true,  long_lead: LONG_LEAD.PEST },
  { re: /\b(infestation|infested|vermin)\b/i,    finding: "Infestation observed",                 work: "Treat infestation",                 severe: true,  long_lead: LONG_LEAD.PEST },
  { re: /\b(flea(s)?|termite(s)?|ant(s)?)\b/i,   finding: "Infestation observed",                 work: "Treat infestation",                 severe: true,  long_lead: LONG_LEAD.PEST },

  // ── cleaning ───────────────────────────────────────────────────────
  //  A deep clean is severe; an ordinary clean is the normal turn.
  //  Deep clean is long-lead (it needs a crew scheduled) but NOT severe on its
  //  own. The contract defines severe as a condition that "prevents the normal
  //  turn from starting" — a deep clean IS the normal turn at many properties.
  //  Scenario 2 still reads severe, correctly, via the infestation beside it.
  //  ⚠ OPERATOR-DISCOVERY QUESTION: whether a deep clean is severe is exactly
  //  the kind of thing that changes property by property. This line is where
  //  that answer lands.
  { re: /\bdeep clean(ing)?\b/i,                 finding: "Deep cleaning required",               work: "Deep clean unit",                   severe: false, long_lead: LONG_LEAD.CLEANUP },
  { re: /\b(filthy|disgusting|biohazard|feces|urine|sewage|rotting|maggots)\b/i,
                                                 finding: "Extreme sanitation condition observed", work: "Deep clean unit",                  severe: true,  long_lead: LONG_LEAD.CLEANUP },
  { re: /\b(needs? (a )?clean(ing)?|cleaning is needed|not clean)\b/i,
                                                 finding: "Cleaning required",                    work: "Clean unit",                        severe: false, long_lead: null },

  // ── contents left behind ───────────────────────────────────────────
  { re: /\b(hoard(er|ing)?)\b/i,                 finding: "Hoarding condition observed",          work: "Remove abandoned contents",         severe: true,  long_lead: LONG_LEAD.CLEANUP },
  { re: /\b(full of (stuff|junk|trash|belongings)|junk everywhere|piled)\b/i,
                                                 finding: "Substantial contents left behind",     work: "Remove abandoned contents",         severe: true,  long_lead: LONG_LEAD.CLEANUP },
  { re: /\b(abandoned (belongings|property|contents|furniture)|left (all )?(their )?(stuff|belongings|furniture))\b/i,
                                                 finding: "Belongings left in the unit",          work: null,                                severe: true,  long_lead: null },
  { re: /\b(trash|garbage|debris)\b/i,           finding: "Trash or debris left in the unit",     work: "Remove trash and debris",           severe: false, long_lead: null },

  // ── appliances ─────────────────────────────────────────────────────
  { re: /\b(refrigerator|fridge)\b[^.!?]{0,40}\b(missing|gone|removed|taken|stolen)\b/i,
                                                 finding: "Refrigerator missing",                 work: "Source and install refrigerator",   severe: false, long_lead: LONG_LEAD.APPLIANCE },
  { re: /\b(missing|gone|removed|taken|stolen|no)\b[^.!?]{0,40}\b(refrigerator|fridge)\b/i,
                                                 finding: "Refrigerator missing",                 work: "Source and install refrigerator",   severe: false, long_lead: LONG_LEAD.APPLIANCE },
  { re: /\b(stove|range|oven|dishwasher|microwave|washer|dryer)\b[^.!?]{0,40}\b(missing|gone|removed|taken|stolen|broken|not working|doesn'?t work|dead)\b/i,
                                                 finding: "Appliance missing or not working",     work: "Repair or replace appliance",       severe: false, long_lead: LONG_LEAD.APPLIANCE },
  { re: /\b(missing|gone|removed|broken|no)\b[^.!?]{0,40}\b(stove|range|oven|dishwasher|microwave|washer|dryer)\b/i,
                                                 finding: "Appliance missing or not working",     work: "Repair or replace appliance",       severe: false, long_lead: LONG_LEAD.APPLIANCE },

  // ── HVAC ───────────────────────────────────────────────────────────
  { re: /\b(a\/?c|ac|air ?conditioning|hvac|furnace|heat(er|ing)?)\b[^.!?]{0,40}\b(not working|isn'?t working|doesn'?t work|broken|out|dead|down|failed|no)\b/i,
                                                 finding: "HVAC not working",                     work: "Diagnose and repair HVAC",          severe: false, long_lead: LONG_LEAD.HVAC },
  { re: /\b(no|broken|dead)\b[^.!?]{0,30}\b(a\/?c|air ?conditioning|hvac|furnace|heat)\b/i,
                                                 finding: "HVAC not working",                     work: "Diagnose and repair HVAC",          severe: false, long_lead: LONG_LEAD.HVAC },

  // ── water, structure, hazards ──────────────────────────────────────
  { re: /\b(mold|mould)\b/i,                     finding: "Possible mold observed",               work: null,                                severe: true,  long_lead: LONG_LEAD.MAJOR_REPAIR },
  { re: /\b(flood(ed|ing)?|water damage|standing water|burst pipe)\b/i,
                                                 finding: "Water damage observed",                work: null,                                severe: true,  long_lead: LONG_LEAD.MAJOR_REPAIR },
  { re: /\b(fire damage|smoke damage|burned|burnt)\b/i,
                                                 finding: "Fire or smoke damage observed",        work: null,                                severe: true,  long_lead: LONG_LEAD.MAJOR_REPAIR },
  { re: /\b(holes? in the wall|walls? (are )?(destroyed|smashed|kicked in)|destroyed|trashed the place|vandali[sz]ed)\b/i,
                                                 finding: "Major destruction observed",           work: null,                                severe: true,  long_lead: LONG_LEAD.MAJOR_REPAIR },
  { re: /\b(leak(ing|s)?)\b/i,                   finding: "Leak observed",                        work: "Diagnose and repair leak",          severe: false, long_lead: null },

  // ── paint & flooring: ordinary turn work ───────────────────────────
  { re: /\b(needs? (paint|painting)|paint(ing)? (is )?needed|repaint)\b/i,
                                                 finding: "Paint condition requires attention",   work: "Paint unit",                        severe: false, long_lead: null },
  { re: /\b(carpet|flooring|floors?)\b[^.!?]{0,40}\b(ruined|destroyed|replace|shot|stained)\b/i,
                                                 finding: "Flooring condition requires attention", work: null,                               severe: false, long_lead: null },

  // ── access / locks ─────────────────────────────────────────────────
  { re: /\b(couldn'?t get in|can'?t get in|no access|locked out|lock (is )?(changed|broken)|key(s)? (don'?t|didn'?t) work)\b/i,
                                                 finding: "Could not access the unit",            work: null,                                severe: true,  long_lead: LONG_LEAD.ACCESS },
];

// ── OCCUPANCY SIGNALS ────────────────────────────────────────────────
//  Someone being present is a PHYSICAL OBSERVATION. It is never a legal
//  conclusion. The contract is explicit: do not label the person a squatter
//  unless the staff member says so, and even then preserve it as an
//  attributed claim rather than a determination. So the squatter pattern
//  below sets the same vacancy value as any other occupancy signal — it
//  changes nothing about severity or legal state, it only survives verbatim
//  in the operator's own words.
const SOMEONE_REMAINS = [
  /\b(someone|somebody|people|a (guy|man|woman|person)|family)\b[^.!?]{0,40}\b(still )?(living|staying|sleeping|inside|in there|in the unit|occupying)\b/i,
  /\b(still (occupied|lives? there|living there|someone there))\b/i,
  /\b(not vacant|isn'?t vacant|still has (a )?(tenant|resident|occupant))\b/i,
  /\b(squatter|squatting)\b/i,
  /\b(occupied)\b/i,
];

const VACANT_SIGNALS = [
  /\b(is |it'?s |unit is |looks )?(vacant|empty)\b/i,
  /\b(nobody|no one|no-one)\b[^.!?]{0,20}\b(there|inside|home|living)\b/i,
  /\b(moved out|cleared out|all out|keys? (were )?(returned|left|on the counter))\b/i,
];

// Explicit statements that this walk was partial. The DEFAULT is already
// initial_triage, so these exist to catch the operator SAYING it plainly —
// they can never upgrade completeness, only reinforce it.
const PARTIAL_SIGNALS = [
  /\b(only (checked|looked at|saw|got (in)?to))\b/i,
  /\b(didn'?t (check|look at|get (in)?to|see))\b/i,
  /\b(just (the|a) (kitchen|bathroom|bedroom|living room))\b/i,
  /\b(quick look|glanced|from the (door|hallway))\b/i,
  /\b(haven'?t (checked|looked))\b/i,
];

// The ONLY way completeness becomes complete_inspection through text. Even
// then it is a PROPOSAL the operator must confirm — never applied silently.
const COMPLETE_SIGNALS = [
  /\b(full(y)? inspect(ed|ion)|complete inspection|checked every(thing| room)|went through the whole (unit|place|apartment))\b/i,
];

// A statement of ordinary condition. Note what is NOT here: "fine", "ok",
// "good", "no issues". Those are absence-of-report, not a report of normality,
// and treating them as normal_turn would be the same defect as treating an
// absent turnover row as readiness.
const NORMAL_SIGNALS = [
  /\b(normal (wear|turn)|wear and tear|standard turn|typical turn|regular turn)\b/i,
  /\b(nothing (major|unusual|out of the ordinary))\b/i,
];

const hasAny = (text, list) => list.some((re) => re.test(text));

/**
 * interpretObservation — one observation → one PROPOSAL.
 *
 * @param {string} text  the operator's exact words
 * @returns {object} proposal; every field is a proposal, none is truth
 */
function interpretObservation(text) {
  const raw = typeof text === "string" ? text : "";
  const t = raw.trim();

  // An empty observation proposes nothing. It does NOT propose "normal".
  if (!t) {
    return {
      vacancy: VACANCY.UNCERTAIN,
      initial_condition: CONDITION.UNCERTAIN,
      inspection_completeness: COMPLETENESS.INITIAL_TRIAGE,
      findings: [],
      long_lead_blockers: [],
      required_work: [],
      uncertainties: ["No observation text was provided — nothing can be proposed from it."],
      interpreted_from: raw,
    };
  }

  // ── vacancy ────────────────────────────────────────────────────────
  //  Someone-remains WINS over a vacancy signal. "304 is empty but there's
  //  still somebody in the back bedroom" must never resolve to vacant. The
  //  more consequential reading of a contradictory sentence is the one that
  //  stops the normal turn, because that is the reading a human would want
  //  double-checked.
  const saysSomeoneRemains = hasAny(t, SOMEONE_REMAINS);
  const saysVacant = hasAny(t, VACANT_SIGNALS);
  let vacancy = VACANCY.UNCERTAIN;
  const uncertainties = [];
  if (saysSomeoneRemains) {
    vacancy = VACANCY.SOMEONE_REMAINS;
    if (saysVacant) {
      uncertainties.push(
        "The observation contains both a vacancy statement and an occupancy statement — occupancy was taken as the safer reading. Confirm which is true."
      );
    }
  } else if (saysVacant) {
    vacancy = VACANCY.VACANT;
  } else {
    uncertainties.push("The observation did not state whether the unit is empty — vacancy stays uncertain.");
  }

  // ── findings, work, long-lead ──────────────────────────────────────
  //  Deduplicated by finding sentence: one sentence naming roaches twice is
  //  one infestation, not two. Order follows the phrase table so the
  //  confirmation card is stable across identical inputs.
  const seenFinding = new Set();
  const seenWork = new Set();
  const seenLongLead = new Set();
  const findings = [];
  const required_work = [];
  const long_lead_blockers = [];
  let severeFromFindings = false;

  for (const p of PHRASES) {
    const m = t.match(p.re);
    if (!m) continue;
    if (seenFinding.has(p.finding)) continue;
    seenFinding.add(p.finding);

    findings.push({
      finding: p.finding,
      // The operator sees WHAT IN THEIR SENTENCE produced this. A proposal
      // that cannot show its evidence is a guess wearing a structure.
      evidence: m[0],
      severe: !!p.severe,
      long_lead_kind: p.long_lead || null,
    });

    if (p.severe) severeFromFindings = true;

    if (p.work && !seenWork.has(p.work)) {
      seenWork.add(p.work);
      required_work.push({ work: p.work, from_finding: p.finding });
    }
    if (p.long_lead && !seenLongLead.has(p.long_lead)) {
      seenLongLead.add(p.long_lead);
      long_lead_blockers.push({ kind: p.long_lead, from_finding: p.finding });
    }
  }

  // Someone remaining is an access/possession blocker on its face, and it is
  // severe: the normal turn cannot start around a person.
  if (vacancy === VACANCY.SOMEONE_REMAINS) {
    severeFromFindings = true;
    if (!seenLongLead.has(LONG_LEAD.ACCESS)) {
      seenLongLead.add(LONG_LEAD.ACCESS);
      long_lead_blockers.push({ kind: LONG_LEAD.ACCESS, from_finding: "Someone remains in the unit" });
    }
    if (!seenFinding.has("Someone remains in the unit")) {
      seenFinding.add("Someone remains in the unit");
      findings.push({
        finding: "Someone remains in the unit",
        evidence: (t.match(SOMEONE_REMAINS.find((re) => re.test(t))) || [""])[0],
        severe: true,
        long_lead_kind: LONG_LEAD.ACCESS,
        // Carried so no downstream reader can mistake this for a ruling.
        not_a_legal_determination: true,
      });
    }
    uncertainties.push(
      "Someone was reported in the unit. This is an attributed observation, not a determination of tenancy, holdover, or trespass."
    );
  }

  // ── initial condition ──────────────────────────────────────────────
  //  severe wins. normal is claimed ONLY when the operator said something
  //  normal AND nothing severe was found. Silence is uncertain, never normal.
  let initial_condition;
  if (severeFromFindings) {
    initial_condition = CONDITION.SEVERE;
  } else if (hasAny(t, NORMAL_SIGNALS)) {
    initial_condition = CONDITION.NORMAL_TURN;
  } else if (findings.length > 0) {
    // Findings exist but none is severe — that is an ordinary turn shape,
    // but the operator did not SAY it was ordinary, so it is not claimed.
    initial_condition = CONDITION.UNCERTAIN;
    uncertainties.push(
      "Conditions were reported but none reads as severe, and the observation did not describe the turn as normal — severity stays uncertain."
    );
  } else {
    initial_condition = CONDITION.UNCERTAIN;
    uncertainties.push("No physical condition was recognized in the observation — severity stays uncertain.");
  }

  // ── inspection completeness ────────────────────────────────────────
  //  Default is initial_triage. A partial signal reinforces it. A complete
  //  signal proposes an upgrade, and loses to any partial signal in the same
  //  sentence — "I fully inspected the kitchen" is partial.
  let inspection_completeness = COMPLETENESS.INITIAL_TRIAGE;
  const saysPartial = hasAny(t, PARTIAL_SIGNALS);
  const saysComplete = hasAny(t, COMPLETE_SIGNALS);
  if (saysComplete && !saysPartial) {
    inspection_completeness = COMPLETENESS.COMPLETE_INSPECTION;
  }
  if (saysPartial) {
    uncertainties.push("The observation describes a partial look — conditions elsewhere in the unit remain unknown.");
  }

  // The standing truth of a first walk, said out loud every time so no
  // reader has to infer it from the absence of a flag.
  if (inspection_completeness === COMPLETENESS.INITIAL_TRIAGE) {
    uncertainties.push(
      "This is initial triage only. Silence about another condition means unknown, not that no other condition exists."
    );
  }

  return {
    vacancy,
    initial_condition,
    inspection_completeness,
    findings,
    long_lead_blockers,
    required_work,
    uncertainties,
    interpreted_from: raw,
  };
}

module.exports = {
  interpretObservation,
  VACANCY, CONDITION, COMPLETENESS, LONG_LEAD,
  VACANCY_VALUES, CONDITION_VALUES, COMPLETENESS_VALUES, LONG_LEAD_VALUES,
};
