// ════════════════════════════════════════════════════════════════════
//  operator_properties.js — PHASE ZERO: THE REAL PROPERTY BOUNDARY
//
//  Two routes, both requiring an already-resolved staff session:
//
//    GET  /operator/properties          which properties may I operate?
//    POST /operator/properties/select   issue me a session for THIS one
//
//  Together they turn "the app has an implicit default property" into
//  "the operator chooses among properties the server says they hold, and
//  the server issues the scope."
//
//  ── THE ONE PLACE IN THIS REPO WHERE A BODY property_id IS LEGITIMATE ─
//  Everywhere else, a client-supplied property_id is refused outright —
//  ask_spine.js returns 403 rather than ignoring it, and operator.js has
//  "no free :propertyId route" as a hard rule. Those rules exist because a
//  browser-supplied property must never SELECT SCOPE for a read.
//
//  This route is a different kind of thing and the difference has to be
//  written down, or the next person reads it as a violation of §21 and
//  either copies it somewhere it does not belong or deletes it:
//
//      A READ takes its property from the session, because the session IS
//      the scope. THIS route is how a scope comes to exist. The property
//      here is a REQUEST — "please issue me a session for this one" — and
//      it is granted only by issueStaffSession re-reading
//      property_team_assignments. The browser proposes; the server grants.
//
//  The distinction is not stylistic. It is the difference between
//  "the browser picked which property's data to show" (forbidden) and
//  "the browser asked for a scope the server then verified" (the product).
//
//  ── PRESENCE IN THE LIST IS NOT PERMISSION ──────────────────────────
//  The select route does NOT check the requested property against the
//  list read above. That would be a second authority, and two authorities
//  drift. issueStaffSession already reads the assignment FOR SHARE and
//  refuses with "No active access to this property." A property that was
//  revoked between the list render and the click is refused at the mint —
//  which is exactly the behaviour we want, and would be lost if this route
//  pre-validated against a list it fetched a moment earlier.
//
//  ── SWITCHING IS MINTING ────────────────────────────────────────────
//  staff_sessions.property_id is one column. A session is bound to one
//  property, and Phase Zero does not change that. So "switch property"
//  is "issue a new session", and the old one is revoked so a tab cannot
//  keep operating the previous property with a token it still holds.
//
//  Mint-then-revoke, in that order, in one transaction: if the mint fails
//  the operator keeps the session they had, rather than being signed out
//  by a failed switch.
//
//  CLASSIFICATION: Class 1 — permanent product primitive. Nothing here is
//  a bridge and nothing retires.
// ════════════════════════════════════════════════════════════════════

"use strict";

const express = require("express");
const staffSessions = require("./staff_session_service.js");
const { listAuthorizedProperties } = require("./authorized_properties.js");

