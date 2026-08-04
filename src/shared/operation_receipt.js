"use strict";
// ════════════════════════════════════════════════════════════════════
//  operation_receipt.js — THE ONE RECEIPT ENVELOPE.
//
//  A governed write returns enough durable identity for the caller to prove
//  what happened and recover it after a lost response. Two identities, and
//  they are not interchangeable:
//
//    operation_id  the CALLER's replay identity. Minted before the first
//                  request, persisted before it leaves the browser, sent
//                  unchanged on every retry. It identifies the ATTEMPT.
//
//    receipt_id    the SERVER's durable result identity. It identifies what
//                  actually exists in the database. It is an existing domain
//                  identity — a tour_events id, an executed_lease_records id,
//                  an obligation event id — never a synthetic handle minted
//                  to make the shapes tidy.
//
//  NO RECEIPT TABLE. A receipt is RECONSTRUCTED from exact durable domain
//  records, not stored as a duplicate JSON blob. Storing it twice would
//  create a second copy of the truth that can drift from the first, which is
//  precisely the defect this product exists to avoid. The invariant is:
//
//      same operation_id → same durable result → same receipt_id
//                        → same structured receipt
//
//  WHY `message` IS STILL HERE. Existing consumers read a prose receipt
//  string. It is retained during the additive transition and marked
//  deprecated. The browser must render success and consequences from the
//  structured fields — never by parsing prose.
// ════════════════════════════════════════════════════════════════════

const crypto = require("crypto");

//  Bump ONLY when a field's MEANING changes or a required field is removed.
//  Adding an optional field does not break a reader and does not bump this.
const RECEIPT_CONTRACT = "operation_receipt_v1";

//  ── OPERATION NAMESPACE ───────────────────────────────────────────
//  Recovery resolves an operation_id inside exactly one namespace. A
//  namespace names WHICH durable store to ask and HOW to reconstruct from
//  it. There is no heuristic search across tables: an unknown operation is
//  an error, not an invitation to guess.
const OPERATIONS = Object.freeze({
  EXECUTED_LEASE_VERIFY: "executed_lease.verify",
  TOUR_CHECK_IN: "tour.check_in",
  TOUR_COMPLETE: "tour.complete",
  WALK_IN_CAPTURE: "tour.walk_in_capture",
  APPLICATION_APPROVE: "application.approve",
  APPLICATION_DENY: "application.deny",
  TOUR_CONFIRM_PROSPECT: "tour.confirm_prospect",
  TASK_RESOLVE: "task.resolve",
  TASK_REASSIGN: "task.reassign",
  TASK_REOPEN: "task.reopen",
  TASK_CHANGE_DUE: "task.change_due",
});
const OPERATION_VALUES = Object.freeze(Object.values(OPERATIONS));

//  ── operation_id VALIDATION ───────────────────────────────────────
//  A UUID from the platform's governed random source. The rule is checked
//  server-side because "the browser was told to use crypto.randomUUID()" is
//  not a guarantee — a caller that derives its key from a timestamp or a
//  target id would collide across properties and never learn why.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function isValidOperationId(v) {
  return typeof v === "string" && UUID_RE.test(v.trim());
}

//  ── PAYLOAD BINDING ───────────────────────────────────────────────
//  An operation_id binds to the MATERIAL BUSINESS INPUTS of the operation,
//  not to the raw request body. Two requests differing only in an
//  idempotency wrapper, key order, or whitespace are the SAME operation; two
//  differing in rent, decision or target are NOT.
//
//  Normalization rules, deliberately narrow:
//    · keys sorted, so JSON key order never changes the hash
//    · null / undefined / "" dropped, so an absent field and an explicit
//      null are the same operation
//    · numbers via Number(), so 1200 and "1200" are the same rent
//    · strings trimmed
//    · nested objects and arrays normalized recursively; array ORDER is
//      preserved, because [unitA, unitB] and [unitB, unitA] may be the same
//      set but this module must not decide that for a domain
function normalizeMaterial(v) {
  if (v === null || v === undefined) return undefined;
  if (Array.isArray(v)) {
    const out = v.map(normalizeMaterial).filter((x) => x !== undefined);
    return out;
  }
  if (typeof v === "object") {
    const out = {};
    for (const k of Object.keys(v).sort()) {
      const nv = normalizeMaterial(v[k]);
      if (nv !== undefined) out[k] = nv;
    }
    return Object.keys(out).length ? out : undefined;
  }
  if (typeof v === "string") {
    const t = v.trim();
    return t === "" ? undefined : t;
  }
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  if (typeof v === "boolean") return v;
  return String(v);
}

