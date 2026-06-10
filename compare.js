// ============================================================
// compare.js — THE COMPARISON LAYER (Phase-1 hook, v1)
//
// "Here is what we recreated. Here is where we match. Here is where
//  we differ. Here is what needs review."
//
// OUR side  = report_ready money_events grouped via category_report_map
//             (same semantics as money.js report-read: only approved truth,
//              economic date = COALESCE(occurred_on, created_at::date)).
// THEIR side = an imported report (report_imports + report_import_lines),
//             labels resolved through report_line_aliases at import time.
//
// PER-LINE VERDICTS — four states, never blended (HOOK_COMPARISON_SPEC.md):
//   matched              ours == theirs (to the cent)
//   timing               differ, but report_ready activity exists on the same
//                        line in an ADJACENT month (cash-vs-accrual candidate;
//                        basis declared — proposed, not proven)
//   unexplained          differ, no adjacent-month story. THE review queue.
//   not_visible_in_cash  non_cash accrual constructs + revenue_v2 lines —
//                        declared out of cash scope, never compared
// Plus two honest buckets (not verdicts):
//   unmatched_labels     their labels with no alias row -> needs_mapping
//   ours_only            our lines carrying money their report didn't show
//
// HEADLINE = gross_unexplained_exposure = SUM |variance| over unexplained
// lines ONLY. Never net. timing_exposure is context, never canceled against it.
//
// Module needs only { pool }. Spawns no obligations in v1.
// Mount AFTER pool is declared:  app.use("/", compareModule({ pool }));
// ============================================================

const express = require('express');

