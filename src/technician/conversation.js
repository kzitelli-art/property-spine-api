/* ════════════════════════════════════════════════════════════════════
   technician/conversation.js — THE OPERATIONS-LINE TURN.

   One inbound message from an authenticated technician becomes: a durable
   inbound record on a staff thread, a governed decision, at most one
   canonical write, an operating receipt, a reply-bound outbound INTENT,
   and — where the fact is resident-safe — a separate resident update
   intent on the PROPERTY-FACING thread.

   ── THE ORDER IS THE POINT ──────────────────────────────────────────

       inbound recorded
         → identity and property authority resolved
         → canonical service validates and commits
         → operating receipt composed FROM THE COMMITTED RESULT
         → resident-safe update derived from the committed fact
         → outbound reply intent persisted
         → COMMIT
         → transport attempted
         → delivery result persisted separately

   ── THE PRODUCT BAR ─────────────────────────────────────────────────

   RECOGNITION OVER RE-ENTRY. Spine already knows who they are, which
   thread this is, which work order they are working, what it asked them
   last, and what proof is still missing. It never asks for any of that
   again. A work reference is required only when the thread and their
   assignments genuinely cannot settle it.

   ONE AMBIGUITY, ONE DIRECT QUESTION — naming their own work, never a
   schema term and never a portfolio listing.

   ── WHAT THIS FILE MAY NOT DO ───────────────────────────────────────
   Decide eligibility, write anything, compose prose, resolve which work
   was meant, decide what a resident may be told, or send. It sequences.
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const workSelection = require("./work_selection");
const workReference = require("../conversation/work_reference");
const technicianIntent = require("../conversation/technician_intent");
const { acceptWork } = require("./acceptance_service");
const lifecycle = require("./lifecycle_service");
const evidence = require("./evidence_service");
const residentUpdate = require("./resident_update");
const { operatingReceipt } = require("../conversation/receipt");

/*  Which field verb each intent records. `accept` and `list_work` are not
 *  field facts; they are handled on their own branches. */
const INTENT_TO_KIND = {
  en_route: "en_route",
  no_access: "no_access",
  blocked: "blocked",
  finding: "finding",
};
const INTENT_TO_OUTCOME = {
  en_route: "en_route_recorded",
  no_access: "no_access_recorded",
  blocked: "blocked_recorded",
  finding: "finding_recorded",
};

async function staffThreadFor(client, { organizationId, userId }) {
  const r = await client.query(
    `insert into staff_threads (organization_id, user_id) values ($1,$2)
     on conflict (organization_id, user_id) do update set last_message_at = now()
     returning id`, [organizationId, userId]);
  return r.rows[0].id;
}

async function actorScope(client, { organizationId, userId }) {
  const { rows } = await client.query(
    `select distinct p.id from property_team_assignments pta
       join properties p on p.id = pta.property_id and p.organization_id = $2
      where pta.user_id = $1 and pta.active = true order by p.id`, [userId, organizationId]);
  return rows.map((r) => r.id);
}

/*  Candidate work, already scoped in SQL to the actor's own properties. A
 *  read that returns another building's rows at all is a read that can
 *  leak one. Carries the descriptive naming a reply needs. */
async function candidateWork(client, { userId, propertyIds }) {
  if (!propertyIds.length) return [];
  const { rows } = await client.query(
    `select o.id as obligation_id, o.related_id as work_order_id, o.related_type,
            o.property_id, o.assigned_user_id, o.accepted_by_user_id, o.status,
            w.work_order_ref, w.title, w.status as work_status, u.unit_number,
            (o.accepted_by_user_id is not null) as accepted
       from obligations o
       join work_orders w on w.id = o.related_id and w.property_id = o.property_id
       left join units u on u.id = w.unit_id
      where o.assigned_user_id = $1 and o.related_type = 'work_order'
        and o.property_id = any($2::uuid[]) and o.status in ('open','in_progress')
        and w.status <> 'complete'
      order by w.work_order_ref`, [userId, propertyIds]);
  return rows;
}

