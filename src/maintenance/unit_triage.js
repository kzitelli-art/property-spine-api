// ════════════════════════════════════════════════════════════════════
//  unit_triage.js — POST-MOVE-OUT INITIAL TRIAGE, THE OPERATOR DOOR
//
//  BUILD 1 of Maintenance Unit-Status Capture. Isolated module, injected
//  deps, mounted in server.js with one line — the same shape as
//  maintenance.js so it can never be silently dropped.
//
//    const unitTriage = require("./src/maintenance/unit_triage");
//    app.use("/", unitTriage({ pool, spawnObligationFromEvent, unitTriageService }));
//
//  ── THE AUTHORITY SEAM (§21) ────────────────────────────────────────
//  Identical to maintenance.js and for the identical reason:
//
//    authenticated staff session
//      → server-derived property
//        → maintenance module entitlement
//          → canonical triage service
//
//  There is NO ungated twin of these routes. maintenance.js documents that
//  its older /work-orders door accepts property_id as a parameter "for dev
//  tooling and the existing callers" — and the source audit found the live
//  app calls that door instead of the authority-scoped one. This module ships
//  with ONE door so that divergence cannot happen here.
//
//  ── PROPOSE IS NOT A WRITE ──────────────────────────────────────────
//  /propose returns an interpretation and touches nothing. It calls the SAME
//  interpreter confirmTriage() uses, so the proposal and the write cannot
//  disagree — the defect that killed GET /maintenance/preview-category.
// ════════════════════════════════════════════════════════════════════

"use strict";

