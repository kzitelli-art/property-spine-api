// ════════════════════════════════════════════════════════════════════
//  application_lifecycle.js — the canonical application lifecycle authority.
//
//  ── WHAT THIS OWNS ───────────────────────────────────────────────────
//      transition admissibility · companion-fact verification
//      status + milestone statement · transition receipt
//
//  ── WHAT THE CALLER OWNS ─────────────────────────────────────────────
//      authority check · application lock · event creation
//      obligation creation/completion · commit
//
//  This module receives an ALREADY-OPEN transaction client. It opens no
//  connection, begins no transaction, commits nothing, creates no event and no
//  obligation, and imports no Express, pool, session or authority service.
//
//  ── FIVE WRITERS, NOT EIGHT ──────────────────────────────────────────
//  An earlier revision exported writers for exact `approved`, `tenant_signed`
//  and `countersigned`. Those are not acts Property Spine performs: the live
//  approval path jumps straight to lease_ready, and the signature doors are
//  410 Gone with no canonical evidence source. A status existing in the
//  historical vocabulary does not justify a callable writer. Those statuses
//  stay READABLE — LADDER still ranks them so historical rows compare
//  correctly — and are not writable.
//
//  ── EVERY INSTANT COMES FROM POSTGRES ────────────────────────────────
//  transaction_timestamp() only, never a JavaScript clock. The app server's
//  clock can skew from the database's, and migration 124's compatibility
//  trigger authors from the database clock — a JS instant would make the two
//  writers disagree about when the same transition happened.
//
//  ── NEVER REPAIR HISTORY ─────────────────────────────────────────────
//  A historical row whose submitted_at is null is approved, admitted and
//  activated with submitted_at STILL NULL. It is honestly untrackable for a
//  submission-origin cohort. Filling it would fabricate a submission date that
//  looks canonical and is not. Likewise a row already at `approved` whose
//  approved_at is NULL keeps it NULL: the approval happened before this writer
//  existed, and now() would be a fabricated instant, not a recovered one.
// ════════════════════════════════════════════════════════════════════
"use strict";

// ── STATUS VOCABULARY ───────────────────────────────────────────────
//  Readable in full. Writable only through the five operations below.
const STATUS = Object.freeze({
  DRAFT: "draft",
  SUBMITTED: "submitted",
  APPROVED: "approved",                    // historical origin, NOT writable
  LEASE_READY: "lease_ready",
  TENANT_SIGNED: "tenant_signed",          // historical origin, NOT writable
  COUNTERSIGNED: "countersigned",          // historical origin, NOT writable
  ACCEPTED_TERM_REQUIRED: "accepted_term_required",
  ACTIVE: "active",
  DECLINED: "declined",
  WITHDRAWN: "withdrawn",
  EXPIRED: "expired",
});

// Progressive ladder, for already_at_target / already_beyond_target reasoning.
// Terminal statuses are deliberately absent — they are OFF the ladder, not
// further along it.
const LADDER = Object.freeze([
  "draft", "submitted", "approved", "lease_ready",
  "tenant_signed", "countersigned", "accepted_term_required", "active",
]);

// ── STATUS GROUPS ───────────────────────────────────────────────────
//  DRIFT WARNING: these three groups also exist in migration 124's
//  compatibility trigger and in staged migration 125. All three copies must
//  agree exactly. tests/proofs/slice9_status_group_drift_proof.js parses all three
//  and fails on any single-source mutation.
const SUBMISSION_REACHED = Object.freeze([
  "submitted", "approved", "lease_ready", "tenant_signed",
  "countersigned", "accepted_term_required", "active",
]);
const APPROVAL_REACHED = Object.freeze([
  "approved", "lease_ready", "tenant_signed",
  "countersigned", "accepted_term_required", "active",
]);
const TERMINAL = Object.freeze(["declined", "withdrawn", "expired"]);

