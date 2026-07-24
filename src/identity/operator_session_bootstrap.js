// operator_session_bootstrap.js
//
// BRICK ONE (S1)  the interim identity-proof door + the two session
// lifecycle routes. This is the ONLY /operator/* surface that is not behind
// requireOperator, because it is how a session comes to exist / ends:
//
//   POST /operator/session          proof -> canonical staff session
//   POST /operator/session/revoke   sign-out (revokes exactly this session)
//
// CLASSIFICATION:
//   the two routes                     Class 1 (permanent product routes)
//   the invite-proof resolution path   Class 2 (temporary adapter)
//     replacement condition: SMS OTP (or another approved proof) resolves
//     the same authorized user/property and calls the same
//     issueStaffSession(). operator_session_invites then retires per
//     credential policy. The routes, response contract, and session
//     semantics do NOT change at replacement.
//
// SECURITY SHAPE (per the approved Phase B plan):
//   - browser submits ONLY { proof }. user_id / property_id / role /
//     modules / TTL in the body are ignored  never authority.
//   - digest lookup: sha256(presented) -> indexed unique equality. The
//     controls are entropy, digest-only storage, short expiry, single-use,
//     FOR UPDATE row locking, and rate limits  stated honestly, the rate
//     limit here is per-process best-effort (mirrors the demo limiter),
//     not durable distributed abuse control.
//   - ONE generic refusal for invalid / expired / consumed / revoked proof.
//     The response never reveals which state applied.
//   - atomic consume-LAST: the invite is marked consumed only after
//     issueStaffSession has produced a real session, inside one
//     transaction, and consumed_staff_session_id links proof -> session.
//     Any failure rolls back: no session, proof NOT falsely consumed.

"use strict";

const express = require("express");
const svc = require("./staff_session_service.js");

