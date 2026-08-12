/* ════════════════════════════════════════════════════════════════════
   insurance_funding.js — the HTTP seam for how insurance is paid for.

   Its own module, mounted by the Asset Management surface behind that
   door's authority. It is NOT part of insurance_establishment.js, and
   that is structural rather than tidy: establishment is in the economic
   chain, and `gate_insurance_funding_boundary.js` fails the build if an
   economic file imports funding. Putting these two routes beside the
   establish route would break the wall the moment it was written.

   The surface can hold both because the surface is the composition
   point, not the economic chain.

   Authority middleware is INJECTED, never re-implemented — same as the
   establishment module. Two copies of an authority rule is a §17 defect
   even while the copies agree.

   CLASS 1 — permanent product primitive.
   ════════════════════════════════════════════════════════════════════ */
"use strict";

module.exports = function insuranceFunding(deps) {
  const express = require("express");
  const router = express.Router();

  const funding = require("./insurance_funding_service.js");
  const fundingRead = require("./insurance_funding_read.js");

  const {
    pool, requireOperator, refuseClientAuthority, requireAssetManagementModule,
    currentPeriod,
  } = deps || {};
  if (!pool) throw new Error("insurance_funding requires a pool");
  for (const [name, fn] of Object.entries({
    requireOperator, refuseClientAuthority, requireAssetManagementModule, currentPeriod,
  })) {
    if (typeof fn !== "function") throw new Error(`insurance_funding requires ${name}`);
  }

  const gate = [requireOperator, refuseClientAuthority, requireAssetManagementModule];

  function fail(res, e) {
    const SAYABLE = new Set([
      "BAD_INPUT", "NOT_FOUND", "PROVENANCE_REQUIRED", "REASON_REQUIRED",
      "PARTICIPATION_REQUIRED", "FINANCE_PROVIDER_REQUIRED", "DIRECT_HAS_NO_INSTRUMENT",
    ]);
    if (e && SAYABLE.has(e.code)) {
      return res.status(e.code === "NOT_FOUND" ? 404 : 422)
        .json({ error: e.code, receipt: e.message });
    }
    console.error("insurance funding write failed", e);
    return res.status(500).json({ error: "insurance_funding_write_failed" });
  }

  /*  ══ POST …/insurance/funding ═════════════════════════════════════
   *  Record how a coverage is funded for THIS property.
   *
   *  Nothing written here can change what insurance costs. The accrual
   *  reads the coverage and the allocation; it cannot see this table,
   *  and the boundary gate makes that a build failure rather than a
   *  convention.
   */
  router.post("/operator/asset-management/insurance/funding", ...gate,
    async (req, res) => {
      const propertyId = req.operator.property_id;
      const b = req.body || {};

      if (!b.coverage_id) {
        return res.status(422).json({
          error: "coverage_required",
          receipt: "Recording funding needs the coverage it pays for.",
        });
      }

      let client;
      try {
        client = await pool.connect();
        await client.query("begin");
        const arr = await funding.openArrangement(client, {
          coverage_id: b.coverage_id,
          //  SERVER-DERIVED. Never a body field; the gate middleware has
          //  already refused a mismatched one outright.
          property_id: propertyId,
          funding_method: b.funding_method,
          effective_from: b.effective_from,
          effective_to: b.effective_to || null,
          source_artifact_id: b.artifact_id || null,
          provenance_note: b.provenance_note || null,
          finance: b.finance || null,
          escrow: b.escrow || null,
          user_id: req.operator.id,
        });
        await client.query("commit");

        const period = /^\d{4}-\d{2}$/.test(String(b.period || ""))
          ? String(b.period) : currentPeriod();
        //  Return the READ, not an echo of the request.
        const now = await fundingRead.readFunding(client,
          { property_id: propertyId, period });

        return res.status(201).json({
          arrangement_id: arr.id,
          funding: now,
          //  ⚠ SAID EXPLICITLY, EVERY TIME. Recording how something is
          //  paid changes nothing about what it costs, and a caller
          //  should never have to infer that from silence.
          insurance_cost_changed: false,
          receipt: `Funding recorded: ${fundingRead.METHOD_LABEL[arr.funding_method]}. ` +
                   `What insurance costs this property is unchanged — how it is paid and ` +
                   `what it costs are separate facts.`,
        });
      } catch (e) {
        if (client) { try { await client.query("rollback"); } catch (_) {} }
        return fail(res, e);
      } finally {
        if (client) client.release();
      }
    });

  /*  ══ POST …/insurance/funding/:id/correct ═════════════════════════
   *  Restate a claim that was wrong. The predecessor stays readable.
   *  A mid-term CHANGE is a new arrangement, not a correction.
   */
  router.post("/operator/asset-management/insurance/funding/:id/correct", ...gate,
    async (req, res) => {
      const b = req.body || {};
      let client;
      try {
        client = await pool.connect();

        //  The arrangement must belong to the operator's own property.
        //  Authentication answers WHO may call this; it does not answer
        //  WHOSE arrangement they may restate.
        const owns = (await client.query(
          `select 1 from insurance_funding_arrangements
            where id = $1 and property_id = $2`,
          [req.params.id, req.operator.property_id])).rows[0];
        if (!owns) {
          return res.status(404).json({
            error: "arrangement_not_found",
            receipt: "That funding arrangement is not on this property.",
          });
        }

        await client.query("begin");
        const arr = await funding.correctArrangement(client, {
          arrangement_id: req.params.id,
          funding_method: b.funding_method || null,
          revision_reason: b.revision_reason,
          source_artifact_id: b.artifact_id || null,
          provenance_note: b.provenance_note || null,
          finance: b.finance || null,
          escrow: b.escrow || null,
          user_id: req.operator.id,
        });
        await client.query("commit");

        const period = /^\d{4}-\d{2}$/.test(String(b.period || ""))
          ? String(b.period) : currentPeriod();
        const now = await fundingRead.readFunding(client,
          { property_id: req.operator.property_id, period });

        return res.status(201).json({
          arrangement_id: arr.id,
          superseded_id: req.params.id,
          funding: now,
          insurance_cost_changed: false,
          receipt: "Funding corrected. The earlier claim is preserved and still readable.",
        });
      } catch (e) {
        if (client) { try { await client.query("rollback"); } catch (_) {} }
        return fail(res, e);
      } finally {
        if (client) client.release();
      }
    });

  return router;
};
