// ════════════════════════════════════════════════════════════════════
//  inbound_opportunity_decision.js — "OPPORTUNITY SELECTION REQUIRED".
//
//  THE SEAM THIS CLOSES. A prospect replies after their opportunity was closed.
//  The reply names a CONVERSATION, not an opportunity, and one conversation
//  covers every opportunity that person has at that property — so the system
//  may not choose one and reopen it. It refuses (migration 128).
//
//  But refusing is not enough. Proven before this module existed: after the
//  refusal the message was stored, no lifecycle event was written, NO obligation
//  existed, and the queue projection classified the conversation
//  `commercial_state='closed_not_fit'` with `waiting_on='none'` — literally
//  nobody owned the next action. The reply was durable and invisible.
//
//  So the refusal now OPENS AN EXPLICIT DECISION:
//
//      "This person replied after the opportunity was closed.
//       Choose which opportunity this reply belongs to."
//
//  The operator never needs to know what a conversation grain, a conversion_id
//  or a lifecycle event is.
//
//  ── NO NEW PRIMITIVE ─────────────────────────────────────────────────
//  This uses the CANONICAL obligation engine (spawnObligationFromEvent) and the
//  CANONICAL lifecycle service (reopenInTransaction). No new table, no second
//  task system, no CRM workflow, no generic timeline. The obligation carries
//  property, person, conversation, the inbound source event, an explicit owner
//  or UNASSIGNED, created/due times, the exact proof required, and — through the
//  engine's own history — correction and reassignment.
//
//  ── IT NEVER CARRIES A GUESSED conversion_id ─────────────────────────
//  The obligation is deliberately NOT written into leasing_conversion_obligations,
//  because that table requires a conversion_id we do not have and may not
//  invent. It links to the CONVERSATION until a human names the opportunity.
// ════════════════════════════════════════════════════════════════════
"use strict";

const { spawnObligationFromEvent, satisfyObligation, completeObligation } =
  require("../shared/obligation_engine");

const DECISION_TYPE = "resolve_inbound_opportunity";
const DECISION_INPUT = "opportunity_selected";
const DECISION_MODULE = "leasing";

//  What the operator is shown. No jargon: no "conversion", no "grain", no
//  "lifecycle event".
const DECISION_LABEL = "Choose which opportunity this reply belongs to";
const DECISION_DETAIL =
  "This person replied after the opportunity was closed. Choose which opportunity this reply belongs to.";

/**
 * openInboundOpportunityDecision — called from inside the inbound transaction
 * when attribution was refused. Idempotent: a duplicate delivery of the same
 * inbound converges on ONE decision via the engine's dedupe_key.
 */
