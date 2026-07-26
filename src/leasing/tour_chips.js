// ════════════════════════════════════════════════════════════════════
//  TOUR CHIPS — "what mattered most", proposed before the agent is asked.
//
//  Class 1, pure. No database, no model call, no I/O. Given what Spine
//  already knows about a person, it proposes up to SIX things that may
//  have mattered on the tour, each carrying its own evidence.
//
//  ── WHY THIS EXISTS ──────────────────────────────────────────────────
//  Design contract §4: "Spine should do the preparation… Capture broadly
//  underneath; ask narrowly on the surface." The agent has four tours
//  back to back and about ten seconds. They should tap two things they
//  recognise, not read a list of twenty generic amenities and translate.
//
//  ── WHY IT MUST BE PRE-COMPUTED ──────────────────────────────────────
//  A ten-second capture cannot wait on a model round trip. Chips are
//  derived when the tour is booked or when it ends, cached, and READ at
//  capture time. This module is the deterministic half of that: it runs
//  in microseconds and needs nothing but rows already in hand.
//
//  ── WHAT THIS IS NOT ─────────────────────────────────────────────────
//  It is not the model-backed extractor. Real transcripts read like
//  "Food around?", "L want a 2bedroom", "Or 36d" — a human reads intent
//  through typos and fragments; patterns do not. This layer catches the
//  signal that is plainly stated and REFUSES to guess at the rest.
//
//  deriveChips() is the seam. A model-backed extractor drops in behind
//  the same shape by contributing higher-strength candidates; nothing
//  downstream changes. Until then, six honest chips beat six invented
//  ones, and FEWER than six is a legitimate answer — padding a list with
//  generics to reach a target is how a personalised prompt turns back
//  into the twenty-item checklist it replaced.
//
//  ── EVERY CHIP CARRIES ITS EVIDENCE ──────────────────────────────────
//  A chip is a PROPOSAL, and a proposal the agent cannot audit is a
//  guess wearing a label. Each one says where it came from and how
//  strongly, so a wrong chip is visibly wrong rather than quietly
//  plausible.
// ════════════════════════════════════════════════════════════════════

//  Strength ranks the evidence, not the topic. A fact the person stated
//  outranks a phrase they used once.
const STRENGTH = Object.freeze({
  STATED_FACT: 3,   // a recorded person_attribute — they told us, we kept it
  ASKED_ABOUT: 2,   // they raised it themselves in conversation
  CONTEXTUAL:  1,   // true of the unit/tour, so it was in front of them
});

