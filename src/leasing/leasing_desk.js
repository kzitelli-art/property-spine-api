"use strict";

// PROPERTY SPINE — canonical Leasing Desk composition.
//
// This module is deliberately pure. It does not query, write, authorize, or infer
// lifecycle truth from raw statuses. Callers must supply application rows already
// interpreted by the canonical Application Review resolver and follow-up rows
// already read from the canonical conversion-obligation rail.
//
// Class 1 permanent primitive: server-authored placement and display suppression.

const READY_TO_BIND_CODES = new Set([
  // Intentionally empty. Current source exposes no canonical resolver code that
  // proves: the executed lease is verified and admitted (088 — there is no
  // company countersignature step). Add a code
  // only when that exact lifecycle fact exists and is verified.
]);

const READY_TO_ADVANCE_CODES = new Set([
  "approve_application",
  "confirm_proposed_terms",
  "generate_terms_review_packet",
  "issue_terms_review_link",
  "review_application",
  "confirm_term",
  "executed_lease_required",
]);

const OMITTED_APPLICATION_CODES = new Set([
  "await_resident_acknowledgment",
  "awaiting_acknowledgment",
  "active",
  "closed",
]);

// Only obligations whose semantics explicitly duplicate the application lifecycle
// row are suppressible. Same conversion alone is never enough.
const APPLICATION_SHADOW_RUNGS = new Set([
  "lease_signature_followup",
  "application_lifecycle_followup",
]);


// Leasing Work is a lifecycle conveyor, not a severity bucket.
// These codes remain in Leasing Work's final tab until the tenancy anchor exists.
// S4 ruling: the acknowledgment codes belong here too — the resolver emits them
// ONLY after the packet was actually issued (PK_AWAITING in applications.js), so
// "the prospect has the document and staff is waiting" is third-stage truth.
const LEASE_SENT_STAGE_CODES = new Set([
  "executed_lease_required",
  "verify_executed_lease",
  "review_conflict",
  "confirm_term",
  "awaiting_acknowledgment",
  "await_resident_acknowledgment",
]);

// S4 ruling: the third machine stage keeps its code but presents as "Lease" —
// preparation/terms/packet states live in it before anything was actually sent,
// so a universal "Lease sent" heading would claim an issuance that may not have
// happened. Row state labels carry the precise truth ("sent" wording only on
// states that prove issuance).
const LEASING_STAGE_LABELS = Object.freeze({
  post_tour: "Post-tour",
  application: "Application",
  lease_sent: "Lease",
});

// S4 ruling: waiting party is server-authored per code, never inferred from
// button availability, elapsed time, or message direction. Only codes with a
// real authoring site appear here; every other row is an honest null. Today
// exactly one workflow authors a wait — the issued terms packet awaiting the
// resident — so `prospect` is the only emitted value. staff / ai /
// external_evidence join this map only when a canonical workflow authors them.
const WAITING_PARTY_BY_CODE = Object.freeze({
  awaiting_acknowledgment: "prospect",
  await_resident_acknowledgment: "prospect",
});

// S4 ruling: blocker_code stays machine-stable; the label is server-owned and
// mapped HERE — the browser must not translate blocker codes independently.
// An unmapped code yields null (honest blank), never an invented sentence.
const BLOCKER_LABELS = Object.freeze({
  executed_lease_conflict: "The executed lease conflicts with the confirmed terms. Review the conflict before proceeding.",
  inconsistent_application_state: "A lease packet exists without a current terms confirmation. Governed correction required.",
  packet_voided: "The prior lease packet was voided. Regenerate it before resident review.",
  packet_status_not_issuable: "The current lease packet is not in an issuable state. Regenerate it.",
  packet_lineage_unproven: "The packet's terms lineage is unproven. Regenerate it from the confirmed terms.",
  packet_confirmation_mismatch: "The packet was generated from different terms than the current confirmation. Regenerate it.",
  packet_stale: "The packet no longer matches the canonical application terms. Regenerate it before resident review.",
});

function blockerLabelFor(code) {
  if (code == null || code === "") return null;
  return BLOCKER_LABELS[code] || null;
}

