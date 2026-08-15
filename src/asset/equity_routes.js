/* ════════════════════════════════════════════════════════════════════
   equity_routes.js — THE GOVERNED EQUITY & PREFERRED EQUITY READ SEAM.

   ONE read, deliberately — unlike Debt's standing/detail split, Equity
   has no expensive derived artifact analogous to a 120-row amortization
   schedule (E3 forbids computing one anyway). position() itself is
   already cheap: a handful of capital entities and positions per
   property, not a schedule derivation.

       GET /operator/equity/standing            property-scoped positions

   ── WHY THERE ARE NO WRITE ROUTES HERE ──────────────────────────────
   Same reasoning as debt_routes.js: the canonical writers exist and are
   proven, and exposing each as an HTTP endpoint is scoped and REFUSED.
   4125's equity positions, once retained documents exist to establish
   them from, land through a narrow controlled step — not through this
   file. This file stays read-only and boring.

   ── CAPABILITY CLASSES, CLAIMED EXPLICITLY (§40.10) ─────────────────
       RETRIEVAL            claimed, narrowly — see
                            docs/EQUITY_READ_CONTRACT_AND_SCHEMA.md
                            Part 2 for exactly what "narrowly" means here
       COMPARISON           NOT claimed
       CAUSAL EXPLANATION   NOT claimed

   ── AUTHORITY IS SERVER-DERIVED (§21) ───────────────────────────────
   `req.operator.property_id` only. No property is ever accepted from
   the caller.

   CLASS 1 — permanent product primitive.
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const express = require("express");
const svc = require("./equity_position_service.js");
const read = require("./equity_position_read.js");

module.exports = function equityRoutes(deps) {
  const { pool, requireOperator, refuseClientAuthority, requireAssetManagementModule } = deps || {};
  if (!pool) throw new Error("equity_routes requires a pool");
  const gate = [requireOperator, refuseClientAuthority, requireAssetManagementModule];
  const router = express.Router();

  const today = () => new Date().toISOString().slice(0, 10);

  //  A read failure is a fact about SPINE, never about the property
  //  (§40.7) — same discipline as Debt's unavailable().
  function unavailable(res, e, what) {
    console.error(`equity read failed (${what})`, e);
    return res.status(503).json({
      truth_state: "READ_FAILED",
      error: "Equity is unavailable right now. This is not a statement about this property's capital structure.",
    });
  }

  router.get("/operator/equity/standing", gate, async (req, res) => {
    const propertyId = req.operator.property_id;
    const asOf = today();
    try {
      const history = await svc.loadHistory(pool, propertyId);

      //  HONEST EMPTY, NOT AN ERROR (§19) — same as Debt. A property with
      //  no established capital-stack entity is a legitimate, complete
      //  answer, and it is NOT the same statement as "this property has
      //  no equity in the world."
      if (!history.capital_entities.length) {
        return res.json({
          property_id: propertyId,
          as_of: asOf,
          capital_entities: [],
          conflicts: [],
          exposure: [],
          standing: {
            truth_state: read.NOT_ESTABLISHED,
            why: "no capital-stack entity is established for this property in Spine",
          },
        });
      }

      const position = read.position(history, asOf);
      return res.json({
        property_id: propertyId,
        as_of: asOf,
        capital_entities: position.capital_entities,
        conflicts: position.conflicts,
        exposure: position.exposure,
        standing: read.standingProjection(position),
      });
    } catch (e) {
      return unavailable(res, e, "standing");
    }
  });

  return router;
};
