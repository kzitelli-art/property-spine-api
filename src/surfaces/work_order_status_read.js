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

/*  ── ATTENTION IS A SECOND DIMENSION, NOT AN EIGHTH STATE ───────────
 *
 *  A work order reported as not-complete keeps whatever physical lifecycle
 *  it legitimately had — a technician who accepted, travelled and then found
 *  the valve was wrong is still `accepted`; nothing about the physical work
 *  was undone. What changed is what SPINE IS WAITING ON, and that is a
 *  different axis:
 *
 *      physical lifecycle   scheduled · accepted · en_route · no_access ·
 *                           blocked · completion_claimed · completed
 *      attention            waiting on a part · vendor needed · approval ·
 *                           access · re-scope · return visit · PM review
 *
 *  Flattening them was the tempting fix and it is wrong twice over. Adding
 *  `needs_followup` as an eighth lifecycle value would overwrite a true fact
 *  about the physical work with a fact about the paperwork; writing a second
 *  `work_order_progress` row so the existing reader notices would duplicate
 *  history that the not-done path already records immutably in `events`.
 *
 *  So the fact is read where it was already written, and reported alongside
 *  the lifecycle rather than on top of it.
 */
function nextActionFor({ state, proof, coordination = null, attention = null }) {
  //  ATTENTION OUTRANKS THE LIFECYCLE for the next action, because it is the
  //  thing actually holding the work up. The physical state still describes
  //  where the work got to; it just is not what anybody does next.
  if (attention) return attention.label;
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

const PROOF_REQUIRED_CLASSIFICATIONS = ["repair_photo", "condition", "unclassified"];

const { FOLLOW_UP_TYPES, reasonForFollowType } = require("../maintenance/not_done_reasons");
const { acceptanceEligibility } = require("../technician/work_selection");

/*  attentionFrom — the open follow-up a stall routed, described from the
 *  immutable event that created it.
 *
 *  WHY THE EVENT AND NOT THE COLUMN. `work_orders.not_done_reason` holds only
 *  the most recent key, so a job stalled twice would describe its older open
 *  follow-up with the newer reason. The event note carries the reason that
 *  actually produced THIS obligation, and it cannot be overwritten.
 *
 *  Null when nothing is open. A resolved follow-up is history — the board
 *  must not keep asking for a part that already arrived.
 */
function attentionFrom(rows) {
  const open = rows.filter((r) => r.status !== "complete");
  if (open.length === 0) return null;
  //  The most recent open one. Two open follow-ups is a real (if unusual)
  //  state; the newest is what a human is being asked about now.
  const o = open[open.length - 1];

  let fromEvent = null;
  try {
    const note = o.event_note ? JSON.parse(o.event_note) : null;
    if (note && note.kind === "not_done" && note.reason) {
      fromEvent = { key: note.reason, label: note.reason_label || null };
    }
  } catch (e) { fromEvent = null; }   // unparseable note is not a reason to guess

  //  Fall back to reversing the routing table, so an event written before the
  //  note carried a reason still describes itself correctly.
  const mapped = reasonForFollowType(o.type);
  const key = (fromEvent && fromEvent.key) || (mapped && mapped.key) || null;
  const label = (fromEvent && fromEvent.label) || (mapped && mapped.label) || null;

  return {
    kind: "needs_followup",
    reason: key,
    //  §5 — a follow-up we cannot name is reported as one we cannot name.
    label: label || "Waiting on a follow-up",
    since: o.recorded_at || o.created_at || null,
    routed_to: {
      obligation_id: o.id, type: o.type,
      assigned_role: o.assigned_role || null, status: o.status,
    },
  };
}

/*  ── MAY THE PERSON LOOKING AT THIS TAKE IT? ────────────────────────
 *  Answered by the CANONICAL acceptance predicate, not by a second copy of
 *  its rules. `Take job` must never appear on a row the write would refuse —
 *  §28: a button label describes the action that will actually occur.
 *
 *  Null when the caller did not say who is looking (the SMS rail reads this
 *  surface with no viewer), because "nobody may accept" and "we were not
 *  asked" are different answers.
 */
function viewerCapabilityFor({ viewerUserId, assignedPropertyIds, organizationId, acceptance, workOrder }) {
  if (!viewerUserId) return null;
  if (!acceptance) {
    return { may_accept: false, refusal: "no_obligation_for_this_work_order" };
  }
  const verdict = acceptanceEligibility({
    actor: { userId: viewerUserId, organizationId: organizationId || null,
             assignedPropertyIds: assignedPropertyIds || [] },
    row: {
      obligation_id: acceptance.id,
      work_order_id: workOrder.id,
      related_type: "work_order",
      property_id: workOrder.property_id,
      assigned_user_id: acceptance.assigned_user_id,
      accepted_by_user_id: acceptance.accepted_by_user_id,
      status: acceptance.status,
    },
  });
  return { may_accept: verdict.eligible, refusal: verdict.eligible ? null : verdict.verdict };
}

/*  readWorkOrderStatus — one work order, fully described.
 *
 *  `propertyId` is the SCOPE and comes from the authenticated session. It
 *  is passed into every query rather than checked afterwards, so a work
 *  order at another property returns null instead of leaking a row.
 */
async function readWorkOrderStatus(db, {
  propertyId, workOrderId,
  //  WHO IS LOOKING. Optional, and server-derived by every caller — the
  //  operator routes pass the resolved staff session, the SMS rail passes
  //  nothing. It is used only to answer "may this person take this job",
  //  never to widen what rows are returned; `propertyId` remains the scope.
  viewerUserId = null, assignedPropertyIds = null, organizationId = null,
}) {
  if (!propertyId || !workOrderId) return null;

  const workOrder = (await db.query(
    `select w.*, u.unit_number
       from work_orders w left join units u on u.id = w.unit_id
      where w.id = $1 and w.property_id = $2`, [workOrderId, propertyId])).rows[0];
  if (!workOrder) return null;

  /*  ── WHO LIVES THERE ────────────────────────────────────────────────
   *  A work order in unit 631 and the resident of unit 631 are the same
   *  physical reality, and until now nothing related them. The board knew
   *  "Unit 631" as a STRING; a surface wanting to reach the person had to
   *  guess a human from a unit label, which §21 forbids — the browser
   *  requests, the server decides.
   *
   *  DERIVED FROM THE LEASE, not from the work order. Occupancy is the
   *  lease's fact, so it is read from the active lease on this unit and
   *  nowhere else. A work order carries no tenant column and must not grow
   *  one: that would be a second statement of who lives somewhere, free to
   *  drift from the first (§7).
   *
   *  §5 — EMPTY IS A REAL ANSWER, and it is not a failure. A common-area
   *  work order has no unit at all; a vacant unit has no active lease. Both
   *  return nothing, and the surface says nothing rather than inventing a
   *  resident or rendering a link to a person who does not exist.
   *
   *  ALL TENANTS, not a guessed primary. A lease may name several people and
   *  Spine has no basis for deciding which of them is "the" resident.
   *  Choosing one would be an invented fact; naming them all is the truth.  */
  const residents = workOrder.unit_id
    ? (await db.query(
        `select p.id, p.name
           from leases l
           join persons p on p.id = any(l.tenant_ids)
          where l.property_id = $1 and l.unit_id = $2
            and l.lease_status = 'active'
          order by p.name asc`, [propertyId, workOrder.unit_id])).rows
    : [];

  //  WHO IS ACCOUNTABLE. The obligation is the accountability rail; the
  //  work order's free-text assigned_to column is deliberately not read.
  //
  //  ACCOUNTABILITY IS NOT A ROUTED FOLLOW-UP. Both are obligations on this
  //  same work order, and until stalls were readable here the `created_at asc`
  //  ordering separated them only by luck: a work order whose accountability
  //  obligation was never created would have reported the assignee of its
  //  first FOLLOW-UP as the person accountable for the repair. The follow-up
  //  types are named, so exclude them rather than rely on arrival order.
  const acceptance = (await db.query(
    `select o.id, o.status, o.assigned_user_id, o.accepted_by_user_id, o.accepted_at,
            usr.name as accepted_by_name, asg.name as assigned_name
       from obligations o
       left join users usr on usr.id = o.accepted_by_user_id
       left join users asg on asg.id = o.assigned_user_id
      where o.related_type = 'work_order' and o.related_id = $1 and o.property_id = $2
        and not (o.type = any($3))
      order by o.created_at asc limit 1`,
    [workOrderId, propertyId, FOLLOW_UP_TYPES])).rows[0] || null;

  //  ── WHAT SPINE IS WAITING ON ──────────────────────────────────────
  //  The routed follow-ups a not-done produced, newest last, each carrying
  //  the immutable event that created it so the reason can be read from the
  //  fact rather than from a column that the next stall would overwrite.
  const followUps = (await db.query(
    `select o.id, o.type, o.status, o.assigned_role, o.created_at,
            e.occurred_at as recorded_at, e.note as event_note
       from obligations o
       left join events e on e.id = o.source_event_id
      where o.related_type = 'work_order' and o.related_id = $1 and o.property_id = $2
        and o.module = 'maintenance' and o.type = any($3)
      order by o.created_at asc`,
    [workOrderId, propertyId, FOLLOW_UP_TYPES])).rows;
  const attention = attentionFrom(followUps);

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

  //  THE VIEWER'S SCOPE. Resolved here for a single read; the list resolves
  //  it once and passes it in, because the answer is identical for every row
  //  at one property and a per-row query would be N+1 for nothing.
  let scope = assignedPropertyIds, org = organizationId;
  if (viewerUserId && scope === null) {
    const s = (await db.query(
      `select p.organization_id, pta.property_id
         from properties p
         left join property_team_assignments pta
           on pta.property_id = p.id and pta.user_id = $2 and pta.active = true
        where p.id = $1`, [propertyId, viewerUserId])).rows[0] || null;
    org = s ? s.organization_id : null;
    scope = s && s.property_id ? [s.property_id] : [];
  }

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
      //  ── TRUE EMERGENCY, DERIVED HERE AND NOWHERE ELSE ──────────────
      //  The canonical vocabulary is emergency | regular | needs_confirmation
      //  (078), and the canonical service already draws exactly this line:
      //  work_order_service.js:252, `is_emergency = urgency_status ===
      //  "emergency"`. Restating that comparison in a surface would be a
      //  second definition of what counts as an emergency, and the first
      //  time somebody decided `needs_confirmation` was close enough, an
      //  unconfirmed report would be shouting on an operator's board.
      //
      //  ONE BOOLEAN, not a severity scale. There is no tier vocabulary here
      //  on purpose: the product asked for the emergency distinction to be
      //  preserved, not for the old severity system to be rebuilt.
      //
      //  URGENCY IS NOT ATTENTION. This says how consequential the physical
      //  condition is; `current.attention` and the surface's banding say
      //  whether a human must act now. An emergency somebody has accepted
      //  and is driving to is urgent and NOT waiting on anyone.
      is_emergency: workOrder.urgency_status === "emergency",
      opened_at: workOrder.created_at,
      /*  The people the work is happening TO. Person id plus name only —
       *  enough for a surface to name them and open their Person Card, and
       *  nothing that would make this projection a second dossier (§13). */
      residents: residents.map((r) => ({ person_id: r.id, name: r.name || "(unnamed)" })),
    },
    current: {
      state,
      //  THE SECOND DIMENSION. Null when nothing is holding the work up.
      //  It sits beside `state` rather than replacing it, so a surface can
      //  say "KZ · ACCEPTED / Waiting on a part" — two true facts about one
      //  job — instead of overwriting the first with the second.
      attention,
      //  MAY THE VIEWER TAKE THIS. Null when the caller did not say who is
      //  looking. Derived from the canonical acceptance predicate, so the
      //  control can never offer a verb the write would refuse.
      viewer: viewerCapabilityFor({
        viewerUserId, assignedPropertyIds: scope, organizationId: org, acceptance,
        workOrder: { id: workOrder.id, property_id: workOrder.property_id },
      }),
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
    next_action: nextActionFor({ state, proof, coordination, attention }),
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
async function readPropertyWorkOrderStatuses(db, { propertyId, limit = 100, viewerUserId = null }) {
  if (!propertyId) return [];

  //  THE VIEWER'S SCOPE, READ ONCE. `acceptanceEligibility` needs the actor's
  //  active assignments, and resolving them per work order would issue one
  //  query per row for an answer that cannot differ between rows — they are
  //  all at this one property. Read here and passed down.
  //
  //  Scope membership, not organization membership: belonging to the company
  //  is not authority over every building in it, which is why this reads
  //  property_team_assignments and not the org.
  let scope = null, organizationId = null;
  if (viewerUserId) {
    const s = (await db.query(
      `select p.organization_id, pta.property_id
         from properties p
         left join property_team_assignments pta
           on pta.property_id = p.id and pta.user_id = $2 and pta.active = true
        where p.id = $1`, [propertyId, viewerUserId])).rows[0] || null;
    organizationId = s ? s.organization_id : null;
    scope = s && s.property_id ? [s.property_id] : [];
  }

  const ids = (await db.query(
    `select id from work_orders where property_id = $1
      order by (status <> 'complete') desc, created_at desc limit $2`, [propertyId, limit])).rows;
  const out = [];
  for (const row of ids) {
    // eslint-disable-next-line no-await-in-loop
    const s = await readWorkOrderStatus(db, {
      propertyId, workOrderId: row.id,
      viewerUserId, assignedPropertyIds: scope, organizationId,
    });
    if (s) {
      out.push({
        work_order: s.work_order, current: s.current, next_action: s.next_action,
        //  `preserved_count` rides along so a verified completion can say
        //  "Proof verified · 2 photos" on the board without the row having to
        //  fetch the detail to count them. It is the same number the detail
        //  carries — not a second derivation.
        proof: { required: s.proof.required, satisfied: s.proof.satisfied,
                 preserved_count: s.proof.preserved_count,
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
