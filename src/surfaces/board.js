// ════════════════════════════════════════════════════════════════════
//  MORNING BOARD — board.js
//
//  "Record the truth at the moment of the event, and reporting becomes
//  a read, not a project." This is that read, made literal: ONE
//  property-scoped GET that joins every rung that exists today —
//  money events, obligations, work orders, the tenant line, bank
//  intake exceptions/parked lines, and ingest pendings — into the
//  screen an operator wakes up to.
//
//  WHAT IT DELIBERATELY DOES NOT DO:
//   • It does NOT recompute exposure. exposure.js is the single source
//     of the headline number; the Today screen calls /properties/:id/
//     exposure alongside this. Two sources for THE number would be the
//     exact divergence the spine exists to prevent.
//   • It does NOT write anything. Identify is not commit; a board is
//     not a mutation.
//   • It does NOT invent numbers. Each section degrades independently
//     to status "unavailable" with the reason (exposure.js's trySource
//     pattern) — unreadable is never rendered as zero/clean.
//
//  THE OWNER.JS DISCIPLINE CARRIES OVER, two buckets never conflated:
//   needs_you      — a real decision someone can make right now, with a
//                    named place to make it (inbox, work orders, bank
//                    board, candidate review).
//   proof_missing  — the system can't prove a thing yet and no button
//                    exists. Stated as consequence, never as a task.
//
//  Route: GET /properties/:id/today
// ════════════════════════════════════════════════════════════════════

const express = require("express");

