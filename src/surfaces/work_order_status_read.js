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

//  The four-state proof derivation (§3.2). One canonical predicate, shared
//  with the §4.2 defect sweep — see that module's header for why it is not
//  inlined here.
const proofState = require("../release0/proof_state.js");

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
 *  contradict the state above.
 *
 *  ── NO ACCESS IS FOUR SITUATIONS, NOT ONE ──────────────────────────
 *  Reporting no access already derives the coordinate-entry message to the
 *  resident. So "coordinate entry with resident" is the right instruction
 *  in exactly one of the four states — the one where nobody has asked them
 *  yet. In the others the operator is waiting, not acting, and saying
 *  otherwise invites them to send a message that has already been sent.
 */
const COORDINATION_NEXT = {
  none:      "Coordinate entry with resident",
  prepared:  "Resident message prepared, not yet sent",
  sent:      "Waiting for the resident to reply",
  delivered: "Waiting for the resident to reply",
  //  Handed to the carrier, nothing back. Not "sent", not "not sent".
  unknown:   "Waiting for the resident to reply",
  failed:    "Retry the resident message",
};

function nextActionFor({ state, proof, coordination = null }) {
  switch (state) {
    case "scheduled":           return "Assign or accept the work";
    case "accepted":            return "Technician to schedule and travel";
    case "en_route":            return "Technician is travelling";
    case "no_access":           return COORDINATION_NEXT[(coordination && coordination.state) || "none"]
                                       || COORDINATION_NEXT.none;
    case "blocked":             return "Resolve what the work is waiting on";
    case "completion_claimed":  return proof.satisfied ? "Close out the work order" : "Obtain repair photo before completion";
    case "completed":           return null;
    default:                    return null;
  }
}

/*  §3.1 — the corrected array. `unclassified` was removed: an unclassified
 *  photo is not proof of a repair. Production impact is zero rows (audit
 *  B2 = 0), and the Step 3 evidence gate already enforced this array — so
 *  until now the READER and the WRITER disagreed about what counts as
 *  proof, which is the drift §3.1 exists to end. */
const PROOF_REQUIRED_CLASSIFICATIONS = ["repair_photo", "condition"];

/*  readWorkOrderStatus — one work order, fully described.
 *
 *  `propertyId` is the SCOPE and comes from the authenticated session. It
 *  is passed into every query rather than checked afterwards, so a work
 *  order at another property returns null instead of leaking a row.
 */
