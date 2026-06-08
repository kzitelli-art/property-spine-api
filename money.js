// ============================================================
// money.js — Accounting Truth at the Event (v2: staged approvals)
//
// THE MODEL (locked v2):
//   One money event → one obligation → the obligation ADVANCES through the
//   approval roles required for that event TYPE → when the last approver signs
//   AND all proof inputs are satisfied → obligation completes and the money
//   event flips to 'report_ready' (safe to roll into the P&L).
//
//   Source of truth = the money EVENT. Not the bank feed (verifies cash later),
//   not the monthly report (reads approved truth). Operating event creates the
//   accounting truth; the report is a read, not a reconstruction.
//
// THE LIFECYCLE:
//   unverified   — event captured, classification + proof owed
//   verified     — category confirmed by a human (proof half done)
//   report_ready — all required approvals landed; rolls into the report
//
// APPROVAL CHAIN (staged assignment, NOT separate obligations):
//   The event-type map defines the ORDERED roles required. The obligation is
//   always assigned to the CURRENT approver (approval_stage tracks who). When
//   the current approver signs off (/approve), money.js computes the next role
//   from the map, resolves it through the org chart + mapRole bridge, and calls
//   the SHARED reassignObligation helper. No next role + no proof outstanding →
//   completeObligation → report_ready. The engine always knows who it's waiting
//   on, because the obligation is literally assigned to them.
//
// Hard safety rules (unchanged):
//   - money-OUT only (amount > 0)         - manual entry only (no bank feed)
//   - AI/system never moves money          - no auto-approve; a human signs
//   - unconfirmed money stays quarantined  - never blends into reported totals
//
// Factory:
//   const money = require('./money');
//   app.use('/', money({ pool, spawnObligationFromEvent, satisfyObligation,
//                        completeObligation, reassignObligation }));
// ============================================================

// ---- plain-language operator categories (what the USER picks) -----
const WHAT_FOR = ['repair','turn','capex','billback','supply','cleaning','other'];

// ---- event TYPES — the kind of money movement (drives the approval chain) --
// Optional on create. If omitted, the event behaves like v1 (classification
// only, no approval chain) so nothing that exists today breaks.
const EVENT_TYPES = [
  'supply_run', 'vendor_payment', 'tenant_refund', 'security_deposit_return',
  'insurance_payment', 'tax_payment', 'loan_payment',
  'investor_distribution', 'owner_contribution',
];

// ---- THE APPROVAL MAP — encoded operator judgment -------------------
// event type -> ORDERED list of approver roles (org-chart role vocabulary).
// PM approval is ONLY for property-level operating activity. Distributions and
// owner/capital events deliberately DO NOT route through the property manager.
// Roles here are ORG-CHART roles; mapRole() bridges them to the obligation
// role_name enum at routing time.
const APPROVAL_CHAIN = {
  // property-level operating activity → PM owns it
  supply_run:              ['property_manager'],
  vendor_payment:          ['property_manager', 'bookkeeper'],
  tenant_refund:           ['property_manager', 'bookkeeper'],
  security_deposit_return: ['property_manager', 'bookkeeper'],
  // accounting-reviewed, owner VISIBILITY only (not in the approval chain) for now
  insurance_payment:       ['bookkeeper'],
  tax_payment:             ['bookkeeper'],
  loan_payment:            ['bookkeeper'],
  // owner / capital events → NO PM; accounting then owner
  investor_distribution:   ['bookkeeper', 'owner'],
  owner_contribution:      ['bookkeeper', 'owner'],
};

// ---- proof/classification inputs required before approvals matter ---
// These are the required_inputs on the obligation (proof half). Approvals are
// handled by staged assignment, NOT as required_inputs. Kept minimal in v2:
// the classification loop's two inputs, same as v1.
const PROOF_INPUTS = ['what_for', 'confirmed_category'];

// ---- org-chart role vocabulary → obligations.role_name enum ----------
// COPIED VERBATIM from turnovers.js — ONE bridge, not two. The org chart uses
// 'leasing'/'bookkeeper'; the obligation enum uses 'leasing_agent'/'accountant'.
// property_manager/maintenance/asset_manager/owner match in both.
function mapRole(orgRole) {
  const map = {
    property_manager: 'property_manager',
    maintenance: 'maintenance',
    leasing: 'leasing_agent',
    bookkeeper: 'accountant',
    asset_manager: 'asset_manager',
    owner: 'owner',
  };
  return map[orgRole] || 'property_manager';
}

