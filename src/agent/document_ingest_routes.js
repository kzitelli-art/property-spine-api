// Legacy ingestion HTTP entry points are retired by owner ruling.
// Keep the independent leasing-basis setter and all retained database history.
const express = require("express");
const retired = require("../onboarding/legacy_ingestion_retired.js");

module.exports = function documentIngestRoutes({ pool }) {
  const router = express.Router();
  router.post("/properties/:propertyId/ingest", retired);
  router.post("/properties/:propertyId/ingest-file", retired);
  router.get("/ingest/:runId", retired);
  router.post("/ingest/:runId/candidates/:candidateId/edit", retired);
  router.get("/ingest/:runId/bed-groups", retired);
  router.post("/ingest/:runId/group-bed-rows", retired);
  router.post("/ingest/:runId/promote", retired);
  router.post("/ingest/:runId/approve", retired);

router.post("/properties/:id/leasing-basis", async (req, res) => {
  const { leasing_basis } = req.body || {};
  if (!["unit", "bed", "unknown"].includes(leasing_basis))
    return res.status(400).json({ error: "leasing_basis must be 'unit', 'bed', or 'unknown'" });
  try {
    const r = await pool.query(
      "update properties set leasing_basis=$1 where id=$2 returning name, address, leasing_basis",
      [leasing_basis, req.params.id]);
    if (r.rows.length === 0) return res.status(404).json({ error: "property not found" });
    const p = r.rows[0];
    res.json({
      receipt: `${p.name || p.address} now leases by the ${leasing_basis === "unknown" ? "— basis unknown (no bed gate)" : leasing_basis}`,
      leasing_basis: p.leasing_basis,
      note: "Leasing basis recorded. Use Deal Setup to upload and review source files.",
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
  return router;
};
