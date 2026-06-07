// ============================================================
// orgchart.js — Org Chart v1 (Per-Property Responsibility Map)
//
// The ONLY question this module answers:
//   At this property: who owns the truth, who can act, how much
//   can they do, and who does it escalate to?
//
// Dependency-injected per the standard pattern: server.js owns the
// pool and passes it in. No money code lives here.
//
//   const orgchart = require('./orgchart');
//   orgchart.register(app, { pool });
// ============================================================

// ---- fixed role vocabulary (regional_manager OUT for v1) ----------
const ROLES = ['property_manager','maintenance','leasing','bookkeeper','asset_manager','owner'];
const SCOPES = ['all','maintenance','leasing','accounting','management'];

// ---- role default seeds -------------------------------------------
// Caps use explicit values: 0 = no authority, null = N/A, -1 = unlimited.
const ROLE_DEFAULTS = {
  maintenance:      { spend_cap: 100,  approval_cap: 0,     scope: 'maintenance' },
  leasing:          { spend_cap: 100,  approval_cap: 0,     scope: 'leasing'     },
  bookkeeper:       { spend_cap: 0,    approval_cap: 0,     scope: 'accounting'  },
  property_manager: { spend_cap: 500,  approval_cap: 2500,  scope: 'all'         },
  asset_manager:    { spend_cap: null, approval_cap: 25000, scope: 'all'         },
  owner:            { spend_cap: null, approval_cap: -1,    scope: 'all'         },
};

// pick first defined of a list; lets caller override role defaults
const pick = (override, fallback) => (override === undefined ? fallback : override);

