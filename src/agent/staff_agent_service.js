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
//  ── AND IT CANNOT TOUCH READINESS AT ALL ────────────────────────────
//  There is no certification path here and, after BUILD 6B, no call to
//  `readinessService.recordWalk` either. The readiness service is injected for
//  ONE READ — `resolveWalkAuthority`, so a redirect can say plainly when the
//  operator could not have done it anyway. Every readiness act, passed or
//  failed, happens in the Build 4 walk.
//
//  ── BUILD 6B: A REDIRECT IS NOT A PROPOSAL ──────────────────────────
//  Four things a message used to propose — accepting work, claiming readiness,
//  recording a FAILED final walk, and correcting a prior confirmed action —
//  now classify as `redirect`. `captureMessage` records the message verbatim
//  and writes NO proposal row for any of them. That is deliberately stronger
//  than refusing the confirmation later: with no row, there is nothing to
//  confirm, nothing to mis-render as pending, and nothing a future surface
//  could quietly start honouring.
//
//  THREE intents remain confirmable — initial_triage, turn_scope,
//  work_completion — and each calls exactly one canonical service. A scope
//  CORRECTION is not a special case of any of this: "actually, it needs full
//  paint" is a new scope statement, and Build 2 supersedes the old scope and
//  keeps it in history. That is the correction mechanism, and it already
//  exists, which is why this module does not grow one.
// ════════════════════════════════════════════════════════════════════

"use strict";

const {
  classifyIntent, photoNeedsClarification, needsClarification, statusLabel,
  INTENT, INTENT_SERVICE, INTENT_PLAIN, CONFIRMABLE_INTENTS, RETIRED_INTENTS,
  CLARIFICATION_STATUS, CLARIFICATION_LABEL,
} = require("./staff_agent_intent");

//  ── WHAT A RETIRED PROPOSAL IS TOLD (BUILD 6B) ──────────────────────
//  One entry per retired intent, each naming the structured door that owns the
//  act. A retired row is never silently dropped and never quietly honoured —
//  the operator is told where the action actually lives.
const RETIRED_REFUSAL = Object.freeze({
  work_acceptance: {
    message: "taking on work is done on the work item, not in a message. " +
             "Open the work item to set ownership and due timing.",
    use_instead: "POST /operator/turn-work/:workId/accept",
  },
  readiness_request: {
    message: "a message cannot certify readiness. Open the final readiness walk, " +
             "affirm every confirmation area, and certify there — Build 4 authority " +
             "and entry conditions apply.",
    use_instead: "POST /operator/units/:id/readiness/walk",
  },
  failed_final_walk: {
    message: "a failed final walk is recorded through the final readiness walk, so the " +
             "failed inspection, findings, and reopened work remain governed. " +
             "Open the walk and record it there.",
    use_instead: "POST /operator/units/:id/readiness/walk",
  },
  correction: {
    message: "open the recorded item to correct it without erasing its history. " +
             "Each record is corrected on its own canonical path.",
    use_instead: "the canonical correction path for the affected record",
  },
});

