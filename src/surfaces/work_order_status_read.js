/* ════════════════════════════════════════════════════════════════════
   surfaces/work_order_status_read.js — WHAT IS HAPPENING WITH THIS WORK.

   A READ. It creates no status of its own, maintains no timeline, and
   writes nothing. Every field below is derived from canonical rows that
   already exist — work_orders, obligations, work_order_progress,
   work_order_proof_attachments, comm_events — so there is no second
   status layer to keep in sync and nothing here can disagree with the
   technician's own receipt.

   ── THE THREE-SECOND READ ───────────────────────────────────────────

     what is happening → who is acting → what is blocking completion
       → whether proof exists → what happens next

   That is the shape of the return value, not a rendering suggestion:
   `current`, `next_action`, `proof`, `history`, `resident_update`.

   ── FOUR THINGS THAT ARE NOT THE SAME STATUS ────────────────────────

     scheduled work        nobody has taken it
     a technician claim    somebody says it is done
     verified proof        evidence exists and is preserved
     completed work        the governed service closed it

   They are separate fields with separate times and separate actors.
   Flattening them is exactly how a board shows "complete" for something
   with no proof behind it.

   ── HONEST BLANK (§5) ───────────────────────────────────────────────
   No owner is `UNASSIGNED`, never a guess and never blank. No proof is
   stated as required-and-missing, never as absent-so-fine. A photo we
   could not preserve is `not_preserved`, never proof.

   ── OPERATING TRUTH AND DELIVERY TRUTH STAY APART ───────────────────
   `resident_update` reports what was PREPARED. `resident_update.delivery`
   reports what the wire did, from the outbound row's own status, and is
   `unknown` when the provider has told us nothing. Nothing here says a
   resident was notified because a work event occurred.
   ════════════════════════════════════════════════════════════════════ */
"use strict";

/*  The lifecycle state an operator needs, derived — never stored. Ordered
 *  most-specific first: a work order that is complete IS complete, whatever
 *  happened before it. */
function lifecycleStateOf({ workOrder, acceptance, latestByKind }) {
  if (workOrder.status === "complete") return "completed";
  if (latestByKind.completion_claimed && !latestByKind.completed) return "completion_claimed";
  if (latestByKind.no_access) return "no_access";
  if (latestByKind.blocked) return "blocked";
  if (latestByKind.en_route) return "en_route";
  if (acceptance && acceptance.accepted_at) return "accepted";
  return "scheduled";
}

/*  What a human should do next. Derived from the same facts, so it cannot
 *  contradict the state above. */
function nextActionFor({ state, proof }) {
  switch (state) {
    case "scheduled":           return "Assign or accept the work";
    case "accepted":            return "Technician to schedule and travel";
    case "en_route":            return "Technician is travelling";
    case "no_access":           return "Coordinate entry with resident";
    case "blocked":             return "Resolve what the work is waiting on";
    case "completion_claimed":  return proof.satisfied ? "Close out the work order" : "Obtain repair photo before completion";
    case "completed":           return null;
    default:                    return null;
  }
}

const PROOF_REQUIRED_CLASSIFICATIONS = ["repair_photo", "condition", "unclassified"];

/*  readWorkOrderStatus — one work order, fully described.
 *
 *  `propertyId` is the SCOPE and comes from the authenticated session. It
 *  is passed into every query rather than checked afterwards, so a work
 *  order at another property returns null instead of leaking a row.
 */
