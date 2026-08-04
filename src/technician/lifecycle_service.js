/* ════════════════════════════════════════════════════════════════════
   technician/lifecycle_service.js — THE canonical field-report writes.

   One place records what happened in the field. Every surface that ever
   offers these verbs — SMS, dashboard, a future app — calls this.

   ── THE FIVE FACTS, AND WHY THEY ARE FIVE ───────────────────────────

     en_route            they are going. The work is not done and nobody
                         has claimed otherwise.
     no_access           they went and could not get in. The work stays
                         OPEN and something new is now needed: access.
     blocked             they went, got in, and something else stops them.
                         Also open, different follow-up.
     finding             what they saw or did. History, not status.
     completion_claimed  they say it is finished. NOT completion.

   `completion_claimed` and `completed` are deliberately two rows written
   by two decisions. A technician saying "all done" is a claim; whether
   the work order may close is a governed decision made against the
   evidence that actually exists. Collapsing them is how a work order gets
   closed with nothing behind it.

   ── APPEND-ONLY ─────────────────────────────────────────────────────
   No UPDATE path on history, no DELETE path anywhere. "Said en route at
   9:02, reported no access at 9:31" is the record; overwriting the first
   would make the second unexplainable.

   ── SERVER-DERIVED AUTHORITY (§21) ──────────────────────────────────
   Every entry point re-derives the actor's scope from
   property_team_assignments against the LOCKED work order. A caller that
   already resolved scope cannot supply it here as authority.
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const { preservedEvidenceFor, allEvidenceFor } = require("./evidence_service");

const PROGRESS_KINDS = ["en_route", "no_access", "blocked", "finding", "completion_claimed", "completed"];

//  What a completion needs before a work order may close. One preserved
//  photo of the repair. Stated here, in one place, so the rule cannot
//  differ between the SMS door and any future one.
const COMPLETION_REQUIRES = Object.freeze({
  evidence: true,
  classifications: ["repair_photo", "condition", "unclassified"],
});

function lifecycleError(code, message, extra = {}) {
  const e = new Error(message); e.code = code; Object.assign(e, extra); return e;
}

/*  The actor's own active assignment at THIS work order's property, read
 *  inside the transaction. Never accepted as an argument. */
async function assertActorMayOperate(client, { work_order_id, user_id, organization_id }) {
  const wo = (await client.query(
    `select * from work_orders where id = $1 for update`, [work_order_id])).rows[0];
  if (!wo) throw lifecycleError("NOT_FOUND", "work order not found");

  const { rows } = await client.query(
    `select 1 from property_team_assignments pta
       join properties p on p.id = pta.property_id and p.organization_id = $3
      where pta.user_id = $1 and pta.property_id = $2 and pta.active = true`,
    [user_id, wo.property_id, organization_id]);
  if (!rows.length) {
    return { wo: null, refusal: "property_outside_actor_scope" };
  }
  return { wo, refusal: null };
}

/*  The one writer of work_order_progress. Every verb goes through it, so
 *  every field fact carries an actor, a source message and a key. */
async function appendProgress(client, { wo, kind, user_id, note, source_comm_event_id, idempotency_key }) {
  if (!PROGRESS_KINDS.includes(kind)) {
    throw lifecycleError("BAD_INPUT", `unknown progress kind ${JSON.stringify(kind)}`);
  }
  try {
    const row = (await client.query(
      `insert into work_order_progress
         (work_order_id, property_id, kind, reported_by_user_id, note, source_comm_event_id, idempotency_key)
       values ($1,$2,$3,$4,$5,$6,$7) returning *`,
      [wo.id, wo.property_id, kind, user_id, note || null, source_comm_event_id || null,
       idempotency_key || null])).rows[0];
    await client.query(
      `insert into events (property_id, unit_id, type, note)
       values ($1,$2,$3,$4)`,
      [wo.property_id, wo.unit_id, `work_order_${kind}`,
       JSON.stringify({ work_order_id: wo.id, progress_id: row.id, reported_by_user_id: user_id,
                        note: note || null, source_comm_event_id: source_comm_event_id || null })]);
    return { row, replayed: false };
  } catch (e) {
    //  A carrier redelivery lost the race. The fact is already recorded.
    if (e.code === "23505") {
      const existing = (await client.query(
        `select * from work_order_progress where idempotency_key = $1`, [idempotency_key])).rows[0];
      return { row: existing, replayed: true };
    }
    throw e;
  }
}

/*  ── THE VERBS ──────────────────────────────────────────────────────
 *  Each returns { outcome, progress, workOrder, refusal, ... }. None of
 *  them sends anything.
 */
