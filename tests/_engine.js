// ════════════════════════════════════════════════════════════════════
//  _engine.js — TEST-ONLY HELPER. Not part of the deployed service.
//  A verbatim copy of spawnObligationFromEvent / completeObligation from
//  server.js, extracted so the conversion-rail test can exercise the
//  obligation engine in ISOLATION (without booting all of server.js).
//  server.js is the SOURCE OF TRUTH. If those functions change there,
//  update this copy to match.
// ════════════════════════════════════════════════════════════════════
// Real obligation engine functions, extracted VERBATIM from property-spine-api/server.js.
// (spawnObligationFromEvent, satisfyObligation, completeObligation, obligationError)
function obligationError(code, message, extra = {}) {
  const e = new Error(message);
  e.code = code;
  Object.assign(e, extra);
  return e;
}

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
  } = spec;

  // Postgres text[] literal, e.g. {tour_feedback} or {closeout_proof}
  const inputsLiteral = "{" + (required_inputs || []).join(",") + "}";

  const r = await client.query(
    `insert into obligations
       (property_id, person_id, unit_id,
        source_event_id, module, type, label,
        owner_type, assigned_role, escalates_to_role,
        status, due_at, priority, severity, required_inputs,
        related_id, related_type)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
     returning *`,
    [property_id, person_id, unit_id,
     source_event_id, module, type, label,
     owner_type, assigned_role, escalates_to_role,
     status, due_at, priority, severity, inputsLiteral,
     related_id, related_type]
  );
  return r.rows[0];
}

async function satisfyObligation(client, { obligation_id, input, proof = null }) {
  if (!input) throw obligationError("BAD_INPUT", "input is required (which required input this satisfies)");

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

module.exports = { spawnObligationFromEvent, satisfyObligation, completeObligation, obligationError };
