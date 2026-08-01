// ════════════════════════════════════════════════════════════════════
//  obligation_transitions.js — THE obligation TYPE-CHANGE service.
//
//  Extracted into its own module for one reason: tests/_engine.js is a
//  hand-maintained VERBATIM COPY of the obligation engine (see its header:
//  "server.js is the SOURCE OF TRUTH. If those functions change there,
//  update this copy to match"). That is a parallel implementation kept in
//  sync by discipline, and this repo has already been bitten by exactly that
//  shape once — work_order_service.js documents two deriveCategories that
//  disagreed and silently misclassified money.
//
//  Rather than add a sixth function to that copy, the transition machinery
//  lives HERE and is imported by server.js and by the harness alike. One
//  implementation, no copy to drift.
//
//  WHY THIS IS NOT A GENERIC MUTATOR (ruling 2026-08-01). A function that can
//  move any obligation to any type with any fields is a hole in the obligation
//  model, not a service. This one:
//    · permits only whitelisted (from -> to) pairs, named below;
//    · requires the caller to declare the type AND status it expects to find,
//      and refuses when the row no longer matches — so a concurrent resolution
//      loses rather than double-applies;
//    · requires every field COUPLED to the target type, so a type can never
//      move while its label, inputs or deadline stay behind;
//    · takes its event type from the table, not the caller, so the history a
//      transition writes cannot be mislabelled by the code writing it.
//  Adding a transition is an edit here, reviewed on its own terms. There is
//  no argument a caller can pass to widen it.
// ════════════════════════════════════════════════════════════════════
"use strict";

const OBLIGATION_TRANSITIONS = {
  "confirm_urgency->maintenance_repair": {
    event_type: "work_order_urgency_resolved",
    requires: ["label", "required_inputs", "priority", "severity"],
  },
  "confirm_urgency->emergency_repair": {
    event_type: "work_order_urgency_escalated",
    // due_at and escalates_to_role are REQUIRED, never defaulted: an emergency
    // obligation with no deadline and no escalation path is precisely the
    // incoherent state this service exists to prevent.
    requires: ["label", "required_inputs", "priority", "severity",
               "escalates_to_role", "due_at"],
  },
};

function obligationError(code, message, extra = {}) {
  const e = new Error(message);
  e.code = code;
  Object.assign(e, extra);
  return e;
}

async function transitionObligation(client, spec) {
  const {
    obligation_id, expected_type, expected_status, to_type,
    label = null, required_inputs = null, priority = null, severity = null,
    escalates_to_role = null, due_at = null, reason = null, event_note = null,
  } = spec || {};

  if (!obligation_id) throw obligationError("BAD_INPUT", "obligation_id is required");
  if (!expected_type || !expected_status) {
    throw obligationError("BAD_INPUT",
      "expected_type and expected_status are required — a transition must state the state it believes it is changing");
  }
  const key = `${expected_type}->${to_type}`;
  const rule = OBLIGATION_TRANSITIONS[key];
  if (!rule) {
    throw obligationError("TRANSITION_NOT_ALLOWED",
      `obligation transition '${key}' is not permitted`,
      { allowed: Object.keys(OBLIGATION_TRANSITIONS) });
  }

  const supplied = { label, required_inputs, priority, severity, escalates_to_role, due_at };
  const missing = rule.requires.filter((f) => supplied[f] === null || supplied[f] === undefined);
  if (missing.length) {
    throw obligationError("INCOHERENT_TRANSITION",
      `transition '${key}' requires ${missing.join(", ")} — a type may not move while its coupled fields stay behind`,
      { missing });
  }

  const o = await client.query("select * from obligations where id=$1 for update", [obligation_id]);
  if (o.rows.length === 0) throw obligationError("NOT_FOUND", "obligation not found");
  const obligation = o.rows[0];

  if (obligation.status === "complete") {
    throw obligationError("ALREADY_COMPLETE", "cannot transition — obligation is already complete");
  }
  // STALE STATE FAILS CLOSED. If someone else already resolved this urgency
  // question, the row no longer looks the way the caller believed. Refuse
  // rather than apply a second transition on top of theirs.
  if (obligation.type !== expected_type || obligation.status !== expected_status) {
    throw obligationError("STALE_OBLIGATION_STATE",
      `obligation is now ${obligation.type}/${obligation.status}, not the expected ${expected_type}/${expected_status}`,
      { actual_type: obligation.type, actual_status: obligation.status });
  }

  // ONE UPDATE. Every coupled field moves together or none does.
  const r = await client.query(
    `update obligations
        set type = $1, label = $2, required_inputs = $3,
            priority = $4, severity = $5,
            escalates_to_role = $6, due_at = $7, updated_at = now()
      where id = $8 returning *`,
    [to_type, label, required_inputs, priority, severity,
     escalates_to_role, due_at, obligation_id]
  );

  await client.query(
    `insert into events (property_id, person_id, unit_id, type, note)
     values ($1,$2,$3,$4,$5)`,
    [obligation.property_id, obligation.person_id, obligation.unit_id,
     rule.event_type,
     JSON.stringify({
       obligation_id,
       work_order_id: obligation.related_type === "work_order" ? obligation.related_id : null,
       from_type: expected_type, to_type,
       reason: reason || null,
       ...(event_note && typeof event_note === "object" ? event_note : {}),
     })]
  );

  return r.rows[0];
}

module.exports = { OBLIGATION_TRANSITIONS, transitionObligation, obligationError };
