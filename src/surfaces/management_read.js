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
//       basis: 'bed'|'unit'|null, basis_state, unit_label
//     }
//
// LEASING GRAIN IS READ, NOT INFERRED. This file used to compute
//   const basis = maxSpaces > 1 ? "bed" : "unit";
// which is the guess migration 026 created 'unknown' to prevent — "instead
// of silently guessing from row patterns". A by-the-bed building whose beds
// are not materialized yet has maxSpaces === 1, so it was labelled "units"
// in contradiction of its own properties.leasing_basis, with nothing saying
// so. The grain now comes from the property, and when the property has not
// answered, this read SAYS SO (basis null, basis_state
// 'not_established', unit_label 'spaces') rather than picking a noun.
//
// The counts themselves are counts of SPACES and always were — no total,
// percentage or classification in this file depends on the basis. Only the
// noun did. So this is a labelling correction, not an occupancy change, and
// it deliberately does NOT refuse the read: the space counts are true
// whether or not anybody has declared what a leasable position is here.
// lease_status: 'active' = current, 'pending' = future, 'commercial' = comm.
// ============================================================

module.exports = function managementRead(deps) {
  const express = require("express");
  const router = express.Router();
  const { pool, spacePosition } = deps;
  const { leasingGrain, grainCountLabel } = require("../tenancy/leasing_grain");
  /*  THE CANONICAL DATED READER, so this surface can publish the answer the
   *  Rent Roll, the lender report and Ask Spine publish — rather than only
   *  its own. See the `canonical` block below for why it rides alongside
   *  instead of replacing the counts.  */
  const { datedPropertyPositions, rentRollBuckets } = require("../tenancy/dated_positions");
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

      /*  ── GRAIN IS THE PROPERTY'S ANSWER, NOT A PATTERN IN THE ROWS ──
       *  What stood here was
       *      const basis = maxSpaces > 1 ? "bed" : "unit";
       *  a guess from row shape, which is the one thing migration 026
       *  wrote 'unknown' to stop. It could contradict the property's own
       *  declared basis and could never say "not established". Reading the
       *  column costs one query and makes this route agree with every
       *  other reader of the grain (src/tenancy/leasing_grain.js). */
      const basisRow = (await client.query(
        `select leasing_basis from properties where id = $1`, [propertyId])).rows[0];
      const basis = leasingGrain(basisRow && basisRow.leasing_basis);
      const basisState = basis ? "declared" : "not_established";
      //  'spaces' when nobody has answered. Not a softer 'units' — the
      //  honest noun for a count whose position meaning is undeclared.
      const unitLabel = grainCountLabel(basis);

      // ── classify each space ──
      const NON_REV_LABEL = /model|down|offline/i;
      let occupied = 0, vacant = 0, commercial = 0, down = 0, model = 0;
      /*  COMMITTED IS A CLASSIFICATION, BECAUSE VACANT MUST NOT BE A
       *  REMAINDER (§42, CURRENT_STATE 146).
       *
       *  This loop used to end `else { vacant++; vacantList.push(...) }`, so
       *  every space that was not detectably occupied became vacant — which
       *  is the subtraction the canonical reader was corrected for, in its own
       *  words: "That subtraction was the defect: it swept committed,
       *  contested and unreconciled beds into Open because they were not
       *  Occupied."
       *
       *  A bed with a future lease and no current one is SPOKEN FOR. Counting
       *  it vacant put it in the "Empty beds are the fastest revenue to
       *  recover" card and added its market rent to the money that card says
       *  is recoverable — pointing an operator at beds somebody has already
       *  signed for. An all-committed building raised that card with every
       *  bed in it.  */
      let committed = 0;
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
        } else if (r.fut_lease_id) {
          //  Spoken for and not yet in. Never Open, never in the vacancy
          //  card, and never in the recoverable-rent total.
          committed++;
        } else {
          vacant++;
          vacantList.push({ unit: r.unit_number, market: Number(r.market_rent || 0) });
        }
      }

      /*  THE CANONICAL OCCUPANCY, read once, beside this surface's own.
       *
       *  Wrapped because a presentation layer must not become the thing that
       *  decides a contract is broken: if the canonical read throws or the
       *  property has no established positions, this block is null WITH A
       *  REASON and the rest of the payload is served unchanged. Silently
       *  omitting it, or substituting zeros, would be the worse failure —
       *  `occupied: 0` reads as a building nobody lives in.                */
      let canonicalOccupancy = null;
      let canonicalReason = null;
      try {
        const dp = await datedPropertyPositions(pool, { property_id: req.params.id, as_of: null });
        const positions = (dp && Array.isArray(dp.positions)) ? dp.positions : [];
        if (!positions.length) {
          canonicalReason = "no canonical rentable positions are established for this property";
        } else {
          const t = rentRollBuckets(positions);
          canonicalOccupancy = {
            as_of: dp.as_of || null,
            rentable_positions: t.total,
            occupied: t.occupied,
            occupied_contractual: t.occupied_contractual,
            occupied_terms_not_established: t.occupied_terms_not_established,
            occupied_state_unknown: t.occupied_state_unknown,
            open: t.open,
            activation_pending: t.activation_pending,
            needs_review: t.needs_review,
            not_established: t.not_established,
          };
        }
      } catch (e) {
        canonicalReason = "the canonical dated read was unavailable: " + (e && e.message ? e.message : "unknown");
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

      // ── CANONICAL SPACE POSITION OVERLAY (Step 5 — existing surface consumes
      //    the shared read). Surfaces the distinct-fact conflicts the position
      //    detects (a commenced lease with no possession, a committed future
      //    over an unfinished turn, possession without a current lease). This is
      //    OWNED WORK made visible on the rent-roll surface — not a replacement
      //    of the occupancy math above (that reconciliation is a later slice).
      //    Fail-soft: a position error must not break the rent roll.
      // position_status makes "checked, no conflicts" DISTINCT from "couldn't
      // check" (Fable's fail-soft-not-silent caution). An empty items array is
      // ONLY meaningful when position_status === "ok". If the overlay fails, the
      // rent roll still loads but the status says "unavailable" — never a silent
      // empty array that would falsely imply there are no conflicts.
      let position_status = "not_computed";
      let position_exceptions = null;
      if (spacePosition) {
        try {
          const sp = await spacePosition(pool, { property_id: propertyId, as_of: req.query.as_of || null });
          const flagged = sp.positions.filter(p => p.next_required_action);
          position_status = "ok";
          position_exceptions = {
            as_of: sp.as_of,
            count: flagged.length,
            items: flagged.map(p => ({
              space_id: p.space_id, unit_number: p.unit_number, space_label: p.space_label,
              issue: p.next_required_action, reason: p.reason,
              current_lease: !!p.current_lease_position, future_lease: !!p.future_lease_position,
              possession: !!p.current_possession, readiness: p.physical_readiness,
            })),
          };
        } catch (e) {
          position_status = "unavailable";
          position_exceptions = null; // NOT an empty array — absence of a check, not absence of conflicts
          console.error("space-position overlay (non-fatal, surfaced as unavailable):", e.message);
        }
      }

      res.json({
        property_id: propertyId,
        has_data: true,
        basis,
        //  basis_state distinguishes "the property declared this" from "nobody
        //  has answered, so the noun below is 'spaces'". A consumer that reads
        //  `basis` alone must not treat null as 'unit'.
        basis_state: basisState,
        basis_receipt: basis ? null
          : "This property has not been established as leasing by bed or by unit, "
          + "so these are counts of spaces. Choose the property grain to count beds or units.",
        position_status,
        position_exceptions,
        unit_label: unitLabel,
        occupancy: {
          current_pct: currentPct,
          occupied: occupied + commercial,
          residential_occupied: occupied,
          commercial,
          vacant,
          //  Classified, not left over. occupied + committed + vacant +
          //  commercial + down + model === total_spaces, by construction.
          committed,
          /*  ── TWO DERIVATIONS, AND THE DISAGREEMENT IS NOW VISIBLE ─────
           *  (CURRENT_STATE 146; the pattern is row 142's, not a new one)
           *
           *  The counts above come from `cur_lease_id` presence, the canonical
           *  reader from `tenancy_state`, so a contradiction looked certain.
           *  Measured on the governed Greenery establishment over real HTTP:
           *
           *      here        occupied 95
           *      canonical   occupied 95            -> they AGREE
           *                  occupied_contractual 94
           *                  occupied_terms_not_established 1
           *
           *  They agree on the coarse count. Describing the gap as "a
           *  disagreement of one bed" was comparing `occupied` against
           *  `contractually_occupied` — the very category error this whole
           *  line of work exists to stop, made while making it. So row 138
           *  item (3)'s "second definition" is really a MISSING DISTINCTION:
           *  this surface had no contractual number at all.
           *
           *  The lender-facing report already solves this correctly and was
           *  measured doing so (row 142): it passes the canonical number
           *  through under a name that says CONFIRMED CONTRACTUAL and reports
           *  the coarser bucket beside it under `positions_occupied_all_bases`.
           *  Same move here. NO number above changes, so nothing that reads
           *  this surface moves; the canonical answer is published beside it
           *  and a disagreement is stated rather than discovered.
           *
           *  A failed or unestablished canonical read is `null` with a named
           *  reason, and `agrees_with_canonical` is then `null` too — never
           *  `true`, because Spine compared nothing. READ_FAILED is not
           *  agreement and it is not NOT_ESTABLISHED (§40.7).            */
          canonical: canonicalOccupancy,
          canonical_unavailable_reason: canonicalOccupancy ? null : canonicalReason,
          agrees_with_canonical: canonicalOccupancy
            ? (canonicalOccupancy.occupied === occupied + commercial)
            : null,
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
