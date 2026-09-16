// ════════════════════════════════════════════════════════════════════
//  leasing_context_resolver.js — WHAT KNOWLEDGE DOES THIS QUESTION NEED?
//
//  THE PROBLEM THIS CLOSES
//  -----------------------
//  resolveContext() loaded EVERY active fact for a property and handed the
//  whole shelf to the model on every turn. On the demo Solo shape that is 26
//  facts; a prospect asking "can I bring my dog?" received all 26 and the
//  model was left to find the one that answers the question. More context is
//  not more accuracy — it is more surface for the model to draw an unasked
//  inference from.
//
//  This module decides WHAT TO RETRIEVE. It never decides what is true.
//
//    resolver says:  pricing is required
//    pricing system says:  the actual permitted number
//
//  ── DETERMINISTIC, AND NOT A MODEL CALL ──────────────────────────────
//  Choosing context by asking a model would put a model inside the retrieval
//  path, where a wrong answer is invisible: the turn simply proceeds without
//  the fact that would have answered it. A regex table is dumber and its
//  mistakes are readable, testable and fixable in one line. No embeddings,
//  no vector store, no second LLM round-trip.
//
//  ── IT REUSES THE EXISTING VOCABULARY, IT DOES NOT INVENT ONE ────────
//  Two registries already exist and both are authoritative:
//    leasing_knowledge.topicsFor(q)  → the ten descriptive shelves
//    operator.js FACT_KEYS/CATEGORY_FOR → the governed write vocabulary
//      (pet_policy·pets, parking_rules·parking, tour_window·tours,
//       fee_policy·fees, required_documents·documents,
//       office_contact/communication_instructions·routing)
//  A competing taxonomy here would drift from the keys operators actually
//  write, and the drift would show up as an unanswerable question rather
//  than as an error. So the shelves come from topicsFor verbatim, and this
//  table covers only the seven governed keys topicsFor does not reach.
//
//  ── UNCLASSIFIED MEANS LOAD EVERYTHING ───────────────────────────────
//  The failure this must never produce is a confident narrow read that drops
//  the one fact the turn needed. When nothing matches, `selective` is false
//  and the caller loads the full set exactly as it did before this module
//  existed. Narrowing is an optimisation that must earn each turn; the
//  unnarrowed path stays the floor.
//
//  ── WHAT IT DELIBERATELY DOES NOT NARROW ─────────────────────────────
//  Economic sources — governed charges and any fact in the `pricing`
//  category — are NEVER dropped by selection. That is not an oversight and
//  it is not laziness. `draft_source_identity.compareEconomicSources`
//  guarantees a reviewed draft cannot be sent after its economics moved, and
//  it computes that over the WHOLE economic set, including sources that
//  APPEARED after review (`added_ids`, asserted by
//  tests/proofs/draft_stale_source_proof.js). Narrow the economic set into
//  the snapshot and that comparison starts reporting every draft stale, or —
//  far worse, if the live side were narrowed to match — stops noticing a fee
//  that appeared after a human approved the message. The stale-draft
//  guarantee outranks the size of the prompt. Enforced by the caller through
//  draft_source_identity.isEconomic, so the boundary has exactly one owner.
//
//  CLASSIFICATION: Class 1 permanent primitive. Pure — no I/O, no state, no
//  model call. Removing it restores the previous full-context behaviour.
// ════════════════════════════════════════════════════════════════════

"use strict";

const leasingKnowledge = require("../leasing/leasing_knowledge");

//  The seven governed fact keys that `leasing_knowledge.topicsFor` does not
//  reach, each with the category operator.js writes for it. `factKeys` are
//  matched exactly against agent_facts.fact_key; `categories` catch the
//  legacy rows that carry the category but a different key.
//
//  These regexes answer ONE question — "is this turn about X?" — and are
//  deliberately broad. A false positive costs one extra fact in context. A
//  false negative costs the answer.
//  ── KEYS THIS TABLE NAMES THAT NO OPERATOR CAN WRITE TODAY ──────────
//  operator.js's FACT_KEYS is the governed write vocabulary. These five
//  appear in the live corpus but are not in it — they predate that list.
//  Naming them here is deliberate: a key an operator cannot create is a key
//  that will never be answered, and leaving that implicit is how a silent
//  dead entry survives. `gate` below asserts every key this file names is
//  either writable or declared here, so a TYPO becomes a red test instead of
//  a question nobody ever answers.
const LEGACY_FACT_KEYS = Object.freeze([
  "parking_pricing", "move_in_requirements", "move_in_credits",
  "utilities", "renters_insurance",
]);

