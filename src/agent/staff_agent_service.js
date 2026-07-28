// ════════════════════════════════════════════════════════════════════
//  staff_agent_service.js — CAPTURE AND INTERPRETATION ONLY
//
//  BUILD 5. A new DOOR into Builds 1-4. Not a new maintenance architecture.
//
//  ── THE ONE RULE THIS FILE EXISTS TO ENFORCE ────────────────────────
//
//      THIS SERVICE WRITES NO DOMAIN TRUTH. EVER.
//
//  It writes exactly three things — a message, a proposal, and a confirmation
//  stamp — all in its own conversation tables. Every operating fact is created
//  by calling the Build 1-4 canonical service that owns it.
//
//  There are NO raw inserts into unit_triage_findings, unit_triage_required_work,
//  unit_turn_scopes, work_acceptances, work_completion_claims, obligations, or
//  unit_readiness_certifications anywhere in this module. The harness asserts
//  that against this source, not against intent.
//
//  Why so strict: if the agent could write a finding directly, "the fridge is
//  missing" would mean one thing typed into the form and a subtly different
//  thing said in the thread — different columns set, different obligations
//  spawned, different history. One operating action must mean one thing.
//
//  ── REQUIRED INJECTED SERVICES ──────────────────────────────────────
//  All four are REQUIRED and construction fails without them. That is the
//  structural guarantee: this module cannot even be built in a configuration
//  where it would have to fall back to a raw insert.
//
//  ── AND IT CANNOT MAKE A UNIT READY ─────────────────────────────────
//  There is no call to any certification path here. `readiness_request` at
//  most opens the governed Build 4 walk, which enforces its own authority.
// ════════════════════════════════════════════════════════════════════

"use strict";

const {
  classifyIntent, photoNeedsClarification, INTENT, INTENT_SERVICE,
} = require("./staff_agent_intent");