//  The families. Patterns are deliberately narrow: a false chip costs an
//  agent a second of confusion and pollutes the record with a preference
//  nobody expressed, which is worse than an absent chip.
const FAMILIES = Object.freeze([
  { key: "price",        label: "Price",
    attrs: ["budget"],
    re: /\b(price|pricing|cost|rent|afford|budget|expensive|cheap|deposit|fee)\b/i },
  { key: "unit_layout",  label: "Unit layout",
    attrs: ["unit_type"],
    re: /\b(studio|1\s?bed|2\s?bed|3\s?bed|one\s?bed|two\s?bed|bedroom|layout|floor\s?plan|sq\s?ft|square feet|size|big|small|space)\b/i },
  { key: "move_timing",  label: "Move timing",
    attrs: ["move_month"],
    re: /\b(move[- ]?in|available|availability|when can i|asap|lease start|month|august|september|october|november|december|january)\b/i },
  { key: "pets",         label: "Pet policy",
    attrs: ["pets"],
    re: /\b(pet|dog|cat|puppy|kitten|breed|esa|emotional support|animal)\b/i },
  { key: "neighborhood", label: "Neighbourhood",
    attrs: [],
    re: /\b(food|restaurant|restaurants|bar|bars|coffee|grocery|groceries|market|nearby|neighborhood|neighbourhood|area|walk(?:able|ing)? distance|around here|whats around|what's around)\b/i },
  { key: "commute",      label: "Commute",
    attrs: [],
    re: /\b(commute|transit|subway|train|bus|drive|driving|blocks away|far|distance|campus|downtown|work)\b/i },
  { key: "parking",      label: "Parking",
    attrs: [],
    re: /\b(parking|garage|park my car|spot|car)\b/i },
  { key: "quiet",        label: "Quiet",
    attrs: [],
    re: /\b(quiet|noise|noisy|loud|street facing|traffic)\b/i },
  { key: "light",        label: "Natural light",
    attrs: [],
    re: /\b(light|bright|sunny|sunlight|window|windows|facing|view)\b/i },
  { key: "laundry",      label: "Laundry",
    attrs: [],
    re: /\b(laundry|washer|dryer|w\/d|in[- ]unit laundry)\b/i },
  { key: "amenities",    label: "Amenities",
    attrs: [],
    re: /\b(gym|fitness|pool|roof|rooftop|lounge|package|amenity|amenities|doorman|elevator)\b/i },
  { key: "furnished",    label: "Furnished",
    attrs: [],
    re: /\b(furnish|furnished|unfurnished|furniture)\b/i },
  { key: "safety",       label: "Safety",
    attrs: [],
    re: /\b(safe|safety|secure|security|camera|cameras|key ?fob|lock)\b/i },
  { key: "community",    label: "People & community",
    attrs: [],
    re: /\b(neighbors|neighbours|community|social|people|roommate|friends)\b/i },
]);

const MAX_CHIPS = 6;

//  FALLBACK — Fable ruling 2026-07-26 §9b.7: "Model failure must not block
//  capture; fall back to a small generic set."
//
//  My first cut returned NOTHING when evidence was thin, on the reasoning
//  that a padded list is worse than a short one. That reasoning holds for
//  PADDING a personalised list — it does not hold for having no list at
//  all. An agent with four tours behind them and an empty screen has to
//  start typing, which is the exact friction this primitive exists to
//  remove.
//
//  So: a short, honestly-labelled generic set. It is marked source
//  'generic' so nothing downstream can mistake it for a signal this
//  person actually gave — the chips still only become facts when tapped.
const GENERIC_FALLBACK = Object.freeze(["price", "unit_layout", "move_timing", "neighborhood"]);

//  THE ESCAPE HATCH — also §9b: "Do not force garbage data… otherwise a
//  rushed operator will tap a random chip simply to finish, and the
//  analytics will become confidently wrong."
//
//  Not a chip. A first-class answer, so "I could not read it" is
//  recordable rather than something the agent has to fake their way past.
const NOTHING_CLEAR = Object.freeze({
  key: "nothing_clear", label: "Nothing clear yet",
  is_escape: true,
  meaning: "the agent could not read a clear signal — recorded as such, never inferred",
});

/**
 * deriveChips — propose what may have mattered.
 *
 *   attributes  [{ attr_key, attr_value }]  what the person told us
 *   inboundText [string]                    THEIR messages only. Ours are
 *                                           excluded deliberately: the agent
 *                                           asking "is quiet important?" is
 *                                           not the prospect caring about it.
 *   unitContext { unit_type, furnished, ... } optional, weakest evidence
 *   limit
 *
 * Returns { chips: [{key,label,strength,source,evidence}], considered, note }
 */
function deriveChips({ attributes = [], inboundText = [], unitContext = null,
                       unitsShown = [], limit = MAX_CHIPS } = {}) {
  const byKey = new Map();

  const offer = (fam, strength, source, evidence) => {
    const prior = byKey.get(fam.key);
    if (prior && prior.strength >= strength) return;
    byKey.set(fam.key, {
      key: fam.key, label: fam.label, strength, source,
      evidence: evidence ? String(evidence).slice(0, 90) : null,
    });
  };

  // 1. STATED FACTS — the strongest thing we have.
  const attrMap = new Map();
  for (const a of attributes || []) {
    if (a && a.attr_key) attrMap.set(String(a.attr_key), a.attr_value);
  }
  for (const fam of FAMILIES) {
    for (const k of fam.attrs) {
      if (attrMap.has(k)) offer(fam, STRENGTH.STATED_FACT, `fact:${k}`, attrMap.get(k));
    }
  }

  // 2. WHAT THEY RAISED THEMSELVES.
  const texts = (inboundText || []).filter(Boolean).map(String);
  for (const fam of FAMILIES) {
    for (const t of texts) {
      const m = fam.re.exec(t);
      if (m) { offer(fam, STRENGTH.ASKED_ABOUT, "asked", t.trim()); break; }
    }
  }

  // 3. CONTEXT — true of what they were shown, so it was in front of them.
  if (unitContext) {
    if (unitContext.unit_type) {
      const fam = FAMILIES.find(f => f.key === "unit_layout");
      offer(fam, STRENGTH.CONTEXTUAL, "unit", String(unitContext.unit_type));
    }
    if (unitContext.furnished === true) {
      const fam = FAMILIES.find(f => f.key === "furnished");
      offer(fam, STRENGTH.CONTEXTUAL, "unit", "furnished unit");
    }
  }

  //  THE ACTUAL UNIT THEY WALKED THROUGH. Fable's example list included
  //  "Unit 304" beside Quiet and Price — because on a multi-unit tour the
  //  thing that mattered is often a specific apartment, not an attribute
  //  of one. An agent who showed 304 and 512 needs to say WHICH landed.
  //
  //  Only offered when more than one unit was shown: with a single unit
  //  there is no choice to record, and a chip with one possible answer is
  //  a question not worth asking in a ten-second capture.
  const units = (unitsShown || []).filter(u => u && (u.unit_number || u.label));
  if (units.length > 1) {
    for (const u of units.slice(0, 3)) {
      const label = String(u.unit_number || u.label);
      const key = `unit:${label}`;
      if (!byKey.has(key)) {
        byKey.set(key, {
          key, label: `Unit ${label}`, strength: STRENGTH.ASKED_ABOUT,
          source: "unit_shown", evidence: `shown on this tour`,
        });
      }
    }
  }

  const all = [...byKey.values()].sort((a, b) =>
    b.strength - a.strength || a.label.localeCompare(b.label));
  let chips = all.slice(0, Math.max(1, limit));

  //  PERSONALISED chips are never padded to reach the limit — a generic
  //  chip sitting among sourced ones is indistinguishable from evidence,
  //  and that is how a proposal layer quietly becomes fake truth.
  //
  //  But an EMPTY screen is its own failure (§9b.7), so when there is
  //  nothing sourced at all we fall back to a short generic set, clearly
  //  marked. Never a mix: either these chips came from this person, or
  //  they plainly did not.
  let personalized = chips.length > 0;
  let note = null;
  if (!personalized) {
    chips = GENERIC_FALLBACK
      .map(k => FAMILIES.find(f => f.key === k))
      .filter(Boolean)
      .map(f => ({ key: f.key, label: f.label, strength: 0,
                   source: "generic", evidence: null }));
    note = "nothing on record for this person — showing a generic set, not a read of them";
  } else if (chips.length < limit) {
    note = `${chips.length} supported by evidence; the rest would be invented`;
  }

  return {
    chips,
    personalized,                 // false = do not present these as "we noticed…"
    escape: NOTHING_CLEAR,        // always offered, never a chip
    considered: all.length,
    note,
  };
}

module.exports = { deriveChips, FAMILIES, STRENGTH, MAX_CHIPS,
                   GENERIC_FALLBACK, NOTHING_CLEAR };
