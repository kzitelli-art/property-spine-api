// ============================================================
// money.js — Accounting Truth at the Event (v1)
//
// The loop:
//   money-out event created → classification obligation routed by
//   org chart → person answers plain questions → system PROPOSES an
//   accounting category → human CONFIRMS → event becomes 'verified'.
//
// Hard safety rules baked in:
//   - money-OUT only (amount > 0, no money-in types)
//   - manual entry only (no bank feed)
//   - AI/system never moves money and never auto-confirms
//   - unconfirmed money stays 'unverified' — quarantined, never truth
//
// Factory pattern, matches orgchart/maintenance:
//   const money = require('./money');
//   app.use('/', money({ pool, spawnObligationFromEvent }));
// ============================================================

// ---- plain-language operator categories (what the USER picks) -----
// No GL codes ever shown to the user.
const WHAT_FOR = ['repair','turn','capex','billback','supply','cleaning','other'];

// ---- the three-layer derivation (same PATTERN as maintenance) -----
// operator answer + context  ->  proposed accounting category.
// This only PROPOSES. A human must confirm before it's truth.
function proposeCategory({ what_for, unitOccupied }) {
  // direct operator answers that map straight through
  const direct = {
    capex:    'capital_expenditure',
    billback: 'tenant_billback',
    supply:   'operating_supplies',
    cleaning: 'repairs_maintenance',
  };
  if (direct[what_for]) return direct[what_for];

  // context-sensitive ones — the maintenance-engine move:
  // a repair on an occupied unit is R&M; the same work on a vacant
  // unit is part of a turn (turnover cost), not ongoing R&M.
  if (what_for === 'repair') {
    return unitOccupied === false ? 'turnover' : 'repairs_maintenance';
  }
  if (what_for === 'turn') return 'turnover';

  // anything we can't confidently map stays uncategorized — never guess.
  return 'uncategorized';
}