module.exports = function compareModule({ pool }) {
  const router = express.Router();
  const norm = (s) => String(s || '').trim().toLowerCase();
  const cents = (x) => Math.round((Number(x) || 0) * 100) / 100;

  // ---- POST /properties/:id/report-imports -------------------------
  // Import THEIR report for a month. Lines resolve through the alias
  // registry; unmatched labels are stored unresolved (never guessed,
  // never auto-aliased). Re-import after teaching aliases to re-resolve.
  // body: { month:'YYYY-MM', source_label, lines:[{label, amount}] }
  router.post('/properties/:id/report-imports', async (req, res) => {
    const property_id = req.params.id;
    const { month, source_label, lines } = req.body || {};
    if (!month || !/^\d{4}-\d{2}$/.test(month))
      return res.status(400).json({ error: "month required as YYYY-MM" });
    if (!source_label || !String(source_label).trim())
      return res.status(400).json({ error: 'source_label required' });
    if (!Array.isArray(lines) || lines.length === 0)
      return res.status(400).json({ error: 'lines must be a non-empty array of {label, amount}' });
    for (const l of lines) {
      if (!l || !String(l.label || '').trim() || !isFinite(Number(l.amount)))
        return res.status(400).json({ error: `bad line: ${JSON.stringify(l)} — need {label, amount(number)}` });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const prop = await client.query('SELECT id FROM properties WHERE id = $1', [property_id]);
      if (prop.rowCount === 0) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'property not found' }); }

      const imp = await client.query(
        `INSERT INTO report_imports (property_id, month, source_label)
         VALUES ($1, $2::date, $3) RETURNING id, month, source_label`,
        [property_id, `${month}-01`, String(source_label).trim()]
      );
      const import_id = imp.rows[0].id;

      let resolved = 0, nonCash = 0, revenue = 0;
      const unmatched = [];
      for (const l of lines) {
        const ln = norm(l.label);
        const a = await client.query(
          `SELECT report_section, report_line, compare_mode
             FROM report_line_aliases WHERE label_norm = $1`, [ln]);
        const hit = a.rows[0] || null;
        if (!hit) unmatched.push(l.label);
        else if (hit.compare_mode === 'non_cash') nonCash++;
        else if (hit.compare_mode === 'revenue_v2') revenue++;
        else resolved++;
        await client.query(
          `INSERT INTO report_import_lines
             (import_id, label_raw, label_norm, amount, report_section, report_line, compare_mode)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [import_id, String(l.label).trim(), ln, cents(l.amount),
           hit ? hit.report_section : null, hit ? hit.report_line : null,
           hit ? hit.compare_mode : null]
        );
      }
      await client.query('COMMIT');
      return res.status(201).json({
        import_id, month, source_label,
        lines_total: lines.length,
        resolved_cash_lines: resolved,
        non_cash_lines: nonCash,
        revenue_lines_declared: revenue,
        unmatched_labels: unmatched,        // -> teach via POST /report-line-aliases, then re-import
        note: 'Resolution is a snapshot. Teaching an alias later does NOT rewrite this import — re-import to re-resolve.'
      });
    } catch (e) {
      await client.query('ROLLBACK');
      return res.status(500).json({ error: e.message });
    } finally { client.release(); }
  });

  // ---- GET /properties/:id/report-compare?import_id=... ------------
  // READ-ONLY. Mutates nothing.
  router.get('/properties/:id/report-compare', async (req, res) => {
    const property_id = req.params.id;
    const import_id = req.query.import_id;
    if (!import_id) return res.status(400).json({ error: 'import_id query param required' });

    try {
      const imp = await pool.query(
        `SELECT id, property_id, month, source_label FROM report_imports WHERE id = $1`, [import_id]);
      if (imp.rowCount === 0) return res.status(404).json({ error: 'import not found' });
      if (imp.rows[0].property_id !== property_id)
        return res.status(409).json({ error: 'import belongs to a different property — refusing the cross-property compare' });

      const monthStart = imp.rows[0].month; // date (first of month)

      // OUR side — mirrors report-read v1 semantics exactly.
      const dateExpr = 'COALESCE(m.occurred_on, m.created_at::date)';
      const ours = await pool.query(
        `SELECT cm.report_section, cm.report_line,
                COALESCE(SUM(m.amount),0)::numeric AS total, COUNT(*)::int AS events
           FROM money_events m
           JOIN category_report_map cm ON cm.confirmed_category = m.confirmed_category
          WHERE m.property_id = $1 AND m.status = 'report_ready'
            AND ${dateExpr} >= $2::date AND ${dateExpr} < ($2::date + interval '1 month')
          GROUP BY cm.report_section, cm.report_line`,
        [property_id, monthStart]
      );

      // ADJACENT-month report_ready activity per line (the timing probe).
      const adjacent = await pool.query(
        `SELECT cm.report_section, cm.report_line,
                COALESCE(SUM(m.amount),0)::numeric AS total, COUNT(*)::int AS events
           FROM money_events m
           JOIN category_report_map cm ON cm.confirmed_category = m.confirmed_category
          WHERE m.property_id = $1 AND m.status = 'report_ready'
            AND ${dateExpr} >= ($2::date - interval '1 month')
            AND ${dateExpr} <  ($2::date + interval '2 month')
            AND NOT (${dateExpr} >= $2::date AND ${dateExpr} < ($2::date + interval '1 month'))
          GROUP BY cm.report_section, cm.report_line`,
        [property_id, monthStart]
      );

      // THEIR side — resolved import lines, summed per {section,line} per mode.
      const theirs = await pool.query(
        `SELECT report_section, report_line, compare_mode,
                COALESCE(SUM(amount),0)::numeric AS total, COUNT(*)::int AS source_lines,
                array_agg(label_raw ORDER BY label_raw) AS labels
           FROM report_import_lines
          WHERE import_id = $1 AND report_section IS NOT NULL
          GROUP BY report_section, report_line, compare_mode`,
        [import_id]
      );
      const unmatchedRows = await pool.query(
        `SELECT label_raw, amount FROM report_import_lines
          WHERE import_id = $1 AND report_section IS NULL ORDER BY label_raw`,
        [import_id]
      );

      const key = (s, l) => `${s}\u0000${l}`;
      const oursMap = {}, adjMap = {};
      for (const r of ours.rows)     oursMap[key(r.report_section, r.report_line)] = { total: cents(r.total), events: r.events };
      for (const r of adjacent.rows) adjMap[key(r.report_section, r.report_line)]  = { total: cents(r.total), events: r.events };

      const compared = [], notVisible = [];
      const seen = new Set();

      for (const t of theirs.rows) {
        const k = key(t.report_section, t.report_line);
        const theirTotal = cents(t.total);

        if (t.compare_mode !== 'cash') {
          notVisible.push({
            report_section: t.report_section, report_line: t.report_line,
            their_total: theirTotal, their_labels: t.labels,
            basis: t.compare_mode === 'non_cash'
              ? 'accrual_construct — no cash counterpart by nature'
              : 'revenue_tables_not_read_v1 — income lives in revenue tables; expense side first',
          });
          continue;
        }

        seen.add(k);
        const our = oursMap[k] || { total: 0, events: 0 };
        const variance = cents(theirTotal - our.total);
        let verdict, basis = null;
        if (Math.abs(variance) < 0.005) {
          verdict = 'matched';
        } else {
          const adj = adjMap[k];
          if (adj && adj.events > 0) {
            verdict = 'timing';
            basis = `adjacent-month report_ready activity on this line: ${adj.events} event(s), ${adj.total}. ` +
                    `Cash-vs-accrual CANDIDATE — proposed, not proven. A human confirms or rejects.`;
          } else {
            verdict = 'unexplained';
            basis = our.events === 0
              ? 'no report_ready cash events on this line in-month or adjacent — either uncaptured cash or their booking differs'
              : 'cash events exist but totals do not tie and no adjacent-month story covers the gap';
          }
        }
        compared.push({
          report_section: t.report_section, report_line: t.report_line,
          their_total: theirTotal, our_total: our.total, our_events: our.events,
          variance, verdict, ...(basis ? { basis } : {}), their_labels: t.labels,
        });
      }

      // ours_only — we carry money on a line their report didn't show as cash.
      const oursOnly = [];
      for (const k of Object.keys(oursMap)) {
        if (seen.has(k)) continue;
        const [s, l] = k.split('\u0000');
        if (oursMap[k].total !== 0)
          oursOnly.push({ report_section: s, report_line: l, our_total: oursMap[k].total, our_events: oursMap[k].events });
      }

      const sumAbs = (arr) => cents(arr.reduce((s, r) => s + Math.abs(r.variance), 0));
      const unexplained = compared.filter(r => r.verdict === 'unexplained');
      const timing      = compared.filter(r => r.verdict === 'timing');
      const matched     = compared.filter(r => r.verdict === 'matched');

      return res.json({
        property_id,
        import_id,
        month: String(imp.rows[0].month).slice(0, 7),
        source_label: imp.rows[0].source_label,
        // THE BOARD — gross, never net. timing is context, never canceled.
        board: {
          gross_unexplained_exposure: sumAbs(unexplained),   // HEADLINE
          timing_exposure: sumAbs(timing),                   // context only
          matched_lines: matched.length,
          unexplained_lines: unexplained.length,
          timing_lines: timing.length,
          unmatched_label_count: unmatchedRows.rowCount,
          fully_matched: unexplained.length === 0 && unmatchedRows.rowCount === 0,
        },
        lines: compared.sort((a, b) =>
          a.report_section === b.report_section
            ? a.report_line.localeCompare(b.report_line)
            : a.report_section.localeCompare(b.report_section)),
        not_visible_in_cash: notVisible,
        unmatched_labels: unmatchedRows.rows,   // needs_mapping queue
        ours_only: oursOnly,
        honest_notes: [
          'OUR side reads ONLY report_ready money_events (report-read v1 semantics). Staged/unverified cash is excluded by design.',
          'timing verdicts are CANDIDATES with the adjacent-month evidence shown — proposed, never silently accepted.',
          'gross_unexplained_exposure is a SUM of absolute variances. Offsetting errors never read as clean.',
          'This compares the cash-visible expense side. Revenue and accrual constructs are declared, not compared, in v1.',
        ],
      });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  });

  // ---- POST /report-line-aliases ------------------------------------
  // Teach (or correct) ONE label -> line mapping. Human action, explicit.
  router.post('/report-line-aliases', async (req, res) => {
    const { label, report_section, report_line, compare_mode } = req.body || {};
    if (!label || !String(label).trim()) return res.status(400).json({ error: 'label required' });
    if (!report_section || !report_line) return res.status(400).json({ error: 'report_section and report_line required' });
    const mode = compare_mode || 'cash';
    if (!['cash', 'non_cash', 'revenue_v2'].includes(mode))
      return res.status(400).json({ error: "compare_mode must be cash | non_cash | revenue_v2" });
    try {
      const r = await pool.query(
        `INSERT INTO report_line_aliases (label_norm, label_raw, report_section, report_line, compare_mode)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (label_norm) DO UPDATE
           SET label_raw = EXCLUDED.label_raw, report_section = EXCLUDED.report_section,
               report_line = EXCLUDED.report_line, compare_mode = EXCLUDED.compare_mode
         RETURNING *`,
        [norm(label), String(label).trim(), report_section, report_line, mode]
      );
      return res.status(201).json({ alias: r.rows[0], note: 'Existing imports keep their snapshot — re-import to apply.' });
    } catch (e) { return res.status(500).json({ error: e.message }); }
  });

  // ---- GET /report-line-aliases?q= ----------------------------------
  router.get('/report-line-aliases', async (req, res) => {
    try {
      const q = norm(req.query.q || '');
      const r = q
        ? await pool.query(`SELECT * FROM report_line_aliases WHERE label_norm LIKE $1 ORDER BY label_norm LIMIT 50`, [`%${q}%`])
        : await pool.query(`SELECT * FROM report_line_aliases ORDER BY label_norm LIMIT 200`);
      return res.json({ count: r.rowCount, aliases: r.rows });
    } catch (e) { return res.status(500).json({ error: e.message }); }
  });

  // ---- DELETE /report-imports/:id/test-cleanup -----------------------
  // Guarded: only deletes imports whose source_label starts with 'TEST '.
  router.delete('/report-imports/:id/test-cleanup', async (req, res) => {
    try {
      const r = await pool.query(
        `DELETE FROM report_imports WHERE id = $1 AND source_label LIKE 'TEST %' RETURNING id, source_label`,
        [req.params.id]);
      if (r.rowCount === 0)
        return res.status(404).json({ error: "not found or not a TEST import (source_label must start with 'TEST ') — real imports are never deletable here" });
      return res.json({ deleted: r.rows[0], note: 'lines removed via ON DELETE CASCADE' });
    } catch (e) { return res.status(500).json({ error: e.message }); }
  });

  return router;
};
