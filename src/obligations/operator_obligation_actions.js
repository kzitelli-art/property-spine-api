// ════════════════════════════════════════════════════════════════════
//  operator_obligation_actions.js — AUTHENTICATED OBLIGATION ACTIONS
//
//  ONE action: self-claim.
//
//  WHAT THIS REPLACES. `PATCH /obligations/:id/claim` took the claiming
//  `user_id` FROM THE REQUEST BODY, behind the portfolio-wide shared key,
//  with no property check. The browser supplied it from a text field
//  persisted in localStorage. A key holder could therefore claim any
//  obligation, on any property, AS ANY USER.
//
//  SELF-CLAIM ONLY, DELIBERATELY. The audit found no server-side
//  work-assignment capability: `can_manage_roles` governs role
//  administration, and `reassignObligation` reassigns by ROLE and is used
//  internally by money.js — neither is an operator delegation authority.
//  Rebuilding "send any user id" behind a new URL would recreate the
//  defect with better manners. Manager delegation waits for its actual
//  workflow and authority contract.
//
//  DOORS DELIBERATELY NOT BUILT: satisfy and complete. Neither had a
//  product caller. Their canonical services — satisfyObligation and
//  completeObligation, with required-input and conversion-rail
//  enforcement — are untouched and still proven directly. Only the
//  exposed HTTP doors are gone.
//
//  CLASS 2 (permanent).
// ════════════════════════════════════════════════════════════════════

"use strict";

module.exports = function operatorObligationActions(deps) {
  const express = require("express");
  const router = express.Router();
  const staffSessions = require("../identity/staff_session_service");

  const { pool } = deps || {};
  if (!pool) throw new Error("operator_obligation_actions requires a pool");

  async function requireOperator(req, res, next) {
    try {
      const op = await staffSessions.resolveStaffSession(pool, req.headers["x-staff-session"]);
      if (!op) return res.status(401).json({ error: "No valid operator session. Sign in." });
      req.operator = op; next();
    } catch (e) { return res.status(500).json({ error: "session resolution failed" }); }
  }

  //  A client-supplied actor is REFUSED, not ignored. Ignoring it would let
  //  a caller believe it had assigned work to someone else.
  function refuseClientActor(req, res, next) {
    const b = req.body || {}, q = req.query || {};
    const claimedUser = b.user_id || q.user_id || b.assigned_user_id || q.assigned_user_id;
    if (claimedUser && String(claimedUser) !== String(req.operator.id)) {
      return res.status(403).json({
        error: "the claimant is the authenticated staff member; a client-supplied user_id cannot claim on someone else's behalf.",
        acting_as: req.operator.id,
      });
    }
    const claimedProperty = b.property_id || q.property_id;
    if (claimedProperty && String(claimedProperty) !== String(req.operator.property_id)) {
      return res.status(403).json({
        error: "property authority is server-derived; a client-supplied property_id cannot select a different property.",
        acting_on: req.operator.property_id,
      });
    }
    return next();
  }

  const gate = [requireOperator, refuseClientActor];

  // ── SELF-CLAIM ────────────────────────────────────────────────────
  //  POST, not PATCH: the app's live write seam (WRITE_ACTIONS) is a set of
  //  named, hardwired POST verbs. Matching that convention keeps the browser
  //  on its existing audited channel instead of widening the loader. The
  //  authority rules are unchanged either way.
  router.post("/operator/obligations/:id/claim", ...gate, async (req, res) => {
    const client = await pool.connect();
    try {
      await client.query("begin");

      //  Scope and lock in one statement: an obligation outside the
      //  session's property or module set is NOT FOUND, not FORBIDDEN —
      //  a scoped caller must not be able to probe for existence.
      const o = (await client.query(
        `select id, property_id, module, status, assigned_user_id
           from obligations
          where id = $1 and property_id = $2 and module = any($3::text[])
          for update`,
        [req.params.id, req.operator.property_id, req.operator.allowed_modules || []]
      )).rows[0];

      if (!o) {
        await client.query("rollback");
        return res.status(404).json({ error: "obligation not found" });
      }

      //  Preserved from the legacy route: do not silently steal work.
      //  Re-claiming your own is a no-op, not a conflict.
      if (o.assigned_user_id && String(o.assigned_user_id) !== String(req.operator.id)) {
        await client.query("rollback");
        return res.status(409).json({
          error: "already claimed by another user",
          assigned_user_id: o.assigned_user_id,
        });
      }

      const updated = (await client.query(
        `update obligations
            set assigned_user_id = $1,
                status = case when status = 'open' then 'in_progress' else status end,
                updated_at = now()
          where id = $2
        returning id, property_id, module, type, label, status, due_at,
                  assigned_user_id, assigned_role, person_id, unit_id,
                  related_type, related_id, created_at, updated_at`,
        [req.operator.id, o.id]          // the SESSION user, never the request
      )).rows[0];

      await client.query("commit");
      return res.json({ obligation: updated, claimed_by: req.operator.id, receipt: "Claimed." });
    } catch (e) {
      try { await client.query("rollback"); } catch (_) {}
      console.error("operator/obligations/claim error", e);
      return res.status(500).json({ error: "Could not claim that work." });
    } finally {
      client.release();
    }
  });

  return router;
};