// ---- the three-layer category derivation (unchanged from v1) --------
function proposeCategory({ what_for, unitOccupied }) {
  const direct = {
    capex:    'capital_expenditure',
    billback: 'tenant_billback',
    supply:   'operating_supplies',
    cleaning: 'repairs_maintenance',
  };
  if (direct[what_for]) return direct[what_for];
  if (what_for === 'repair') {
    return unitOccupied === false ? 'turnover' : 'repairs_maintenance';
  }
  if (what_for === 'turn') return 'turnover';
  return 'uncategorized';
}

function money({ pool, spawnObligationFromEvent, satisfyObligation, completeObligation, reassignObligation }) {
  const express = require('express');
  const app = express.Router();

  // ── resolve the assignment + escalation for a given ORG-CHART role at a
  //    property, returning obligation-enum roles. Used to route each approval
  //    stage. If nobody holds the role, we still return the mapped role string
  //    so the obligation lands in the right queue even before staffing exists.
  async function resolveRole(client, property_id, orgRole) {
    const mapped = mapRole(orgRole);
    // find an active assignment with this org-chart role at this property
    const a = await client.query(
      `SELECT id, escalates_to_assignment_id FROM assignments
        WHERE property_id = $1 AND role = $2 AND is_active = TRUE
        ORDER BY created_at LIMIT 1`,
      [property_id, orgRole]
    );
    let escalates_to_role = null;
    if (a.rowCount > 0 && a.rows[0].escalates_to_assignment_id) {
      const esc = await client.query(
        'SELECT role FROM assignments WHERE id = $1',
        [a.rows[0].escalates_to_assignment_id]
      );
      if (esc.rowCount > 0) escalates_to_role = mapRole(esc.rows[0].role);
    }
    return { assigned_role: mapped, escalates_to_role, assignment_id: a.rowCount ? a.rows[0].id : null };
  }

  // ── the approval chain for an event type (empty if none / unknown type) ──
  function chainFor(event_type) {
    return (event_type && APPROVAL_CHAIN[event_type]) ? APPROVAL_CHAIN[event_type] : [];
  }

  // ---- POST /money-events -----------------------------------------
  // Create a money-OUT event. Lands UNVERIFIED. Spawns ONE classification
  // obligation, assigned to the FIRST approver role in the event type's chain
  // (or, if no event_type / unknown, falls back to v1 routing: spender or
  // accountable owner). approval_stage records whose turn it is.
  app.post('/money-events', async (req, res) => {
    const { property_id, amount, event_type = null } = req.body || {};
    if (!property_id) return res.status(400).json({ error: 'property_id required' });
    const amt = Number(amount);
    if (!(amt > 0)) {
      return res.status(400).json({ error: 'amount must be a positive number (money-OUT only)' });
    }
    if (event_type && !EVENT_TYPES.includes(event_type)) {
      return res.status(400).json({ error: 'event_type must be one of', allowed: EVENT_TYPES });
    }

    const {
      unit_id = null, vendor = null, spent_by_person_id = null, occurred_on = null,
    } = req.body;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const prop = await client.query('SELECT id FROM properties WHERE id = $1', [property_id]);
      if (prop.rowCount === 0) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'property not found' }); }

      const chain = chainFor(event_type);

      // Decide routing + the first approval stage.
      //   • event_type with a chain → assign to the FIRST role in the chain.
      //   • no/unknown event_type   → v1 fallback (spender or accountable owner).
      // assignment_id = the specific org-chart assignment this routes to, written
      // onto the money event (assigned_assignment_id) like v1 did and the
      // ix_money_assignee index serves. Tracked through whichever path resolves.
      let assigned_role = null, escalates_to_role = null, firstStage = null, assignment_id = null;

      if (chain.length > 0) {
        const r = await resolveRole(client, property_id, chain[0]);
        assigned_role = r.assigned_role;
        escalates_to_role = r.escalates_to_role
          || (chain.length > 1 ? mapRole(chain[1]) : null);  // next in chain escalates
        firstStage = mapRole(chain[0]);
        assignment_id = r.assignment_id;   // may be null if the role isn't staffed yet
      } else {
        // v1 fallback routing — spender's own active assignment, else accountable owner
        if (spent_by_person_id) {
          const own = await client.query(
            `SELECT id, role, escalates_to_assignment_id FROM assignments
              WHERE property_id = $1 AND person_id = $2 AND is_active = TRUE
              ORDER BY created_at LIMIT 1`,
            [property_id, spent_by_person_id]
          );
          if (own.rowCount > 0) {
            assigned_role = mapRole(own.rows[0].role);
            assignment_id = own.rows[0].id;
            if (own.rows[0].escalates_to_assignment_id) {
              const esc = await client.query('SELECT role FROM assignments WHERE id = $1', [own.rows[0].escalates_to_assignment_id]);
              if (esc.rowCount > 0) escalates_to_role = mapRole(esc.rows[0].role);
            }
          }
        }
        if (!assigned_role) {
          const p = await client.query('SELECT accountable_assignment_id FROM properties WHERE id = $1', [property_id]);
          const accId = p.rows[0] ? p.rows[0].accountable_assignment_id : null;
          if (accId) {
            const acc = await client.query('SELECT id, role, escalates_to_assignment_id FROM assignments WHERE id = $1 AND is_active = TRUE', [accId]);
            if (acc.rowCount > 0) {
              assigned_role = mapRole(acc.rows[0].role);
              assignment_id = acc.rows[0].id;
              if (acc.rows[0].escalates_to_assignment_id) {
                const esc = await client.query('SELECT role FROM assignments WHERE id = $1', [acc.rows[0].escalates_to_assignment_id]);
                if (esc.rowCount > 0) escalates_to_role = mapRole(esc.rows[0].role);
              }
            }
          }
        }
      }

      // 1) insert the raw money event — unverified, unclassified
      const ins = await client.query(
        `INSERT INTO money_events
           (property_id, unit_id, amount, vendor, spent_by_person_id, occurred_on,
            source_kind, status, event_type, approval_stage, assigned_assignment_id, provenance)
         VALUES ($1,$2,$3,$4,$5,$6,'manual','unverified',$7,$8,$9,$10)
         RETURNING *`,
        [property_id, unit_id, amt, vendor, spent_by_person_id, occurred_on,
         event_type, firstStage, assignment_id, JSON.stringify({ source: 'manual_entry' })]
      );
      const ev = ins.rows[0];

      // 2) SOURCE EVENT — obligation must be born from an event
      const srcEv = await client.query(
        `INSERT INTO events (property_id, unit_id, type, note)
         VALUES ($1,$2,'money_out_logged',$3) RETURNING *`,
        [property_id, unit_id,
         `$${amt.toFixed(2)} money-out${vendor ? ' — ' + vendor : ''}${event_type ? ' [' + event_type + ']' : ''} (money_event ${ev.id})`]
      );
      const sourceEvent = srcEv.rows[0];

      // 3) spawn the obligation through the SHARED engine, assigned to the
      //    current approval stage (or fallback role). required_inputs = proof.
      let obligation = null;
      if (assigned_role && typeof spawnObligationFromEvent === 'function') {
        const amtLabel = `$${amt.toFixed(2)}`;
        obligation = await spawnObligationFromEvent(client, {
          property_id,
          unit_id: unit_id ?? null,
          source_event_id: sourceEvent.id,
          related_id: ev.id,
          related_type: 'money_event',
          module: 'money',
          type: event_type || 'classification',
          label: `Explain a ${amtLabel} expense${vendor ? ' — ' + vendor : ''}${event_type ? ' (' + event_type + ')' : ''}`,
          owner_type: 'human',
          assigned_role,
          escalates_to_role,
          status: 'open',
          priority: 'normal',   // engine now defaults to valid 'normal'; a $2 supply run isn't 'high'
          severity: 'normal',
          required_inputs: PROOF_INPUTS,
        });
        await client.query('UPDATE money_events SET obligation_id = $1 WHERE id = $2', [obligation.id, ev.id]);
        ev.obligation_id = obligation.id;
      }

      await client.query('COMMIT');

      return res.status(201).json({
        ...ev,
        obligation_id: obligation ? obligation.id : null,
        source_event_id: sourceEvent.id,
        assigned_role,
        approval_stage: firstStage,
        approval_chain: chain.length ? chain.map(mapRole) : null,
        note: !assigned_role
          ? 'Captured as UNVERIFIED, but no approver could be routed (no chain match and no accountable owner). Set an accountable owner or pass an event_type.'
          : (chain.length
              ? `Captured as UNVERIFIED. Obligation spawned and assigned to the first approver (${firstStage}). Approval chain: ${chain.map(mapRole).join(' → ')}.`
              : 'Captured as UNVERIFIED. Classification obligation spawned and routed by org chart (no event_type → v1 behavior).'),
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
  // Answer the plain questions; system PROPOSES a category. Satisfies the
  // obligation's `what_for` input via the SHARED helper. Does NOT verify or
  // advance approvals. (Unchanged from v1 except it tolerates the longer
  // lifecycle.)
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

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const upd = await client.query(
        `UPDATE money_events
            SET what_for = $1, completion = $2, receipt_note = $3, proposed_category = $4
          WHERE id = $5
          RETURNING *`,
        [what_for, completion, receipt_note, proposed, id]
      );
      if (upd.rowCount === 0) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'money event not found' }); }
      const ev = upd.rows[0];

      let obligationNote = null;
      if (ev.obligation_id && typeof satisfyObligation === 'function') {
        try {
          await satisfyObligation(client, {
            obligation_id: ev.obligation_id,
            input: 'what_for',
            proof: { what_for, completion, proposed_category: proposed },
          });
          obligationNote = 'Obligation input "what_for" satisfied.';
        } catch (e) {
          if (e.code === 'NOT_OUTSTANDING') obligationNote = 'Obligation input "what_for" was already satisfied.';
          else throw e;
        }
      }

      await client.query('COMMIT');
      return res.json({
        ...ev,
        note: `Proposed accounting category: "${proposed}". A human must CONFIRM (then approve) before this becomes report-ready.`,
        obligation_note: obligationNote,
      });
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      console.error('classify error', e);
      return res.status(500).json({ error: 'internal error' });
    } finally {
      client.release();
    }
  });

  // ---- POST /money-events/:id/confirm -----------------------------
  // A human confirms (or overrides) the category. Flips status → 'verified'
  // and satisfies the obligation's `confirmed_category` input (SHARED helper).
  // This is the PROOF half. It does NOT complete the obligation and does NOT
  // mark report_ready — approvals do that (see /approve). If the event has NO
  // approval chain (no event_type), confirm also completes + marks report_ready
  // (v1 behavior: classification-only events have nothing more to approve).
  app.post('/money-events/:id/confirm', async (req, res) => {
    const id = req.params.id;
    const { confirmed_by_person_id, confirmed_category = null } = req.body || {};
    if (!confirmed_by_person_id) {
      return res.status(400).json({ error: 'confirmed_by_person_id required — a human must confirm' });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const cur = await client.query(
        'SELECT proposed_category, what_for, obligation_id, event_type, approval_stage FROM money_events WHERE id = $1 FOR UPDATE',
        [id]
      );
      if (cur.rowCount === 0) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'money event not found' }); }

      if (!cur.rows[0].what_for) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          error: 'cannot confirm before classification',
          outstanding: ['what_for'],
          note: 'Run /classify first so there is something to confirm.',
        });
      }

      const finalCat = confirmed_category || cur.rows[0].proposed_category;
      const obligationId = cur.rows[0].obligation_id;
      const whatFor = cur.rows[0].what_for;
      const chain = chainFor(cur.rows[0].event_type);

      // satisfy both proof inputs (idempotent) through SHARED helpers
      if (obligationId && typeof satisfyObligation === 'function') {
        for (const [input, proof] of [
          ['what_for', { what_for: whatFor }],
          ['confirmed_category', { confirmed_category: finalCat, confirmed_by_person_id }],
        ]) {
          try {
            await satisfyObligation(client, { obligation_id: obligationId, input, proof });
          } catch (e) {
            if (e.code !== 'NOT_OUTSTANDING') throw e;
          }
        }
      }

      // If there's NO approval chain, confirm closes the loop (v1 behavior):
      // complete the obligation and mark report_ready. If there IS a chain,
      // we stop at 'verified' — the approval stages still have to sign off.
      let newStatus = 'verified';
      let obligationNote = 'Verified. Proof half done.';
      if (chain.length === 0 && obligationId && typeof completeObligation === 'function') {
        try {
          await completeObligation(client, { obligation_id: obligationId, completed_by: confirmed_by_person_id });
          newStatus = 'report_ready';
          obligationNote = 'No approval chain — obligation completed and money marked report_ready.';
        } catch (e) {
          if (e.code === 'ALREADY_COMPLETE') { newStatus = 'report_ready'; obligationNote = 'Obligation already complete.'; }
          else if (e.code === 'INPUTS_OUTSTANDING') { obligationNote = `Verified, but obligation has unexpected outstanding inputs: ${(e.outstanding_inputs || []).join(', ')}.`; }
          else throw e;
        }
      } else if (chain.length > 0) {
        obligationNote = `Verified. Now awaiting approval: ${chain.map(mapRole).join(' → ')}. Current stage: ${cur.rows[0].approval_stage}.`;
      }

      const upd = await client.query(
        `UPDATE money_events
            SET confirmed_category = $1, status = $2,
                verified_by_person_id = $3, verified_at = now()
          WHERE id = $4
          RETURNING *`,
        [finalCat, newStatus, confirmed_by_person_id, id]
      );

      await client.query('COMMIT');
      return res.json({
        ...upd.rows[0],
        note: newStatus === 'report_ready'
          ? 'Report-ready. This event is approved truth and rolls into the report.'
          : 'Verified. Category confirmed — approval chain still pending before report-ready.',
        obligation_note: obligationNote,
      });
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      console.error('confirm error', e);
      return res.status(500).json({ error: 'internal error' });
    } finally {
      client.release();
    }
  });

  // ---- POST /money-events/:id/approve -----------------------------
  // The CURRENT approver signs off. Advances the approval chain:
  //   • records the approval as a durable event
  //   • computes the NEXT role from the event type's chain
  //   • if there's a next role → reassign the obligation to it (SHARED helper),
  //     update approval_stage
  //   • if no next role AND proof inputs are satisfied → complete the obligation
  //     (SHARED helper) and flip the money event to 'report_ready'
  //
  // Body: { approved_by_person_id }   (a human must sign — no auto-approve)
  app.post('/money-events/:id/approve', async (req, res) => {
    const id = req.params.id;
    const { approved_by_person_id } = req.body || {};
    if (!approved_by_person_id) {
      return res.status(400).json({ error: 'approved_by_person_id required — a human must approve' });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const cur = await client.query(
        `SELECT id, property_id, status, event_type, approval_stage, obligation_id
           FROM money_events WHERE id = $1 FOR UPDATE`,
        [id]
      );
      if (cur.rowCount === 0) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'money event not found' }); }
      const m = cur.rows[0];

      const chain = chainFor(m.event_type);
      if (chain.length === 0) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'this money event has no approval chain (no event_type). Use /confirm to close it.' });
      }
      if (m.status === 'report_ready') {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'already report_ready — approval chain is complete' });
      }
      if (!m.approval_stage) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'no active approval stage — confirm the category first (/confirm)' });
      }

      // where are we in the chain? approval_stage is the mapped (enum) role.
      const mappedChain = chain.map(mapRole);
      const idx = mappedChain.indexOf(m.approval_stage);
      if (idx === -1) {
        await client.query('ROLLBACK');
        return res.status(500).json({ error: 'approval_stage not found in chain — data anomaly', approval_stage: m.approval_stage, chain: mappedChain });
      }

      // record this approval as a durable event
      await client.query(
        `INSERT INTO events (property_id, type, note)
         VALUES ($1,'money_approved',$2)`,
        [m.property_id, `${m.event_type} stage ${m.approval_stage} approved by ${approved_by_person_id} (money_event ${id})`]
      );

      const nextOrgRole = (idx + 1 < chain.length) ? chain[idx + 1] : null;

      let result;
      if (nextOrgRole) {
        // advance: reassign the obligation to the next approver via SHARED helper
        const nextMapped = mapRole(nextOrgRole);
        const afterNext = (idx + 2 < chain.length) ? mapRole(chain[idx + 2]) : null;
        if (m.obligation_id && typeof reassignObligation === 'function') {
          await reassignObligation(client, {
            obligation_id: m.obligation_id,
            assigned_role: nextMapped,
            escalates_to_role: afterNext,
            reason: `approval advanced from ${m.approval_stage}`,
            reassigned_by: approved_by_person_id,
          });
        }
        await client.query('UPDATE money_events SET approval_stage = $1 WHERE id = $2', [nextMapped, id]);
        result = { advanced_to: nextMapped, report_ready: false,
          note: `Approved at ${m.approval_stage}. Obligation reassigned to ${nextMapped}.` };
      } else {
        // last approver — complete the obligation (proof gate enforced) + report_ready
        let obligationNote = null, becameReady = false;
        if (m.obligation_id && typeof completeObligation === 'function') {
          try {
            await completeObligation(client, { obligation_id: m.obligation_id, completed_by: approved_by_person_id });
            becameReady = true;
            obligationNote = 'Final approval — obligation completed.';
          } catch (e) {
            if (e.code === 'ALREADY_COMPLETE') { becameReady = true; obligationNote = 'Obligation already complete.'; }
            else if (e.code === 'INPUTS_OUTSTANDING') {
              // proof half not done — can't go report_ready yet. Refuse cleanly.
              await client.query('ROLLBACK');
              return res.status(409).json({
                error: 'cannot finalize — proof still outstanding on the obligation',
                outstanding: e.outstanding_inputs,
                hint: 'classify + confirm the category before final approval',
              });
            } else throw e;
          }
        }
        if (becameReady) {
          await client.query(
            `UPDATE money_events SET status = 'report_ready', approval_stage = NULL WHERE id = $1`,
            [id]
          );
        }
        result = { advanced_to: null, report_ready: becameReady, obligation_note: obligationNote,
          note: becameReady ? 'Final approval landed. Money event is REPORT-READY.' : 'Approval recorded.' };
      }

      await client.query('COMMIT');
      const out = await pool.query('SELECT * FROM money_events WHERE id = $1', [id]);
      return res.json({ ...out.rows[0], ...result });
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      console.error('approve error', e);
      return res.status(500).json({ error: 'internal error' });
    } finally {
      client.release();
    }
  });

  // ---- GET /properties/:id/money-events ---------------------------
  // List money events for a property, split by lifecycle. report_ready is the
  // ONLY tier that counts as reportable truth.
  app.get('/properties/:id/money-events', async (req, res) => {
    const property_id = req.params.id;
    try {
      const rows = await pool.query(
        `SELECT m.*, p.name AS spent_by_name
           FROM money_events m
           LEFT JOIN persons p ON p.id = m.spent_by_person_id
          WHERE m.property_id = $1
          ORDER BY (m.status = 'unverified') DESC, (m.status = 'verified') DESC, m.created_at DESC`,
        [property_id]
      );
      const unverified  = rows.rows.filter(r => r.status === 'unverified');
      const verified    = rows.rows.filter(r => r.status === 'verified');
      const reportReady = rows.rows.filter(r => r.status === 'report_ready');
      return res.json({
        unverified_queue: unverified,       // proof owed — quarantined
        awaiting_approval: verified,        // confirmed, approval chain pending — quarantined
        report_ready: reportReady,          // approved truth — rolls into the report
        summary: {
          unverified_count: unverified.length,
          awaiting_approval_count: verified.length,
          report_ready_count: reportReady.length,
          // ONLY report_ready is reportable truth. Everything else is quarantined.
          report_ready_total: reportReady.reduce((s, r) => s + Number(r.amount), 0),
          quarantined_total: [...unverified, ...verified].reduce((s, r) => s + Number(r.amount), 0),
        },
      });
    } catch (e) {
      console.error('GET money-events error', e);
      return res.status(500).json({ error: 'internal error' });
    }
  });

  // ---- GET /money-review ------------------------------------------
  // "Money to Review" queue, role-filtered by who's owed the next approval.
  //   ?role=property_manager|accountant|owner   (obligation-enum role)
  //   ?property_id=<uuid>  (optional scope)
  // Reads off approval_stage — the obligation is literally assigned to this
  // role, so this is the honest "what's waiting on me" list.
  app.get('/money-review', async (req, res) => {
    const { role, property_id } = req.query;
    if (!role) return res.status(400).json({ error: 'role query param required (e.g. accountant, property_manager, owner)' });
    try {
      const vals = [role];
      let sql = `SELECT m.*, p.name AS property_name
                   FROM money_events m
                   LEFT JOIN properties p ON p.id = m.property_id
                  WHERE m.approval_stage = $1 AND m.status = 'verified'`;
      if (property_id) { vals.push(property_id); sql += ` AND m.property_id = $${vals.length}`; }
      sql += ' ORDER BY m.created_at ASC';
      const rows = await pool.query(sql, vals);
      return res.json({
        role,
        count: rows.rows.length,
        awaiting_your_approval: rows.rows,
        note: 'Each item is verified (category confirmed) and assigned to your role for the next approval. Approve via POST /money-events/:id/approve.',
      });
    } catch (e) {
      console.error('GET money-review error', e);
      return res.status(500).json({ error: 'internal error' });
    }
  });

  // ---- GET /properties/:id/report-read?month=YYYY-MM --------------
  // MONEY REPORT READ v1 — read-only. Mutates NOTHING.
  //
  // Rolls ONLY report_ready money events into report totals, grouped by the
  // category_report_map (migration 008). The report SHAPE is data, not code.
  //
  // HONEST SCOPE (locked): money_events only. money_events is money-OUT plus
  // any billback events; rental income lives in the revenue tables and is NOT
  // read here. So Income is empty except billbacks, and this is NOT the final
  // monthly P&L. The gap is made visible, never hidden.
  //
  // Rules enforced:
  //   1. Only status='report_ready' events hit report totals.
  //   2. Unverified / verified (not-ready) money is EXCLUDED, shown separately.
  //   3. Capex sits BELOW NOI in its own section (never depresses NOI).
  //   4. Unmapped confirmed_categories are surfaced separately, never guessed.
  //   5. NOI and Net Income are COMPUTED, not stored.
  app.get('/properties/:id/report-read', async (req, res) => {
    const property_id = req.params.id;
    const month = req.query.month;

    // month must be YYYY-MM
    if (!month || !/^\d{4}-\d{2}$/.test(month)) {
      return res.status(400).json({ error: "month query param required as YYYY-MM (e.g. 2026-02)" });
    }
    const monthStart = `${month}-01`;

    try {
      const prop = await pool.query('SELECT id, name FROM properties WHERE id = $1', [property_id]);
      if (prop.rowCount === 0) return res.status(404).json({ error: 'property not found' });

      // The economic date is occurred_on; fall back to created_at when null.
      // Month window: [monthStart, monthStart + 1 month).
      const dateExpr = 'COALESCE(m.occurred_on, m.created_at::date)';
      const monthFilter = `${dateExpr} >= $2::date AND ${dateExpr} < ($2::date + interval '1 month')`;

      // 1) report_ready events in-month, joined to the mapping table.
      const ready = await pool.query(
        `SELECT m.id, m.amount, m.confirmed_category,
                cm.report_section, cm.report_line, cm.sort_order
           FROM money_events m
           LEFT JOIN category_report_map cm
             ON cm.confirmed_category = m.confirmed_category
          WHERE m.property_id = $1
            AND m.status = 'report_ready'
            AND ${monthFilter}`,
        [property_id, monthStart]
      );

      // 2) excluded (not-ready) money in-month — quarantined, shown separately.
      const excluded = await pool.query(
        `SELECT m.status, COUNT(*)::int AS count, COALESCE(SUM(m.amount),0)::numeric AS total
           FROM money_events m
          WHERE m.property_id = $1
            AND m.status IN ('unverified','verified')
            AND ${monthFilter}
          GROUP BY m.status`,
        [property_id, monthStart]
      );

      // 3) open money-obligations count (proof/approval still owed, any month).
      const openObl = await pool.query(
        `SELECT COUNT(*)::int AS n
           FROM obligations
          WHERE property_id = $1 AND module = 'money' AND status = 'open'`,
        [property_id]
      );

      // ---- the Tower T12 report SKELETON (section + line order) -------
      // Lines render even at $0 so the report shape is honest and the gaps
      // (categories that don't exist yet, rent income that lives elsewhere)
      // are VISIBLE, not hidden. Seeded mapping rows land their totals onto
      // matching {section,line}; everything else stays $0.
      const SKELETON = [
        { section: 'Income', sort: 10, lines: [
          { line: 'Residential Rent', note: 'lives in revenue tables — not read in v1' },
          { line: 'Other Income' },
          { line: 'Billbacks / Utility Income' },
        ]},
        { section: 'Operating Expenses', sort: 20, lines: [
          { line: 'Payroll' },
          { line: 'Taxes & Insurance' },
          { line: 'Utilities' },
          { line: 'Repair & Maintenance' },
          { line: 'Building Services / Contracted Services' },
          { line: 'Administration & General' },
          { line: 'Advertising & Marketing' },
        ]},
        { section: 'Capital Expenditures', sort: 60, lines: [
          { line: 'CapEx' },
        ]},
        { section: 'Debt Service / Interest', sort: 70, lines: [
          { line: 'Debt Service / Interest' },
        ]},
        { section: 'Depreciation / Amortization', sort: 80, lines: [
          { line: 'Depreciation / Amortization' },
        ]},
      ];

      // ---- fold the report_ready rows into section/line totals ----
      const num = (x) => Number(x) || 0;
      // lineAmounts: "section\u0000line" -> summed amount
      const lineAmounts = {};
      const categoryTotals = {};      // confirmed_category -> amount (underlying truth)
      const unmappedMap = {};         // confirmed_category -> {amount, count}
      let reportReadyCount = 0;

      const lineKey = (sec, line) => `${sec}\u0000${line}`;

      for (const r of ready.rows) {
        reportReadyCount += 1;
        const amt = num(r.amount);
        const cat = r.confirmed_category || '(null category)';
        categoryTotals[cat] = (categoryTotals[cat] || 0) + amt;

        if (!r.report_section) {
          // report_ready but no mapping row → needs review. Never guess.
          if (!unmappedMap[cat]) unmappedMap[cat] = { confirmed_category: cat, amount: 0, count: 0 };
          unmappedMap[cat].amount += amt;
          unmappedMap[cat].count += 1;
          continue;
        }
        lineAmounts[lineKey(r.report_section, r.report_line)] =
          (lineAmounts[lineKey(r.report_section, r.report_line)] || 0) + amt;
      }

      // shape the skeleton, dropping mapped totals onto matching lines.
      // A mapped {section,line} that isn't in the skeleton is still shown
      // (appended) so nothing seeded ever silently vanishes.
      const seenLineKeys = new Set();
      const sectionsOut = SKELETON.map(s => {
        const lines = s.lines.map(l => {
          const k = lineKey(s.section, l.line);
          seenLineKeys.add(k);
          const out = { report_line: l.line, amount: lineAmounts[k] || 0 };
          if (l.note) out.note = l.note;
          return out;
        });
        const total = lines.reduce((sum, l) => sum + l.amount, 0);
        return { section: s.section, sort: s.sort, total, lines };
      });
      // append any mapped line that wasn't in the skeleton (mapping/skeleton drift guard)
      for (const k of Object.keys(lineAmounts)) {
        if (seenLineKeys.has(k)) continue;
        const [sec, line] = k.split('\u0000');
        let target = sectionsOut.find(s => s.section === sec);
        if (!target) { target = { section: sec, sort: 999, total: 0, lines: [] }; sectionsOut.push(target); }
        target.lines.push({ report_line: line, amount: lineAmounts[k], note: 'mapped but not in v1 skeleton' });
        target.total += lineAmounts[k];
      }
      sectionsOut.sort((a, b) => a.sort - b.sort);
      sectionsOut.forEach(s => delete s.sort);

      const sectionTotal = (name) => {
        const s = sectionsOut.find(x => x.section === name);
        return s ? s.total : 0;
      };

      // ---- computed P&L spine (v1: most of this is $0 by design) ----
      // money_events carries expenses + billbacks. Income = billbacks only here.
      const income      = sectionTotal('Income');
      const opex        = sectionTotal('Operating Expenses');
      const debtService = sectionTotal('Debt Service / Interest');   // empty in v1
      const da          = sectionTotal('Depreciation / Amortization'); // empty in v1
      const capex       = sectionTotal('Capital Expenditures');       // below NOI
      const noi         = income - opex;
      const netIncome   = noi - debtService - da;

      // ---- excluded / unmapped surfaces ----
      const excludedByStatus = {};
      let excludedTotal = 0, excludedCount = 0;
      for (const r of excluded.rows) {
        excludedByStatus[r.status] = { count: r.count, total: num(r.total) };
        excludedTotal += num(r.total);
        excludedCount += r.count;
      }
      const unmappedCategories = Object.values(unmappedMap);

      // ---- status of the read ----
      // blocked  : nothing report_ready to read this month
      // needs_mapping: report_ready money exists but some categories are unmapped
      // ready    : everything report_ready is mapped
      let status;
      if (reportReadyCount === 0) status = 'blocked';
      else if (unmappedCategories.length > 0) status = 'needs_mapping';
      else status = 'ready';

      return res.json({
        report: 'Money Report Read v1',
        disclaimer: 'NOT the final full monthly P&L. Rental income is not included — it lives in the revenue tables, which v1 does not read.',
        income_scope: 'money_events_only',
        excluded_sources: ['revenue_tables_not_included_v1'],

        property_id,
        property_name: prop.rows[0].name,
        month,
        status,

        // computed P&L spine (sections that have no money_events show $0 by design)
        spine: {
          income,
          operating_expenses: opex,
          noi,                       // computed: income - operating_expenses
          capital_expenditures: capex, // BELOW NOI, its own section
          debt_service_interest: debtService,
          depreciation_amortization: da,
          net_income: netIncome,     // computed: noi - debt_service - d&a
        },

        // the report shaped by the mapping table (data-driven, sorted)
        sections: sectionsOut,

        // underlying category truth (the input the mapping folded)
        category_totals: categoryTotals,

        // never hidden, never guessed:
        unmapped_categories: unmappedCategories,
        excluded: {
          total: excludedTotal,
          count: excludedCount,
          by_status: excludedByStatus,   // { unverified: {...}, verified: {...} }
          note: 'Not report_ready — quarantined out of all totals above.',
        },

        // operational signals
        report_ready_event_count: reportReadyCount,
        open_money_obligations: openObl.rows[0].n,
      });
    } catch (e) {
      console.error('report-read error', e);
      return res.status(500).json({ error: 'internal error' });
    }
  });

  return app;
}

module.exports = money;
module.exports.WHAT_FOR = WHAT_FOR;
module.exports.EVENT_TYPES = EVENT_TYPES;
module.exports.APPROVAL_CHAIN = APPROVAL_CHAIN;
module.exports.proposeCategory = proposeCategory;
module.exports.mapRole = mapRole;
