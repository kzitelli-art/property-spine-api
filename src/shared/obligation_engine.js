// ════════════════════════════════════════════════════════════════════
//  obligation_engine.js — THE obligation engine. One implementation.
//
//  These four functions were defined inline in server.js and COPIED BY HAND
//  into tests/_engine.js, whose own header said: "server.js is the SOURCE OF
//  TRUTH. If those functions change there, update this copy to match."
//
//  They did change there. The copy did not keep up, and the drift was all in
//  the PERMISSIVE direction — the test copy was missing:
//    · spawnObligationFromEvent — five columns, including dedupe_key (the
//      idempotency mechanism) and the durable-ownership-at-insert fields;
//    · satisfyObligation        — the ENTIRE reserved-input guard, so it would
//      satisfy invitation-proof inputs the real engine categorically refuses;
//    · completeObligation       — the ENTIRE conversion-rail guard, so it would
//      close conversion-linked obligations the real engine categorically
//      refuses.
//
//  So every harness importing that copy was asserting against an engine MORE
//  PERMISSIVE than production: a test could pass on behaviour the real system
//  would refuse. That is the deriveCategories incident again, the one
//  work_order_service.js documents — two implementations of one rule, kept in
//  step by discipline, silently diverging.
//
//  Extracting them here removes the copy rather than re-syncing it.
//  tests/_engine.js is now a thin re-export of THIS module, so the harness and
//  the server cannot disagree by construction.
// ════════════════════════════════════════════════════════════════════
"use strict";

const { obligationError } = require("./obligation_transitions");

// RESERVED INPUTS (v2.5-r1): the two application-invitation proof codes may be
// satisfied ONLY by the application input authority — a module-private
// capability minted once in server.js and injected into the invitation
// service. The generic path CATEGORICALLY refuses them; no argument overrides
// it, because the capability is a Symbol and cannot be forged by a caller.
const RESERVED_APPLICATION_INPUTS = ["application_invitation_prepared", "application_invitation_sent"];
const __APP_INPUT_CAPABILITY = Symbol("application_input_authority");

async function spawnObligationFromEvent(client, spec) {
  const {
    property_id = null, person_id = null, unit_id = null,
    source_event_id = null, module, type, label,
    owner_type = "human", assigned_role = null, escalates_to_role = null,
    status = "open", due_at = null,
    // priority/severity are NOT NULL in the DB with CHECK vocabularies:
    //   priority: low|normal|high   severity: low|normal|high|emergency
    // Default to 'normal' (valid) so NO caller can trip the not-null constraint.
    // Callers override when the work is genuinely low/high/emergency.
    priority = "normal", severity = "normal",
    required_inputs = [],
    // related_id / related_type link an obligation to the DOMAIN OBJECT it's
    // about (turnover, work order, lease). Both nullable columns. Additive:
    // callers that don't pass them get null (prior behavior); callers that do
    // (turnover, down_units) can now find their obligation by the link.
    related_id = null, related_type = null,
    // DURABLE OWNERSHIP AT INSERT (v2.5-r1 Corr 3): the two application-link
    // child types carry ownership from birth (biconditional CHECK in 084).
    // Additive: other callers omit these and get nulls, exactly as before.
    assigned_user_id = null, ownership_origin = null, owner_eligibility_state = null,
    parent_obligation_id = null,
    // DEDUPE KEY (086): operational_escalation writes set this to a stable
    // sha256(inbound_event_id + normalized_reason) so a retry / concurrent
    // double converges (unique partial index), while two DIFFERENT tasks in
    // one inbound get different keys and both persist. All other callers omit
    // it → null → unchanged (the index is partial on non-null).
    dedupe_key = null,
  } = spec;

  // Postgres text[] literal, e.g. {tour_feedback} or {closeout_proof}
  const inputsLiteral = "{" + (required_inputs || []).join(",") + "}";

  const r = await client.query(
    `insert into obligations
       (property_id, person_id, unit_id,
        source_event_id, module, type, label,
        owner_type, assigned_role, escalates_to_role,
        status, due_at, priority, severity, required_inputs,
        related_id, related_type,
        assigned_user_id, ownership_origin, owner_eligibility_state, parent_obligation_id, dedupe_key)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
     returning *`,
    [property_id, person_id, unit_id,
     source_event_id, module, type, label,
     owner_type, assigned_role, escalates_to_role,
     status, due_at, priority, severity, inputsLiteral,
     related_id, related_type,
     assigned_user_id, ownership_origin, owner_eligibility_state, parent_obligation_id, dedupe_key]
  );
  return r.rows[0];
}