const reachedSubmission = (s) => SUBMISSION_REACHED.includes(s);
const reachedApproval = (s) => APPROVAL_REACHED.includes(s);
const isTerminal = (s) => TERMINAL.includes(s);
const rank = (s) => LADDER.indexOf(s);

// Exact allowed origins per terminal disposition. Deliberately NOT derived
// from the ladder: accepted_term_required and active carry verified
// executed-lease evidence, and correcting those belongs to executed-lease or
// tenancy governance, never to a generic application denial.
const TERMINAL_ORIGINS = Object.freeze({
  declined: Object.freeze(["submitted", "approved", "lease_ready"]),
  expired: Object.freeze(["submitted", "approved", "lease_ready"]),
  withdrawn: Object.freeze(["draft", "submitted", "approved", "lease_ready"]),
});

// Retired statuses are accepted as HISTORICAL ORIGINS for admission. That does
// not make them writable — no operation moves an application into them.
const ADMISSION_ORIGINS = Object.freeze([
  "approved", "lease_ready", "tenant_signed", "countersigned",
]);

const MILESTONE_COLUMNS = Object.freeze([
  "submitted_at", "approved_at", "terminal_at", "terminal_code",
]);

// ── CONTROLLED REFUSAL ──────────────────────────────────────────────
function refuse(code, message, { application_id = null, from_status = null, to_status = null } = {}) {
  const e = new Error(message);
  e.transition_state = "refused";
  e.code = code;
  e.application_id = application_id;
  e.from_status = from_status;
  e.to_status = to_status;
  e.httpStatus = 409;
  e.publicMessage = message;
  return e;
}

function assertClient(client) {
  if (!client || typeof client.query !== "function") {
    throw new TypeError("application_lifecycle requires the caller's open transaction client");
  }
}

// ── TRANSITION ASSESSMENT (read-only) ───────────────────────────────
//  applied · already_at_target · already_beyond_target · refused
//
//  already_beyond_target is NOT ordinary idempotency. A caller that cannot
//  tell the two apart emits a second admission event and a duplicate
//  obligation for a row that has already moved on.
function assessTransition(fromStatus, toStatus) {
  if (fromStatus === toStatus) return { transition_state: "already_at_target" };

  if (isTerminal(toStatus)) {
    const origins = TERMINAL_ORIGINS[toStatus];
    if (!origins) return { transition_state: "refused", code: "unknown_terminal_code" };
    if (isTerminal(fromStatus)) {
      return { transition_state: "refused", code: "terminal_disposition_immutable" };
    }
    return origins.includes(fromStatus)
      ? { transition_state: "applied" }
      : { transition_state: "refused", code: "terminal_origin_not_permitted" };
  }

  if (isTerminal(fromStatus)) return { transition_state: "refused", code: "terminal_cannot_reopen" };

  const from = rank(fromStatus), to = rank(toStatus);
  if (from < 0 || to < 0) return { transition_state: "refused", code: "status_not_on_ladder" };
  if (from > to) return { transition_state: "already_beyond_target" };
  return { transition_state: "applied" };
}

// ── ROW HELPERS ─────────────────────────────────────────────────────
async function lockApplication(client, applicationId) {
  if (!applicationId) throw refuse("application_id_required", "An application id is required.");
  const row = (await client.query(
    "select * from lease_applications where id=$1 for update", [applicationId])).rows[0];
  if (!row) throw refuse("application_not_found", "No such application.", { application_id: applicationId });
  return row;
}

// Derived from the LOCKED before-row and the RETURNED after-row, so a
// coalesce() target that was already populated is never reported as authored.
function milestoneDelta(before, after) {
  const authored = [];
  for (const col of MILESTONE_COLUMNS) {
    const had = before && before[col] != null;
    const has = after && after[col] != null;
    if (!had && has) authored.push(col);
  }
  return {
    milestones_authored_now: authored,
    milestones_present_after: MILESTONE_COLUMNS.filter((c) => after && after[c] != null),
  };
}