function money({ pool, spawnObligationFromEvent }) {
  const express = require('express');
  const app = express.Router();

  // ---- helper: pick the assignment this spend routes to ----------
  // Rule (v1): if we know who spent it AND they have an active
  // assignment at this property, route to them (they classify their
  // own). Otherwise route to the property's accountable owner.
  //
  // Returns the full routing picture the obligation engine needs:
  //   { assignment_id, assigned_role, escalates_to_role }
  // The obligation engine assigns by ROLE string (like leasing uses
  // "leasing_agent"), so we resolve the assignment's role here. The
  // org chart's escalates_to_assignment_id points at ANOTHER assignment,
  // so we resolve THAT assignment's role for escalates_to_role.
  async function routeAssignment(client, property_id, spent_by_person_id) {
    let chosen = null;

    if (spent_by_person_id) {
      const own = await client.query(
        `SELECT id, role, escalates_to_assignment_id FROM assignments
          WHERE property_id = $1 AND person_id = $2 AND is_active = TRUE
          ORDER BY created_at LIMIT 1`,
        [property_id, spent_by_person_id]
      );
      if (own.rowCount > 0) chosen = own.rows[0];
    }

    // fall back to the property's accountable owner (never ownerless)
    if (!chosen) {
      const prop = await client.query(
        'SELECT accountable_assignment_id FROM properties WHERE id = $1',
        [property_id]
      );
      const accId = prop.rows[0] ? prop.rows[0].accountable_assignment_id : null;
      if (accId) {
        const acc = await client.query(
          'SELECT id, role, escalates_to_assignment_id FROM assignments WHERE id = $1 AND is_active = TRUE',
          [accId]
        );
        if (acc.rowCount > 0) chosen = acc.rows[0];
      }
    }

    if (!chosen) {
      return { assignment_id: null, assigned_role: null, escalates_to_role: null };
    }

    // resolve escalation: the org chart points at an assignment; the
    // obligation engine wants the role. null escalation = top of chain.
    let escalates_to_role = null;
    if (chosen.escalates_to_assignment_id) {
      const esc = await client.query(
        'SELECT role FROM assignments WHERE id = $1',
        [chosen.escalates_to_assignment_id]
      );
      if (esc.rowCount > 0) escalates_to_role = esc.rows[0].role;
    }

    return {
      assignment_id: chosen.id,
      assigned_role: chosen.role,
      escalates_to_role,
    };
  }

  // ---- POST /money-events -----------------------------------------
  // Create a money-OUT event. It lands UNVERIFIED and spawns a
  // classification obligation routed via the org chart.
  app.post('/money-events', async (req, res) => {
    const { property_id, amount } = req.body || {};
    if (!property_id) return res.status(400).json({ error: 'property_id required' });
    const amt = Number(amount);
    if (!(amt > 0)) {
      return res.status(400).json({ error: 'amount must be a positive number (money-OUT only in v1)' });
    }

    const {
      unit_id = null, vendor = null, spent_by_person_id = null,
      occurred_on = null,
    } = req.body;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const prop = await client.query('SELECT id FROM properties WHERE id = $1', [property_id]);
      if (prop.rowCount === 0) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'property not found' }); }

      // who owns this spend's classification (role + escalation, from the org chart)
      const route = await routeAssignment(client, property_id, spent_by_person_id);

      // 1) insert the raw money event — unverified, unclassified
      const ins = await client.query(
        `INSERT INTO money_events
           (property_id, unit_id, amount, vendor, spent_by_person_id, occurred_on,
            source_kind, status, assigned_assignment_id, provenance)
         VALUES ($1,$2,$3,$4,$5,$6,'manual','unverified',$7,$8)
         RETURNING *`,
        [property_id, unit_id, amt, vendor, spent_by_person_id, occurred_on,
         route.assignment_id, JSON.stringify({ source: 'manual_entry' })]
      );
      const ev = ins.rows[0];

      // 2) write the SOURCE EVENT — the obligation must be born from an
      //    event (spine rule), exactly like tour_booked and collections.
      const srcEv = await client.query(
        `INSERT INTO events (property_id, unit_id, type, note)
         VALUES ($1,$2,'money_out_logged',$3) RETURNING *`,
        [property_id, unit_id,
         `$${amt.toFixed(2)} money-out${vendor ? ' — ' + vendor : ''} (money_event ${ev.id})`]
      );
      const sourceEvent = srcEv.rows[0];

      // 3) spawn the classification obligation through the SHARED engine —
      //    same path as leasing/maintenance, inside this same transaction.
      //    Only spawn if it's routed AND the engine is present.
      let obligation = null;
      if (route.assignment_id && typeof spawnObligationFromEvent === 'function') {
        obligation = await spawnObligationFromEvent(client, {
          property_id,
          unit_id: unit_id ?? null,
          source_event_id: sourceEvent.id,
          module: 'money',
          type: 'classification',
          label: `Explain a $${amt.toFixed(2)} expense${vendor ? ' — ' + vendor : ''}`,
          owner_type: 'human',
          assigned_role: route.assigned_role,
          escalates_to_role: route.escalates_to_role,
          status: 'open',
          required_inputs: ['what_for', 'confirmed_category'],
        });
        // 4) link the obligation back onto the money event
        await client.query(
          'UPDATE money_events SET obligation_id = $1 WHERE id = $2',
          [obligation.id, ev.id]
        );
        ev.obligation_id = obligation.id;
      }

      // 5) commit everything together — money event, source event, and
      //    obligation are one atomic unit. No half-states.
      await client.query('COMMIT');

      return res.status(201).json({
        ...ev,
        obligation_id: obligation ? obligation.id : null,
        source_event_id: sourceEvent.id,
        routed_to_assignment: route.assignment_id,
        assigned_role: route.assigned_role,
        note: route.assignment_id
          ? 'Captured as UNVERIFIED. Classification obligation spawned via the shared engine and routed by org chart role.'
          : 'Captured as UNVERIFIED, but this property has NO accountable owner — no obligation spawned. Set an accountable owner so money classification gets routed.',
      });
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      console.error('POST money-event error', e);
      return res.status(500).json({ error: 'internal error' });
    } finally {
      client.release();
    }
  });

  // ---- POST /money-events/:id/classify ----------------------------
  // The person answers the plain questions. System PROPOSES a category.
  // This does NOT verify — it just records the answers + proposal.
  app.post('/money-events/:id/classify', async (req, res) => {
    const id = req.params.id;
    const { what_for, completion = null, receipt_note = null, unit_occupied = null } = req.body || {};

    if (!WHAT_FOR.includes(what_for)) {
      return res.status(400).json({ error: 'what_for must be one of', allowed: WHAT_FOR });
    }
    if (completion !== null && !['done','pending'].includes(completion)) {
      return res.status(400).json({ error: "completion must be 'done', 'pending', or omitted" });
    }

    const proposed = proposeCategory({ what_for, unitOccupied: unit_occupied });

    try {
      const upd = await pool.query(
        `UPDATE money_events
            SET what_for = $1, completion = $2, receipt_note = $3, proposed_category = $4
          WHERE id = $5
          RETURNING *`,
        [what_for, completion, receipt_note, proposed, id]
      );
      if (upd.rowCount === 0) return res.status(404).json({ error: 'money event not found' });
      return res.json({
        ...upd.rows[0],
        note: `Proposed accounting category: "${proposed}". A human must CONFIRM before this becomes verified truth.`,
      });
    } catch (e) {
      console.error('classify error', e);
      return res.status(500).json({ error: 'internal error' });
    }
  });

  // ---- POST /money-events/:id/confirm -----------------------------
  // A human confirms (or overrides) the category. THIS is what flips
  // the event to 'verified'. Nothing else can.
  app.post('/money-events/:id/confirm', async (req, res) => {
    const id = req.params.id;
    const { confirmed_by_person_id, confirmed_category = null } = req.body || {};
    if (!confirmed_by_person_id) {
      return res.status(400).json({ error: 'confirmed_by_person_id required — a human must confirm' });
    }
    try {
      const cur = await pool.query('SELECT proposed_category, what_for FROM money_events WHERE id = $1', [id]);
      if (cur.rowCount === 0) return res.status(404).json({ error: 'money event not found' });

      // can't confirm what hasn't been classified — soft proof gate
      if (!cur.rows[0].what_for) {
        return res.status(409).json({
          error: 'cannot confirm before classification',
          outstanding: ['what_for'],
          note: 'Run /classify first so there is something to confirm.',
        });
      }

      // human can override the proposal; otherwise the proposal stands
      const finalCat = confirmed_category || cur.rows[0].proposed_category;

      const upd = await pool.query(
        `UPDATE money_events
            SET confirmed_category = $1,
                status = 'verified',
                verified_by_person_id = $2,
                verified_at = now()
          WHERE id = $3
          RETURNING *`,
        [finalCat, confirmed_by_person_id, id]
      );
      return res.json({
        ...upd.rows[0],
        note: 'Verified. This event is now accounting truth and may appear in clean/reported views.',
      });
    } catch (e) {
      console.error('confirm error', e);
      return res.status(500).json({ error: 'internal error' });
    }
  });

  // ---- GET /properties/:id/money-events ---------------------------
  // List money events for a property, split by the soft gate.
  // Default shows the queue (unverified) up top — what needs explaining.
  app.get('/properties/:id/money-events', async (req, res) => {
    const property_id = req.params.id;
    try {
      const rows = await pool.query(
        `SELECT m.*, p.name AS spent_by_name
           FROM money_events m
           LEFT JOIN persons p ON p.id = m.spent_by_person_id
          WHERE m.property_id = $1
          ORDER BY (m.status = 'unverified') DESC, m.created_at DESC`,
        [property_id]
      );
      const unverified = rows.rows.filter(r => r.status === 'unverified');
      const verified   = rows.rows.filter(r => r.status === 'verified');
      return res.json({
        unverified_queue: unverified,   // needs explaining — quarantined from truth
        verified,                       // confirmed accounting truth
        summary: {
          unverified_count: unverified.length,
          verified_count: verified.length,
          // NOTE: only verified amounts are "truth". Unverified never blends in.
          verified_total: verified.reduce((s, r) => s + Number(r.amount), 0),
          unverified_total_quarantined: unverified.reduce((s, r) => s + Number(r.amount), 0),
        },
      });
    } catch (e) {
      console.error('GET money-events error', e);
      return res.status(500).json({ error: 'internal error' });
    }
  });

  return app;
}

module.exports = money;
module.exports.WHAT_FOR = WHAT_FOR;
module.exports.proposeCategory = proposeCategory;