// S4: latest MEANINGFUL activity — the server selects the greatest supported
// SEMANTIC timestamp with its label. Candidates arrive from the loader with
// labels drawn from the closed source vocabulary (conversation_message,
// tour_completed, tour_outcome_captured, application_signed,
// application_countersigned, application_activated, obligation_activity).
// Generic updated_at columns are deliberately never candidates: a technical
// row update is not operating activity. No candidates → honest nulls.
function latestActivityFrom(candidates) {
  let bestAt = null;
  let bestLabel = null;
  for (const c of Array.isArray(candidates) ? candidates : []) {
    if (!c || !c.at || !c.label) continue;
    const t = new Date(c.at).getTime();
    if (!Number.isFinite(t)) continue;
    if (bestAt == null || t > bestAt) { bestAt = t; bestLabel = c.label; }
  }
  return bestAt == null
    ? { latest_activity_at: null, latest_activity_label: null }
    : { latest_activity_at: new Date(bestAt).toISOString(), latest_activity_label: bestLabel };
}

// Once the canonical resolver says the application is complete/active/closed,
// it has left acquisition. Move-in and Future Rent Roll own the next projection.
const EXITED_LEASING_CODES = new Set([
  "active",
  "closed",
  "term_confirmed",
]);

const LEASING_STAGE_CODES = Object.freeze([
  "post_tour",
  "application",
  "lease_sent",
]);

const DUE_RANK = Object.freeze({ overdue: 0, today: 1, upcoming: 2, none: 3 });

function valueOrNull(value) {
  return value == null || value === "" ? null : value;
}