function receipt(before, after, toStatus, transitionState) {
  return {
    application_id: (after || before).id,
    from_status: before ? before.status : null,
    to_status: toStatus,
    transition_state: transitionState,
    ...milestoneDelta(before, after),
    application: after,
  };
}

// A no-write outcome still returns a truthful receipt: nothing was authored.
function noWriteReceipt(before, toStatus, transitionState) {
  return {
    application_id: before.id,
    from_status: before.status,
    to_status: toStatus,
    transition_state: transitionState,
    milestones_authored_now: [],
    milestones_present_after: MILESTONE_COLUMNS.filter((c) => before[c] != null),
    application: before,
  };
}

// ── COMPANION-FACT VERIFICATION ─────────────────────────────────────
//  A status is only as meaningful as the fact that justifies it. lease_ready
//  without its terms_review obligation is a label, not a state.
async function requireObligation(client, { obligationId, applicationId, type, statuses, label }) {
  if (!obligationId) {
    throw refuse(`${label}_obligation_required`,
      `A ${type} obligation id is required to reach this state.`, { application_id: applicationId });
  }
  const o = (await client.query(
    "select id, related_id, related_type, type, status from obligations where id=$1 for update",
    [obligationId])).rows[0];
  if (!o) {
    throw refuse(`${label}_obligation_not_found`, `That ${type} obligation does not exist.`,
      { application_id: applicationId });
  }
  if (String(o.related_id) !== String(applicationId) || o.related_type !== "lease_application") {
    throw refuse(`${label}_obligation_lineage_mismatch`,
      `That ${type} obligation belongs to a different application.`, { application_id: applicationId });
  }
  if (o.type !== type) {
    throw refuse(`${label}_obligation_wrong_type`,
      `Expected a ${type} obligation, found ${o.type}.`, { application_id: applicationId });
  }
  if (!statuses.includes(o.status)) {
    throw refuse(`${label}_obligation_wrong_status`,
      `That ${type} obligation is ${o.status}; expected ${statuses.join(" or ")}.`,
      { application_id: applicationId });
  }
  return o;
}

// ════════════════════════════════════════════════════════════════════
//  1. createSubmittedApplication
//     ONE insert. status and submitted_at land together, because migration
//     125 refuses a row that reaches submission without its milestone —
//     insert-then-update is rejected by the database, not merely discouraged.
//
//     ── CLOSED PAYLOAD, FIXED COLUMN LIST ────────────────────────────
//     An earlier revision took { columns } and interpolated Object.keys()
//     straight into the SQL. That let a caller name any column — including
//     approved_at, terminal_code or an arbitrary identifier — and it silently
//     dropped the required-field guards. The payload is now a closed
//     allowlist, unknown keys are REFUSED rather than ignored, and no
//     caller-controlled string ever reaches the SQL text: the column list is
//     assembled from BIRTH_FIELDS, a module constant.
// ════════════════════════════════════════════════════════════════════
//  space_id joined this list at migration 182 — the exact rentable space the
//  application is aimed at, durable from the aim rather than first appearing
//  at the lease. It is OPTIONAL: an application may be born before a bed is
//  settled, and null is the honest record of that (§5). What it may never be
//  is a bed nobody chose, which is what deriveSpaceGrain below enforces.
const BIRTH_FIELDS = Object.freeze([
  "property_id", "unit_id", "space_id", "person_id", "leasing_lead_id", "applicant_name",
  "unit_label", "rent", "deposit", "guarantor_name", "captured", "source",
  "conversion_id",
]);
const BIRTH_REQUIRED = Object.freeze(["property_id", "person_id", "applicant_name"]);

// captured arrives either as an object or already-serialized JSON, as the
// prior authority accepted. Normalize once, here.
function normalizeCaptured(v) {
  if (v == null) return null;
  if (typeof v === "string") return v;
  try { return JSON.stringify(v); } catch (_) { return null; }
}