//  material: the domain's OWN list of what makes this operation what it is.
//  Passing the whole request body would bind the hash to fields that do not
//  change the operation, and a harmless client change would then 409.
function payloadHash(operation, material) {
  const canonical = { op: operation, m: normalizeMaterial(material) || {} };
  return crypto.createHash("sha256")
    .update(JSON.stringify(canonical)).digest("hex");
}

//  ── THE ENVELOPE ──────────────────────────────────────────────────
//  Every field is explicit. A missing value is `null`, never absent and
//  never invented — a reader must be able to tell "this operation has no
//  effective date" from "somebody forgot to populate it".
function buildReceipt({
  operation,
  operationId,
  receiptId,
  replayed = false,
  actor,                    // { user_id, ... } — the SESSION actor, always
  propertyId,
  targets = {},             // canonical object ids, named by role
  before = null,            // material lifecycle state before
  after = null,             // material lifecycle state after
  evidenceIds = [],         // documents, hashes, proof references
  eventIds = [],            // immutable history rows this write created
  obligationEffects = {},   // { created:[], completed:[], reopened:[], reassigned:[] }
  occurredAt = null,        // when the real-world fact happened
  recordedAt,               // when this system wrote it
  effectiveAt = null,       // when it becomes/became governing, where governed
  canonicalDestination,     // the durable store this operation's truth lives in
  recovery,                 // { route, operation, operation_id }
  message = null,           // DEPRECATED prose, retained for existing readers
  extra = {},               // operation-specific structured detail
}) {
  if (!OPERATION_VALUES.includes(operation)) {
    throw new Error(`operation_receipt: unknown operation "${operation}"`);
  }
  return {
    contract: RECEIPT_CONTRACT,
    operation,
    operation_id: operationId,
    receipt_id: receiptId,
    replayed: !!replayed,
    actor: actor ? { user_id: actor.user_id || actor.id || null } : null,
    property_id: propertyId || null,
    targets,
    before,
    after,
    evidence_ids: evidenceIds,
    event_ids: eventIds,
    obligation_effects: {
      created: obligationEffects.created || [],
      completed: obligationEffects.completed || [],
      reopened: obligationEffects.reopened || [],
      reassigned: obligationEffects.reassigned || [],
    },
    occurred_at: occurredAt,
    recorded_at: recordedAt,
    effective_at: effectiveAt,
    canonical_destination: canonicalDestination,
    recovery,
    //  DEPRECATED. Retained for consumers not yet migrated. The browser must
    //  not read success or consequences out of this string.
    message,
    ...extra,
  };
}

//  ── TYPED RECOVERY STATES ─────────────────────────────────────────
//  "Not found", "failed" and "unknown" are three different facts about the
//  world and are never collapsed. A caller that cannot tell them apart
//  cannot decide whether to retry, and retrying a succeeded write is how
//  duplicates are born.
const RECOVERY = Object.freeze({
  FOUND: "receipt_found",
  NONE: "no_qualifying_operation",
  PENDING: "operation_still_pending",
  FAILED: "operation_failed",
  MISMATCH: "operation_id_payload_mismatch",
  UNAVAILABLE: "recovery_unavailable",
  FORBIDDEN: "forbidden",
});

//  The refusal a route sends when the caller omitted the replay identity.
//  Named as its own function so every route refuses in the same words.
function refuseMissingOperationId(res) {
  return res.status(400).json({
    error: "operation_id_required",
    receipt: "This write needs an operation_id — a UUID minted and stored by the caller "
      + "BEFORE the request, so a lost response can be recovered instead of retried blindly.",
  });
}

function refusePayloadMismatch(res, { operation, operationId }) {
  return res.status(409).json({
    error: "operation_id_payload_mismatch",
    receipt: "That operation_id was already used for a materially different operation. "
      + "A replay identity may recover the original result; it may not change it.",
    operation, operation_id: operationId,
  });
}

module.exports = {
  RECEIPT_CONTRACT, OPERATIONS, OPERATION_VALUES, RECOVERY,
  isValidOperationId, payloadHash, normalizeMaterial, buildReceipt,
  refuseMissingOperationId, refusePayloadMismatch,
};