async function readWorkOrderStatus(db, { propertyId, workOrderId, activationAuthority: activationAuthority_ = null }) {
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
            usr.name as accepted_by_name, asg.name as assigned_name
       from obligations o
       left join users usr on usr.id = o.accepted_by_user_id
       left join users asg on asg.id = o.assigned_user_id
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

  /*  ── STEP 8: THE FOUR-STATE PROOF READ (§3.2) ────────────────────
   *
   *  `satisfied` USED TO MEAN "preserved evidence exists". It now means
   *  what the frozen compatibility mapping says (§3.4), derived from the
   *  evaluation head, the inventory, and nothing else:
   *
   *    satisfied                 → true
   *    not_satisfied             → false
   *    legacy_indeterminate      → null
   *    missing_evaluation_defect → null
   *
   *  `null` is deliberate. Legacy history and a writer defect may NOT be
   *  collapsed into "proof failed" — that collapse is what made a closed
   *  work order with nothing behind it indistinguishable from a real one.
   *
   *  The derivation lives in release0/proof_state.js because §3.2.0
   *  requires the §4.2 defect sweep to use the SAME predicate. It is
   *  called from here and nowhere else.
   *
   *  `authority` may be supplied by a list read that resolved it once; a
   *  detail read resolves its own.  */
  const auth = activationAuthority_ || await proofState.activationAuthority(db);
  const derived = await proofState.deriveProofState(db, {
    workOrder, authority: auth, hasEligibleEvidence: preserved.length > 0,
  });

  const proof = {
    required: true,
    //  read_status first: when it is "unavailable", `state` and `satisfied`
    //  are ABSENT rather than null (§3.2.1). Spreading a conditional object
    //  is what makes the key genuinely absent instead of undefined-valued,
    //  which JSON.stringify would drop but an in-process consumer would not.
    ...derived,
    //  §19c Ruling C — presence booleans only. The legacy columns hold a
    //  stub:// string and free text; neither is proof and neither travels.
    legacy_evidence: proofState.legacyEvidenceOf(workOrder),
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
            ce.derived_from_progress_id, ce.classification, ce.channel,
            p.kind as derived_from_kind
       from comm_events ce
       left join work_order_progress p on p.id = ce.derived_from_progress_id
      where ce.property_id = $1 and ce.derived_from_progress_id is not null
        and ce.created_object_type = 'work_order' and ce.created_object_id = $2
      order by ce.occurred_at asc`, [propertyId, workOrderId])).rows;

  const resident_update = residentRows.map((row) => ({
    id: row.id,
    prepared_at: row.occurred_at,
    text: row.body,
    derived_from_progress_id: row.derived_from_progress_id,
    //  WHICH FACT caused it. A failed text about a completion and a failed
    //  text about entry are not the same exception and must not be labelled
    //  as though they were.
    derived_from_kind: row.derived_from_kind || null,
    classification: row.classification || null,
    channel: row.channel || null,
    delivery: deliveryStateOf(row),
  }));

  //  ── HAS THE RESIDENT ALREADY BEEN ASKED? ─────────────────────────
  //  Resolved against the canonical CAUSE — the no-access progress row —
  //  which is the same thing the automatic derivation and the operator
  //  action both record, and the same thing migration 136 makes unique.
  //  There is no second source of truth to disagree with.
  const coordination = residentCoordinationFor({ state, latestByKind, resident_update });

  //  The latest resident update the wire could not deliver, whatever caused
  //  it. Carried in `current` so the list and the detail band identically
  //  and neither has to re-derive it.
  const failedUpdates = resident_update.filter((r) => r.delivery.state === "failed");
  const resident_exception = failedUpdates.length
    ? { comm_event_id: failedUpdates[failedUpdates.length - 1].id,
        kind: failedUpdates[failedUpdates.length - 1].derived_from_kind,
        at: failedUpdates[failedUpdates.length - 1].prepared_at }
    : null;

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
      //  ASSIGNED is not ACCEPTED. "Nobody owns this" and "Dana has it and
      //  hasn't taken it yet" are different situations with different repairs,
      //  and the surface cannot say so without both facts.
      assigned_to: acceptance && acceptance.assigned_user_id
        ? { user_id: acceptance.assigned_user_id, name: acceptance.assigned_name || null }
        : null,
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
      resident_coordination: coordination,
      resident_exception,
    },
    next_action: nextActionFor({ state, proof, coordination }),
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

/*  ── THE FOUR COORDINATION STATES ───────────────────────────────────
 *
 *    none       nobody has asked the resident      → offer the action
 *    prepared   an intent exists, nothing sent     → say so, offer nothing
 *    sent       the wire took it                   → they were asked; wait
 *    delivered  the carrier confirmed it           → they were asked; wait
 *    failed     it did not arrive                  → retry THAT message
 *
 *  Only `none` is an invitation to act. The other four are the operator
 *  being told what already happened, which is the whole point: the system
 *  remembers what it did rather than asking somebody to do it again.
 *
 *  Null unless no-access is the CURRENT state — a coordination request is
 *  not a fact about a work order that has since moved on.
 */
function residentCoordinationFor({ state, latestByKind, resident_update }) {
  if (state !== "no_access") return null;
  const cause = latestByKind.no_access;
  if (!cause) return null;
  //  THE SAME SHAPE MIGRATION 136 GOVERNS. The index is scoped to the
  //  outbound resident work-order-update SMS, so a fact that later carries
  //  other derived messages — a different type, a different channel — has
  //  exactly one row that answers "has the resident been asked". Matching
  //  on the cause alone would let an unrelated derived message answer it.
  const asked = resident_update.find((r) => r.derived_from_progress_id === cause.id
    && r.classification === "work_order_update" && r.channel === "sms");
  if (!asked) return { state: "none", comm_event_id: null, at: null, cause_progress_id: cause.id };
  //  `unknown` is NOT rounded down to `prepared`. The carrier has the
  //  message and has told us nothing; saying "not yet sent" would be a
  //  confident wrong, and offering a second send on the strength of it is
  //  exactly the duplicate this whole change exists to prevent.
  return {
    state: asked.delivery.state,
    comm_event_id: asked.id, at: asked.prepared_at, cause_progress_id: cause.id,
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
  /*  §3.3 / §19 Ruling 2 — THE LIST CARRIES `state` TOO. The board renders
   *  from this subset, so if only the detail carried it the two surfaces
   *  would disagree on precisely the states the ruling exists to
   *  distinguish: a legacy closed row and a writer defect both show
   *  `satisfied: null`, and only `state` tells them apart.
   *
   *  The activation authority is resolved ONCE for the whole list rather
   *  than per row — a board of fifty work orders would otherwise ask the
   *  same question fifty times, and could in principle see it change
   *  mid-list and render two different verdicts on one screen. */
  const listAuthority = await proofState.activationAuthority(db);
  for (const row of ids) {
    // eslint-disable-next-line no-await-in-loop
    const s = await readWorkOrderStatus(db, {
      propertyId, workOrderId: row.id, activationAuthority: listAuthority });
    if (s) {
      out.push({
        work_order: s.work_order, current: s.current, next_action: s.next_action,
        proof: { required: s.proof.required,
                 //  read_status, and state/satisfied ONLY when the read
                 //  completed — absent, not null, when it did not (§3.2.1).
                 read_status: s.proof.read_status,
                 ...(s.proof.read_status === "ok"
                   ? { state: s.proof.state, satisfied: s.proof.satisfied }
                   : { reason_code: s.proof.reason_code }),
                 legacy_evidence: s.proof.legacy_evidence,
                 not_preserved_count: s.proof.not_preserved_count },
        resident_update_count: s.resident_update.length,
        //  The LIST must be able to band on an unresolved resident update.
        //  Carrying only a count made a completed work order with a failed
        //  text indistinguishable from a clean one, so it sorted into
        //  "recently completed" and the operator never saw it.
        //
        //  It is `current.resident_exception` that carries this now — the
        //  same object the detail reads, naming the message and the fact
        //  that caused it. A parallel count would be a second answer to a
        //  question that already has one.
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
