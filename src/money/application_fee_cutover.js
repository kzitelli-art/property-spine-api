// ════════════════════════════════════════════════════════════════════
//  application_fee_cutover.js — THIN COMPATIBILITY ADAPTER (Class 2)
//
//  This file used to be the business implementation: its own terms digest, its
//  own publication rule, its own cutover transaction, its own ownership proof —
//  all with charge_code and the legacy fact key pinned as module constants. A
//  second governed term could not reuse any of it, so governing one would have
//  meant copying the file. Two cutover implementations are two copies that must
//  agree, which is the disease the governed catalog exists to cure.
//
//  Everything below now delegates to src/money/governed_charge_cutover.js.
//  THIS MODULE CONTAINS NO BUSINESS RULES. It supplies exactly two facts:
//
//      charge_code           fee.application
//      declared legacy owner pricing_application_fee   (from SUPERSEDES)
//
//  It exists only so the three deployed routes in operator.js keep their URLs
//  and response shapes while the generalized service becomes the single
//  implementation.
//
//  ── WHAT MOVED, AND WHAT CHANGED WITH IT ─────────────────────────────
//  Three behaviours are strictly STRONGER in the generalized service. None of
//  them alters the $50's meaning, and each is declared rather than discovered:
//
//   1. approveAndPublish now re-runs checkChargePublishable before flipping
//      draft -> active. The old module ran the publication contract only at
//      INSERT time in publishCharge, so a draft edited after creation reached
//      publication unchecked. No draft exists for fee.application, so this
//      changes nothing observable here.
//   2. termsDigest covers every material term. The old digest ignored
//      effective_from, effective_until, condition_key, applicability_scope,
//      unit_type_id, waivable, waiver_authority_verb, amount_unresolved_reason
//      and charge_code, so a sheet could be approved, its effective date
//      moved, then published wearing the old approval. Widening changes the
//      hash — safe here because no stored digest is ever re-verified after
//      publication (approveAndPublish is the only reader and it only runs
//      against drafts, of which fee.application has none).
//   3. oneSourceProof additionally scans for unrecorded live claimants. It
//      cannot upgrade the verdict, only degrade it. `one_canonical_truth` is
//      preserved for exactly the state it has always meant.
//
//  ── DELIBERATELY NOT RE-EXPORTED ─────────────────────────────────────
//  recordRuling. It exists in the generalized service but no application-fee
//  route uses it, and exporting it here would invite a caller to record a
//  ruling through a per-fee door.
//
//  CLASSIFICATION: Class 2 — temporary compatibility adapter.
//  REMOVAL CONDITION: delete this file once operator.js calls
//  governed_charge_cutover.js directly with charge_code: "fee.application".
//  That is a route change, deliberately not bundled into the consolidation
//  slice so the two are independently revertible.
// ════════════════════════════════════════════════════════════════════

"use strict";

const g = require("./governed_charge_cutover");

const CHARGE_CODE = "fee.application";
// Not redeclared as policy — read back from the generalized registry so this
// adapter cannot drift from the legacy owner the service will actually retire.
const LEGACY_FACT = g.SUPERSEDES[CHARGE_CODE][0];

const approveAndPublish = (pool, opts = {}) =>
  g.approveAndPublish(pool, { ...opts, charge_code: CHARGE_CODE });

const cutOver = (pool, opts = {}) =>
  g.cutOver(pool, { ...opts, charge_code: CHARGE_CODE });

const oneSourceProof = (pool, opts = {}) =>
  g.oneSourceProof(pool, { ...opts, charge_code: CHARGE_CODE });

// The old signature took a terms object and hashed it against a hard-coded
// charge_code. The generalized digest reads charge_code off the object, so
// default it here for callers that pass a bare row.
//
// The default is applied AFTER the spread, not before it: `{ charge_code: X,
// ...t }` lets an explicit `charge_code: undefined` on t overwrite the default
// with undefined, which silently changes the hash. Caught by layer D.
const termsDigest = (t = {}) =>
  g.termsDigest({ ...t, charge_code: t.charge_code || CHARGE_CODE });

module.exports = { approveAndPublish, cutOver, oneSourceProof, termsDigest, CHARGE_CODE, LEGACY_FACT };
