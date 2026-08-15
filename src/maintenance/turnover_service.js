// One canonical move-out -> turnover transaction. HTTP doors supply authority;
// this service owns the durable write and never trusts a client property id.

"use strict";

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

    // Compatibility cache only. The unit event above remains possession truth.
    await client.query(
      "update units set occupancy_status='vacant', updated_at=now() where id=$1",
      [unit_id]
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

  return { openTurnover, routeMoveOut, GATES };
}

module.exports = { makeTurnoverService, GATES };
