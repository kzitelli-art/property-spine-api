/* ════════════════════════════════════════════════════════════════════
   maintenance/proof_evaluation_service.js — THE one writer of proof
   evaluations and their attachment links.

   Release 0 §2.1. Every evaluation is an append-only row in a single
   rooted acyclic chain, scoped to (work_order_id, property_id).

   ── IT USES THE CHAIN CONTRACT. IT DOES NOT REPLACE IT. ─────────────
   Migration 137 carries a BEFORE INSERT trigger that refuses
   self-supersession, a second genesis, a non-head predecessor, a
   cross-scope link and a cycle — plus two partial unique indexes that
   win the concurrent races the trigger cannot see.

   This service reads the head and cites it. It does NOT re-implement
   those rules and it does NOT get an exemption for being canonical. If
   two turns race, one of them loses to `uq_wope_one_successor` and is
   told so. That is the design working, not an error to smooth over.

   ── WHY THE STATE VOCABULARY IS TWO WORDS ───────────────────────────
   Only `satisfied` and `not_satisfied` are ever STORED.
   `legacy_indeterminate` and `missing_evaluation_defect` are DERIVED at
   read time from the absence of a head plus the cutover inventory, and
   `unavailable` is a read STATUS, not a state at all. Storing any of
   them would make a derived fact writable and the inventory would stop
   being the authority (§3.2).
   ════════════════════════════════════════════════════════════════════ */
"use strict";

//  Stored states. Deliberately frozen and deliberately two.
const EVALUATION_STATES = Object.freeze(["satisfied", "not_satisfied"]);

//  Bumped when the MEANING of an evaluation changes, so a later reader can
//  tell which rule produced a verdict rather than assuming today's.
const RULE_VERSION = "release-0.1";
const SERVICE_NAME = "claimCompletion";

function evaluationError(code, message) {
  const e = new Error(message); e.code = code; return e;
}

/*  Is the schema this service requires actually present?
 *
 *  FAIL CLOSED. If Step 3 (this writer) were ever deployed ahead of
 *  Step 2 (migration 137), the evaluation insert would throw and the
 *  whole completion transaction would roll back — which is correct, but
 *  the operator would see a raw "relation does not exist". This turns
 *  that into a named refusal, and — far more importantly — it means the
 *  answer to a missing schema is REFUSE TO COMPLETE, never "complete
 *  without an evaluation". A completion with no proof evaluation is
 *  exactly the state Release 0 exists to make impossible. */
async function evaluationSchemaPresent(client) {
  const { rows } = await client.query(
    `select count(*)::int n from information_schema.tables
      where table_schema = 'public'
        and table_name in ('work_order_proof_evaluations',
                           'work_order_proof_evaluation_attachments')`);
  return rows[0].n === 2;
}

/*  The current head: the ONE unsuperseded row in this scope.
 *
 *  Read as "no successor exists", never as "highest timestamp" or
 *  "newest id". Ordering is not load-bearing and must not become so —
 *  an earlier revision of the plan read the head as the highest sequence
 *  number, which is only the head if the chain is guaranteed linear.
 *
 *  FOR UPDATE locks the head, so a second concurrent superseder blocks
 *  here rather than discovering the conflict at the unique index. Both
 *  outcomes are safe; this one produces the better error. */
async function currentHead(client, { work_order_id, property_id }) {
  const { rows } = await client.query(
    `select e.* from work_order_proof_evaluations e
      where e.work_order_id = $1 and e.property_id = $2
        and not exists (select 1 from work_order_proof_evaluations s
                         where s.supersedes_id = e.id)
      for update`,
    [work_order_id, property_id]);
  if (rows.length > 1) {
    //  Unreachable through this service; reachable only if the chain is
    //  already corrupt. Say so rather than picking one.
    throw evaluationError("CHAIN_CORRUPT",
      `scope (${work_order_id}, ${property_id}) has ${rows.length} heads`);
  }
  return rows[0] || null;
}

/*  Write one evaluation and link the evidence it was computed from.
 *
 *  Genesis when the scope is empty; otherwise it cites the head. The
 *  caller never chooses which — choosing would let a caller write a
 *  second genesis and the trigger would (correctly) refuse it as a
 *  confusing error instead of this service simply doing the right thing.
 *
 *  Links are inserted in the SAME transaction. An evaluation whose
 *  attachments are written separately could be read, between the two
 *  statements, as a verdict computed from nothing. */
async function recordEvaluation(client, {
  work_order_id, property_id, state, evaluated_by_user_id = null,
  attachment_ids = [], evaluated_by_service = SERVICE_NAME, rule_version = RULE_VERSION,
} = {}) {
  if (!work_order_id || !property_id) {
    throw evaluationError("BAD_INPUT", "an evaluation is scoped to a work order AND its property");
  }
  if (!EVALUATION_STATES.includes(state)) {
    //  Names the two writable values explicitly, because the tempting
    //  mistake is to pass a DERIVED one through from a reader.
    throw evaluationError("BAD_INPUT",
      `evaluation state ${JSON.stringify(state)} is not writable — ` +
      `only ${EVALUATION_STATES.join(" | ")} are stored; ` +
      `legacy_indeterminate and missing_evaluation_defect are derived at read time`);
  }
  if (!(await evaluationSchemaPresent(client))) {
    throw evaluationError("SCHEMA_MISSING",
      "migration 137 has not been applied — refusing to complete work without a proof evaluation");
  }

  const head = await currentHead(client, { work_order_id, property_id });

  const ev = (await client.query(
    `insert into work_order_proof_evaluations
       (work_order_id, property_id, state, evaluated_by_user_id,
        evaluated_by_service, rule_version, supersedes_id)
     values ($1,$2,$3,$4,$5,$6,$7) returning *`,
    [work_order_id, property_id, state, evaluated_by_user_id,
     evaluated_by_service, rule_version, head ? head.id : null])).rows[0];

  //  The link table is scoped on (evaluation, attachment, work order,
  //  property) by composite FK, so a cross-scope link is unrepresentable
  //  rather than merely refused. Passing the scope explicitly is what
  //  lets the database prove that.
  for (const attachment_id of attachment_ids) {
    await client.query(
      `insert into work_order_proof_evaluation_attachments
         (evaluation_id, attachment_id, work_order_id, property_id)
       values ($1,$2,$3,$4)`,
      [ev.id, attachment_id, work_order_id, property_id]);
  }

  return { evaluation: ev, supersededId: head ? head.id : null, linked: attachment_ids.length };
}

module.exports = {
  EVALUATION_STATES, RULE_VERSION, SERVICE_NAME,
  evaluationSchemaPresent, currentHead, recordEvaluation, evaluationError,
};
