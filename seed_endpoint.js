// ============================================================
// seed_endpoint.js — trigger the historical snapshot seed via HTTP
//   (because there's no CLI access to Render — you click, it seeds)
//
//   POST /admin/seed-snapshot            → seeds both Skyline + Solo
//   POST /admin/seed-snapshot/skyline    → just Skyline
//   POST /admin/seed-snapshot/solo       → just Solo
//   POST /admin/seed-snapshot/rollback/:key → remove a property's snapshot
//   GET  /admin/seed-snapshot/status     → what's currently seeded
//
//   All behind the operator-key middleware (it's under /admin, not public).
//   Idempotent: re-running reloads cleanly, never duplicates.
// ============================================================

module.exports = function seedEndpoint(deps){
  const express = require("express");
  const router = express.Router();
  const { pool } = deps;
  if (!pool) throw new Error("seed_endpoint requires a pool");

  const { seedOne, rollbackOne, DATASETS } = require("./seed_snapshot");

  // seed both, or one
  router.post("/admin/seed-snapshot/:key?", async (req, res) => {
    try {
      const key = req.params.key;
      if (key && key !== "rollback" && !DATASETS[key])
        return res.status(404).json({ error: "unknown property", known: Object.keys(DATASETS) });
      const keys = key ? [key] : Object.keys(DATASETS);
      const results = [];
      for (const k of keys) results.push(await seedOne(pool, k));
      const anyErr = results.some(r => r.error);
      res.status(anyErr ? 207 : 201).json({ seeded: results });
    } catch (e) {
      console.error("seed endpoint error:", e);
      res.status(500).json({ error: "seed_failed", detail: e.message });
    }
  });

  // rollback a property's snapshot
  router.post("/admin/seed-snapshot/rollback/:key", async (req, res) => {
    try {
      const key = req.params.key;
      if (!DATASETS[key]) return res.status(404).json({ error: "unknown property", known: Object.keys(DATASETS) });
      res.json(await rollbackOne(pool, key));
    } catch (e) {
      res.status(500).json({ error: "rollback_failed", detail: e.message });
    }
  });

  // what's currently seeded (the snapshot batches that exist)
  router.get("/admin/seed-snapshot/status", async (req, res) => {
    try {
      const r = await pool.query(
        `select b.id, b.source_file, b.source_as_of_date, b.leasing_model, b.confidence, b.loaded_at,
                p.name as property_name, p.canonical_key,
                (select count(*) from units u where u.import_batch_id=b.id)::int as units,
                (select count(*) from spaces s where s.import_batch_id=b.id)::int as spaces,
                (select count(*) from persons pe where pe.import_batch_id=b.id)::int as persons,
                (select count(*) from leases l where l.import_batch_id=b.id)::int as leases
           from import_batches b
           join properties p on p.id=b.property_id
          where b.source_type='historical_snapshot'
          order by b.loaded_at desc`);
      res.json({ snapshots: r.rows });
    } catch (e) {
      res.status(500).json({ error: "status_failed", detail: e.message });
    }
  });

  return router;
};
