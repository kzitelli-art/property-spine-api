/* ════════════════════════════════════════════════════════════════════
   maintenance/not_done_service.js — THE ONE WRITER FOR "WORK STOPPED".

   ── WHY THIS EXISTS ─────────────────────────────────────────────────
   The behavior below already shipped, inline, inside
   `PATCH /work-orders/:id/closeout`. The signed-in operator app cannot
   reach that route: it is gated by the shared `x-operator-key` rather
   than a staff session, and it carries no property scope, so a caller
   authenticated for one building could stall a work order in another.

   The wrong fix is a second implementation behind an `/operator/` path.
   Two writers producing the same terminal fact is the exact shape
   Release 0 exists to remove — they agree until they don't, and then a
   stalled job exists that only one of them knows how to route.

   So the behavior moved HERE, unchanged, and both routes call it:

     PATCH /work-orders/:id/closeout   done=false   shared key, legacy
     POST  /operator/work-orders/:id/not-done       staff session, scoped

   §18 — the legacy caller is a CLASS 3 compatibility path. It is removed
   when no non-operator consumer of `closeout` remains; the shared key is
   held outside this repo, so absence of a caller here is not absence.

   ── WHAT IS RECORDED, AND WHAT IS DERIVED ───────────────────────────
   The reporter states ONE fact: what is stopping completion. Everything
   below is Spine's consequence, and none of it is theirs to choose.

     1  an immutable `events` row            what happened, and why
     2  the work order stays OPEN            `needs_followup`, reason in
                                             its own column — never the
                                             completion note
     3  a ROUTED follow-up obligation        the named next step, with a
                                             named owner and an escalation

   THE WORK ORDER IS NOT CLOSED. A stall is a fork, not an ending, and
   step 3 is what keeps the chain alive: "nothing is done until the next
   step is visible."
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const { routeFor, NOT_DONE_REASONS } = require("./not_done_reasons");

class NotDoneError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.code = code;
    Object.assign(this, extra);
  }
}

/*  recordNotDone — runs inside a transaction the CALLER owns, so the stall,
 *  its event and its follow-up commit or roll back together. A stall with no
 *  routed next step is the one outcome this must never leave behind.
 *
 *  `workOrder` is a row the caller has already loaded and locked. It is
 *  passed in rather than re-read because the caller is responsible for
 *  proving it may touch it — property scope is authority, and this service
 *  does not re-derive authority it was not given.
 */
async function recordNotDone(client, {
  workOrder, reasonKey, note = null, actorUserId = null,
  spawnObligationFromEvent, defaultWhenMissing = false,
} = {}) {
  if (!client) throw new NotDoneError("BAD_INPUT", "a transaction client is required");
  if (!workOrder || !workOrder.id) throw new NotDoneError("BAD_INPUT", "workOrder is required");
  if (typeof spawnObligationFromEvent !== "function") {
    throw new NotDoneError("BAD_INPUT", "spawnObligationFromEvent must be injected");
  }

  //  §5 — AN UNKNOWN REASON IS REFUSED, NEVER COERCED. A reason we cannot
  //  route produces a stall with no named next step, which is precisely the
  //  failure the continuity engine exists to prevent.
  //
  //  `defaultWhenMissing` exists only for the legacy caller, whose contract
  //  has always been that a blank reason routes to PM review rather than
  //  vanishing. The operator surface passes false: its picker is populated
  //  from this same vocabulary, so a missing reason there is a defect in the
  //  surface, not an old client being generous with.
  const key = reasonKey || (defaultWhenMissing ? "other" : null);
  const route = key && routeFor(key);
  if (!route) {
    throw new NotDoneError("INVALID_REASON",
      key ? `not a routable reason: ${key}` : "a reason is required",
      { allowed: Object.keys(NOT_DONE_REASONS) });
  }

  const wo = workOrder;
  const person = wo.affected_person_id ?? wo.reported_by_person_id ?? null;

  //  1) THE DURABLE EVENT. The obligation is born only from an event, and
  //     this row is the immutable record of what the reporter said. It is
  //     also what the read surface times "since" from — the work order's
  //     `updated_at` moves for unrelated reasons and cannot answer it.
  const followNote = {
    work_order_id: wo.id,
    kind: "not_done",
    reason: key,
    reason_label: route.label,
    routes_to: route.follow_type,
    owner_role: route.follow_role,
    note: note || null,          // optional reporter context, kept separate
    reported_by_user_id: actorUserId || null,
  };
  const ev = await client.query(
    `insert into events (property_id, person_id, unit_id, type, note)
     values ($1,$2,$3,'maintenance_followup',$4) returning *`,
    [wo.property_id, person, wo.unit_id ?? null, JSON.stringify(followNote)]);

  //  2) THE WORK ORDER STAYS OPEN, flagged for review, with the structured
  //     reason in its OWN column. `completion_note` means only "completion
  //     note" and is not overwritten with the stall reason.
  await client.query(
    `update work_orders
        set status='needs_followup', needs_pm_review=true,
            not_done_reason=$2, updated_at=now()
      where id=$1`, [wo.id, key]);

  //  3) THE ROUTED FOLLOW-UP, through the shared engine, in THIS transaction.
  //     related_id/related_type link it back so the next owner inherits the
  //     full context rather than a sentence about it.
  const followup = await spawnObligationFromEvent(client, {
    property_id: wo.property_id,
    person_id: person,
    unit_id: wo.unit_id ?? null,
    source_event_id: ev.rows[0].id,
    module: "maintenance",
    type: route.follow_type,
    label: route.follow_label(wo),
    owner_type: "human",
    assigned_role: route.follow_role,
    escalates_to_role: route.escalates_to,
    status: "open",
    priority: "normal",
    severity: "normal",
    related_id: wo.id,
    related_type: "work_order",
  });

  return { reasonKey: key, route, event: ev.rows[0], followup };
}

module.exports = { recordNotDone, NotDoneError };