async function readWorkOrderStatus(db, { propertyId, workOrderId }) {
  if (!propertyId || !workOrderId) return null;

  const workOrder = (await db.query(
    `select w.*, u.unit_number
       from work_orders w left join units u on u.id = w.unit_id
      where w.id = $1 and w.property_id = $2`, [workOrderId, propertyId])).rows[0];
  if (!workOrder) return null;

  //  WHO IS ACCOUNTABLE. The obligation is the accountability rail; the
  //  work order's free-text assigned_to column is deliberately not read.
  const acceptance = (await db.query(
    `select o.id, o.status, o.assigned_user_id, o.accepted_by_user_id, o.accepted_at,
            usr.name as accepted_by_name
       from obligations o
       left join users usr on usr.id = o.accepted_by_user_id
      where o.related_type = 'work_order' and o.related_id = $1 and o.property_id = $2
      order by o.created_at asc limit 1`, [workOrderId, propertyId])).rows[0] || null;

  const progress = (await db.query(
    `select p.id, p.kind, p.note, p.occurred_at, p.reported_by_user_id,
            usr.name as reported_by_name, p.source_comm_event_id
       from work_order_progress p
       left join users usr on usr.id = p.reported_by_user_id
      where p.work_order_id = $1 and p.property_id = $2
      order by p.occurred_at asc`, [workOrderId, propertyId])).rows;

  //  Latest of each kind, so "reported no access at 2:14" survives a later
  //  finding without the two overwriting each other.
  const latestByKind = {};
  for (const p of progress) latestByKind[p.kind] = p;

  const attachments = (await db.query(
    `select id, storage_state, proof_classification, mime_type, byte_size,
            received_at, stored_at, provider
       from work_order_proof_attachments
      where work_order_id = $1 and property_id = $2
      order by received_at asc`, [workOrderId, propertyId])).rows;

  const preserved = attachments.filter(
    (a) => a.storage_state === "stored" && PROOF_REQUIRED_CLASSIFICATIONS.includes(a.proof_classification));
  const proof = {
    required: true,
    satisfied: preserved.length > 0,
    preserved_count: preserved.length,
    //  A photo that arrived and could not be kept is NOT proof, and is
    //  reported separately so an operator can see the difference between
    //  "no photo" and "a photo we lost".
    not_preserved_count: attachments.filter((a) => a.storage_state !== "stored").length,
    attachments: attachments.map((a) => ({
      id: a.id, storage_state: a.storage_state, classification: a.proof_classification,
      mime_type: a.mime_type, byte_size: a.byte_size,
      received_at: a.received_at, stored_at: a.stored_at, provider: a.provider,
    })),
  };

  const state = lifecycleStateOf({ workOrder, acceptance, latestByKind });

  //  An OPEN follow-up obligation, if the work created one.
  const followUp = acceptance && acceptance.status !== "complete"
    ? { obligation_id: acceptance.id, status: acceptance.status }
    : null;

  //  ── RESIDENT UPDATES: PREPARED vs DELIVERED ──────────────────────
  //  Every intent derived from a field fact on this work order, with the
  //  transport's own status kept as its own column. `unknown` is a real
  //  answer — the provider has told us nothing yet — and is never rounded
  //  up to delivered.
  const residentRows = (await db.query(
    `select ce.id, ce.body, ce.occurred_at, ce.sms_status, ce.sms_sid, ce.sms_error,
            ce.derived_from_progress_id
       from comm_events ce
      where ce.property_id = $1 and ce.derived_from_progress_id is not null
        and ce.created_object_type = 'work_order' and ce.created_object_id = $2
      order by ce.occurred_at asc`, [propertyId, workOrderId])).rows;

  const resident_update = residentRows.map((row) => ({
    id: row.id,
    prepared_at: row.occurred_at,
    text: row.body,
    derived_from_progress_id: row.derived_from_progress_id,
    delivery: deliveryStateOf(row),
  }));

  return {
    work_order: {
      id: workOrder.id, reference: workOrder.work_order_ref,
      title: workOrder.title, unit_number: workOrder.unit_number,
      status: workOrder.status, urgency_status: workOrder.urgency_status || null,
      opened_at: workOrder.created_at,
    },
    current: {
      state,
      //  §5 — an owner we do not have is UNASSIGNED, never blank and never
      //  the technician who happens to have reported something.
      accountable: acceptance && acceptance.accepted_by_user_id
        ? { user_id: acceptance.accepted_by_user_id, name: acceptance.accepted_by_name || "(unnamed user)" }
        : "UNASSIGNED",
      accepted_at: (acceptance && acceptance.accepted_at) || null,
      en_route_at: latestByKind.en_route ? latestByKind.en_route.occurred_at : null,
      //  CURRENT means current. A no-access reported at 2:14 is not a fact
      //  about a work order closed at 4:40 — showing both put "Completed"
      //  and "No access reported" on screen together, which is the kind of
      //  stale line an operator reads as a live problem.
      //
      //  Tied to the derived state rather than to the row existing, so the
      //  chip and this line cannot disagree. The history still holds it.
      blocked: (state === "no_access" || state === "blocked")
        ? { reason: workOrder.not_done_reason || state,
            since: (latestByKind[state] || {}).occurred_at || null }
        : null,
      //  A CLAIM, labelled as one. Never merged into the completion fact.
      latest_finding: latestByKind.finding
        ? { note: latestByKind.finding.note, at: latestByKind.finding.occurred_at,
            by: latestByKind.finding.reported_by_name || "(unnamed user)", verified: false }
        : null,
      completion_claimed_at: latestByKind.completion_claimed ? latestByKind.completion_claimed.occurred_at : null,
      completed_at: latestByKind.completed ? latestByKind.completed.occurred_at : null,
      completed_by: latestByKind.completed
        ? { user_id: latestByKind.completed.reported_by_user_id,
            name: latestByKind.completed.reported_by_name || "(unnamed user)" }
        : null,
    },
    next_action: nextActionFor({ state, proof }),
    open_follow_up: followUp,
    proof,
    resident_update,
    history: progress.map((p) => ({
      id: p.id, kind: p.kind, at: p.occurred_at,
      actor: p.reported_by_name || "(unnamed user)",
      actor_user_id: p.reported_by_user_id,
      note: p.note,
      //  SOURCE ATTRIBUTION stays visible: every field fact traces to the
      //  message it was reported in.
      source_comm_event_id: p.source_comm_event_id,
    })),
  };
}

