// ============================================================
// moneyboard.js — THE MONEY BOARD (read-only, migration 044-aware)
//
// One call, the whole money story for a property, in the reverse-funnel
// shape the doctrine demands: TOP (1–2 headline numbers) · MIDDLE (the one
// thing needing attention) · BOTTOM (detail on click). It AUTHORS NOTHING —
// it reads confirmed truth (money_events) and the switch state
// (vendor_property_categories) and tells you where the money layer stands.
//
// It exists because we just built earned autonomy (autoconfirm.js +
// bankbridge bridge-auto) and the mechanism is invisible without a read.
// This is the screen that makes it PROVABLE the moment it deploys: it shows
// what's proven, what's still gross exposure, how much was auto-confirmed
// vs hand-confirmed, and — the payoff — which vendors have EARNED the switch
// but haven't been turned on yet. That last list is the live "ask me"
// surface: the system showing its work and requesting autonomy.
//
// HARD RULES IT HONORS (read side of the same doctrine):
//   • GROSS, NEVER NET. Exposure is sum(|amount|) of unproven lines. The
//     same dollar is never counted twice; offsetting errors never read clean.
//   • PROVEN CARRIES ITS RECEIPT. Every proven figure traces to money_events
//     rows; every auto line is tagged confirm_method='auto' + its rule.
//   • NO ACCOUNTING LANGUAGE LEAKS. Sections/lines come from
//     category_report_map (plain report names), never GL codes.
//   • IT NEVER WRITES. Pure SELECTs. Nothing here can break the money model;
//     the worst failure is a 500 on a read.
//
// THE THREE QUESTIONS IT ANSWERS (the funnel, top to bottom):
//   1. Where are we?      → proven $ this period, exposure $, occupancy of
//                            the money story (how much is confirmed).
//   2. What needs me?     → the human queue depth + the single biggest
//                            unproven line, and any vendor that just got
//                            REVOKED (trust broke — look here).
//   3. What's earned?     → vendors eligible to pre-authorize but not yet
//                            switched on, ranked by streak. The "ask me" list.
//
// Factory (standing module pattern, read-only so minimal deps):
//   const moneyBoardModule = require('./moneyboard');
//   app.use('/', moneyBoardModule({ pool }));
// ============================================================