const INTENTS = Object.freeze([
  {
    intent: "pets",
    factKeys: ["pet_policy"],
    categories: ["pets"],
    //  Assistance animals are NOT this intent's business — preGenerationPolicy
    //  hard-gates them before any of this runs. Matching them here is still
    //  right: if that gate is ever narrowed, the pet policy is the fact the
    //  turn most needs, not the one it least needs.
    rx: /\b(pets?|dogs?|cats?|puppy|puppies|kitten|kittens|breeds?|animals?|pet[- ](?:rent|fee|deposit|policy)|service animal|emotional support animal|esa)\b/i,
  },
  {
    intent: "parking",
    factKeys: ["parking_rules", "parking_pricing"],
    categories: ["parking"],
    rx: /\b(parking|park(?:ed|ing)?\s+(?:my|a|the)?\s*car|garages?|car\s?ports?|parking\s+spots?|vehicles?|motorcycles?|ev\s+charg(?:er|ing))\b/i,
  },
  {
    intent: "tours",
    factKeys: ["tour_window"],
    categories: ["tours"],
    //  "can i see it saturday" was unclassified until the object after
    //  `see` was made optional and bare day names were admitted. A day name
    //  on its own is nearly always someone proposing a time.
    rx: /\b(tours?|touring|showings?|open house|walk[- ]?throughs?|come (?:by|see|look)|stop by|see (?:it|this|the place|the unit|the apartment|the home)|available to (?:show|see)|schedule (?:a|an)|book (?:a|an)|visit)\b|\b(?:mon|tues|wednes|thurs|fri|satur|sun)day\b/i,
  },
  {
    intent: "fees",
    factKeys: ["fee_policy"],
    categories: ["fees"],
    rx: /\b(fees?|deposits?|admin(?:istration)?\s+fee|application\s+fee|security\s+deposit|move[- ]?in\s+cost|upfront|due at signing|charges?)\b/i,
  },
  {
    intent: "application_requirements",
    factKeys: ["required_documents", "move_in_requirements"],
    categories: ["documents"],
    rx: /\b(appl(?:y|ication|ications|ying)|qualif(?:y|ications?|ied)|screening|credit\s+(?:check|score)|background\s+check|income\s+(?:requirement|proof)|proof\s+of\s+income|pay\s?stubs?|bank\s+statements?|guarantors?|co[- ]?signers?|documents?\s+(?:needed|required|do i need)|what do i need to)\b/i,
  },
  {
    intent: "contact_and_office",
    factKeys: ["office_contact", "communication_instructions"],
    categories: ["routing"],
    rx: /\b(office\s+hours?|where(?:'s|s| is)?\s+(?:the\s+)?office|office\s+(?:location|address)|phone\s+number|call\s+(?:the\s+)?office|how do i (?:reach|contact)|who (?:do i|should i) (?:talk|speak)|email address)\b/i,
  },
  {
    intent: "utilities",
    //  Legacy pricing-category keys — economic, therefore never narrowed away
    //  by selection anyway. Naming them is still right: it records what the
    //  turn is about, and keeps the list honest if either is recategorised.
    //  Renters insurance is its own intent: bundling it here put it on the
    //  selected list for "is wifi included", which is simply not what was asked.
    factKeys: ["utilities"],
    categories: [],
    rx: /\b(utilit(?:y|ies)|electric(?:ity)?|gas bill|water bill|trash|sewer|internet|wi-?fi|cable)\b/i,
  },
  {
    intent: "renters_insurance",
    factKeys: ["renters_insurance"],
    categories: [],
    rx: /\brenters?\s+insurance\b|\bproof of insurance\b/i,
  },
  {
    intent: "lease_term",
    factKeys: [],
    categories: [],
    //  `sublet` inside \b…\b did not match "subletting"; "how long is the
    //  lease" put the noun last and matched nothing at all.
    rx: /\b(lease\s+(?:term|length|end|start)|how long\s+(?:is|are)\s+(?:the\s+)?leases?|\d{1,2}[- ]month|month[- ]to[- ]month|short[- ]term|sublease\w*|sublet\w*|renew\w*|break the lease|early termination)\b/i,
  },
  {
    intent: "move_in_timing",
    factKeys: ["move_in_guidance", "move_in_requirements", "move_in_credits"],
    categories: [],
    rx: /\b(move[- ]?in|moving in|move\s+(?:by|on|the)|key\s+pickup|when can i (?:move|get in)|available\s+(?:by|on|in)\s+\w+)\b/i,
  },
]);

//  Two capability flags, separate from fact selection because they route to
//  different canonical owners. Both are deliberately eager: a question that
//  merely smells economic gets the governed pricing read, because the cost of
//  reading it and not needing it is a query, and the cost of needing it and
//  not reading it is the model improvising a number.
//  ── A TRAILING \b AFTER \d IS A TRAP, AND IT BIT THIS FILE ──────────
//  The first version put the money patterns inside one \b(…)\b wrapper.
//  `\b` after `\d` requires a NON-word character next, so "under $2,500"
//  matched (comma) and "under 2000" did not (another digit). The Example 3
//  test passed on the comma and the plain-number case would have shipped
//  silently: a prospect stating a budget would have had governed pricing
//  skipped and been told the team would confirm. Amounts are now their own
//  alternatives with no trailing boundary.
const PRICING_RX = new RegExp([
  String.raw`\b(rent|rents|pricing|prices?|priced|cost|costs?|how much|monthly|per month|rate|rates|budget|afford|cheap(?:er|est)?|expensive|specials?|concessions?|discounts?)\b`,
  String.raw`\$\s*\d`,
  String.raw`\b(?:under|below|max(?:imum)?|up to|no more than|around|about)\s*\$?\s*\d`,
  String.raw`\d{3,5}\s*(?:\/|a |per )?\s*(?:mo\b|month)`,
].join("|"), "i");

//  `floor` alone matched "what floor is it on", which is not an availability
//  question and collides with the floor_plans shelf. Narrowed to an actual
//  floor reference.
const INVENTORY_RX =
  /\b(availab(?:le|ility)|vacan(?:t|cy|cies)|open\s+(?:units?|apartments?)|what\s+do\s+you\s+have|any(?:thing)?\s+(?:available|open|left)|studios?|\d\s*[- ]?\s*(?:br|bed|beds|bedrooms?)|one[- ]bed(?:room)?|two[- ]bed(?:room)?|three[- ]bed(?:room)?|\d(?:st|nd|rd|th)\s+floor|floor\s+\d|unit\s+\d|apartment\s+\d|move[- ]?in\s+(?:date|by|in))\b/i;

//  ── THE REAL VOCABULARY, READ OUT OF THE SCHEMA ─────────────────────
//  An earlier version of this file guessed these names from an example
//  prompt — budget, max_rent, price_ceiling, target_rent, bedrooms,
//  bedroom_preference, unit_preference, desired_move_in, move_in_date. The
//  `person_attributes` table constrains attr_key with a CHECK to exactly
//  six values, and only ONE of those nine guesses was among them. Eight
//  names matched nothing and would have silently recorded a prospect as
//  having told Spine nothing at all.
//
//    move_month · budget · unit_type · occupants · pets · reason
//
//  The column is `attr_key`, not `attribute_key`. The canonical read is
//  leasing_inventory.readProspectFacts, which resolves person-level against
//  property-level rows and carries source and recorded_at on every value.
const ATTR_KEYS = Object.freeze(["move_month", "budget", "unit_type", "occupants", "pets", "reason"]);

//  Which recorded facts bear on which kind of turn. A turn that is ABOUT
//  pets should carry the recorded pet fact; a turn refining a search should
//  carry the search terms the prospect already gave.
const ATTR_RELEVANCE = Object.freeze({
  search: ["unit_type", "move_month", "budget", "occupants"],
  pets:   ["pets"],
});

//  ── AN ELLIPTICAL FOLLOW-UP ─────────────────────────────────────────
//  "What about furnished?" carries no subject of its own; it only makes
//  sense against what was already established. That is the one shape where
//  the whole recorded set must travel forward, because the prospect is
//  explicitly relying on not having to repeat themselves.
const FOLLOW_UP_RX =
  /^\s*(?:and\b|also\b|what about\b|how about\b|what if\b|any\b.{0,20}\?|ok(?:ay)?[, ]|is it\b|are they\b|does it\b|do they\b)/i;

/**
 * Normalise whatever the caller has into { key: {value, source, recorded_at} }.
 * Accepts readProspectFacts' `facts` map, a plain key/value object, or a row
 * array — so a future caller with a different shape is not silently ignored.
 */
function normaliseAttributes(personAttributes) {
  const out = {};
  if (!personAttributes || typeof personAttributes !== "object") return out;
  for (const [rawKey, raw] of Object.entries(personAttributes)) {
    const key = String((raw && typeof raw === "object" && raw.key) || rawKey || "");
    //  Never carry a key the schema cannot hold. This is the guard that
    //  would have caught the nine guessed names.
    if (!ATTR_KEYS.includes(key)) continue;
    const box = raw && typeof raw === "object" ? raw : { value: raw };
    const value = box.value == null ? "" : String(box.value);
    if (!value.trim()) continue;              //  a blank is not a recorded preference
    out[key] = { value, source: box.source || null, recorded_at: box.recorded_at || null };
  }
  return out;
}

//  ── WHICH RECORDED FACTS BEAR ON THIS TURN ──────────────────────────
//  Deterministic, and deliberately narrow in both directions.
//
//  Carry everything when the turn is elliptical — "what about furnished?"
//  has no subject of its own and is only answerable against what was already
//  established, which is the whole point of having recorded it.
//
//  Carry the search terms when THIS turn is a search, because a budget and a
//  bedroom count refine it. Carry the recorded pet fact when the turn is
//  about pets.
//
//  Carry NOTHING otherwise. A prospect who mentioned a budget once has not
//  asked about money forever; dragging their whole profile into an unrelated
//  question is how a recorded preference turns into a wrong answer.
function establishedFor(recorded, { text, intents, needsPricing, needsInventory }) {
  const keys = Object.keys(recorded);
  if (!keys.length) return {};
  const wanted = new Set();
  if (FOLLOW_UP_RX.test(text)) for (const k of keys) wanted.add(k);
  if (needsPricing || needsInventory) for (const k of ATTR_RELEVANCE.search) wanted.add(k);
  if (intents.includes("pets")) for (const k of ATTR_RELEVANCE.pets) wanted.add(k);
  const out = {};
  for (const k of keys) if (wanted.has(k)) out[k] = recorded[k];
  return out;
}

//  ── ONE SWITCH THAT DOES NOT NEED A DEPLOY ──────────────────────────
//  This changes what a real prospect is told, and deploys here are manual.
//  If narrowing ever drops a fact a turn needed, the fix must not wait on a
//  build: set LEASING_CONTEXT_RESOLVER=off in the environment and every turn
//  reverts to the full-context behaviour that predates this module, with no
//  code change and nothing else altered. Read per call rather than cached at
//  module load, so flipping it takes effect on the next turn.
function narrowingDisabled() {
  return String(process.env.LEASING_CONTEXT_RESOLVER || "").trim().toLowerCase() === "off";
}

function resolveLeasingContext({ message, conversation, lead, personAttributes, propertyId,
                                 attributesReadFailed = false } = {}) {
  //  Property scope is carried through verbatim so a caller cannot use a
  //  selection built for one property against another. This module never
  //  reads it and never defaults it — §21, the server decides.
  const property_id = propertyId || (conversation && conversation.property_id) || null;
  const text = String(message || "");

  const empty = (basis) => Object.freeze({
    intents: [], factKeys: [], categories: [],
    //  An unreadable turn gets everything, not nothing.
    needsPricing: true, needsInventory: true,
    //  ...but not the prospect's recorded profile. A greeting is not a
    //  follow-up, and an unclassified turn is the one place we are least
    //  entitled to assume which established fact it leans on.
    established: {}, established_read_failed: !!attributesReadFailed,
    selective: false, basis, property_id,
  });

  //  The kill switch returns the SAME shape as any unclassified turn, so no
  //  caller needs to know it exists — `selective:false` already means "load
  //  everything", and `basis` records why.
  if (narrowingDisabled()) return empty("disabled_by_env");

  if (!text.trim()) return empty("no_message");

  const intents = [];
  const factKeys = new Set();
  const categories = new Set();

  for (const spec of INTENTS) {
    if (!spec.rx.test(text)) continue;
    intents.push(spec.intent);
    for (const k of spec.factKeys) factKeys.add(k);
    for (const c of spec.categories) categories.add(c);
  }

  //  The ten descriptive shelves come from the existing registry verbatim.
  //  Every shelf carries category `leasing_knowledge`, and the key IS the
  //  shelf, so adding the keys is sufficient.
  const shelves = leasingKnowledge.topicsFor(text);
  for (const key of shelves) {
    factKeys.add(key);
    if (!intents.includes(`knowledge:${key}`)) intents.push(`knowledge:${key}`);
  }

  //  ── WHAT IS RECORDED NEVER DECIDES WHAT IS ASKED ─────────────────
  //  An earlier version let a stored budget set needsPricing outright, so a
  //  prospect who once mentioned $2,500 would turn a question about package
  //  handling into a governed pricing search forever after. A recorded
  //  preference is CONTEXT for a question that depends on it — never a
  //  standing instruction that every later turn is about money.
  //
  //  So the two capability flags are decided by THIS turn's words alone.
  const recorded = normaliseAttributes(personAttributes);
  const needsPricing = PRICING_RX.test(text) || intents.includes("fees");
  const needsInventory = INVENTORY_RX.test(text);

  //  NOTHING MATCHED — not a narrow read, a full one. See the header.
  if (!intents.length && !needsPricing && !needsInventory) return empty("unclassified");

  //  ── AN INTENT THAT NAMES NO SHELF IS NOT A NARROW READ ────────────
  //  `lease_term` recognises "how long is the lease" but no agent_facts
  //  shelf holds that answer — it lives in the lease and the operating
  //  rules. Left as-is this returned selective:true with an EMPTY factKeys
  //  list, which handed the model zero curated facts and told it nothing on
  //  file answers the question. That is a confident narrow read to nothing,
  //  the exact failure the header of this file warns about, and it was
  //  introduced by widening the lease-term pattern. Selectivity is decided
  //  by whether any shelf was actually selected, never by whether a pattern
  //  fired.
  if (intents.length && !factKeys.size && !categories.size) {
    return Object.freeze({
      intents, factKeys: [], categories: [],
      needsPricing, needsInventory,
      established: establishedFor(recorded, { text, intents, needsPricing, needsInventory }),
      established_read_failed: !!attributesReadFailed,
      selective: false, basis: "intent_without_shelf",
      property_id,
    });
  }

  //  Matched only on pricing/inventory with no curated topic (Example 3,
  //  "I need a 2BR in August under $2,500"): the answer lives in governed
  //  pricing and inventory, not on a knowledge shelf. Selecting zero facts
  //  would be right, but it would also mean a single stray word decides the
  //  whole shelf is irrelevant — so this stays unnarrowed on the fact side
  //  and narrow on nothing else. The governed paths answer it either way.
  if (!intents.length) {
    return Object.freeze({
      intents: [], factKeys: [], categories: [],
      needsPricing, needsInventory,
      established: establishedFor(recorded, { text, intents: [], needsPricing, needsInventory }),
      established_read_failed: !!attributesReadFailed,
      selective: false, basis: "economic_only",
      property_id,
    });
  }

  return Object.freeze({
    intents,
    factKeys: [...factKeys].sort(),
    categories: [...categories].sort(),
    needsPricing,
    needsInventory,
    established: establishedFor(recorded, { text, intents, needsPricing, needsInventory }),
    established_read_failed: !!attributesReadFailed,
    selective: true,
    basis: "matched",
    property_id,
  });
}

/**
 * Does this resolved-context fact belong in the model's context for a turn?
 *
 * Economic sources are the caller's business, not this predicate's — the
 * caller keeps them unconditionally via draft_source_identity.isEconomic
 * BEFORE consulting this. See the header for why that boundary exists.
 */
function selects(selection, fact) {
  if (!selection || !selection.selective) return true;
  if (!fact) return false;
  const key = String(fact.fact_key || "");
  const category = String(fact.category || "");
  return selection.factKeys.includes(key) || selection.categories.includes(category);
}

module.exports = { resolveLeasingContext, selects, narrowingDisabled, normaliseAttributes,
                   INTENTS, LEGACY_FACT_KEYS, ATTR_KEYS, ATTR_RELEVANCE, FOLLOW_UP_RX,
                   PRICING_RX, INVENTORY_RX };
