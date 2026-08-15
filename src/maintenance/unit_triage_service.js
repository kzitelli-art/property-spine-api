// ════════════════════════════════════════════════════════════════════
//  unit_triage_service.js — THE ONE CANONICAL POST-MOVE-OUT TRIAGE PATH
//
//  BUILD 1 of Maintenance Unit-Status Capture. Every triage write — operator,
//  and any future channel — flows through this service. No route coordinates
//  low-level writes on its own, for the same reason work_order_service.js
//  exists: two functions with one name once disagreed, and the stub was the
//  one inside the write.
//
//  Each confirmTriage() call produces, in ONE caller-owned transaction:
//      · the attributed observation      (the human's exact words, verbatim)
//      · the confirmed interpretation    (append-only, supersedable)
//      · one row per confirmed finding   (separate identities, never one note)
//      · one row per required-work item  (separate identities)
//      · a trigger event                 (the trail)
//      · ONE accountable readiness obligation (owner or honest UNASSIGNED)
//      · a possession exception          when vacancy is not confirmed
//      · a manager decision obligation   when a committed move-in is at risk
//
//  Injected deps: { spawnObligationFromEvent }  — the shared engine helper.
//  This module does NOT re-implement obligation logic.
//
//  ── WHAT THIS SERVICE MAY NEVER DO ──────────────────────────────────
//  Establish readiness. Decide a legal possession question. Invent a cost,
//  vendor, schedule, or ready date. Contact a resident. Transfer a resident.
//  Change a lease or a move-in commitment. Assign ownership to whoever
//  happened to perform the preceding action.
// ════════════════════════════════════════════════════════════════════

"use strict";

const {
  interpretObservation,
  VACANCY, CONDITION, COMPLETENESS,
  VACANCY_VALUES, CONDITION_VALUES, COMPLETENESS_VALUES, LONG_LEAD_VALUES,
} = require("./unit_triage_interpreter");

const { readNextCommittedMoveIn } = require("./unit_move_in_read");

// ── READINESS VOCABULARY ────────────────────────────────────────────
//  `ready` is deliberately ABSENT. A first walk cannot prove a unit is
//  ready, so this service cannot express it. Final readiness confirmation is
//  a separate design ruling and an explicit non-goal of BUILD 1.
const READINESS = Object.freeze({
  NOT_READY: "not_ready",
  UNKNOWN: "unknown",
});

const OBLIGATION_TYPES = Object.freeze({
  INITIAL_WALK: "initial_unit_walk",
  READINESS_SCOPE: "resolve_unit_readiness_scope",
  PROTECT_MOVE_IN: "protect_next_move_in",
  POSSESSION_EXCEPTION: "unit_possession_exception",
});

// ── DERIVE READINESS — PURE, and never stored ───────────────────────
//
//  Migration 112 deliberately has no readiness column. Readiness is a READ
//  over confirmed findings, the same ruling as billback current-state
//  (work_order_service.readBillbackState) and draft staleness (commit
//  48c766e: "staleness is derived, not stored").
//
//  Two outcomes only:
//    not_ready  a confirmed blocker exists
//    unknown    the first walk found no clear blocker, but no complete
//               inspection or readiness confirmation has occurred
//
//  There is no third outcome. Absence of a finding is not evidence of
//  readiness — it is absence of evidence, which is exactly the defect this
//  build corrects.
function deriveReadiness({ confirmation, findings = [], requiredWork = [] }) {
  if (!confirmation) {
    return {
      readiness: READINESS.UNKNOWN,
      readiness_reason: "no_initial_walk_recorded",
      readiness_label: "Readiness unknown — initial inspection pending",
    };
  }

  const liveFindings = findings.filter((f) => !f.withdrawn_at);
  const liveWork = requiredWork.filter((w) => w.status === "required");

  if (confirmation.initial_condition === CONDITION.SEVERE) {
    return {
      readiness: READINESS.NOT_READY,
      readiness_reason: "severe_condition_confirmed",
      readiness_label: "Not ready — severe condition confirmed",
    };
  }
  if (confirmation.vacancy_observation !== VACANCY.VACANT) {
    return {
      readiness: READINESS.NOT_READY,
      readiness_reason: "vacancy_not_confirmed",
      readiness_label: "Not ready — vacancy not confirmed",
    };
  }
  if (liveWork.length > 0) {
    return {
      readiness: READINESS.NOT_READY,
      readiness_reason: "required_work_outstanding",
      readiness_label: "Not ready — confirmed physical work remains",
    };
  }
  if (liveFindings.length > 0) {
    return {
      readiness: READINESS.NOT_READY,
      readiness_reason: "confirmed_findings_outstanding",
      readiness_label: "Not ready — confirmed physical findings remain",
    };
  }

  // No blocker found. This is still NOT readiness — the walk was triage.
  return {
    readiness: READINESS.UNKNOWN,
    readiness_reason:
      confirmation.inspection_completeness === COMPLETENESS.COMPLETE_INSPECTION
        ? "complete_inspection_no_blocker_but_readiness_unconfirmed"
        : "initial_triage_only",
    readiness_label: "Readiness unknown — detailed inspection still required",
  };
}

