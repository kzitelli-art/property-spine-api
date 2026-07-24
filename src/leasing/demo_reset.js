"use strict";
/**
 * demo_reset.js — REHEARSAL RESET for the Boardroom Live demo. (Jul 2026)
 *
 * WHY THIS EXISTS
 *   The public POST /demo/intake writes REAL persons + leasing_leads +
 *   conversations, tagged source='boardroom_demo', at the property named exactly
 *   "Property Spine Demo Building". They accumulate on every submission. Week-4
 *   rehearsal needs the operator Conversations queue to start EMPTY so the
 *   attendee's live submission is the ONE row that appears (Act 1, Beat 2).
 *   The existing demo.js reset only touches the demo_runs ORCHESTRATION layer —
 *   it does NOT clear this live boardroom queue. This module does, and only this.
 *
 * WHAT IT DOES
 *   Closes every ACTIVE boardroom_demo conversation at the Demo Building through
 *   the CANONICAL leasingLifecycle.closeNotFit service — the exact same lever the
 *   operator "Close" button pulls. A closed conversation drops out of the active
 *   queue (is_closed -> commercial_state='closed_not_fit', excluded from the
 *   projection's ACTIVE_STATES). No forked SQL; no reimplemented lifecycle.
 *
 * IT DELETES NOTHING
 *   Every row is preserved. Each close is a reopenable lifecycle event, so a
 *   reset is fully reversible and history stays intact ("reset preserves history").
 *
 * FAIL-CLOSED — checked in order, BEFORE any DB write:
 *   1. DEMO_MODE=true required                         -> 403 otherwise
 *   2. body.confirm === "RESET"                         -> 400 otherwise (no drive-by clears)
 *   3. if env DEMO_ACCESS_CODE is set, body.access_code -> 403 otherwise (constant-time compare)
 *   4. per-IP rate limit                                -> 429 otherwise (before any DB touch)
 *
 * SCOPE WALL (four independent locks; client input is ignored entirely):
 *   • property is SERVER-DERIVED as the row named exactly "Property Spine Demo
 *     Building" (same constant + same `order by created_at asc limit 1` as
 *     /demo/intake and operator.js). Absent -> 409, touch nothing.
 *   • only leads whose source_id = lead_sources('boardroom_demo').
 *   • only conversations with status='open' and a non-terminal lead.
 *   • closeNotFit's own lockConversation re-verifies property scope (403 on mismatch).
 *   Because the boardroom_demo tag can only be attached at the Demo Building, this
 *   endpoint is STRUCTURALLY incapable of touching Solo / production / the sandbox.
 *
 * The route lives under /demo/ (a PUBLIC_PREFIX — no operator key) so it is
 * curl-able during rehearsal. Safe because the worst possible outcome is "some
 * demo rehearsal conversations were closed," which is reversible.
 */
const crypto = require("crypto");

