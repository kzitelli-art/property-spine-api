// ════════════════════════════════════════════════════════════════════
//  obligation_missed.js — THE durable missed-RECOGNITION primitive.
//
//  NAME THE CLAIM HONESTLY. This is NOT automated missed-window detection.
//  No sweeper exists in this system — nothing anywhere detects a crossed
//  window. `resolveRung(result:'missed')` is reachable only from human paths.
//  This module is the primitive a future sweeper AND the existing human paths
//  both call. Automatic recognition is a later slice with its own cadence,
//  ownership, retry, locking and recovery questions.
//
//  WHAT A MISS IS, AND IS NOT (ruling 2026-08-01):
//
//    lifecycle status        open | in_progress | complete | escalated
//    timeliness / recovery   on_time | due | overdue | missed
//
//  These are ORTHOGONAL. An obligation may be open and missed, in progress and
//  missed, escalated because it was missed, or complete having been missed
//  earlier. The rejected design put 'missed' into the lifecycle enum, which
//  erases every one of those distinctions.
//
//  A MISSED OBLIGATION KEEPS ITS LIFECYCLE. open stays open; in_progress stays
//  in_progress. It does not become complete, and it does not become escalated
//  merely to leave a queue. It stays VISIBLE because the underlying work still
//  has not happened. The conversion rung's local window and the operating
//  obligation are different truths: the window closed as missed, the obligation
//  is still open and actionable. The window ended; the work did not disappear.
//
//  OVERDUE IS NOT MISSED. `overdue` is a clock-derived operating condition and
//  moves with the clock — correct for what it is. `missed` is a DURABLE
//  INSTITUTIONAL FACT: someone or something recognised the window as missed, at
//  a recorded time. `missed` is never derived from the clock. Until missed_at
//  exists, the honest answer is `overdue` — otherwise an obligation would become
//  "missed" merely because a page was opened after the deadline.
// ════════════════════════════════════════════════════════════════════
"use strict";

//  Recognition is permitted ONLY from these lifecycle states. Retrospective
//  recognition of an already-complete obligation is DEFERRED: it needs its own
//  rule about late completion, evidence, and who may backdate an institutional
//  recognition. A later slice decides it.
const RECOGNIZABLE_STATUSES = ["open", "in_progress"];

//  A system actor must be a CONTROLLED NAMED value. "some background job did it"
//  is not an actor. Add here, reviewed on its own terms.
const SYSTEM_ACTORS = ["conversion_rail_window"];

function missedError(code, message, extra = {}) {
  const e = new Error(message);
  e.code = code;
  Object.assign(e, extra);
  return e;
}

//  THE CANONICAL TIMELINESS READ. Four states, one function, so the answer
//  cannot drift between surfaces.
//
//  This slice EXPORTS it and rewires nothing. Eight existing sites derive
//  timeliness independently — operator.js, leasing_desk_loader.js, desks.js,
//  board.js, server.js x2, unit_triage.js, work_acceptance_service.js — plus the
//  app's own missed_window with a grace band, under three different names
//  (overdue / missed_window / missed_commitment). Consolidating them is a
//  follow-on slice, deliberately not attempted while introducing the primitive.
function timelinessOf(obligation, now = new Date()) {
  if (!obligation) return null;
  // DURABLE FIRST, AND NEVER A CLOCK FALLBACK TO 'missed'. If no recognition
  // exists, the honest answer is overdue — not missed.
  if (obligation.missed_at) return "missed";
  if (!obligation.due_at) return "on_time";      // no clock ⇒ status-only
  const due = new Date(obligation.due_at).getTime();
  const t = now instanceof Date ? now.getTime() : new Date(now).getTime();
  if (t > due) return "overdue";
  return "due";
}

