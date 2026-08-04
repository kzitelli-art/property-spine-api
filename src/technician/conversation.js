/* ════════════════════════════════════════════════════════════════════
   technician/conversation.js — THE OPERATIONS-LINE TURN.

   One inbound message from an authenticated technician becomes: a durable
   inbound record on a staff thread, a governed decision, at most one
   canonical write, an operating receipt, and a reply-bound outbound
   INTENT. Transport happens afterwards, outside the transaction, and
   never revises any of it.

   ── THE ORDER IS THE POINT (owner ruling 2026-08-04) ────────────────

       inbound recorded
         → identity and property authority resolved
         → canonical service validates and commits
         → operating receipt composed FROM THE COMMITTED RESULT
         → outbound reply intent persisted
         → COMMIT
         → transport attempted
         → delivery result persisted separately

   Everything up to COMMIT is one transaction, so a failure leaves the
   inbound preserved and nothing half-done. Everything after it can fail
   without touching what was committed. `Acceptance recorded.` is composed
   after the write and sent after the commit — never before either.

   ── WHAT THIS FILE MAY NOT DO ───────────────────────────────────────

   · decide eligibility (work_selection.js does, and the service re-decides
     against the locked row);
   · write an acceptance (acceptance_service.js does, and it is the only
     writer);
   · compose resident-facing or technician-facing prose (receipt.js does);
   · resolve which work was meant (work_reference.js does);
   · send anything (the boundary does, under the line's policy).

   It sequences. That is all it is for, and keeping it that thin is what
   lets every decision above be proven without a database.
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const workSelection = require("./work_selection");
const workReference = require("../conversation/work_reference");
const { acceptWork } = require("./acceptance_service");
const { operatingReceipt } = require("../conversation/receipt");

/*  The technician's intent, narrowly. This build understands ONE verb.
 *  Anything else is not guessed at — an unrecognised message asks which
 *  work they mean rather than inventing an action for it. */