// ── SPACE GRAIN AT BIRTH (182) ───────────────────────────────────────
//  THE SERVER DERIVES THE PARENT FROM THE SPACE. It never lets a caller
//  assert both independently and then trusts whichever it read first.
//
//    space present, unit absent      → unit derived from the space
//    space present, unit agrees      → unchanged
//    space present, unit disagrees   → REFUSED, named
//    space absent                    → unchanged (permissive; bed not chosen)
//
//  The database trigger trg_lease_application_space_grain enforces the same
//  three rules and is the real authority — it has to be, because more than one
//  path writes. This function exists so the ordinary case fails with a sentence
//  a person can act on instead of a raw constraint violation, and so unit_id is
//  DERIVED rather than demanded. A guard here and a guard in Postgres are not
//  duplication: one is a message, the other is the wall.
async function deriveSpaceGrain(client, payload) {
  if (payload.space_id == null) return payload;

  const s = (await client.query(
    `select s.id, s.unit_id, u.property_id
       from spaces s join units u on u.id = s.unit_id
      where s.id = $1`,
    [payload.space_id]
  )).rows[0];

  if (!s) {
    throw refuse("birth_space_unknown",
      "That space does not exist, so an application cannot be aimed at it.");
  }
  if (payload.property_id != null && String(s.property_id) !== String(payload.property_id)) {
    throw refuse("birth_space_property_mismatch",
      "That space is not at this property.");
  }
  if (payload.unit_id != null && String(s.unit_id) !== String(payload.unit_id)) {
    throw refuse("birth_space_unit_mismatch",
      "The unit and the space disagree. An application is aimed at one space; "
      + "its unit is derived from that space, never asserted beside it.");
  }
  // Derived, not demanded. A caller that knew only the bed gets the parent for free.
  return { ...payload, unit_id: payload.unit_id != null ? payload.unit_id : s.unit_id };
}

async function createSubmittedApplication(client, rawPayload = {}) {
  assertClient(client);

  // Unknown-key refusal runs FIRST, on the caller's own object, so a typo is
  // still reported as a typo rather than surviving into the derived payload.
  const unknownEarly = Object.keys(rawPayload).filter((k) => !BIRTH_FIELDS.includes(k));
  if (unknownEarly.length) {
    throw refuse("birth_payload_unknown_field",
      `Unknown application field(s): ${unknownEarly.join(", ")}. Lifecycle columns are authored by this module, never supplied.`);
  }
  const payload = await deriveSpaceGrain(client, rawPayload);

  const unknown = Object.keys(payload).filter((k) => !BIRTH_FIELDS.includes(k));
  if (unknown.length) {
    throw refuse("birth_payload_unknown_field",
      `Unknown application field(s): ${unknown.join(", ")}. Lifecycle columns are authored by this module, never supplied.`);
  }
  const missing = BIRTH_REQUIRED.filter((k) => payload[k] == null || payload[k] === "");
  if (missing.length) {
    throw refuse("birth_payload_missing_required",
      `An application requires ${missing.join(", ")}.`);
  }

  // Identifiers come ONLY from BIRTH_FIELDS. Absent fields are omitted rather
  // than sent as explicit null, so NOT NULL columns keep their database
  // defaults (captured, for one) instead of being overwritten with null.
  const present = BIRTH_FIELDS.filter((f) => payload[f] !== undefined && payload[f] !== null);
  const values = present.map((f) => (f === "captured" ? normalizeCaptured(payload[f]) : payload[f]));
  const placeholders = present.map((_, i) => `$${i + 1}`);

  const after = (await client.query(
    `insert into lease_applications (${present.join(", ")}, status, submitted_at)
     values (${placeholders.join(", ")}, 'submitted', transaction_timestamp())
     returning *`, values)).rows[0];

  return receipt(null, after, STATUS.SUBMITTED, "applied");
}

