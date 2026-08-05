/* ════════════════════════════════════════════════════════════════════
   technician/operator_actions.js — THE FOUR CANONICAL OPERATOR WRITES.

   Every control the Work Orders surface renders performs its narrow
   governed function here and returns a receipt. A visible control that
   only records intent is broken software, whatever the data underneath
   says — so there is exactly one service per rendered verb and no verb
   without one.

     assignWork        an eligible technician becomes accountable
     askForPhoto       one reply-bound request on the operations line
     coordinateEntry   one resident-safe message on the property line
     retryDelivery     a NEW attempt at an EXISTING failed intent

   `Review` is deliberately absent: it is a read, and a read that writes
   is the thing this file exists to prevent.

   ── SERVER-DERIVED AUTHORITY (§21) ──────────────────────────────────
   Every entry point takes the operator's user id and the SESSION'S
   property id, and re-derives eligibility against the locked row. A
   caller cannot pass an owner, a property, or a permission.

   ── OPERATING TRUTH AND DELIVERY TRUTH STAY APART ───────────────────
   Every send persists its intent and commits BEFORE transport is
   attempted, and returns them as two facts. Nothing here reports `sent`
   because a row was written.
   ════════════════════════════════════════════════════════════════════ */
"use strict";

function actionError(code, message) { const e = new Error(message); e.code = code; return e; }

/*  The work order, locked, inside the operator's own property scope.
 *  Scope is a WHERE clause, not a check afterwards, so another building's
 *  row is never read at all. */
async function lockScoped(client, { workOrderId, propertyId }) {
  const wo = (await client.query(
    `select w.*, u.unit_number from work_orders w
       left join units u on u.id = w.unit_id
      where w.id = $1 and w.property_id = $2 for update of w`,
    [workOrderId, propertyId])).rows[0];
  if (!wo) throw actionError("NOT_FOUND", "work order not found in this property");
  return wo;
}

const label = (wo) => (wo.unit_number ? "Unit " + wo.unit_number + " " : "") + (wo.title || "work order");

/*  ── ELIGIBLE TECHNICIANS ───────────────────────────────────────────
 *  Active staff with an active assignment to THIS property. Derived, so
 *  the picker cannot offer somebody the write would refuse. */
async function eligibleTechnicians(db, { propertyId }) {
  const { rows } = await db.query(
    `select distinct u.id, u.name from users u
       join property_team_assignments pta on pta.user_id = u.id and pta.active = true
      where pta.property_id = $1 and u.is_active = true
      order by u.name`, [propertyId]);
  return rows;
}

/*  ── 1. ASSIGN ──────────────────────────────────────────────────────*/
async function assignWork(client, { workOrderId, propertyId, technicianUserId, operatorUserId, idempotencyKey = null }) {
  if (!technicianUserId) throw actionError("BAD_INPUT", "a technician must be chosen");
  const wo = await lockScoped(client, { workOrderId, propertyId });

  //  ELIGIBILITY, re-derived. A client-supplied technician is a request.
  const ok = (await client.query(
    `select 1 from property_team_assignments pta join users u on u.id = pta.user_id
      where pta.user_id = $1 and pta.property_id = $2 and pta.active = true and u.is_active = true`,
    [technicianUserId, propertyId])).rows.length;
  if (!ok) return { outcome: "refused", refusal: "technician_not_eligible_at_property", receipt: null };

  const ob = (await client.query(
    `select * from obligations where related_type='work_order' and related_id=$1 and property_id=$2
      order by created_at asc limit 1 for update`, [workOrderId, propertyId])).rows[0];
  if (!ob) return { outcome: "refused", refusal: "no_obligation_for_work_order", receipt: null };
  //  STALE-STATE PROTECTION. Accepted work is not reassignable here.
  if (ob.accepted_by_user_id) return { outcome: "refused", refusal: "already_accepted", receipt: null };
  if (ob.status === "complete") return { outcome: "refused", refusal: "already_complete", receipt: null };
  if (ob.assigned_user_id === technicianUserId) {
    const t = (await client.query(`select name from users where id=$1`, [technicianUserId])).rows[0];
    return { outcome: "unchanged", refusal: null,
             receipt: { text: `${t.name} already has ${label(wo)}.`, work_order_id: workOrderId } };
  }

  await client.query(
    `update obligations set assigned_user_id=$2, ownership_origin='operator_assigned', updated_at=now() where id=$1`,
    [ob.id, technicianUserId]);
  const tech = (await client.query(`select name from users where id=$1`, [technicianUserId])).rows[0];
  await client.query(
    `insert into events (property_id, unit_id, type, note) values ($1,$2,'work_order_assigned',$3)`,
    [wo.property_id, wo.unit_id, JSON.stringify({
      work_order_id: workOrderId, obligation_id: ob.id,
      assigned_user_id: technicianUserId, assigned_by_user_id: operatorUserId, idempotency_key: idempotencyKey })]);

  return { outcome: "assigned", refusal: null,
           receipt: { text: `${label(wo)} is assigned to ${tech.name}. They still need to accept it.`,
                      work_order_id: workOrderId, responsible: tech.name } };
}