module.exports = function operatorSessionBootstrap({ pool }) {
  const router = express.Router();

  // -- per-process best-effort rate limiter (same shape as the demo one) --
  // Endpoint-wide 30/min is the hard, proven ceiling. Per-IP 8/min is
  // best-effort AND proxy-configuration-dependent (server.js sets
  // trust proxy=1 for Render's single hop; the live acceptance harness
  // captures the verification receipt). The IP map is BOUNDED: expired
  // entries are pruned on every call and the key count is capped, so a
  // long-running process scanning many client IPs cannot grow it without
  // limit.
  const _hits = [];
  const _hitsByIp = new Map();
  const _MAX_IP_KEYS = 5000;
  function rateOk(ip) {
    const now = Date.now();
    while (_hits.length && now - _hits[0] > 60_000) _hits.shift();
    if (_hits.length >= 30) return false;                    // endpoint: 30/min (hard)
    let arr = _hitsByIp.get(ip) || [];
    while (arr.length && now - arr[0] > 60_000) arr.shift();
    if (arr.length >= 8) return false;                       // per-IP: 8/min (best-effort)
    if (arr.length === 0) _hitsByIp.delete(ip);              // drop empty before re-set
    if (_hitsByIp.size >= _MAX_IP_KEYS) {
      // prune expired-empty entries; if still at cap, evict oldest-inserted
      for (const [k, v] of _hitsByIp) {
        while (v.length && now - v[0] > 60_000) v.shift();
        if (v.length === 0) _hitsByIp.delete(k);
        if (_hitsByIp.size < _MAX_IP_KEYS) break;
      }
      if (_hitsByIp.size >= _MAX_IP_KEYS) {
        _hitsByIp.delete(_hitsByIp.keys().next().value);
      }
    }
    arr.push(now); _hitsByIp.set(ip, arr);
    return true;
  }

  const GENERIC_REFUSAL = { error: "That access code isn't valid. Ask for a new invite." };

  // =========================================================================
  // POST /operator/session  identity proof -> canonical staff session
  // =========================================================================
  router.post("/operator/session", async (req, res) => {
    res.set("Cache-Control", "no-store");

    if (!rateOk(req.ip || (req.connection && req.connection.remoteAddress) || "unknown")) {
      return res.status(429).json({ error: "Too many attempts  slow down." });
    }

    // The ONLY thing read from the browser. Anything else in the body is
    // ignored by construction: we never destructure user/property/role.
    const proof = (req.body && typeof req.body.proof === "string") ? req.body.proof : "";
    if (!proof) return res.status(400).json({ error: "Enter your access code." });

    const digest = svc._sha256(proof);

    const client = await pool.connect();
    try {
      await client.query("begin");

      // 1) lock the invite row by digest. FOR UPDATE means two racing
      //    submissions of the same proof serialize here: the second waits,
      //    then sees consumed_at set, and refuses. Exactly one session.
      const inv = (await client.query(
        `select id, user_id, property_id, issuance_reason,
                expires_at, consumed_at, revoked_at
           from operator_session_invites
          where token_digest = $1
          for update`,
        [digest]
      )).rows[0];

      // 2) ONE generic refusal for every proof-state failure. No oracle.
      if (!inv || inv.consumed_at || inv.revoked_at || new Date(inv.expires_at) <= new Date()) {
        await client.query("rollback");
        return res.status(401).json(GENERIC_REFUSAL);
      }

      // 3) mint FIRST. issueStaffSession independently re-verifies the
      //    user's CURRENT active assignment for the invite's bound
      //    property  the invite binds the attempt; entitlement is the
      //    authority. If entitlement was pulled between invite issuance
      //    and now, this throws, we roll back, and the proof is NOT
      //    consumed (case Q).
      let session;
      try {
        session = await svc.issueStaffSession(client, {
          userId: inv.user_id,
          propertyId: inv.property_id,
          purpose: "bootstrap_invite",
        });
      } catch (e) {
        await client.query("rollback");
        // entitlement/eligibility failures surface as the same generic
        // refusal: an attacker holding a stolen invite learns nothing
        // about whether the target user still has access.
        return res.status(401).json(GENERIC_REFUSAL);
      }

      // 4) consume LAST  and link proof -> exact session (receipts,
      //    targeted revocation, rollback).
      await client.query(
        `update operator_session_invites
            set consumed_at = now(),
                consumed_staff_session_id = $2
          where id = $1`,
        [inv.id, session.session_id]
      );

      await client.query("commit");

      // Response contract (Phase B final): existing vocabulary, four facts
      // kept distinct, modules live from the assignment  never a literal.
      return res.json({
        session_token: session.session_token,   // returned ONCE
        expires_in_hours: session.expires_in_hours,
        user: session.user,                      // { id, name, global_role }
        property: session.property,              // { id, name }
        property_role_title: session.property_role_title,
        allowed_modules: session.allowed_modules,
        landing_module: session.allowed_modules && session.allowed_modules.length
          ? session.allowed_modules[0] : null,
      });
    } catch (e) {
      try { await client.query("rollback"); } catch (_) {}
      // no raw proof, digest, or token in logs  ever.
      console.error("operator/session error:", e.publicMessage || e.message);
      return res.status(500).json({ error: "Sign-in is unavailable right now. Try again." });
    } finally {
      client.release();
    }
  });

  // =========================================================================
  // POST /operator/session/revoke  sign-out. Self-protecting: it derives
  // the target from the presented x-staff-session header itself. Idempotent
  // from the user's perspective  revoking an unknown/expired/already-
  // revoked token returns the same receipt (no state oracle).
  // =========================================================================
  router.post("/operator/session/revoke", async (req, res) => {
    // Reviewer hardening: the SAME bounded limiter as login. Revoke is
    // self-authenticating via the presented token, but fabricated headers
    // still cost a database read/update -- the wall applies here too.
    if (!rateOk(req.ip || (req.connection && req.connection.remoteAddress) || "unknown")) {
      return res.status(429).json({ receipt: "Too many attempts. Wait a minute and try again." });
    }
    res.set("Cache-Control", "no-store");
    const token = req.headers["x-staff-session"];
    if (!token) return res.status(400).json({ error: "No session to sign out." });
    try {
      await svc.revokeCurrentStaffSession(pool, token);
      return res.json({ receipt: "Signed out." });
    } catch (e) {
      console.error("operator/session/revoke error:", e.message);
      return res.status(500).json({ error: "Sign-out is unavailable right now." });
    }
  });

  return router;
};
