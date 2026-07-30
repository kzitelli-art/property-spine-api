// ════════════════════════════════════════════════════════════════════
//  unit_turn_scope_service.js — THE ONE CANONICAL TURN-SCOPE PATH (BUILD 2)
//
//  Extends a confirmed BUILD 1 initial triage into a complete normal-turn
//  scope Spine can order and operate. Every scope write flows through here.
//
//  Each confirmScope() produces, in ONE caller-owned transaction:
//      · the confirmed scope        (append-only, supersedable)
//      · appliance condition rows   (unknown stays unknown)
//      · one row per finding        (separate identities)
//      · one row per required work  (separate identities, WITH A STAGE)
//      · a trigger event
//      · ONE accountable scope obligation (owner or honest UNASSIGNED)
//
//  Injected deps: { spawnObligationFromEvent }
//
//  ── ROUTINE TURN WORK IS QUIET ──────────────────────────────────────
//  This service raises NO manager obligation for ordinary paint / clean /
//  repair flow. A manager shown every routine turn stops reading the list,
//  and then misses the one that mattered. Exceptions are computed as a READ
//  (turn_sequence.turnExceptions), not spawned as noise.
//
//  ── WHAT IT MAY NEVER DO ────────────────────────────────────────────
//  Certify readiness. Complete or claim work. Invent cost, vendor, delivery
//  date, or resident responsibility. Rule on a missing key. Assign ownership
//  to whoever happened to type the scope in.
// ════════════════════════════════════════════════════════════════════

"use strict";

const {
  proposeScope, STANDARD_APPLIANCES,
  PAINT_VALUES, CLEANING_VALUES, KEYS_VALUES, APPLIANCE_VALUES, INSPECTION_VALUES,
  PAINT, CLEANING, KEYS, INSPECTION,
} = require("./turn_scope_interpreter");
const { computeTurnFlow, turnExceptions, STAGE_VALUES } = require("./turn_sequence");

const OBLIGATION_TYPES = Object.freeze({
  COMPLETE_SCOPE: "complete_turn_scope",
  RESOLVE_SCOPE: "resolve_turn_scope",
});

// ── TEMPORARY SCOPE-OWNER DEFAULT ───────────────────────────────────
//
//  Ruled for BUILD 2 and EXPLICITLY TEMPORARY:
//
//      default accountable scope owner  assistant property manager
//      contributors                     maintenance, supervisor, PM, other eligible
//      fallback                         senior property manager
//      nobody eligible                  UNASSIGNED
//
//  Matched on property_team_assignments.role_title, which migration 035 made
//  FREE TEXT precisely because real job titles ("Lead Maintenance Tech") do
//  not fit the eight-value role_name enum. So this matches PATTERNS, never a
//  named person and never a single hardcoded title.
//
//  ══════════════════════════════════════════════════════════════════
//   CLASS 4 — TEMPORARY ADAPTER. NOT THE ROLE OR ELIGIBILITY MODEL.
//  ══════════════════════════════════════════════════════════════════
//
//  EXACT REPLACEMENT CONDITION: delete this ladder in full — the constant and
//  every reference to it — the moment a property can configure its own
//  accountable turn-scope owner (a per-property assignment or setting naming
//  the role or user who owns turn scope). Nothing else needs to change: the
//  eligibility filter below already stands on its own, and this ladder only
//  ORDERS people that filter has already admitted.
//
//  1. EXISTING ASSIGNMENT AND MODULE ELIGIBILITY REMAIN AUTHORITATIVE.
//     property_team_assignments.active and .allowed_modules decide WHO MAY be
//     an owner. That check runs FIRST in resolveScopeOwner and is not
//     negotiable. This ladder never widens it.
//
//  2. A TITLE MATCH ALONE CANNOT GRANT AUTHORITY. The ladder is applied only
//     to the already-eligible pool, so a person titled "Assistant Property
//     Manager" with no management or maintenance module access is NEVER
//     selected — they are filtered out before the ladder is consulted. Title
//     breaks ties among the eligible; it does not create eligibility. If the
//     eligible pool is empty the answer is null, which surfaces as UNASSIGNED.
//
//  3. NO NAMED EMPLOYEE IS HARDCODED. These are role-title PATTERNS. No user
//     id, name, email or phone appears here or anywhere in this module. A
//     property with different titles falls through to module access, and a
//     property with nobody eligible returns UNASSIGNED rather than a guess.
//
//  4. THE REPORTING ACTOR IS NEVER ASSIGNED BY IMPLICATION. confirmScope
//     passes exclude_user_id = actor_user_id, so whoever typed the scope in is
//     preferred AGAINST. Performing the preceding action is not consent to own
//     the next one. They are re-admitted only when they are genuinely the sole
//     eligible person at the property — otherwise a single-staff property
//     would always read UNASSIGNED, which would be its own kind of lie.
//
//  5. FREE-TEXT MATCHING IS A CONCESSION, NOT A DESIGN. role_title is free
//     text (migration 035, deliberately, because "Lead Maintenance Tech" does
//     not fit the eight-value role_name enum). Matching prose is fragile and
//     is tolerated ONLY because the fallback is safe: an unmatched title loses
//     nothing, since module access still decides eligibility.
const SCOPE_OWNER_LADDER = [
  { rank: 1, re: /\b(assistant|asst\.?)\s+(property\s+)?manager\b/i, why: "assistant property manager (BUILD 2 default)" },
  { rank: 2, re: /\bsenior\s+(property\s+)?manager\b/i, why: "senior property manager (fallback)" },
  { rank: 3, re: /\b(property\s+)?manager\b/i, why: "property manager" },
];

