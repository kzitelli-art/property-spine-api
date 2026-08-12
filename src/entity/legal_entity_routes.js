/* ════════════════════════════════════════════════════════════════════
   legal_entity_routes.js — THE NARROW CAPTURE SEAM FOR A TAXPAYER.

   ── IT EXISTS TO CLOSE A REAL DEAD END ──────────────────────────────
   BIRT and NPT are owed by a legal entity. Until this route existed,
   establishing either from a property required somebody to insert rows
   in the database by hand — so the browser path stopped at a sheet that
   correctly explained the problem and offered no way out of it. An
   honest dead end is still a dead end.

   ── IT IS NOT OWNED BY TAXES, AND IT DOES NOT LIVE IN THE ASSET DOOR ─
   `legal_entities` is a shared primitive. Ownership and debt work will
   want the same object, and putting its writer inside `tax_*` would make
   Taxes the owner of a thing Taxes merely uses — the same mistake a
   `tax_taxpayers` table would have been.

   The Asset Management surface MOUNTS it, behind that door's authority,
   the way it mounts the other write modules.

   ── IT DOES NOT EXPAND THE PRIMITIVE ────────────────────────────────
   No EIN. No City tax account number. No percentages, no waterfall, no
   cap table, no org-chart ingestion. One route that does exactly what an
   operator needs to get past the dead end: name the entity, say how it
   relates to this property, and record where that came from.

   ⚠ AND IT ONLY ESTABLISHES. There is deliberately no "pick an existing
   entity" picker, because `legal_entities` carries no tenancy of its own
   and listing candidates would mean reading entities this operator has
   no relationship to. The cost is real and is recorded rather than
   papered over: the same LLC entered from two properties becomes two
   rows. Fixing that needs a scoped read, which needs the primitive to
   know whose it is — a deliberate decision, not a side effect of a
   capture form.

   CLASS 1 — permanent product primitive.
   ════════════════════════════════════════════════════════════════════ */
"use strict";

module.exports = function legalEntityRoutes(deps) {
  const express = require("express");
  const router = express.Router();
  const entities = require("./legal_entity_service.js");

  const {
    pool, requireOperator, refuseClientAuthority, requireAssetManagementModule,
  } = deps || {};
  if (!pool) throw new Error("legal_entity_routes requires a pool");
  for (const [name, fn] of Object.entries({
    requireOperator, refuseClientAuthority, requireAssetManagementModule,
  })) {
    if (typeof fn !== "function") throw new Error(`legal_entity_routes requires ${name}`);
  }
  const gate = [requireOperator, refuseClientAuthority, requireAssetManagementModule];

  /*  ══ POST …/legal-entity ══════════════════════════════════════════
   *  Establish an entity and relate it to THIS property, in one
   *  transaction, because it is one human act: "this property is owned
   *  by 2116 Chestnut Partners LLC, per the deed."
   *
   *  Two canonical writes, no third path — `establishEntity` and
   *  `relateToProperty` are the same functions Deal Setup and any later
   *  ownership work will call.
   */
  router.post("/operator/asset-management/legal-entity", ...gate, async (req, res) => {
    const b = req.body || {};
    let client;
    try {
      client = await pool.connect();
      await client.query("begin");

      const entity = await entities.establishEntity(client, {
        //  The name on the formation document, not a display name.
        legal_name: b.legal_name,
        entity_type: b.entity_type || null,
        formation_jurisdiction: b.formation_jurisdiction || null,
        source_artifact_id: b.artifact_id || null,
        provenance_note: b.provenance_note || null,
        user_id: req.operator.id,
      });

      const rel = await entities.relateToProperty(client, {
        legal_entity_id: entity.id,
        //  SERVER-DERIVED. The operator's own property, never a body
        //  field — the gate has already refused a mismatched one.
        property_id: req.operator.property_id,
        relationship_type: b.relationship_type || "owner",
        effective_from: b.effective_from,
        source_artifact_id: b.artifact_id || null,
        provenance_note: b.provenance_note || null,
        user_id: req.operator.id,
      });
      await client.query("commit");

      const now = await entities.readForProperty(client,
        { property_id: req.operator.property_id });

      return res.status(201).json({
        legal_entity_id: entity.id,
        relationship_id: rel.id,
        entities: now,
        //  ⚠ SAID EXPLICITLY. Naming the taxpayer establishes no tax
        //  fact whatever — not applicability, not an obligation, not a
        //  filer profile. Each of those is a separate confirmed act.
        tax_truth_established: false,
        receipt: `${entity.legal_name} is recorded as ${
          (b.relationship_type || "owner").replace(/_/g, " ")} of this property. ` +
          `That names the taxpayer — it does not yet say which taxes apply to it.`,
      });
    } catch (e) {
      if (client) { try { await client.query("rollback"); } catch (_) {} }
      const SAYABLE = new Set(["BAD_INPUT", "NOT_FOUND", "PROVENANCE_REQUIRED"]);
      if (e && SAYABLE.has(e.code)) {
        return res.status(e.code === "NOT_FOUND" ? 404 : 422)
          .json({ error: e.code, receipt: e.message });
      }
      console.error("legal entity write failed", e);
      return res.status(500).json({ error: "legal_entity_write_failed" });
    } finally {
      if (client) client.release();
    }
  });

  return router;
};