module.exports = function moneyboard(deps) {
  const express = require("express");
  const router = express.Router();
  const { pool } = deps;
  if (!pool) throw new Error("moneyboard module requires a pool");

  // category vocabulary is DATA — same source the bridge validates against
  async function reportMap(client) {
    const r = await (client || pool).query(
      "select confirmed_category, report_section, report_line, sort_order from category_report_map order by sort_order");
    const m = {};
    for (const row of r.rows) m[row.confirmed_category] = row;
    return m;
  }

  // ──────────────────────────────────────────────────────────────────
  //  THE BOARD — GET /properties/:id/money-board?period=YYYY-MM
  //  period optional; omit for all-time. Everything scoped to the property.
  // ──────────────────────────────────────────────────────────────────
  router.get("/properties/:id/money-board", async (req, res) => {
    const property_id = req.params.id;
    const period = (req.query.period || "").trim(); // "2026-05" or ""
    try {
      // optional period filter on occurred_on (the event date)
      const periodClause = period
        ? "and to_char(me.occurred_on, 'YYYY-MM') = $2"
        : "";
      const periodArgs = period ? [property_id, period] : [property_id];

      const map = await reportMap();

      // ── 1) PROVEN: report_ready money_events, split auto vs human ──────
      const proven = (await pool.query(
        `select me.confirmed_category,
                me.confirm_method,
                count(*)::int            as n,
                sum(abs(me.amount))      as gross
           from money_events me
          where me.property_id = $1
            and me.status = 'report_ready'
            ${periodClause}
          group by me.confirmed_category, me.confirm_method`,
        periodArgs)).rows;

      let proven_gross = 0, auto_gross = 0, human_gross = 0, auto_n = 0, human_n = 0;
      const by_section = {};
      for (const r of proven) {
        const g = Number(r.gross);
        proven_gross += g;
        if (r.confirm_method === "auto") { auto_gross += g; auto_n += r.n; }
        else { human_gross += g; human_n += r.n; }
        const sec = map[r.confirmed_category]?.report_section || "Unmapped";
        const line = map[r.confirmed_category]?.report_line || r.confirmed_category;
        by_section[sec] = by_section[sec] || { section: sec, lines: {}, gross: 0 };
        by_section[sec].lines[line] = (by_section[sec].lines[line] || 0) + g;
        by_section[sec].gross += g;
      }

      // ── 2) EXPOSURE: still-unproven bank lines (claimed/identified) ────
      //    GROSS sum of |amount| — the honest "money story not yet proven."
      const exposure = (await pool.query(
        `select t.status,
                count(*)::int       as n,
                sum(abs(t.amount))  as gross
           from bank_transactions t
          where t.bank_account_id in (select id from bank_accounts where property_id = $1)
            and t.money_event_id is null
            and t.amount < 0
            and t.status in ('claimed','identified')
          group by t.status`,
        [property_id])).rows;

      let exposure_gross = 0, identified_n = 0, claimed_n = 0;
      for (const r of exposure) {
        exposure_gross += Number(r.gross);
        if (r.status === "identified") identified_n = r.n;
        if (r.status === "claimed") claimed_n = r.n;
      }

      // the single biggest unproven line — the "what needs me first" anchor
      const biggest = (await pool.query(
        `select t.id, t.txn_date, t.description, abs(t.amount) as amount, t.status,
                v.canonical_name as vendor
           from bank_transactions t
           left join vendors v on v.id = t.vendor_id
          where t.bank_account_id in (select id from bank_accounts where property_id = $1)
            and t.money_event_id is null
            and t.amount < 0
            and t.status in ('claimed','identified')
          order by abs(t.amount) desc
          limit 1`,
        [property_id])).rows[0] || null;

      // money-story "occupancy": proven / (proven + exposure)
      const denom = proven_gross + exposure_gross;
      const proven_pct = denom > 0 ? Number(((proven_gross / denom) * 100).toFixed(1)) : null;

      // ── 3) EARNED BUT NOT SWITCHED: the "ask me" list ──────────────────
      //    Reuse the autoconfirm read so the threshold lives in ONE place.
      const { trackRecord } = require("./autoconfirm").helpers({ pool });
      const ruleVendors = (await pool.query(
        `select distinct v.id, v.canonical_name,
                vpc.auto_confirm, vpc.revoked_at, vpc.revoked_reason,
                coalesce(vpc.default_category, v.default_category) as effective_category
           from vendors v
           join money_events me on me.vendor = v.canonical_name and me.property_id = $1
           left join vendor_property_categories vpc
                  on vpc.vendor_id = v.id and vpc.property_id = $1
          where coalesce(vpc.default_category, v.default_category) is not null`,
        [property_id])).rows;

      const earned = [];
      const live_auto = [];
      const recently_revoked = [];
      for (const v of ruleVendors) {
        const rec = await trackRecord(pool, { property_id, vendor_id: v.id });
        if (v.auto_confirm === true) {
          live_auto.push({ vendor: v.canonical_name, category: v.effective_category,
                           streak: rec.current_streak, band: rec.amount_band });
        } else if (rec.eligible) {
          earned.push({ vendor_id: v.id, vendor: v.canonical_name,
                        category: v.effective_category, streak: rec.current_streak,
                        overrides: rec.overrides, band: rec.amount_band,
                        grant_via: `POST /properties/${property_id}/auto-confirm/grant { vendor_id: "${v.id}", granted_by_person_id }` });
        }
        if (v.revoked_at) {
          recently_revoked.push({ vendor: v.canonical_name, when: v.revoked_at,
                                  why: v.revoked_reason });
        }
      }
      earned.sort((a, b) => b.streak - a.streak);

      // ── assemble the reverse funnel ────────────────────────────────────
      res.json({
        property_id,
        period: period || "all-time",

        // TOP — the one or two headline numbers
        headline: {
          proven_gross: Number(proven_gross.toFixed(2)),
          exposure_gross: Number(exposure_gross.toFixed(2)),
          money_story_proven_pct: proven_pct,    // how much of the story is confirmed
          note: "Exposure is GROSS unproven (sum of |amount|), never netted. Proven is report_ready money_events.",
        },

        // MIDDLE — what needs a human
        needs_attention: {
          human_queue_lines: identified_n,        // identified, awaiting a confirm
          unidentified_lines: claimed_n,          // claimed, awaiting vendor proof
          biggest_unproven: biggest,              // the single line to look at first
          recently_revoked,                       // trust that just broke — look here
        },

        // the earned-autonomy story (the payoff of what we just built)
        autonomy: {
          live_auto_confirm: live_auto,           // switches currently ON
          earned_not_yet_on: earned,              // the "ask me" list — earned, not switched
          earned_count: earned.length,
          note: "earned_not_yet_on = vendors whose track record meets the threshold but a human hasn't flipped the switch. The system showing its work and asking for autonomy.",
        },

        // confirm-method split — proves auto is real and traceable
        confirm_split: {
          auto:  { lines: auto_n,  gross: Number(auto_gross.toFixed(2)) },
          human: { lines: human_n, gross: Number(human_gross.toFixed(2)) },
          auto_share_pct: proven_gross > 0
            ? Number(((auto_gross / proven_gross) * 100).toFixed(1)) : null,
          note: "Every auto line is bridged through the same lifecycle as a human confirm and tagged confirm_method='auto'. Never indistinguishable from a human one.",
        },

        // BOTTOM — the report-shaped detail (plain section/line names, no GL)
        by_report_section: Object.values(by_section)
          .map(s => ({
            section: s.section,
            gross: Number(s.gross.toFixed(2)),
            lines: Object.entries(s.lines)
              .map(([line, g]) => ({ line, gross: Number(g.toFixed(2)) }))
              .sort((a, b) => b.gross - a.gross),
          }))
          .sort((a, b) => b.gross - a.gross),
      });
    } catch (e) {
      console.error("money-board error:", e);
      res.status(500).json({ error: "money board read failed", detail: e.message });
    }
  });

  return router;
};
