// ============================================================
// seed_endpoint.js — backend-only historical snapshot bootstrap
//
// The operator app never uploads infrastructure files. In DEMO_MODE, the
// sourced Solo June 2026 baseline is ensured on the Demo Building at API
// startup through the SAME canonical snapshot importer used by live reads.
// Repeated restarts are a no-op once the exact source/date batch exists.
// Nothing writes to Yardi.
//
// Admin routes remain available behind the operator-key middleware:
//   POST /admin/seed-snapshot            → Skyline + Solo QA baseline
//   POST /admin/seed-snapshot/solo       → Solo QA baseline only
//   POST /admin/seed-snapshot/skyline    → Skyline only
//   GET  /admin/seed-snapshot/status
// ============================================================

const DEMO_PROP_NAME = "Property Spine Demo Building";
const DEMO_MODE = String(process.env.DEMO_MODE || "").toLowerCase() === "true";

module.exports = function seedEndpoint(deps){
  const express = require("express");
  const router = express.Router();
  const { pool } = deps;
  if (!pool) throw new Error("seed_endpoint requires a pool");

  const legacy = require("./seed_snapshot");
  const soloData = require("./seeds/data_solo");
  const snapshotLoader = require("./snapshot_loader");
  const { seedOne, DATASETS } = legacy;
  const { loadSnapshot, CONFIGS } = snapshotLoader;

  async function resolveDemoPropertyId(){
    const r = await pool.query(
      "select id from properties where name=$1 order by created_at asc limit 1",
      [DEMO_PROP_NAME]
    );
    return r.rows[0]?.id || null;
  }

  async function removePriorSnapshotLeases(propertyId){
    const batches = (await pool.query(
      `select id from import_batches
        where property_id=$1 and source_type='historical_snapshot'
          and not (source_file=$2 and source_as_of_date=$3)`,
      [propertyId, soloData.source_file, soloData.source_as_of_date]
    )).rows.map(r => r.id);
    if (!batches.length) return 0;

    const client = await pool.connect();
    try {
      await client.query("begin");
      // Remove only records owned by prior snapshot batches. QA-created records
      // have no such batch id and remain intact. Inventory is retained/reused.
      await client.query("delete from leases where import_batch_id = any($1::uuid[])", [batches]);
      await client.query("delete from persons where import_batch_id = any($1::uuid[])", [batches]);
      await client.query("delete from import_source_rows where import_batch_id = any($1::uuid[])", [batches]);
      await client.query("update spaces set import_batch_id=null where import_batch_id = any($1::uuid[])", [batches]);
      await client.query("update units set import_batch_id=null where import_batch_id = any($1::uuid[])", [batches]);
      await client.query("delete from import_batches where id = any($1::uuid[])", [batches]);
      await client.query("commit");
      return batches.length;
    } catch (e) {
      await client.query("rollback");
      throw e;
    } finally {
      client.release();
    }
  }

  async function ensureSoloQaBaseline(){
    const propertyId = await resolveDemoPropertyId();
    if (!propertyId) return { error:"demo_property_not_found", property_name:DEMO_PROP_NAME };

    const existing = await pool.query(
      `select id from import_batches
        where property_id=$1 and source_type='historical_snapshot'
          and source_file=$2 and source_as_of_date=$3 and status='committed'
        order by loaded_at desc limit 1`,
      [propertyId, soloData.source_file, soloData.source_as_of_date]
    );
    if (existing.rows.length) {
      return { ok:true, already_loaded:true, property_id:propertyId, import_batch_id:existing.rows[0].id,
               source_file:soloData.source_file, source_as_of_date:soloData.source_as_of_date };
    }

    const removedPriorBatches = await removePriorSnapshotLeases(propertyId);
    const cfg = { ...CONFIGS.solo,
      source_file:soloData.source_file,
      source_as_of_date:soloData.source_as_of_date,
      leasing_model:soloData.leasing_model,
      confidence:soloData.confidence,
      badge:soloData.badge,
    };
    const out = await loadSnapshot(pool, cfg, soloData.ROWS, {
      targetPropertyId:propertyId,
      sourceFile:soloData.source_file,
      sourceAsOfDate:soloData.source_as_of_date,
      sourceLabel:soloData.badge,
      confidence:soloData.confidence,
      notes:"Solo June 2026 sourced operating baseline for Demo/QA. Loaded from backend GitHub seed through canonical importer; no Yardi write.",
    });
    return { ...out, removed_prior_snapshot_batches:removedPriorBatches };
  }

  // Backend infrastructure bootstrap, never an operator action. Fail soft at
  // process start so a seed problem cannot take down the API; the rent-roll read
  // remains honestly empty/unavailable and the error is visible in Render logs.
  if (DEMO_MODE) {
    setImmediate(() => {
      ensureSoloQaBaseline()
        .then(r => console.log("[solo-qa-baseline]", JSON.stringify(r)))
        .catch(e => console.error("[solo-qa-baseline] failed:", e.message));
    });
  }

  router.post("/admin/seed-snapshot/:key?", async (req, res) => {
    try {
      const key = req.params.key;
      if (key && key !== "solo" && key !== "skyline")
        return res.status(404).json({ error:"unknown property", known:["solo","skyline"] });
      const keys = key ? [key] : ["skyline","solo"];
      const results = [];
      for (const k of keys) {
        results.push(k === "solo" ? await ensureSoloQaBaseline() : await seedOne(pool, k));
      }
      const anyErr = results.some(r => r.error);
      return res.status(anyErr ? 207 : 201).json({ seeded:results });
    } catch (e) {
      console.error("seed endpoint error:", e);
      return res.status(500).json({ error:"seed_failed", detail:e.message });
    }
  });

  router.get("/admin/seed-snapshot/status", async (_req, res) => {
    try {
      const r = await pool.query(
        `select b.id, b.property_id, b.source_file, b.source_as_of_date, b.leasing_model, b.confidence, b.loaded_at,
                p.name as property_name, p.display_name, p.canonical_key,
                (select count(*) from units u where u.import_batch_id=b.id)::int as units,
                (select count(*) from spaces s where s.import_batch_id=b.id)::int as spaces,
                (select count(*) from persons pe where pe.import_batch_id=b.id)::int as persons,
                (select count(*) from leases l where l.import_batch_id=b.id)::int as leases,
                (select count(*) from leases l where l.import_batch_id=b.id and l.lease_status='active')::int as current_leases,
                (select count(*) from leases l where l.import_batch_id=b.id and l.lease_status='commercial')::int as commercial_leases,
                (select count(*) from leases l where l.import_batch_id=b.id and l.lease_status='pending')::int as future_leases
           from import_batches b
           join properties p on p.id=b.property_id
          where b.source_type='historical_snapshot'
          order by b.loaded_at desc`);
      return res.json({ snapshots:r.rows });
    } catch (e) {
      return res.status(500).json({ error:"status_failed", detail:e.message });
    }
  });

  router.helpers = { ensureSoloQaBaseline };
  return router;
};
