// ════════════════════════════════════════════════════════════════════
//  readiness.js — FINAL READINESS WALK AND CERTIFICATION: OPERATOR DOOR
//
//  BUILD 4. Same authority seam as every other maintenance door. ONE door,
//  no ungated twin.
//
//  A SUCCESSFUL certification is QUIET: it returns a receipt and spawns no
//  manager obligation. Management visibility is required only when the walk
//  fails, authority is unavailable, a certification is corrected or revoked, a
//  near-term move-in is exposed, or another availability blocker needs
//  judgment.
// ════════════════════════════════════════════════════════════════════

"use strict";

module.exports = function readiness(deps) {
  const express = require("express");
  const router = express.Router();
  const staffSessions = require("../identity/staff_session_service");
  const { CONFIRMATION_AREAS } = require("./readiness_gate");
  const { availabilityRead } = require("../surfaces/availability_read");

  const { pool, readinessService } = deps || {};
  if (!pool) throw new Error("readiness module requires a pool");
  if (!readinessService || typeof readinessService.recordWalk !== "function") {
    throw new Error(
      "readiness module requires readinessService (build it with " +
      "makeReadinessService({ spawnObligationFromEvent, workAcceptanceService }) and inject it)"
    );
  }

  async function requireOperator(req, res, next) {
    try {
      const op = await staffSessions.resolveStaffSession(pool, req.headers["x-staff-session"]);
      if (!op) return res.status(401).json({ error: "No valid operator session. Sign in." });
      req.operator = op; next();
    } catch (e) { return res.status(500).json({ error: "session resolution failed" }); }
  }
  function requireMaintenanceModuleAccess(req, res, next) {
    const mods = (req.operator && req.operator.allowed_modules) || [];
    if (!mods.includes("maintenance") && !mods.includes("management")) {
      return res.status(403).json({
        error: "maintenance or management module access required at this property.",
      });
    }
    return next();
  }
  function refuseClientProperty(req, res, next) {
    const claimed = (req.body && req.body.property_id) || (req.query && req.query.property_id) || null;
    if (claimed && String(claimed) !== String(req.operator.property_id)) {
      return res.status(403).json({
        error: "property authority is server-derived; a client-supplied property_id cannot select a different property.",
        acting_on: req.operator.property_id,
      });
    }
    return next();
  }
  const operatorGate = [requireOperator, requireMaintenanceModuleAccess, refuseClientProperty];

  //  Marketability AFTER certification, read from the canonical availability
  //  surface rather than recomputed here. A second copy is how a read and a
  //  write come to disagree.
  async function marketabilityFor(property_id, unit_id) {
    try {
      const av = await availabilityRead(pool, { property_id });
      const rows = (av.rows || []).filter((r) => String(r.unit_id) === String(unit_id));
      if (!rows.length) return null;
      const r = rows[0];
      return {
        marketing_state: r.marketing_state,
        blocking_reason: r.blocking_reason,
        blocking_label: r.blocking_label,
        marketable_now: r.marketing_state === "marketable_now",
      };
    } catch (e) { return { error: "availability read failed", detail: e.message }; }
  }

  // ── QUEUE — GET /operator/readiness/queue ─────────────────────────
  router.get("/operator/readiness/queue", ...operatorGate, async (req, res) => {
    try {
      const units = (await pool.query(
        `select distinct u.id, u.unit_number from units u
          where u.property_id=$1 and exists (select 1 from unit_turn_scopes s where s.unit_id=u.id)
          order by u.unit_number asc`, [req.operator.property_id])).rows;
      const actionable = [], blocked = [], certified = [];
      for (const u of units) {
        const st = await readinessService.readGateState(pool, { unit_id: u.id });
        const row = {
          unit_id: u.id, unit_number: u.unit_number,
          controlling_blocker: st.gate.controlling_blocker,
          blockers: st.gate.blockers,
          certification: st.certification ? {
            id: st.certification.id, certified_at: st.certification.certified_at,
            certified_by_user_id: st.certification.certified_by_user_id,
          } : null,
        };
        if (st.certification) certified.push(row);
        else if (st.gate.actionable) actionable.push(row);
        else blocked.push(row);
      }
      res.json({
        property_id: req.operator.property_id,
        actionable_count: actionable.length,
        actionable, blocked, certified,
        meaning: "Actionable means a human may now walk the unit. It is NOT readiness.",
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── GATE — GET /operator/units/:id/readiness ──────────────────────
  router.get("/operator/units/:id/readiness", ...operatorGate, async (req, res) => {
    try {
      const u = (await pool.query(
        "select id, unit_number, property_id from units where id=$1", [req.params.id])).rows[0];
      if (!u) return res.status(404).json({ error: "unit not found" });
      if (String(u.property_id) !== String(req.operator.property_id)) {
        return res.status(403).json({ error: "that unit is not at the property you are operating" });
      }
      const st = await readinessService.readGateState(pool, { unit_id: u.id });
      const auth = await readinessService.resolveWalkAuthority(pool,
        { property_id: u.property_id, user_id: req.operator.id });
      const senior = await readinessService.resolveSeniorAccountable(pool, { property_id: u.property_id });
      const moveIn = await readinessService.nextCommittedMoveIn(pool, { unit_id: u.id });
      res.json({
        unit: { id: u.id, unit_number: u.unit_number },
        gate: st.gate, certification: st.certification,
        confirmation_areas: CONFIRMATION_AREAS,
        your_authority: auth,
        senior_accountable: senior,
        next_move_in: moveIn,
        marketability: st.certification ? await marketabilityFor(u.property_id, u.id) : null,
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── WALK — POST /operator/units/:id/readiness/walk ────────────────
  router.post("/operator/units/:id/readiness/walk", ...operatorGate, async (req, res) => {
    const b = req.body || {};
    const client = await pool.connect();
    let out;
    try {
      await client.query("begin");
      out = await readinessService.recordWalk(client, {
        property_id: req.operator.property_id,
        unit_id: req.params.id,
        actor_user_id: req.operator.id,
        outcome: b.outcome,
        confirmations: b.confirmations || {},
        note: b.note || null,
        photos: Array.isArray(b.photos) ? b.photos : [],
        findings_text: b.findings_text || "",
        reopen_work: Array.isArray(b.reopen_work) ? b.reopen_work : [],
        reclean_ruling: b.reclean_ruling || null,
      });
      await client.query("commit");
    } catch (e) {
      try { await client.query("rollback"); } catch (_) {}
      return res.status(e.httpStatus || 500).json({
        error: e.message,
        ...(e.blockers ? { blockers: e.blockers } : {}),
        ...(e.missing ? { missing_confirmations: e.missing } : {}),
      });
    } finally { client.release(); }

    if (out.outcome === "ready") {
      const mk = await marketabilityFor(req.operator.property_id, req.params.id);
      return res.status(201).json({
        certified: true,
        receipt: {
          headline: `Unit ${(out.walk && out.walk.unit_id) ? "" : ""}certified physically ready`.replace("  ", " "),
          certified_by: out.certification.certified_by_user_id,
          walked_by: out.certification.walked_by_user_id,
          walked_by_differs: String(out.certification.walked_by_user_id) !== String(out.certification.certified_by_user_id),
          senior_accountable: out.senior_accountable.user_id || "UNRESOLVED",
          senior_accountable_basis: out.senior_accountable.basis,
          time: out.certification.certified_at,
          next_move_in: out.next_move_in ? out.next_move_in.move_in_date : null,
          // The distinction the ruling requires, stated whichever way it falls.
          marketability: mk ? mk.marketing_state : "unavailable",
          remaining_blocker: mk && !mk.marketable_now ? mk.blocking_label : null,
          summary: mk && mk.marketable_now
            ? "Physically ready and currently marketable."
            : `Physically ready but NOT currently marketable. Reason: ${mk ? mk.blocking_label : "availability read failed"}.`,
          meaning: out.meaning,
        },
        certification: out.certification, walk: out.walk,
        marketability: mk, authority: out.authority,
      });
    }

    const c = out.flow.controlling_next_action;
    return res.status(201).json({
      certified: false,
      receipt: {
        headline: "Final walk failed — unit is not ready",
        what_was_found: out.new_findings.map((f) => f.finding_text),
        new_work: out.new_work.map((w) => `${w.work_text} (${w.stage})`),
        reopened_work: out.reopened_work.map((r) => r.work_text),
        original_claims_preserved: out.reopened_work.every((r) => r.preserved_claim_id !== undefined),
        recleaning: out.reclean
          ? (out.reclean.reclean_required
              ? "Final cleaning reopened — corrective work disturbs the cleaned condition."
              : `Recleaning ruled unnecessary: ${out.reclean.reason}`)
          : null,
        controlling_next_action: c ? c.action : null,
        move_in_risk: out.next_move_in
          ? `${out.next_move_in.move_in_date} — ${out.next_move_in.days_remaining} days remaining`
          : null,
        accountable_owner: out.move_in_obligation
          ? (out.move_in_obligation.assigned_user_id || "UNASSIGNED") : null,
        meaning: out.meaning,
      },
      walk: out.walk, new_findings: out.new_findings, new_work: out.new_work,
      reopened_work: out.reopened_work, reclean: out.reclean,
      gate: out.gate, flow: out.flow, next_move_in: out.next_move_in,
      move_in_obligation: out.move_in_obligation,
    });
  });

  // ── CORRECT / REVOKE — POST /operator/readiness/:certId/correct ───
  router.post("/operator/readiness/:certId/correct", ...operatorGate, async (req, res) => {
    const b = req.body || {};
    const client = await pool.connect();
    let out;
    try {
      await client.query("begin");
      out = await readinessService.correctCertification(client, {
        certification_id: req.params.certId,
        property_id: req.operator.property_id,
        actor_user_id: req.operator.id,
        new_state: b.new_state,
        reason: b.reason,
      });
      await client.query("commit");
    } catch (e) {
      try { await client.query("rollback"); } catch (_) {}
      return res.status(e.httpStatus || 500).json({ error: e.message });
    } finally { client.release(); }

    const mk = await marketabilityFor(req.operator.property_id, out.original.unit_id);
    res.status(201).json({
      corrected: true,
      receipt: {
        headline: `Readiness ${out.correction.state}`,
        original_certification_preserved: true,
        original_certified_at: out.original.certified_at,
        corrected_by: out.correction.certified_by_user_id,
        reason: out.correction.correction_reason,
        current_readiness: out.current_readiness,
        reinspection_owner: out.obligation
          ? (out.obligation.assigned_user_id || "UNASSIGNED") : null,
        marketability: mk ? mk.marketing_state : null,
        note: out.note,
      },
      original: out.original, correction: out.correction,
      obligation: out.obligation, marketability: mk,
    });
  });

  return router;
};
