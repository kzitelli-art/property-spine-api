"use strict";

// Class 1: shared read/wording contract over agent_facts, not another store.
// Each shelf is approved property-wide wording. Exact-space geometry/media
// mapping is not inferred from prose. Economics remain in their own domains.
const TOPICS = Object.freeze({
  leasing_highlights: "Leasing highlights", amenities: "Amenities",
  layouts: "Layouts", dimensions: "Dimensions", photos: "Photos",
  floor_plans: "Floor plans", virtual_tours: "Virtual tours",
  neighborhood: "Neighborhood", leasing_faq: "Common questions",
  move_in_guidance: "Moving in",
});
const MATCHES = [
  ["leasing_highlights", /\b(highlights?|selling points?|what makes .+ special)\b/i],
  ["amenities", /\b(amenit(?:y|ies)|laundry|furnish(?:ed|ing|ings)|roof deck|courtyard|packages?|balcon(?:y|ies))\b/i],
  ["layouts", /\b(layouts?)\b/i],
  ["dimensions", /\b(dimensions?|measurements?|square feet|square footage|room size)\b/i],
  ["photos", /\b(photos?|pictures?)\b/i],
  ["floor_plans", /\bfloor\s*plans?\b/i],
  ["virtual_tours", /\b(matterports?|materports?|virtual tours?|3d tours?|walkthroughs?)\b/i],
  ["neighborhood", /\b(neighbou?rhood|local recommendations?|nearby (?:coffee|groceries|restaurants?|transit))\b/i],
  ["leasing_faq", /\b(faqs?|common questions|leasing answers)\b/i],
  ["move_in_guidance", /\b(move[- ]in (?:instructions|guidance|directions)|key pickup)\b/i],
];
function topicsFor(question) {
  return MATCHES.filter(([, rx]) => rx.test(String(question || ""))).map(([key]) => key);
}
function isSelfRead(question) {
  const q = String(question || "").trim();
  if (!topicsFor(q).length) return false;
  // A question about evidence for work is still a work turn. Sending to
  // another recipient is not retrieval; neither is changing a policy.
  if (/\b(broken|repair|work order|dispatch|approve|publish|update|replace|delete|retire|change|assign)\b/i.test(q)) return false;
  if (/\b(?:send|text|email|forward|share)\b/i.test(q)) {
    return /^(?:please\s+)?(?:(?:can|could|would|will) you\s+)?(?:please\s+)?(?:send|text|show) me\b/i.test(q)
      && !/\bto\s+|\bfor\s+(?:him|her|them|the prospect|the resident)|@|\b(?:and|then)\b/i.test(q);
  }
  return /^(?:please\s+)?(?:show|find|pull up|what|which|where|how|does|do|is|are|can|tell me)\b/i.test(q)
    || /^(?:matterports?|materports?|floor\s*plans?|amenities|layouts|photos|dimensions)\s*[?.!]*$/i.test(q);
}
function isKnowledgeRead(q) {
  return isSelfRead(q) && !/\b(rent|pricing|prices?|availability|available|occupied|vacant|contracts?|invoices?|debt|loans?|balance|revenue|expenses?|insurance|tax|work order)\b/i.test(q);
}
async function readActive(db, propertyId) {
  if (!propertyId) throw new Error("Leasing knowledge requires a server-derived property scope.");
  return (await db.query(
    `select id, fact_key, category, rendered_text, source_type, source_record_id, confirmed_at,
            effective_until, approved_by_user_id
       from agent_facts
      where property_id=$1 and status='active' and (space_id is null)
        and (effective_until is null or effective_until > now())
      order by fact_key`, [propertyId])).rows;
}
function safeLinks(text) {
  return [...new Set(String(text || "").match(/https:\/\/[^\s<>"\]\)]+/g) || [])]
    .filter(raw => { try { const u = new URL(raw); return u.protocol === "https:" && !u.username && !u.password; } catch (_) { return false; } });
}
async function answer(db, { property_id, allowed_modules, question }) {
  if (!(allowed_modules || []).includes("leasing")) return {
    outcome: "not_authorized", answer: "Leasing knowledge is not available in your current access for this property.",
    grounded_on: null, references: [],
  };
  let rows;
  try { rows = await readActive(db, property_id); }
  catch (e) { return { outcome: "unavailable", answer: "I couldn't read this property's leasing knowledge. Please retry.",
    grounded_on: { leasing_knowledge: e.code === "57014" ? "READ_TIMED_OUT" : "READ_FAILED" }, references: [] }; }
  const keys = topicsFor(question);
  const selected = rows.filter(r => keys.includes(r.fact_key));
  const missing = keys.filter(key => !selected.some(r => r.fact_key === key));
  const parts = selected.map(r => `${TOPICS[r.fact_key]}:\n${r.rendered_text}`);
  if (missing.length) parts.push(`Not established here: ${missing.map(k => TOPICS[k].toLowerCase()).join(", ")}.`);
  return { outcome: selected.length ? "answered" : "not_established",
    answer: parts.join("\n\n") || "No approved leasing knowledge is recorded for that question.",
    grounded_on: { leasing_knowledge: selected.length ? "ESTABLISHED" : "NOT_ESTABLISHED",
      topics: selected.map(r => r.fact_key), missing_topics: missing },
    references: selected.flatMap(r => safeLinks(r.rendered_text).map(url => ({ kind: "leasing_knowledge_link", label: TOPICS[r.fact_key], url }))),
  };
}
module.exports = { TOPICS, topicsFor, isSelfRead, isKnowledgeRead, readActive, safeLinks, answer };
