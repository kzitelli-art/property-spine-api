// ============================================================
// attributions.js — CAUSALITY: money event → operating record (migration 045)
//
// THE DISTINCTION THIS MODULE PROTECTS:
//   category confirmation says WHAT a spend was (plumbing supplies).
//   attribution confirmation says WHAT CAUSED it (WO-2384 disposal leak).
//   Two separate facts. This module owns ONLY the second. It never touches
//   the category/purpose confirm — that stays in the existing money flow.
//
// V1 SCOPE: work orders only, human-confirmed only, no auto-linking.
//   • PROPOSE — for a money event with a known vendor, find work orders at
//     the SAME property, same vendor, within a time window of completion,
//     and offer them as a proposal with a confidence score + plain reason.
//     Property match REQUIRED. Unit match STRENGTHENS but is not required.
//     vendor + property + date window is enough for a lower-confidence
//     proposal. Nothing is written by proposing-for-preview; a proposal row
//     is written only by the explicit propose endpoint.
//   • CONFIRM — a human attaches the money event to the work order. The
//     SUM-GUARD runs here: confirmed cents for a money event can never
//     exceed the event amount (×100). Splits-must-sum, applied to cause.
//   • REJECT — "not this work order" / "no related work." Kept as a trail
//     so the same pair can be re-proposed later if evidence changes.
//
// MANY-TO-MANY UNDERNEATH, ONE-AT-A-TIME ON TOP: the schema holds a charge
// split across WOs and a WO fed by many charges. V1 UI creates ONE 100%
// attribution; allocated_amount_cents defaults to the full event amount.
//
// NO ATTRIBUTION FOR SPLIT-NEEDED CHARGES: a money event that still needs a
// purpose-split is not offered attribution. Split first (existing flow),
// THEN attribute the resulting child line. Enforced at the propose read.
//
// Factory (standing module pattern):
//   const attributionsModule = require('./attributions');
//   app.use('/', attributionsModule({ pool }));
// ============================================================

const SYSTEM_VERSION = "attrib-v1-wo-only";

// matching window: a charge usually posts AFTER the work is done. We look
// for work orders whose completion (proxied by updated_at — work_orders has
// no completed_at column) falls within this window relative to the charge.
const WINDOW_DAYS_BEFORE = 7;   // charge can slightly precede completion bookkeeping
const WINDOW_DAYS_AFTER  = 45;  // or land weeks after the work was finished