/*  RECOGNITION. What work is already live in this thread — the second
 *  governed reference source, and the thing that lets a technician say
 *  "couldn't get in" with no reference at all. */
async function threadWorkOrderIds(client, { staffThreadId }) {
  const { rows } = await client.query(
    `select distinct created_object_id as id from comm_events
      where staff_thread_id = $1 and created_object_type = 'work_order'
        and created_object_id is not null`, [staffThreadId]);
  return rows.map((r) => r.id);
}

/*  Was the last thing WE said a question? If so, a bare "yes"/"ok" is an
 *  answer to it, not an unreadable fragment — the technician should never
 *  have to repeat something Spine just asked about. */
async function lastQuestionIn(client, { staffThreadId }) {
  const { rows } = await client.query(
    `select id, reply_reason, created_object_id from comm_events
      where staff_thread_id = $1 and direction = 'outbound' and reply_reason = 'clarification'
      order by occurred_at desc limit 1`, [staffThreadId]);
  return rows[0] || null;
}

/*  The resident to tell, if there is one. Derived from the work order's
 *  own affected/reporting person — never from anything in the message. */
async function residentForWorkOrder(client, { workOrderId }) {
  const { rows } = await client.query(
    `select coalesce(affected_person_id, reported_by_person_id) as person_id
       from work_orders where id = $1`, [workOrderId]);
  return (rows[0] && rows[0].person_id) || null;
}

/*  The resident conversation on the PROPERTY-FACING side. Created if it
 *  does not exist, because a resident update must land in the resident's
 *  own thread — never in the staff thread it was derived from. */
async function residentConversationFor(client, { propertyId, personId }) {
  const r = await client.query(
    `insert into conversations (property_id, person_id) values ($1,$2)
     on conflict (property_id, person_id) do update set last_message_at = now()
     returning id`, [propertyId, personId]);
  return r.rows[0].id;
}

