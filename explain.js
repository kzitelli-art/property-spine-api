// ============================================================
// explain.js — The Explanation Rung (migration 018)
//
// The comparison layer renders verdicts; THIS module lets a human convert
// "unexplained" into "explained, with my name on it." An explanation is a
// named, signed, evidence-carrying claim about WHY a report line and the
// bank disagree. It never edits the compare, never nets, never auto-applies.
//
// THE RULES:
//   1. PROPOSE, NEVER SILENTLY EXPLAIN. The UI may SUGGEST explanations;
//      nothing reduces residual exposure until a human attests it
//      (created_by_person_id is required — the signature IS the rung).
//   2. GROSS, NEVER NET. amount > 0 always; direction lives in the note.
//      Residual = |variance| − sum(explanations), floored at 0, computed
//      at read time. Over-explanation is FLAGGED, never hidden.
//   3. Kinds are app-layer vocabulary so the language can grow:
//      timing_prior_month_cash · timing_next_month_cash · escrow_paid ·
//      accrual_not_paid · held_out_composite · held_out_affiliate ·
//      unproven_checks · booking_difference · balance_sheet_item · other
//   4. Removal is GUARDED: confirm must equal the explanation's amount,
//      forcing a look at what is being unattested. The removal is itself
//      a durable event.
//
// Composition note (honest scope): the residual board is composed by the
// CLIENT from GET /report-compare + GET /variance-explanations. A server-
// side composed board is a later slice — this rung is the data + the
// attestation, the smallest real slice that makes explanations exist.
//
// Factory: app.use('/', explainModule({ pool }));
// ============================================================

const express = require("express");

const KINDS = [
  "timing_prior_month_cash", "timing_next_month_cash",
  "escrow_paid", "accrual_not_paid",
  "held_out_composite", "held_out_affiliate",
  "unproven_checks", "booking_difference",
  "balance_sheet_item", "other",
];