function makeUnitTurnScopeService(deps) {
  const { spawnObligationFromEvent } = deps || {};
  if (typeof spawnObligationFromEvent !== "function") {
    throw new Error("unit_turn_scope_service requires spawnObligationFromEvent()");
  }

  //  Walks the ladder, then falls back to anyone with management access, then
  //  anyone with maintenance access. Returns null — a real UNASSIGNED — rather
  //  than inventing an owner from a role label with nobody behind it.
  async function resolveScopeOwner(client, { property_id, exclude_user_id = null }) {
    const r = await client.query(
      `select pta.user_id, pta.role_title, u.name, pta.allowed_modules
         from property_team_assignments pta
         join users u on u.id = pta.user_id
        where pta.property_id = $1 and pta.active = true
        order by pta.created_at asc`,
      [property_id]
    );
    if (r.rows.length === 0) return null;

    const eligible = r.rows.filter((x) => {
      const m = x.allowed_modules || [];
      return m.includes("management") || m.includes("maintenance");
    });
    if (eligible.length === 0) return null;

    const preferred = exclude_user_id
      ? eligible.filter((x) => String(x.user_id) !== String(exclude_user_id))
      : eligible;
    const pool = preferred.length ? preferred : eligible;

    for (const rung of SCOPE_OWNER_LADDER) {
      const hit = pool.find((x) => rung.re.test(String(x.role_title || "")));
      if (hit) return { user_id: hit.user_id, name: hit.name, role_title: hit.role_title, matched: rung.why };
    }
    const mgmt = pool.find((x) => (x.allowed_modules || []).includes("management"));
    if (mgmt) return { user_id: mgmt.user_id, name: mgmt.name, role_title: mgmt.role_title, matched: "management module access" };
    const any = pool[0];
    return { user_id: any.user_id, name: any.name, role_title: any.role_title, matched: "maintenance module access" };
  }

  //  Candidate appliances. No per-unit inventory exists in the schema, so this
  //  is served from the standard list and the caller is TOLD that, rather than
  //  being handed a fabricated unit-specific inventory.
  async function applianceCandidates(_db, { unit_id }) {
    return {
      inventory_source: "standard_list",
      inventory_known: false,
      note: "No per-unit appliance inventory exists for this property. This is a standard candidate list — anything not answered stays unknown, never 'working'.",
      appliances: STANDARD_APPLIANCES.map((a) => ({ ...a, condition: null })),
      unit_id,
    };
  }

  // ── PROPOSE — pure interpretation, writes nothing ─────────────────
  function propose(input) { return proposeScope(input); }

  // ── CONFIRM — THE ONE CANONICAL WRITE ─────────────────────────────
  async function confirmScope(client, spec) {
    const {
      property_id, unit_id, actor_user_id,
      triage_confirmation_id,
      original_text = null, photos = [],
      paint_level, paint_areas = null,
      cleaning_level,
      keys_status, keys_note = null,
      inspection_completeness = INSPECTION.PARTIAL,
      appliances = [],           // [{ key, label, condition }]
      findings = [],             // [{ finding_text, evidence_text?, origin? }]
      required_work = [],        // [{ work_text, stage, disturbs_painted_surfaces?, from_finding_index?, origin? }]
      supersedes_id = null,
      correction_reason = null,
    } = spec || {};

    const bad = (m, extra) => Object.assign(new Error(m), { httpStatus: 400, ...(extra || {}) });

    if (!property_id) throw bad("property_id is required");
    if (!unit_id) throw bad("unit_id is required");
    if (!actor_user_id) throw bad("actor_user_id is required — a confirmation needs a human actor");
    if (!triage_confirmation_id) throw bad("triage_confirmation_id is required — a turn scope extends a confirmed initial walk");
    if (!PAINT_VALUES.includes(paint_level)) throw bad("invalid paint_level", { allowed: PAINT_VALUES });
    if (!CLEANING_VALUES.includes(cleaning_level)) throw bad("invalid cleaning_level", { allowed: CLEANING_VALUES });
    if (!KEYS_VALUES.includes(keys_status)) throw bad("invalid keys_status", { allowed: KEYS_VALUES });
    if (!INSPECTION_VALUES.includes(inspection_completeness)) throw bad("invalid inspection_completeness", { allowed: INSPECTION_VALUES });
    if (paint_level !== PAINT.PARTIAL && paint_areas) throw bad("paint_areas is only meaningful when paint_level is 'partial'");
    if (supersedes_id && !(correction_reason && String(correction_reason).trim()))
      throw bad("correction_reason is required — a correction must say what it corrects and why");
    for (const w of required_work) {
      if (w.stage && !STAGE_VALUES.includes(w.stage)) throw bad("invalid stage", { allowed: STAGE_VALUES });
    }
    for (const a of appliances) {
      if (a && a.condition && !APPLIANCE_VALUES.includes(a.condition))
        throw bad("invalid appliance condition", { allowed: APPLIANCE_VALUES });
    }

    // The triage confirmation must exist, be for this unit, and be at this
    // property. A scope for another building is not a request we can honour.
    const tc = (await client.query(
      `select c.id, c.unit_id, c.property_id, u.unit_number
         from unit_triage_confirmations c join units u on u.id = c.unit_id
        where c.id = $1`, [triage_confirmation_id])).rows[0];
    if (!tc) throw Object.assign(new Error("triage confirmation not found"), { httpStatus: 404 });
    if (String(tc.unit_id) !== String(unit_id) || String(tc.property_id) !== String(property_id)) {
      throw Object.assign(
        new Error("that triage confirmation is not for the unit and property you are operating"),
        { httpStatus: 403 });
    }

    // 1) the scope
    const scope = (await client.query(
      `insert into unit_turn_scopes
         (triage_confirmation_id, property_id, unit_id, confirmed_by_user_id, original_text, photos,
          paint_level, paint_areas, cleaning_level, keys_status, keys_note,
          inspection_completeness, supersedes_id, correction_reason)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) returning *`,
      [triage_confirmation_id, property_id, unit_id, actor_user_id, original_text, photos,
       paint_level, paint_level === PAINT.PARTIAL ? paint_areas : null,
       cleaning_level, keys_status, keys_note,
       inspection_completeness, supersedes_id,
       correction_reason ? String(correction_reason).trim() : null]
    )).rows[0];

    // 2) appliances — an unanswered appliance stays unknown
    const applianceRows = [];
    for (const a of appliances) {
      if (!a || !a.key) continue;
      const row = (await client.query(
        `insert into unit_turn_appliances (scope_id, property_id, unit_id, appliance_key, label, condition)
         values ($1,$2,$3,$4,$5,$6)
         on conflict (scope_id, appliance_key) do update set condition = excluded.condition
         returning *`,
        [scope.id, property_id, unit_id, String(a.key), a.label || null, a.condition || "unknown"]
      )).rows[0];
      applianceRows.push(row);
    }

    // 3) findings — each its own row
    const findingRows = [];
    for (const f of findings) {
      if (!f || !f.finding_text || !String(f.finding_text).trim()) continue;
      const row = (await client.query(
        `insert into unit_triage_findings
           (confirmation_id, turn_scope_id, property_id, unit_id, finding_text, evidence_text, origin, is_severe, long_lead_kind)
         values ($1,$2,$3,$4,$5,$6,$7,false,null) returning *`,
        [triage_confirmation_id, scope.id, property_id, unit_id,
         String(f.finding_text).trim(), f.evidence_text || null,
         f.origin === "operator_added" ? "operator_added" : "proposed"]
      )).rows[0];
      findingRows.push(row);
    }

    // 4) required work — separate identities, each carrying its STAGE
    const workRows = [];
    for (const w of required_work) {
      if (!w || !w.work_text || !String(w.work_text).trim()) continue;
      const linked = Number.isInteger(w.from_finding_index) && findingRows[w.from_finding_index]
        ? findingRows[w.from_finding_index].id : null;
      const row = (await client.query(
        `insert into unit_triage_required_work
           (finding_id, confirmation_id, turn_scope_id, property_id, unit_id, work_text, origin,
            stage, disturbs_painted_surfaces)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning *`,
        [linked, triage_confirmation_id, scope.id, property_id, unit_id,
         String(w.work_text).trim(), w.origin === "operator_added" ? "operator_added" : "proposed",
         w.stage || null,
         w.disturbs_painted_surfaces === undefined ? null : w.disturbs_painted_surfaces]
      )).rows[0];
      workRows.push(row);
    }

    // 4b) INHERITED WORK MUST ENTER THE FLOW (migration 114)
    //
    //  Every unresolved item that predates this scope — BUILD 1 triage work,
    //  or work from an earlier scope — must be addressed EXPLICITLY. The
    //  operator sends a decision per item: place it in a stage, mark it
    //  unknown-and-owed, or withdraw it with a reason.
    //
    //  Anything they do NOT address, when they are claiming a COMPLETE scope,
    //  is flagged rather than ignored. Silence about a known blocker is not
    //  consent that it does not block.
    const inheritedDecisions = Array.isArray(spec.inherited_work) ? spec.inherited_work : [];
    const inheritedHandled = [];
    for (const d of inheritedDecisions) {
      if (!d || !d.work_id) continue;
      // The item must be on this unit — a decision cannot reach across units.
      const target = (await client.query(
        "select id, unit_id, status from unit_triage_required_work where id=$1 and unit_id=$2",
        [d.work_id, unit_id])).rows[0];
      if (!target) throw bad(`inherited work item ${d.work_id} is not on this unit`);

      if (d.action === "stage") {
        if (!STAGE_VALUES.includes(d.stage)) throw bad("a staged decision needs a valid stage", { allowed: STAGE_VALUES });
        const row = (await client.query(
          `update unit_triage_required_work
              set stage=$2, disturbs_painted_surfaces=$3,
                  stage_decision_required=false, stage_decision_note=null
            where id=$1 returning *`,
          [d.work_id, d.stage,
           d.disturbs_painted_surfaces === undefined ? null : d.disturbs_painted_surfaces])).rows[0];
        inheritedHandled.push({ work_id: d.work_id, action: "staged", stage: d.stage, work_text: row.work_text });
      } else if (d.action === "unknown") {
        // Explicitly unknown AND OWED. It blocks readiness and shows as an
        // exception until somebody answers it. This is the honest middle
        // option — not a way to make the question go away.
        if (!d.reason || !String(d.reason).trim())
          throw bad("marking inherited work unknown requires a reason");
        const row = (await client.query(
          `update unit_triage_required_work
              set stage=null, stage_decision_required=true, stage_decision_note=$2
            where id=$1 returning *`,
          [d.work_id, String(d.reason).trim()])).rows[0];
        inheritedHandled.push({ work_id: d.work_id, action: "unknown_and_owed", work_text: row.work_text });
      } else if (d.action === "withdraw") {
        if (!d.reason || !String(d.reason).trim())
          throw bad("withdrawing inherited work requires an attributed reason");
        const row = (await client.query(
          `update unit_triage_required_work
              set status='withdrawn', withdrawn_at=now(), withdrawn_by_user_id=$2,
                  withdrawn_reason=$3, stage_decision_required=false
            where id=$1 returning *`,
          [d.work_id, actor_user_id, String(d.reason).trim()])).rows[0];
        inheritedHandled.push({ work_id: d.work_id, action: "withdrawn", work_text: row.work_text });
      } else {
        throw bad("invalid inherited-work action", { allowed: ["stage", "unknown", "withdraw"] });
      }
    }

    //  The safety net. A COMPLETE scope that silently leaves known work
    //  unplaced would let `stage = NULL` mean "does not block" — the exact
    //  absence-reads-as-fact defect this build exists to prevent.
    let flaggedUnplaced = [];
    if (inspection_completeness === INSPECTION.COMPLETE) {
      flaggedUnplaced = (await client.query(
        `update unit_triage_required_work
            set stage_decision_required = true,
                stage_decision_note = coalesce(stage_decision_note,
                  'A complete turn scope was confirmed without deciding where this item belongs in the turn.')
          where unit_id = $1
            and status = 'required'
            and stage is null
            and turn_scope_id is distinct from $2
          returning id, work_text`,
        [unit_id, scope.id])).rows;
    }

    // 5) CORRECTION: withdraw the superseded scope's still-open work rather
    //    than deleting it. History stays; current truth moves.
    let withdrawn = [];
    if (supersedes_id) {
      withdrawn = (await client.query(
        `update unit_triage_required_work
            set status='superseded', superseded_by_id=null
          where turn_scope_id=$1 and status='required'
          returning id, work_text`,
        [supersedes_id])).rows;
    }

    // 6) the event
    const ev = (await client.query(
      `insert into events (property_id, unit_id, type, note)
       values ($1,$2,'unit_turn_scope_confirmed',$3) returning *`,
      [property_id, unit_id, JSON.stringify({
        scope_id: scope.id, triage_confirmation_id,
        paint_level, cleaning_level, keys_status, inspection_completeness,
        finding_count: findingRows.length, work_count: workRows.length,
        corrected: !!supersedes_id, superseded_work: withdrawn.length,
      })]
    )).rows[0];

    // 7) THE ONE ACCOUNTABLE SCOPE OBLIGATION — owner or honest UNASSIGNED.
    //    Routine work raises nothing else. This is the only obligation BUILD 2
    //    spawns on a normal turn.
    const owner = await resolveScopeOwner(client, { property_id, exclude_user_id: actor_user_id });
    const scopeObligation = await spawnObligationFromEvent(client, {
      property_id, unit_id, source_event_id: ev.id,
      module: "maintenance",
      type: OBLIGATION_TYPES.RESOLVE_SCOPE,
      label: `Resolve turn scope — unit ${tc.unit_number || ""}`.replace(/\s+/g, " ").trim(),
      owner_type: "human",
      assigned_role: "property_manager",
      escalates_to_role: "asset_manager",
      status: "open",
      priority: "normal",   // routine by default; exceptions are a READ, not noise
      severity: "normal",
      due_at: null,         // no defensible SLA; an invented clock is a fake number
      related_id: scope.id,
      related_type: "unit_turn_scope",
      assigned_user_id: owner ? owner.user_id : null,
      ownership_origin: owner ? "eligible_assignment" : "observation_spawn",
      owner_eligibility_state: owner ? "eligible_assignment" : "unassigned",
      dedupe_key: `resolve_turn_scope:${scope.id}`,
    });

    // 8) close the complete_turn_scope obligation this answers, if open
    let closedScopeTask = null;
    const openTask = (await client.query(
      `select id from obligations
        where related_type='unit' and related_id=$1 and type=$2 and status in ('open','in_progress')
        order by created_at asc limit 1`,
      [unit_id, OBLIGATION_TYPES.COMPLETE_SCOPE])).rows[0];
    if (openTask) {
      await client.query(
        `update obligations set status='complete', completed_at=now(),
                resolution_code='satisfied', updated_at=now() where id=$1`, [openTask.id]);
      closedScopeTask = openTask.id;
    }

    //  Flow is computed over ALL open work on the unit, not just the rows this
    //  scope created. Inherited items are part of this turn whether or not this
    //  confirmation authored them, and a flow that ignored them would be the
    //  seam this correction closes.
    const allOpen = (await client.query(
      "select * from unit_triage_required_work where unit_id=$1 and status='required'",
      [unit_id])).rows;
    const flow = computeTurnFlow({ scope, work: allOpen });

    return {
      scope, appliances: applianceRows, findings: findingRows, required_work: workRows,
      inherited_handled: inheritedHandled,
      inherited_left_unplaced: flaggedUnplaced,
      superseded_work: withdrawn, event: ev, flow,
      scope_obligation: scopeObligation,
      scope_owner: owner,
      closed_complete_scope_obligation_id: closedScopeTask,
      unit: { id: unit_id, unit_number: tc.unit_number },
    };
  }

  // ── WHAT THIS SCOPE WILL INHERIT ──────────────────────────────────
  //  Served BEFORE confirmation so the operator can see, and decide about,
  //  every unresolved item that predates this scope. An operator cannot place
  //  work they were never shown.
  async function inheritedWork(db, { unit_id }) {
    const rows = (await db.query(
      `select id, work_text, stage, status, stage_decision_required, stage_decision_note, created_at
         from unit_triage_required_work
        where unit_id = $1 and status = 'required'
        order by created_at asc`, [unit_id])).rows;
    const unplaced = rows.filter((r) => !r.stage);
    return {
      count: rows.length,
      needs_decision: unplaced.length,
      items: unplaced.map((r) => ({
        work_id: r.id, work_text: r.work_text,
        stage_decision_required: r.stage_decision_required,
        stage_decision_note: r.stage_decision_note,
      })),
      note: unplaced.length
        ? "These items are unresolved and have no stage. Confirming a COMPLETE scope without deciding about each one will flag it and hold the readiness walk."
        : null,
    };
  }

  // ── SEQUENCE EXCEPTION — deliberate, attributed, per item ──────────
  async function recordSequenceException(client, { work_id, actor_user_id, reason }) {
    if (!work_id) throw Object.assign(new Error("work_id is required"), { httpStatus: 400 });
    if (!actor_user_id) throw Object.assign(new Error("actor_user_id is required"), { httpStatus: 400 });
    if (!reason || !String(reason).trim())
      throw Object.assign(new Error("a reason is required — releasing work from its prerequisite must say why"), { httpStatus: 400 });
    const r = (await client.query(
      `update unit_triage_required_work
          set sequence_exception=true, sequence_exception_reason=$2,
              sequence_exception_by_user_id=$3, sequence_exception_at=now()
        where id=$1 returning *`,
      [work_id, String(reason).trim(), actor_user_id])).rows[0];
    if (!r) throw Object.assign(new Error("required-work item not found"), { httpStatus: 404 });
    return r;
  }

  // ── READ CURRENT SCOPE + ORDERED FLOW ─────────────────────────────
  async function readTurnFlow(db, { unit_id }) {
    const scopes = (await db.query(
      "select * from unit_turn_scopes where unit_id=$1 order by created_at asc", [unit_id])).rows;

    const superseded = new Set(scopes.map((s) => s.supersedes_id).filter(Boolean).map(String));
    const live = scopes.filter((s) => !superseded.has(String(s.id)));
    const scope = live[live.length - 1] || scopes[scopes.length - 1] || null;

    // ALL work for the unit, including BUILD 1 unstaged rows. One work list.
    const work = (await db.query(
      `select w.*, o.assigned_user_id as owner_user_id, usr.name as owner_name
         from unit_triage_required_work w
         left join lateral (
           select ob.assigned_user_id from obligations ob
            where ob.related_type in ('unit_turn_scope','unit_triage_confirmation')
              and ob.related_id in (w.turn_scope_id, w.confirmation_id)
              and ob.status in ('open','in_progress')
            order by ob.created_at desc limit 1
         ) o on true
         left join users usr on usr.id = o.assigned_user_id
        where w.unit_id = $1
        order by w.created_at asc`, [unit_id])).rows;

    const appliances = scope
      ? (await db.query("select * from unit_turn_appliances where scope_id=$1 order by appliance_key", [scope.id])).rows
      : [];
    const findings = scope
      ? (await db.query("select * from unit_triage_findings where turn_scope_id=$1 and withdrawn_at is null order by created_at asc", [scope.id])).rows
      : [];

    const flow = computeTurnFlow({ scope, work });

    return {
      unit_id, scope, appliances, findings,
      required_work: work,
      flow,
      corrected: !!(scope && scope.supersedes_id),
      history: scopes.map((s) => ({
        scope_id: s.id, paint_level: s.paint_level, cleaning_level: s.cleaning_level,
        keys_status: s.keys_status, inspection_completeness: s.inspection_completeness,
        confirmed_by_user_id: s.confirmed_by_user_id, supersedes_id: s.supersedes_id,
        correction_reason: s.correction_reason, created_at: s.created_at,
      })),
      state: scope ? "recorded" : "no_turn_scope_confirmed",
    };
  }

  return {
    propose, confirmScope, readTurnFlow, recordSequenceException, inheritedWork,
    resolveScopeOwner, applianceCandidates,
    computeTurnFlow, turnExceptions,
    OBLIGATION_TYPES, SCOPE_OWNER_LADDER,
  };
}

module.exports = { makeUnitTurnScopeService, OBLIGATION_TYPES };