function makeStaffAgentService(deps) {
  const {
    unitTriageService, unitTurnScopeService, workAcceptanceService, readinessService,
  } = deps || {};

  // CONSTRUCTION FAILS WITHOUT EVERY CANONICAL SERVICE. A missing dependency
  // must not degrade into "well, just insert it directly" — that is precisely
  // how a second maintenance system gets built by accident.
  //  BUILD 6B: each entry names the call this module actually makes.
  //
  //    · `acceptWork` left, because accepting work is a tap on the work item.
  //    · `recordWalk` left, because a failed final walk is recorded in the
  //      walk. The readiness service is still REQUIRED — the agent reads
  //      `resolveWalkAuthority` from it so a readiness redirect can say
  //      plainly when the operator could not certify anyway — but it is
  //      required for a READ now, and there is no write left to fall back to.
  const required = [
    ["unitTriageService", unitTriageService, "confirmTriage"],
    ["unitTurnScopeService", unitTurnScopeService, "confirmScope"],
    ["workAcceptanceService", workAcceptanceService, "claimCompletion"],
    ["readinessService", readinessService, "resolveWalkAuthority"],
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

    // ── REDIRECT — RECORDED, NEVER PROPOSED (BUILD 6B) ──────────────
    //
    //  "I'll handle the refrigerator tomorrow" and "304 is ready" are real
    //  things a person said, so the message is kept. Neither is a proposal:
    //  the operator is pointed at the structured action that owns the
    //  commitment, and NO proposal row is written.
    //
    //  This returns BEFORE the proposal insert. There is no branch below that
    //  can create a confirmable row for a redirect.
    if (intent.intent === INTENT.REDIRECT) {
      let redirect = intent.redirect;

      //  WHERE THE OPERATOR LACKS AUTHORITY, SAY SO PLAINLY. The classifier is
      //  pure and cannot know who is speaking, so the authority sentence is
      //  added here — READ from the Build 4 service that owns the decision,
      //  never decided locally.
      if (redirect && redirect.to === "final_readiness" &&
          typeof readinessService.resolveWalkAuthority === "function") {
        const auth = await readinessService.resolveWalkAuthority(client, {
          property_id, user_id: actor_user_id,
        });
        if (auth) {
          //  The sentence has to match what was actually said. "You cannot
          //  certify this unit" is wrong on a FAILED walk — nobody was trying
          //  to certify — so the two redirects say different true things.
          const cannot = redirect.reason_code === "failed_walk"
            ? "You cannot perform the final readiness walk at this property:"
            : "You cannot certify this unit:";
          redirect = {
            ...redirect,
            authorized: !!auth.authorized,
            authority: auth,
            message: auth.authorized
              ? redirect.message
              : `${redirect.message} ${cannot} ${auth.reason}`,
          };
        }
      }

      return {
        thread, message,
        proposal: null,
        redirect,
        unit: resolvedUnit,
        unit_basis: unitRes.basis,
        open_work: openWork,
        would_call: INTENT_SERVICE[INTENT.REDIRECT],
        nothing_recorded:
          "Nothing operating has been recorded, and nothing is waiting on you here. " +
          "This action is taken on the item itself.",
      };
    }

    // A photo with too little text is a question, never a finding.
    const photoQ = photoNeedsClarification(text, photos);

    let status = "proposed";
    let clarification = intent.clarification;
    const unknowns = [...intent.unknowns];

    //  ONE STATUS FOR ONE OPERATOR SITUATION (BUILD 6B). `unclear` as an
    //  intent and `clarification_required` as a status were two internal names
    //  for "answer one question". New rows emit only the status.
    if (photoQ) {
      status = CLARIFICATION_STATUS;
      clarification = photoQ.clarification;
      unknowns.push(photoQ.why);
    } else if (intent.intent === INTENT.UNCLEAR || clarification) {
      status = CLARIFICATION_STATUS;
    }
    if (!resolvedUnit && unitRes.question) {
      status = CLARIFICATION_STATUS;
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
      // ONE operator concept, decided in one place, read by every surface.
      needs_clarification: needsClarification(proposal),
      clarification_label: CLARIFICATION_LABEL,
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

    //  ── RETIRED INTENTS (BUILD 6B) ────────────────────────────────
    //  Rows written before this build may name an action a message may no
    //  longer take. They stay readable history. They are refused here with the
    //  structured action that owns the commitment, never silently dropped and
    //  never quietly honoured.
    if (RETIRED_INTENTS.includes(p.intent)) {
      throw Object.assign(new Error(RETIRED_REFUSAL[p.intent].message),
        { httpStatus: 409, use_instead: RETIRED_REFUSAL[p.intent].use_instead });
    }
    //  A redirect is never written as a proposal, so this is unreachable by
    //  construction. Asserted anyway: an unreachable guard costs nothing, and
    //  a future writer adding a redirect row would otherwise find a hole.
    if (p.intent === INTENT.REDIRECT) {
      throw bad("that message pointed at a structured action. Take the action there — there is nothing to confirm here.");
    }

    //  ONE OPERATOR SITUATION, EITHER STORED SHAPE. `unclear` as an intent and
    //  `clarification_required` as a status both mean the same thing to a
    //  person: answer one question first.
    if (p.intent === INTENT.UNCLEAR) {
      throw bad("this message was not understood well enough to record anything. Answer the clarification first.",
        { clarification: p.clarification || null });
    }
    if (p.status === CLARIFICATION_STATUS) {
      throw bad("this proposal needs a clarification before it can be confirmed", { clarification: p.clarification });
    }
    //  Every remaining confirmable intent records a fact about a unit, so a
    //  proposal without one records nothing. (BUILD 6B removed the only intent
    //  that was exempt from this.)
    if (!p.unit_id) {
      throw bad("no unit was resolved for this proposal, so nothing can be recorded");
    }
    //  BELT AND BRACES: three intents may be confirmed. Anything else — a row
    //  from an older build, a value a future writer adds — stops here rather
    //  than falling through to a branch that happens to match.
    if (!CONFIRMABLE_INTENTS.includes(p.intent)) {
      throw bad("this intent cannot be confirmed");
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

    } else {
      // Unreachable: CONFIRMABLE_INTENTS was checked above.
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
    //  ONE presentation of state, decided here so every surface agrees. Old
    //  rows carrying either internal name read as the same operator concept.
    return {
      thread, messages,
      proposals: proposals.map((p) => ({
        ...p,
        plain_label: INTENT_PLAIN[p.intent] || "You sent a message",
        needs_clarification: needsClarification(p),
        status_label: statusLabel(p),
      })),
    };
  }

  return {
    captureMessage, confirmProposal, cancelProposal, readThread,
    resolveUnit, ensureThread, INTENT_SERVICE,
  };
}

module.exports = { makeStaffAgentService };
