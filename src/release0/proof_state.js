/* ════════════════════════════════════════════════════════════════════
   release0/proof_state.js — THE four-state proof derivation.

   §3.2. Exactly four values, and `unavailable` is NOT one of them.

     satisfied · not_satisfied · legacy_indeterminate · missing_evaluation_defect

   ── WHY THIS IS ITS OWN MODULE ──────────────────────────────────────

   The plan places the derivation "in work_order_status_read.js". It lives
   here instead, called from exactly one place, for a reason the plan
   itself supplies: §3.2.0 requires that "the same predicate governs the
   §4.2 defect sweep, so the reader and the sweep cannot disagree about
   which rows are visible."

   A predicate that must be shared by two consumers and must never differ
   between them is a module, not a paragraph inside one of them. "One
   canonical derivation"
   is the requirement; a single file is one way to get it, and the weaker
   way once a second consumer exists. `isTerminal` and `deriveProofState`
   are exported so the sweep imports them rather than restating them.

   THE READER WRITES NOTHING, EVER (§4.2). Nothing in this file mutates.

   ── TERMINALITY AND LEGITIMACY ARE TWO DIFFERENT QUESTIONS (§3.2.0) ──

     TERMINAL, for defect detection:   status in ('complete','closed')
     LEGITIMATE historical closed:     closed AND in the cutover inventory

   Revision 3 defined terminal as "complete, or closed FOR AN INVENTORIED
   ROW", and that left the exact hole the release exists to catch:

     closed + NOT inventoried + no evaluation
       → not "terminal" under that definition
       → escapes missing_evaluation_defect
       → escapes the defect sweep
       → renders as if the work were merely unstarted

   That is precisely the row a surviving legacy writer or an in-flight
   request creates AFTER activation. Inventory membership decides whether
   a closed row is legitimate legacy history; it does NOT decide whether
   the row is visible to defect detection.

   NO TIMESTAMP COMPARISON APPEARS ANYWHERE. Membership is the
   discriminator, which closes the missing-`completed_at` gap without a
   fifth state.

   ── `unavailable` IS THE READ FAILING, NOT A PROOF CONDITION (§3.2.1) ─

   Without an activation there is no inventory, so legacy cannot be told
   from defect and the derivation CANNOT RUN. The reader says the read did
   not complete and OMITS `state` and `satisfied` entirely. It must not
   fall back to missing_evaluation_defect — that would raise a
   writer-defect on every terminal work order the moment the reader
   shipped.
   ════════════════════════════════════════════════════════════════════ */
"use strict";

//  The only four values `state` may ever take.
const PROOF_STATES = Object.freeze([
  "satisfied", "not_satisfied", "legacy_indeterminate", "missing_evaluation_defect",
]);

const TERMINAL_STATUSES = Object.freeze(["complete", "closed"]);

/*  §3.2.0. Every terminal row is visible to defect detection. Inventory
 *  membership is asked separately, and later. */
const isTerminal = (workOrder) =>
  !!workOrder && TERMINAL_STATUSES.includes(workOrder.status);

/*  §3.4, frozen. `null` is deliberate: legacy and writer-defect may NOT be
 *  collapsed into "proof failed". */
const SATISFIED_FOR = Object.freeze({
  satisfied: true,
  not_satisfied: false,
  legacy_indeterminate: null,
  missing_evaluation_defect: null,
});

/*  Is there an activation at all? Without one the derivation cannot run.
 *  Absent TABLES are treated the same as an absent ROW — a reader deployed
 *  ahead of migration 137 must report the read as unavailable rather than
 *  crash or, worse, fall through to a defect verdict. */
async function activationAuthority(db) {
  const present = (await db.query(
    `select count(*)::int n from information_schema.tables
      where table_schema='public'
        and table_name in ('release_0_activation_history',
                           'release_0_legacy_cutover_inventory')`)).rows[0].n === 2;
  if (!present) return { available: false, reason_code: "schema_absent" };

  const { rows } = await db.query(`select id, activated_at from release_0_activation_current`);
  if (!rows.length) return { available: false, reason_code: "activation_absent" };
  return { available: true, activation: rows[0] };
}

/**
 * Derive the proof block's state fields for ONE work order.
 *
 * Returns either
 *   { read_status: "unavailable", reason_code }              — no state, no satisfied
 * or
 *   { read_status: "ok", state, satisfied }                  — state is one of four
 *
 * @param authority  the result of activationAuthority(db), passed in so a
 *                   list read resolves it ONCE rather than per row.
 * @param hasEligibleEvidence  whether preserved, classified evidence exists
 *                   right now. Only consulted for a non-terminal work order.
 */
async function deriveProofState(db, { workOrder, authority, hasEligibleEvidence = false }) {
  if (!authority || !authority.available) {
    //  §3.2.1 — the READ is unavailable. `state` and `satisfied` are ABSENT,
    //  not null, not "unavailable". A fifth value would force every consumer
    //  to handle a read failure as a proof condition.
    return { read_status: "unavailable",
             reason_code: (authority && authority.reason_code) || "activation_absent" };
  }

  //  1. A live evaluation head answers directly, terminal or not.
  const head = (await db.query(
    `select state from work_order_proof_evaluation_head
      where work_order_id = $1 and property_id = $2`,
    [workOrder.id, workOrder.property_id])).rows[0];
  if (head) {
    //  A stored state outside the two writable ones would be a schema
    //  breach, but reading it back unvalidated would launder it into the
    //  four-state contract. Refused rather than passed through.
    if (head.state !== "satisfied" && head.state !== "not_satisfied") {
      throw new Error(
        `proof_state: evaluation head carries an unwritable state ${JSON.stringify(head.state)} ` +
        `for work order ${workOrder.id} — the chain contract has been violated`);
    }
    return { read_status: "ok", state: head.state, satisfied: SATISFIED_FOR[head.state] };
  }

  //  2. No head. Not terminal → proof is not yet due, and the block
  //     reflects CURRENT EVIDENCE rather than a defect (§3.2).
  if (!isTerminal(workOrder)) {
    const state = hasEligibleEvidence ? "satisfied" : "not_satisfied";
    return { read_status: "ok", state, satisfied: SATISFIED_FOR[state] };
  }

  //  3. Terminal, no head. Inventory membership is the ONLY discriminator.
  const inventoried = (await db.query(
    `select 1 from release_0_legacy_cutover_inventory
      where work_order_id = $1 and property_id = $2`,
    [workOrder.id, workOrder.property_id])).rowCount > 0;

  const state = inventoried ? "legacy_indeterminate" : "missing_evaluation_defect";
  return { read_status: "ok", state, satisfied: SATISFIED_FOR[state] };
}

/*  §3.3 / §19c Ruling C — presence booleans ONLY. The legacy columns hold
 *  a `stub://` string and free text; neither is proof and neither travels. */
const legacyEvidenceOf = (workOrder) => ({
  column_photo_present: workOrder.completion_photo != null,
  column_note_present: workOrder.completion_note != null,
});

module.exports = {
  PROOF_STATES, TERMINAL_STATUSES, SATISFIED_FOR,
  isTerminal, activationAuthority, deriveProofState, legacyEvidenceOf,
};
