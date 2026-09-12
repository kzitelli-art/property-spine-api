"use strict";

/**
 * PROPERTY SPINE — SEND APPLICATION FROM CONVERSION COMMAND
 *
 * This module is an application-command orchestrator, not a second domain
 * authority. It calls the existing canonical services in order:
 *
 *   recordApplicationIntent
 *     -> prepareApplicationLinkForObligation
 *     -> dispatchPreparedLinkProvider
 *
 * The caller owns the database transaction around stageApplicationSend().
 * dispatchApplicationSend() runs only after that transaction commits because
 * provider I/O cannot be part of a PostgreSQL transaction.
 */

function commandError(status, message, code) {
  const error = new Error(message);
  error.httpStatus = status;
  error.publicMessage = message;
  if (code) error.code = code;
  return error;
}

function requireFunction(object, name, label) {
  if (!object || typeof object[name] !== "function") {
    throw commandError(503, `${label || name} is unavailable.`, "SERVICE_UNAVAILABLE");
  }
  return object[name].bind(object);
}

function requiredString(value, name) {
  const normalized = value == null ? "" : String(value).trim();
  if (!normalized) throw commandError(400, `${name} is required.`, "INVALID_COMMAND");
  return normalized;
}

/**
 * Database phase. The route must call this inside one open transaction.
 *
 * Intent and preparation therefore commit or roll back together. The prepare
 * child id is always server-produced; the browser never supplies it.
 */
async function stageApplicationSend(client, deps, input) {
  if (!client || typeof client.query !== "function") {
    throw commandError(500, "A transaction client is required.", "CLIENT_REQUIRED");
  }

  const conversionService = deps && deps.conversionService;
  const applicationInvitations = deps && deps.applicationInvitations;
  const recordIntent = requireFunction(
    conversionService,
    "recordApplicationIntent",
    "Application-intent service"
  );
  const prepareLink = requireFunction(
    applicationInvitations,
    "prepareApplicationLinkForObligation",
    "Application-link preparation service"
  );

  const conversionId = requiredString(input && input.conversionId, "conversionId");
  const actorUserId = requiredString(input && input.actorUserId, "actorUserId");
  const unitId = requiredString(input && input.unitId, "unit_id");
  const spaceId = input && input.spaceId != null
    ? requiredString(input.spaceId, "space_id")
    : null;
  const intendedMoveIn = input && input.intendedMoveIn != null
    ? requiredString(input.intendedMoveIn, "intended_move_in")
    : null;
  const idempotencyKey = requiredString(
    input && input.idempotencyKey,
    "idempotency_key"
  );

  if (input.deliveryMethod === "manual_email") {
    // Digest-only tokens cannot be replayed. Preserve the existing invitation
    // and expose its governed correction door, never mint a replacement here.
    const prior = (await client.query(`select ai.*, o.id as send_obligation_id, o.assigned_user_id, p.email
      from application_invitations ai join persons p on p.id=ai.person_id
      left join obligations o on o.related_type='application_invitation' and o.related_id=ai.id
        and o.type='send_application_link'
      where ai.conversion_id=$1 order by ai.created_at desc limit 1`, [conversionId])).rows[0];
    if (prior) {
      const basis = await requireFunction(conversionService, "resolveSendActionBasis")(client, {
        actor_user_id: actorUserId, property_id: prior.property_id, stored_owner_user_id: prior.assigned_user_id,
      });
      if (!basis.allowed) throw commandError(403, "You do not own this work or hold its covering role.", "APPLICATION_SEND_FORBIDDEN");
      const conflict = String(prior.unit_id) !== unitId || (spaceId && String(prior.space_id) !== spaceId)
        || (input.applicationOfferId && String(prior.application_offer_id) !== String(input.applicationOfferId))
        || (input.expiresAt != null && new Date(prior.expires_at).getTime() !== new Date(input.expiresAt).getTime())
        || (intendedMoveIn && String(prior.intended_move_in instanceof Date ? prior.intended_move_in.toISOString().slice(0,10) : prior.intended_move_in).slice(0,10) !== intendedMoveIn.slice(0,10));
      const error = commandError(409, conflict
        ? "An invitation already exists with different home or terms. Review its existing correction action."
        : "The application link was already prepared and is returned only once. Use its existing recovery action if the link was lost.",
        conflict ? "APPLICATION_PREPARATION_CONFLICT" : "APPLICATION_LINK_ALREADY_PREPARED");
      error.recovery = { invitation_id: prior.id, send_obligation_id: prior.send_obligation_id,
        conversion_id: conversionId, delivery_method: "manual_email", link: null,
        prepared: prior.status === "prepared", sent: false, dispatched: false, recipient_snapshot: prior.email, email: prior.email,
        invitation_status: prior.status, recovery_action: prior.status === "prepared" ? "regenerate" : "review_existing_invitation" };
      throw error;
    }
  }

  const intent = await recordIntent(client, {
    conversion_id: conversionId,
    source: "operator_recorded",
    recorded_by_user_id: actorUserId,
    idempotency_key: idempotencyKey,
    evidence_type: (input && input.evidenceType) || null,
    evidence_ref: (input && input.evidenceRef) || null,
  });

  const prepareObligationId =
    intent && intent.obligation && intent.obligation.id
      ? String(intent.obligation.id)
      : null;

  if (!prepareObligationId) {
    throw commandError(
      500,
      "Application intent did not return its prepare commitment.",
      "PREPARE_COMMITMENT_MISSING"
    );
  }

  const prepared = await prepareLink(client, {
    prepare_obligation_id: prepareObligationId,
    unit_id: unitId,
    space_id: spaceId,
    intended_move_in: intendedMoveIn,
    expires_at: (input && input.expiresAt) || null,
    actor_user_id: actorUserId,
    unitOfferable: input && input.unitOfferable,
    application_offer_id: input && input.applicationOfferId,
  });

  if (!prepared || !prepared.invitation_id || !prepared.token) {
    throw commandError(
      500,
      "Application-link preparation returned an incomplete result.",
      "PREPARE_RESULT_INCOMPLETE"
    );
  }

  return {
    conversion_id: conversionId,
    unit_id: unitId,
    space_id: prepared.space_id || spaceId || null,
    intended_move_in: prepared.intended_move_in || intendedMoveIn || null,
    intent_id: intent && intent.intent ? intent.intent.id || null : null,
    recorded_intent: !!(intent && intent.recorded),
    prepare_obligation_id: prepareObligationId,
    parent_obligation_id:
      prepared.parent_obligation_id ||
      (intent && intent.obligation
        ? intent.obligation.parent_obligation_id || null
        : null),
    invitation_id: prepared.invitation_id,
    send_obligation_id: prepared.send_obligation_id || null,
    token: prepared.token,
    prepared,
  };
}