function toIsoOrNull(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function dealKey(row) {
  if (row && row.conversion_id) return `conversion:${row.conversion_id}`;
  if (row && row.application_id) return `application:${row.application_id}`;
  if (row && row.obligation_id) return `obligation:${row.obligation_id}`;
  // S4: an owed tour-outcome capture predates the conversion (capture is what
  // creates it), so the tour is the only durable identity the deal has yet.
  if (row && row.tour_id) return `tour:${row.tour_id}`;
  throw new Error("Leasing Desk row requires conversion_id, application_id, obligation_id, or tour_id.");
}

function applicationDeskKey(row) {
  if (!row || !row.application_id) throw new Error("Application DeskRow requires application_id.");
  return `application:${row.application_id}`;
}

function obligationDeskKey(row) {
  if (!row || !row.obligation_id) throw new Error("Follow-up DeskRow requires obligation_id.");
  return `obligation:${row.obligation_id}`;
}

function normalizeApplicationAction(row, next) {
  // CLOSED CTA VOCABULARY (ruled): navigation → "Open", dispatch → "Send",
  // obligation closure → "Complete". The row SENTENCE carries the business
  // meaning ("Confirm the proposed terms."); the button says only what
  // pressing it does. Every branch here is navigation, so every label is
  // "Open" — this also retires the countersignature-era button label that
  // was still speaking the signing ceremony 088 removed.
  const blocked = next.state === "blocked";
  return {
    code: blocked ? "review_application_blocker" : "open_application_review",
    label: "Open",
    kind: "navigation",
    target: { type: "application", id: row.application_id },
  };
}

function normalizeApplicationRow(row) {
  const next = row && row.next_action;
  if (!next || !next.code) return null; // honest omission; caller must not guess.
  if (next.state === "waiting" || next.state === "complete" || OMITTED_APPLICATION_CODES.has(next.code)) {
    return null;
  }

  const band = READY_TO_BIND_CODES.has(next.code) ? "ready_to_bind" : "ready_to_advance";
  // Unknown available/blocked lifecycle codes remain visible in Ready to advance.
  // They receive a navigation action, never an invented consequential write.
  const knownAdvance = READY_TO_ADVANCE_CODES.has(next.code);
  const stateLabel = valueOrNull(next.label) || (knownAdvance ? "Application needs review." : "Other application work.");

  return {
    desk_key: applicationDeskKey(row),
    deal_key: dealKey(row),
    conversion_id: valueOrNull(row.conversion_id),
    band,
    person_id: valueOrNull(row.person_id),
    person_name: valueOrNull(row.person_name || row.applicant_name),
    unit_number: valueOrNull(row.unit_number || row.unit_label),
    application_id: row.application_id,
    obligation_id: valueOrNull(row.obligation_id || next.obligation_id),
    state_code: next.state || "available",
    state_label: stateLabel,
    blocker_code: valueOrNull(next.blocker_code),
    next_action_code: next.code,
    primary_action: normalizeApplicationAction(row, next),
    owner_name: valueOrNull(row.owner_name),
    owner_basis: valueOrNull(row.owner_basis),
    due_at: toIsoOrNull(row.due_at),
    due_state: valueOrNull(row.due_state),
    created_at: toIsoOrNull(row.created_at),
    source: "application_lifecycle",
  };
}

// Buddy-ruled action tiers (see DELIVERY note). The client dispatches exactly:
//   task_write  send_application            → Send-application flow
//   task_write  complete_task               → Complete confirmation sheet (never instant-close)
//   navigation  target {type:'person'}      → open the conversation / Person Card
//   navigation  target {type:'application'} → Application Review
// Communication-oriented next moves open the conversation rather than asserting
// completion of undone work. This set is CONFIG TO VERIFY against the live
// rail's actual next_move_code vocabulary before the loader ships (Rule 11).
// CORRECTED 2026-07-26: this used to claim "unlisted codes fall to Complete,
// so a missing entry is safe, never wrong." They fall to UNAVAILABLE. A
// missing entry is therefore neither safe nor invisible — it tells the
// operator the app cannot do a thing it just offered them.
// tests/leasing_action_deadend_audit.js exists to catch the next one.
const COMMUNICATION_MOVE_CODES = new Set([
  "send_follow_up",
  "call_prospect",
  "message_prospect",
  "send_floor_plans",
  "schedule_second_tour",
]);

// ── REMINDERS — the work IS the remembering ──────────────────────────
//  Added 2026-07-26. These are authored by the post-tour capture menu, so
//  they are not "unknown codes"; the desk simply never declared them. Every
//  one of them rendered "Unavailable", which told an operator the app could
//  not do something it had just invited them to choose. Seven of the ten
//  remaining post-tour options were in that state.
//
//  The fallback below is NOT the bug and is deliberately left alone: for a
//  genuinely unrecognised code, refusing to invent a consequential write is
//  correct. The fix is to say what these mean, not to loosen the default.
//
//  Note the header comment on COMMUNICATION_MOVE_CODES claimed "unlisted
//  codes fall to Complete, so a missing entry is safe, never wrong". That
//  was never true of the code — unlisted fell to Unavailable. Corrected
//  there as well, because a comment that misdescribes its own fallback is
//  how a missing entry stays missing.
const REMINDER_MOVE_CODES = new Set([
  "follow_up_later",
  "set_follow_up_time",
  "watch_future",
  "close_out",
  "different_home",
  "different_price",
  "different_timing",
]);

// ── HELD, NOT UNAVAILABLE ────────────────────────────────────────────
// Two different truths were collapsed into one word. "Unavailable" is
// honest when the operator app does not implement an action — there is
// nothing to press and nothing to explain. It is the WRONG word when the
// action exists, works, and is simply held for this record by policy:
// that is not a missing feature, it is a decision, and the operator should
// see the verb they would press plus why they cannot press it yet.
//
// So a held action keeps its real code, label and target, and is marked
// blocked. The button shows Send, disabled, with the reason underneath.
// Rule 9 is not violated: a disabled control makes no promise.
function blockedFollowupAction({ code, label, target, reason, reason_code }) {
  return {
    code,
    label,
    kind: "blocked",
    target,
    blocked: true,
    reason_code: reason_code || null,
    reason,
  };
}

function unsupportedFollowupAction(row, code, reason) {
  return {
    code: "unsupported_action",
    label: "Unavailable",
    kind: "unsupported",
    target: { type: "obligation", id: row.obligation_id },
    source_code: code,
    reason: reason || "This action is not supported in the operator app yet.",
  };
}

function normalizeFollowupAction(row) {
  const code = valueOrNull(row.next_move_code);

  if (code === "send_application") {
    const conversionId = valueOrNull(row.conversion_id);
    if (!conversionId) {
      return unsupportedFollowupAction(
        row,
        code,
        "The application cannot be sent because this work has no leasing conversion."
      );
    }
    // ── CAPABILITY BEFORE PROMISE ───────────────────────────────────
    // The row carries the SAME verdict the write route will compute. If the
    // action would be refused, it renders disabled with the operator-facing
    // reason rather than as a live button that fails on press. A screen that
    // offers what the server will not do is a phantom dispatch (Rule 9); the
    // promise is made by the button, not by the request.
    //
    // A null verdict means capability was not evaluated on this deploy — the
    // action is left exactly as it was. Unknown is not denial.
    const cap = row.send_application_capability || null;
    if (cap && cap.allowed === false) {
      return blockedFollowupAction({
        code: "send_application",
        label: "Send",
        target: { type: "conversion", id: conversionId },
        reason: cap.display_reason,
        reason_code: cap.reason_code,
      });
    }
    return {
      code: "send_application",
      label: "Send",
      kind: "task_write",
      target: { type: "conversion", id: conversionId },
      capability: cap || null,
    };
  }

  if (code && COMMUNICATION_MOVE_CODES.has(code)) {
    const personId = valueOrNull(row.person_id);
    if (!personId) {
      return unsupportedFollowupAction(
        row,
        code,
        "The conversation cannot be opened because no durable person is connected to this work."
      );
    }
    return {
      code: "open_conversation",
      label: "Open",
      kind: "navigation",
      target: { type: "person", id: personId },
    };
  }

  // A rail row with no authored next move is the one genuine generic
  // obligation-completion case. Explicit legacy completion codes remain
  // accepted, as do the declared reminder moves — for those, recording that
  // the remembering happened IS the whole of the work.
  if (code == null || code === "complete_task" || code === "complete"
      || REMINDER_MOVE_CODES.has(code)) {
    return {
      code: "complete_task",
      label: "Complete",
      kind: "task_write",
      target: { type: "obligation", id: row.obligation_id },
    };
  }

  // Unknown non-null codes are not completion instructions. Preserve the work,
  // expose the unsupported source code, and refuse to invent a consequential write.
  return unsupportedFollowupAction(row, code);
}

function normalizeFollowupRow(row) {
  const action = normalizeFollowupAction(row);
  // S4: a capability-held action is a genuinely blocked ROW — the server has
  // already refused the one thing this row offers, with an authored reason.
  // That is the only followup-rail blocker authoring site today.
  const held = action && action.kind === "blocked";
  const accountableUserId = valueOrNull(row.owner_user_id);
  return {
    desk_key: obligationDeskKey(row),
    deal_key: dealKey(row),
    conversion_id: valueOrNull(row.conversion_id),
    band: "follow_ups",
    person_id: valueOrNull(row.person_id),
    person_name: valueOrNull(row.person_name),
    unit_number: valueOrNull(row.unit_number),
    application_id: valueOrNull(row.application_id),
    obligation_id: row.obligation_id,
    state_code: valueOrNull(row.rung) || "other_leasing_work",
    state_label: valueOrNull(row.label) || "Other leasing work",
    operating_state: held ? "blocked" : "available",
    waiting_on: null, // no rail workflow authors a waiting party yet (S4 ruling)
    blocker_code: held ? valueOrNull(action.reason_code) : null,
    blocker_label: held ? valueOrNull(action.reason) : null,
    next_action_code: valueOrNull(row.next_move_code),
    primary_action: action,
    accountable_user_id: accountableUserId,
    accountable_user_name: valueOrNull(row.owner_name),
    assignment_state: accountableUserId ? "assigned" : "unassigned",
    owner_name: valueOrNull(row.owner_name),
    owner_basis: valueOrNull(row.owner_basis) || "unassigned",
    due_at: toIsoOrNull(row.due_at),
    due_state: valueOrNull(row.due_state) || "none",
    created_at: toIsoOrNull(row.created_at),
    source: "followup_rail",
    rung: valueOrNull(row.rung),
    // S4 correlations — passthrough of already-canonical reads, null preserved
    // when no canonical relationship exists (never synthesized).
    tour_id: valueOrNull(row.origin_tour_id),
    conversation_id: valueOrNull(row.conversation_id),
    unit_id: valueOrNull(row.unit_id),
    lease_packet_id: null,
    lease_id: null,
    ...latestActivityFrom(row.activity_candidates),
  };
}


function stageForApplicationNext(next) {
  if (!next || !next.code) return null;
  if (next.state === "complete" || EXITED_LEASING_CODES.has(next.code)) return null;
  if (LEASE_SENT_STAGE_CODES.has(next.code)) return "lease_sent";
  return "application";
}

function normalizeStageApplicationAction(row, next) {
  // The row sentence carries the specific business meaning. Every application
  // lifecycle action opens the governed Application Review workspace, so the
  // button vocabulary remains the canonical navigation verb: Open.
  return normalizeApplicationAction(row, next);
}

function normalizeStageApplicationRow(row) {
  const next = row && row.next_action;
  const stage = stageForApplicationNext(next);
  if (!stage) return null;

  // S4 ruling: waiting is ACTIVE work and stays on the rail. The row keeps its
  // PRECISE canonical code as state_code (never the generic word "waiting");
  // operating_state carries the machine state and waiting_on the authored
  // party. Genuinely exited states (complete / active tenancy / closed) are
  // already removed above by stageForApplicationNext.
  const operatingState = next.state || "available";
  const waiting = operatingState === "waiting";
  const accountableUserId = valueOrNull(row.owner_user_id);
  return {
    desk_key: applicationDeskKey(row),
    deal_key: dealKey(row),
    conversion_id: valueOrNull(row.conversion_id),
    stage,
    person_id: valueOrNull(row.person_id),
    person_name: valueOrNull(row.person_name || row.applicant_name),
    unit_number: valueOrNull(row.unit_number || row.unit_label),
    application_id: row.application_id,
    obligation_id: valueOrNull(row.obligation_id || next.obligation_id),
    state_code: waiting ? next.code : (next.state || "available"),
    state_label: valueOrNull(next.label) || "Application in progress.",
    operating_state: operatingState,
    waiting_on: WAITING_PARTY_BY_CODE[next.code] || null,
    blocker_code: valueOrNull(next.blocker_code),
    blocker_label: blockerLabelFor(next.blocker_code),
    next_action_code: next.code,
    primary_action: normalizeStageApplicationAction(row, next),
    accountable_user_id: accountableUserId,
    accountable_user_name: valueOrNull(row.owner_name),
    assignment_state: accountableUserId ? "assigned" : "unassigned",
    owner_name: valueOrNull(row.owner_name),
    owner_basis: valueOrNull(row.owner_basis),
    due_at: toIsoOrNull(row.due_at),
    due_state: valueOrNull(row.due_state),
    created_at: toIsoOrNull(row.created_at),
    source: "application_lifecycle",
    // S4 correlations. tour_id stays null on this rail — no application-to-tour
    // link is stored, and none may be inferred (ruling). lease_packet_id is the
    // resolver's own packet passthrough; lease_id is the direct
    // leases.application_id read Application Review already serves.
    tour_id: null,
    conversation_id: valueOrNull(row.conversation_id),
    unit_id: valueOrNull(row.unit_id),
    lease_packet_id: valueOrNull(next.packet_id),
    lease_id: valueOrNull(row.lease_id),
    ...latestActivityFrom(row.activity_candidates),
  };
}

function stageForFollowup(row) {
  if (!row) return null;
  const substatus = valueOrNull(row.applicant_substatus);
  if (substatus === "declined") return null;
  if (substatus === "application_sent" || substatus === "submitted" || substatus === "approved") {
    return "application";
  }
  // createConversionFromTour is called only when tour_given !== false.
  // Therefore origin_tour_id on an open rail row is the durable proof that
  // post-tour capture actually happened; no-shows and reschedules stay in Tours.
  if (valueOrNull(row.origin_tour_id)) return "post_tour";
  return null;
}

function normalizeStageFollowupRow(row) {
  const stage = stageForFollowup(row);
  if (!stage) return null;
  return { ...normalizeFollowupRow(row), stage };
}

// ── S4: TOUR-CAPTURE ROWS (third row source) ────────────────────────────────
// A tour that HAPPENED with no recorded outcome is owed work the desk never
// showed: the follow-up rail only begins once capture creates the conversion,
// so the owing period was invisible. The loader selects these with the ONE
// canonical capture resolver (tour_outcome.resolveCaptureState — the same
// judgment the Tours board renders); this normalizer only shapes the row.
//
// Ruled behavior:
//   · owner is the canonical assigned tour host (leasing_agent_id) or honest
//     unassigned — never confirmed_by, which proves confirmation, not hosting;
//   · no invented capture SLA: due_at is null (no authored deadline timestamp
//     exists), and due_state is "overdue" ONLY because the canonical resolver
//     already authors exactly that judgment for these rows on the Tours board
//     (tour ended + existing grace, nothing captured) — else "none";
//   · the primary action navigates to the EXISTING canonical tour-outcome
//     destination; no second capture workflow or write path.
function normalizeTourCaptureRow(row) {
  if (!row || !row.tour_id) return null;
  const accountableUserId = valueOrNull(row.leasing_agent_id);
  return {
    desk_key: `tour:${row.tour_id}`,
    deal_key: dealKey({ tour_id: row.tour_id }),
    conversion_id: null,
    stage: "post_tour",
    person_id: valueOrNull(row.person_id),
    person_name: valueOrNull(row.person_name),
    unit_number: valueOrNull(row.unit_number),
    application_id: null,
    obligation_id: null,
    state_code: "tour_outcome_owed",
    state_label: "Tour happened — outcome not captured.",
    operating_state: "available",
    waiting_on: null,
    blocker_code: null,
    blocker_label: null,
    next_action_code: "capture_tour_outcome",
    primary_action: {
      code: "capture_tour_outcome",
      label: "Open",
      kind: "navigation",
      target: { type: "tour", id: row.tour_id },
    },
    accountable_user_id: accountableUserId,
    accountable_user_name: valueOrNull(row.host_name),
    assignment_state: accountableUserId ? "assigned" : "unassigned",
    owner_name: valueOrNull(row.host_name),
    owner_basis: accountableUserId ? "tour_host" : "unassigned",
    due_at: null,
    due_state: row.capture_state === "overdue" ? "overdue" : "none",
    created_at: toIsoOrNull(row.created_at),
    source: "tour_capture",
    tour_id: row.tour_id,
    conversation_id: valueOrNull(row.conversation_id),
    unit_id: valueOrNull(row.unit_id),
    lease_packet_id: null,
    lease_id: null,
    ...latestActivityFrom(row.activity_candidates),
  };
}

function identityKeys(row) {
  const keys = [];
  if (row && row.conversion_id) keys.push(`conversion:${row.conversion_id}`);
  if (row && row.application_id) keys.push(`application:${row.application_id}`);
  return keys;
}

const LEASING_STAGE_RANK = Object.freeze({ post_tour: 0, application: 1, lease_sent: 2 });

/* ONE RELATIONSHIP, ONE KEY — and the relationship is the DEAL, which the
   conversion identifies. One conversion can legitimately hold two applications
   (a re-application after a dead first attempt), and only the downstream one
   may show, so the application id can NEVER be the primary key. But an
   application row does not always carry its conversion — the Jordan Avery
   defect: his application row (application:A, no conversion) and the rail
   follow-up about him (conversion:C, application A) rendered as two rows in
   one tab. Rows carrying BOTH establish the alias application → conversion,
   and every row resolves through it before keying:
     conversion_id || alias[application_id] || application_id || desk_key.
   The stage-rank sort then keeps exactly one visible row per deal, downstream
   truth outranking upstream. */
function lifecycleAliases(rows) {
  const byApplication = new Map();
  for (const row of rows) {
    if (row && row.conversion_id && row.application_id) {
      byApplication.set(String(row.application_id), String(row.conversion_id));
    }
  }
  return byApplication;
}
function lifecycleRowKey(row, aliases) {
  const convId = row.conversion_id
    || (row.application_id ? aliases.get(String(row.application_id)) : null);
  if (convId) return `conversion:${convId}`;
  if (row.application_id) return `application:${row.application_id}`;
  return row.desk_key;
}

function dedupeLifecycleRows(rows) {
  const aliases = lifecycleAliases(rows);
  // Downstream truth outranks upstream truth for the same relationship. Within
  // one stage, the existing deterministic urgency order selects the visible row.
  const sorted = [...rows].sort((a, b) => {
    const stageDelta = (LEASING_STAGE_RANK[b.stage] ?? -1) - (LEASING_STAGE_RANK[a.stage] ?? -1);
    return stageDelta || compareRows(a, b);
  });
  const chosen = new Map();

  for (const row of sorted) {
    const key = lifecycleRowKey(row, aliases);

    if (!chosen.has(key)) {
      chosen.set(key, { ...row, related_open_count: 1 });
    } else {
      chosen.get(key).related_open_count += 1;
    }
  }
  return [...chosen.values()];
}

function isApplicationShadow(row) {
  return row && (row.display_shadow_of_application === true || APPLICATION_SHADOW_RUNGS.has(row.rung));
}

function compareRows(a, b) {
  const ar = DUE_RANK[a.due_state] ?? 4;
  const br = DUE_RANK[b.due_state] ?? 4;
  if (ar !== br) return ar - br;

  const ad = a.due_at ? Date.parse(a.due_at) : Number.POSITIVE_INFINITY;
  const bd = b.due_at ? Date.parse(b.due_at) : Number.POSITIVE_INFINITY;
  if (ad !== bd) return ad - bd;

  const ac = a.created_at ? Date.parse(a.created_at) : Number.POSITIVE_INFINITY;
  const bc = b.created_at ? Date.parse(b.created_at) : Number.POSITIVE_INFINITY;
  if (ac !== bc) return ac - bc;

  return a.desk_key.localeCompare(b.desk_key);
}

function normalizeClosedReceipt(row) {
  return {
    obligation_id: valueOrNull(row.obligation_id),
    conversion_id: valueOrNull(row.conversion_id),
    person_id: valueOrNull(row.person_id),
    person_name: valueOrNull(row.person_name),
    state_label: valueOrNull(row.label) || "Leasing work closed",
    resolution: valueOrNull(row.resolution),
    resolution_basis: valueOrNull(row.resolution_basis),
    closed_at: toIsoOrNull(row.closed_at),
    closed_by_name: valueOrNull(row.closed_by_name),
    reopenable: row.reopenable === true,
    not_reopenable_reason: row.reopenable === true ? null : valueOrNull(row.not_reopenable_reason),
  };
}

function composeLeasingDesk({
  propertyId,
  applicationRows = [],
  followupRows = [],
  tourCaptureRows = [],
  tourCaptureUntrackable = 0,
  recentlyClosedRows = [],
  recentlyClosedWindowHours = 72,
  generatedAt = new Date(),
} = {}) {
  if (!propertyId) throw new Error("composeLeasingDesk requires propertyId.");
  if (!Array.isArray(applicationRows) || !Array.isArray(followupRows) || !Array.isArray(recentlyClosedRows)) {
    throw new TypeError("Leasing Desk sources must be arrays.");
  }
  if (!Array.isArray(tourCaptureRows)) {
    throw new TypeError("Leasing Desk sources must be arrays.");
  }

  const applications = applicationRows.map(normalizeApplicationRow).filter(Boolean);

  // Suppression identity: an application deal is addressable by EITHER its
  // conversion or its application id. A shadow rung may carry only one of the
  // two (e.g. an application row with no conversion_id, whose shadow rung keys
  // by conversion). Matching on a single derived deal_key silently fails in
  // that case and the deal renders twice — so suppression checks every key the
  // application legitimately answers to.
  const applicationSuppressKeys = new Set();
  for (const row of applications) {
    if (row.application_id) applicationSuppressKeys.add(`application:${row.application_id}`);
    if (row.conversion_id) applicationSuppressKeys.add(`conversion:${row.conversion_id}`);
  }
  function shadowMatchesApplication(row) {
    if (row && row.conversion_id && applicationSuppressKeys.has(`conversion:${row.conversion_id}`)) return true;
    if (row && row.application_id && applicationSuppressKeys.has(`application:${row.application_id}`)) return true;
    return false;
  }

  const followups = followupRows
    .filter((row) => !(shadowMatchesApplication(row) && isApplicationShadow(row)))
    .map(normalizeFollowupRow);


  // The new operator projection: one relationship in exactly one lifecycle tab.
  // It is additive; legacy `bands` remain below during the API→app rolling deploy.
  const stageApplications = applicationRows
    .map(normalizeStageApplicationRow)
    .filter(Boolean);

  // Application Review remains the stronger lifecycle authority even when its
  // answer is "this relationship has exited Leasing." Build suppression keys
  // from every resolver-backed application row, not only rows that remain in a
  // visible stage; otherwise an active/term-confirmed application could leak
  // back into Application through the rail's coarse `approved` substatus.
  const applicationAuthorityKeys = new Set();
  for (const row of applicationRows) {
    if (!row || !row.next_action || !row.next_action.code) continue;
    for (const key of identityKeys(row)) applicationAuthorityKeys.add(key);
  }

  function followupHasApplicationAuthority(row) {
    return identityKeys(row).some((key) => applicationAuthorityKeys.has(key));
  }

  // The rail remains the authority for Post-tour and invitation-only waiting,
  // before a resolver-backed application row exists.
  const stageFollowups = followupRows
    .filter((row) => !followupHasApplicationAuthority(row))
    .map(normalizeStageFollowupRow)
    .filter(Boolean);

  const stageTourCaptures = tourCaptureRows.map(normalizeTourCaptureRow).filter(Boolean);

  const allStageRows = dedupeLifecycleRows([...stageApplications, ...stageFollowups, ...stageTourCaptures]);
  const stages = {
    post_tour: allStageRows.filter((row) => row.stage === "post_tour").sort(compareRows),
    application: allStageRows.filter((row) => row.stage === "application").sort(compareRows),
    lease_sent: allStageRows.filter((row) => row.stage === "lease_sent").sort(compareRows),
  };
  const stage_counts = {
    post_tour: stages.post_tour.length,
    application: stages.application.length,
    lease_sent: stages.lease_sent.length,
    total: stages.post_tour.length + stages.application.length + stages.lease_sent.length,
  };

  // S4: the operating counts the home card and the destination BOTH read —
  // derived from the same deduped rail rows the destination renders, so the
  // two surfaces reconcile by construction. Legacy `counts` below still
  // describes the pre-S4 bands during the rolling deploy.
  const operating_counts = {
    total_active: allStageRows.length,
    waiting: allStageRows.filter((row) => row.operating_state === "waiting").length,
    blocked: allStageRows.filter((row) => row.operating_state === "blocked").length,
    due_today: allStageRows.filter((row) => row.due_state === "today").length,
    overdue: allStageRows.filter((row) => row.due_state === "overdue").length,
    unassigned: allStageRows.filter((row) => row.assignment_state === "unassigned").length,
  };

  const bands = {
    ready_to_bind: applications.filter((row) => row.band === "ready_to_bind").sort(compareRows),
    ready_to_advance: applications.filter((row) => row.band === "ready_to_advance").sort(compareRows),
    follow_ups: followups.sort(compareRows),
  };

  const all = [...bands.ready_to_bind, ...bands.ready_to_advance, ...bands.follow_ups];
  const counts = {
    actionable: all.length,
    due_today: all.filter((row) => row.due_state === "today").length,
    overdue: all.filter((row) => row.due_state === "overdue").length,
    unassigned: all.filter((row) => !row.owner_name).length,
  };

  return {
    property_id: propertyId,
    generated_at: new Date(generatedAt).toISOString(),
    stages,
    stage_counts,
    stage_labels: LEASING_STAGE_LABELS,
    operating_counts,
    // Honest visibility for the capture set the rail does NOT show: tours the
    // canonical resolver cannot time (untrackable) are repaired on the Tours
    // board, but their count must never silently read as "nothing owed".
    tour_capture: {
      owed_shown: stageTourCaptures.length,
      untrackable_not_shown: Number(tourCaptureUntrackable) || 0,
    },
    bands,
    counts,
    receipts: {
      recently_closed: {
        window_hours: recentlyClosedWindowHours,
        items: recentlyClosedRows.map(normalizeClosedReceipt),
      },
    },
  };
}

module.exports = {
  composeLeasingDesk,
  compareRows,
  dealKey,
  isApplicationShadow,
  READY_TO_BIND_CODES,
  READY_TO_ADVANCE_CODES,
  OMITTED_APPLICATION_CODES,
  APPLICATION_SHADOW_RUNGS,
  COMMUNICATION_MOVE_CODES,
  LEASE_SENT_STAGE_CODES,
  EXITED_LEASING_CODES,
  LEASING_STAGE_CODES,
  LEASING_STAGE_LABELS,
  WAITING_PARTY_BY_CODE,
  BLOCKER_LABELS,
  blockerLabelFor,
  latestActivityFrom,
  normalizeTourCaptureRow,
  stageForApplicationNext,
  stageForFollowup,
  dedupeLifecycleRows,
  normalizeApplicationAction,
  normalizeFollowupAction,
  normalizeStageApplicationAction,
  unsupportedFollowupAction,
  blockedFollowupAction,
};