const ACCEPT_RX = /\b(accept|accepted|accepting|i'?ll take|ill take|taking|take it|got it|on it|mine)\b/i;

function readsAsAcceptance(body) {
  return ACCEPT_RX.test(String(body || ""));
}

/*  The staff coordination thread for (organization, user). Upserted, not
 *  created blindly: one thread per technician per organization, which is
 *  what makes "the existing thread" a fact rather than a new row each time. */
async function staffThreadFor(client, { organizationId, userId }) {
  const r = await client.query(
    `insert into staff_threads (organization_id, user_id)
     values ($1,$2)
     on conflict (organization_id, user_id) do update set last_message_at = now()
     returning id`, [organizationId, userId]);
  return r.rows[0].id;
}

/*  The actor's own active properties inside this organization. Server-derived
 *  here so the candidate read below is already scoped; the canonical service
 *  derives it AGAIN against the locked row and does not trust this. */
async function actorScope(client, { organizationId, userId }) {
  const { rows } = await client.query(
    `select distinct p.id
       from property_team_assignments pta
       join properties p on p.id = pta.property_id and p.organization_id = $2
      where pta.user_id = $1 and pta.active = true
      order by p.id`, [userId, organizationId]);
  return rows.map((r) => r.id);
}

/*  Candidate work. Scoped to the actor's own properties in SQL — the pure
 *  module verifies the same thing again, but a read that returns another
 *  building's rows at all is a read that can leak one. */
async function candidateWork(client, { userId, propertyIds }) {
  if (!propertyIds.length) return [];
  const { rows } = await client.query(
    `select o.id            as obligation_id,
            o.related_id    as work_order_id,
            o.related_type,
            o.property_id,
            o.assigned_user_id,
            o.accepted_by_user_id,
            o.status,
            w.work_order_ref,
            w.title
       from obligations o
       join work_orders w on w.id = o.related_id and w.property_id = o.property_id
      where o.assigned_user_id = $1
        and o.related_type = 'work_order'
        and o.property_id = any($2::uuid[])
        and o.status in ('open','in_progress')
      order by w.work_order_ref`, [userId, propertyIds]);
  return rows;
}

/*  Work orders already active in this thread — the second governed
 *  reference source. Being discussed here is not authority; these ids are
 *  intersected with the authorized set before anything is selected. */
async function threadWorkOrderIds(client, { staffThreadId }) {
  const { rows } = await client.query(
    `select distinct created_object_id as id
       from comm_events
      where staff_thread_id = $1
        and created_object_type = 'work_order'
        and created_object_id is not null`, [staffThreadId]);
  return rows.map((r) => r.id);
}

/*  ── THE TURN ───────────────────────────────────────────────────────
 *  Runs inside ONE transaction owned by the caller. Returns the operating
 *  receipt and the outbound intent; the caller performs transport AFTER
 *  the commit and records delivery separately.
 */
async function runOperationsTurn(client, {
  organizationId, userId, lineId, body, providerMessageId,
}) {
  const threadId = await staffThreadFor(client, { organizationId, userId });

  //  T1-equivalent: the claim is durable before any interpretation.
  //  needs_human starts TRUE and is cleared only by a decision that
  //  actually committed — the same inversion the resident spine uses.
  const inbound = (await client.query(
    `insert into comm_events (channel, direction, body, communication_line_id, staff_thread_id,
       actor_user_id, sms_sid, needs_human)
     values ('sms','inbound',$1,$2,$3,$4,$5,true) returning id`,
    [body, lineId, threadId, userId, providerMessageId || null])).rows[0];

  const propertyIds = await actorScope(client, { organizationId, userId });
  const candidates = await candidateWork(client, { userId, propertyIds });
  const authorized = workSelection.offerableWork({
    actor: { userId, organizationId, assignedPropertyIds: propertyIds },
    candidates,
  }).offerable;

  const resolution = workReference.resolveWorkReference({
    authorized,
    claim: workReference.extractReference(body),
    threadWorkOrderIds: await threadWorkOrderIds(client, { staffThreadId: threadId }),
  });

  let receipt, reason, createdObject = null;

  if (resolution.outcome !== "one" || !readsAsAcceptance(body)) {
    //  Nothing is written. Either which work they meant is not established,
    //  or they said something this build does not understand as a verb —
    //  and a message that does not clearly ask for an action never gets one.
    const clarification = workReference.clarificationForReference(
      resolution.outcome === "one"
        ? { outcome: "no_reference" }     // work is clear; the request is not
        : resolution,
      authorized);
    receipt = operatingReceipt({
      outcome: "work_reference_needed",
      result: { question: clarification.question, reason: clarification.reason },
    });
    reason = "clarification";
  } else {
    const selected = resolution.selected;
    const out = await acceptWork(client, {
      obligation_id: selected.obligation_id,
      user_id: userId,
      organization_id: organizationId,
      acceptance_key: providerMessageId || null,
      channel: "sms",
    });

    if (out.outcome === "refused") {
      receipt = operatingReceipt({ outcome: "authorization_refused", result: { verdict: out.refusal } });
      reason = "authorization_refusal";
    } else {
      //  Composed from what the SERVICE returned, never from what was asked.
      receipt = operatingReceipt({
        outcome: "work_accepted",
        result: { obligation: out.obligation, workOrderRef: selected.work_order_ref, serviceOutcome: out.outcome },
      });
      reason = "execution_receipt";
      createdObject = { type: "work_order", id: selected.work_order_id };
    }
  }

  if (receipt.text === null) {
    //  The composer refused: it had nothing committed to describe. Failing
    //  here rolls the whole turn back rather than acknowledging something
    //  that may not exist.
    throw new Error(`receipt refused (${receipt.refusal}) — no reply composed for outcome ${receipt.outcome}`);
  }

  //  A decision committed, so the inbound is no longer an unhandled claim.
  await client.query(`update comm_events set needs_human = false, classification = $2,
                             created_object_type = $3, created_object_id = $4 where id = $1`,
    [inbound.id, receipt.outcome, createdObject && createdObject.type, createdObject && createdObject.id]);

  //  THE OUTBOUND INTENT. Carries all five bindings the ruling requires;
  //  the database trigger refuses it if any is missing, independently of
  //  this function having remembered them.
  //
  //  The correlation key is derived from the provider's own message id, so
  //  a redelivered inbound produces the SAME key and the unique index makes
  //  a second reply impossible — the replay control is the database's, not
  //  this function's memory.
  const correlationKey = `${providerMessageId || inbound.id}:${reason}`;
  const outbound = (await client.query(
    `insert into comm_events (channel, direction, body, communication_line_id, staff_thread_id,
       in_reply_to_comm_event_id, to_user_id, reply_reason, correlation_key,
       created_object_type, created_object_id)
     values ('sms','outbound',$1,$2,$3,$4,$5,$6,$7,$8,$9) returning id`,
    [receipt.text, lineId, threadId, inbound.id, userId, reason, correlationKey,
     createdObject && createdObject.type, createdObject && createdObject.id])).rows[0];

  await client.query(`update staff_threads set last_message_at = now() where id = $1`, [threadId]);

  return { inbound, outbound, threadId, operating: receipt, replyReason: reason, resolution };
}

module.exports = { runOperationsTurn, readsAsAcceptance, ACCEPT_RX };
