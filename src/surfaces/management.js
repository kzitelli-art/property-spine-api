// ════════════════════════════════════════════════════════════════════
//  MANAGEMENT SURFACE MODULE  —  management.js
//
//  Management is centered on the RENT ROLL — the property's current truth.
//  Everything else is a LENS that asks the truth for action. The surface
//  is FOUR DOORS, never more:
//
//    1. Rent Roll   — the truth: units, residents, leases, beds, charges.
//    2. Collections — the truth under MONEY stress: late rent, chronic
//                     delinquency, payment plans, disputes, evictions.
//    3. Services    — the truth under OPERATING stress: vendors, supplies,
//                     recurring services, unit blockers.
//    4. Needs You   — the truth needing HUMAN JUDGMENT: approvals,
//                     signatures, exceptions, compliance, escalations.
//
//  THE LOAD-BEARING RULE — "don't make symptoms into doors; put them
//  under the system causing them." A down unit is a SYMPTOM. It routes to
//  the door that must ACT to clear it:
//      • down for nonpayment / legal  → Collections
//      • down for a repair / vendor    → Services
//      • down & rent-ready to show     → (Leasing, not Management)
//  The door that clears it OWNS it; the doors it affects only REFLECT it.
//
//  This module is a READ. It assembles the four doors in surface shape
//  from data the rest of the system already captures. It writes nothing.
//  Each door is fail-soft: an unreadable door returns `unavailable`, it
//  never takes down the surface.
//
//  Same DI pattern as down_units.js / maintenance.js: server.js owns the
//  pool; this module receives it by injection.
//
//  Mount in server.js (anchor near the other desk/down-unit mounts):
//      const management = require("./management");
//      app.use("/", management({ pool }));
// ════════════════════════════════════════════════════════════════════