async function openInboundOpportunityDecision(client, {
  property_id, person_id, conversation_id, source_comm_event_id,
  assigned_user_id = null, due_at = null,
} = {}) {
  if (!property_id || !conversation_id) {
    throw new Error("openInboundOpportunityDecision requires server-derived property_id and conversation_id");
  }

  //  Stable per inbound message. A retry, a webhook replay or a concurrent
  //  double-delivery all converge on the one decision.
  const dedupe_key = source_comm_event_id
    ? `resolve_inbound_opportunity:${source_comm_event_id}`
    : `resolve_inbound_opportunity:conversation:${conversation_id}`;

  const existing = (await client.query(
    `select id, status, assigned_user_id from obligations where dedupe_key = $1`, [dedupe_key])).rows[0];
  if (existing) {
    return { ok: true, created: false, obligation_id: existing.id, dedupe_key,
             inbound_comm_event_id: source_comm_event_id || null };
  }

  //  ── A REAL SCHEMA LIMITATION, STATED RATHER THAN FUDGED ──────────
  //  obligations.source_event_id references `events`, NOT `comm_events`, and
  //  obligations carries no comm-event column and no metadata jsonb. Writing
  //  the inbound id there would either violate the FK or claim a reference to a
  //  different object. So source_event_id stays NULL and the inbound message is
  //  carried by the dedupe_key, which is stable, durable and parseable
  //  (`resolve_inbound_opportunity:<comm_event_id>`), and is repeated in the
  //  resolution proof. Promotion condition: if obligations ever gains a
  //  comm-event reference, move it there and delete this note.
  const ob = await spawnObligationFromEvent(client, {
    property_id, person_id,
    source_event_id: null,
    module: DECISION_MODULE,
    type: DECISION_TYPE,
    label: DECISION_LABEL,
    owner_type: "human",
    status: "open",
    priority: "high",         // a live prospect is waiting on a human decision
    severity: "normal",
    due_at,
    required_inputs: [DECISION_INPUT],
    //  Linked to the CONVERSATION — never to a guessed opportunity.
    related_id: conversation_id,
    related_type: "conversation",
    //  OWNERSHIP IS EXPLICIT EITHER WAY. Never silently ownerless.
    assigned_user_id: assigned_user_id || null,
    ownership_origin: assigned_user_id ? "explicit_choice" : null,
    owner_eligibility_state: assigned_user_id ? "eligible_assignment" : "unassigned",
    dedupe_key,
  });

  return { ok: true, created: true, obligation_id: ob.id, dedupe_key,
           inbound_comm_event_id: source_comm_event_id || null,
           owner: assigned_user_id || "UNASSIGNED" };
}

/**
 * listOpportunityCandidates — EXACT candidates, for a human to choose from.
 *
 * The server may offer candidates. It may NOT select one. There is deliberately
 * no ordering that could be mistaken for a recommendation and no "best match":
 * candidates come back in stable opened_at order with the facts a human needs,
 * and ONE candidate is still a human confirmation.
 *
 * Property-walled. A candidate at another property is structurally excluded.
 */
async function listOpportunityCandidates(q, { property_id, conversation_id } = {}) {
  if (!property_id || !conversation_id) {
    throw new Error("listOpportunityCandidates requires server-derived property_id and conversation_id");
  }
  const conv = (await q.query(
    `select id, property_id, person_id from conversations where id = $1`, [conversation_id])).rows[0];
  if (!conv) return { ok: false, refusal_code: "conversation_not_found", candidates: [] };
  if (String(conv.property_id) !== String(property_id)) {
    return { ok: false, refusal_code: "conversation_not_at_property", candidates: [] };
  }

  const rows = (await q.query(
    `select lc.id, lc.opened_at, lc.closed_at, lc.current_stage, lc.status,
            (select max(e.event_sequence) from leasing_lead_lifecycle_events e
              where e.conversion_id = lc.id and e.event_type = 'closed_not_fit') as close_seq,
            (select max(e.event_sequence) from leasing_lead_lifecycle_events e
              where e.conversion_id = lc.id and e.event_type = 'reopened') as reopen_seq,
            (select e.reason_code from leasing_lead_lifecycle_events e
              where e.conversion_id = lc.id and e.event_type = 'closed_not_fit'
              order by e.event_sequence desc limit 1) as last_close_reason
       from leasing_conversions lc
      where lc.property_id = $1 and lc.person_id = $2
      order by lc.opened_at asc, lc.id asc`,
    [property_id, conv.person_id])).rows;

  const candidates = rows.map((r) => ({
    opportunity_id: r.id,
    opened_at: r.opened_at,
    current_stage: r.current_stage,
    //  Terminal state from EVENTS, so the operator chooses against the same
    //  truth the rest of the system uses — never the mutable label.
    closed_by_event: r.close_seq !== null
      && (r.reopen_seq === null || Number(r.reopen_seq) < Number(r.close_seq)),
    last_close_reason: r.last_close_reason || null,
  }));

  return {
    ok: true,
    property_id, conversation_id, person_id: conv.person_id,
    candidate_count: candidates.length,
    candidates,
    //  STATED, so no caller can mistake this for a resolved answer.
    selection_required: true,
    auto_selected: null,
    note: candidates.length === 0
      ? "No opportunity exists for this person at this property. The decision stays open and visible; it is not resolvable by choosing nothing."
      : "Candidates are offered for human selection only. Even a single candidate requires explicit confirmation — the server never selects.",
  };
}

