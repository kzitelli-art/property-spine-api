// ============================================================
// management_read.js — the Management profitability read
//
// Answers ONE question: "Is this property healthy, and where do I focus?"
// Everything here is computed from REAL seeded snapshot data (units, spaces,
// leases). NOTHING is faked. NOI is deliberately ABSENT (returned as null
// with a reason) because a rent roll has no expenses — that needs the P&L
// intake, a later track.
//
// GET /properties/:id/management-read
//   → {
//       occupancy: { current_pct, occupied, total_units_or_beds, vacant, ... },
//       upcoming:  { future_leases, preleasing_pct, risk:{level,reason} },
//       noi: { trailing:null, trending:null, missing_source },
//       focus: [ ranked alerts by dollars/lost-revenue/urgency ],
//       basis: 'bed'|'unit'
//     }
//
// Leasing model is inferred from the data: if a unit has >1 space, it's
// by-bed; else by-unit. (Matches how the snapshot wrote it.)
// lease_status: 'active' = current, 'pending' = future, 'commercial' = comm.
// ============================================================

module.exports = function managementRead(deps) {
  const express = require("express");
  const router = express.Router();
  const { pool } = deps;
  if (!pool) throw new Error("management_read requires a pool");

  router.get("/properties/:id/management-read", async (req, res) => {
    const propertyId = req.params.id;
    const client = await pool.connect();
    try {
      // ── pull the raw truth: every space with its unit + current/future lease ──
      // one row per space; left join the active (current) lease and, separately,
      // whether a future (pending) lease exists for that space.
      const rows = (await client.query(
        `select
            u.id              as unit_id,
            u.unit_number,
            u.market_rent,
            s.id              as space_id,
            s.space_label,
            cur.id            as cur_lease_id,
            cur.rent          as cur_rent,
            cur.balance       as cur_balance,
            cur.end_date      as cur_end_date,
            cur.lease_status  as cur_status,
            curp.name         as cur_tenant,
            fut.id            as fut_lease_id,
            fut.start_date    as fut_start_date
          from units u
          join spaces s on s.unit_id = u.id
          left join lateral (
            select l.* from leases l
             where l.space_id = s.id and l.lease_status in ('active','commercial')
             order by l.start_date desc nulls last limit 1
          ) cur on true
          left join lateral (
            select pe.name from persons pe
             where pe.id = any(cur.tenant_ids) limit 1
          ) curp on true
          left join lateral (
            select l.* from leases l
             where l.space_id = s.id and l.lease_status = 'pending'
             order by l.start_date asc nulls last limit 1
          ) fut on true
          where u.property_id = $1`,
        [propertyId])).rows;

      if (!rows.length) {
        return res.json({
          property_id: propertyId, has_data: false,
          receipt: "No units/spaces for this property yet. Load a snapshot or check the property.",
        });
      }

      // ── infer basis: by-bed if any unit has >1 space ──
      const spacesPerUnit = new Map();
      for (const r of rows) spacesPerUnit.set(r.unit_id, (spacesPerUnit.get(r.unit_id) || 0) + 1);
      const maxSpaces = Math.max(...spacesPerUnit.values());
      const basis = maxSpaces > 1 ? "bed" : "unit";
      const unitLabel = basis === "bed" ? "beds" : "units";

      // ── classify each space ──
      const NON_REV_LABEL = /model|down|offline/i;
      let occupied = 0, vacant = 0, commercial = 0, down = 0, model = 0;
      let currentRentRoll = 0;          // sum of actual rent on current (occupied) leases
      let marketIfFull = 0;             // sum of market rent across all revenue spaces
      const balances = [];              // {unit, tenant, balance}
      const downUnits = [];             // {unit, label}
      const vacantList = [];            // {unit, market}
      let futureCount = 0;
      const totalSpaces = rows.length;

      for (const r of rows) {
        const status = (r.cur_status || "").toLowerCase();
        const label = r.space_label || "";
        const isCommercial = status === "commercial";
        const isDownModel = NON_REV_LABEL.test(label) || NON_REV_LABEL.test(r.cur_tenant || "");
        const hasCurrent = !!r.cur_lease_id && !isDownModel;

        if (r.fut_lease_id) futureCount++;

        // market potential (exclude down/model from "if full")
        if (!isDownModel) marketIfFull += Number(r.market_rent || 0);

        if (isDownModel) {
          if (/down|offline/i.test(label) || /down|offline/i.test(r.cur_tenant||"")) { down++; downUnits.push({ unit: r.unit_number, label: "DOWN" }); }
          else { model++; downUnits.push({ unit: r.unit_number, label: "MODEL" }); }
          continue;
        }
        if (isCommercial) {
          commercial++;
          currentRentRoll += Number(r.cur_rent || 0);
          if (Number(r.cur_balance || 0) !== 0) balances.push({ unit: r.unit_number, tenant: r.cur_tenant || "Commercial", balance: Number(r.cur_balance), commercial: true });
          continue;
        }
        if (hasCurrent) {
          occupied++;
          currentRentRoll += Number(r.cur_rent || 0);
          if (Number(r.cur_balance || 0) !== 0) balances.push({ unit: r.unit_number, tenant: r.cur_tenant || "—", balance: Number(r.cur_balance) });
        } else {
          vacant++;
          vacantList.push({ unit: r.unit_number, market: Number(r.market_rent || 0) });
        }
      }

      const revenueSpaces = totalSpaces - down - model;   // leasable
      const currentPct = revenueSpaces ? Math.round((occupied + commercial) / revenueSpaces * 1000) / 10 : null;
      const upcomingPct = revenueSpaces ? Math.round(((occupied + commercial + futureCount) / revenueSpaces) * 1000) / 10 : null;

      // ── leasing risk: vacant + thin future leasing = exposure ──
      // risk rises when there are many vacant/expiring spaces and few future signed.
      const expiringSoon = rows.filter(r => {
        if (!r.cur_end_date) return false;
        const d = new Date(r.cur_end_date); const now = new Date();
        const days = (d - now) / (1000*60*60*24);
        return days >= 0 && days <= 90;       // current leases ending within 90 days
      }).length;
      const openOrExpiring = vacant + expiringSoon;
      let riskLevel = "low", riskReason = "";
      if (revenueSpaces) {
        const coverage = openOrExpiring ? futureCount / openOrExpiring : 1;   // future signed vs the gap to fill
        if (vacant === 0 && expiringSoon === 0) { riskLevel = "low"; riskReason = `Fully leased, nothing expiring in 90 days.`; }
        else if (coverage >= 0.75) { riskLevel = "low"; riskReason = `${futureCount} future signed covers most of the ${openOrExpiring} ${unitLabel} open or expiring soon.`; }
        else if (coverage >= 0.35) { riskLevel = "watch"; riskReason = `${openOrExpiring} ${unitLabel} open or expiring within 90 days; only ${futureCount} future leases signed.`; }
        else { riskLevel = "high"; riskReason = `${openOrExpiring} ${unitLabel} open or expiring within 90 days but only ${futureCount} future leases signed — turn is outrunning leasing.`; }
      }

      // ── collection-loss exposure: gross positive balances owed ──
      const owed = balances.filter(b => b.balance > 0);
      const totalOwed = owed.reduce((s,b) => s + b.balance, 0);
      const credits = balances.filter(b => b.balance < 0).reduce((s,b)=>s+b.balance,0);
      const topBalances = [...owed].sort((a,b)=>b.balance-a.balance).slice(0,8);

      // monthly lost revenue from vacant + down (at market)
      const vacantMarket = vacantList.reduce((s,v)=>s+v.market,0);
      const downMarket = downUnits.reduce((s,d)=>{
        const row = rows.find(r=>r.unit_number===d.unit); return s + Number(row?.market_rent||0);
      },0);

      // ── WHERE TO FOCUS: ranked alerts by dollars / lost revenue / urgency ──
      const focus = [];
      // 1. biggest single balances (largest dollar exposure first)
      for (const b of topBalances.slice(0,5)) {
        focus.push({
          kind: "balance",
          severity: b.balance >= 10000 ? "high" : b.balance >= 3000 ? "watch" : "normal",
          dollars: b.balance,
          unit: b.unit,
          title: `${b.tenant} owes $${b.balance.toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}`,
          detail: `Unit ${b.unit}${b.commercial?" · commercial":""} — largest outstanding balance${b.balance>=10000?", well past a normal cycle":""}.`,
        });
      }
      // 2. down/offline units — lost revenue, not producing
      if (down + model > 0) {
        focus.push({
          kind: "down_units",
          severity: (down+model) >= 3 ? "watch" : "normal",
          dollars: downMarket,
          title: `${down+model} ${unitLabel.slice(0,-1)}(s) offline (${down} down, ${model} model)`,
          detail: `Producing $0. ~$${downMarket.toLocaleString()}/mo of market rent not in service.`,
          units: downUnits.map(d=>`${d.unit} (${d.label})`),
        });
      }
      // 3. vacancy exposure
      if (vacant > 0) {
        focus.push({
          kind: "vacancy",
          severity: currentPct!=null && currentPct < 90 ? "watch" : "normal",
          dollars: vacantMarket,
          title: `${vacant} vacant ${unitLabel} — ~$${vacantMarket.toLocaleString()}/mo at market`,
          detail: `Current occupancy ${currentPct}%. Empty ${unitLabel} are the fastest revenue to recover.`,
        });
      }
      // 4. future-vs-turn leasing risk
      if (riskLevel !== "low") {
        focus.push({
          kind: "leasing_risk",
          severity: riskLevel === "high" ? "high" : "watch",
          dollars: null,
          title: riskLevel === "high" ? "Leasing is behind turn" : "Watch leasing pace",
          detail: riskReason,
        });
      }
      // rank: high → watch → normal, then by dollars desc
      const sevRank = { high:0, watch:1, normal:2 };
      focus.sort((a,b)=> (sevRank[a.severity]-sevRank[b.severity]) || ((b.dollars||0)-(a.dollars||0)));

      res.json({
        property_id: propertyId,
        has_data: true,
        basis,
        unit_label: unitLabel,
        occupancy: {
          current_pct: currentPct,
          occupied: occupied + commercial,
          residential_occupied: occupied,
          commercial,
          vacant,
          leasable: revenueSpaces,
          total_spaces: totalSpaces,
          down, model,
          current_rent_roll: Math.round(currentRentRoll),
          market_if_full: Math.round(marketIfFull),
        },
        upcoming: {
          future_leases: futureCount,
          upcoming_pct: upcomingPct,
          expiring_90d: expiringSoon,
          risk: { level: riskLevel, reason: riskReason },
        },
        noi: {
          trailing: null,
          trending: null,
          missing_source: "Requires monthly P&L / reporting package intake.",
        },
        collections: {
          total_owed: Math.round(totalOwed),
          accounts_owing: owed.length,
          credits_outstanding: Math.round(credits),
          top_balances: topBalances,
        },
        focus,
        as_of_note: "Computed from the loaded rent-roll snapshot. NOI awaits financials.",
      });
    } catch (e) {
      console.error("management-read error:", e);
      res.status(500).json({ error: "management_read_failed", detail: e.message });
    } finally {
      client.release();
    }
  });

  return router;
};