function orgchart({ pool }) {
  const express = require('express');
  const app = express.Router();


  // ---- POST /properties/:id/assignments ---------------------------
  // Assign a person to a property in a role. Ranges optional → role defaults.
  app.post('/properties/:id/assignments', async (req, res) => {
    const property_id = req.params.id;
    const { person_id, role } = req.body || {};

    if (!person_id) return res.status(400).json({ error: 'person_id required' });
    if (!ROLES.includes(role)) {
      return res.status(400).json({ error: 'invalid role', allowed: ROLES });
    }

    const d = ROLE_DEFAULTS[role];
    const spend_cap    = pick(req.body.spend_cap,    d.spend_cap);
    const approval_cap = pick(req.body.approval_cap, d.approval_cap);
    const scope        = pick(req.body.scope,        d.scope);

    if (!SCOPES.includes(scope)) {
      return res.status(400).json({ error: 'invalid scope', allowed: SCOPES });
    }

    // escalates_to is optional and may be null (top of chain).
    const escalates_to = req.body.escalates_to_assignment_id || null;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // property must exist
      const prop = await client.query('SELECT id FROM properties WHERE id = $1', [property_id]);
      if (prop.rowCount === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'property not found' });
      }
      // person must exist
      const pers = await client.query('SELECT id FROM persons WHERE id = $1', [person_id]);
      if (pers.rowCount === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'person not found' });
      }
      // if escalates_to given, it must be an assignment at THIS property
      if (escalates_to) {
        const esc = await client.query(
          'SELECT id FROM assignments WHERE id = $1 AND property_id = $2 AND is_active = TRUE',
          [escalates_to, property_id]
        );
        if (esc.rowCount === 0) {
          await client.query('ROLLBACK');
          return res.status(400).json({
            error: 'escalates_to must be an active assignment at this property'
          });
        }
      }

      // provenance: caps that came from the caller are confirmed; defaults are assumed
      const provenance = {
        spend_cap:    req.body.spend_cap    !== undefined ? 'confirmed' : 'assumed',
        approval_cap: req.body.approval_cap !== undefined ? 'confirmed' : 'assumed',
        scope:        req.body.scope        !== undefined ? 'confirmed' : 'assumed',
      };

      const ins = await client.query(
        `INSERT INTO assignments
           (person_id, property_id, role, spend_cap, approval_cap, scope,
            escalates_to_assignment_id, is_active, provenance)
         VALUES ($1,$2,$3,$4,$5,$6,$7,TRUE,$8)
         RETURNING *`,
        [person_id, property_id, role, spend_cap, approval_cap, scope,
         escalates_to, JSON.stringify(provenance)]
      );

      await client.query('COMMIT');
      return res.status(201).json(ins.rows[0]);
    } catch (e) {
      await client.query('ROLLBACK');
      // unique-violation = duplicate active role for this person at this property
      if (e.code === '23505') {
        return res.status(409).json({
          error: 'person already holds this role at this property (active)'
        });
      }
      console.error('POST assignment error', e);
      return res.status(500).json({ error: 'internal error' });
    } finally {
      client.release();
    }
  });

  // ---- GET /properties/:id/assignments ----------------------------
  // Everyone at the property + ranges + escalation, PLUS coverage in one payload.
  // This is the seam the Money Gate will query later.
  app.get('/properties/:id/assignments', async (req, res) => {
    const property_id = req.params.id;
    try {
      const prop = await pool.query(
        'SELECT id, accountable_assignment_id FROM properties WHERE id = $1',
        [property_id]
      );
      if (prop.rowCount === 0) return res.status(404).json({ error: 'property not found' });

      const accountableId = prop.rows[0].accountable_assignment_id;

      const rows = await pool.query(
        `SELECT a.*, p.name AS person_name
           FROM assignments a
           JOIN persons p ON p.id = a.person_id
          WHERE a.property_id = $1 AND a.is_active = TRUE
          ORDER BY a.created_at`,
        [property_id]
      );

      // ---- coverage (folded in — no separate endpoint) ----
      const gaps = [];
      if (!accountableId) {
        gaps.push({ type: 'no_accountable_owner',
          message: 'Property has no accountable owner. Money truth is unowned.' });
      }
      if (rows.rowCount === 0) {
        gaps.push({ type: 'no_assignments',
          message: 'Property has no assigned staff.' });
      }
      // flag missing escalation ONLY when the assignment is NOT the accountable one
      // (top/accountable assignment is allowed a null escalation — clarification #2)
      for (const a of rows.rows) {
        if (!a.escalates_to_assignment_id && a.id !== accountableId) {
          gaps.push({ type: 'no_escalation', assignment_id: a.id,
            message: `${a.person_name} (${a.role}) has no escalation path.` });
        }
      }

      return res.json({
        assignments: rows.rows,
        coverage: {
          accountable_owner: accountableId ? 'present' : 'missing',
          accountable_assignment_id: accountableId || null,
          gaps,
        },
      });
    } catch (e) {
      console.error('GET assignments error', e);
      return res.status(500).json({ error: 'internal error' });
    }
  });

  // ---- PATCH /assignments/:id -------------------------------------
  // Change ranges / role / scope / escalation, or set is_active=false.
  app.patch('/assignments/:id', async (req, res) => {
    const id = req.params.id;
    const fields = [];
    const vals = [];
    let i = 1;

    const set = (col, val) => { fields.push(`${col} = $${i++}`); vals.push(val); };

    if (req.body.role !== undefined) {
      if (!ROLES.includes(req.body.role)) {
        return res.status(400).json({ error: 'invalid role', allowed: ROLES });
      }
      set('role', req.body.role);
    }
    if (req.body.scope !== undefined) {
      if (!SCOPES.includes(req.body.scope)) {
        return res.status(400).json({ error: 'invalid scope', allowed: SCOPES });
      }
      set('scope', req.body.scope);
    }
    if (req.body.spend_cap !== undefined)    set('spend_cap', req.body.spend_cap);
    if (req.body.approval_cap !== undefined) set('approval_cap', req.body.approval_cap);
    if (req.body.is_active !== undefined)    set('is_active', !!req.body.is_active);

    try {
      // escalation change: must point at an assignment at the same property
      if (req.body.escalates_to_assignment_id !== undefined) {
        const target = req.body.escalates_to_assignment_id;
        if (target === null) {
          set('escalates_to_assignment_id', null);
        } else {
          const cur = await pool.query('SELECT property_id FROM assignments WHERE id = $1', [id]);
          if (cur.rowCount === 0) return res.status(404).json({ error: 'assignment not found' });
          const esc = await pool.query(
            'SELECT id FROM assignments WHERE id = $1 AND property_id = $2 AND is_active = TRUE',
            [target, cur.rows[0].property_id]
          );
          if (esc.rowCount === 0) {
            return res.status(400).json({
              error: 'escalates_to must be an active assignment at the same property'
            });
          }
          set('escalates_to_assignment_id', target);
        }
      }

      if (fields.length === 0) return res.status(400).json({ error: 'nothing to update' });

      vals.push(id);
      const upd = await pool.query(
        `UPDATE assignments SET ${fields.join(', ')} WHERE id = $${i} RETURNING *`,
        vals
      );
      if (upd.rowCount === 0) return res.status(404).json({ error: 'assignment not found' });
      return res.json(upd.rows[0]);
    } catch (e) {
      console.error('PATCH assignment error', e);
      return res.status(500).json({ error: 'internal error' });
    }
  });

  // ---- PUT /properties/:id/accountable ----------------------------
  // Designate WHICH assignment owns this property's truth.
  // (Designation, not a role. Must be an active assignment at this property.)
  app.put('/properties/:id/accountable', async (req, res) => {
    const property_id = req.params.id;
    const { assignment_id } = req.body || {};
    if (!assignment_id) return res.status(400).json({ error: 'assignment_id required' });
    try {
      const esc = await pool.query(
        'SELECT id FROM assignments WHERE id = $1 AND property_id = $2 AND is_active = TRUE',
        [assignment_id, property_id]
      );
      if (esc.rowCount === 0) {
        return res.status(400).json({
          error: 'accountable assignment must be an active assignment at this property'
        });
      }
      const upd = await pool.query(
        'UPDATE properties SET accountable_assignment_id = $1 WHERE id = $2 RETURNING id, accountable_assignment_id',
        [assignment_id, property_id]
      );
      if (upd.rowCount === 0) return res.status(404).json({ error: 'property not found' });
      return res.json(upd.rows[0]);
    } catch (e) {
      console.error('PUT accountable error', e);
      return res.status(500).json({ error: 'internal error' });
    }
  });

  return app;
}

module.exports = orgchart;
module.exports.ROLES = ROLES;
module.exports.SCOPES = SCOPES;
module.exports.ROLE_DEFAULTS = ROLE_DEFAULTS;