module.exports = function explainModule({ pool }) {
  const router = express.Router();

  // ── POST /properties/:id/variance-explanations ────────────────────
  // A human attests one explanation for one line in one month.
  // Body: { month:'YYYY-MM', report_section, report_line, kind, amount,
  //         note?, evidence?, created_by_person_id }
  router.post("/properties/:id/variance-explanations", async (req, res) => {
    const property_id = req.params.id;
    const { month, report_section, report_line, kind, amount, note = null, evidence = null, created_by_person_id } = req.body || {};
    if (!month || !/^\d{4}-\d{2}$/.test(month)) return res.status(400).json({ error: "month required as YYYY-MM" });
    if (!report_section || !report_line) return res.status(400).json({ error: "report_section and report_line required" });
    if (!KINDS.includes(kind)) return res.status(400).json({ error: "kind must be one of", allowed: KINDS });
    const amt = Number(amount);
    if (!(amt > 0)) return res.status(400).json({ error: "amount must be a positive number — explanations are gross; direction lives in the note" });
    if (!created_by_person_id) return res.status(400).json({ error: "created_by_person_id required — explanations are signed or they don't exist" });

    try {
      const prop = await pool.query("select id from properties where id = $1", [property_id]);
      if (prop.rowCount === 0) return res.status(404).json({ error: "property not found" });

      const ins = await pool.query(
        `insert into variance_explanations
           (property_id, month, report_section, report_line, kind, amount, note, evidence, created_by_person_id)
         values ($1, $2::date, $3, $4, $5, $6, $7, $8, $9)
         returning *`,
        [property_id, `${month}-01`, report_section, report_line, kind, amt,
         note, evidence ? JSON.stringify(evidence) : null, created_by_person_id]);

      // durable receipt in the event history
      await pool.query(
        `insert into events (property_id, type, note)
         values ($1, 'variance_explained', $2)`,
        [property_id,
         `${month} ${report_section} / ${report_line}: $${amt.toFixed(2)} attested as ${kind} by ${created_by_person_id}${note ? " — " + note.slice(0, 120) : ""}`]);

      // line context: total now attested on this line
      const tot = await pool.query(
        `select coalesce(sum(amount),0)::numeric(14,2) as attested, count(*)::int as n
           from variance_explanations
          where property_id=$1 and month=$2::date and report_section=$3 and report_line=$4`,
        [property_id, `${month}-01`, report_section, report_line]);

      return res.status(201).json({
        explanation: ins.rows[0],
        line_attested_total: Number(tot.rows[0].attested),
        line_explanations: tot.rows[0].n,
        note: "Attested. Residual exposure is computed at read time: |variance| minus attested, floored at zero — over-explanation is flagged, never hidden.",
      });
    } catch (e) {
      console.error("variance-explanation create error", e);
      return res.status(500).json({ error: e.message });
    }
  });

  // ── GET /properties/:id/variance-explanations?month=YYYY-MM ───────
  // All explanations for a property-month, grouped per line.
  router.get("/properties/:id/variance-explanations", async (req, res) => {
    const property_id = req.params.id;
    const month = req.query.month;
    if (!month || !/^\d{4}-\d{2}$/.test(month)) return res.status(400).json({ error: "month query param required as YYYY-MM" });
    try {
      const rows = (await pool.query(
        `select e.*, p.name as attested_by_name
           from variance_explanations e
           left join persons p on p.id = e.created_by_person_id
          where e.property_id = $1 and e.month = $2::date
          order by e.report_section, e.report_line, e.created_at`,
        [property_id, `${month}-01`])).rows;

      const byLine = {};
      for (const r of rows) {
        const k = `${r.report_section}\u0000${r.report_line}`;
        if (!byLine[k]) byLine[k] = { report_section: r.report_section, report_line: r.report_line, attested_total: 0, explanations: [] };
        byLine[k].attested_total = Number((byLine[k].attested_total + Number(r.amount)).toFixed(2));
        byLine[k].explanations.push({
          id: r.id, kind: r.kind, amount: Number(r.amount), note: r.note,
          evidence: r.evidence, attested_by: r.attested_by_name || r.created_by_person_id,
          created_at: r.created_at,
        });
      }
      return res.json({
        property_id, month,
        lines: Object.values(byLine),
        total_attested: Number(rows.reduce((s, r) => s + Number(r.amount), 0).toFixed(2)),
        kinds: KINDS,
      });
    } catch (e) {
      console.error("variance-explanation list error", e);
      return res.status(500).json({ error: e.message });
    }
  });

  // ── DELETE /variance-explanations/:id ─────────────────────────────
  // Guarded unattest: confirm must equal the amount, to the cent, as a
  // string — forces a look. The removal is a durable event.
  router.delete("/variance-explanations/:id", async (req, res) => {
    const id = req.params.id;
    const { confirm } = req.body || {};
    try {
      const cur = await pool.query("select * from variance_explanations where id = $1", [id]);
      if (cur.rowCount === 0) return res.status(404).json({ error: "explanation not found" });
      const e0 = cur.rows[0];
      const want = Number(e0.amount).toFixed(2);
      if (String(confirm) !== want) {
        return res.status(403).json({ error: "confirm must equal the explanation amount, to the cent", expected: want });
      }
      await pool.query("delete from variance_explanations where id = $1", [id]);
      await pool.query(
        `insert into events (property_id, type, note)
         values ($1, 'variance_explained', $2)`,
        [e0.property_id,
         `UNATTESTED ${String(e0.month).slice(0,7)} ${e0.report_section} / ${e0.report_line}: $${want} (${e0.kind}) removed`]);
      return res.json({ deleted: id, note: "Unattested. The residual for that line grows back accordingly — the history keeps the trail." });
    } catch (e) {
      console.error("variance-explanation delete error", e);
      return res.status(500).json({ error: e.message });
    }
  });

  return router;
};
module.exports.KINDS = KINDS;
