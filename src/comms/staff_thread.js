/* ====================================================================
   comms/staff_thread.js - THE DURABLE STAFF CONVERSATION.

   Operations SMS has more than one kind of turn, but it has one thread
   and one persistence contract. This module records the inbound first and
   binds exactly one governed reply to it. It decides no intent, authority,
   answer, action, or transport behavior.
   ==================================================================== */
"use strict";

async function threadFor(client, { organizationId, userId }) {
  const result = await client.query(
    `insert into staff_threads (organization_id, user_id) values ($1,$2)
     on conflict (organization_id, user_id) do update set last_message_at = now()
     returning id`,
    [organizationId, userId]
  );
  return result.rows[0].id;
}

async function recordInbound(client, {
  organizationId, userId, lineId, body, providerMessageId,
}) {
  const threadId = await threadFor(client, { organizationId, userId });
  const inbound = (await client.query(
    `insert into comm_events (channel, direction, body, communication_line_id, staff_thread_id,
       actor_user_id, sms_sid, needs_human)
     values ('sms','inbound',$1,$2,$3,$4,$5,true) returning id`,
    [body, lineId, threadId, userId, providerMessageId || null]
  )).rows[0];
  return { threadId, inbound };
}

async function recordReply(client, {
  threadId, inboundId, userId, lineId, providerMessageId,
  body, replyReason, classification, createdObject = null,
}) {
  await client.query(
    `update comm_events set needs_human = false, classification = $2,
            created_object_type = $3, created_object_id = $4 where id = $1`,
    [inboundId, classification,
     createdObject && createdObject.type, createdObject && createdObject.id]
  );

  const correlationKey = `${providerMessageId || inboundId}:${replyReason}`;
  const outbound = (await client.query(
    `insert into comm_events (channel, direction, body, communication_line_id, staff_thread_id,
       in_reply_to_comm_event_id, to_user_id, reply_reason, correlation_key,
       created_object_type, created_object_id)
     values ('sms','outbound',$1,$2,$3,$4,$5,$6,$7,$8,$9) returning id`,
    [body, lineId, threadId, inboundId, userId, replyReason, correlationKey,
     createdObject && createdObject.type, createdObject && createdObject.id]
  )).rows[0];

  await client.query(`update staff_threads set last_message_at = now() where id = $1`, [threadId]);
  return outbound;
}

module.exports = { threadFor, recordInbound, recordReply };