/**
 * Provider phase. This delegates to the existing save-first / wire / finalize
 * service. The response adds `sent` as a compatibility field for the browser,
 * while preserving the canonical `dispatched` fact.
 */
async function dispatchApplicationSend(deps, staged, input) {
  const applicationInvitations = deps && deps.applicationInvitations;
  const dispatch = requireFunction(
    applicationInvitations,
    "dispatchPreparedLinkProvider",
    "Application-link dispatch service"
  );

  if (!staged || !staged.invitation_id || !staged.token) {
    throw commandError(500, "A staged invitation is required.", "STAGED_INVITATION_REQUIRED");
  }

  const actorUserId = requiredString(input && input.actorUserId, "actorUserId");

  const out = await dispatch({
    invitation_id: staged.invitation_id,
    raw_token: staged.token,
    actor_user_id: actorUserId,
    message_prefix: (input && input.messagePrefix) || "",
  });

  const dispatched = !!(out && out.dispatched);
  return {
    ...(out || {}),
    sent: dispatched,
    dispatched,
    conversion_id: staged.conversion_id,
    unit_id: staged.unit_id,
    space_id: staged.space_id || null,
    intended_move_in: staged.intended_move_in || null,
    intent_id: staged.intent_id,
    recorded_intent: staged.recorded_intent,
    prepare_obligation_id: staged.prepare_obligation_id,
    parent_obligation_id: staged.parent_obligation_id,
    invitation_id:
      (out && out.invitation_id) || staged.invitation_id,
    send_obligation_id:
      (out && out.send_obligation_id) || staged.send_obligation_id || null,
  };
}

module.exports = {
  stageApplicationSend,
  dispatchApplicationSend,
  _private: { commandError, requiredString },
};
