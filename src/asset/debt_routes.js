/* ════════════════════════════════════════════════════════════════════
   debt_routes.js — THE GOVERNED DEBT READ SEAM.

   Two reads. Nothing else, deliberately.

       GET /operator/debt/standing            property-scoped positions
       GET /operator/debt/instrument/:id      one instrument, with detail

   ── WHY THERE ARE NO WRITE ROUTES HERE ──────────────────────────────
   The seven canonical writers exist and are proven, and exposing each as
   an HTTP endpoint was scoped and REFUSED. A low-level writer existing is
   not a reason to give it a permanent public door: nine mutation routes
   would turn this plumbing layer into an admin API, and the durable write
   path belongs to the governed document-establishment workflow rather
   than to us surfacing every writer because it is there.

   4125 will be established in production through a narrow controlled
   step. This file stays read-only and boring.

   ── CAPABILITY CLASSES, CLAIMED EXPLICITLY (§40.10) ─────────────────
       RETRIEVAL            claimed
       COMPARISON           NOT claimed
       CAUSAL EXPLANATION   NOT claimed — hooks preserved

   `/standing` is scoped to the operator's own property, so there is no
   cross-property surface to aggregate over. That is deliberate: comparing
   debt needs a basis — per unit, per SF, per dollar of value — and the
   basis is a model nobody recorded. A portfolio comparison is a NEW read
   with a declared basis, never a wider filter on this one.

   ── IT ADDS NO DOMAIN LOGIC ─────────────────────────────────────────
       route → listInstrumentsForProperty → loadHistory → position → JSON

   No derivation, no composition, no defaults, no truth decided here. If
   an answer looks wrong, it is wrong in debt_position_read.js, and that
   is the point of keeping this layer thin enough to rule out.

   ── AUTHORITY IS SERVER-DERIVED, AND PATH IDENTITY IS NOT AUTHORITY ──
   The gate is passed in from the Asset Management surface and is the same
   one Taxes and Insurance use. Every handler reads
   `req.operator.property_id`; none accepts a property from the caller.

   `:id` NAMES an instrument. It never GRANTS one. The detail route
   re-derives which instruments the operator's property actually secures
   and refuses anything outside that set — otherwise a guessed uuid would
   be an authority bypass wearing a path parameter.

   CLASS 1 — permanent product primitive.
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const express = require("express");
const svc = require("./debt_instrument_service.js");
const read = require("./debt_position_read.js");

module.exports = function debtRoutes(deps) {
  const { pool, requireOperator, refuseClientAuthority, requireAssetManagementModule } = deps || {};
  if (!pool) throw new Error("debt_routes requires a pool");
  const gate = [requireOperator, refuseClientAuthority, requireAssetManagementModule];
  const router = express.Router();

  const today = () => new Date().toISOString().slice(0, 10);

  //  A read failure is a fact about SPINE, never about the property
  //  (§40.7). It must not arrive shaped like "no debt established".
  function unavailable(res, e, what) {
    console.error(`debt read failed (${what})`, e);
    return res.status(503).json({
      truth_state: "READ_FAILED",
      error: "Debt is unavailable right now. This is not a statement about this property's debt.",
    });
  }

  /*  ── STANDING ───────────────────────────────────────────────────
   *  The compact governed reading for every instrument this property
   *  secures. No payment schedule here — 120 rows per loan is the detail
   *  projection, and §40.6 exists so the routine read stays cheap enough
   *  to gather beside Taxes, Insurance and the rest.                    */
  router.get("/operator/debt/standing", gate, async (req, res) => {
    const propertyId = req.operator.property_id;
    const asOf = today();
    try {
      const ids = await svc.listInstrumentsForProperty(pool, propertyId, asOf);

      //  HONEST EMPTY, NOT AN ERROR (§19). A property with no established
      //  debt is a legitimate, complete answer — and it is NOT the same
      //  statement as "this property has no debt in the world", which
      //  Spine has no basis to make.
      if (!ids.length) {
        return res.json({
          property_id: propertyId,
          as_of: asOf,
          instrument_count: 0,
          instruments: [],
          standing: {
            truth_state: read.NOT_ESTABLISHED,
            why: "no debt instrument is established for this property in Spine",
          },
        });
      }

      const instruments = [];
      for (const id of ids) {
        const hist = await svc.loadHistory(pool, id);
        if (hist) instruments.push(read.position(hist, asOf));
      }
      return res.json({
        property_id: propertyId,
        as_of: asOf,
        instrument_count: instruments.length,
        instruments,
      });
    } catch (e) {
      return unavailable(res, e, "standing");
    }
  });

  /*  ── ONE INSTRUMENT, WITH DETAIL ────────────────────────────────  */
  router.get("/operator/debt/instrument/:id", gate, async (req, res) => {
    const propertyId = req.operator.property_id;
    const asOf = today();
    try {
      //  ⚠ THE AUTHORITY CHECK, AND IT RUNS BEFORE THE READ.
      //  Membership is re-derived from the operator's property rather than
      //  trusted from the path. A uuid the caller supplies identifies; it
      //  does not entitle.
      const ids = await svc.listInstrumentsForProperty(pool, propertyId, asOf);
      if (!ids.includes(req.params.id)) {
        //  404, not 403: a "forbidden" here would confirm the instrument
        //  exists, which is itself a fact about another property.
        return res.status(404).json({
          error: "No such debt instrument for this property.",
        });
      }

      const hist = await svc.loadHistory(pool, req.params.id);
      if (!hist) return res.status(404).json({ error: "No such debt instrument for this property." });

      const position = read.position(hist, asOf);
      return res.json({
        property_id: propertyId,
        as_of: asOf,
        position,
        //  The detail projection (§40.6). Derived from the contractual
        //  terms, and every row says so — a schedule row is what the
        //  contract REQUIRES, never evidence that a payment occurred.
        payment_schedule: read.deriveSchedule(hist.terms, hist.instrument),
        schedule_basis: "schedule_derivation",
      });
    } catch (e) {
      return unavailable(res, e, "instrument detail");
    }
  });

  return router;
};
