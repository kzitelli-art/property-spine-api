// ═══════════════════════════════════════════════════════════════════════════
// movein.js — MOVE-IN READINESS, ECONOMIC TENANCY, AND KEY HANDOFF
//
// Permanent distinctions:
//   confirmed lease + exact charges + applied funds → economic tenancy active
//   maintenance readiness                            → unit_ready
//   PM preparation                                  → keys_access_ready
//   authenticated human hands over access           → physical possession
//
// Maintenance never activates tenancy, never claims possession, and never
// supplies the handoff actor. A late key pickup is a normal active-tenancy state.
// ═══════════════════════════════════════════════════════════════════════════

"use strict";

const staffSessions = require("./staff_session_service");
const economicTenancy = require("./economic_tenancy_service");
const moveInQueue = require("./move_in_queue");

module.exports = function movein(deps) {
  const express = require("express");
  const router = express.Router();
  const {
    pool,
    spawnObligationFromEvent,
    satisfyObligation,
    completeObligation,
    deliveryHelper = null,
    recordEffectivePossession = null,
  } = deps || {};
  if (!pool) throw new Error("movein module requires a pool");
  if (typeof spawnObligationFromEvent !== "function" ||
      typeof satisfyObligation !== "function" ||
      typeof completeObligation !== "function") {
    throw new Error("movein module requires obligation helpers");
  }

  const OPERATIONAL_GATES = ["readiness_checklist", "appliances_checked", "unit_condition_photos"];
  const APPROVAL_GATE = "rent_ready_approval";
  const ALL_INPUTS = [...OPERATIONAL_GATES, APPROVAL_GATE];
  const DEFAULT_WINDOW_DAYS = 7;

  const httpError = (status, code, receipt, extra = {}) => {
    const e = new Error(receipt);
    e.httpStatus = status;
    e.publicBody = { error: code, receipt, ...extra };
    return e;
  };
  const sendError = (res, e) => {
    if (e && e.service && e.body) return res.status(e.http || 500).json(e.body);
    if (e && e.publicBody) return res.status(e.httpStatus || 500).json(e.publicBody);
    console.error("movein error", e);
    return res.status(500).json({ error: "MOVE_IN_FAILED", receipt: "The move-in action failed. No success was recorded." });
  };
  const ymd = (value) => {
    if (!value) return null;
    const d = value instanceof Date ? value : new Date(value);
    return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
  };

  function moduleAllowed(operator, accepted) {
    const modules = Array.isArray(operator && operator.allowed_modules) ? operator.allowed_modules : [];
    if (accepted.some((m) => modules.includes(m))) return true;
    const role = String(operator && (operator.role_title || operator.role) || "").toLowerCase().replace(/[^a-z0-9]+/g, "_");
    const roleDomains = new Set();
    if (role.includes("leasing")) roleDomains.add("leasing");
    if (role.includes("maintenance")) roleDomains.add("maintenance");
    if (role.includes("property_manager") || role.includes("manager") || role.includes("asset_manager") || role.includes("owner")) roleDomains.add("management");
    if (role.includes("front_desk") || role.includes("concierge")) roleDomains.add("front_desk");
    return accepted.some((m) => roleDomains.has(m));
  }

  function requireOperator(acceptedModules = ["leasing", "maintenance", "management"]) {
    return async function moveInOperatorGate(req, res, next) {
      try {
        const operator = await staffSessions.resolveStaffSession(pool, req.headers["x-staff-session"]);
        if (!operator) return res.status(401).json({ error: "NO_OPERATOR_SESSION", receipt: "No valid operator session. Sign in." });
        if (!moduleAllowed(operator, acceptedModules)) {
          return res.status(403).json({ error: "MODULE_NOT_AUTHORIZED", receipt: "Your current property assignment does not authorize this move-in action." });
        }
        req.operator = operator;
        return next();
      } catch (e) {
        console.error("move-in session resolution failed", e);
        return res.status(500).json({ error: "SESSION_RESOLUTION_FAILED", receipt: "The operator session could not be resolved." });
      }
    };
  }

  async function scopedLease(client, leaseId, propertyId, { forUpdate = false } = {}) {
    const q = await client.query(
      `select l.*, s.unit_id, u.unit_number, u.property_id as unit_property_id,
              (l.tenant_ids)[1] as primary_person_id
         from leases l
         join spaces s on s.id=l.space_id
         join units u on u.id=s.unit_id
        where l.id=$1
        ${forUpdate ? "for update of l" : ""}`,
      [leaseId]
    );
    const lease = q.rows[0] || null;
    if (!lease) throw httpError(404, "LEASE_NOT_FOUND", "Lease not found.");
    if (lease.property_id !== propertyId || lease.unit_property_id !== propertyId) {
      throw httpError(403, "LEASE_OUT_OF_SCOPE", "That lease is outside your property scope.");
    }
    return lease;
  }

  async function scopedReadinessObligation(client, obligationId, propertyId, { forUpdate = false } = {}) {
    const q = await client.query(
      `select * from obligations where id=$1 ${forUpdate ? "for update" : ""}`,
      [obligationId]
    );
    const obligation = q.rows[0] || null;
    if (!obligation) throw httpError(404, "OBLIGATION_NOT_FOUND", "Move-in readiness obligation not found.");
    if (obligation.property_id !== propertyId) throw httpError(403, "OBLIGATION_OUT_OF_SCOPE", "That obligation is outside your property scope.");
    if (obligation.module !== "movein" || obligation.type !== "readiness") {
      throw httpError(409, "NOT_READINESS_OBLIGATION", "That obligation is not a move-in readiness record.");
    }
    return obligation;
  }

  async function resolveApproverRole(client, propertyId) {
    const prop = await client.query("select accountable_assignment_id from properties where id=$1", [propertyId]);
    const assignmentId = prop.rows[0] && prop.rows[0].accountable_assignment_id;
    if (!assignmentId) return "property_manager";
    const assignment = await client.query("select role from assignments where id=$1 and is_active=true", [assignmentId]);
    const role = assignment.rows[0] && assignment.rows[0].role;
    const map = {
      property_manager: "property_manager", maintenance: "maintenance", leasing: "leasing_agent",
      bookkeeper: "accountant", asset_manager: "asset_manager", owner: "owner",
    };
    return map[role] || "property_manager";
  }

  async function processDue(client, { propertyId = null, windowDays = DEFAULT_WINDOW_DAYS }) {
    const days = Number.isFinite(Number(windowDays)) ? Number(windowDays) : DEFAULT_WINDOW_DAYS;
    const params = [days];
    let scope = "";
    if (propertyId) { params.push(propertyId); scope = ` and ue.property_id=$${params.length}`; }
    const due = await client.query(
      `select ue.*, u.unit_number
         from unit_events ue
         join units u on u.id=ue.unit_id
        where ue.event_type='move_in_scheduled'
          and ue.status='scheduled'
          and ue.effective_date <= current_date + ($1 || ' days')::interval
          ${scope}
        for update of ue`,
      params
    );
    const spawned = [];
    for (const event of due.rows) {
      const existing = await client.query(
        `select id from obligations
          where related_id=$1 and related_type='unit_event'
            and module='movein' and type='readiness'
            and status in ('open','in_progress','complete') limit 1`,
        [event.id]
      );
      if (existing.rows.length) {
        await client.query("update unit_events set status='actioned', spawned_obligation_id=coalesce(spawned_obligation_id,$1), updated_at=now() where id=$2", [existing.rows[0].id, event.id]);
        continue;
      }
      const approver = await resolveApproverRole(client, event.property_id);
      const obligation = await spawnObligationFromEvent(client, {
        property_id: event.property_id,
        unit_id: event.unit_id,
        source_event_id: null,
        related_id: event.id,
        related_type: "unit_event",
        module: "movein",
        type: "readiness",
        label: `Prepare unit for move-in${event.unit_number ? " — " + event.unit_number : ""}`,
        assigned_role: "maintenance",
        escalates_to_role: approver,
        status: "open",
        priority: "normal",
        severity: "normal",
        due_at: event.effective_date ? new Date(event.effective_date) : null,
        required_inputs: ALL_INPUTS,
      });
      await client.query("update unit_events set status='actioned', spawned_obligation_id=$1, updated_at=now() where id=$2", [obligation.id, event.id]);
      spawned.push({
        unit_event_id: event.id,
        unit_id: event.unit_id,
        unit_number: event.unit_number,
        move_in_date: event.effective_date,
        obligation_id: obligation.id,
        assigned_role: "maintenance",
        approver_role: approver,
      });
    }
    return { window_days: days, processed: spawned.length, spawned };
  }

  async function satisfyReadiness(client, { obligation, gate, proof, actorUserId = null, actorName = null }) {
    if (!OPERATIONAL_GATES.includes(gate)) {
      throw httpError(400, "BAD_READINESS_GATE", "gate must be one of the operational readiness gates.", { allowed: OPERATIONAL_GATES });
    }
    let idempotent = false;
    try {
      await satisfyObligation(client, {
        obligation_id: obligation.id,
        input: gate,
        proof: { ...(proof && typeof proof === "object" ? proof : {}), actor_user_id: actorUserId, actor_name: actorName, recorded_at: new Date().toISOString() },
      });
    } catch (e) {
      if (e.code === "NOT_OUTSTANDING") idempotent = true;
      else throw e;
    }
    const current = (await client.query("select required_inputs from obligations where id=$1", [obligation.id])).rows[0];
    const outstanding = current && Array.isArray(current.required_inputs) ? current.required_inputs : [];
    return {
      satisfied_gate: gate,
      idempotent,
      operational_gates_outstanding: OPERATIONAL_GATES.filter((g) => outstanding.includes(g)),
      ready_for_approval: OPERATIONAL_GATES.every((g) => !outstanding.includes(g)),
    };
  }

  async function approveReadiness(client, { obligation, operator, note = null }) {
    const outstanding = Array.isArray(obligation.required_inputs) ? obligation.required_inputs : [];
    const opsLeft = OPERATIONAL_GATES.filter((g) => outstanding.includes(g));
    if (opsLeft.length) {
      throw httpError(409, "READINESS_INCOMPLETE", "Unit readiness cannot be approved until maintenance completes the operational checks.", { operational_gates_outstanding: opsLeft });
    }
    try {
      await satisfyObligation(client, {
        obligation_id: obligation.id,
        input: APPROVAL_GATE,
        proof: { approved_by_user_id: operator.id, approved_by_name: operator.name, note, approved_at: new Date().toISOString() },
      });
    } catch (e) {
      if (e.code !== "NOT_OUTSTANDING") throw e;
    }
    try {
      await completeObligation(client, { obligation_id: obligation.id, completed_by: operator.id });
    } catch (e) {
      if (e.code !== "ALREADY_COMPLETE") throw e;
    }

    const eventLink = await client.query(
      `select coalesce(lease_id,(payload->>'lease_id')::uuid) as lease_id
         from unit_events
        where spawned_obligation_id=$1 and event_type='move_in_scheduled'
          and (lease_id is not null or payload->>'lease_id' is not null)
        limit 1`,
      [obligation.id]
    );
    const leaseId = eventLink.rows[0] && eventLink.rows[0].lease_id;
    let delivery = null;
    if (leaseId && deliveryHelper && typeof deliveryHelper.satisfyDeliveryInput === "function") {
      delivery = await deliveryHelper.satisfyDeliveryInput(client, {
        lease_id: leaseId,
        input_key: "unit_ready",
        source: "rent_ready_approval",
        source_obligation_id: obligation.id,
        actor: operator.id,
        timestamp: new Date().toISOString(),
        proof_extra: { actor_name: operator.name },
      });
    }
    await client.query(
      `insert into events (property_id, unit_id, type, note)
       values ($1,$2,'move_in_readiness_approved',$3)`,
      [obligation.property_id, obligation.unit_id,
       `Unit readiness approved by ${operator.name || operator.id}. This proves physical readiness only; it does not activate tenancy or record possession.`]
    );
    return {
      approved: true,
      readiness_obligation_id: obligation.id,
      approved_by_user_id: operator.id,
      unit_ready_fed_to_delivery: !!(delivery && delivery.satisfied),
      receipt: "Unit readiness approved. No tenancy or possession state changed.",
    };
  }

  // ── SESSION-AUTHENTICATED CANONICAL OPERATOR ROUTES ─────────────────────


  // PROPERTY SPINE MOVE-IN QUEUE ROUTE v1
  // One property-scoped read projection over composeMoveInState. This route
  // authors no move-in transition and accepts no browser-supplied property id.
  router.get("/operator/leasing/move-ins", requireOperator(["leasing", "management", "maintenance"]), async (req, res) => {
    res.set("Cache-Control", "no-store");
    const client = await pool.connect();
    try {
      await client.query("begin isolation level repeatable read read only");
      const result = await moveInQueue.readMoveInQueue(client, {
        propertyId: req.operator.property_id,
        windowDays: req.query && req.query.window_days,
        limit: req.query && req.query.limit,
        includeCompleted: String(req.query && req.query.include_completed || "").toLowerCase() === "true",
      });
      await client.query("commit");
      return res.json(result);
    } catch (e) {
      try { await client.query("rollback"); } catch (_) {}
      return sendError(res, e);
    } finally { client.release(); }
  });

  router.get("/operator/leasing/leases/:leaseId/move-in-state", requireOperator(["leasing", "management", "maintenance"]), async (req, res) => {
    res.set("Cache-Control", "no-store");
    const client = await pool.connect();
    try {
      await scopedLease(client, req.params.leaseId, req.operator.property_id);
      return res.json(await economicTenancy.composeMoveInState(client, req.params.leaseId));
    } catch (e) { return sendError(res, e); }
    finally { client.release(); }
  });

  router.post("/operator/leasing/leases/:leaseId/move-in-charges/confirm", requireOperator(["leasing", "management"]), async (req, res) => {
    res.set("Cache-Control", "no-store");
    const client = await pool.connect();
    try {
      await client.query("begin");
      await scopedLease(client, req.params.leaseId, req.operator.property_id, { forUpdate: true });
      const body = req.body || {};
      const result = await economicTenancy.confirmMoveInChargeSet(client, {
        lease_id: req.params.leaseId,
        first_period_amount: body.first_period_amount,
        first_period_start: body.first_period_start,
        first_period_end: body.first_period_end,
        required_fees: Object.prototype.hasOwnProperty.call(body, "required_fees") ? body.required_fees : null,
        confirmed_by_user_id: req.operator.id,
        calculation_note: body.calculation_note,
        idempotency_key: body.idempotency_key || req.get("idempotency-key") || null,
      });
      await client.query("commit");
      return res.json({
        receipt: "Move-in charge set confirmed from the governing lease. Charges are claims until payments are applied.",
        ...result,
      });
    } catch (e) { try { await client.query("rollback"); } catch (_) {} return sendError(res, e); }
    finally { client.release(); }
  });

  router.post("/operator/leasing/leases/:leaseId/activate-tenancy", requireOperator(["leasing", "management"]), async (req, res) => {
    res.set("Cache-Control", "no-store");
    const client = await pool.connect();
    try {
      await client.query("begin");
      await scopedLease(client, req.params.leaseId, req.operator.property_id, { forUpdate: true });
      const result = await economicTenancy.attemptEconomicTenancyActivation(client, {
        lease_id: req.params.leaseId,
        activated_by_user_id: req.operator.id,
        actor_name: req.operator.name,
        source: "operator_move_in",
      });
      await client.query("commit");
      return res.json(result);
    } catch (e) { try { await client.query("rollback"); } catch (_) {} return sendError(res, e); }
    finally { client.release(); }
  });

  router.post("/operator/leasing/move-ins/process-due", requireOperator(["leasing", "management", "maintenance"]), async (req, res) => {
    const client = await pool.connect();
    try {
      await client.query("begin");
      const result = await processDue(client, { propertyId: req.operator.property_id, windowDays: req.body && req.body.window_days });
      await client.query("commit");
      return res.json({ ...result, property_id: req.operator.property_id });
    } catch (e) { try { await client.query("rollback"); } catch (_) {} return sendError(res, e); }
    finally { client.release(); }
  });

  router.post("/operator/leasing/move-in-readiness/:obligationId/satisfy", requireOperator(["maintenance", "management"]), async (req, res) => {
    const client = await pool.connect();
    try {
      await client.query("begin");
      const obligation = await scopedReadinessObligation(client, req.params.obligationId, req.operator.property_id, { forUpdate: true });
      const result = await satisfyReadiness(client, {
        obligation,
        gate: req.body && req.body.gate,
        proof: req.body && req.body.proof,
        actorUserId: req.operator.id,
        actorName: req.operator.name,
      });
      await client.query("commit");
      return res.json(result);
    } catch (e) { try { await client.query("rollback"); } catch (_) {} return sendError(res, e); }
    finally { client.release(); }
  });

  router.post("/operator/leasing/move-in-readiness/:obligationId/approve", requireOperator(["management", "leasing"]), async (req, res) => {
    const client = await pool.connect();
    try {
      await client.query("begin");
      const obligation = await scopedReadinessObligation(client, req.params.obligationId, req.operator.property_id, { forUpdate: true });
      const result = await approveReadiness(client, { obligation, operator: req.operator, note: req.body && req.body.note });
      await client.query("commit");
      return res.json(result);
    } catch (e) { try { await client.query("rollback"); } catch (_) {} return sendError(res, e); }
    finally { client.release(); }
  });

  router.post("/operator/leasing/leases/:leaseId/delivery/keys-handed-over", requireOperator(["leasing", "management", "front_desk"]), async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!recordEffectivePossession || !deliveryHelper) {
      return res.status(503).json({ error: "MOVE_IN_SERVICES_NOT_WIRED", receipt: "Possession services are not wired on this deploy." });
    }
    const body = req.body || {};
    const recipientName = String(body.recipient_name || "").trim();
    const recipientType = String(body.recipient_type || "resident").trim();
    if (!recipientName) return res.status(400).json({ error: "RECIPIENT_REQUIRED", receipt: "recipient_name is required for the key handoff record." });
    if (!["resident", "authorized_representative"].includes(recipientType)) {
      return res.status(400).json({ error: "BAD_RECIPIENT_TYPE", receipt: "recipient_type must be resident or authorized_representative." });
    }
    const accessItems = Array.isArray(body.access_items) ? body.access_items.map((x) => String(x).trim()).filter(Boolean).slice(0, 25) : [];

    const client = await pool.connect();
    try {
      await client.query("begin");
      const lease = await scopedLease(client, req.params.leaseId, req.operator.property_id, { forUpdate: true });
      if (String(lease.lease_status).toLowerCase() !== "active") {
        throw httpError(409, "TENANCY_NOT_ACTIVE", "Keys cannot be handed over until economic tenancy is active.");
      }
      const today = (await client.query("select current_date::text as today")).rows[0].today;
      if (ymd(lease.start_date) > today) {
        throw httpError(409, "EARLY_POSSESSION_BLOCKED", "Keys cannot be handed over before the governing lease start date.", { lease_start_date: ymd(lease.start_date), today });
      }
      const funds = await economicTenancy.readMoveInFunds(client, lease.id);
      if (!funds.cleared) {
        throw httpError(409, "MOVE_IN_FUNDS_OUTSTANDING", "Keys cannot be handed over while required move-in funds are outstanding.", { funds });
      }
      const delivery = await deliveryHelper.findOpenDelivery(client, lease.id);
      if (!delivery) {
        const possession = await deliveryHelper.hasEffectivePossession(client, lease.id);
        if (possession) {
          await client.query("commit");
          return res.json({ idempotent: true, possession_event_id: possession.id, receipt: "Keys handoff was already recorded." });
        }
        throw httpError(409, "DELIVERY_OBLIGATION_MISSING", "No open move-in delivery obligation exists for this lease.");
      }
      const outstanding = Array.isArray(delivery.required_inputs) ? delivery.required_inputs : [];
      if (outstanding.includes("unit_ready") || outstanding.includes("keys_access_ready")) {
        throw httpError(409, "DELIVERY_NOT_READY", "Keys cannot be handed over until the unit and access preparation gates are complete.", { outstanding_inputs: outstanding });
      }

      const handoffAt = body.handed_over_at ? new Date(body.handed_over_at) : new Date();
      if (Number.isNaN(handoffAt.getTime())) throw httpError(400, "BAD_HANDOFF_TIME", "handed_over_at must be a valid timestamp when provided.");
      if (handoffAt > new Date(Date.now() + 5 * 60 * 1000)) throw httpError(400, "HANDOFF_IN_FUTURE", "The handoff time cannot be in the future.");
      if (ymd(handoffAt) < ymd(lease.start_date)) throw httpError(409, "EARLY_POSSESSION_BLOCKED", "The handoff time cannot precede the lease start date.");

      const possession = await recordEffectivePossession(client, {
        kind: "move_in",
        lease_id: lease.id,
        unit_id: lease.unit_id,
        property_id: lease.property_id,
        effective_date: ymd(handoffAt),
        actor: req.operator.id,
        source: "keys_handed_over",
        space_id_hint: lease.space_id,
        details: {
          actor_user_id: req.operator.id,
          actor_name: req.operator.name,
          recipient_name: recipientName,
          recipient_type: recipientType,
          handed_over_at: handoffAt.toISOString(),
          access_items: accessItems,
          note: body.note ? String(body.note).slice(0, 1000) : null,
        },
      });
      const completion = await deliveryHelper.completeDeliveryIfReady(client, { lease_id: lease.id, completed_by: req.operator.id });
      if (!completion.completed && !["already complete"].includes(completion.reason)) {
        throw httpError(409, "DELIVERY_NOT_COMPLETED", "Possession was recorded, but the delivery obligation could not complete.", { delivery: completion });
      }
      await client.query("commit");
      return res.json({
        receipt: `Keys/access handed to ${recipientName}. Physical possession recorded; economic tenancy was already active.`,
        possession_event_id: possession.event.id,
        possession_idempotent: possession.idempotent === true,
        delivery_obligation_id: completion.obligation_id,
        delivery_completed: completion.completed === true || completion.reason === "already complete",
        actor_user_id: req.operator.id,
        recipient: { name: recipientName, type: recipientType },
      });
    } catch (e) { try { await client.query("rollback"); } catch (_) {} return sendError(res, e); }
    finally { client.release(); }
  });

  // ── LEGACY/OPERATIONS ROUTES ────────────────────────────────────────────
  // Kept for existing external operations. The old body-authored approval is
  // tombstoned because it conflated readiness with possession and identity.

  router.post("/units/:id/schedule-move-in", async (req, res) => {
    const { move_in_date, tenant_name = null, lease_id = null, rent = null } = req.body || {};
    if (!move_in_date) return res.status(400).json({ error: "move_in_date is required (YYYY-MM-DD)" });
    const client = await pool.connect();
    try {
      await client.query("begin");
      const unit = (await client.query("select id, property_id, unit_number from units where id=$1", [req.params.id])).rows[0];
      if (!unit) throw httpError(404, "UNIT_NOT_FOUND", "Unit not found.");
      const duplicate = await client.query(
        `select id from unit_events where unit_id=$1 and event_type='move_in_scheduled' and status='scheduled' limit 1`,
        [unit.id]
      );
      if (duplicate.rows.length) throw httpError(409, "MOVE_IN_ALREADY_SCHEDULED", "This unit already has a scheduled move-in.", { unit_event_id: duplicate.rows[0].id });
      const payload = { ...(tenant_name ? { tenant_name } : {}), ...(lease_id ? { lease_id } : {}), ...(rent != null ? { rent } : {}) };
      const row = (await client.query(
        `insert into unit_events (unit_id,property_id,event_type,effective_date,payload,source,status,lease_id)
         values ($1,$2,'move_in_scheduled',$3,$4,'manual','scheduled',$5) returning *`,
        [unit.id, unit.property_id, move_in_date, JSON.stringify(payload), lease_id]
      )).rows[0];
      await client.query("commit");
      return res.status(201).json({ unit_event: row, note: "Move-in scheduled. Readiness work spawns when it enters the operating window." });
    } catch (e) { try { await client.query("rollback"); } catch (_) {} return sendError(res, e); }
    finally { client.release(); }
  });

  router.post("/unit-events/process-due", async (req, res) => {
    const client = await pool.connect();
    try {
      await client.query("begin");
      const result = await processDue(client, { propertyId: req.body && req.body.property_id || null, windowDays: req.body && req.body.window_days });
      await client.query("commit");
      return res.json(result);
    } catch (e) { try { await client.query("rollback"); } catch (_) {} return sendError(res, e); }
    finally { client.release(); }
  });

  router.post("/movein/:obligationId/satisfy", async (req, res) => {
    const client = await pool.connect();
    try {
      await client.query("begin");
      const obligation = (await client.query("select * from obligations where id=$1 for update", [req.params.obligationId])).rows[0];
      if (!obligation) throw httpError(404, "OBLIGATION_NOT_FOUND", "Move-in readiness obligation not found.");
      const result = await satisfyReadiness(client, { obligation, gate: req.body && req.body.gate, proof: req.body && req.body.proof });
      await client.query("commit");
      return res.json(result);
    } catch (e) { try { await client.query("rollback"); } catch (_) {} return sendError(res, e); }
    finally { client.release(); }
  });

  router.post("/movein/:obligationId/approve", (_req, res) => res.status(410).json({
    error: "LEGACY_MOVE_IN_APPROVAL_RETIRED",
    receipt: "This route was retired because it accepted a body-supplied actor and conflated readiness with possession. Use the session-authenticated readiness approval and Keys Handed Over actions.",
    replacements: {
      readiness: "/operator/leasing/move-in-readiness/:obligationId/approve",
      possession: "/operator/leasing/leases/:leaseId/delivery/keys-handed-over",
    },
  }));

  router.get("/move-ins", async (req, res) => {
    try {
      const values = [];
      const where = ["ue.event_type='move_in_scheduled'"];
      if (req.query.property_id) { values.push(req.query.property_id); where.push(`ue.property_id=$${values.length}`); }
      const rows = (await pool.query(
        `select ue.*, u.unit_number, o.id as obligation_id, o.status as obligation_status,
                o.required_inputs as obligation_outstanding, o.assigned_role, o.escalates_to_role
           from unit_events ue
           join units u on u.id=ue.unit_id
           left join obligations o on o.id=ue.spawned_obligation_id
          where ${where.join(" and ")}
          order by ue.effective_date`, values
      )).rows;
      return res.json({
        count: rows.length,
        move_ins: rows.map((row) => ({
          unit_event_id: row.id,
          unit_id: row.unit_id,
          unit_number: row.unit_number,
          property_id: row.property_id,
          lease_id: row.lease_id || (row.payload && row.payload.lease_id) || null,
          move_in_date: row.effective_date,
          event_status: row.status,
          obligation_id: row.obligation_id,
          obligation_status: row.obligation_status,
          accountable_role: row.escalates_to_role,
          operational_gates_outstanding: OPERATIONAL_GATES.filter((g) => (row.obligation_outstanding || []).includes(g)),
          awaiting_readiness_approval: !!row.obligation_id && OPERATIONAL_GATES.every((g) => !(row.obligation_outstanding || []).includes(g)) && (row.obligation_outstanding || []).includes(APPROVAL_GATE),
        })),
      });
    } catch (e) { return sendError(res, e); }
  });

  return router;
};