// ════════════════════════════════════════════════════════════════════
//  2. markLeaseReadyFromApproval
//     The live approval act. Crossing from submitted authors approved_at.
//     Advancing a HISTORICAL `approved` row authors nothing.
// ════════════════════════════════════════════════════════════════════
async function markLeaseReadyFromApproval(client, { applicationId, termsReviewObligationId } = {}) {
  assertClient(client);
  const before = await lockApplication(client, applicationId);
  const target = STATUS.LEASE_READY;
  const a = assessTransition(before.status, target);

  if (a.transition_state === "already_beyond_target") return noWriteReceipt(before, target, "already_beyond_target");
  if (a.transition_state === "refused") {
    throw refuse(a.code, `Cannot reach lease_ready from ${before.status}.`,
      { application_id: applicationId, from_status: before.status, to_status: target });
  }

  // ALREADY AT TARGET IS NOT A FREE PASS. A row sitting at lease_ready whose
  // terms_review pointer is missing, or points somewhere else, is malformed —
  // blessing it as a successful idempotent replay would launder exactly the
  // defect the companion rule exists to prevent.
  if (a.transition_state === "already_at_target") {
    if (!before.terms_review_obligation_id
        || String(before.terms_review_obligation_id) !== String(termsReviewObligationId)) {
      throw refuse("lease_ready_companion_mismatch",
        "This application is already lease_ready but its terms_review obligation does not match the one supplied.",
        { application_id: applicationId, from_status: before.status, to_status: target });
    }
    await requireObligation(client, {
      obligationId: termsReviewObligationId, applicationId,
      type: "terms_review", statuses: ["open", "in_progress"], label: "terms_review",
    });
    return noWriteReceipt(before, target, "already_at_target");
  }
  if (before.status !== STATUS.SUBMITTED && before.status !== STATUS.APPROVED) {
    throw refuse("lease_ready_origin_not_permitted",
      `lease_ready may only be reached from submitted or approved, not ${before.status}.`,
      { application_id: applicationId, from_status: before.status, to_status: target });
  }

  await requireObligation(client, {
    obligationId: termsReviewObligationId, applicationId,
    type: "terms_review", statuses: ["open", "in_progress"], label: "terms_review",
  });

  // Crossing from submitted authors approval NOW. From historical approved,
  // approved_at is left exactly as found — including null.
  const authorsApproval = !reachedApproval(before.status);

  const after = (await client.query(
    `update lease_applications
        set status='lease_ready',
            terms_review_obligation_id=$2,
            approved_at = case when $3::boolean and approved_at is null
                               then transaction_timestamp() else approved_at end,
            updated_at = transaction_timestamp()
      where id=$1 returning *`,
    [applicationId, termsReviewObligationId, authorsApproval])).rows[0];

  return receipt(before, after, target, "applied");
}