/**
 * resolveInboundOpportunityDecision — the operator has named the opportunity.
 *
 * Order matters: reopen FIRST, close the decision only if the reopen succeeded.
 * A failed reopen must leave the decision visible rather than closing it on a
 * promise.
 */
async function resolveInboundOpportunityDecision(client, {
  obligation_id, conversation_id, property_id, conversion_id,
  actor_user_id, source_comm_event_id = null, lifecycleService,
} = {}) {
  if (!conversion_id) {
    return { ok: false, refusal_code: "opportunity_selection_required", httpStatus: 400,
             refusal_reason: "Choose which opportunity this reply belongs to. The system will not choose one." };
  }
  if (!actor_user_id) {
    return { ok: false, refusal_code: "actor_required", httpStatus: 400,
             refusal_reason: "A person must be accountable for this decision." };
  }
  if (!lifecycleService || typeof lifecycleService.reopenInTransaction !== "function") {
    throw new Error("resolveInboundOpportunityDecision requires the canonical lifecycle service");
  }

  //  1 + 2 · REOPEN THE EXACT OPPORTUNITY through the existing service. It
  //  re-validates property and person, and refuses a foreign opportunity. The
  //  original terminal event is never mutated or deleted — the reopen is a NEW
  //  append-only event.
  let reopened;
  try {
    reopened = await lifecycleService.reopenInTransaction(client, {
      conversationId: conversation_id, propertyId: property_id,
      conversionId: conversion_id, actorType: "operator", actorUserId: actor_user_id,
      sourceCommEventId: source_comm_event_id,
      idempotencyKey: source_comm_event_id
        ? `reopen_decision:${source_comm_event_id}:${conversion_id}`
        : undefined,
    });
  } catch (e) {
    //  FAILURE BEHAVIOUR: the decision stays open, owned and visible, with the
    //  exact blocked reason. Nothing is marked handled.
    return {
      ok: false, decision_remains_open: true,
      refusal_code: e.code || "reopen_failed",
      httpStatus: e.httpStatus || 500,
      refusal_reason: e.publicMessage || e.message,
      obligation_id,
    };
  }

  //  3 · CLOSE THE DECISION WITH PROOF — the attributed decision and actor.
  if (obligation_id) {
    await satisfyObligation(client, {
      obligation_id, input: DECISION_INPUT,
      proof: {
        selected_opportunity_id: String(conversion_id),
        selected_by_user_id: String(actor_user_id),
        reopen_event_id: reopened.event ? String(reopened.event.id) : null,
        source_comm_event_id: source_comm_event_id ? String(source_comm_event_id) : null,
        basis: "explicit_human_selection",
      },
    });
    await completeObligation(client, { obligation_id, completed_by: actor_user_id });
  }

  return {
    ok: true,
    obligation_id,
    opportunity_id: String(conversion_id),
    reopen_event_id: reopened.event ? reopened.event.id : null,
    selected_by_user_id: actor_user_id,
    receipt: "Reply attributed and the opportunity reopened.",
  };
}

/** inboundEventIdOf — read the inbound message a decision was raised for. */
function inboundEventIdOf(obligationRow) {
  const k = obligationRow && obligationRow.dedupe_key;
  if (!k || !String(k).startsWith("resolve_inbound_opportunity:")) return null;
  const rest = String(k).slice("resolve_inbound_opportunity:".length);
  return rest.startsWith("conversation:") ? null : rest;
}

module.exports = {
  openInboundOpportunityDecision, inboundEventIdOf,
  listOpportunityCandidates,
  resolveInboundOpportunityDecision,
  DECISION_TYPE, DECISION_INPUT, DECISION_LABEL, DECISION_DETAIL,
};
