// ════════════════════════════════════════════════════════════════════
//  property_resolution_service.js — WHICH PROPERTY IS THIS?
//
//  Build 0 found two fuzzy resolvers running beside the registry with the
//  opposite doctrine to it:
//
//      snapshot_loader.resolveProperty   ┐  select id from properties
//      seed_snapshot.resolveProperty     ┘   where lower(name) like '%x%'
//                                             or lower(address) like '%x%'
//                                        order by created_at limit 1
//
//  registry.js exists because that is not safe: "'SOLO on Chestnut' means
//  both 4125 and 4233; a 4233 loan doc says 'LVL 4125'. Name is not
//  identity… It NEVER guesses — an unmapped string returns unresolved,
//  not a best-match."
//
//  The consequence is not a bad label. Whatever these resolvers return
//  receives an entire rent roll: units, spaces, leases, persons, dated
//  ledger evidence. `order by created_at limit 1` picks the OLDEST match
//  and reports nothing, so a roll landing on the wrong building looks
//  exactly like a roll landing on the right one.
//
//  ── RECOGNITION MAY PROPOSE. AMBIGUITY MAY NOT CHOOSE. ───────────────
//  This module keeps the recognition and removes the choosing:
//
//      canonical_key exact          → resolved      (identity, not a guess)
//      registry alias, resolved     → resolved      (a human taught this)
//      one fuzzy candidate          → PROPOSED, not resolved
//      several fuzzy candidates     → ambiguous, all of them named
//      none                         → unresolved
//
//  A single fuzzy candidate is deliberately NOT resolved. "Only one match
//  today" is a fact about the current row count, not about identity: the
//  4125/4233 collision reads as one match right up until the second
//  building is onboarded, and then it silently starts meaning the other
//  one. The caller passes an explicit property id, or a human links the
//  string through the registry. Both are cheap; a misattributed rent roll
//  is not.
//
//  ── WHY THE NAME CHANGED ─────────────────────────────────────────────
//  This was `resolvePropertyForImport`. The name was scoped to imports;
//  the contract never was. Every branch below answers "which property is
//  this, and am I certain" — a question a demo path, a reset, a preflight
//  and an AUTHORIZATION WALL all ask. A guard routed through a function
//  named "for import" reads as a borrowed convenience rather than the
//  identity contract it is, and the next person moves it.
//
//  `resolveProperty` was not available: snapshot_loader.js and
//  seed_snapshot.js still define local wrappers by that name, and an
//  import colliding with a local function is how the wrong one gets
//  called. `Identity` is also the doctrine — name is not identity.
//
//  CLASSIFICATION: Class 1 permanent primitive.
// ════════════════════════════════════════════════════════════════════

"use strict";

/**
 * @param db     pool or checked-out client
 * @param spec   { canonical_key?, match_tokens?: string[], name_exact? }
 * @returns {
 *   status: 'resolved' | 'proposed' | 'ambiguous' | 'unresolved',
 *   property_id: uuid|null,        // ONLY set when status === 'resolved'
 *   via: 'canonical_key' | 'registry_alias' | 'exact_name' | null,
 *   candidates: [{ property_id, name, canonical_key, matched_on }],
 *   receipt: string                // sayable to a human as-is
 * }
 */