module.exports = function unitTriage(deps) {
  const express = require("express");
  const router = express.Router();

  const staffSessions = require("../identity/staff_session_service");
  const { VACANCY, CONDITION, COMPLETENESS } = require("./unit_triage_interpreter");

  const { pool, unitTriageService } = deps || {};
  if (!pool) throw new Error("unit_triage module requires a pool");
  // Assert at CONSTRUCTION, not at first request. maintenance.js learned this
  // the expensive way: it booted clean without its service and threw
  // TypeError inside the route, which its own catch turned into a bare 500.
  // Every create was dead for weeks behind a green boot.
  if (!unitTriageService || typeof unitTriageService.confirmTriage !== "function") {
    throw new Error(
      "unit_triage module requires unitTriageService (build it with " +
      "makeUnitTriageService({ spawnObligationFromEvent }) and inject it)"
    );
  }

  // ── the operator gate — re-read live on EVERY request, no cached scope ──
  async function requireOperator(req, res, next) {
    try {
      const op = await staffSessions.resolveStaffSession(pool, req.headers["x-staff-session"]);
      if (!op) return res.status(401).json({ error: "No valid operator session. Sign in." });
      req.operator = op;
      next();
    } catch (e) {
      return res.status(500).json({ error: "session resolution failed" });
    }
  }

  function requireMaintenanceModuleAccess(req, res, next) {
    const mods = (req.operator && req.operator.allowed_modules) || [];
    if (!mods.includes("maintenance")) {
      return res.status(403).json({
        error: "maintenance-module access required at this property (property_team_assignments.allowed_modules).",
      });
    }
    return next();
  }

  // A client-supplied property_id is never authority. If one is sent and does
  // not match the session, REFUSE — never silently substitute.
  function refuseClientProperty(req, res, next) {
    const claimed =
      (req.body && req.body.property_id) || (req.query && req.query.property_id) || null;
    if (claimed && String(claimed) !== String(req.operator.property_id)) {
      return res.status(403).json({
        error: "property authority is server-derived; a client-supplied property_id cannot select a different property.",
        acting_on: req.operator.property_id,
      });
    }
    return next();
  }

  const operatorGate = [requireOperator, requireMaintenanceModuleAccess, refuseClientProperty];

  // ── plain-language labels. The SERVER decides the words the operator
  //    reads — the same rule the economic decision card runs on. ──
  const VACANCY_LABEL = {
    [VACANCY.VACANT]: "Confirmed vacant",
    [VACANCY.SOMEONE_REMAINS]: "Someone remains in the unit",
    [VACANCY.UNCERTAIN]: "Vacancy uncertain",
  };
  const CONDITION_LABEL = {
    [CONDITION.NORMAL_TURN]: "Normal turn",
    [CONDITION.SEVERE]: "Severe",
    [CONDITION.UNCERTAIN]: "Condition uncertain",
  };
  const COMPLETENESS_LABEL = {
    [COMPLETENESS.INITIAL_TRIAGE]: "Initial triage only",
    [COMPLETENESS.COMPLETE_INSPECTION]: "Complete condition inspection",
  };
  const LONG_LEAD_LABEL = {
    appliance_replacement: "Appliance replacement",
    hvac_failure: "HVAC failure",
    pest_treatment: "Pest treatment",
    access_or_possession_problem: "Access or possession problem",
    major_cleanup: "Major cleanup",
    major_repair: "Major repair",
  };

  // Owner display: a name, or the honest word. Never a role label standing in
  // for a person, and never the submitting operator by default.
  function ownerLine(obligation) {
    if (!obligation) return null;
    if (obligation.assigned_user_id) return { owner_user_id: obligation.assigned_user_id, display: "assigned" };
    return { owner_user_id: null, display: "UNASSIGNED" };
  }

  // ════════════════════════════════════════════════════════════════
  //  PROPOSE  —  POST /operator/units/:id/triage/propose
  //  Body: { text }
  //  WRITES NOTHING. Returns the proposal plus the context Spine already
  //  knows, so the operator is never asked to re-enter a date we hold.
  // ════════════════════════════════════════════════════════════════
  router.post("/operator/units/:id/triage/propose", ...operatorGate, async (req, res) => {
    const unit_id = req.params.id;
    const text = (req.body && req.body.text) || "";
    try {
      const u = (await pool.query(
        "select id, unit_number, property_id from units where id=$1", [unit_id])).rows[0];
      if (!u) return res.status(404).json({ error: "unit not found" });
      if (String(u.property_id) !== String(req.operator.property_id)) {
        return res.status(403).json({ error: "that unit is not at the property you are operating" });
      }

      const proposal = unitTriageService.proposeTriage({ text });
      const moveIn = await unitTriageService.nextCommittedMoveIn(pool, { unit_id });

      res.json({
        unit: { id: u.id, unit_number: u.unit_number },
        // Echoed back so the confirmation card can show the operator their own
        // words above the interpretation, exactly as the contract requires.
        you_reported: text,
        proposal: {
          ...proposal,
          vacancy_label: VACANCY_LABEL[proposal.vacancy],
          initial_condition_label: CONDITION_LABEL[proposal.initial_condition],
          inspection_completeness_label: COMPLETENESS_LABEL[proposal.inspection_completeness],
          long_lead_blockers: proposal.long_lead_blockers.map((b) => ({
            ...b, label: LONG_LEAD_LABEL[b.kind] || b.kind,
          })),
        },
        // Spine already knows this. Never ask for it.
        next_move_in: moveIn,
        // Stated on every proposal so no surface has to infer it.
        proposal_is_not_truth:
          "Nothing has been recorded. These are proposals — correct, remove, or add anything before confirming.",
      });
    } catch (e) {
      res.status(e.httpStatus || 500).json({ error: e.message });
    }
  });

  // ════════════════════════════════════════════════════════════════
  //  CONFIRM  —  POST /operator/units/:id/triage/confirm
  //
  //  The ONE canonical write. Property comes from the SESSION.
  // ════════════════════════════════════════════════════════════════
  router.post("/operator/units/:id/triage/confirm", ...operatorGate, async (req, res) => {
    const b = req.body || {};
    const client = await pool.connect();
    try {
      await client.query("begin");
      const out = await unitTriageService.confirmTriage(client, {
        // authority: from the session, never the request
        property_id: req.operator.property_id,
        // staff_session_service returns the user id as `id`, NOT `user_id` —
        // it is "kept as `id` for drop-in compatibility with req.operator".
        // Reading .user_id here yields undefined, which reaches the NOT NULL
        // constraint on unit_observations.observed_by_user_id as a bare 500.
        actor_user_id: req.operator.id,
        unit_id: req.params.id,
        original_text: b.text,
        photos: Array.isArray(b.photos) ? b.photos : [],
        capture_mode: b.capture_mode === "voice" ? "voice" : "text",
        vacancy_observation: b.vacancy_observation,
        initial_condition: b.initial_condition,
        inspection_completeness: b.inspection_completeness,
        findings: Array.isArray(b.findings) ? b.findings : [],
        required_work: Array.isArray(b.required_work) ? b.required_work : [],
        supersedes_id: b.supersedes_id || null,
        correction_reason: b.correction_reason || null,
      });
      await client.query("commit");

      // ── THE RECEIPT — plain language, no internal codes ──
      const owner = ownerLine(out.scope_obligation);
      const next_steps = [];
      if (out.possession_exception) {
        next_steps.push("A manager must confirm whether this unit is actually vacant before the turn proceeds.");
      }
      if (out.move_in_risk_obligation) {
        next_steps.push(
          `A manager must decide how to protect the move-in on ${out.next_move_in.move_in_date}.`
        );
      }
      if (out.required_work.length > 0) {
        next_steps.push(`${out.required_work.length} required-work item${out.required_work.length === 1 ? "" : "s"} must be resolved.`);
      }
      if (out.confirmation.inspection_completeness === COMPLETENESS.INITIAL_TRIAGE) {
        next_steps.push("A detailed inspection is still required — this was initial triage only.");
      }

      res.status(201).json({
        recorded: true,
        receipt: {
          unit: `Unit ${out.unit.unit_number || out.unit.id}`,
          you_reported: out.observation.original_text,
          vacancy: VACANCY_LABEL[out.confirmation.vacancy_observation],
          condition: CONDITION_LABEL[out.confirmation.initial_condition],
          inspection: COMPLETENESS_LABEL[out.confirmation.inspection_completeness],
          readiness: out.readiness.readiness_label,
          findings_recorded: out.findings.map((f) => f.finding_text),
          required_work_created: out.required_work.map((w) => w.work_text),
          accountable_owner: owner ? owner.display : "UNASSIGNED",
          next_move_in: out.next_move_in
            ? `${out.next_move_in.move_in_date} — ${out.next_move_in.days_remaining} days remaining`
            : null,
          what_happens_next: next_steps,
          // Said out loud on every receipt. The absence of a finding is never
          // evidence there is nothing else wrong.
          standing_caveat:
            out.confirmation.inspection_completeness === COMPLETENESS.INITIAL_TRIAGE
              ? "Conditions not mentioned remain unknown — they were not ruled out."
              : null,
        },
        observation: out.observation,
        confirmation: out.confirmation,
        findings: out.findings,
        required_work: out.required_work,
        readiness: out.readiness,
        obligations: {
          readiness_scope: out.scope_obligation,
          possession_exception: out.possession_exception,
          protect_next_move_in: out.move_in_risk_obligation,
          closed_initial_walk: out.closed_initial_walk_obligation_id,
        },
        next_move_in: out.next_move_in,
        move_in_at_risk: out.move_in_at_risk,
        acted_on: { property_id: req.operator.property_id, actor: req.operator.name || null },
      });
    } catch (e) {
      try { await client.query("rollback"); } catch (_) {}
      res.status(e.httpStatus || 500).json({
        error: e.message, ...(e.allowed ? { allowed: e.allowed } : {}),
      });
    } finally {
      client.release();
    }
  });

  // ════════════════════════════════════════════════════════════════
  //  READ  —  GET /operator/units/:id/triage
  // ════════════════════════════════════════════════════════════════
  router.get("/operator/units/:id/triage", ...operatorGate, async (req, res) => {
    try {
      const u = (await pool.query(
        "select id, unit_number, property_id from units where id=$1", [req.params.id])).rows[0];
      if (!u) return res.status(404).json({ error: "unit not found" });
      if (String(u.property_id) !== String(req.operator.property_id)) {
        return res.status(403).json({ error: "that unit is not at the property you are operating" });
      }
      const state = await unitTriageService.readUnitTriageState(pool, { unit_id: req.params.id });
      const moveIn = await unitTriageService.nextCommittedMoveIn(pool, { unit_id: req.params.id });
      res.json({ unit: { id: u.id, unit_number: u.unit_number }, ...state, next_move_in: moveIn });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ════════════════════════════════════════════════════════════════
  //  OPEN INITIAL WALKS  —  GET /operator/unit-triage/open-walks
  //
  //  The incomplete first walk must have a visible home until completed.
  //  Scope is the SESSION's property; a caller cannot widen it.
  // ════════════════════════════════════════════════════════════════
  router.get("/operator/unit-triage/open-walks", ...operatorGate, async (req, res) => {
    try {
      const r = await pool.query(
        `select o.id, o.unit_id, o.label, o.status, o.due_at, o.priority,
                o.assigned_user_id, o.assigned_role, o.owner_eligibility_state,
                o.created_at, u.unit_number, usr.name as assigned_user_name
           from obligations o
           left join units u on u.id = o.unit_id
           left join users usr on usr.id = o.assigned_user_id
          where o.property_id = $1
            and o.type = 'initial_unit_walk'
            and o.status in ('open','in_progress')
          order by o.due_at asc nulls last, o.created_at asc`,
        [req.operator.property_id]
      );
      const now = Date.now();
      res.json({
        property_id: req.operator.property_id,
        count: r.rows.length,
        open_walks: r.rows.map((w) => ({
          obligation_id: w.id,
          unit_id: w.unit_id,
          unit_number: w.unit_number,
          label: w.label,
          due_at: w.due_at,
          // Same-day expectation. An overdue walk stays visibly overdue — it
          // never lapses into "fine", and the unit never becomes ready by it.
          overdue: !!(w.due_at && new Date(w.due_at).getTime() < now),
          owner: w.assigned_user_id
            ? { user_id: w.assigned_user_id, name: w.assigned_user_name }
            : "UNASSIGNED",
          owner_eligibility_state: w.owner_eligibility_state,
        })),
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ════════════════════════════════════════════════════════════════
  //  MANAGEMENT RISK READ  —  GET /operator/unit-triage/risk
  //
  //  The manager's decision context, in one read, so nobody reconstructs a
  //  unit's condition from work-order notes, texts, or conversations.
  //
  //  Shows units where: move-out confirmed but the first walk is incomplete ·
  //  vacancy uncertain · severe condition · long-lead blockers · a committed
  //  move-in that may be at risk · a required manager decision unassigned or
  //  unresolved.
  // ════════════════════════════════════════════════════════════════
  router.get("/operator/unit-triage/risk", ...operatorGate, async (req, res) => {
    const property_id = req.operator.property_id;
    try {
      // Units carrying either an open triage obligation or a live confirmation.
      const units = (await pool.query(
        `select distinct u.id, u.unit_number
           from units u
          where u.property_id = $1
            and ( exists (select 1 from obligations o
                           where o.unit_id = u.id
                             and o.type in ('initial_unit_walk','resolve_unit_readiness_scope',
                                            'protect_next_move_in','unit_possession_exception')
                             and o.status in ('open','in_progress'))
               or exists (select 1 from unit_triage_confirmations c where c.unit_id = u.id) )
          order by u.unit_number asc`,
        [property_id]
      )).rows;

      const rows = [];
      for (const u of units) {
        const state = await unitTriageService.readUnitTriageState(pool, { unit_id: u.id });
        const moveIn = await unitTriageService.nextCommittedMoveIn(pool, { unit_id: u.id });

        const obs = (await pool.query(
          `select o.id, o.type, o.status, o.assigned_user_id, o.assigned_role,
                  o.owner_eligibility_state, o.label, usr.name as assigned_user_name
             from obligations o
             left join users usr on usr.id = o.assigned_user_id
            where o.unit_id = $1
              and o.type in ('initial_unit_walk','resolve_unit_readiness_scope',
                             'protect_next_move_in','unit_possession_exception')
              and o.status in ('open','in_progress')
            order by o.created_at asc`,
          [u.id]
        )).rows;

        const byType = (t) => obs.find((o) => o.type === t) || null;
        const walk = byType("initial_unit_walk");
        const scope = byType("resolve_unit_readiness_scope");
        const risk = byType("protect_next_move_in");
        const possession = byType("unit_possession_exception");

        const liveFindings = (state.findings || []).filter((f) => !f.withdrawn_at);
        const longLead = liveFindings.filter((f) => !!f.long_lead_kind);

        // What actually needs a human next, in priority order. One sentence,
        // server-authored — the browser renders, it does not decide.
        let next_decision = null;
        if (possession) next_decision = "Confirm whether this unit is actually vacant.";
        else if (risk) next_decision = "Decide how to protect the committed move-in.";
        else if (walk) next_decision = "Complete the initial walk.";
        else if (scope) next_decision = "Resolve the unit-readiness scope.";

        const ownerOf = (o) =>
          !o ? null
            : o.assigned_user_id
              ? { user_id: o.assigned_user_id, name: o.assigned_user_name }
              : "UNASSIGNED";

        rows.push({
          unit_id: u.id,
          unit_number: u.unit_number,

          initial_walk_complete: !walk && !!state.confirmation,
          initial_walk_outstanding: !!walk,

          vacancy: state.confirmation ? state.confirmation.vacancy_observation : null,
          vacancy_label: state.confirmation ? VACANCY_LABEL[state.confirmation.vacancy_observation] : null,
          vacancy_uncertain: !!state.confirmation && state.confirmation.vacancy_observation !== VACANCY.VACANT,

          condition: state.confirmation ? state.confirmation.initial_condition : null,
          condition_label: state.confirmation ? CONDITION_LABEL[state.confirmation.initial_condition] : null,
          severe: !!state.confirmation && state.confirmation.initial_condition === CONDITION.SEVERE,

          inspection_completeness: state.confirmation ? state.confirmation.inspection_completeness : null,

          readiness: state.readiness,
          readiness_label: state.readiness_label,

          open_findings: liveFindings.map((f) => f.finding_text),
          long_lead_blockers: longLead.map((f) => ({
            finding: f.finding_text, kind: f.long_lead_kind,
            label: LONG_LEAD_LABEL[f.long_lead_kind] || f.long_lead_kind,
          })),
          open_scope: (state.required_work || [])
            .filter((w) => w.status === "required").map((w) => w.work_text),

          next_move_in: moveIn,
          move_in_at_risk: !!risk,

          scope_owner: ownerOf(scope),
          manager_decision_owner: ownerOf(risk),
          possession_exception_owner: ownerOf(possession),
          next_decision,
        });
      }

      // Most consequential first: possession doubt, then a threatened move-in,
      // then severity, then an outstanding walk.
      const rank = (r) =>
        (r.vacancy_uncertain ? 8 : 0) + (r.move_in_at_risk ? 4 : 0) +
        (r.severe ? 2 : 0) + (r.initial_walk_outstanding ? 1 : 0);
      rows.sort((a, b) => rank(b) - rank(a) ||
        String(a.unit_number || "").localeCompare(String(b.unit_number || "")));

      res.json({
        property_id,
        count: rows.length,
        headline: {
          walks_outstanding: rows.filter((r) => r.initial_walk_outstanding).length,
          vacancy_uncertain: rows.filter((r) => r.vacancy_uncertain).length,
          severe: rows.filter((r) => r.severe).length,
          move_ins_at_risk: rows.filter((r) => r.move_in_at_risk).length,
          unassigned_manager_decisions: rows.filter(
            (r) => r.manager_decision_owner === "UNASSIGNED").length,
        },
        units: rows,
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  return router;
};
