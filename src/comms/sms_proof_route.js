// sms_proof_route.js — extracted VERBATIM from server.js (dedup state included:
// it is route-private). Mounted at "/" at the exact position the route was
// registered inline, behind the global operator-key gate.
const express = require("express");

module.exports = function smsProofRoute({ commBoundary }) {
  const router = express.Router();
// In-process proof-send dedup state (see /sms-proof). Best-effort, single-instance,
// non-durable by design — a heavier store isn't warranted for a manual Class-2 route.
const PROOF_DEDUP_WINDOW_MS = 60000;
let __lastProofSend = { cell: null, at: 0, result: null };

// ── SMS PROOF ROUTE (Phase B · Class 2 adapter — DELETE when Phase C customer-care
//    sends are live). The ONLY caller of sendPropertySms with purpose 'proof_text'.
//    Sits behind the global operator-key gate. The recipient is SERVER-FORCED to
//    SMS_PROOF_CELL — this route physically cannot text any number but the one
//    designated proof cell, and proof_only refuses every other purpose. The
//    operator-supplied property_id only selects WHICH property line it sends FROM.
router.post("/sms-proof", async (req, res) => {
  try {
    const cell = (process.env.SMS_PROOF_CELL || "").trim();
    if (!cell) return res.status(400).json({ sent: false, reason: "proof_cell_not_configured" });
    const property_id = (req.body && req.body.property_id) || null;
    if (!property_id) return res.status(400).json({ sent: false, reason: "property_id_required" });

    // Idempotency guard: a proof that ALREADY SENT to this cell within the window is
    // not re-sent — a repeated manual fire returns the prior result, not a second
    // text. A refused attempt is NOT recorded, so retries after a refusal (e.g. SMS
    // off) still go through.
    const now = Date.now();
    if (__lastProofSend.cell === cell && (now - __lastProofSend.at) < PROOF_DEDUP_WINDOW_MS) {
      return res.status(200).json({ ...__lastProofSend.result, deduped: true, reason: "proof_deduped_recent_send" });
    }

    const out = await commBoundary.sendPropertySms({
      property_id,
      recipient: cell,
      body: (req.body && req.body.body) || "Property Spine proof text - Phase B. Reply STOP to opt out.",
      purpose: "proof_text",
    });
    if (out.sent) __lastProofSend = { cell, at: now, result: out }; // only actual sends dedup future repeats
    return res.status(out.sent ? 200 : 409).json(out);
  } catch (e) {
    console.error("[/sms-proof]", e.message);
    return res.status(500).json({ sent: false, reason: "proof_route_error", error: e.message });
  }
});
  return router;
}