async function resolvePropertyIdentity(db, spec = {}) {
  const { canonical_key = null, match_tokens = [], name_exact = null } = spec;

  // ── 1. canonical key. Identity, not a guess. ──────────────────────
  if (canonical_key) {
    const r = await db.query(
      `select id, name, canonical_key from properties where canonical_key = $1`,
      [canonical_key]);
    if (r.rows.length === 1) {
      return { status: "resolved", property_id: r.rows[0].id, via: "canonical_key",
               candidates: [], receipt: `Resolved by canonical key ${canonical_key}.` };
    }
  }

  // ── 2. the registry. A resolved alias is a human's answer. ────────
  //  Same lookup shape registry.js uses, so the two agree on "same
  //  string" — and deliberately across ALL source systems, because a
  //  string may have been taught under any of them.
  const tokens = (Array.isArray(match_tokens) ? match_tokens : [])
    .map((t) => (t == null ? "" : String(t).trim())).filter(Boolean);

  for (const token of tokens) {
    const r = await db.query(
      `select distinct pa.property_id, p.name, p.canonical_key
         from property_aliases pa
         join properties p on p.id = pa.property_id
        where lower(btrim(pa.alias_value)) = lower(btrim($1))
          and pa.confidence = 'resolved'`, [token]);
    if (r.rows.length === 1) {
      return { status: "resolved", property_id: r.rows[0].property_id, via: "registry_alias",
               candidates: [], receipt: `Resolved by a registered alias for "${token}".` };
    }
    if (r.rows.length > 1) {
      return { status: "ambiguous", property_id: null, via: null,
        candidates: r.rows.map((x) => ({ property_id: x.property_id, name: x.name,
          canonical_key: x.canonical_key, matched_on: `alias "${token}"` })),
        receipt: `"${token}" is registered against ${r.rows.length} properties. ` +
                 `Name the property explicitly.` };
    }
  }

  // ── 3. an exact name, when the caller has one ─────────────────────
  //  Exact is stronger than substring but still not identity: two
  //  buildings may share a name. One row resolves; more than one is
  //  ambiguous rather than "the oldest".
  if (name_exact) {
    const r = await db.query(
      `select id, name, canonical_key from properties where name = $1`, [name_exact]);
    if (r.rows.length === 1) {
      return { status: "resolved", property_id: r.rows[0].id, via: "exact_name",
               candidates: [], receipt: `Resolved by exact name "${name_exact}".` };
    }
    if (r.rows.length > 1) {
      return { status: "ambiguous", property_id: null, via: null,
        candidates: r.rows.map((x) => ({ property_id: x.id, name: x.name,
          canonical_key: x.canonical_key, matched_on: `exact name "${name_exact}"` })),
        receipt: `${r.rows.length} properties are named "${name_exact}". ` +
                 `Name the property explicitly.` };
    }
  }

  // ── 4. recognition. Proposes; never selects. ──────────────────────
  //  No `limit 1`, and no ordering that implies a winner: every match is
  //  returned so the refusal can show the human what it saw.
  const seen = new Map();
  for (const token of tokens) {
    const r = await db.query(
      `select id, name, canonical_key from properties
        where lower(name) like '%'||lower($1)||'%'
           or lower(coalesce(address,'')) like '%'||lower($1)||'%'`, [token]);
    for (const row of r.rows) {
      if (!seen.has(row.id)) {
        seen.set(row.id, { property_id: row.id, name: row.name,
          canonical_key: row.canonical_key, matched_on: `text match on "${token}"` });
      }
    }
  }
  const candidates = [...seen.values()];

  if (candidates.length === 0) {
    return { status: "unresolved", property_id: null, via: null, candidates: [],
      receipt: tokens.length
        ? `Nothing matched ${tokens.map((t) => `"${t}"`).join(", ")}.`
        : "No identity was supplied to resolve against." };
  }

  //  One candidate is a PROPOSAL. See the header: "only one match" is a
  //  fact about today's row count, not about identity.
  return {
    status: candidates.length === 1 ? "proposed" : "ambiguous",
    property_id: null, via: null, candidates,
    receipt: candidates.length === 1
      ? `Recognized "${candidates[0].name}" by text, which is a suggestion rather than ` +
        `identity. Confirm it, or register the identity string, before importing.`
      : `${candidates.length} properties match by text. Name the property explicitly.`,
  };
}

/** The shape every import caller returns when resolution did not resolve. */
function resolutionError(res) {
  return {
    error: res.status === "unresolved" ? "property_not_found" : "property_not_resolved",
    resolution_status: res.status,
    receipt: res.receipt,
    candidates: res.candidates,
    next_step: "Pass an explicit property, or register the identity string in the registry " +
               "(POST /registry/aliases) so it resolves without guessing.",
  };
}

module.exports = { resolvePropertyIdentity, resolutionError };
