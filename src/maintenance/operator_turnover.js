// Authenticated, property-scoped move-out door. The transaction itself lives
// in turnover_service so this route and the legacy operator-key adapter cannot
// create competing turnover semantics.

"use strict";

module.exports = function operatorTurnover(deps) {
  const express = require("express");
  const staffSessions = require("../identity/staff_session_service");
  const router = express.Router();
  const { pool, turnoverService } = deps || {};

  if (!pool) throw new Error("operator_turnover requires a pool");
  if (!turnoverService || typeof turnoverService.openTurnover !== "function") {
    throw new Error("operator_turnover requires the canonical turnoverService");
  }

  async function requireOperator(req, res, next) {
    try {
      const operator = await staffSessions.resolveStaffSession(pool, req.headers["x-staff-session"]);
      if (!operator) return res.status(401).json({ error: "No valid operator session. Sign in." });
      req.operator = operator;
      return next();
    } catch (_) {
      return res.status(500).json({ error: "session resolution failed" });
    }
  }

  function requireManagement(req, res, next) {
    const modules = (req.operator && req.operator.allowed_modules) || [];
    if (!modules.includes("management")) {
      return res.status(403).json({
        error: "management module access is required to confirm move-out and end possession.",
      });
    }
    return next();
  }

  function refuseClientAuthority(req, res, next) {
    const claimed = (req.body && req.body.property_id) || (req.query && req.query.property_id) || null;
    if (claimed && String(claimed) !== String(req.operator.property_id)) {
      return res.status(403).json({
        error: "property authority is server-derived; property_id cannot select another property.",
        acting_on: req.operator.property_id,
      });
    }
    return next();
  }

  router.post(
    "/operator/units/:unitId/move-out",
    requireOperator,
    requireManagement,
    refuseClientAuthority,
    async (req, res) => {
      const body = req.body || {};
      const client = await pool.connect();
      try {
        await client.query("begin");
        const out = await turnoverService.openTurnover(client, {
          property_id: req.operator.property_id,
          unit_id: req.params.unitId,
          outgoing_lease_id: body.outgoing_lease_id || null,
          needs: body.needs == null ? [] : body.needs,
          expected_ready_date: body.expected_ready_date || null,
          actor_user_id: req.operator.id,
        });
        await client.query("commit");
        return res.status(201).json({
          ...out,
          authority: {
            actor_user_id: req.operator.id,
            property_id: req.operator.property_id,
            basis: "active staff session with management module access",
          },
        });
      } catch (error) {
        await client.query("rollback").catch(() => {});
        return res.status(error.httpStatus || 500).json({
          error: error.message,
          code: error.code || null,
          turnover_id: error.turnover_id || null,
        });
      } finally {
        client.release();
      }
    }
  );

  return router;
};