// ════════════════════════════════════════════════════════════════════
//  3. markTermConfirmationRequiredFromExecutedLease
//     Admission of a verified executed lease. Writes STATUS ONLY.
//
//     It must NOT write countersigned_at. The executed-lease service states
//     plainly that this act is neither acceptance nor countersigning, and the
//     real execution instant already lives on executed_lease_records. An
//     earlier revision wrote countersigned_at=coalesce(countersigned_at, now())
//     here — a fabricated legal-semantic fact on every admission.
// ════════════════════════════════════════════════════════════════════
async function markTermConfirmationRequiredFromExecutedLease(client, {
  applicationId, executedLeaseRecordId, termRequiredObligationId,
} = {}) {
  assertClient(client);
  const before = await lockApplication(client, applicationId);
  const target = STATUS.ACCEPTED_TERM_REQUIRED;
  const a = assessTransition(before.status, target);

  if (a.transition_state === "already_beyond_target") return noWriteReceipt(before, target, "already_beyond_target");
  if (a.transition_state === "refused") {
    throw refuse(a.code, `Cannot reach ${target} from ${before.status}.`,
      { application_id: applicationId, from_status: before.status, to_status: target });
  }
  const replay = a.transition_state === "already_at_target";
  if (!replay && !ADMISSION_ORIGINS.includes(before.status)) {
    throw refuse("admission_origin_not_permitted",
      `${target} may only be reached from ${ADMISSION_ORIGINS.join(", ")}, not ${before.status}.`,
      { application_id: applicationId, from_status: before.status, to_status: target });
  }

  if (!executedLeaseRecordId) {
    throw refuse("executed_lease_record_required",
      "A verified executed-lease record is required to admit term confirmation.",
      { application_id: applicationId });
  }
  const rec = (await client.query(
    "select id, application_id, record_state from executed_lease_records where id=$1 for update",
    [executedLeaseRecordId])).rows[0];
  if (!rec) {
    throw refuse("executed_lease_record_not_found", "That executed-lease record does not exist.",
      { application_id: applicationId });
  }
  if (String(rec.application_id) !== String(applicationId)) {
    throw refuse("executed_lease_record_lineage_mismatch",
      "That executed-lease record belongs to a different application.", { application_id: applicationId });
  }
  if (rec.record_state !== "verified") {
    throw refuse("executed_lease_record_not_verified",
      `That executed-lease record is ${rec.record_state}; only a verified record admits term confirmation.`,
      { application_id: applicationId });
  }
  // CURRENT is the application's OWN pointer plus the record's own state —
  // the direct operating facts. "No row happens to reference this through
  // supersedes_record_id" is an absence of contradiction, not evidence of
  // currency, and it silently passes for a record the application has already
  // moved off.
  // The pointer must be NON-NULL and exact. Guarding only "non-null AND
  // mismatched" let a null pointer pass, which is the same defect wearing a
  // different shape: an application with no pointer has no current record, so
  // nothing can be its current record.
  if (!before.executed_lease_record_id
      || String(before.executed_lease_record_id) !== String(executedLeaseRecordId)) {
    throw refuse("executed_lease_record_not_current",
      "That executed-lease record is not the one this application currently points at.",
      { application_id: applicationId });
  }

  await requireObligation(client, {
    obligationId: termRequiredObligationId, applicationId,
    type: "term_required", statuses: ["open", "in_progress"], label: "term_required",
  });

  if (replay) return noWriteReceipt(before, target, "already_at_target");

  // STATUS ONLY. No countersigned_at, no executed_at, no submitted_at, no approved_at.
  const after = (await client.query(
    `update lease_applications
        set status='accepted_term_required', updated_at = transaction_timestamp()
      where id=$1 returning *`, [applicationId])).rows[0];

  return receipt(before, after, target, "applied");
}