function makeStaffAgentService(deps) {
  const {
    unitTriageService, unitTurnScopeService, workAcceptanceService, readinessService,
  } = deps || {};

  // CONSTRUCTION FAILS WITHOUT EVERY CANONICAL SERVICE. A missing dependency
  // must not degrade into "well, just insert it directly" — that is precisely
  // how a second maintenance system gets built by accident.
  const required = [
    ["unitTriageService", unitTriageService, "confirmTriage"],
    ["unitTurnScopeService", unitTurnScopeService, "confirmScope"],
    ["workAcceptanceService", workAcceptanceService, "acceptWork"],
    ["readinessService", readinessService, "recordWalk"],
  ];
  for (const [name, svc, fn] of required) {
    if (!svc || typeof svc[fn] !== "function") {
      throw new Error(
        `staff_agent_service requires ${name} (with ${fn}()). The staff agent is a capture layer ` +
        `and must delegate every write to an existing canonical service — it has no fallback path.`);
    }
  }

  const bad = (m, extra) => Object.assign(new Error(m), { httpStatus: 400, ...(extra || {}) });

  // ── UNIT RESOLUTION — NEVER ACROSS A PROPERTY ─────────────────────
  //
  //  A unit reference resolves ONLY inside the authenticated property. If it
  //  matches more than one unit there, that is a question, not a coin flip.
  //  The query itself is scoped by property_id, so a cross-property match is
  //  not merely rejected — it is unreachable.
  async function resolveUnit(db, { property_id, unit_ref, context_unit_id }) {
    if (context_unit_id) {
      const u = (await db.query(
        "select id, unit_number from units where id=$1 and property_id=$2",
        [context_unit_id, property_id])).rows[0];
      if (u) return { unit: u, basis: "the unit already open in the app" };
    }
    if (!unit_ref) return { unit: null, basis: "no unit named and none open" };

    const rows = (await db.query(
      "select id, unit_number from units where property_id=$1 and unit_number = $2",
      [property_id, String(unit_ref)])).rows;
    if (rows.length === 1) return { unit: rows[0], basis: `resolved "${unit_ref}" at this property` };
    if (rows.length > 1) {
      return {
        unit: null, ambiguous: true,
        basis: `"${unit_ref}" matches ${rows.length} units at this property`,
        question: `Which ${unit_ref}? It matches more than one unit here.`,
      };
    }
    return {
      unit: null,
      basis: `"${unit_ref}" is not a unit at this property`,
      question: `I can't find unit ${unit_ref} at this property. Which unit did you mean?`,
    };
  }

  // ── THREAD ────────────────────────────────────────────────────────
  async function ensureThread(client, { property_id, user_id }) {
    const found = (await client.query(
      "select * from staff_agent_threads where property_id=$1 and user_id=$2 order by created_at desc limit 1",
      [property_id, user_id])).rows[0];
    if (found) return found;
    return (await client.query(
      "insert into staff_agent_threads (property_id, user_id) values ($1,$2) returning *",
      [property_id, user_id])).rows[0];
  }

  // ── CAPTURE — records the message, PROPOSES, writes no truth ──────
  async function captureMessage(client, spec) {
    const {
      property_id, actor_user_id, text, photos = [], context_unit_id = null,
    } = spec || {};
    if (!actor_user_id) throw bad("actor_user_id is required");
    if (!text || !String(text).trim()) throw bad("a message is required");

    const thread = await ensureThread(client, { property_id, user_id: actor_user_id });

    // What the app already knows, so the operator never repeats it.
    let openWork = [];
    let resolvedUnit = null;

    const draft = classifyIntent(text, { unit_id: context_unit_id });
    const unitRes = await resolveUnit(client, {
      property_id, unit_ref: draft.unit_ref, context_unit_id,
    });
    resolvedUnit = unitRes.unit;

    if (resolvedUnit) {
      openWork = (await client.query(
        `select id, work_text, stage, status from unit_triage_required_work
          where unit_id=$1 and status='required' order by created_at asc`,
        [resolvedUnit.id])).rows;
    }

    // Re-classify WITH the loaded context so work-item resolution can run.
    const intent = classifyIntent(text, {
      unit_id: resolvedUnit ? resolvedUnit.id : null,
      unit_number: resolvedUnit ? resolvedUnit.unit_number : null,
      open_work: openWork,
    });

    // THE MESSAGE — verbatim, attributed, never edited.
    const message = (await client.query(
      `insert into staff_agent_messages (thread_id, property_id, user_id, role, body, photos, unit_id)
       values ($1,$2,$3,'staff',$4,$5,$6) returning *`,
      [thread.id, property_id, actor_user_id, String(text), photos,
       resolvedUnit ? resolvedUnit.id : null])).rows[0];

    // A photo with too little text is a question, never a finding.
    const photoQ = photoNeedsClarification(text, photos);

    let status = "proposed";
    let clarification = intent.clarification;
    const unknowns = [...intent.unknowns];

    if (photoQ) {
      status = "clarification_required";
      clarification = photoQ.clarification;
      unknowns.push(photoQ.why);
    } else if (intent.intent === INTENT.UNCLEAR || clarification) {
      status = "clarification_required";
    }
    if (!resolvedUnit && unitRes.question) {
      status = "clarification_required";
      clarification = unitRes.question;
      unknowns.push(unitRes.basis);
    }

    const proposal = (await client.query(
      `insert into staff_agent_proposals
         (thread_id, message_id, property_id, unit_id, intent, proposed, unknowns, clarification, status)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning *`,
      [thread.id, message.id, property_id, resolvedUnit ? resolvedUnit.id : null,
       intent.intent, JSON.stringify(intent.proposed), unknowns, clarification, status])).rows[0];

    return {
      thread, message, proposal,
      unit: resolvedUnit,
      unit_basis: unitRes.basis,
      open_work: openWork,
      would_call: INTENT_SERVICE[intent.intent],
      nothing_recorded:
        "Nothing operating has been recorded. This is a proposal — confirm, correct, or cancel it.",
    };
  }

  // ── CONFIRM — the ONLY path that may invoke a canonical service ───
  async function confirmProposal(client, spec) {
    const { proposal_id, property_id, actor_user_id, overrides = {} } = spec || {};
    if (!actor_user_id) throw bad("actor_user_id is required — a confirmation needs a human actor");

    // Lock the row so two concurrent confirmations cannot both proceed.
    const p = (await client.query(
      "select * from staff_agent_proposals where id=$1 for update", [proposal_id])).rows[0];
    if (!p) throw Object.assign(new Error("proposal not found"), { httpStatus: 404 });
    if (String(p.property_id) !== String(property_id)) {
      throw Object.assign(
        new Error("that proposal is not at the property you are operating"), { httpStatus: 403 });
    }

    // IDEMPOTENCE. A double tap, a retry, a flaky connection — the canonical
    // service must run ONCE. Creating the work twice would be worse than
    // failing, because nobody would notice.
    if (p.status === "confirmed") {
      return {
        already_confirmed: true, proposal: p,
        resulting_kind: p.resulting_kind, resulting_id: p.resulting_id,
        note: "This proposal was already confirmed. The canonical action ran once and was not repeated.",
      };
    }
    if (p.status === "cancelled") throw bad("that proposal was cancelled and cannot be confirmed");
    if (p.intent === INTENT.UNCLEAR) {
      throw bad("this message was not understood well enough to record anything. Answer the clarification first.");
    }
    if (p.status === "clarification_required") {
      throw bad("this proposal needs a clarification before it can be confirmed", { clarification: p.clarification });
    }
    if (!p.unit_id && p.intent !== INTENT.CORRECTION) {
      throw bad("no unit was resolved for this proposal, so nothing can be recorded");
    }

    const msg = (await client.query(
      "select * from staff_agent_messages where id=$1", [p.message_id])).rows[0];
    const proposed = p.proposed || {};

    // ══════════════════════════════════════════════════════════════
    //  DELEGATION. Every branch calls a canonical service. There is no
    //  branch that writes a domain row itself.
    // ══════════════════════════════════════════════════════════════
    let result = null, kind = null, summary = {};

    if (p.intent === INTENT.TRIAGE) {
      const interp = unitTriageService.proposeTriage({ text: msg.body });
      result = await unitTriageService.confirmTriage(client, {
        property_id, unit_id: p.unit_id, actor_user_id,
        original_text: msg.body,
        photos: msg.photos || [],
        vacancy_observation: overrides.vacancy_observation || interp.vacancy,
        initial_condition: overrides.initial_condition || interp.initial_condition,
        // NEVER upgraded here. A conversation does not establish that the
        // whole unit was inspected.
        inspection_completeness: interp.inspection_completeness,
        findings: interp.findings.map((f) => ({
          finding_text: f.finding, evidence_text: f.evidence,
          is_severe: !!f.severe, long_lead_kind: f.long_lead_kind || null, origin: "proposed",
        })),
        required_work: interp.required_work.map((w) => ({ work_text: w.work, origin: "proposed" })),
      });
      kind = "unit_triage_confirmation";
      summary = {
        findings: result.findings.map((f) => f.finding_text),
        required_work: result.required_work.map((w) => w.work_text),
        readiness: result.readiness.readiness_label,
        owner: result.scope_obligation && result.scope_obligation.assigned_user_id ? "assigned" : "UNASSIGNED",
        next_move_in: result.next_move_in ? result.next_move_in.move_in_date : null,
        manager_decision: !!result.move_in_risk_obligation,
      };
      result = { id: result.confirmation.id, ...result };

    } else if (p.intent === INTENT.SCOPE) {
      const triage = await unitTriageService.readUnitTriageState(client, { unit_id: p.unit_id });
      if (!triage || !triage.confirmation) {
        throw Object.assign(
          new Error("a turn scope extends a confirmed initial walk, and this unit has none yet"),
          { httpStatus: 409 });
      }
      const s = unitTurnScopeService.propose({
        repairs_text: "",
        paint_level: overrides.paint_level || proposed.paint_level || "unknown",
        cleaning_level: overrides.cleaning_level || proposed.cleaning_level || "unknown",
        keys_status: overrides.keys_status || "unknown",
        // NEVER inferred from a message.
        inspection_completeness: overrides.inspection_completeness || "partial",
      });
      result = await unitTurnScopeService.confirmScope(client, {
        property_id, unit_id: p.unit_id, actor_user_id,
        triage_confirmation_id: triage.confirmation.id,
        original_text: msg.body,
        paint_level: s.paint_level, paint_areas: s.paint_areas,
        cleaning_level: s.cleaning_level,
        keys_status: s.keys_status, inspection_completeness: s.inspection_completeness,
        findings: s.findings.map((f) => ({ finding_text: f.finding, evidence_text: f.evidence, origin: "proposed" })),
        required_work: s.required_work.map((w) => ({
          work_text: w.work, stage: w.stage,
          disturbs_painted_surfaces: w.disturbs_painted_surfaces, origin: "proposed",
        })),
      });
      kind = "unit_turn_scope";
      summary = {
        required_work: result.required_work.map((w) => `${w.work_text} (${w.stage})`),
        next_action: result.flow.controlling_next_action ? result.flow.controlling_next_action.action : null,
      };
      result = { id: result.scope.id, ...result };

    } else if (p.intent === INTENT.ACCEPT) {
      // Build 3 eligibility and actionability still apply. A message
      // expressing intent does not make blocked work acceptable.
      result = await workAcceptanceService.acceptWork(client, {
        work_id: overrides.work_id || proposed.work_id,
        property_id, actor_user_id,
        owner_user_id: overrides.owner_user_id || actor_user_id,
        due_at: overrides.due_at || null,
        commitment_source: overrides.due_at ? "proposed_from_text" : null,
        note: msg.body,
      });
      kind = "work_acceptance";
      summary = {
        work: result.work.work_text,
        due: result.acceptance.due_at || "no date committed",
        proof_required: result.proof_requirement.label,
      };
      result = { id: result.acceptance.id, ...result };

    } else if (p.intent === INTENT.COMPLETE) {
      result = await workAcceptanceService.claimCompletion(client, {
        work_id: overrides.work_id || proposed.work_id,
        property_id, actor_user_id,
        outcome: "completed",
        note: msg.body,
        proof_photos: msg.photos || [],
        functional_confirmation: proposed.functional_confirmation || null,
      });
      kind = "work_completion_claim";
      summary = {
        work: result.work.work_text,
        closed: result.closed,
        shortfall: result.claim.proof_shortfall,
        unlocked: result.unlocked_stages,
      };
      result = { id: result.claim.id, ...result };

    } else if (p.intent === INTENT.FAILED_WALK) {
      // Build 4 owns authority and entry conditions. This door creates no
      // weaker failed-walk path — it calls the same service.
      result = await readinessService.recordWalk(client, {
        property_id, unit_id: p.unit_id, actor_user_id,
        outcome: "not_ready",
        note: msg.body,
        photos: msg.photos || [],
        findings_text: overrides.findings_text || proposed.findings_text || "",
      });
      kind = "readiness_walk";
      summary = {
        new_work: result.new_work.map((w) => w.work_text),
        next_action: result.flow.controlling_next_action ? result.flow.controlling_next_action.action : null,
      };
      result = { id: result.walk.id, ...result };

    } else if (p.intent === INTENT.READINESS) {
      // A message CANNOT certify. Refused here, explicitly.
      throw Object.assign(new Error(
        "a message cannot certify readiness. Open the final readiness walk, affirm every confirmation area, " +
        "and certify there — Build 4 authority and entry conditions apply."),
        { httpStatus: 409, use_instead: "POST /operator/units/:id/readiness/walk" });

    } else if (p.intent === INTENT.CORRECTION) {
      // Build 5 does not invent a generic correction mechanism.
      throw Object.assign(new Error(
        "corrections go through the canonical correction path for the affected record. " +
        "Open the affected record and correct it there — the original stays in history."),
        { httpStatus: 409 });

    } else {
      throw bad("this intent cannot be confirmed");
    }

    // Stamp the confirmation and REFERENCE what the canonical service made.
    const confirmed = (await client.query(
      `update staff_agent_proposals
          set status='confirmed', confirmed_by_user_id=$2, confirmed_at=now(),
              resulting_kind=$3, resulting_id=$4, resulting_summary=$5
        where id=$1 returning *`,
      [p.id, actor_user_id, kind, result.id, JSON.stringify(summary)])).rows[0];

    return { proposal: confirmed, resulting_kind: kind, resulting_id: result.id, summary, result };
  }

  async function cancelProposal(client, { proposal_id, property_id, actor_user_id, reason = null }) {
    const p = (await client.query(
      "select * from staff_agent_proposals where id=$1", [proposal_id])).rows[0];
    if (!p) throw Object.assign(new Error("proposal not found"), { httpStatus: 404 });
    if (String(p.property_id) !== String(property_id))
      throw Object.assign(new Error("that proposal is not at the property you are operating"), { httpStatus: 403 });
    if (p.status === "confirmed") throw bad("a confirmed proposal cannot be cancelled — it already created operating truth");
    const row = (await client.query(
      "update staff_agent_proposals set status='cancelled', clarification=$2 where id=$1 returning *",
      [proposal_id, reason || p.clarification])).rows[0];
    return { proposal: row, note: "Cancelled. Nothing operating was recorded." };
  }

  async function readThread(db, { property_id, user_id, limit = 50 }) {
    const thread = (await db.query(
      "select * from staff_agent_threads where property_id=$1 and user_id=$2 order by created_at desc limit 1",
      [property_id, user_id])).rows[0];
    if (!thread) return { thread: null, messages: [], proposals: [] };
    const messages = (await db.query(
      "select * from staff_agent_messages where thread_id=$1 order by created_at asc limit $2",
      [thread.id, limit])).rows;
    const proposals = (await db.query(
      "select * from staff_agent_proposals where thread_id=$1 order by created_at asc", [thread.id])).rows;
    return { thread, messages, proposals };
  }

  return {
    captureMessage, confirmProposal, cancelProposal, readThread,
    resolveUnit, ensureThread, INTENT_SERVICE,
  };
}

module.exports = { makeStaffAgentService };