/*  ── THE TURN ───────────────────────────────────────────────────────*/
async function runOperationsTurn(client, {
  organizationId, userId, lineId, body, providerMessageId, attachments = [],
}, { fetchMedia = null } = {}) {
  const threadId = await staffThreadFor(client, { organizationId, userId });

  const inbound = (await client.query(
    `insert into comm_events (channel, direction, body, communication_line_id, staff_thread_id,
       actor_user_id, sms_sid, needs_human)
     values ('sms','inbound',$1,$2,$3,$4,$5,true) returning id`,
    [body, lineId, threadId, userId, providerMessageId || null])).rows[0];

  const propertyIds = await actorScope(client, { organizationId, userId });
  const candidates = await candidateWork(client, { userId, propertyIds });
  const authorized = workSelection.offerableWork({
    actor: { userId, organizationId, assignedPropertyIds: propertyIds }, candidates,
  }).offerable;

  const read = technicianIntent.readTurn({ text: body, attachments });

  //  RECOGNITION — a bare "yes"/"ok" answering the question we just asked.
  let intent = read.intent;
  const pendingQuestion = intent === "unclear" ? await lastQuestionIn(client, { staffThreadId: threadId }) : null;
  const affirm = technicianIntent.readAnswerToQuestion(body);
  if (intent === "unclear" && pendingQuestion && affirm === "affirmative") intent = "accept";

  const resolution = workReference.resolveWorkReference({
    authorized,
    claim: workReference.extractReference(body),
    threadWorkOrderIds: await threadWorkOrderIds(client, { staffThreadId: threadId }),
  });

  let receipt = null, reason = null, createdObject = null, residentIntent = null;

  //  ── LIST: a read, not an action. No reference needed, ever. ──────
  if (intent === "list_work") {
    receipt = operatingReceipt({ outcome: "work_list", result: { items: authorized } });
    reason = "governed_read";
  } else if (intent === "unclear" || resolution.outcome !== "one") {
    //  ONE AMBIGUITY, ONE QUESTION. Either we cannot read the message, or
    //  we cannot tell which work it is about. Nothing is written.
    const clarification = workReference.clarificationForReference(
      resolution.outcome === "one" ? { outcome: "no_reference" } : resolution, authorized);
    receipt = operatingReceipt({ outcome: "work_reference_needed",
      result: { question: clarification.question, reason: clarification.reason } });
    reason = "clarification";
  } else {
    const selected = resolution.selected;
    const work = {
      id: selected.work_order_id, title: selected.title,
      unit_number: selected.unit_number, work_order_ref: selected.work_order_ref,
    };

    //  Evidence arrives with whatever verb carried it, and is recorded
    //  against the resolved work order before the verb is acted on — so a
    //  "done" + photo in one message has its proof already in hand.
    let lastEvidence = null;
    for (const media of (attachments || [])) {
      // eslint-disable-next-line no-await-in-loop
      lastEvidence = await evidence.ingestProviderMedia(client, {
        work_order_id: selected.work_order_id, property_id: selected.property_id,
        uploaded_by_user_id: userId, source_comm_event_id: inbound.id,
        provider: media.provider || "twilio", provider_media_id: media.id || null,
        provider_media_url: media.url || null, mime_type: media.mime_type,
        proof_classification: media.proof_classification || "repair_photo",
      }, { fetchMedia });
    }

    if (intent === "accept") {
      const out = await acceptWork(client, {
        obligation_id: selected.obligation_id, user_id: userId,
        organization_id: organizationId, acceptance_key: providerMessageId || null, channel: "sms",
      });
      if (out.outcome === "refused") {
        receipt = operatingReceipt({ outcome: "authorization_refused", result: { verdict: out.refusal } });
        reason = "authorization_refusal";
      } else {
        receipt = operatingReceipt({ outcome: "work_accepted",
          result: { work, serviceOutcome: out.outcome } });
        reason = "execution_receipt";
        createdObject = { type: "work_order", id: selected.work_order_id };
      }
    } else if (intent === "complete") {
      const out = await lifecycle.claimCompletion(client, {
        work_order_id: selected.work_order_id, user_id: userId, organization_id: organizationId,
        note: body, source_comm_event_id: inbound.id,
        idempotency_key: providerMessageId ? `${providerMessageId}:complete` : null,
      });
      if (out.outcome === "refused") {
        receipt = operatingReceipt({ outcome: "authorization_refused", result: { verdict: out.refusal } });
        reason = "authorization_refusal";
      } else {
        createdObject = { type: "work_order", id: selected.work_order_id };
        reason = "execution_receipt";
        if (out.closed) {
          residentIntent = residentUpdate.deriveResidentUpdate({
            committed: out.progress, workOrder: out.workOrder,
            recipientPersonId: await residentForWorkOrder(client, { workOrderId: selected.work_order_id }),
          });
          receipt = operatingReceipt({ outcome: "work_completed",
            result: { work, progress: out.progress, residentUpdateQueued: !!(residentIntent && residentIntent.send) } });
        } else {
          receipt = operatingReceipt({ outcome: "completion_blocked",
            result: { work, progress: out.progress, missing: out.missing,
                      evidenceAttempted: !!out.evidenceAttempted } });
        }
      }
    } else if (read.evidenceOnly && lastEvidence) {
      //  A photo with no verb — or with a bare caption like "here you go" —
      //  is EVIDENCE, and the reply must be about the photo. Recording it as
      //  a finding whose note is "here you go" tells the technician nothing
      //  about whether their proof landed.
      receipt = operatingReceipt({ outcome: "evidence_recorded",
        result: { work, storageState: lastEvidence.attachment.storage_state } });
      reason = "execution_receipt";
      createdObject = { type: "work_order", id: selected.work_order_id };
    } else if (INTENT_TO_KIND[intent]) {
      const out = await lifecycle.reportFieldFact(client, {
        kind: INTENT_TO_KIND[intent], work_order_id: selected.work_order_id,
        user_id: userId, organization_id: organizationId, note: body,
        source_comm_event_id: inbound.id,
        idempotency_key: providerMessageId ? `${providerMessageId}:${INTENT_TO_KIND[intent]}` : null,
      });
      if (out.outcome === "refused") {
        receipt = operatingReceipt({ outcome: "authorization_refused", result: { verdict: out.refusal } });
        reason = "authorization_refusal";
      } else {
        createdObject = { type: "work_order", id: selected.work_order_id };
        reason = "execution_receipt";
        residentIntent = residentUpdate.deriveResidentUpdate({
          committed: out.progress, workOrder: out.workOrder,
          recipientPersonId: await residentForWorkOrder(client, { workOrderId: selected.work_order_id }),
        });
        receipt = operatingReceipt({ outcome: INTENT_TO_OUTCOME[intent],
          result: { work, progress: out.progress,
                    residentUpdateQueued: !!(residentIntent && residentIntent.send) } });
      }
    } else if (lastEvidence) {
      //  Photos with nothing else. Evidence is recorded; it never completes.
      receipt = operatingReceipt({ outcome: "evidence_recorded",
        result: { work, storageState: lastEvidence.attachment.storage_state } });
      reason = "execution_receipt";
      createdObject = { type: "work_order", id: selected.work_order_id };
    } else {
      receipt = operatingReceipt({ outcome: "work_reference_needed",
        result: { question: "What would you like me to record for that one?", reason: "intent_unclear" } });
      reason = "clarification";
    }
  }

  if (receipt.text === null) {
    throw new Error(`receipt refused (${receipt.refusal}) — no reply composed for outcome ${receipt.outcome}`);
  }

  await client.query(
    `update comm_events set needs_human = false, classification = $2,
            created_object_type = $3, created_object_id = $4 where id = $1`,
    [inbound.id, receipt.outcome, createdObject && createdObject.type, createdObject && createdObject.id]);

  //  ── THE RESIDENT UPDATE INTENT ──────────────────────────────────
  //  Derived from the committed fact, attached to the RESIDENT thread,
  //  and never carrying a word the technician typed. The database refuses
  //  it on a staff thread (ck_comm_derived_is_resident_facing).
  let residentEvent = null;
  if (residentIntent && residentIntent.send) {
    const convoId = await residentConversationFor(client,
      { propertyId: residentIntent.propertyId, personId: residentIntent.personId });
    residentEvent = (await client.query(
      `insert into comm_events (property_id, person_id, conversation_id, channel, direction, body,
         classification, created_object_type, created_object_id, derived_from_progress_id)
       values ($1,$2,$3,'sms','outbound',$4,'work_order_update','work_order',$5,$6) returning id`,
      [residentIntent.propertyId, residentIntent.personId, convoId, residentIntent.text,
       createdObject && createdObject.id, residentIntent.derivedFromProgressId])).rows[0];
  }

  const correlationKey = `${providerMessageId || inbound.id}:${reason}`;
  const outbound = (await client.query(
    `insert into comm_events (channel, direction, body, communication_line_id, staff_thread_id,
       in_reply_to_comm_event_id, to_user_id, reply_reason, correlation_key,
       created_object_type, created_object_id)
     values ('sms','outbound',$1,$2,$3,$4,$5,$6,$7,$8,$9) returning id`,
    [receipt.text, lineId, threadId, inbound.id, userId, reason, correlationKey,
     createdObject && createdObject.type, createdObject && createdObject.id])).rows[0];

  await client.query(`update staff_threads set last_message_at = now() where id = $1`, [threadId]);

  return { inbound, outbound, threadId, operating: receipt, replyReason: reason,
           resolution, residentIntent, residentEvent, intent };
}

module.exports = { runOperationsTurn, INTENT_TO_KIND, INTENT_TO_OUTCOME };