async function satisfyObligation(client, { obligation_id, input, proof = null, __capability = null }) {
  if (!input) throw obligationError("BAD_INPUT", "input is required (which required input this satisfies)");
  if (RESERVED_APPLICATION_INPUTS.includes(input) && __capability !== __APP_INPUT_CAPABILITY) {
    throw obligationError("RESERVED_INPUT",
      `"${input}" is a reserved invitation-proof input — it can only be satisfied by the canonical invitation service against verified invitation state.`);
  }

  const o = await client.query("select * from obligations where id=$1 for update", [obligation_id]);
  if (o.rows.length === 0) throw obligationError("NOT_FOUND", "obligation not found");
  const obligation = o.rows[0];

  const outstanding = obligation.required_inputs || [];
  if (!outstanding.includes(input)) {
    throw obligationError("NOT_OUTSTANDING",
      `"${input}" is not an outstanding required input on this obligation`,
      { required_inputs: outstanding });
  }

  // Record the proof as a durable event (same shape the route always used).
  const proofText = (proof == null) ? ""
    : (typeof proof === "string" ? proof : JSON.stringify(proof));
  await client.query(
    `insert into events (property_id, person_id, unit_id, type, note)
     values ($1,$2,$3,$4,$5)`,
    [obligation.property_id, obligation.person_id, obligation.unit_id,
     `input_satisfied:${input}`,
     proofText ? `${input} provided: ${proofText}` : `${input} provided`]
  );

  const remaining = outstanding.filter(i => i !== input);
  const upd = await client.query(
    `update obligations set required_inputs = $1, updated_at = now()
      where id = $2 returning *`,
    [remaining, obligation_id]
  );

  return { obligation: upd.rows[0], satisfied_input: input, remaining };
}

async function completeObligation(client, { obligation_id, completed_by = null }) {
  // CLOSURE AUTHORITY (structural — reviewer ruling Jul 4): a conversion-linked
  // obligation closes ONLY through the conversion rail's closure capability
  // (conversion_obligation_closure.js). This public engine categorically
  // rejects linked obligations and carries NO bypass parameter, flag, header,
  // or marker of any kind. There is nothing a future caller can pass.
  {
    const linked = (await client.query(
      `select 1 from leasing_conversion_obligations where obligation_id=$1
        and (select to_regclass('leasing_conversion_obligations')) is not null limit 1`,
      [obligation_id])).rows[0];
    if (linked) {
      const err = new Error("Conversion-linked obligations must resolve through the conversion rail.");
      err.code = "CONVERSION_RAIL_REQUIRED"; err.httpStatus = 409; err.publicMessage = err.message;
      throw err;
    }
  }
  const o = await client.query("select * from obligations where id=$1 for update", [obligation_id]);
  if (o.rows.length === 0) throw obligationError("NOT_FOUND", "obligation not found");
  const obligation = o.rows[0];

  if (obligation.status === "complete") {
    throw obligationError("ALREADY_COMPLETE", "obligation is already complete");
  }

  const outstanding = obligation.required_inputs || [];
  if (outstanding.length > 0) {
    throw obligationError("INPUTS_OUTSTANDING",
      "cannot complete — required inputs are still outstanding",
      { outstanding_inputs: outstanding });
  }

  const r = await client.query(
    `update obligations
        set status = 'complete', completed_at = now(), updated_at = now()
      where id = $1 returning *`,
    [obligation_id]
  );

  await client.query(
    `insert into events (property_id, person_id, unit_id, type, note)
     values ($1,$2,$3,'obligation_completed',$4)`,
    [obligation.property_id, obligation.person_id, obligation.unit_id,
     `${obligation.type} obligation completed${completed_by ? " by " + completed_by : ""}`]
  );

  return r.rows[0];
}

async function reassignObligation(client, { obligation_id, assigned_role, escalates_to_role = null, reason = null }) {
  if (!assigned_role) throw obligationError("BAD_INPUT", "assigned_role is required (the role to reassign to)");

  const o = await client.query("select * from obligations where id=$1 for update", [obligation_id]);
  if (o.rows.length === 0) throw obligationError("NOT_FOUND", "obligation not found");
  const obligation = o.rows[0];

  if (obligation.status === "complete") {
    throw obligationError("ALREADY_COMPLETE", "cannot reassign — obligation is already complete");
  }

  const r = await client.query(
    `update obligations
        set assigned_role = $1, escalates_to_role = $2, updated_at = now()
      where id = $3 returning *`,
    [assigned_role, escalates_to_role, obligation_id]
  );

  await client.query(
    `insert into events (property_id, person_id, unit_id, type, note)
     values ($1,$2,$3,'obligation_reassigned',$4)`,
    [obligation.property_id, obligation.person_id, obligation.unit_id,
     `${obligation.type} obligation reassigned from ${obligation.assigned_role || "none"} to ${assigned_role}${reason ? " (" + reason + ")" : ""}`]
  );

  return r.rows[0];
}

module.exports = {
  obligationError,
  RESERVED_APPLICATION_INPUTS,
  __APP_INPUT_CAPABILITY,
  spawnObligationFromEvent,
  satisfyObligation,
  completeObligation,
  reassignObligation,
};