/*  ── 2. ASK FOR A PHOTO ─────────────────────────────────────────────
 *  A REPLY on the operations line — bound to the technician's own most
 *  recent inbound message, which is what makes it expressible at all:
 *  the line is reply_only and a proactive push is refused by the
 *  database. Asking for the proof their completion claim is missing is
 *  genuinely a clarification of that claim, not an unprompted broadcast.
 */
async function askForPhoto(client, { workOrderId, propertyId, operatorUserId, idempotencyKey = null }) {
  const wo = await lockScoped(client, { workOrderId, propertyId });
  const ob = (await client.query(
    `select * from obligations where related_type='work_order' and related_id=$1 and property_id=$2
      order by created_at asc limit 1`, [workOrderId, propertyId])).rows[0];
  const techId = ob && (ob.accepted_by_user_id || ob.assigned_user_id);
  if (!techId) return { outcome: "refused", refusal: "no_technician_to_ask", receipt: null };

  //  Already have it? Then there is nothing to ask for.
  const preserved = (await client.query(
    `select 1 from work_order_proof_attachments where work_order_id=$1 and storage_state='stored' limit 1`,
    [workOrderId])).rows.length;
  if (preserved) return { outcome: "refused", refusal: "proof_already_preserved", receipt: null };

  const thread = (await client.query(
    `select st.id, st.organization_id from staff_threads st
       join properties p on p.organization_id = st.organization_id and p.id = $2
      where st.user_id = $1`, [techId, propertyId])).rows[0];
  if (!thread) return { outcome: "refused", refusal: "no_operations_thread", receipt: null };

  const inbound = (await client.query(
    `select id from comm_events where staff_thread_id=$1 and direction='inbound'
      order by occurred_at desc limit 1`, [thread.id])).rows[0];
  if (!inbound) return { outcome: "refused", refusal: "nothing_to_reply_to", receipt: null };

  const line = (await client.query(
    `select id from communication_lines where organization_id=$1 and line_type='operations' and status='active'`,
    [thread.organization_id])).rows[0];
  if (!line) return { outcome: "refused", refusal: "no_operations_line", receipt: null };

  const tech = (await client.query(`select name from users where id=$1`, [techId])).rows[0];
  const key = idempotencyKey || `askphoto:${workOrderId}:${inbound.id}`;
  const body = `Please send a repair photo for the ${label(wo)}.`;

  let ev;
  try {
    ev = (await client.query(
      `insert into comm_events (channel, direction, body, communication_line_id, staff_thread_id,
         in_reply_to_comm_event_id, to_user_id, reply_reason, correlation_key,
         created_object_type, created_object_id, actor_user_id)
       values ('sms','outbound',$1,$2,$3,$4,$5,'clarification',$6,'work_order',$7,$8) returning id`,
      [body, line.id, thread.id, inbound.id, techId, key, workOrderId, operatorUserId])).rows[0];
  } catch (e) {
    //  A second press finds the key already used. Nothing is spammed.
    if (e.code === "23505") return { outcome: "already_requested", refusal: null,
      receipt: { text: `A photo request for ${label(wo)} is already prepared for ${tech.name}.`, work_order_id: workOrderId } };
    throw e;
  }
  const phone = (await client.query(`select phone from users where id=$1`, [techId])).rows[0];
  return { outcome: "prepared", refusal: null, commEventId: ev.id,
           //  Everything transport needs, derived here — the route composes
           //  nothing and guesses nothing.
           sendSpec: { kind: "operations_reply", organization_id: thread.organization_id,
                       recipient: phone && phone.phone, body, replyToCommEventId: inbound.id },
           receipt: { text: `Photo request prepared for ${tech.name}.`, work_order_id: workOrderId,
                      responsible: tech.name } };
}