module.exports = function boardModule({ pool }) {
  const router = express.Router();

  async function trySource(name, fn) {
    try {
      const r = await fn();
      return { source: name, status: "ok", ...r };
    } catch (e) {
      const missingTable = e && e.code === "42P01";
      return {
        source: name, status: "unavailable",
        reason: missingTable ? "tables not created yet" : e.message,
      };
    }
  }

  // Same fail-closed operator gate as tenant_link — the board reads tenant
  // message counts and the property's whole operating state.
  function requireOperator(req, res, next) {
    const expected = process.env.OPERATOR_KEY;
    if (!expected) {
      return res.status(503).json({
        receipt: "Operator routes are locked: set OPERATOR_KEY in Render's environment, then send it as the x-operator-key header.",
      });
    }
    if (req.headers["x-operator-key"] !== expected) {
      return res.status(401).json({ receipt: "Operator key missing or wrong. Set it in the operator page header." });
    }
    next();
  }

  router.get("/properties/:id/today", requireOperator, async (req, res) => {
    const propertyId = req.params.id;
    try {
      const prop = (await pool.query(
        `select id, name, address, canonical_key, leasing_basis
           from properties where id = $1`, [propertyId])).rows[0];
      if (!prop) return res.status(404).json({ receipt: "No property with that id." });

      // ── MONEY STORY (money_events lifecycle: unverified → verified →
      //    report_ready). Counts + gross dollars per stage. Gross, never net.
      const money = await trySource("money", async () => {
        const r = (await pool.query(
          `select
             count(*) filter (where status = 'unverified')::int   as unverified,
             count(*) filter (where status = 'verified')::int     as verified,
             count(*) filter (where status = 'report_ready')::int as report_ready,
             coalesce(sum(abs(amount)) filter (where status = 'unverified'),0)::numeric(14,2)   as unverified_gross,
             coalesce(sum(abs(amount)) filter (where status = 'verified'),0)::numeric(14,2)     as verified_gross,
             coalesce(sum(abs(amount)) filter (where status = 'report_ready'),0)::numeric(14,2) as report_ready_gross
           from money_events where property_id = $1`, [propertyId])).rows[0];
        return {
          unverified: r.unverified, verified: r.verified, report_ready: r.report_ready,
          unverified_gross: Number(r.unverified_gross),
          verified_gross: Number(r.verified_gross),
          report_ready_gross: Number(r.report_ready_gross),
        };
      });

      // ── OBLIGATIONS (the engine). Open, overdue, oldest — who the
      //    system is waiting on, by module.
      const obligations = await trySource("obligations", async () => {
        const r = (await pool.query(
          `select
             count(*) filter (where status <> 'complete')::int as open,
             count(*) filter (where status <> 'complete' and due_at is not null and due_at < now())::int as overdue
           from obligations where property_id = $1`, [propertyId])).rows[0];
        const oldest = (await pool.query(
          `select label, module, due_at from obligations
            where property_id = $1 and status <> 'complete'
            order by due_at asc nulls last limit 1`, [propertyId])).rows[0] || null;
        const byModule = (await pool.query(
          `select module, count(*)::int as n from obligations
            where property_id = $1 and status <> 'complete'
            group by module order by n desc`, [propertyId])).rows;
        return { open: r.open, overdue: r.overdue, oldest, by_module: byModule };
      });

      // ── WORK ORDERS. Open, emergencies, awaiting PM review.
      const workOrders = await trySource("work_orders", async () => {
        const r = (await pool.query(
          `select
             count(*) filter (where status <> 'complete')::int as open,
             count(*) filter (where status <> 'complete' and (is_emergency = true or title like 'EMERGENCY%'))::int as emergencies,
             count(*) filter (where status <> 'complete' and needs_pm_review = true)::int as needs_pm_review
           from work_orders where property_id = $1`, [propertyId])).rows[0];
        return { open: r.open, emergencies: r.emergencies, needs_pm_review: r.needs_pm_review };
      });

      // ── TENANT LINE. Connection coverage + messages waiting on a human.
      const tenantLine = await trySource("tenant_line", async () => {
        const occ = (await pool.query(
          `select count(distinct t.pid)::int as total
             from leases l cross join lateral unnest(l.tenant_ids) as t(pid)
            where l.property_id = $1 and l.lease_status = 'active'`, [propertyId])).rows[0];
        const conn = (await pool.query(
          `select count(distinct person_id)::int as n from tenant_invites
            where property_id = $1 and status = 'used'`, [propertyId])).rows[0];
        const msgs = (await pool.query(
          `select count(*) filter (where needs_human = true)::int as needs_human,
                  max(occurred_at) as last_message_at
             from comm_events
            where property_id = $1 and direction = 'inbound' and conversation_id is not null`,
          [propertyId])).rows[0];
        return {
          occupants: occ.total, connected: conn.n,
          needs_human_messages: msgs.needs_human, last_message_at: msgs.last_message_at,
        };
      });

      // ── BANK BOARD STATE. Claimed (unproven), parked-with-note, and
      //    exception findings not yet booked (e.g. payment returns whose
      //    booking is structurally blocked until RC pairing confirms).
      //    Property-scoped through bank_accounts.property_id — the same
      //    join exposure.js uses, so the two reads can never disagree on
      //    which lines belong to the property.
      const bank = await trySource("bank", async () => {
        const r = (await pool.query(
          `select
             count(*) filter (where t.status = 'claimed')::int as claimed,
             count(*) filter (where t.parked_at is not null)::int as parked,
             count(*) filter (where t.exception_reason is not null and t.money_event_id is null)::int as exceptions_unbooked
           from bank_transactions t
           join bank_accounts a on a.id = t.bank_account_id
          where a.property_id = $1`, [propertyId])).rows[0];
        return { claimed: r.claimed, parked: r.parked,
                 exceptions_unbooked: r.exceptions_unbooked };
      });

      // ── INGEST. Units read from files, waiting on a human yes.
      const ingest = await trySource("ingest", async () => {
        const r = (await pool.query(
          `select count(distinct unit_number)::int as pending
             from ingest_candidates
            where property_id = $1
              and decision_status in ('pending','proposed','needs_review')`,
          [propertyId])).rows[0];
        return { pending_units: r.pending };
      });

      // ── NEEDS YOU — composed queue. Real decisions only, each with the
      //    named place to make it. Order = severity of ignoring it.
      const needs_you = [];
      if (workOrders.status === "ok" && workOrders.emergencies > 0)
        needs_you.push({ headline: `${workOrders.emergencies} emergency work order${workOrders.emergencies === 1 ? "" : "s"} open`, go: "work_orders" });
      if (tenantLine.status === "ok" && tenantLine.needs_human_messages > 0)
        needs_you.push({ headline: `${tenantLine.needs_human_messages} tenant message${tenantLine.needs_human_messages === 1 ? "" : "s"} waiting on a human`, go: "inbox" });
      if (obligations.status === "ok" && obligations.overdue > 0)
        needs_you.push({ headline: `${obligations.overdue} obligation${obligations.overdue === 1 ? " is" : "s are"} past due`, go: "obligations" });
      if (money.status === "ok" && money.unverified > 0)
        needs_you.push({ headline: `${money.unverified} money event${money.unverified === 1 ? "" : "s"} unverified ($${money.unverified_gross.toLocaleString()})`, go: "money" });
      if (bank.status === "ok" && bank.exceptions_unbooked > 0)
        needs_you.push({ headline: `${bank.exceptions_unbooked} bank exception finding${bank.exceptions_unbooked === 1 ? "" : "s"} not yet booked`, go: "bank" });
      if (workOrders.status === "ok" && workOrders.needs_pm_review > 0)
        needs_you.push({ headline: `${workOrders.needs_pm_review} work order${workOrders.needs_pm_review === 1 ? "" : "s"} awaiting PM review`, go: "work_orders" });
      if (ingest.status === "ok" && ingest.pending_units > 0)
        needs_you.push({ headline: `${ingest.pending_units} unit${ingest.pending_units === 1 ? "" : "s"} from uploads waiting to be confirmed`, go: "candidates" });
      if (tenantLine.status === "ok" && tenantLine.occupants > 0 && tenantLine.connected < tenantLine.occupants)
        needs_you.push({ headline: `${tenantLine.occupants - tenantLine.connected} of ${tenantLine.occupants} occupants not on the tenant line yet`, go: "tenant_link" });

      // ── PROOF MISSING — honest consequences, no buttons.
      const proof_missing = [];
      if (money.status === "ok" && money.report_ready === 0)
        proof_missing.push("No money events are report-ready yet — the report read for this property has no proven money rows.");
      for (const s of [money, obligations, workOrders, tenantLine, bank, ingest])
        if (s.status === "unavailable")
          proof_missing.push(`${s.source} is unreadable right now (${s.reason}) — its numbers are absent, not zero.`);

      const quiet = needs_you.length === 0;
      res.json({
        receipt: quiet
          ? `Quiet board at ${prop.name || prop.address} — nothing is waiting on a human right now.`
          : `${needs_you.length} thing${needs_you.length === 1 ? "" : "s"} need${needs_you.length === 1 ? "s" : ""} a human at ${prop.name || prop.address}.`,
        property: { id: prop.id, name: prop.name, address: prop.address },
        as_of: new Date().toISOString(),
        needs_you, proof_missing,
        sections: { money, obligations, work_orders: workOrders, tenant_line: tenantLine, bank, ingest },
        note: "Exposure headline comes from GET /properties/:id/exposure — single source, not recomputed here.",
      });
    } catch (e) {
      console.error("today board:", e);
      res.status(500).json({ receipt: "Could not assemble the board.", error: e.message });
    }
  });

  return router;
};