async function reportFieldFact(client, {
  kind, work_order_id, user_id, organization_id, note = null,
  source_comm_event_id = null, idempotency_key = null,
} = {}) {
  if (!work_order_id || !user_id || !organization_id) {
    throw lifecycleError("BAD_INPUT", "work_order_id, user_id and organization_id are required");
  }
  const { wo, refusal } = await assertActorMayOperate(client, { work_order_id, user_id, organization_id });
  if (refusal) return { outcome: "refused", refusal, progress: null, workOrder: null };

  //  A closed work order does not receive new field facts. Reopening is a
  //  different, governed act that this slice does not build.
  if (wo.status === "complete") {
    return { outcome: "refused", refusal: "work_order_already_complete", progress: null, workOrder: wo };
  }

  const { row, replayed } = await appendProgress(client,
    { wo, kind, user_id, note, source_comm_event_id, idempotency_key });

  //  NO ACCESS and BLOCKED are the two that change what the work order
  //  needs next. The work stays OPEN in both cases — it was not done.
  if (!replayed && (kind === "no_access" || kind === "blocked")) {
    await client.query(
      `update work_orders set not_done_reason = $2, updated_at = now() where id = $1`,
      [wo.id, kind === "no_access" ? "no_access" : "blocked"]);
  }

  const workOrder = (await client.query(`select * from work_orders where id=$1`, [wo.id])).rows[0];
  return { outcome: replayed ? "replayed" : "recorded", refusal: null, progress: row, workOrder };
}

/*  ── GOVERNED COMPLETION ────────────────────────────────────────────
 *  The technician's claim is ALWAYS recorded. Whether the work order
 *  closes is decided here, against the evidence that actually exists.
 *
 *  A photo we referenced but could not preserve does NOT satisfy the
 *  requirement — that is exactly the case where a carrier URL would have
 *  read as proof and later evaporated.
 */
async function claimCompletion(client, {
  work_order_id, user_id, organization_id, note = null,
  source_comm_event_id = null, idempotency_key = null,
} = {}) {
  const claim = await reportFieldFact(client, {
    kind: "completion_claimed", work_order_id, user_id, organization_id, note,
    source_comm_event_id, idempotency_key,
  });
  if (claim.outcome === "refused") return { ...claim, closed: false, missing: null };

  const preserved = await preservedEvidenceFor(client,
    { work_order_id, classifications: COMPLETION_REQUIRES.classifications });

  if (COMPLETION_REQUIRES.evidence && preserved.length === 0) {
    //  The claim stands and is recorded. The work order does not close.
    const attempted = await allEvidenceFor(client, { work_order_id });
    return {
      outcome: claim.outcome, refusal: null, progress: claim.progress,
      workOrder: claim.workOrder, closed: false,
      missing: "repair_photo",
      //  Distinguishes "you sent nothing" from "you sent one and we could
      //  not save it" — different sentences, different repairs.
      evidenceAttempted: attempted.length > 0,
    };
  }

  if (claim.outcome === "replayed" && claim.workOrder.status === "complete") {
    return { outcome: "replayed", refusal: null, progress: claim.progress,
             workOrder: claim.workOrder, closed: true, missing: null, evidenceAttempted: true };
  }

  //  CLOSE IT. A second `completed` progress row records the governed
  //  decision as its own fact, distinct from the claim that triggered it.
  await client.query(
    `update work_orders set status = 'complete', not_done_reason = null,
            completion_note = coalesce($2, completion_note), updated_at = now()
      where id = $1`, [work_order_id, note]);

  //  The owning obligation closes with it — work and accountability move
  //  together or neither moves.
  await client.query(
    `update obligations set status = 'complete', completed_at = now(),
            resolution_code = 'satisfied', updated_at = now()
      where related_type = 'work_order' and related_id = $1 and status <> 'complete'`,
    [work_order_id]);

  const closedWo = (await client.query(`select * from work_orders where id=$1`, [work_order_id])).rows[0];
  const done = await appendProgress(client, {
    wo: closedWo, kind: "completed", user_id, note: null,
    source_comm_event_id, idempotency_key: idempotency_key ? `${idempotency_key}:completed` : null,
  });

  return { outcome: "completed", refusal: null, progress: done.row, claimProgress: claim.progress,
           workOrder: closedWo, closed: true, missing: null, evidenceAttempted: true,
           evidenceCount: preserved.length };
}

module.exports = {
  PROGRESS_KINDS, COMPLETION_REQUIRES,
  reportFieldFact, claimCompletion, lifecycleError,
};