/*  ── 3. COORDINATE ENTRY ────────────────────────────────────────────
 *  A resident-safe message on the PROPERTY-FACING thread. Derived text
 *  only — the technician's own words never travel. The no-access fact is
 *  already committed and is not touched by this.
 *
 *  ── ONE FACT, ONE MESSAGE ──────────────────────────────────────────
 *  Reporting no access ALREADY derives this exact sentence automatically.
 *  This action and that derivation resolve against the SAME canonical
 *  cause — the no-access progress row — so the second one cannot be
 *  written. Not hidden, not discouraged: refused, by migration 136's
 *  unique index on `derived_from_progress_id`.
 *
 *  The lookup below exists so the operator is TOLD what already happened
 *  and when. The index exists so a replay, a double-click or a future
 *  third writer cannot get past it anyway.
 */
const ENTRY_TEXT = "The technician could not access the unit. Please reply with the best way to coordinate entry.";

/*  What the resident has already been told about THIS no-access fact.
 *  Both writers record the cause, so one query answers it for both. */
async function existingCoordination(client, causeProgressId) {
  return (await client.query(
    `select id, occurred_at, sms_status, actor_user_id
       from comm_events where derived_from_progress_id = $1 limit 1`, [causeProgressId])).rows[0] || null;
}

function alreadyAsked(row, wo) {
  const s = String(row.sms_status || "").toLowerCase();
  const failed = s === "failed" || s === "undelivered" || s === "refused";
  return {
    outcome: "already_asked", refusal: null, commEventId: row.id,
    //  The delivery state travels with it, because "already asked" and
    //  "asked and it failed" call for different operator moves.
    coordination: { comm_event_id: row.id, at: row.occurred_at, failed },
    receipt: {
      text: failed
        ? `The resident of ${label(wo)} was already asked to coordinate entry, and that message failed. Retry it rather than sending a second one.`
        : `The resident of ${label(wo)} has already been asked to coordinate entry.`,
      work_order_id: wo.id, responsible: "the resident",
    },
  };
}

async function coordinateEntry(client, { workOrderId, propertyId, operatorUserId, idempotencyKey = null }) {
  const wo = await lockScoped(client, { workOrderId, propertyId });
  const personId = wo.affected_person_id || wo.reported_by_person_id;
  if (!personId) return { outcome: "refused", refusal: "no_resident_to_contact", receipt: null };

  //  It must actually BE a no-access situation.
  const na = (await client.query(
    `select id from work_order_progress where work_order_id=$1 and kind='no_access'
      order by occurred_at desc limit 1`, [workOrderId])).rows[0];
  if (!na) return { outcome: "refused", refusal: "no_access_not_reported", receipt: null };

  const already = await existingCoordination(client, na.id);
  if (already) return alreadyAsked(already, wo);

  const convo = (await client.query(
    `insert into conversations (property_id, person_id) values ($1,$2)
     on conflict (property_id, person_id) do update set last_message_at = now() returning id`,
    [propertyId, personId])).rows[0];

  const key = idempotencyKey || `entry:${workOrderId}:${na.id}`;
  let ev;
  //  SAVEPOINT, because losing the race must leave a USABLE transaction.
  //  A bare 23505 aborts it, and then the query that would tell the operator
  //  what already happened cannot run — the caller would be left with the
  //  duplicate refused and nothing to say about it.
  await client.query("savepoint coordinate_entry");
  try {
    ev = (await client.query(
      `insert into comm_events (property_id, person_id, conversation_id, channel, direction, body,
         classification, created_object_type, created_object_id, derived_from_progress_id,
         correlation_key, actor_user_id)
       values ($1,$2,$3,'sms','outbound',$4,'work_order_update','work_order',$5,$6,$7,$8) returning id`,
      [propertyId, personId, convo.id, ENTRY_TEXT, workOrderId, na.id, key, operatorUserId])).rows[0];
    await client.query("release savepoint coordinate_entry");
  } catch (e) {
    await client.query("rollback to savepoint coordinate_entry");
    //  THE STRUCTURAL BACKSTOP. A concurrent press, a replayed request or a
    //  writer that forgot to look first all land here, and all land on the
    //  same answer as the lookup above — because they lost to the same
    //  index on the same canonical cause.
    if (e.code === "23505") {
      const raced = await existingCoordination(client, na.id);
      if (raced) return alreadyAsked(raced, wo);
      return { outcome: "already_prepared", refusal: null,
               receipt: { text: `Access coordination for ${label(wo)} is already prepared.`, work_order_id: workOrderId } };
    }
    throw e;
  }
  const rp = (await client.query(
    `select coalesce(primary_phone_e164, phone) as p from persons where id=$1`, [personId])).rows[0];
  return { outcome: "prepared", refusal: null, commEventId: ev.id, personId,
           sendSpec: { kind: "property_sms", property_id: propertyId, recipient: rp && rp.p,
                       body: ENTRY_TEXT, person_id: personId },
           receipt: { text: `Access coordination prepared for the resident of ${label(wo)}.`,
                      work_order_id: workOrderId, responsible: "the resident" } };
}