// ════════════════════════════════════════════════════════════════════
//  recognizeObligationMissed(client, spec)
//
//  Returns { recognized: true,  obligation }               on first recognition
//          { recognized: false, replayed: true, obligation } on a repeat
//  Throws on refusal. Never writes obligations.status.
// ════════════════════════════════════════════════════════════════════
async function recognizeObligationMissed(client, spec) {
  const {
    obligation_id,
    expected_status,
    expected_threshold_at = null,
    recognized_by_user_id = null,
    system_actor = null,
    reason = null,
    source = null,
    idempotency_key,
  } = spec || {};

  if (!obligation_id) throw missedError("BAD_INPUT", "obligation_id is required");
  if (!expected_status) {
    throw missedError("BAD_INPUT",
      "expected_status is required — a recognition must state the state it believes it is recognising");
  }
  if (!idempotency_key) throw missedError("BAD_INPUT", "idempotency_key is required");
  if (!reason && !source) {
    throw missedError("BAD_INPUT", "reason or source is required — a recognition records why and by which path");
  }

  //  EXACTLY ONE ACTOR. Never both, never neither. An institutional fact with no
  //  author is not a fact anyone can answer for.
  const hasUser = !!recognized_by_user_id;
  const hasSystem = !!system_actor;
  if (hasUser === hasSystem) {
    throw missedError("BAD_ACTOR",
      "exactly one of recognized_by_user_id or system_actor is required — never both, never neither");
  }
  if (hasSystem && !SYSTEM_ACTORS.includes(system_actor)) {
    throw missedError("BAD_ACTOR",
      `system_actor '${system_actor}' is not a controlled named actor`,
      { allowed: SYSTEM_ACTORS });
  }

  // LOCK, then read. Everything below decides against a row nobody else can move.
  const o = await client.query("select * from obligations where id=$1 for update", [obligation_id]);
  if (o.rows.length === 0) throw missedError("NOT_FOUND", "obligation not found");
  const ob = o.rows[0];

  // IDEMPOTENT REPLAY. A repeat returns the existing recognition rather than
  // throwing or writing again. Checked before every other refusal so a replay
  // stays a replay even once the lifecycle has moved on (e.g. later completed).
  if (ob.missed_at) {
    return { recognized: false, replayed: true, obligation: ob };
  }

  // T3 — only open | in_progress.
  if (!RECOGNIZABLE_STATUSES.includes(ob.status)) {
    throw missedError("LIFECYCLE_NOT_RECOGNIZABLE",
      `an obligation in '${ob.status}' cannot be recognised as missed in this slice — retrospective recognition after completion is deferred`,
      { actual_status: ob.status, allowed: RECOGNIZABLE_STATUSES });
  }

  // STALE STATE FAILS CLOSED — someone else moved it since the caller looked.
  if (ob.status !== expected_status) {
    throw missedError("STALE_OBLIGATION_STATE",
      `obligation is now '${ob.status}', not the expected '${expected_status}'`,
      { actual_status: ob.status });
  }

  // T1 — THE THRESHOLD IS DERIVED, NOT SUPPLIED. A caller that could name its
  // own threshold could mark anything missed by passing an earlier timestamp.
  const threshold = ob.due_at;
  if (!threshold) {
    throw missedError("NO_THRESHOLD",
      "obligation has no due_at — there is no window to miss");
  }
  if (expected_threshold_at != null) {
    const a = new Date(expected_threshold_at).getTime();
    const b = new Date(threshold).getTime();
    if (!(a === b)) {
      throw missedError("STALE_THRESHOLD",
        "expected_threshold_at does not match this obligation's current due_at — it was rescheduled since the caller looked",
        { actual_threshold_at: threshold });
    }
  }

  // T2 — ONE CONDITIONAL ATOMIC UPDATE under the lock. `missed_at is null` is
  // both the write-once guarantee and the concurrency gate: exactly one
  // transaction can satisfy it, so exactly one state transition and exactly one
  // event. The DATABASE CLOCK decides the crossing and the recognition time.
  const upd = await client.query(
    `update obligations
        set missed_at = now(),
            missed_threshold_at = due_at,
            missed_recognition_key = $2,
            updated_at = now()
      where id = $1
        and missed_at is null
        and due_at is not null
        and due_at < now()
    returning *`,
    [obligation_id, idempotency_key]
  );

  if (upd.rows.length === 0) {
    // Either a competing transaction won the race, or the window has not passed.
    const fresh = (await client.query(
      "select * from obligations where id=$1", [obligation_id])).rows[0];
    if (fresh && fresh.missed_at) {
      return { recognized: false, replayed: true, obligation: fresh };
    }
    throw missedError("THRESHOLD_NOT_CROSSED",
      "the window has not passed — an obligation cannot be recognised as missed before its deadline",
      { threshold_at: threshold });
  }
  const updated = upd.rows[0];

  // THE IMMUTABLE HISTORY. Written in the SAME transaction as the columns: both
  // or neither. The columns are a read accelerator; this row is the fact.
  await client.query(
    `insert into events (property_id, person_id, unit_id, type, note)
     values ($1,$2,$3,'obligation_missed',$4)`,
    [ob.property_id, ob.person_id, ob.unit_id,
     JSON.stringify({
       obligation_id,
       obligation_type: ob.type,
       module: ob.module,
       // the CANONICAL threshold, taken from the obligation
       threshold_at: updated.missed_threshold_at,
       missed_at: updated.missed_at,
       // lifecycle is recorded as UNCHANGED, so history states plainly that
       // recognising a miss did not move it
       lifecycle_status: updated.status,
       recognized_by_user_id: recognized_by_user_id || null,
       system_actor: system_actor || null,
       reason: reason || null,
       source: source || null,
       idempotency_key,
     })]
  );

  return { recognized: true, obligation: updated };
}

module.exports = {
  recognizeObligationMissed,
  timelinessOf,
  RECOGNIZABLE_STATUSES,
  SYSTEM_ACTORS,
  missedError,
};