function makeUnitTriageService(deps) {
  const { spawnObligationFromEvent } = deps || {};
  if (typeof spawnObligationFromEvent !== "function") {
    throw new Error("unit_triage_service requires spawnObligationFromEvent()");
  }

  // ── ELIGIBLE OWNER — or an honest UNASSIGNED ──────────────────────
  //
  //  The contract is explicit: DO NOT HARDCODE A UNIVERSAL JOB TITLE. Who
  //  walks a unit differs by property — assistant manager, maintenance tech,
  //  supervisor, property manager, another onsite staff member. So eligibility
  //  is resolved by MODULE ACCESS, which is the real gate
  //  (property_team_assignments.allowed_modules; migration 035 says so in its
  //  own header: "role_title is FREE TEXT ... and modules are the real gate").
  //
  //  `exclude_user_id` exists for one specific rule: the person who confirmed
  //  move-out must not become the inspector merely because they performed the
  //  preceding action. Doing the previous step is not consent to own the next
  //  one. If they are the ONLY eligible person, they remain eligible — the
  //  exclusion is a preference, not a disqualification, because a real
  //  single-staff property would otherwise always read UNASSIGNED.
  async function resolveEligibleOwner(client, { property_id, module, exclude_user_id = null }) {
    const r = await client.query(
      `select pta.user_id, pta.role_title, u.name,
              (pta.primary_for_modules @> array[$2]::text[]) as is_primary
         from property_team_assignments pta
         join users u on u.id = pta.user_id
        where pta.property_id = $1
          and pta.active = true
          and pta.allowed_modules @> array[$2]::text[]
        order by is_primary desc, pta.created_at asc`,
      [property_id, module]
    );
    if (r.rows.length === 0) return null;

    const notExcluded = exclude_user_id
      ? r.rows.filter((x) => String(x.user_id) !== String(exclude_user_id))
      : r.rows;

    // Prefer someone other than the preceding actor; fall back to them only
    // when they are genuinely the only eligible person at the property.
    const pick = notExcluded[0] || r.rows[0];
    return {
      user_id: pick.user_id,
      role_title: pick.role_title,
      name: pick.name,
      is_primary: pick.is_primary,
      was_preceding_actor: exclude_user_id && String(pick.user_id) === String(exclude_user_id),
    };
  }

  // ── NEXT COMMITTED MOVE-IN ────────────────────────────────────────
  //
  //  Spine already knows this. The contract forbids asking the operator to
  //  re-enter a date the system holds.
  //
  //  "Committed" is the governed threshold: executed AND required move-in
  //  funds cleared. Pending leases still affect the main planning order, but
  //  they cannot create a committed-move-in obligation here.
  async function nextCommittedMoveIn(db, { unit_id, as_of = null }) {
    return readNextCommittedMoveIn(db, { unit_id, as_of });
  }

  // ── THE INITIAL-WALK OBLIGATION ───────────────────────────────────
  //
  //  Born from confirmed move-out. The operating expectation is same-day
  //  inspection, so it is born HIGH priority and due today. If staffing or
  //  timing prevents that, it stays visibly unresolved and overdue — it does
  //  NOT quietly lapse, and the unit does not become ready by its absence.
  async function spawnInitialWalk(client, { property_id, unit_id, source_event_id, unit_number = null, exclude_user_id = null }) {
    const owner = await resolveEligibleOwner(client, {
      property_id, module: "maintenance", exclude_user_id,
    });

    return spawnObligationFromEvent(client, {
      property_id,
      unit_id,
      source_event_id,
      module: "maintenance",
      type: OBLIGATION_TYPES.INITIAL_WALK,
      label: `Walk unit ${unit_number || ""} and report its initial condition`.replace(/\s+/g, " ").trim(),
      owner_type: "human",
      assigned_role: "maintenance",
      escalates_to_role: "property_manager",
      status: "open",
      priority: "high",
      severity: "high",
      // Same-day expectation, stated as a real due date rather than a
      // sentiment. An obligation with no clock cannot be visibly late.
      due_at: new Date(),
      required_inputs: ["initial_walk_report"],
      related_id: unit_id,
      related_type: "unit",
      assigned_user_id: owner ? owner.user_id : null,
      ownership_origin: owner ? "eligible_assignment" : null,
      owner_eligibility_state: owner ? "eligible_assignment" : "unassigned",
      dedupe_key: `initial_unit_walk:${unit_id}:${source_event_id}`,
    });
  }

  // ── PROPOSE — pure, writes nothing ────────────────────────────────
  //
  //  Separated from confirm on purpose. GET /maintenance/preview-category was
  //  deleted because a preview promised what the save would not do; the fix is
  //  not to remove proposals but to make the proposal and the write share one
  //  interpreter. They do: this calls the same function confirmTriage does.
  function proposeTriage({ text }) {
    return interpretObservation(text);
  }

  // ── CONFIRM — THE ONE CANONICAL WRITE ─────────────────────────────
  //
  //  Caller owns the transaction. `property_id` MUST come from the session at
  //  the route layer; this service takes it as already-derived authority and
  //  never accepts it from a request body.
  async function confirmTriage(client, spec) {
    const {
      property_id, unit_id,
      actor_user_id,                 // the authenticated staff member
      original_text,                 // their exact words
      photos = [],
      capture_mode = "text",
      // The CONFIRMED interpretation. The operator may have corrected any of
      // it; what arrives here is what they confirmed, not what was proposed.
      vacancy_observation,
      initial_condition,
      inspection_completeness = COMPLETENESS.INITIAL_TRIAGE,
      findings = [],                 // [{ finding_text, evidence_text?, is_severe?, long_lead_kind?, origin? }]
      required_work = [],            // [{ work_text, from_finding_index?, origin? }]
      // Correction of a prior confirmation.
      supersedes_id = null,
      correction_reason = null,
    } = spec || {};

    const bad = (m, extra) => Object.assign(new Error(m), { httpStatus: 400, ...(extra || {}) });

    if (!property_id) throw bad("property_id is required");
    if (!unit_id) throw bad("unit_id is required");
    if (!actor_user_id) throw bad("actor_user_id is required — a confirmation needs a human actor");
    if (!original_text || !String(original_text).trim())
      throw bad("original_text is required — the observation's own words are the evidence");
    if (!VACANCY_VALUES.includes(vacancy_observation))
      throw bad("invalid vacancy_observation", { allowed: VACANCY_VALUES });
    if (!CONDITION_VALUES.includes(initial_condition))
      throw bad("invalid initial_condition", { allowed: CONDITION_VALUES });
    if (!COMPLETENESS_VALUES.includes(inspection_completeness))
      throw bad("invalid inspection_completeness", { allowed: COMPLETENESS_VALUES });
    if (supersedes_id && !(correction_reason && String(correction_reason).trim()))
      throw bad("correction_reason is required — a correction must say what it corrects and why");
    for (const f of findings) {
      if (f.long_lead_kind && !LONG_LEAD_VALUES.includes(f.long_lead_kind))
        throw bad("invalid long_lead_kind", { allowed: LONG_LEAD_VALUES });
    }

    // The unit must exist AND belong to the session's property. A unit from
    // another building is not a request this service can honor, whatever the
    // caller believes.
    const u = (await client.query(
      "select id, unit_number, property_id from units where id=$1", [unit_id])).rows[0];
    if (!u) throw Object.assign(new Error("unit not found"), { httpStatus: 404 });
    if (String(u.property_id) !== String(property_id)) {
      throw Object.assign(
        new Error("unit does not belong to the property you are operating"),
        { httpStatus: 403 });
    }

    // 1) the attributed observation — verbatim, never edited
    const obs = (await client.query(
      `insert into unit_observations
         (property_id, unit_id, observed_by_user_id, original_text, photos, capture_mode)
       values ($1,$2,$3,$4,$5,$6) returning *`,
      [property_id, unit_id, actor_user_id, String(original_text), photos, capture_mode]
    )).rows[0];

    // 2) the confirmed interpretation
    const conf = (await client.query(
      `insert into unit_triage_confirmations
         (observation_id, property_id, unit_id, confirmed_by_user_id,
          vacancy_observation, initial_condition, inspection_completeness,
          supersedes_id, correction_reason)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning *`,
      [obs.id, property_id, unit_id, actor_user_id,
       vacancy_observation, initial_condition, inspection_completeness,
       supersedes_id, correction_reason ? String(correction_reason).trim() : null]
    )).rows[0];

    // 3) findings — each its own row, each its own identity
    const findingRows = [];
    for (const f of findings) {
      if (!f || !f.finding_text || !String(f.finding_text).trim()) continue;
      const row = (await client.query(
        `insert into unit_triage_findings
           (confirmation_id, property_id, unit_id, finding_text, evidence_text,
            origin, is_severe, long_lead_kind)
         values ($1,$2,$3,$4,$5,$6,$7,$8) returning *`,
        [conf.id, property_id, unit_id, String(f.finding_text).trim(),
         f.evidence_text || null, f.origin === "operator_added" ? "operator_added" : "proposed",
         !!f.is_severe, f.long_lead_kind || null]
      )).rows[0];
      findingRows.push(row);
    }

    // 4) required work — separate identities, never collapsed into one note
    const workRows = [];
    for (const w of required_work) {
      if (!w || !w.work_text || !String(w.work_text).trim()) continue;
      const linked =
        Number.isInteger(w.from_finding_index) && findingRows[w.from_finding_index]
          ? findingRows[w.from_finding_index].id
          : null;
      const row = (await client.query(
        `insert into unit_triage_required_work
           (finding_id, confirmation_id, property_id, unit_id, work_text, origin)
         values ($1,$2,$3,$4,$5,$6) returning *`,
        [linked, conf.id, property_id, unit_id, String(w.work_text).trim(),
         w.origin === "operator_added" ? "operator_added" : "proposed"]
      )).rows[0];
      workRows.push(row);
    }

    // 5) the trigger event — obligations are born only from events
    const readiness = deriveReadiness({ confirmation: conf, findings: findingRows, requiredWork: workRows });
    const ev = (await client.query(
      `insert into events (property_id, unit_id, type, note)
       values ($1,$2,'unit_triage_confirmed',$3) returning *`,
      [property_id, unit_id, JSON.stringify({
        observation_id: obs.id, confirmation_id: conf.id,
        vacancy_observation, initial_condition, inspection_completeness,
        finding_count: findingRows.length, required_work_count: workRows.length,
        readiness: readiness.readiness,
        corrected: !!supersedes_id,
      })]
    )).rows[0];

    // 6) THE ONE ACCOUNTABLE OBLIGATION over the confirmed scope.
    //    It governs the unresolved outcome. It does NOT mean one person
    //    performs every item — individual work may later be assigned to
    //    different people or vendors without changing who is accountable.
    const scopeOwner = await resolveEligibleOwner(client, {
      property_id, module: "maintenance", exclude_user_id: null,
    });
    const scopeObligation = await spawnObligationFromEvent(client, {
      property_id, unit_id, source_event_id: ev.id,
      module: "maintenance",
      type: OBLIGATION_TYPES.READINESS_SCOPE,
      label: `Resolve unit-readiness scope — unit ${u.unit_number || ""}`.replace(/\s+/g, " ").trim(),
      owner_type: "human",
      assigned_role: "maintenance",
      escalates_to_role: "property_manager",
      status: "open",
      priority: readiness.readiness === READINESS.NOT_READY ? "high" : "normal",
      severity: initial_condition === CONDITION.SEVERE ? "high" : "normal",
      // No due date. There is no defensible SLA for resolving a scope whose
      // contents were just discovered, and an invented clock is a fake number.
      due_at: null,
      related_id: conf.id,
      related_type: "unit_triage_confirmation",
      assigned_user_id: scopeOwner ? scopeOwner.user_id : null,
      ownership_origin: scopeOwner ? "eligible_assignment" : "observation_spawn",
      owner_eligibility_state: scopeOwner ? "eligible_assignment" : "unassigned",
      dedupe_key: `unit_readiness_scope:${conf.id}`,
    });

    // 7) POSSESSION EXCEPTION — vacancy not confirmed.
    //    Preserve the uncertainty and route it. This is NOT a legal
    //    determination: not holdover, not trespass, not eviction. The staff
    //    member's words survive verbatim on the observation; this obligation
    //    only says a human must look at it.
    let possessionException = null;
    if (vacancy_observation !== VACANCY.VACANT) {
      const mgr = await resolveEligibleOwner(client, { property_id, module: "management" });
      possessionException = await spawnObligationFromEvent(client, {
        property_id, unit_id, source_event_id: ev.id,
        module: "maintenance",
        type: OBLIGATION_TYPES.POSSESSION_EXCEPTION,
        label: vacancy_observation === VACANCY.SOMEONE_REMAINS
          ? `Possession exception — someone was reported in unit ${u.unit_number || ""}`.replace(/\s+/g, " ").trim()
          : `Possession unclear — confirm whether unit ${u.unit_number || ""} is vacant`.replace(/\s+/g, " ").trim(),
        owner_type: "human",
        assigned_role: "property_manager",
        escalates_to_role: "asset_manager",
        status: "open",
        priority: "high",
        severity: "high",
        due_at: null,
        related_id: conf.id,
        related_type: "unit_triage_confirmation",
        assigned_user_id: mgr ? mgr.user_id : null,
        ownership_origin: mgr ? "eligible_assignment" : "observation_spawn",
        owner_eligibility_state: mgr ? "eligible_assignment" : "unassigned",
        dedupe_key: `unit_possession_exception:${conf.id}`,
      });
    }

    // 8) NEXT-MOVE-IN RISK — a MANAGER DECISION, never an action.
    //    This build may not contact the incoming resident, promise another
    //    unit, transfer anyone, or change a lease. It surfaces the decision
    //    and names who owes it.
    const moveIn = await nextCommittedMoveIn(client, { unit_id });
    const hasLongLead = findingRows.some((f) => !!f.long_lead_kind);
    const atRisk = !!moveIn && (initial_condition === CONDITION.SEVERE || hasLongLead);

    let moveInRiskObligation = null;
    if (atRisk) {
      // The expected owner is the most senior eligible onsite manager under
      // the existing assignment model. If none is eligible, UNASSIGNED — and
      // the existing escalation path reaches the asset manager.
      const mgr = await resolveEligibleOwner(client, { property_id, module: "management" });
      moveInRiskObligation = await spawnObligationFromEvent(client, {
        property_id, unit_id, source_event_id: ev.id,
        module: "maintenance",
        type: OBLIGATION_TYPES.PROTECT_MOVE_IN,
        label: `Protect the next move-in — unit ${u.unit_number || ""}, ${moveIn.move_in_date} (${moveIn.days_remaining} days)`.replace(/\s+/g, " ").trim(),
        owner_type: "human",
        assigned_role: "property_manager",
        escalates_to_role: "asset_manager",
        status: "open",
        priority: "high",
        severity: "high",
        due_at: null,
        related_id: conf.id,
        related_type: "unit_triage_confirmation",
        assigned_user_id: mgr ? mgr.user_id : null,
        ownership_origin: mgr ? "eligible_assignment" : "observation_spawn",
        owner_eligibility_state: mgr ? "eligible_assignment" : "unassigned",
        dedupe_key: `protect_next_move_in:${conf.id}`,
      });
    }

    // 9) Close the initial-walk obligation this confirmation answers, if one
    //    is open. The walk was performed; leaving it open would show a unit as
    //    uninspected immediately after it was inspected.
    let closedWalk = null;
    const openWalk = (await client.query(
      `select id from obligations
        where related_type='unit' and related_id=$1 and type=$2 and status in ('open','in_progress')
        order by created_at asc limit 1`,
      [unit_id, OBLIGATION_TYPES.INITIAL_WALK])).rows[0];
    if (openWalk) {
      await client.query(
        `update obligations
            set status='complete', completed_at=now(), resolution_code='satisfied', updated_at=now()
          where id=$1`, [openWalk.id]);
      closedWalk = openWalk.id;
    }

    return {
      observation: obs,
      confirmation: conf,
      findings: findingRows,
      required_work: workRows,
      event: ev,
      readiness,
      scope_obligation: scopeObligation,
      possession_exception: possessionException,
      next_move_in: moveIn,
      move_in_at_risk: atRisk,
      move_in_risk_obligation: moveInRiskObligation,
      closed_initial_walk_obligation_id: closedWalk,
      unit: { id: u.id, unit_number: u.unit_number },
    };
  }

  // ── READ CURRENT TRIAGE TRUTH ─────────────────────────────────────
  //
  //  Current state is a READ. The latest confirmation nothing supersedes wins.
  async function readUnitTriageState(db, { unit_id }) {
    const rows = (await db.query(
      `select c.*, o.original_text, o.observed_by_user_id, o.captured_at, o.photos
         from unit_triage_confirmations c
         join unit_observations o on o.id = c.observation_id
        where c.unit_id = $1
        order by c.created_at asc`, [unit_id])).rows;

    if (rows.length === 0) {
      return {
        unit_id,
        confirmation: null,
        ...deriveReadiness({ confirmation: null }),
        findings: [], required_work: [], history: [],
        // An honest blank. Not "ready", not "fine", not an empty success.
        state: "no_initial_walk_recorded",
      };
    }

    const superseded = new Set(rows.map((r) => r.supersedes_id).filter(Boolean).map(String));
    const live = rows.filter((r) => !superseded.has(String(r.id)));
    const current = live[live.length - 1] || rows[rows.length - 1];

    const findings = (await db.query(
      "select * from unit_triage_findings where confirmation_id=$1 order by created_at asc",
      [current.id])).rows;
    const requiredWork = (await db.query(
      "select * from unit_triage_required_work where confirmation_id=$1 order by created_at asc",
      [current.id])).rows;

    return {
      unit_id,
      confirmation: current,
      ...deriveReadiness({ confirmation: current, findings, requiredWork }),
      findings,
      required_work: requiredWork,
      corrected: !!current.supersedes_id,
      history: rows.map((r) => ({
        confirmation_id: r.id,
        observation_id: r.observation_id,
        original_text: r.original_text,
        confirmed_by_user_id: r.confirmed_by_user_id,
        vacancy_observation: r.vacancy_observation,
        initial_condition: r.initial_condition,
        inspection_completeness: r.inspection_completeness,
        supersedes_id: r.supersedes_id,
        correction_reason: r.correction_reason,
        created_at: r.created_at,
      })),
      state: "recorded",
    };
  }

  return {
    proposeTriage,
    confirmTriage,
    readUnitTriageState,
    nextCommittedMoveIn,
    resolveEligibleOwner,
    spawnInitialWalk,
    deriveReadiness,
    READINESS,
    OBLIGATION_TYPES,
  };
}

module.exports = { makeUnitTriageService, deriveReadiness, READINESS, OBLIGATION_TYPES };
