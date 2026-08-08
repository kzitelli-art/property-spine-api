/* ════════════════════════════════════════════════════════════════════
   maintenance/proof_defect_service.js — THE one writer of the
   `proof_evaluation_missing` obligation (§4.2).

   A `missing_evaluation_defect` means a work order reached a terminal
   status, carries no proof evaluation, and is NOT in the cutover
   inventory — so it is not legacy history. Something wrote a terminal
   status outside the canonical writer, after the cutover. That is an
   accountability fact, and this codebase's accountability rail is the
   obligation, so it becomes one.

   ── NO CALLER INSERTS THE OBLIGATION DIRECTLY ───────────────────────

   Two callers, both through here (§4.2):

     a  claimCompletion, when it observes a terminal work order it did not
        just evaluate and which is absent from the inventory
     b  the scheduled sweep

   ── THE REPORTER IS NOT THE WRITER ──────────────────────────────────

   The READER stays pure. Revision 2 raised the obligation from the read,
   which would have made every board render a write, duplicated on every
   refresh, and turned a GET into something that fails on a read-only
   replica. The reader computes and returns; this writes.

   ── IDEMPOTENT BY CONSTRUCTION, NOT BY CHECKING ─────────────────────

   Migration 138's partial unique index makes a duplicate outstanding
   obligation UNREPRESENTABLE. This inserts and treats the conflict as
   success. A check-then-insert would be a race, and two overlapping sweep
   runs is the ordinary case for a scheduled rail.

   The conflict arrives as a raised error, because the obligation engine
   has no `on conflict` clause and is not going to grow one for this
   caller. So the insert runs inside a SAVEPOINT: PostgreSQL aborts the
   whole transaction on a failed statement, and without one the recovery
   would be issued on a dead transaction. That is not hypothetical — it
   is the defect found in `appendProgress` on 2026-08-08, where the
   handler written to absorb a duplicate was itself what threw.

   The savepoint also rolls back the EVENT written alongside the
   obligation, so a re-run leaves no trail of near-misses.

   ── UNASSIGNED IS THE HONEST ANSWER ─────────────────────────────────

   §4.2 freezes the routing: assigned_role `property_manager`, escalating
   to `asset_manager`. It does NOT name a person, and neither does this.
   `assigned_user_id` stays null — the obligation is owned by a ROLE until
   a governed assignment gives it a human. Resolving one here would be
   inventing an ownership ruling nobody made.
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const { spawnObligationFromEvent } = require("../shared/obligation_engine.js");

const OBLIGATION_TYPE = "proof_evaluation_missing";
const SERVICE_NAME = "maintenance.proof_defect_service";

//  Frozen by §4.2. Stated as data so a drift shows up as a diff.
const DEFECT_SPEC = Object.freeze({
  module: "maintenance",
  type: OBLIGATION_TYPE,
  owner_type: "human",
  assigned_role: "property_manager",
  escalates_to_role: "asset_manager",
  status: "open",
  priority: "normal",
  severity: "normal",
  related_type: "work_order",
  required_inputs: ["proof_evaluation"],
});

function defectError(code, message) {
  const e = new Error(message); e.code = code; return e;
}

/**
 * Raise the defect obligation for ONE work order. Idempotent.
 *
 * @returns { outcome: "raised" | "already_open", obligation | null }
 */
async function raiseProofEvaluationDefect(client, {
  work_order_id, property_id, detected_by = SERVICE_NAME, unit_id = null,
} = {}) {
  if (!work_order_id || !property_id) {
    //  Both, always. The obligation's uniqueness is keyed on
    //  (property_id, related_id), so an unscoped call could not be
    //  deduplicated even in principle.
    throw defectError("BAD_INPUT",
      "work_order_id and property_id are both required — the defect obligation " +
      "is property-scoped and its idempotency key depends on it");
  }

  await client.query("savepoint raise_proof_defect");
  try {
    //  An obligation is born from an event, everywhere in this codebase.
    //  The event carries the attribution and the reason; the obligation
    //  carries the accountability.
    const ev = (await client.query(
      `insert into events (property_id, unit_id, type, note)
       values ($1,$2,'proof_evaluation_missing_detected',$3) returning id`,
      [property_id, unit_id,
       JSON.stringify({
         work_order_id, property_id, detected_by, service: SERVICE_NAME,
         why: "terminal work order with no proof evaluation and no cutover " +
              "inventory row — it postdates the cutover, so it is not legacy",
       })])).rows[0];

    const obligation = await spawnObligationFromEvent(client, {
      ...DEFECT_SPEC,
      property_id,
      unit_id,
      source_event_id: ev.id,
      related_id: work_order_id,
      label: `Proof evaluation missing for work order ${work_order_id}`,
      //  Deliberately NOT set: assigned_user_id. The role owns it until a
      //  governed assignment gives it a human. UNASSIGNED is the truthful
      //  rendering, never a guess.
    });

    await client.query("release savepoint raise_proof_defect");
    return { outcome: "raised", obligation };
  } catch (e) {
    await client.query("rollback to savepoint raise_proof_defect");
    await client.query("release savepoint raise_proof_defect");

    //  23505 here can only be uq_obl_proof_eval_missing_open: an
    //  outstanding defect obligation already exists for this
    //  (property, work order). That is the idempotency contract working,
    //  and it is a success, not a failure. Any OTHER error is real.
    if (e.code === "23505") {
      const existing = (await client.query(
        `select * from obligations
          where property_id = $1 and related_id = $2
            and related_type = 'work_order' and type = $3 and status <> 'complete'
          order by created_at asc limit 1`,
        [property_id, work_order_id, OBLIGATION_TYPE])).rows[0];
      //  If the lookup finds nothing, the conflict was something else and
      //  reporting "already open" would invent a state. Rethrow.
      if (existing) return { outcome: "already_open", obligation: existing };
    }
    throw e;
  }
}

/*  Is the idempotency index actually there? A sweep run against a database
 *  without it would insert a duplicate per run rather than converge, and
 *  the failure would be silent — a growing pile of obligations for one
 *  work order. Fail closed instead. */
async function defectIndexPresent(client) {
  const { rows } = await client.query(
    `select 1 from pg_indexes
      where schemaname = 'public' and indexname = 'uq_obl_proof_eval_missing_open'`);
  return rows.length > 0;
}

module.exports = {
  OBLIGATION_TYPE, SERVICE_NAME, DEFECT_SPEC,
  raiseProofEvaluationDefect, defectIndexPresent, defectError,
};