// ════════════════════════════════════════════════════════════════════
//  4. markActiveFromConfirmedTerm
//     The tenancy anchor exists and the term obligation is complete.
//     Populates NO missing submission or approval milestone.
// ════════════════════════════════════════════════════════════════════
async function markActiveFromConfirmedTerm(client, { applicationId, leaseId, termRequiredObligationId } = {}) {
  assertClient(client);
  const before = await lockApplication(client, applicationId);
  const target = STATUS.ACTIVE;
  const a = assessTransition(before.status, target);

  if (a.transition_state === "already_beyond_target") return noWriteReceipt(before, target, "already_beyond_target");
  if (a.transition_state === "refused") {
    throw refuse(a.code, `Cannot reach active from ${before.status}.`,
      { application_id: applicationId, from_status: before.status, to_status: target });
  }
  const replayActive = a.transition_state === "already_at_target";
  if (!replayActive && before.status !== STATUS.ACCEPTED_TERM_REQUIRED) {
    throw refuse("active_origin_not_permitted",
      `active may only be reached from accepted_term_required, not ${before.status}.`,
      { application_id: applicationId, from_status: before.status, to_status: target });
  }

  if (!leaseId) {
    throw refuse("lease_required", "A lease anchor is required to activate an application.",
      { application_id: applicationId });
  }
  const lease = (await client.query(
    "select id, application_id from leases where id=$1 for update", [leaseId])).rows[0];
  if (!lease) throw refuse("lease_not_found", "That lease does not exist.", { application_id: applicationId });
  if (String(lease.application_id) !== String(applicationId)) {
    throw refuse("lease_lineage_mismatch", "That lease belongs to a different application.",
      { application_id: applicationId });
  }

  await requireObligation(client, {
    obligationId: termRequiredObligationId, applicationId,
    type: "term_required", statuses: ["complete"], label: "term_required",
  });

  if (replayActive) return noWriteReceipt(before, target, "already_at_target");

  const after = (await client.query(
    `update lease_applications
        set status='active',
            activated_at = coalesce(activated_at, transaction_timestamp()),
            updated_at = transaction_timestamp()
      where id=$1 returning *`, [applicationId])).rows[0];

  return receipt(before, after, target, "applied");
}

// ════════════════════════════════════════════════════════════════════
//  5. markTerminal
//     One statement authors the whole disposition. terminal_code always
//     equals status — migration 125 enforces the correspondence as a standing
//     constraint, so a mismatched pair cannot exist even transiently.
//
//     actorUserId MAY be null: legacy actorless doors still exist. It must
//     always come from a server-derived session, never a request body — the
//     caller cutover proves that.
// ════════════════════════════════════════════════════════════════════
async function markTerminal(client, {
  applicationId, terminalCode, decisionReason = null, actorUserId = null,
} = {}) {
  assertClient(client);
  if (!TERMINAL.includes(terminalCode)) {
    throw refuse("unknown_terminal_code",
      `${terminalCode} is not a terminal disposition. Expected ${TERMINAL.join(", ")}.`,
      { application_id: applicationId, to_status: terminalCode });
  }
  const before = await lockApplication(client, applicationId);

  // Exact same-terminal replay is a no-write result, not a refusal.
  if (before.status === terminalCode) return noWriteReceipt(before, terminalCode, "already_at_target");

  const a = assessTransition(before.status, terminalCode);
  if (a.transition_state === "refused") {
    const msg = isTerminal(before.status)
      ? `This application is already ${before.status}; a terminal disposition is immutable and a later pursuit is a new application.`
      : `${terminalCode} may only be reached from ${TERMINAL_ORIGINS[terminalCode].join(", ")}, not ${before.status}.`;
    throw refuse(a.code, msg,
      { application_id: applicationId, from_status: before.status, to_status: terminalCode });
  }

  const after = (await client.query(
    `update lease_applications
        set status=$2, terminal_code=$2,
            terminal_at = transaction_timestamp(),
            decision_reason = $3,
            decision_by_user_id = $4,
            decided_at = transaction_timestamp(),
            updated_at = transaction_timestamp()
      where id=$1 returning *`,
    [applicationId, terminalCode, decisionReason, actorUserId])).rows[0];

  return receipt(before, after, terminalCode, "applied");
}

module.exports = {
  //  (182) exported for the grain test — the same function birth uses, not a
  //  reimplementation of it. A test that re-derives the rule proves the test.
  deriveSpaceGrain,
  // read-only vocabulary
  STATUS, LADDER,
  SUBMISSION_REACHED, APPROVAL_REACHED, TERMINAL, TERMINAL_ORIGINS, ADMISSION_ORIGINS,
  reachedSubmission, reachedApproval, isTerminal,
  assessTransition,

  // the five writable acts — the ONLY writers of lease_applications.status
  createSubmittedApplication,
  markLeaseReadyFromApproval,
  markTermConfirmationRequiredFromExecutedLease,
  markActiveFromConfirmedTerm,
  markTerminal,
};