module.exports = function demoReset(deps) {
  const { pool, leasingLifecycle } = deps || {};
  if (!pool) throw new Error("demo_reset requires { pool }");
  if (!leasingLifecycle || typeof leasingLifecycle.closeNotFit !== "function") {
    throw new Error("demo_reset requires { leasingLifecycle } with closeNotFit()");
  }

  const express = require("express");
  const router = express.Router();

  const DEMO_PROP_NAME = "Property Spine Demo Building"; // MUST match /demo/intake + operator.js
  const DEMO_SOURCE = "boardroom_demo";                  // MUST match /demo/intake DEMO_INTAKE_SOURCE

  // tiny per-IP limiter (reset is low-frequency; a Map is enough).
  const _hits = new Map(); // ip -> [timestamps]
  function rateOk(ip, max, windowMs) {
    const now = Date.now();
    const arr = (_hits.get(ip) || []).filter((t) => now - t < windowMs);
    if (arr.length >= max) { _hits.set(ip, arr); return false; }
    arr.push(now); _hits.set(ip, arr); return true;
  }

  function safeEqual(a, b) {
    const ba = Buffer.from(String(a == null ? "" : a));
    const bb = Buffer.from(String(b == null ? "" : b));
    if (ba.length !== bb.length) return false;
    return crypto.timingSafeEqual(ba, bb);
  }

  // Resolve the Demo Building + the boardroom_demo source id. Returns
  // { prop, srcId } or null on the honest "nothing to reset" cases.
  async function resolveScope() {
    const prop = (await pool.query(
      "select id, name from properties where name=$1 order by created_at asc limit 1",
      [DEMO_PROP_NAME]
    )).rows[0];
    if (!prop) return { missingProperty: true };
    const src = (await pool.query(
      "select id from lead_sources where lower(name)=lower($1) limit 1",
      [DEMO_SOURCE]
    )).rows[0];
    return { prop, srcId: src ? src.id : null };
  }

  // The candidate conversations = exactly what the operator active queue would
  // show, narrowed to the boardroom source. Mirrors the projection's `eligible`
  // CTE AND its is_closed derivation: a conversation already closed (and not since
  // reopened) is NOT active, so it is not a reset candidate. Without this, health
  // over-counts and a re-run needlessly re-touches settled rows.
  async function candidateConversationIds(propId, srcId) {
    if (!srcId) return [];
    return (await pool.query(
      `select distinct c.id as conversation_id
         from leasing_leads ll
         join conversations c
           on c.property_id = ll.property_id and c.person_id = ll.person_id
         left join (
           select conversation_id,
                  max(event_sequence) filter (where event_type='closed_not_fit') as close_seq,
                  max(event_sequence) filter (where event_type='reopened')       as reopen_seq
             from leasing_lead_lifecycle_events
            group by conversation_id
         ) life on life.conversation_id = c.id
        where ll.property_id = $1
          and ll.source_id   = $2
          and c.status = 'open'
          and ll.status not in ('applied','leased','lost')
          -- NOT is_closed: never closed, or reopened at/after the last close
          and (life.close_seq is null
               or (life.reopen_seq is not null and life.reopen_seq >= life.close_seq))`,
      [propId, srcId]
    )).rows.map((r) => r.conversation_id);
  }

  // ── GET /demo/rehearsal-reset/health — how many rows a reset WOULD close,
  //    without closing anything. (Dry run for the rehearsal checklist.) ──
  router.get("/demo/rehearsal-reset/health", async (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      if (String(process.env.DEMO_MODE || "").toLowerCase() !== "true") {
        return res.status(403).json({ ok: false, receipt: "The live demo is not enabled on this deployment." });
      }
      const scope = await resolveScope();
      if (scope.missingProperty) {
        return res.status(409).json({ ok: false, receipt: "The demo property is not seeded yet — start the demo first." });
      }
      const ids = await candidateConversationIds(scope.prop.id, scope.srcId);
      return res.json({
        ok: true,
        mode: "demo",
        property: scope.prop.name,
        source: DEMO_SOURCE,
        active_conversations_eligible_for_reset: ids.length,
        action: "none",
        receipt: `${ids.length} active boardroom conversation${ids.length === 1 ? "" : "s"} at ${scope.prop.name} would be closed by a reset. Nothing was changed.`,
      });
    } catch (e) {
      console.error("[demo_reset] health failed", (e && e.message) || "unknown");
      return res.status(500).json({ ok: false, receipt: "Health check failed — see server logs." });
    }
  });

  // ── POST /demo/rehearsal-reset — empties the live boardroom Conversations queue. ──
  router.post("/demo/rehearsal-reset", async (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      // 1) DEMO_MODE gate
      if (String(process.env.DEMO_MODE || "").toLowerCase() !== "true") {
        return res.status(403).json({ ok: false, receipt: "The live demo is not enabled on this deployment." });
      }
      const b = req.body || {};

      // 2) explicit confirm token — no accidental / drive-by resets
      if (b.confirm !== "RESET") {
        return res.status(400).json({
          ok: false,
          receipt: 'Reset not confirmed. Send {"confirm":"RESET"} to clear the boardroom rehearsal queue.',
        });
      }

      // 3) optional shared code (defense in depth; the scope wall already bounds blast radius)
      if (process.env.DEMO_ACCESS_CODE && !safeEqual(b.access_code, process.env.DEMO_ACCESS_CODE)) {
        return res.status(403).json({ ok: false, receipt: "Reset code incorrect." });
      }

      // 4) rate limit BEFORE any DB touch — nothing partial is ever attempted
      const ip = (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown")
        .toString().split(",")[0].trim();
      if (!rateOk(ip, 6, 10 * 60 * 1000)) {
        return res.status(429).json({ ok: false, receipt: "Too many resets — wait a few minutes." });
      }

      // ── SERVER-DERIVED scope (client property_id ignored entirely) ──
      const scope = await resolveScope();
      if (scope.missingProperty) {
        return res.status(409).json({ ok: false, receipt: "The demo property is not seeded yet — start the demo first." });
      }
      if (!scope.srcId) {
        // No boardroom_demo source row means nothing was ever tagged — honest empty.
        return res.json({
          ok: true, mode: "demo", property: scope.prop.name, source: DEMO_SOURCE,
          closed: 0, already_clear: true, action: "none",
          receipt: "Queue already clear — no boardroom_demo leads exist yet. Ready to rehearse Act 1.",
        });
      }

      const ids = await candidateConversationIds(scope.prop.id, scope.srcId);
      if (ids.length === 0) {
        return res.json({
          ok: true, mode: "demo", property: scope.prop.name, source: DEMO_SOURCE,
          closed: 0, already_clear: true, action: "none",
          receipt: `Queue already clear at ${scope.prop.name} — nothing to reset. Ready to rehearse Act 1.`,
        });
      }

      let closed = 0, already = 0, errorCount = 0;
      for (const conversationId of ids) {
        try {
          await leasingLifecycle.closeNotFit({
            conversationId,
            propertyId: scope.prop.id,          // re-verified inside lockConversation (403 on mismatch)
            actorUserId: null,                  // system reset — no operator identity is faked
            reasonCode: "other",
            reasonNote: "boardroom rehearsal reset",
            idempotencyKey: `rehearsal_reset:${conversationId}`,
          });
          closed++;
        } catch (e) {
          // 409 = already closed OR duplicate reset key -> already clear, not a failure.
          if (e && (e.httpStatus === 409 || /already closed|Duplicate/i.test(e.message || ""))) {
            already++;
          } else {
            // Count only — no raw ids or error text cross a public response. Details -> logs.
            errorCount++;
            console.error("[demo_reset] close failed", conversationId, (e && e.message) || "unknown");
          }
        }
      }

      return res.json({
        ok: errorCount === 0,
        mode: "demo",
        property: scope.prop.name,
        source: DEMO_SOURCE,
        closed,
        already_clear: closed === 0 && errorCount === 0,
        errors: errorCount,
        action: errorCount === 0 ? "rehearsal_reset_complete" : "rehearsal_reset_partial",
        receipt:
          `Boardroom rehearsal queue reset at ${scope.prop.name}: ` +
          `${closed} conversation${closed === 1 ? "" : "s"} closed` +
          (already ? `, ${already} already clear` : "") +
          (errorCount ? `, ${errorCount} error${errorCount === 1 ? "" : "s"} (see server logs)` : "") +
          `. Every record preserved and reopenable. Ready to rehearse Act 1.`,
      });
    } catch (e) {
      // Public 500: no internal error text crosses the wire; details -> logs.
      console.error("[demo_reset] reset failed", (e && e.message) || "unknown");
      return res.status(500).json({ ok: false, receipt: "Reset failed — see server logs." });
    }
  });

  return router;
};
