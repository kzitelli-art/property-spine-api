// ════════════════════════════════════════════════════════════════════
//  draft_source_identity.js — A PENDING MESSAGE IS A PROMISE, NOT HISTORY
//
//  THE DEFECT THIS CLOSES
//  ----------------------
//  A draft is generated from a resolved fact set, reviewed by a human, and
//  then sits in `ready` until someone presses send. Nothing re-checked the
//  economics in between. If a fee was governed, retired or repriced after the
//  review, the draft would still dispatch — quoting terms the property no
//  longer holds, under an approval given for different terms.
//
//  The thread already had exactly this guarantee for CONVERSATION freshness:
//  a newer inbound bumps thread_version and sendDraftService refuses. This is
//  the same shape for ECONOMIC freshness, deliberately built to match.
//
//  ── NO NEW SCHEMA ────────────────────────────────────────────────────
//  agent_runs.resolved_fact_snapshot_json already stores the exact facts the
//  draft was generated from, and agent_drafts.status already carries
//  'superseded' with superseded_at. So the durable transition and the durable
//  source record both exist. This module only reads them and compares.
//
//  ── SOURCE IDENTITY, NOT DISPLAY TEXT ────────────────────────────────
//  Each economic source contributes { type, id, digest }:
//    governed_charge  id = charge_code, digest = the CANONICAL terms digest
//                     (structured material terms — not the sentence, so a
//                     term can change without changing wording and still be
//                     caught).
//    property_fact    id = fact_key, digest = sha256 of the operating text
//                     actually used, which for a prose fact IS the term.
//  Legacy snapshots predate terms_digest; for those the rendered sentence is
//  the only identity available and is used as a documented fallback.
//
//  ── SCOPE, STATED PLAINLY ────────────────────────────────────────────
//  "Economic" means governed charges plus facts in the `pricing` category.
//  A draft is judged against every economic source that was IN CONTEXT when
//  it was generated — not against the subset the text demonstrably quoted,
//  because non-reliance cannot be proven from prose. That is deliberately
//  conservative: it can mark a draft stale that never mentioned money. A
//  draft generated with no economic sources at all is unaffected.
//
//  CLASSIFICATION: Class 1 permanent primitive. Pure — the caller supplies
//  both sides; this module performs no I/O and stores nothing.
// ════════════════════════════════════════════════════════════════════

"use strict";

const crypto = require("crypto");

const sha = (v) => crypto.createHash("sha256").update(typeof v === "string" ? v : JSON.stringify(v))
  .digest("hex").slice(0, 32);

/** Is this resolved-context entry an economic source? */
function isEconomic(f) {
  return f && (f.source === "governed_charge" || f.category === "pricing");
}

/**
 * Reduce a resolved fact array (live context OR a stored snapshot) to a stable,
 * order-independent economic identity set.
 */
function economicSourceIdentity(facts) {
  const list = (Array.isArray(facts) ? facts : []).filter(isEconomic).map((f) => {
    const governed = f.source === "governed_charge";
    return {
      type: governed ? "governed_charge" : "property_fact",
      id: String(f.fact_key || ""),
      // terms_digest is the structured identity. Snapshots written before it
      // existed fall back to the rendered sentence — weaker, and marked so a
      // reader is never misled about which was compared.
      digest: governed && f.terms_digest ? f.terms_digest : sha(String(f.rendered_text || "")),
      identity: governed && f.terms_digest ? "structured_terms" : "rendered_text",
    };
  });
  list.sort((a, b) => (a.type + a.id).localeCompare(b.type + b.id));
  return { sources: list, digest: sha(list.map((x) => `${x.type}:${x.id}:${x.digest}`).join("|")) };
}

/**
 * Compare the economic truth a draft was reviewed against with what is true
 * now. Returns a structured diff plus operator-readable language.
 */
function compareEconomicSources(reviewed, current) {
  const a = economicSourceIdentity(reviewed);
  const b = economicSourceIdentity(current);
  const key = (x) => `${x.type}:${x.id}`;
  const aMap = new Map(a.sources.map((x) => [key(x), x]));
  const bMap = new Map(b.sources.map((x) => [key(x), x]));

  const changed = [], removed = [], added = [];
  for (const [k, x] of aMap) {
    const y = bMap.get(k);
    if (!y) removed.push(x);
    else if (y.digest !== x.digest) changed.push(x);
  }
  for (const [k, y] of bMap) if (!aMap.has(k)) added.push(y);

  return {
    match: a.digest === b.digest,
    reviewed_digest: a.digest,
    current_digest: b.digest,
    changed_ids: changed.map((x) => x.id),
    removed_ids: removed.map((x) => x.id),
    added_ids: added.map((x) => x.id),
    // A draft generated with no economic sources cannot go economically stale.
    had_economic_sources: a.sources.length > 0,
  };
}

/**
 * Plain language for an operator. No hashes, no fact keys, no schema words,
 * no migration terminology — an operator should learn what happened and what
 * to do, not what the column is called.
 */
function staleReasonForOperator(diff) {
  if (!diff || diff.match) return null;
  const kinds = [diff.changed_ids.length, diff.removed_ids.length, diff.added_ids.length];
  const n = kinds[0] + kinds[1] + kinds[2];

  // Subject and verb must agree — an earlier version produced "the fees and
  // charges … was withdrawn" on the real draft, which reads like a bug to the
  // one person who most needs to trust the message.
  let clause;
  if (n > 1) {
    clause = "the fees and charges this message relied on have changed";
  } else if (kinds[0]) {
    clause = "the fee policy this message relied on has changed";
  } else if (kinds[1]) {
    clause = "the fee policy this message relied on has been withdrawn";
  } else {
    clause = "a fee policy now applies that did not when this was written";
  }

  return `This draft is out of date because ${clause} after it was reviewed. ` +
         `It can't be sent. Regenerate it so it reflects the current terms, then review it again.`;
}

module.exports = { economicSourceIdentity, compareEconomicSources, staleReasonForOperator, isEconomic };
