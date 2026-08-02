// ════════════════════════════════════════════════════════════════════
//  operator_obligations.js — THE AUTHENTICATED OBLIGATIONS DOOR
//
//  Replaces `GET /obligations`, which was protected only by the
//  portfolio-wide shared operator key while taking its property scope
//  from the query string — so any key holder could omit or change
//  property_id and read across every property.
//
//  Here property, modules and actor all come from the resolved staff
//  session. The browser may express a preference (status); it may not
//  supply authority.
//
//  DOORS DELIBERATELY NOT BUILT. The audit found `GET /obligations/:id`
//  had no caller at all, and `satisfy`/`complete` had no product caller.
//  Rebuilding them behind a new URL would preserve attack surface for
//  workflows that do not exist. Their canonical SERVICES are untouched;
//  only the exposed HTTP doors are gone. Add a door when a real workflow
//  needs one.
//
//  CLASS 2 (permanent).
// ════════════════════════════════════════════════════════════════════

"use strict";

module.exports = function operatorObligations(deps) {
  const express = require("express");
  const router = express.Router();
  const staffSessions = require("../identity/staff_session_service");
  const service = require("./operator_obligations_service");

  const { pool } = deps || {};
  if (!pool) throw new Error("operator_obligations requires a pool");

  async function requireOperator(req, res, next) {
    try {
      const op = await staffSessions.resolveStaffSession(pool, req.headers["x-staff-session"]);
      if (!op) return res.status(401).json({ error: "No valid operator session. Sign in." });
      req.operator = op; next();
    } catch (e) { return res.status(500).json({ error: "session resolution failed" }); }
  }

  //  §21. A client-supplied property is REFUSED rather than ignored, so a
  //  caller cannot believe it chose the scope. Module inputs are ignored
  //  outright — there is no legitimate reason to send one, and refusing
  //  would turn a harmless stray parameter into an error.
  function refuseClientAuthority(req, res, next) {
    const claimed = (req.query && req.query.property_id) || (req.body && req.body.property_id) || null;
    if (claimed && String(claimed) !== String(req.operator.property_id)) {
      return res.status(403).json({
        error: "property authority is server-derived; a client-supplied property_id cannot select a different property.",
        acting_on: req.operator.property_id,
      });
    }
    return next();
  }

  const gate = [requireOperator, refuseClientAuthority];

  // ── the scoped collection read ────────────────────────────────────
  router.get("/operator/obligations", ...gate, async (req, res) => {
    try {
      const out = await service.list(pool, {
        property_id: req.operator.property_id,        // session, never the request
        allowed_modules: req.operator.allowed_modules, // session, never the request
        status: req.query && req.query.status,        // preference only
      });

      return res.json({
        items: out.items,
        total: out.total,
        scope: {
          property_id: req.operator.property_id,
          modules: req.operator.allowed_modules || [],
        },
        ...(out.scope_note ? { scope_note: out.scope_note } : {}),
      });
    } catch (e) {
      //  A failure must never reach the browser shaped like an empty
      //  result — that is the false green this whole lane exists to stop.
      console.error("operator/obligations error", e);
      return res.status(500).json({ error: "Could not read this property's open work." });
    }
  });

  return router;
};
