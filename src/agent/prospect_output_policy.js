"use strict";

// Shared deterministic output floor for every prospect-facing AI surface.
// This module owns formatting and unsafe-output detection. Callers still own
// their workflow-specific handoff, audit, and delivery behavior.

const TYPO_RATE = 0;
const TYPO_SWAPS = [
  [/\bdon't\b/g, "dont"], [/\bcan't\b/g, "cant"], [/\bwon't\b/g, "wont"],
  [/\bthat's\b/g, "thats"], [/\bthere's\b/g, "theres"], [/\bwhat's\b/g, "whats"],
  [/\blet's\b/g, "lets"], [/\bdoesn't\b/g, "doesnt"], [/\bisn't\b/g, "isnt"],
  [/\byou're\b/g, "youre"], [/\bthey're\b/g, "theyre"],
];

function stripDashes(text) {
  if (!text) return text;
  let s = String(text);
  const DAY = "(?:Mon|Tues|Wednes|Thurs|Fri|Satur|Sun)day";
  // A numeric or weekday en/em dash is a range from source data, not a pause.
  s = s.replace(/(\d\s*(?:AM|PM)?)\s*[—–]\s*(\$?\d)/gi, "$1 to $2");
  s = s.replace(new RegExp(`(${DAY})\\s*[—–]\\s*(${DAY})`, "gi"), "$1 to $2");
  s = s.replace(/\s+[—–]\s+/g, "... ");
  s = s.replace(/([^\s])[—–]([^\s])/g, "$1, $2");
  s = s.replace(/[—–]/g, ", ");
  s = s.replace(/,\s*\.\.\./g, "...").replace(/\.\.\.\s*,/g, "...");
  return s.replace(/\s{2,}/g, " ").replace(/\s+([,.])/g, "$1").trim();
}

function stripMarkdown(text) {
  if (!text) return text;
  let s = String(text);
  s = s.replace(/\*\*\*([^*]+)\*\*\*/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*\n]+)\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/(^|\n)\s*[-*•]\s+/g, "$1")
    .replace(/(^|\n)\s*\d+[.)]\s+/g, "$1")
    .replace(/\s+[-•]\s+/g, ", ")
    .replace(/(^|\n)\s*#{1,6}\s*/g, "$1")
    .replace(/\*/g, "")
    .replace(/\s*\n+\s*/g, " ")
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([,.;:!?])/g, "$1")
    .replace(/,\s*,/g, ",")
    .trim();
  return s;
}

function humanizeTypos(text, rng = Math.random) {
  if (!text || rng() >= TYPO_RATE) return text;
  const applicable = TYPO_SWAPS.filter(([re]) => { re.lastIndex = 0; return re.test(text); });
  if (!applicable.length) return text;
  const [re, replacement] = applicable[Math.floor(rng() * applicable.length) % applicable.length];
  let done = false;
  re.lastIndex = 0;
  return String(text).replace(re, match => (done ? match : ((done = true), replacement)));
}

function finishProspectText(text, rng) {
  if (!text) return text;
  return humanizeTypos(stripDashes(stripMarkdown(text)), rng);
}

function postGenerationPolicy(draftText) {
  const t = String(draftText || "").toLowerCase();
  const blockPatterns = [
    [/\b(good|bad|safe|dangerous|rough|sketchy|nice|great) (neighborhood|area|part of town|block|side of town)\b/, "fairhousing:neighborhood_character"],
    [/\b(crime rate|crime is|safe to walk|it'?s safe|is safe|very safe|totally safe|perfectly safe)\b/, "fairhousing:safety_claim"],
    [/\b(perfect for|ideal for|suited for|great for|good for) (families|singles|young professionals|students|christian|jewish|muslim|couples)/, "fairhousing:demographic_steering"],
    [/\b(service animal|emotional support animal|assistance animal|esa)\b[\s\S]{0,240}(\$\s?\d|pet fee|pet rent|pet deposit)/, "fairhousing:esa_fee"],
    [/(\$\s?\d|pet fee|pet rent|pet deposit)[\s\S]{0,240}\b(service animal|emotional support animal|assistance animal|esa)\b/, "fairhousing:esa_fee"],
    [/\b(skews?|mostly|mainly|largely|predominantly|a lot of|lots of|full of) (young|younger|older|students|families|kids|professionals|couples|singles|immigrants|retirees)\b/, "fairhousing:demographic_composition"],
    [/\b((state|city|local|municipal|federal) law|by law|legally (required|obligated|entitled)|(pennsylvania|philadelphia|pittsburgh|new york|nyc|pa|ny) (law|ordinance|code|statute)|rent control|rent stabiliz|your rights under)\b/, "legal:local_law_claim"],
    [/\b(while i work on it|i(?:'ll| will) push|let me verify it|come straight back to you|i(?:'ll| will) (?:flag|file|submit|escalate) (?:it|this))\b/, "workflow:unowned_action_claim"],
  ];
  for (const [re, code] of blockPatterns) if (re.test(t)) return { decision: "blocked", code };
  return { decision: "safe", code: null };
}

const POLICY_FALLBACKS = Object.freeze({
  fairhousing: "I can give you the practical building details we have on file. For the neighborhood, I can point you to current public data so you can make your own call.",
  esa: "An assistance animal isn't a pet, so pet fees and pet rent don't apply. The team handles accommodation requests directly and can walk you through what's needed.",
  legal: "That is specific to local law and the lease, and I don't want to guess. The leasing team can walk you through the exact terms.",
  workflow: "I want to give you a solid answer rather than guess. The leasing team can confirm that detail.",
});

function fallbackForPolicy(code, fallback) {
  if (code === "fairhousing:esa_fee") return POLICY_FALLBACKS.esa;
  if (String(code || "").startsWith("fairhousing:")) return POLICY_FALLBACKS.fairhousing;
  if (String(code || "").startsWith("legal:")) return POLICY_FALLBACKS.legal;
  if (String(code || "").startsWith("workflow:")) return POLICY_FALLBACKS.workflow;
  return String(fallback || "").trim();
}

function guardProspectText(text, fallback, { maxLength = 320 } = {}) {
  const raw = String(text || "").trim();
  const policy = postGenerationPolicy(raw);
  const candidate = policy.decision === "safe" ? raw : fallbackForPolicy(policy.code, fallback);
  let body = finishProspectText(candidate);
  let accepted = !!raw && policy.decision === "safe";
  if (!body || body.length > maxLength) {
    body = finishProspectText(fallbackForPolicy(null, fallback));
    accepted = false;
  }
  return { body, accepted, policyCode: policy.code };
}

module.exports = {
  TYPO_RATE, stripDashes, stripMarkdown, humanizeTypos, finishProspectText,
  postGenerationPolicy, fallbackForPolicy, guardProspectText,
};
