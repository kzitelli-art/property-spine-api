// space_position_routes.js — extracted VERBATIM from server.js. The read is
// mounted at "/" at the exact position the route was registered inline.
const express = require("express");
const { spacePosition } = require("./space_position");

module.exports = function spacePositionRoutes({ pool }) {
  const router = express.Router();
// Canonical dated space position (read-only): GET /properties/:id/space-position?as_of=YYYY-MM-DD
// One shared truth for current rent roll / forward rent roll / availability — distinct fields, never one status.
router.get("/properties/:id/space-position", async (req, res) => {
  try {
    const out = await spacePosition(pool, { property_id: req.params.id, as_of: req.query.as_of || null });
    res.json(out);
  } catch (e) {
    console.error("space-position error", e);
    res.status(500).json({ error: e.message });
  }
});
  return router;
}