/*  ── 4. RETRY ───────────────────────────────────────────────────────
 *  A NEW ATTEMPT at an EXISTING intent. It creates no completion event,
 *  no work order and no new message — the thing to send already exists
 *  and already says what it says. Every prior attempt is preserved.
 */
const RETRYABLE = ["failed", "undelivered", "refused"];

async function prepareRetry(client, { commEventId, propertyId, operatorUserId, idempotencyKey = null }) {
  const ev = (await client.query(
    `select * from comm_events where id=$1 and property_id=$2 for update`, [commEventId, propertyId])).rows[0];
  if (!ev) return { outcome: "refused", refusal: "not_found_in_property", receipt: null };
  if (!RETRYABLE.includes(String(ev.sms_status || "").toLowerCase())) {
    return { outcome: "refused", refusal: "not_in_a_retryable_state", receipt: null };
  }

  const prior = (await client.query(
    `select coalesce(max(attempt_no),0) as n from comm_delivery_attempts where comm_event_id=$1`,
    [commEventId])).rows[0];
  const attemptNo = Number(prior.n) + 1;
  const key = idempotencyKey || `retry:${commEventId}:${attemptNo}`;

  //  A double-click loses here, at the database, not at whichever layer
  //  happened to remember.
  try {
    await client.query(
      `insert into comm_delivery_attempts (comm_event_id, attempt_no, requested_by_user_id, outcome,
         failure_reason, idempotency_key)
       values ($1,$2,$3,'refused','pending',$4)`, [commEventId, attemptNo, operatorUserId, key]);
  } catch (e) {
    if (e.code === "23505") return { outcome: "already_in_flight", refusal: null,
      receipt: { text: "A retry for that message is already in progress.", work_order_id: ev.created_object_id } };
    throw e;
  }
  const rp = ev.person_id ? (await client.query(
    `select coalesce(primary_phone_e164, phone) as p from persons where id=$1`, [ev.person_id])).rows[0] : null;
  return { outcome: "prepared", refusal: null, commEventId: ev.id, attemptNo,
           sendSpec: { kind: "property_sms", property_id: ev.property_id, recipient: rp && rp.p,
                       body: ev.body, person_id: ev.person_id },
           receipt: { text: "Retrying the resident message.", work_order_id: ev.created_object_id } };
}

/*  Records what the wire actually did. Called AFTER the commit that
 *  prepared the attempt, so a transport failure cannot roll back the
 *  operating record of having tried. */
async function recordAttemptResult(db, { commEventId, attemptNo, sent, providerRef = null, failureReason = null }) {
  await db.query(
    `update comm_delivery_attempts set outcome=$3, provider_ref=$4, failure_reason=$5, attempted_at=now()
      where comm_event_id=$1 and attempt_no=$2`,
    [commEventId, attemptNo, sent ? "sent" : "failed", providerRef,
     sent ? null : (failureReason || "unknown")]);
  //  The CURRENT projection follows the latest attempt.
  await db.query(
    `update comm_events set sms_status=$2, sms_sid=coalesce($3, sms_sid), sms_error=$4 where id=$1`,
    [commEventId, sent ? "queued" : "failed", providerRef, sent ? null : (failureReason || "unknown")]);
}

module.exports = {
  eligibleTechnicians, assignWork, askForPhoto, coordinateEntry,
  prepareRetry, recordAttemptResult, actionError, ENTRY_TEXT, RETRYABLE,
};
