// ============================================================
// leasing_detail.js — SOLO / LEASING (scoped leasing truth, one layer deeper)
//
// This is NOT a leasing dashboard. It is the property surface opened one
// layer down: what does the rent-roll snapshot prove about leasing?
//
// SCOPE DISCIPLINE (the guardrail): every number is tied to ONE batch —
//   property_id + import_batch_id + leasing_model + source_as_of_date.
// The front end reads this scoped payload, never cached leasing data.
//
// Leasing model comes from deal_registry (stored), NEVER inferred.
//
// Returns, in the locked order:
//   identity (name, snapshot, source, as_of, model)
//   headline (occupied/total, vacant, future, rent in place, gross balance)
//   known / missing (plain honest text; "snapshot vacancy" not "current")
//   vacant_units      — the current hole (active section)
//   future_signed     — does the hole close? (clearly separated, not current)
//   balance_exposure  — top owed + aggregate (money exposure from rent roll)
//   occupied_units    — evidence (collapsed in UI)
//   full_rent_roll    — auditability (collapsed in UI)
//
// GET /properties/:id/leasing
// ============================================================

const { byPropertyId, byCanonical } = require("./deal_registry");

module.exports = function leasingDetail(deps) {
  const express = require("express");
  const router = express.Router();
  const { pool } = deps;
  if (!pool) throw new Error("leasing_detail requires a pool");

  router.get("/properties/:id/leasing", async (req, res) => {
    const propertyId = req.params.id;
    const client = await pool.connect();
    try {
      const propRow = (await client.query("select id, name, canonical_key from properties where id=$1", [propertyId])).rows[0];
      const deal = byPropertyId(propertyId) || (propRow && byCanonical(propRow.canonical_key)) || null;
      const model = deal?.model || null;       // stored, never inferred
      const name = deal?.name || propRow?.name || "Property";

      const batch = (await client.query(
        `select id, source_file, source_as_of_date, leasing_model
           from import_batches
          where property_id=$1 and source_type='historical_snapshot'
          order by loaded_at desc limit 1`, [propertyId])).rows[0];

      if (!batch) {
        return res.json({
          property_id: propertyId, name, model, loaded: false,
          truth_state: "Historical snapshot not loaded yet",
          scope: { property_id: propertyId, import_batch_id: null, leasing_model: model, source_as_of_date: null, data_mode: "historical_snapshot" },
        });
      }

      const batchId = batch.id;

      // every space in THIS batch with its current/future lease — scoped to batch
      const rows = (await client.query(
        `select u.unit_number, u.market_rent, u.square_feet,
                s.id as space_id, s.space_label,
                cur.id as cur_id, cur.rent as cur_rent, cur.balance as cur_balance,
                cur.lease_status as cur_status, cur.start_date as cur_start, cur.end_date as cur_end,
                curp.name as cur_tenant,
                fut.id as fut_id, fut.start_date as fut_start, fut.end_date as fut_end,
                futp.name as fut_tenant
           from units u
           join spaces s on s.unit_id=u.id
           left join lateral (select l.* from leases l
              where l.space_id=s.id and l.lease_status in ('active','commercial')
              order by l.start_date desc nulls last limit 1) cur on true
           left join lateral (select pe.name from persons pe where pe.id = any(cur.tenant_ids) limit 1) curp on true
           left join lateral (select l.* from leases l
              where l.space_id=s.id and l.lease_status='pending'
              order by l.start_date asc nulls last limit 1) fut on true
           left join lateral (select pe.name from persons pe where pe.id = any(fut.tenant_ids) limit 1) futp on true
          where u.property_id=$1 and u.import_batch_id=$2`, [propertyId, batchId])).rows;

      const NONREV = /model|down|offline/i;
      const vacant=[], occupied=[], future=[], balances=[], fullRoll=[];
      let rentInPlace=0, commercial=0, down=0, modelUnits=0;
      const unitSet = new Set();

      for (const r of rows) {
        unitSet.add(r.unit_number);
        const status = (r.cur_status||"").toLowerCase();
        const isNonRev = NONREV.test(r.space_label||"") || NONREV.test(r.cur_tenant||"");
        const noun = model === "bed" ? (r.space_label || r.unit_number) : r.unit_number;

        // future (separate truth, never current)
        if (r.fut_id) {
          future.push({
            unit: r.unit_number, space: model==="bed"?r.space_label:null,
            tenant: r.fut_tenant || null,
            start: r.fut_start || null, end: r.fut_end || null,
          });
        }

        if (isNonRev) {
          if (/down|offline/i.test(r.space_label||"") || /down|offline/i.test(r.cur_tenant||"")) down++; else modelUnits++;
          fullRoll.push({ unit: r.unit_number, space: model==="bed"?r.space_label:null, status: /down/i.test(r.cur_tenant||r.space_label||"")?"DOWN":"MODEL", tenant:null, rent:0, balance:0 });
          continue;
        }
        if (status === "commercial") {
          commercial++; rentInPlace += Number(r.cur_rent||0);
          if (Number(r.cur_balance||0) > 0) balances.push({ unit:r.unit_number, tenant:r.cur_tenant||"Commercial", balance:Number(r.cur_balance), commercial:true });
          occupied.push({ unit:r.unit_number, space:null, tenant:r.cur_tenant||"Commercial", rent:Number(r.cur_rent||0), end:r.cur_end||null, commercial:true });
          fullRoll.push({ unit:r.unit_number, space:null, status:"COMMERCIAL", tenant:r.cur_tenant||"Commercial", rent:Number(r.cur_rent||0), balance:Number(r.cur_balance||0) });
          continue;
        }
        if (r.cur_id) {
          occupied.push({ unit:r.unit_number, space:model==="bed"?r.space_label:null, tenant:r.cur_tenant||"—", rent:Number(r.cur_rent||0), end:r.cur_end||null });
          rentInPlace += Number(r.cur_rent||0);
          if (Number(r.cur_balance||0) > 0) balances.push({ unit:r.unit_number, tenant:r.cur_tenant||"—", balance:Number(r.cur_balance) });
          fullRoll.push({ unit:r.unit_number, space:model==="bed"?r.space_label:null, status:"OCCUPIED", tenant:r.cur_tenant||"—", rent:Number(r.cur_rent||0), balance:Number(r.cur_balance||0) });
        } else {
          vacant.push({ unit:r.unit_number, space:model==="bed"?r.space_label:null, market:Number(r.market_rent||0) });
          fullRoll.push({ unit:r.unit_number, space:model==="bed"?r.space_label:null, status:"VACANT", tenant:null, rent:0, balance:0 });
        }
      }

      const totalSpaces = rows.length;
      const totalUnits = unitSet.size;
      const denom = model === "bed" ? (totalSpaces - down - modelUnits) : (totalUnits - nonRevUnits(rows, NONREV));
      const occupiedCount = occupied.length;   // includes commercial
      const countNoun = model === "bed" ? "beds" : "units";

      // balance exposure: gross owed, top first
      const owed = balances.filter(b => b.balance > 0).sort((a,b)=>b.balance-a.balance);
      const grossOwed = owed.reduce((s,b)=>s+b.balance, 0);

      // sort vacant + occupied for clean lists
      const sortUnit = (a,b)=> String(a.unit).localeCompare(String(b.unit), undefined, {numeric:true});
      vacant.sort(sortUnit); occupied.sort(sortUnit); future.sort(sortUnit); fullRoll.sort(sortUnit);

      res.json({
        property_id: propertyId,
        name, model, loaded: true,
        truth_state: "Historical Snapshot",
        scope: {
          property_id: propertyId,
          import_batch_id: batchId,
          leasing_model: model,
          source_as_of_date: batch.source_as_of_date,
          data_mode: "historical_snapshot",
        },
        identity: {
          name, snapshot: "Historical Snapshot",
          source: batch.source_file, as_of: batch.source_as_of_date,
        },
        headline: {
          occupied: occupiedCount,
          denom,
          count_noun: countNoun,
          occupancy_pct: denom ? Math.round(occupiedCount/denom*1000)/10 : null,
          vacant: vacant.length,
          future_signed: future.length,
          rent_in_place: Math.round(rentInPlace),
          gross_balance_exposure: Math.round(grossOwed),
          balance_accounts: owed.length,
          down, model_units: modelUnits, commercial,
        },
        known: "Occupancy, snapshot vacancy, rent in place, resident balances, future signed leases.",
        missing: "Live availability, traffic, tours, applications, renewals, current pricing.",
        vacant_units: vacant,                 // active section — the current hole
        future_signed: {                      // separated truth
          count: future.length,
          note: "Not counted as current occupancy.",
          rows: future,
        },
        balance_exposure: {                   // money exposure from rent roll
          accounts: owed.length,
          gross: Math.round(grossOwed),
          top: owed.slice(0, 8),
        },
        occupied_units: occupied,             // evidence (collapsed in UI)
        full_rent_roll: fullRoll,             // auditability (collapsed in UI)
      });
    } catch (e) {
      console.error("leasing detail error:", e);
      res.status(500).json({ error: "leasing_detail_failed", detail: e.message });
    } finally {
      client.release();
    }
  });

  return router;
};

function nonRevUnits(rows, NONREV){
  const byUnit = new Map();
  for (const r of rows) {
    const nonRev = NONREV.test(r.space_label||"") || NONREV.test(r.cur_tenant||"");
    if (!byUnit.has(r.unit_number)) byUnit.set(r.unit_number, true);
    if (!nonRev) byUnit.set(r.unit_number, false);
  }
  let n=0; for (const v of byUnit.values()) if (v) n++; return n;
}
