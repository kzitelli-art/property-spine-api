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
    rx: /\b(tours?|touring|showings?|open house|walk[- ]?throughs?|come (?:by|see|look)|see (?:the|it|a) (?:place|unit|apartment|home|space)|schedule (?:a|an)|book (?:a|an)|visit)\b/i,
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
    rx: /\b(office\s+hours?|phone\s+number|call\s+(?:the\s+)?office|how do i (?:reach|contact)|who (?:do i|should i) (?:talk|speak)|email address)\b/i,
  },
  {
    intent: "utilities",
    //  `utilities` and `renters_insurance` are legacy pricing-category keys —
    //  economic, therefore never narrowed away by selection. Naming them here
    //  is still correct: it records that the turn is about them, and it keeps
    //  the intent list honest if either is ever recategorised.
    factKeys: ["utilities", "renters_insurance"],
    categories: [],
    rx: /\b(utilit(?:y|ies)|electric(?:ity)?|gas bill|water bill|trash|sewer|internet|wi-?fi|cable|renters?\s+insurance)\b/i,
  },
  {
    intent: "lease_term",
    factKeys: [],
    categories: [],
    rx: /\b(lease\s+(?:term|length|end|start)|\d{1,2}[- ]month|month[- ]to[- ]month|short[- ]term|sublease|sublet|renew(?:al|ing)?|break the lease|early termination)\b/i,
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
const PRICING_RX =
  /\b(rent|rents|pricing|prices?|priced|cost|costs?|how much|monthly|per month|rate|rates|budget|afford|cheap(?:er|est)?|expensive|under\s*\$?\s*\d|\$\s*\d|\d{3,4}\s*(?:a|per)\s*month|specials?|concessions?|discounts?)\b/i;

const INVENTORY_RX =
  /\b(availab(?:le|ility)|vacan(?:t|cy|cies)|open\s+(?:units?|apartments?)|what\s+do\s+you\s+have|any(?:thing)?\s+(?:available|open|left)|studios?|\d\s*[- ]?\s*(?:br|bed|beds|bedrooms?)|one[- ]bed(?:room)?|two[- ]bed(?:room)?|three[- ]bed(?:room)?|floor\b|unit\s+\d|apartment\s+\d|move[- ]?in\s+(?:date|by|in))\b/i;

/** Fact keys recorded on a lead/person that imply live inventory or pricing. */
const ATTRIBUTE_SIGNALS = Object.freeze({
  pricing: ["budget", "max_rent", "price_ceiling", "target_rent"],
  inventory: ["bedrooms", "bedroom_preference", "unit_preference", "desired_move_in", "move_in_date"],
});

function attributeNames(personAttributes) {
  if (!personAttributes) return [];
  if (Array.isArray(personAttributes)) {
    return personAttributes.map(a => String((a && (a.attribute_key || a.key || a.name)) || "")).filter(Boolean);
  }
  if (typeof personAttributes === "object") return Object.keys(personAttributes);
  return [];
}

/**
 * Decide what context this turn needs.
 *
 * @param {object} input
 * @param {string} input.message            the inbound prospect text
 * @param {object} [input.conversation]     the canonical conversation row
 * @param {object} [input.lead]             the lead/prospect record, if any
 * @param {object|Array} [input.personAttributes] recorded person attributes
 * @param {string} [input.propertyId]       server-derived property scope
 * @returns {{intents:string[], factKeys:string[], categories:string[],
 *            needsPricing:boolean, needsInventory:boolean,
 *            selective:boolean, basis:string, property_id:(string|null)}}
 */
function resolveLeasingContext({ message, conversation, lead, personAttributes, propertyId } = {}) {
  //  Property scope is carried through verbatim so a caller cannot use a
  //  selection built for one property against another. This module never
  //  reads it and never defaults it — §21, the server decides.
  const property_id = propertyId || (conversation && conversation.property_id) || null;
  const text = String(message || "");

  const empty = (basis) => Object.freeze({
    intents: [], factKeys: [], categories: [],
    //  An unreadable turn gets everything, not nothing.
    needsPricing: true, needsInventory: true,
    selective: false, basis, property_id,
  });

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

  const attrs = attributeNames(personAttributes);
  const attrPricing = attrs.some(a => ATTRIBUTE_SIGNALS.pricing.includes(a));
  const attrInventory = attrs.some(a => ATTRIBUTE_SIGNALS.inventory.includes(a));

  const needsPricing = PRICING_RX.test(text) || intents.includes("fees") || attrPricing;
  const needsInventory = INVENTORY_RX.test(text) || attrInventory;

  //  NOTHING MATCHED — not a narrow read, a full one. See the header.
  if (!intents.length && !needsPricing && !needsInventory) return empty("unclassified");

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

module.exports = { resolveLeasingContext, selects, INTENTS, PRICING_RX, INVENTORY_RX };
