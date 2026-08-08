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

const { preservedEvidenceFor, allEvidenceFor, completionEligibleEvidenceFor,
        COMPLETION_EVIDENCE_CLASSIFICATIONS } = require("./evidence_service");
const proofEvaluations = require("../maintenance/proof_evaluation_service.js");
const proofDefects = require("../maintenance/proof_defect_service.js");
const releaseProofState = require("../release0/proof_state.js");

const PROGRESS_KINDS = ["en_route", "no_access", "blocked", "finding", "completion_claimed", "completed"];

//  What a completion needs before a work order may close. One preserved
//  photo of the repair. Stated here, in one place, so the rule cannot
//  differ between the SMS door and any future one.
//  ONE array, owned by the evidence service. It was duplicated here as
//  ["repair_photo","condition","unclassified"] while the corrected array
//  (§3.1) drops 'unclassified' — an unclassified photo is not proof of a
//  repair. Two copies of a rule is how they come to disagree, so this
//  now cites the one the gate actually enforces.
const COMPLETION_REQUIRES = Object.freeze({
  evidence: true,
  classifications: COMPLETION_EVIDENCE_CLASSIFICATIONS,
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

/*  §4.2 caller (a). Uses the READER's predicate — never a local copy —
 *  so the writer, the reader and the sweep cannot disagree about which
 *  row is a defect (§3.2.0).
 *
 *  Returns null when there is nothing to notice, which is the ordinary
 *  case: a terminal work order carrying a proper evaluation, or a
 *  legitimate legacy row sitting in the cutover inventory. */
async function noticeTerminalWithoutEvaluation(client, wo) {
  const authority = await releaseProofState.activationAuthority(client);
  //  No activation, no inventory, nothing separating legacy from defect.
  //  Raising here would accuse every legacy row. Say nothing.
  if (!authority.available) return null;

  const derived = await releaseProofState.deriveProofState(client, { workOrder: wo, authority });
  if (derived.read_status !== "ok" || derived.state !== "missing_evaluation_defect") return null;

  const out = await proofDefects.raiseProofEvaluationDefect(client, {
    work_order_id: wo.id, property_id: wo.property_id, unit_id: wo.unit_id || null,
    detected_by: "technician.lifecycle_service.claimCompletion",
  });
  return { outcome: out.outcome, obligation_id: out.obligation && out.obligation.id };
}

/*  The one writer of work_order_progress. Every verb goes through it, so
 *  every field fact carries an actor, a source message and a key. */
async function appendProgress(client, { wo, kind, user_id, note, source_comm_event_id, idempotency_key }) {
  if (!PROGRESS_KINDS.includes(kind)) {
    throw lifecycleError("BAD_INPUT", `unknown progress kind ${JSON.stringify(kind)}`);
  }
  /*  ── THE RECOVERY MUST NOT RUN ON A POISONED TRANSACTION ──────────
   *
   *  PostgreSQL aborts the WHOLE transaction on a failed statement. The
   *  duplicate-key recovery below is a SELECT, and a SELECT issued after
   *  the failing INSERT — with no savepoint between them — does not run:
   *  it raises `current transaction is aborted, commands ignored until
   *  end of transaction block`. The handler that exists to make a carrier
   *  redelivery harmless was itself throwing, rolling back the caller's
   *  entire operations turn.
   *
   *  The savepoint is what makes the failure recoverable. Same discipline
   *  as the read-only audit probes: a probe must not poison the
   *  transaction it is probing.
   *
   *  Every caller of this service already runs inside an explicit
   *  transaction — `assertActorMayOperate` takes `for update`, which
   *  outside one would lock nothing. A SAVEPOINT outside a transaction
   *  block raises rather than silently doing nothing, which is the
   *  behaviour we want if that ever stops being true.  */
  await client.query("savepoint append_progress");
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
    await client.query("release savepoint append_progress");
    return { row, replayed: false };
  } catch (e) {
    //  A carrier redelivery lost the race. The fact is already recorded.
    //  Undo only this attempt; the caller's transaction stays usable.
    await client.query("rollback to savepoint append_progress");
    await client.query("release savepoint append_progress");

    //  The ONLY duplicate this may absorb is the idempotency key, which is
    //  the only unique index on the table (134, partial: `where
    //  idempotency_key is not null`). Without a key there is nothing to
    //  look the prior fact up by, so a 23505 here means something else
    //  collided and swallowing it would invent a replay that never
    //  happened. Same if the lookup finds nothing.
    if (e.code === "23505" && idempotency_key) {
      const existing = (await client.query(
        `select * from work_order_progress where idempotency_key = $1`, [idempotency_key])).rows[0];
      if (existing) return { row: existing, replayed: true };
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
    /*  ── §4.2 CALLER (a) ───────────────────────────────────────────
     *  This is the canonical writer LOOKING AT a terminal work order it
     *  did not just evaluate. If that row also has no evaluation and is
     *  absent from the cutover inventory, something else wrote a terminal
     *  status after the cutover — the defect this release exists to
     *  surface — and the writer is the first thing to notice.
     *
     *  Reported, not repaired. It records the accountability fact and
     *  still refuses the field fact; a refusal that quietly fixed things
     *  would be a second completion path by another name.
     *
     *  It is deliberately best-effort: a defect-detection failure must
     *  never turn a technician's ordinary refusal into a thrown turn. The
     *  sweep re-derives the same population and converges.  */
    let defect = null;
    try {
      defect = await noticeTerminalWithoutEvaluation(client, wo);
    } catch (e) {
      //  Swallowed ON PURPOSE, and named so it is visible in the log.
      console.error("proof-defect notice failed (non-fatal):", e.message);
    }
    return { outcome: "refused", refusal: "work_order_already_complete",
             progress: null, workOrder: wo, proofDefect: defect };
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

  //  ── THE EVIDENCE GATE (§3.1, Part C) ──────────────────────────────
  //  Scoped to the work order AND its property, and asking about the
  //  STORED BYTES rather than a carrier's claim: content, byte_size,
  //  sha256 and stored_at all present, a verified MIME, and the
  //  CORRECTED classification array — 'unclassified' is not proof of a
  //  repair. The legacy completion_photo/completion_note columns are
  //  never consulted: that column holds a `stub://` string with no bytes.
  const preserved = await completionEligibleEvidenceFor(client,
    { work_order_id, property_id: claim.workOrder.property_id });

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

  //  ── FACT 2 + 3: THE PROOF EVALUATION AND ITS LINKS ────────────────
  //  Written BEFORE the status changes, so a failure here — a lost
  //  supersession race, a corrupt chain, migration 137 absent — rolls the
  //  whole transaction back with the work order still open. A completion
  //  that exists without the evaluation that justified it is the precise
  //  state Release 0 exists to make impossible, so it is written first
  //  and the rest is contingent on it.
  //
  //  `satisfied` because the evidence gate above already refused every
  //  path that would not be. `not_satisfied` is written by the defect and
  //  review paths, not here.
  const evaluated = await proofEvaluations.recordEvaluation(client, {
    work_order_id, property_id: claim.workOrder.property_id,
    state: "satisfied", evaluated_by_user_id: user_id,
    attachment_ids: preserved.map((a) => a.id),
  });

  /*  ── §4.2 CLOSURE: the evaluation is the resolution ────────────────
   *  A `proof_evaluation_missing` obligation exists precisely because
   *  this work order had no evaluation. It now has one, so the defect is
   *  genuinely resolved and the obligation closes in the SAME transaction
   *  that resolved it — never as a follow-up job that could fail and
   *  leave an accountability item open against work that is proven.
   *
   *  The service DERIVES the resolution rather than taking one from here.
   *  This call cannot close an obligation over a defect that persists,
   *  even if this code is wrong about why it is calling.
   *
   *  Almost always a no-op: the obligation only exists if something wrote
   *  a terminal status outside this writer. `nothing_open` is the normal
   *  answer and is not an error.  */
  const defectClosure = await proofDefects.resolveProofEvaluationDefect(client, {
    work_order_id, property_id: claim.workOrder.property_id,
    closed_by: "technician.lifecycle_service.claimCompletion",
  });

  //  CLOSE IT. A second `completed` progress row records the governed
  //  decision as its own fact, distinct from the claim that triggered it.
  //
  //  completion_note is still written because it is the operator-visible
  //  note on the row, NOT because it is evidence — nothing reads it as
  //  proof, and §4.1 forbids ever converting it into any. Step 6 retires
  //  the legacy path that treats it as more than a note.
  await client.query(
    `update work_orders set status = 'complete', not_done_reason = null,
            completion_note = coalesce($2, completion_note), updated_at = now()
      where id = $1`, [work_order_id, note]);

  //  The owning obligation closes with it — work and accountability move
  //  together or neither moves.
  //
  //  PROPERTY-SCOPED. Without property_id this matched on
  //  (related_type, related_id) alone and trusted work-order ids to be
  //  globally unique — true today, and not a property any of this should
  //  depend on. Every other write in this transaction is scoped; this one
  //  now is too.
  await client.query(
    `update obligations set status = 'complete', completed_at = now(),
            resolution_code = 'satisfied', updated_at = now()
      where related_type = 'work_order' and related_id = $1 and property_id = $2
        and status <> 'complete'`,
    [work_order_id, claim.workOrder.property_id]);

  const closedWo = (await client.query(`select * from work_orders where id=$1`, [work_order_id])).rows[0];
  const done = await appendProgress(client, {
    wo: closedWo, kind: "completed", user_id, note: null,
    source_comm_event_id, idempotency_key: idempotency_key ? `${idempotency_key}:completed` : null,
  });

  return { outcome: "completed", refusal: null, progress: done.row, claimProgress: claim.progress,
           workOrder: closedWo, closed: true, missing: null, evidenceAttempted: true,
           evidenceCount: preserved.length,
           proofDefectClosure: defectClosure,
           evaluation: evaluated.evaluation, supersededEvaluationId: evaluated.supersededId,
           evaluationLinks: evaluated.linked };
}

module.exports = {
  PROGRESS_KINDS, COMPLETION_REQUIRES,
  reportFieldFact, claimCompletion, lifecycleError,
};
