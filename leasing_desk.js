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
  // proves: tenant signed AND company countersignature is available. Add a code
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
const LEASE_SENT_STAGE_CODES = new Set([
  "executed_lease_required",
  "verify_executed_lease",
  "review_conflict",
  "confirm_term",
]);

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
  throw new Error("Leasing Desk row requires conversion_id, application_id, or obligation_id.");
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
  const blocked = next.state === "blocked";
  let label = "Review application";
  if (blocked) label = "Review blocker";
  else if (next.code === "confirm_proposed_terms") label = "Continue terms review";
  else if (next.code === "generate_terms_review_packet") label = "Generate review packet";
  else if (next.code === "issue_terms_review_link") label = "Review and issue";
  else if (READY_TO_BIND_CODES.has(next.code)) label = "Review and countersign";

  return {
    code: blocked ? "review_application_blocker" : "open_application_review",
    label,
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
// rail's actual next_move_code vocabulary before the loader ships (Rule 11);
// unlisted codes fall to Complete, so a missing entry is safe, never wrong.
const COMMUNICATION_MOVE_CODES = new Set([
  "send_follow_up",
  "call_prospect",
  "message_prospect",
  "send_floor_plans",
  "schedule_second_tour",
]);

function normalizeFollowupAction(row) {
  const code = valueOrNull(row.next_move_code);

  if (code === "send_application") {
    const conversionId = valueOrNull(row.conversion_id);
    if (!conversionId) {
      throw new Error("send_application requires conversion_id.");
    }
    return {
      code: "send_application",
      label: valueOrNull(row.next_move_label) || "Send application",
      kind: "task_write",
      target: { type: "conversion", id: conversionId },
    };
  }

  // Communication-oriented move with a known person → open the conversation.
  // Without a person_id there is nothing to open; fall through to Complete.
  if (code && COMMUNICATION_MOVE_CODES.has(code) && valueOrNull(row.person_id)) {
    return {
      code: "open_conversation",
      label: valueOrNull(row.next_move_label) || "Open conversation",
      kind: "navigation",
      target: { type: "person", id: row.person_id },
    };
  }

  // Unknown generic obligation → Complete, which opens the confirmation sheet.
  return {
    code: "complete_task",
    label: "Complete",
    kind: "task_write",
    target: { type: "obligation", id: row.obligation_id },
  };
}

function normalizeFollowupRow(row) {
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
    blocker_code: null,
    next_action_code: valueOrNull(row.next_move_code),
    primary_action: normalizeFollowupAction(row),
    owner_name: valueOrNull(row.owner_name),
    owner_basis: valueOrNull(row.owner_basis) || "unassigned",
    due_at: toIsoOrNull(row.due_at),
    due_state: valueOrNull(row.due_state) || "none",
    created_at: toIsoOrNull(row.created_at),
    source: "followup_rail",
    rung: valueOrNull(row.rung),
  };
}


function stageForApplicationNext(next) {
  if (!next || !next.code) return null;
  if (next.state === "complete" || EXITED_LEASING_CODES.has(next.code)) return null;
  if (LEASE_SENT_STAGE_CODES.has(next.code)) return "lease_sent";
  return "application";
}

function normalizeStageApplicationAction(row, next) {
  const base = normalizeApplicationAction(row, next);
  const labels = {
    executed_lease_required: "Record executed lease",
    verify_executed_lease: "Record executed lease",
    review_conflict: "Review conflict",
    confirm_term: "Confirm lease term",
    await_resident_acknowledgment: "Open application",
    awaiting_acknowledgment: "Open application",
  };
  return { ...base, label: labels[next.code] || base.label };
}

function normalizeStageApplicationRow(row) {
  const next = row && row.next_action;
  const stage = stageForApplicationNext(next);
  if (!stage) return null;

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
    state_code: next.state || "available",
    state_label: valueOrNull(next.label) || "Application in progress.",
    blocker_code: valueOrNull(next.blocker_code),
    next_action_code: next.code,
    primary_action: normalizeStageApplicationAction(row, next),
    owner_name: valueOrNull(row.owner_name),
    owner_basis: valueOrNull(row.owner_basis),
    due_at: toIsoOrNull(row.due_at),
    due_state: valueOrNull(row.due_state),
    created_at: toIsoOrNull(row.created_at),
    source: "application_lifecycle",
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

function identityKeys(row) {
  const keys = [];
  if (row && row.conversion_id) keys.push(`conversion:${row.conversion_id}`);
  if (row && row.application_id) keys.push(`application:${row.application_id}`);
  return keys;
}

const LEASING_STAGE_RANK = Object.freeze({ post_tour: 0, application: 1, lease_sent: 2 });

function dedupeLifecycleRows(rows) {
  // Downstream truth outranks upstream truth for the same relationship. Within
  // one stage, the existing deterministic urgency order selects the visible row.
  const sorted = [...rows].sort((a, b) => {
    const stageDelta = (LEASING_STAGE_RANK[b.stage] ?? -1) - (LEASING_STAGE_RANK[a.stage] ?? -1);
    return stageDelta || compareRows(a, b);
  });
  const chosen = new Map();

  for (const row of sorted) {
    const key = row.conversion_id
      ? `conversion:${row.conversion_id}`
      : row.application_id
        ? `application:${row.application_id}`
        : row.desk_key;

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
  recentlyClosedRows = [],
  recentlyClosedWindowHours = 72,
  generatedAt = new Date(),
} = {}) {
  if (!propertyId) throw new Error("composeLeasingDesk requires propertyId.");
  if (!Array.isArray(applicationRows) || !Array.isArray(followupRows) || !Array.isArray(recentlyClosedRows)) {
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

  const allStageRows = dedupeLifecycleRows([...stageApplications, ...stageFollowups]);
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
  stageForApplicationNext,
  stageForFollowup,
  dedupeLifecycleRows,
};
