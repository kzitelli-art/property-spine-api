// ============================================================
// property_surface.js — THE PROPERTY SURFACE (control surface for one asset)
//
// Not a dashboard. One property. One truth state. One next action.
// Answers exactly four things:
//   Where am I?  → identity (name, snapshot, source, as-of)
//   What is true? → occupancy, rent in place, AR exposure (from snapshot)
//   What is missing? → each lens says what it knows or what's not loaded
//   What's next? → the single largest blocker to operating truth
//
// HARD RULES:
//   - Leasing model comes from deal_registry, NEVER inferred from data.
//   - AR exposure = GROSS positive balances owed (never netted).
//   - No NOI/profitability (money layer not loaded yet).
//   - No fake fullness: a lens with nothing loaded says so plainly.
//   - No cross-module borrowing: this reads only this property's snapshot.
//
// GET /properties/:id/surface        (by property uuid)
// GET /deals                          (the six deals + load state, for the picker)
// ============================================================

const { DEALS, byPropertyId, byCanonical } = require("../onboarding/deal_registry");

module.exports = function propertySurface(deps) {
  const express = require("express");
  const router = express.Router();
  const { pool } = deps;
  if (!pool) throw new Error("property_surface requires a pool");

  // ── the six deals + whether each has a loaded snapshot (for the picker) ──
  router.get("/deals", async (_req, res) => {
    try {
      // find loaded snapshot batches, map to deals by property_id or canonical
      const batches = (await pool.query(
        `select b.property_id, b.source_file, b.source_as_of_date, p.canonical_key, p.name as property_name
           from import_batches b join properties p on p.id=b.property_id
          where b.source_type='historical_snapshot'
          order by b.loaded_at desc`)).rows;

      const loadedByCanon = new Map();
      const loadedByPid = new Map();
      for (const b of batches) {
        if (b.canonical_key && !loadedByCanon.has(b.canonical_key)) loadedByCanon.set(b.canonical_key, b);
        if (b.property_id && !loadedByPid.has(b.property_id)) loadedByPid.set(b.property_id, b);
      }

      const deals = DEALS.map(d => {
        const b = (d.property_id && loadedByPid.get(d.property_id)) || loadedByCanon.get(d.canonical_key) || null;
        return {
          key: d.key, name: d.name, model: d.model, canonical_key: d.canonical_key,
          property_id: b?.property_id || d.property_id || null,
          loaded: !!b,
          truth_state: b ? "Historical Snapshot" : "Historical snapshot not loaded yet",
          source_file: b?.source_file || null,
          source_as_of_date: b?.source_as_of_date || null,
        };
      });
      res.json({ deals });
    } catch (e) {
      console.error("/deals error:", e);
      res.status(500).json({ error: "deals_failed", detail: e.message });
    }
  });

  // ── the surface for one property ──
  router.get("/properties/:id/surface", async (req, res) => {
    const propertyId = req.params.id;
    const client = await pool.connect();
    try {
      // identity from registry (model is fixed here)
      const propRow = (await client.query("select id, name, canonical_key from properties where id=$1", [propertyId])).rows[0];
      const deal = byPropertyId(propertyId) || (propRow && byCanonical(propRow.canonical_key)) || null;
      const model = deal?.model || null;   // NEVER inferred — if unknown, say so
      const displayName = deal?.name || propRow?.name || "Property";

      // the snapshot batch for this property
      const batch = (await client.query(
        `select id, source_file, source_as_of_date, leasing_model
           from import_batches
          where property_id=$1 and source_type='historical_snapshot'
          order by loaded_at desc limit 1`, [propertyId])).rows[0];

      if (!batch) {
        return res.json({
          property_id: propertyId, name: displayName, model,
          loaded: false,
          truth_state: "Historical snapshot not loaded yet",
          where_am_i: { name: displayName, snapshot: null, source: null, as_of: null },
          lenses: lensesEmpty(),
          next_action: { label: "Load historical snapshot", reason: "No snapshot loaded for this property yet." },
        });
      }

      // ── compute truth from the snapshot, by the STORED model ──
      const rows = (await client.query(
        `select u.unit_number, u.market_rent,
                s.id as space_id, s.space_label,
                cur.id as cur_id, cur.rent as cur_rent, cur.balance as cur_balance,
                cur.lease_status as cur_status, cur.end_date as cur_end,
                curp.name as cur_tenant,
                fut.id as fut_id
           from units u
           join spaces s on s.unit_id=u.id
           left join lateral (select l.* from leases l
              where l.space_id=s.id and l.lease_status in ('active','commercial')
              order by l.start_date desc nulls last limit 1) cur on true
           left join lateral (select pe.name from persons pe where pe.id = any(cur.tenant_ids) limit 1) curp on true
           left join lateral (select l.id from leases l
              where l.space_id=s.id and l.lease_status='pending' limit 1) fut on true
          where u.property_id=$1`, [propertyId])).rows;

      const NONREV = /model|down|offline/i;
      let occupied=0, vacant=0, commercial=0, down=0, model_units=0, rentInPlace=0, future=0;
      const owed=[];
      const unitSet = new Set();
      for (const r of rows) {
        unitSet.add(r.unit_number);
        const status = (r.cur_status||"").toLowerCase();
        const isNonRev = NONREV.test(r.space_label||"") || NONREV.test(r.cur_tenant||"");
        if (r.fut_id) future++;
        if (isNonRev) {
          if (/down|offline/i.test(r.space_label||"") || /down|offline/i.test(r.cur_tenant||"")) down++; else model_units++;
          continue;
        }
        if (status === "commercial") { commercial++; rentInPlace += Number(r.cur_rent||0); if(Number(r.cur_balance||0)>0) owed.push(Number(r.cur_balance)); continue; }
        if (r.cur_id) { occupied++; rentInPlace += Number(r.cur_rent||0); if(Number(r.cur_balance||0)>0) owed.push(Number(r.cur_balance)); }
        else vacant++;
      }

      // count by the STORED model: bed = spaces, unit = units
      const totalSpaces = rows.length;
      const totalUnits = unitSet.size;
      const denom = model === "bed" ? (totalSpaces - down - model_units) : (totalUnits - countNonRevUnits(rows, NONREV));
      const occupiedCount = occupied + commercial;
      const occPct = denom ? Math.round(occupiedCount / denom * 1000) / 10 : null;
      const arExposure = owed.reduce((a,b)=>a+b,0);   // GROSS
      const countNoun = model === "bed" ? "beds" : "units";

      // ── the ONE next action: largest blocker to operating truth ──
      // Snapshot gives occupancy/rent/AR. The biggest missing proof is CASH —
      // bank activity, AP, NOI are not loaded. That gap dominates "review vacancy".
      const next_action = {
        label: "Load money proof",
        reason: "Occupancy and rent-roll truth are known from the snapshot, but cash, bank activity, AP, and NOI are not proven yet. The largest gap to operating truth is money.",
      };

      res.json({
        property_id: propertyId,
        name: displayName,
        model,
        loaded: true,
        truth_state: "Historical Snapshot",
        where_am_i: {
          name: displayName,
          snapshot: "Historical Snapshot",
          source: batch.source_file,
          as_of: batch.source_as_of_date,
        },
        what_is_true: {
          occupied: occupiedCount,
          denom,
          count_noun: countNoun,
          occupancy_pct: occPct,
          vacant,
          down, model_units, commercial,
          rent_in_place: Math.round(rentInPlace),
          ar_exposure: Math.round(arExposure),
          ar_accounts: owed.length,
        },
        lenses: {
          leasing:   { knows: true,  line: `${occupiedCount} of ${denom} ${countNoun} occupied · ${future} future signed`, clickable: true },
          maintenance:{ knows: false, line: "No work orders loaded from this snapshot", clickable: false },
          money:     { knows: "partial", line: `AR loaded from rent roll ($${Math.round(arExposure).toLocaleString()}) · bank proof not loaded`, clickable: false },
          reporting: { knows: false, line: "Not ready · money proof missing", clickable: false },
        },
        next_action,
      });
    } catch (e) {
      console.error("surface error:", e);
      res.status(500).json({ error: "surface_failed", detail: e.message });
    } finally {
      client.release();
    }
  });

  return router;
};

function lensesEmpty(){
  return {
    leasing:    { knows: false, line: "No snapshot loaded", clickable: false },
    maintenance:{ knows: false, line: "No work orders loaded", clickable: false },
    money:      { knows: false, line: "No money loaded", clickable: false },
    reporting:  { knows: false, line: "Not ready", clickable: false },
  };
}

// count units that are entirely non-revenue (all their spaces are down/model)
function countNonRevUnits(rows, NONREV){
  const byUnit = new Map();
  for (const r of rows) {
    const nonRev = NONREV.test(r.space_label||"") || NONREV.test(r.cur_tenant||"");
    if (!byUnit.has(r.unit_number)) byUnit.set(r.unit_number, true);
    if (!nonRev) byUnit.set(r.unit_number, false);
  }
  let n=0; for (const v of byUnit.values()) if (v) n++; return n;
}