module.exports = function operatorProperties({ pool }) {
  const router = express.Router();
  if (!pool) throw new Error("operator_properties requires a pool");

  //  Same gate shape as every other /operator/* surface. The session is the
  //  only thing that establishes who is asking.
  async function requireOperator(req, res, next) {
    try {
      const op = await staffSessions.resolveStaffSession(pool, req.get("x-staff-session"));
      if (!op) return res.status(401).json({ error: "No valid operator session. Sign in." });
      req.operator = op;
      return next();
    } catch (e) {
      //  Unavailable must never collapse into permitted.
      return res.status(500).json({ error: "session resolution failed" });
    }
  }

  // ══════════════════════════════════════════════════════════════════
  //  GET /operator/properties
  //
  //  The properties this operator may operate, from their own session.
  //  The browser names no user and no property; both come from the token.
  //
  //  `active_property_id` is echoed so the picker can mark the current one
  //  without holding its own idea of what is active. The server says which
  //  property the caller is presently scoped to; the browser renders it.
  // ══════════════════════════════════════════════════════════════════
  router.get("/operator/properties", requireOperator, async (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      const properties = await listAuthorizedProperties(pool, { user_id: req.operator.id });
      return res.json({
        active_property_id: req.operator.property_id,   // from the session, never the request
        count: properties.length,
        properties,
      });
    } catch (e) {
      //  A failed read is a failure. It must never arrive shaped like
      //  "you have no properties" — that would read as a revoked account.
      console.error("operator/properties error", e);
      return res.status(500).json({ error: "Could not read your authorized properties." });
    }
  });

  // ══════════════════════════════════════════════════════════════════
  //  POST /operator/properties/select   { property_id }
  //
  //  Issue a session bound to the requested property, if — and only if —
  //  the authenticated user holds an active assignment to it.
  //
  //  Returns the same grant shape as POST /operator/session so the browser
  //  has one way to accept a session, not two.
  // ══════════════════════════════════════════════════════════════════
  router.post("/operator/properties/select", requireOperator, async (req, res) => {
    res.set("Cache-Control", "no-store");

    const requested = req.body && req.body.property_id;
    if (!requested || typeof requested !== "string") {
      return res.status(400).json({
        error: "property_id is required.",
        receipt: "Choose a property to open.",
      });
    }

    //  A malformed id is a bad request, not a refusal — refusing it as
    //  "no access" would tell an operator their assignment was removed.
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(requested)) {
      return res.status(400).json({
        error: "property_id is not a valid identifier.",
        receipt: "That property could not be opened.",
      });
    }

    //  Already there. Minting a second session for the same property would
    //  churn tokens on every re-click of the active chip.
    //
    //  No property name here: resolveStaffSession does not return one, and
    //  inventing a lookup to fill the field would be a second source for a
    //  string the caller already has. `unchanged` is the whole answer.
    if (String(requested) === String(req.operator.property_id)) {
      return res.status(200).json({
        ok: true,
        unchanged: true,
        property: { id: req.operator.property_id },
        receipt: "Already open.",
      });
    }

    const client = await pool.connect();
    try {
      await client.query("begin");

      //  CARRY THE ISSUANCE PURPOSE FORWARD, do not re-label the session.
      //
      //  ISSUANCE_POLICY sets TTL per purpose: sms_otp is 14 days,
      //  bootstrap_invite is 12 hours. Someone who signed in by SMS and then
      //  switched property would have had their session silently shortened
      //  from two weeks to half a day — a real regression, invisible until
      //  an operator is logged out mid-shift and nobody can say why.
      //
      //  A switch is a continuation of the session the operator already
      //  holds, so it keeps that session's purpose and therefore its policy.
      //  Legacy raw-token rows carry no purpose (migration 070 added it) and
      //  fall back to the operator-initiated default.
      const prior = (await client.query(
        `select issuance_purpose from staff_sessions where id = $1`,
        [req.operator.session_id]
      )).rows[0];
      const purpose = (prior && prior.issuance_purpose) || "bootstrap_invite";

      //  THE AUTHORITY. issueStaffSession re-reads the users row and the
      //  (user, property) assignment FOR SHARE and throws 403 when there is
      //  no active access. Nothing above this line grants anything.
      //
      //  Phase Zero deliberately adds no new issuance purpose. The
      //  vocabulary is constrained by the CHECK added in migration 070
      //  (demo | bootstrap_invite | sms_otp), and a new value would be a
      //  migration — this slice ships none.
      let issued;
      try {
        issued = await staffSessions.issueStaffSession(client, {
          userId: req.operator.id,
          propertyId: requested,
          purpose,
        });
      } catch (e) {
        await client.query("rollback");
        //  ONE refusal shape for "not yours", whether the assignment is
        //  absent, inactive, or the property does not exist. Distinguishing
        //  them would let a caller probe which properties exist.
        //
        //  issueStaffSession throws svcErr → e.httpStatus. A 403 is the
        //  refusal we expect and re-say in the operator's language; a 500
        //  (unknown purpose, missing argument) is our bug, not their access,
        //  and must not be dressed up as a permission answer.
        if (e && e.httpStatus && e.httpStatus !== 403) {
          console.error("operator/properties/select issue error", e);
          return res.status(500).json({ error: "Could not open that property." });
        }
        return res.status(403).json({
          error: "no_access_to_property",
          receipt: "You do not have access to that property.",
        });
      }

      //  The previous session ends only once the new one exists. Revoking
      //  first would sign an operator out on a failed switch.
      await client.query(
        `update staff_sessions set revoked = true
          where id = $1 and revoked = false`,
        [req.operator.session_id]
      );

      await client.query("commit");

      return res.json({
        ok: true,
        session_token: issued.session_token,      // returned ONCE; never stored or logged
        expires_at: issued.expires_at,
        expires_in_hours: issued.expires_in_hours,
        user: issued.user,
        property: issued.property,
        //  issueStaffSession names this `property_role_title`. The grant
        //  shape the browser already accepts (POST /operator/session) calls
        //  it `role_title`, so it is mapped here rather than teaching the
        //  browser two names for one field.
        role_title: issued.property_role_title || null,
        allowed_modules: Array.isArray(issued.allowed_modules) ? issued.allowed_modules : [],
        previous_property_id: req.operator.property_id,
      });
    } catch (e) {
      try { await client.query("rollback"); } catch (_) { /* already unwound */ }
      console.error("operator/properties/select error", e);
      return res.status(500).json({ error: "Could not open that property." });
    } finally {
      client.release();
    }
  });

  return router;
};