/*  What the transport actually did. Read from the outbound row's own
 *  status column and from nothing else — never inferred from the intent
 *  existing, and never from the work event having occurred. */
const SENT_STATUSES = ["queued", "sent", "sending", "accepted"];
function deliveryStateOf(row) {
  const s = String(row.sms_status || "").toLowerCase();
  if (s === "delivered") return { state: "delivered", provider_ref: row.sms_sid || null, error: null };
  if (s === "failed" || s === "undelivered" || s === "refused") {
    return { state: "failed", provider_ref: row.sms_sid || null, error: row.sms_error || null };
  }
  if (SENT_STATUSES.includes(s)) return { state: "sent", provider_ref: row.sms_sid || null, error: null };
  //  Prepared and nothing more. An honest blank, not an optimistic one.
  return { state: row.sms_sid ? "unknown" : "prepared", provider_ref: row.sms_sid || null, error: null };
}

/*  The list view. Same derivation, compact — so the board and the detail
 *  can never disagree about what state a work order is in. */
async function readPropertyWorkOrderStatuses(db, { propertyId, limit = 100 }) {
  if (!propertyId) return [];
  const ids = (await db.query(
    `select id from work_orders where property_id = $1
      order by (status <> 'complete') desc, created_at desc limit $2`, [propertyId, limit])).rows;
  const out = [];
  for (const row of ids) {
    // eslint-disable-next-line no-await-in-loop
    const s = await readWorkOrderStatus(db, { propertyId, workOrderId: row.id });
    if (s) {
      out.push({
        work_order: s.work_order, current: s.current, next_action: s.next_action,
        proof: { required: s.proof.required, satisfied: s.proof.satisfied,
                 not_preserved_count: s.proof.not_preserved_count },
        resident_update_count: s.resident_update.length,
        //  The LIST must be able to band on an unresolved resident update.
        //  Carrying only a count made a completed work order with a failed
        //  text indistinguishable from a clean one, so it sorted into
        //  "recently completed" and the operator never saw it.
        resident_update_failed: s.resident_update.filter(
          (r) => r.delivery && r.delivery.state === "failed").length,
      });
    }
  }
  return out;
}

module.exports = {
  readWorkOrderStatus, readPropertyWorkOrderStatuses,
  lifecycleStateOf, nextActionFor, deliveryStateOf,
  PROOF_REQUIRED_CLASSIFICATIONS,
};