module.exports = function management(deps) {
  const express = require("express");
  const router = express.Router();

  const { pool } = deps || {};
  if (!pool) throw new Error("management module requires a pool");

  // exposure.js is the single source for gross unproven exposure. Optional —
  // if it can't be required or read, the Collections door still computes its
  // own delinquency numbers; we just omit the exposure cross-reference.
  let computeExposure = null;
  try { ({ computeExposure } = require("../money/exposure")); } catch (_) { /* fail-soft */ }

  const requireOperator =
    (deps && deps.requireOperator) ||
    ((_req, _res, next) => next()); // mounted middleware may already gate this

  // ── helpers ───────────────────────────────────────────────────────
  const usd = (n) =>
    "$" + Number(n || 0).toLocaleString("en-US", { maximumFractionDigits: 0 });
  const unavailable = (why) => ({ status: "unavailable", reason: why });
  const ok = (obj) => ({ status: "ok", ...obj });

  // Down-unit cause → which door must ACT to clear it. This is the routing
  // rule made executable. Anything economic/legal goes to Collections;
  // anything physical/vendor goes to Services. (Reasons come from
  // down_units.js's fixed vocabulary.)
  const COLLECTIONS_DOWN_REASONS = new Set([
    "inspection_co_legal",
    "access_possession",
  ]);
  function downDoorFor(reason) {
    if (COLLECTIONS_DOWN_REASONS.has(reason)) return "collections";
    return "services"; // hvac/plumbing/electrical/appliance/vendor_parts_delay/etc.
  }

  // ── OCCUPANCY (header) ─────────────────────────────────────────────
  // Current: units with an active lease tied through a space.
  // Future:  preleasing — spaces with a lease that STARTS in the future
  //          (signed-for-future), the student-housing forward look.
  async function occupancyHeader(propertyId) {
    const cur = (await pool.query(
      `select
         (select count(*)::int from units where property_id = $1) as total_units,
         (select count(distinct s.unit_id)::int
            from leases l join spaces s on s.id = l.space_id
           where l.property_id = $1 and l.lease_status = 'active') as occupied_units,
         (select count(*)::int from spaces s
            join units u on u.id = s.unit_id
           where u.property_id = $1) as total_spaces,
         (select count(distinct l.space_id)::int
            from leases l
           where l.property_id = $1 and l.lease_status = 'active') as occupied_spaces`,
      [propertyId])).rows[0];

    // Future / preleasing: leases that are signed/active but whose term
    // starts after today — beds spoken for next term. Counted at the SPACE
    // (bed) grain because that's how student housing is leased.
    const fut = (await pool.query(
      `select count(distinct l.space_id)::int as preleased_spaces
         from leases l
        where l.property_id = $1
          and l.start_date is not null
          and l.start_date > current_date
          and l.lease_status in ('active','pending','signed')`,
      [propertyId])).rows[0];

    const pct = (num, den) => (den > 0 ? Math.round((num / den) * 100) : null);

    return {
      current: {
        units: { occupied: cur.occupied_units, total: cur.total_units,
                 pct: pct(cur.occupied_units, cur.total_units) },
        spaces: { occupied: cur.occupied_spaces, total: cur.total_spaces,
                  pct: pct(cur.occupied_spaces, cur.total_spaces) },
      },
      future: {
        preleased_spaces: fut.preleased_spaces,
        total_spaces: cur.total_spaces,
        prelease_pct: pct(fut.preleased_spaces, cur.total_spaces),
      },
    };
  }

  // ── DOOR 1 · RENT ROLL (the truth) ─────────────────────────────────
  // Headline only here — the full roll is its own read on click-through.
  // Shows the size of the truth: units, leased spaces, scheduled monthly
  // rent (gross), and how many rows carry an unresolved (claimed) charge.
  async function rentRollDoor(propertyId) {
    try {
      // RENT ROLL — the reference shelf, NOT a work queue. It carries NO
      // badge/count: 105 units is the size of the property, not a to-do.
      // The flow is exploration: choose an object type → filtered list →
      // object detail/history. We return the four object types with their
      // sizes (as reference, not work) so the front end can offer the fork:
      //   Units · Residents · Leases · Charges
      const r = (await pool.query(
        `select
           (select count(*)::int from units where property_id = $1) as units,
           (select count(distinct p)::int
              from leases l, unnest(l.tenant_ids) as p
             where l.property_id = $1 and l.lease_status = 'active') as residents,
           (select count(*)::int from leases
              where property_id = $1 and lease_status = 'active') as leases,
           (select count(*)::int from scheduled_charges
              where property_id = $1
                and status in ('claimed','partially_paid')) as open_charges,
           (select coalesce(sum(l.rent),0)::numeric from leases l
              where l.property_id = $1 and l.lease_status = 'active') as scheduled_rent`,
        [propertyId])).rows[0];
      return ok({
        is_reference: true,    // no badge — exploration, not work
        badge: null,           // explicit: Rent Roll never nags
        headline: `${r.units} units · ${usd(r.scheduled_rent)}/mo`,
        objects: {             // the exploration fork
          units: r.units,
          residents: r.residents,
          leases: r.leases,
          charges: r.open_charges,
        },
        scheduled_monthly_rent: Number(r.scheduled_rent),
        go: "rent-roll",
      });
    } catch (e) { return unavailable(e.message); }
  }

  // ── DOOR 2 · COLLECTIONS (money stress) ────────────────────────────
  // Delinquency = scheduled_charges past due_date and not paid (claimed or
  // partially_paid). Buckets are the fork the door opens to:
  //   newly_late  — past due, first period
  //   chronic     — multiple unpaid periods on one lease
  //   disputed    — status = disputed
  //   in_eviction — economic/legal down unit (the loud, escalated tail)
  // Plus the gross exposure cross-reference when exposure.js is readable.
  async function collectionsDoor(propertyId) {
    try {
      // Past-due, unpaid scheduled charges → the delinquency base.
      const aging = (await pool.query(
        `select
           count(*) filter (where status in ('claimed','partially_paid')
                              and due_date is not null and due_date < current_date)::int
             as overdue_charges,
           coalesce(sum(amount - coalesce(amount_paid,0))
             filter (where status in ('claimed','partially_paid')
                       and due_date is not null and due_date < current_date),0)::numeric
             as overdue_balance,
           count(*) filter (where status = 'disputed')::int as disputed,
           count(distinct lease_id) filter (where status in ('claimed','partially_paid')
                              and due_date is not null and due_date < current_date)::int
             as delinquent_leases
         from scheduled_charges
        where property_id = $1`,
        [propertyId])).rows[0];

      // Chronic = a lease with 2+ distinct overdue periods unpaid.
      const chronic = (await pool.query(
        `select count(*)::int as n from (
           select lease_id
             from scheduled_charges
            where property_id = $1
              and status in ('claimed','partially_paid')
              and due_date is not null and due_date < current_date
            group by lease_id
           having count(distinct period) >= 2
         ) q`,
        [propertyId])).rows[0];

      // Economic/legal down units = the eviction-adjacent loud rows.
      const legalDown = (await pool.query(
        `select count(*)::int as n
           from units
          where property_id = $1
            and down_reason = any($2)`,
        [propertyId, Array.from(COLLECTIONS_DOWN_REASONS)])).rows[0];

      let exposure = null;
      if (computeExposure) {
        try {
          const exp = await computeExposure(pool, propertyId);
          if (exp) exposure = Number(exp.gross_unproven_exposure);
        } catch (_) { /* fail-soft — omit cross-reference */ }
      }

      return ok({
        count: aging.delinquent_leases,
        headline: aging.overdue_charges > 0
          ? `${usd(aging.overdue_balance)} late · ${aging.delinquent_leases} residents`
          : "Collections current",
        overdue_balance: Number(aging.overdue_balance),
        buckets: {
          newly_late: aging.delinquent_leases - chronic.n > 0
            ? aging.delinquent_leases - chronic.n : 0,
          chronic: chronic.n,           // broken promise / chronic
          disputed: aging.disputed,     // dispute
          legal: legalDown.n,           // legal / eviction (the loud tail)
        },
        item_actions: ["text", "payment_plan", "escalate", "legal"],
        gross_unproven_exposure: exposure, // null when exposure.js unread
        go: "collections",
      });
    } catch (e) { return unavailable(e.message); }
  }

  // ── DOOR · OPERATIONS (the WAITING board) ──────────────────────────
  // Operations is NOT a work queue — it is a status board of in-flight
  // dependencies. The defining rule: if I am waiting on someone else, it
  // lives here. The moment someone is waiting on ME, it is promoted to
  // Needs You. So every bucket is a "waiting on X":
  //   waiting_vendor     — down units / obligations blocked on a vendor
  //   waiting_supplies   — blocked on parts / supplies arriving
  //   waiting_inspection — blocked on an inspection / license / CO
  //   waiting_internal   — blocked on another internal team member
  // The action inside an item is nudge or escalate — never "do the work"
  // (the work belongs to the party you're waiting on).
  async function operationsDoor(propertyId) {
    try {
      // Physical down units, split by what they're waiting on (by reason).
      const down = (await pool.query(
        `select
           count(*) filter (where down_reason = 'vendor_parts_delay')::int as waiting_vendor_units,
           count(*) filter (where down_reason in ('hvac','plumbing','electrical','appliance','window_door_security','water_fire_damage','capital_repair'))::int as repair_units,
           count(*) filter (where down_reason in ('inspection_co_legal'))::int as waiting_inspection_units
           from units
          where property_id = $1
            and down_reason is not null
            and not (down_reason = any($2))`,
        [propertyId, Array.from(COLLECTIONS_DOWN_REASONS)])).rows[0];

      // Supply requests — fail-soft if the table isn't present.
      let waitingSupplies = null;
      try {
        const s = (await pool.query(
          `select count(*)::int as n from supply_requests
            where property_id = $1 and status <> 'fulfilled'`,
          [propertyId])).rows[0];
        waitingSupplies = s.n;
      } catch (_) { waitingSupplies = null; }

      // Waiting-on-internal: open obligations assigned to a non-manager
      // internal role (maintenance/leasing/accountant) — i.e. work the
      // manager is monitoring but someone else owns.
      let waitingInternal = 0;
      try {
        const wi = (await pool.query(
          `select count(*)::int as n from obligations
            where property_id = $1
              and status not in ('complete')
              and assigned_role in ('maintenance','leasing_agent','accountant')`,
          [propertyId])).rows[0];
        waitingInternal = wi.n;
      } catch (_) { waitingInternal = 0; }

      const waitingVendor = down.waiting_vendor_units + down.repair_units;
      const waitingInspection = down.waiting_inspection_units;
      const total = waitingVendor + (waitingSupplies || 0) + waitingInspection + waitingInternal;

      return ok({
        count: total,
        headline: total > 0
          ? `${total} in flight · waiting`
          : "Nothing waiting",
        buckets: {
          waiting_vendor: waitingVendor,
          waiting_supplies: waitingSupplies, // null when no supply table
          waiting_inspection: waitingInspection,
          waiting_internal: waitingInternal,
        },
        item_actions: ["nudge", "escalate", "reassign"],
        go: "operations",
      });
    } catch (e) { return unavailable(e.message); }
  }

  // ── DOOR · NEEDS YOU (PRIMARY — the judgment lens) ─────────────────
  async function needsYouDoor(propertyId) {
    try {
      // NEEDS YOU — the PRIMARY drawer. The cross-surface judgment lens.
      // The honest query is "everything where requires_judgment = true and
      // owner = current_user." There is no requires_judgment column yet, so
      // we INFER it (build now, add the clean flag later without UI change):
      //   judgment item  := type is approval/signature/exception/escalation
      //                     OR severity = emergency
      //                     OR status   = escalated
      //   owned by mgr   := assigned_role in (property_manager, asset_manager,
      //                     owner) OR module in (accounting, controls, management)
      //
      // Buckets are kept PURE — only the three where the manager is the
      // terminal decision-maker. Respond/Escalate are item-level ACTIONS,
      // not buckets (the manager respond/escalates from inside the item).
      //   Approve — a decision gate: concession, waiver, PO, spend, plan
      //   Sign    — a signature that binds the company (countersign, contract)
      //   Decide  — an exception / judgment call with no pre-set answer
      //
      // RULE: if someone is waiting on ME → here. If I'm waiting on someone
      // else → Operations. That split is enforced by what lands as a
      // judgment obligation vs. a waiting dependency.
      const o = (await pool.query(
        `with judgment as (
           select *,
             case
               when type ilike '%countersign%' or type ilike '%signature%'
                 or type ilike '%sign%' or type ilike '%contract%' then 'sign'
               when type in ('rent_concession','fee_waiver','lease_modification',
                             'move_out_credit','payment_plan','spend_approval',
                             'purchase_order')
                 or type ilike '%approv%' or module in ('accounting','controls')
                 then 'approve'
               else 'decide'
             end as judgment_kind
           from obligations
          where property_id = $1
            and status not in ('complete')
            and (assigned_role in ('property_manager','asset_manager','owner')
                 or module in ('accounting','controls','management'))
            and (
              type ilike '%approv%' or type ilike '%sign%'
              or type ilike '%countersign%' or type ilike '%contract%'
              or type ilike '%exception%' or type ilike '%waiver%'
              or type ilike '%concession%' or type ilike '%modification%'
              or type in ('move_out_credit','payment_plan','spend_approval','purchase_order')
              or severity = 'emergency' or status = 'escalated'
            )
         )
         select
           count(*)::int as total,
           count(*) filter (where judgment_kind = 'approve')::int as approve,
           count(*) filter (where judgment_kind = 'sign')::int    as sign,
           count(*) filter (where judgment_kind = 'decide')::int  as decide
         from judgment`,
        [propertyId])).rows[0];

      return ok({
        primary: true, // this is the top drawer — the reverse-funnel apex
        count: o.total,
        headline: o.total > 0 ? `${o.total} need you` : "Nothing needs you",
        buckets: { approve: o.approve, sign: o.sign, decide: o.decide },
        // item-level actions available inside any Needs You item
        item_actions: ["approve", "reject", "request_info", "respond", "escalate", "assign"],
        go: "needs-you",
      });
    } catch (e) {
      // Schema drift safety: if a column differs, Needs You degrades to
      // unavailable rather than blocking the whole surface.
      return unavailable(e.message);
    }
  }

  // ── THE SURFACE READ ───────────────────────────────────────────────
  router.get(
    "/properties/:propertyId/management-surface",
    requireOperator,
    async (req, res) => {
      const propertyId = req.params.propertyId;
      try {
        const prop = (await pool.query(
          `select id, name, address from properties where id = $1`,
          [propertyId])).rows[0];
        if (!prop) return res.status(404).json({ error: "property not found" });

        // Header occupancy is the one piece allowed to hard-fail to
        // unavailable without killing the doors.
        let occupancy;
        try { occupancy = ok(await occupancyHeader(propertyId)); }
        catch (e) { occupancy = unavailable(e.message); }

        const [rentRoll, collections, operations, needsYou] = await Promise.all([
          rentRollDoor(propertyId),
          collectionsDoor(propertyId),
          operationsDoor(propertyId),
          needsYouDoor(propertyId),
        ]);

        // THE REVERSE FUNNEL. The home is not "here is the property" — it is
        // "here is the one thing only you can do," then the rest widens
        // beneath it. So the response declares a structure, not a flat list:
        //   header     — occupancy, health only, no action
        //   primary    — Needs You: the cross-surface judgment lens
        //   secondary  — Collections (money risk) · Operations (waiting)
        //   reference  — Rent Roll: the truth shelf, no badge, exploration
        res.json({
          property: { id: prop.id, name: prop.name, address: prop.address },
          header: { occupancy },          // health indicators only
          primary: { needs_you: needsYou }, // the apex of the funnel
          secondary: { collections, operations },
          reference: { rent_roll: rentRoll }, // no badge — exploration
          // Back-compat: also expose the flat doors map so any caller still
          // reading `doors` keeps working during the front-end transition.
          doors: {
            needs_you: needsYou,
            collections,
            operations,
            rent_roll: rentRoll,
          },
          model:
            "Reverse funnel. Needs You is the primary judgment lens (someone " +
            "is waiting on you). Operations is the waiting board (you are " +
            "waiting on someone). Collections is money risk. Rent Roll is the " +
            "reference shelf (truth, not work — no badge).",
        });
      } catch (e) {
        res.status(500).json({ error: "management surface failed", detail: e.message });
      }
    }
  );

  return router;
};
