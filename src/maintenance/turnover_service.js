// One canonical move-out -> turnover transaction. HTTP doors supply authority;
// this service owns the durable write and never trusts a client property id.

"use strict";

const { spacePosition } = require('../tenancy/space_position');

const GATES = Object.freeze(["moveout_photos", "deposit_review"]);

const serviceError = (httpStatus, code, message, extra = {}) =>
  Object.assign(new Error(message), { httpStatus, code, ...extra });

const ymd = (value, field) => {
  if (value == null || value === "") return null;
  const text = String(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    throw serviceError(400, "INVALID_DATE", `${field} must be YYYY-MM-DD.`);
  }
  const parsed = new Date(text + "T00:00:00Z");
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== text) {
    throw serviceError(400, "INVALID_DATE", `${field} must be a real calendar date.`);
  }
  return text;
};

function makeTurnoverService(deps) {
  const {
    spawnObligationFromEvent,
    recordEffectivePossession,
    unitTriageService,
  } = deps || {};

  if (typeof spawnObligationFromEvent !== "function") {
    throw new Error("turnover_service requires spawnObligationFromEvent");
  }
  if (typeof recordEffectivePossession !== "function") {
    throw new Error("turnover_service requires recordEffectivePossession");
  }
  if (!unitTriageService || typeof unitTriageService.spawnInitialWalk !== "function") {
    throw new Error("turnover_service requires unitTriageService.spawnInitialWalk");
  }

  const mapRole = (orgRole) => ({
    property_manager: "property_manager",
    maintenance: "maintenance",
    leasing: "leasing_agent",
    bookkeeper: "accountant",
    asset_manager: "asset_manager",
    owner: "owner",
  })[orgRole] || "property_manager";

  async function routeMoveOut(client, property_id) {
    const prop = await client.query(
      "select accountable_assignment_id from properties where id=$1",
      [property_id]
    );
    const accountableId = prop.rows[0] ? prop.rows[0].accountable_assignment_id : null;
    let assigned_role = "property_manager";
    let escalates_to_role = "owner";

    if (accountableId) {
      const assignment = await client.query(
        "select role, escalates_to_assignment_id from assignments where id=$1 and is_active=true",
        [accountableId]
      );
      if (assignment.rows.length) {
        assigned_role = mapRole(assignment.rows[0].role);
        if (assignment.rows[0].escalates_to_assignment_id) {
          const escalation = await client.query(
            "select role from assignments where id=$1",
            [assignment.rows[0].escalates_to_assignment_id]
          );
          if (escalation.rows.length) escalates_to_role = mapRole(escalation.rows[0].role);
        }
      }
    }
    return { assigned_role, escalates_to_role };
  }

  async function openTurnover(client, {
    property_id = null,
    unit_id,
    outgoing_lease_id = null,
    needs = [],
    expected_ready_date = null,
    actor_user_id = null,
  } = {}) {
    if (!client || typeof client.query !== "function") {
      throw new Error("openTurnover requires a database client");
    }
    if (!unit_id) throw serviceError(400, "UNIT_REQUIRED", "unit_id is required.");
    if (!Array.isArray(needs) || needs.some((n) => typeof n !== "string")) {
      throw serviceError(400, "INVALID_NEEDS", "needs must be an array of text items.");
    }
    const normalizedNeeds = [...new Set(needs.map((n) => n.trim()).filter(Boolean))];
    const expectedReadyDate = ymd(expected_ready_date, "expected_ready_date");

    const unit = (await client.query(
      `select id, property_id, unit_number, occupancy_status
         from units where id=$1 for update`,
      [unit_id]
    )).rows[0];
    if (!unit) throw serviceError(404, "UNIT_NOT_FOUND", "unit not found");
    if (property_id && String(unit.property_id) !== String(property_id)) {
      throw serviceError(403, "WRONG_PROPERTY", "that unit is not at the property you are operating");
    }

    if (outgoing_lease_id) {
      const lease = (await client.query(
        `select l.id, l.property_id, s.unit_id
           from leases l join spaces s on s.id=l.space_id
          where l.id=$1`,
        [outgoing_lease_id]
      )).rows[0];
      if (!lease) throw serviceError(404, "LEASE_NOT_FOUND", "outgoing_lease_id not found");
      if (String(lease.property_id) !== String(unit.property_id) || String(lease.unit_id) !== String(unit.id)) {
        throw serviceError(409, "LEASE_UNIT_MISMATCH", "the outgoing lease does not govern this unit");
      }
    }

    const existing = (await client.query(
      `select id from turnovers
        where unit_id=$1 and status='in_progress'
        order by created_at desc limit 1 for update`,
      [unit_id]
    )).rows[0];
    if (existing) {
      throw serviceError(409, "TURNOVER_ALREADY_ACTIVE", "this unit already has an in-progress turnover", {
        turnover_id: existing.id,
      });
    }

    const turnover = (await client.query(
      `insert into turnovers (property_id, unit_id, outgoing_lease_id, needs, ready_date)
       values ($1,$2,$3,$4,$5) returning *`,
      [unit.property_id, unit_id, outgoing_lease_id, normalizedNeeds, expectedReadyDate]
    )).rows[0];

    const event = (await client.query(
      `insert into events (property_id, unit_id, type, note)
       values ($1,$2,'move_out',$3) returning *`,
      [unit.property_id, unit_id, JSON.stringify({
        unit_id,
        turnover_id: turnover.id,
        outgoing_lease_id,
        needs: normalizedNeeds,
        confirmed_by_user_id: actor_user_id,
      })]
    )).rows[0];

    const route = await routeMoveOut(client, unit.property_id);
    const obligation = await spawnObligationFromEvent(client, {
      property_id: unit.property_id,
      unit_id,
      source_event_id: event.id,
      related_id: turnover.id,
      related_type: "turnover",
      module: "turnover",
      type: "move_out",
      label: `Move-out turn - unit ${unit.unit_number || ""}`.trim(),
      owner_type: "human",
      assigned_role: route.assigned_role,
      escalates_to_role: route.escalates_to_role,
      status: "open",
      priority: "high",
      severity: "high",
      due_at: expectedReadyDate ? new Date(expectedReadyDate + "T00:00:00Z") : null,
      required_inputs: GATES,
    });

    const initialWalk = await unitTriageService.spawnInitialWalk(client, {
      property_id: unit.property_id,
      unit_id,
      source_event_id: event.id,
      unit_number: unit.unit_number,
      exclude_user_id: actor_user_id,
    });

    let moveOutNote = null;
    if (outgoing_lease_id) {
      await client.query("savepoint sp_moveout");
      try {
        const possession = await recordEffectivePossession(client, {
          kind: "move_out",
          lease_id: outgoing_lease_id,
          unit_id,
          property_id: unit.property_id,
          effective_date: new Date().toISOString().slice(0, 10),
          actor: actor_user_id,
          source: "move_out",
          details: { actor_user_id, turnover_id: turnover.id },
        });
        await client.query("release savepoint sp_moveout");
        moveOutNote = possession.created
          ? "Effective move_out recorded (verified prior possession)."
          : "Move_out already recorded - idempotent no-op.";
      } catch (error) {
        if (error.code !== "NO_POSSESSION_TO_END") throw error;
        await client.query("rollback to savepoint sp_moveout");
        moveOutNote = "Turn recorded; no possession-end event because this lease had no live move-in.";
      }
    } else {
      moveOutNote = "No outgoing_lease_id - turn only; no possession-end event.";
    }

    // A bed's move-out cannot vacate a sibling whose possession remains live.
    // Reuse the canonical as-of reader, including its correction/date handling;
    // this compatibility label does not establish rentable-space availability.
    const positions = await spacePosition(client, { property_id: unit.property_id });
    const unitPositions = positions.positions.filter(position => String(position.unit_id) === String(unit_id));
    const stillPossessed = unitPositions.some(position => position.current_possession);
    // No recorded move-in is not a recorded vacancy. A whole-unit move-out
    // retains its existing single-position meaning; on a shared unit each
    // position needs its own recorded end before this cache can say vacant.
    const allEnded = unitPositions.length > 0 && unitPositions.every(position =>
      position.last_possession_end?.event_id && position.last_possession_end?.lease_id
      && position.conflict_state === 'clear'
      && !position.activation_pending_lease_position
      && !(position.other_spanning_lease_positions || []).length
      && (!position.current_lease_position
        || position.current_lease_position.lease_id === position.last_possession_end.lease_id));
    const occupancy = stillPossessed ? 'occupied'
      : unitPositions.length === 1 || allEnded ? 'vacant' : 'unknown';
    await client.query(
      "update units set occupancy_status=$2, updated_at=now() where id=$1",
      [unit_id, occupancy]
    );
    const updatedUnit = (await client.query(
      "select id, unit_number, occupancy_status, operating_use, is_down from units where id=$1",
      [unit_id]
    )).rows[0];

    return {
      turnover,
      event,
      move_out_note: moveOutNote,
      obligation,
      initial_walk_obligation: initialWalk,
      unit: updatedUnit,
      routed_role: route.assigned_role,
      note: "Move-out logged. Turnover opened; rentable readiness remains pending the turn.",
      initial_walk_note: initialWalk.assigned_user_id
        ? "Initial walk assigned - same-day inspection expected."
        : "Initial walk created but UNASSIGNED - no eligible onsite staff at this property.",
    };
  }

  /*  ── RE-STATE THE EXPECTED-READY DATE ON AN OPEN TURN ──────────────
   *  Until row 152 `turnovers.ready_date` had no writer between move-out
   *  and close, so a plan that slipped stayed `expected` on a date nobody
   *  believed. This is the governed correction: the same management
   *  authority that stated the date at move-out may re-state it, with a
   *  reason, and the change is an event a reader can point at. Availability
   *  treats a re-statement as the manager pricing in whatever the walk
   *  found after the previous date (availability_read.turnPlanExceeded).
   *
   *  It does not close the turn, certify anything, or touch possession.
   *  `ready_date` keeps ONE meaning per status by convention: expected
   *  while `in_progress`, actual once closed.                          */
  async function restateExpectedReady(client, {
    property_id = null, unit_id, expected_ready_date, reason, actor_user_id = null,
  } = {}) {
    if (!client || typeof client.query !== "function") throw new Error("restateExpectedReady requires a database client");
    if (!unit_id) throw serviceError(400, "UNIT_REQUIRED", "unit_id is required.");
    const next = ymd(expected_ready_date, "expected_ready_date");
    if (!next) throw serviceError(400, "EXPECTED_READY_DATE_REQUIRED", "expected_ready_date is required to re-state the turn target.");
    if (!reason || !String(reason).trim()) throw serviceError(400, "REASON_REQUIRED", "Say why the turn target moved — the reason is the record.");
    if (!actor_user_id) throw serviceError(400, "ACTOR_REQUIRED", "A staff actor is required to re-state a turn target.");

    const unit = (await client.query("select id, property_id, unit_number from units where id=$1", [unit_id])).rows[0];
    if (!unit) throw serviceError(404, "UNIT_NOT_FOUND", "unit not found");
    if (property_id && String(unit.property_id) !== String(property_id)) {
      throw serviceError(403, "WRONG_PROPERTY", "that unit is not at the property you are operating");
    }
    const turnover = (await client.query(
      `select id, ready_date from turnovers
        where unit_id=$1 and status='in_progress'
        order by created_at desc limit 1 for update`, [unit_id])).rows[0];
    if (!turnover) throw serviceError(409, "NO_ACTIVE_TURNOVER", "this unit has no turn in progress, so there is no target to re-state");
    const previous = turnover.ready_date ? new Date(turnover.ready_date).toISOString().slice(0, 10) : null;

    const updated = (await client.query(
      "update turnovers set ready_date=$2, updated_at=now() where id=$1 returning *", [turnover.id, next])).rows[0];
    const event = (await client.query(
      `insert into events (property_id, unit_id, type, note) values ($1,$2,'turn_ready_date_restated',$3) returning *`,
      [unit.property_id, unit_id, JSON.stringify({
        turnover_id: turnover.id, previous_ready_date: previous, ready_date: next,
        reason: String(reason).trim(), restated_by_user_id: actor_user_id,
      })])).rows[0];
    //  The move-out obligation was born due on the stated date; it moves with it.
    await client.query(
      `update obligations set due_at=$2, updated_at=now()
        where module='turnover' and type='move_out' and related_id=$1 and status in ('open','in_progress')`,
      [turnover.id, new Date(next + "T00:00:00Z")]);

    return {
      turnover: updated, event, previous_ready_date: previous, expected_ready_date: next,
      note: previous
        ? `Turn target moved from ${previous} to ${next}. Leasing reads the new date as expected from now on.`
        : `Turn target set to ${next}. Leasing reads it as expected from now on.`,
    };
  }

  return { openTurnover, restateExpectedReady, routeMoveOut, GATES };
}

module.exports = { makeTurnoverService, GATES };