module.exports = function attributions(deps) {
  const express = require("express");
  const router = express.Router();
  const { pool } = deps;
  if (!pool) throw new Error("attributions module requires a pool");

  // ── does this money event still need a purpose-split? If so, no
  //    attribution is offered (split first, then attribute the child).
  //    Heuristic for V1: a split-needed event is one flagged in provenance
  //    or one not yet report_ready. We keep it simple: only OFFER
  //    attribution for events that are confirmed (report_ready) — an
  //    unconfirmed-purpose charge isn't ready to have its cause attached.
  function isAttributable(me) {
    return me && me.status === "report_ready";
  }

  // ── THE PROPOSER (read-only preview). Given a money event, return the
  //    candidate work orders ranked by confidence, WITHOUT writing rows.
  //    The card uses this to show "Possible work-order match: …".
  async function proposeForEvent(client, money_event_id) {
    const db = client || pool;
    const meR = await db.query(
      `select id, property_id, amount, vendor, occurred_on, status
         from money_events where id = $1`, [money_event_id]);
    if (!meR.rows.length) return { error: "money_event_not_found" };
    const me = meR.rows[0];

    if (!isAttributable(me)) {
      return { money_event_id, attributable: false,
               reason: "purpose not confirmed yet — confirm/split the purpose first, then attribute the cause",
               candidates: [] };
    }
    if (!me.vendor) {
      return { money_event_id, attributable: true, candidates: [],
               reason: "no vendor on this charge — attribution needs a vendor to match a work order" };
    }

    // resolve the vendor id from the canonical name the bridge stored
    const vR = await db.query(
      "select id, canonical_name from vendors where canonical_name = $1", [me.vendor]);
    const vendor_id = vR.rows[0]?.id || null;

    // candidate work orders: SAME property (required), SAME vendor, with
    // completion (updated_at, the proxy) within the window of the charge.
    // We DON'T require unit — its presence/match only strengthens score.
    const cand = await db.query(
      `select wo.id, wo.unit_id, wo.title, wo.issue_type, wo.status,
              wo.completion_note, wo.updated_at,
              u.unit_number as unit_label
         from work_orders wo
         left join units u on u.id = wo.unit_id
        where wo.property_id = $1
          and wo.vendor_id = $2
          and wo.updated_at::date between ($3::date - $4::int) and ($3::date + $5::int)
        order by wo.updated_at desc`,
      [me.property_id, vendor_id, me.occurred_on, WINDOW_DAYS_BEFORE, WINDOW_DAYS_AFTER]);

    // already-attributed (active) targets for this event — don't re-offer
    const taken = new Set((await db.query(
      `select related_id from money_event_attributions
        where money_event_id = $1 and related_type = 'work_order'
          and status in ('proposed','confirmed')`, [money_event_id]
    )).rows.map(r => r.related_id));

    const candidates = cand.rows
      .filter(wo => !taken.has(wo.id))
      .map(wo => {
        // confidence: property+vendor+window is the floor; completed status
        // and a tighter date gap raise it. Unit presence is a mild boost
        // (we can't match unit to a charge that carries no unit, so unit
        // here only signals "this WO is unit-specific" → slightly stronger).
        let score = 0.55;                                  // floor: vendor+property+window
        const reasons = ["same vendor", "same property", "within completion window"];
        if (wo.status === "complete") { score += 0.20; reasons.push("work order completed"); }
        if (wo.unit_id) { score += 0.05; reasons.push(`unit-specific (${wo.unit_label || "unit"})`); }
        const days = Math.abs(
          (new Date(me.occurred_on) - new Date(wo.updated_at)) / 86400000);
        if (days <= 7) { score += 0.15; reasons.push(`${Math.round(days)} days after completion`); }
        else if (days <= 21) { score += 0.07; reasons.push(`${Math.round(days)} days after completion`); }
        score = Math.min(0.99, Number(score.toFixed(2)));

        return {
          related_type: "work_order",
          related_id: wo.id,
          label: wo.title || wo.issue_type || "Work order",
          unit_label: wo.unit_label || null,
          wo_status: wo.status,
          confidence_score: score,
          confidence_reason: reasons.join(" · "),
        };
      })
      .sort((a, b) => b.confidence_score - a.confidence_score);

    return {
      money_event_id,
      attributable: true,
      vendor: me.vendor,
      amount: Number(me.amount),
      candidates,
      system_version: SYSTEM_VERSION,
      note: candidates.length
        ? "Proposals only — nothing is attributed until a human attaches it."
        : "No confident work-order match. Human can still mark 'no related work'.",
    };
  }

  // ── SUM-GUARD: confirmed cents for a money event must never exceed the
  //    event amount (×100). Runs inside confirm. Returns {ok, ...}.
  async function sumGuard(client, money_event_id, addingCents) {
    const meR = await client.query(
      "select amount from money_events where id = $1", [money_event_id]);
    if (!meR.rows.length) return { ok: false, reason: "money_event_not_found" };
    const capCents = Math.round(Number(meR.rows[0].amount) * 100);
    const usedR = await client.query(
      `select coalesce(sum(allocated_amount_cents),0)::bigint as used
         from money_event_attributions
        where money_event_id = $1 and status = 'confirmed'`, [money_event_id]);
    const used = Number(usedR.rows[0].used);
    if (used + addingCents > capCents) {
      return { ok: false, reason: "would_exceed_event_amount",
               cap_cents: capCents, already_confirmed_cents: used, adding_cents: addingCents };
    }
    return { ok: true, cap_cents: capCents, already_confirmed_cents: used };
  }

  // ════════════════════════════════════════════════════════════════
  //  ENDPOINTS
  // ════════════════════════════════════════════════════════════════

  // ── PREVIEW proposals for a money event (read-only, writes nothing) ──
  //   GET /money-events/:id/attribution/proposals
  router.get("/money-events/:id/attribution/proposals", async (req, res) => {
    try {
      const out = await proposeForEvent(pool, req.params.id);
      if (out.error) return res.status(404).json({ error: out.error });
      res.json(out);
    } catch (e) {
      console.error("attribution proposals error:", e);
      res.status(500).json({ error: "proposal read failed", detail: e.message });
    }
  });

  // ── the attributions ALREADY on a money event (card detail) ──────────
  //   GET /money-events/:id/attributions
  router.get("/money-events/:id/attributions", async (req, res) => {
    try {
      const r = await pool.query(
        `select mea.*, wo.title as wo_title, wo.issue_type, u.unit_number as unit_label
           from money_event_attributions mea
           left join work_orders wo
                  on mea.related_type = 'work_order' and wo.id = mea.related_id
           left join units u on u.id = wo.unit_id
          where mea.money_event_id = $1
          order by mea.created_at desc`, [req.params.id]);
      res.json({ money_event_id: req.params.id, attributions: r.rows });
    } catch (e) {
      console.error("attributions list error:", e);
      res.status(500).json({ error: "attributions read failed", detail: e.message });
    }
  });

  // ── ATTACH (confirm) a money event to a work order ───────────────────
  //   POST /money-events/:id/attribution/confirm
  //   Body: { related_id, confirmed_by_person_id, allocated_amount_cents?,
  //           confidence_score?, confidence_reason? }
  //   allocated_amount_cents defaults to the FULL event amount (V1: 100%).
  //   The sum-guard refuses an allocation that would exceed the charge.
  router.post("/money-events/:id/attribution/confirm", async (req, res) => {
    const money_event_id = req.params.id;
    const { related_id, confirmed_by_person_id,
            allocated_amount_cents = null, confidence_score = null,
            confidence_reason = null } = req.body || {};
    if (!related_id || !confirmed_by_person_id) {
      return res.status(400).json({ error: "related_id and confirmed_by_person_id are required" });
    }
    const client = await pool.connect();
    try {
      await client.query("begin");

      const meR = await client.query(
        "select id, amount, status from money_events where id = $1 for update", [money_event_id]);
      if (!meR.rows.length) { await client.query("rollback"); return res.status(404).json({ error: "money_event not found" }); }
      if (!isAttributable(meR.rows[0])) {
        await client.query("rollback");
        return res.status(409).json({ error: "purpose not confirmed — confirm/split the purpose before attributing the cause" });
      }

      // the work order must exist and be at the SAME property (required)
      const woR = await client.query(
        `select wo.id from work_orders wo
           join money_events me on me.id = $2
          where wo.id = $1 and wo.property_id = me.property_id`,
        [related_id, money_event_id]);
      if (!woR.rows.length) {
        await client.query("rollback");
        return res.status(409).json({ error: "work order not found at this charge's property (property match is required)" });
      }

      // default allocation = the full charge, in cents (V1 one-100%-link)
      const cents = allocated_amount_cents != null
        ? Number(allocated_amount_cents)
        : Math.round(Number(meR.rows[0].amount) * 100);
      if (!(cents > 0)) { await client.query("rollback"); return res.status(400).json({ error: "allocated_amount_cents must be > 0" }); }

      // SUM-GUARD — never over-attribute a charge
      const guard = await sumGuard(client, money_event_id, cents);
      if (!guard.ok) {
        await client.query("rollback");
        return res.status(409).json({ error: "attribution refused — would exceed the charge amount", ...guard });
      }

      // upsert against the partial-unique index: if a PROPOSED row exists
      // for this pair, confirm it; otherwise insert a confirmed row. A
      // rejected row is inactive and does not collide.
      const existing = await client.query(
        `select id, status from money_event_attributions
          where money_event_id = $1 and related_type = 'work_order' and related_id = $2
            and status in ('proposed','confirmed')
          for update`, [money_event_id, related_id]);

      let row;
      if (existing.rows.length) {
        if (existing.rows[0].status === "confirmed") {
          await client.query("rollback");
          return res.status(409).json({ error: "already attributed to this work order" });
        }
        row = (await client.query(
          `update money_event_attributions
              set status = 'confirmed', allocated_amount_cents = $2,
                  confirmed_by_person_id = $3, confirmed_at = now(), updated_at = now()
            where id = $1 returning *`,
          [existing.rows[0].id, cents, confirmed_by_person_id])).rows[0];
      } else {
        row = (await client.query(
          `insert into money_event_attributions
             (money_event_id, related_type, related_id, allocated_amount_cents,
              status, confidence_score, confidence_reason, proposed_by_system_version,
              confirmed_by_person_id, confirmed_at)
           values ($1,'work_order',$2,$3,'confirmed',$4,$5,$6,$7,now())
           returning *`,
          [money_event_id, related_id, cents, confidence_score, confidence_reason,
           SYSTEM_VERSION, confirmed_by_person_id])).rows[0];
      }

      await client.query("commit");
      res.status(201).json({
        attributed: true,
        attribution: row,
        remaining_cents: guard.cap_cents - guard.already_confirmed_cents - cents,
        note: "Cause attached. This is separate from the purpose confirm — what it was vs what caused it.",
      });
    } catch (e) {
      await client.query("rollback");
      console.error("attribution confirm error:", e);
      res.status(500).json({ error: "attribution confirm failed", detail: e.message });
    } finally {
      client.release();
    }
  });

  // ── REJECT a proposed work-order match ("not this work order") ───────
  //   POST /money-events/:id/attribution/reject
  //   Body: { related_id, rejected_by_person_id }
  //   Marks any active proposal for this pair rejected (kept as trail; the
  //   pair can be re-proposed later). If none exists, writes a rejected
  //   row so "not this WO" is recorded even for an unsolicited match.
  router.post("/money-events/:id/attribution/reject", async (req, res) => {
    const money_event_id = req.params.id;
    const { related_id, rejected_by_person_id } = req.body || {};
    if (!related_id || !rejected_by_person_id) {
      return res.status(400).json({ error: "related_id and rejected_by_person_id are required" });
    }
    try {
      const upd = await pool.query(
        `update money_event_attributions
            set status = 'rejected', rejected_by_person_id = $3, rejected_at = now(), updated_at = now()
          where money_event_id = $1 and related_type = 'work_order' and related_id = $2
            and status = 'proposed'
          returning id`,
        [money_event_id, related_id, rejected_by_person_id]);
      res.json({ rejected: true, updated: upd.rowCount,
        note: upd.rowCount ? "Proposal rejected — can be re-proposed later if evidence changes."
                           : "No active proposal for this pair; nothing to reject." });
    } catch (e) {
      console.error("attribution reject error:", e);
      res.status(500).json({ error: "attribution reject failed", detail: e.message });
    }
  });

  router.helpers = { proposeForEvent, sumGuard, SYSTEM_VERSION };
  return router;
};
