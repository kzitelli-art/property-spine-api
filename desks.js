// ════════════════════════════════════════════════════════════════════
//  THREE DESKS — desks.js  (Operator Surface V3, Phase 1)
//
//  The reverse funnel: the screen tells the operator the condition of
//  the property and the one thing to do next; detail only on click.
//  These four endpoints make the BACKEND own the headline math — the
//  front end renders labels, it never calculates NOI, collection loss,
//  occupancy, or exposure.
//
//    GET /properties/:id/operator-home           — three desk cards, one call
//    GET /properties/:id/management-dashboard    — full/collecting/profitable/clean
//    GET /properties/:id/leasing-dashboard       — inventory/demand/response/conversion
//    GET /properties/:id/maintenance-dashboard   — urgent/open/review/waiting/oldest
//
//  HONESTY RULES (enforced, not aspirational):
//   • Every headline metric is {status, label, ...}. What can't be
//     computed from real data returns status "unavailable" with a human
//     reason — NEVER a fake number, never a silent zero. Today that
//     means: NOI trend (no revenue/expense series exists), unanswered
//     leads + applications (lead pipeline not property-wired).
//   • Occupancy is lease-based — units carrying an active lease over
//     total units on file — and SAYS SO in its note. It is not a
//     confirmed-status unit walk; that proof rung doesn't exist yet.
//   • Collection loss is gross positive arrears on active leases.
//     Gross, never net: tenant credits do not offset other tenants' debt.
//   • Exposure comes from exposure.js's computeExposure — the single
//     source. This module does not re-derive a dollar of it.
//   • Completion of work orders is not reachable from any desk —
//     closeout proof gate only.
// ════════════════════════════════════════════════════════════════════

const express = require("express");
const { computeExposure } = require("./exposure");

module.exports = function desksModule({ pool }) {
  const router = express.Router();

  // Same fail-closed operator gate as tenantlink/board. (Phase 0 auth
  // pass should centralize this — third copy is the signal.)
  function requireOperator(req, res, next) {
    const expected = process.env.OPERATOR_KEY;
    if (!expected) {
      return res.status(503).json({
        receipt: "Operator routes are locked: set OPERATOR_KEY in Render's environment, then send it as the x-operator-key header.",
      });
    }
    if (req.headers["x-operator-key"] !== expected) {
      return res.status(401).json({ receipt: "Operator key missing or wrong." });
    }
    next();
  }

  const unavailable = (reason) => ({ status: "unavailable", reason });
  const pct = (v) => (v * 100).toFixed(1) + "%";
  const usd = (n) => "$" + Number(n).toLocaleString(undefined, { maximumFractionDigits: 0 });

  async function getProperty(propertyId) {
    return (await pool.query(
      `select id, name, address, leasing_basis from properties where id = $1`,
      [propertyId])).rows[0] || null;
  }

  // ── shared fact reads ────────────────────────────────────────────────
  async function occupancyFacts(propertyId) {
    const r = (await pool.query(
      `select
         (select count(*)::int from units where property_id = $1) as total_units,
         (select count(distinct s.unit_id)::int
            from leases l join spaces s on s.id = l.space_id
           where l.property_id = $1 and l.lease_status = 'active') as occupied_units`,
      [propertyId])).rows[0];
    return r;
  }

  async function maintenanceFacts(propertyId) {
    const head = (await pool.query(
      `select
         count(*) filter (where status <> 'complete')::int as open,
         count(*) filter (where status <> 'complete' and (is_emergency = true or title like 'EMERGENCY%'))::int as emergencies,
         count(*) filter (where status <> 'complete' and needs_pm_review = true)::int as needs_pm_review,
         min(created_at) filter (where status <> 'complete') as oldest_created
       from work_orders where property_id = $1`, [propertyId])).rows[0];

    // tenant_waiting: open tenant-sourced WOs with a reporting tenant and
    // NO work_order_update message sent after the WO was created. Honest
    // definition, stated in the note.
    const waiting = (await pool.query(
      `select count(*)::int as n from work_orders w
        where w.property_id = $1 and w.status <> 'complete'
          and w.source = 'tenant' and w.person_id is not null
          and not exists (
            select 1 from comm_events ce
             where ce.person_id = w.person_id and ce.property_id = w.property_id
               and ce.direction = 'outbound' and ce.classification = 'work_order_update'
               and ce.occurred_at > w.created_at)`, [propertyId])).rows[0];

    const oldestDays = head.oldest_created
      ? Math.floor((Date.now() - new Date(head.oldest_created).getTime()) / 86400000)
      : null;
    return { ...head, tenant_waiting: waiting.n, oldest_days: oldestDays };
  }

  async function maintenanceItems(propertyId) {
    return (await pool.query(
      `select w.id, w.title, w.description, w.status, w.field_category, w.source,
              coalesce(w.is_emergency, false) or w.title like 'EMERGENCY%' as is_emergency,
              w.needs_pm_review, w.created_at,
              u.unit_number, per.name as tenant_name,
              c.id as conversation_id,
              jsonb_build_object('unit_id', w.unit_id, 'person_id', w.person_id) as _details
         from work_orders w
         left join units u on u.id = w.unit_id
         left join persons per on per.id = w.person_id
         left join conversations c on c.property_id = w.property_id and c.person_id = w.person_id
        where w.property_id = $1 and w.status <> 'complete'
        order by (coalesce(w.is_emergency,false) or w.title like 'EMERGENCY%') desc, w.created_at asc
        limit 50`, [propertyId])).rows;
  }

  async function tenantLineFacts(propertyId) {
    const occ = (await pool.query(
      `select count(distinct t.pid)::int as total,
              count(distinct t.pid) filter (where per.phone is null)::int as missing_phone
         from leases l cross join lateral unnest(l.tenant_ids) as t(pid)
         join persons per on per.id = t.pid
        where l.property_id = $1 and l.lease_status = 'active'`, [propertyId])).rows[0];
    const conn = (await pool.query(
      `select count(distinct person_id)::int as n from tenant_invites
        where property_id = $1 and status = 'used'`, [propertyId])).rows[0];
    const msgs = (await pool.query(
      `select count(*) filter (where needs_human = true)::int as needs_human
         from comm_events
        where property_id = $1 and direction = 'inbound' and conversation_id is not null`,
      [propertyId])).rows[0];
    return { occupants: occ.total, missing_phone: occ.missing_phone,
             connected: conn.n, needs_human_messages: msgs.needs_human };
  }

  async function moneyObligationFacts(propertyId) {
    const money = (await pool.query(
      `select count(*) filter (where status = 'unverified')::int as unverified,
              coalesce(sum(abs(amount)) filter (where status = 'unverified'),0)::numeric(14,2) as unverified_gross
         from money_events where property_id = $1`, [propertyId])).rows[0];
    const obls = (await pool.query(
      `select count(*) filter (where status <> 'complete')::int as open,
              count(*) filter (where status <> 'complete' and due_at is not null and due_at < now())::int as overdue
         from obligations where property_id = $1`, [propertyId])).rows[0];
    return { money_unverified: money.unverified,
             money_unverified_gross: Number(money.unverified_gross),
             obligations_open: obls.open, obligations_overdue: obls.overdue };
  }

  // ════════════════════════════════════════════════════════════════════
  //  MANAGEMENT DESK — are we full, collecting, profitable, clean?
  // ════════════════════════════════════════════════════════════════════
  async function buildManagement(propertyId, prop) {
    // occupancy
    let occupancy;
    try {
      const o = await occupancyFacts(propertyId);
      occupancy = o.total_units > 0
        ? { status: "ok", value: o.occupied_units / o.total_units,
            label: pct(o.occupied_units / o.total_units) + " occupied",
            note: `${o.occupied_units} of ${o.total_units} units carry an active lease — lease-based, not a confirmed-status walk` }
        : unavailable("no units on file for this property yet");
    } catch (e) { occupancy = unavailable(e.message); }

    // collection loss (gross arrears)
    let collection;
    try {
      const r = (await pool.query(
        `select coalesce(sum(balance) filter (where balance > 0),0)::numeric(14,2) as arrears,
                count(*) filter (where balance > 0)::int as tenants_behind
           from leases where property_id = $1 and lease_status = 'active'`,
        [propertyId])).rows[0];
      collection = { status: "ok", amount: Number(r.arrears),
        label: usd(r.arrears) + " collection loss",
        note: `gross positive balances on ${r.tenants_behind} active lease${r.tenants_behind === 1 ? "" : "s"} — credits never offset other tenants' debt` };
    } catch (e) { collection = unavailable(e.message); }

    // NOI trend — honestly not buildable yet
    const noi = unavailable("no revenue/expense time series exists yet — the NOI rung isn't built; this stays absent until it is");

    // exposure — single source
    let exposureHead;
    try {
      const exp = await computeExposure(pool, propertyId);
      exposureHead = exp
        ? { status: "ok", amount: exp.gross_unproven_exposure,
            label: usd(exp.gross_unproven_exposure) + " unproven",
            note: exp.headline_note, complete: exp.complete, fully_clean: exp.fully_clean }
        : unavailable("property not found by exposure read");
    } catch (e) { exposureHead = unavailable(e.message); }

    const mo = await moneyObligationFacts(propertyId).catch(() => null);
    const tl = await tenantLineFacts(propertyId).catch(() => null);
    const mf = await maintenanceFacts(propertyId).catch(() => null);

    // next + short queue (severity order)
    const queue = [];
    if (mf && mf.emergencies > 0) queue.push({ label: `${mf.emergencies} emergency work order${mf.emergencies === 1 ? "" : "s"} open`, go: "maintenance" });
    if (exposureHead.status === "ok" && exposureHead.amount > 0) queue.push({ label: `${usd(exposureHead.amount)} gross unproven exposure`, go: "exposure" });
    if (mo && mo.obligations_overdue > 0) queue.push({ label: `${mo.obligations_overdue} obligations overdue`, go: "obligations" });
    if (mo && mo.money_unverified > 0) queue.push({ label: `${mo.money_unverified} money rows unverified (${usd(mo.money_unverified_gross)})`, go: "money" });
    if (tl && tl.missing_phone > 0) queue.push({ label: `${tl.missing_phone} tenant${tl.missing_phone === 1 ? "" : "s"} missing phone numbers`, go: "tenant_line" });
    if (tl && tl.needs_human_messages > 0) queue.push({ label: `${tl.needs_human_messages} tenant message${tl.needs_human_messages === 1 ? "" : "s"} need a human`, go: "tenant_line" });

    const next = queue.length
      ? { label: queue[0].label.charAt(0).toUpperCase() + queue[0].label.slice(1) + ".", go: queue[0].go, object_id: null }
      : { label: "Nothing needs management right now.", go: null, object_id: null };

    return {
      receipt: queue.length
        ? `Management has ${queue.length} thing${queue.length === 1 ? "" : "s"} needing attention at ${prop.name || prop.address}.`
        : `Management board is quiet at ${prop.name || prop.address}.`,
      headline: { occupancy, collection_loss: collection, noi_trend: noi, gross_unproven_exposure: exposureHead },
      next, short_queue: queue.slice(0, 5),
    };
  }

  // ════════════════════════════════════════════════════════════════════
  //  LEASING DESK — inventory, demand, response, conversion
  // ════════════════════════════════════════════════════════════════════
  async function buildLeasing(propertyId, prop) {
    let occupancy, availability;
    try {
      const o = await occupancyFacts(propertyId);
      occupancy = o.total_units > 0
        ? { status: "ok", value: o.occupied_units / o.total_units, label: pct(o.occupied_units / o.total_units) + " occupied" }
        : unavailable("no units on file yet");
      const avail = (await pool.query(
        `select u.id as unit_id, u.unit_number, u.market_rent
           from units u
          where u.property_id = $1
            and not exists (
              select 1 from leases l join spaces s on s.id = l.space_id
               where s.unit_id = u.id and l.lease_status = 'active')
          order by u.unit_number limit 100`, [propertyId])).rows;
      availability = { status: "ok", available_units: avail.length,
        label: `${avail.length} unit${avail.length === 1 ? "" : "s"} available`,
        note: "units with no active lease on file",
        list: avail.map(a => ({ unit_id: a.unit_id, unit_number: a.unit_number,
          status: "available", market_rent: a.market_rent == null ? null : Number(a.market_rent) })) };
    } catch (e) { occupancy = occupancy || unavailable(e.message); availability = unavailable(e.message); }

    // tours today — real read from the obligation engine
    let tours;
    try {
      const r = (await pool.query(
        `select count(*)::int as n from obligations
          where property_id = $1 and status <> 'complete'
            and (type ilike '%tour%' or label ilike '%tour%')
            and due_at::date = current_date`, [propertyId])).rows[0];
      tours = { status: "ok", count: r.n, label: `${r.n} tour${r.n === 1 ? "" : "s"} today` };
    } catch (e) { tours = unavailable(e.message); }

    // honestly not wired yet — never faked
    const unanswered = unavailable("lead inbox isn't property-wired yet — no source of truth for unanswered leads");
    const applications = unavailable("application pipeline isn't wired yet");

    const queue = [];
    if (availability.status === "ok" && availability.available_units > 0)
      queue.push({ label: `${availability.available_units} units to fill`, go: "availability" });
    if (tours.status === "ok" && tours.count > 0)
      queue.push({ label: tours.label, go: "tours" });

    const next = queue.length
      ? { label: queue[0].label.charAt(0).toUpperCase() + queue[0].label.slice(1) + ".", go: queue[0].go, object_id: null }
      : { label: "Leasing board is quiet — the lead pipeline isn't wired yet.", go: null, object_id: null };

    return {
      receipt: `Leasing has ${queue.length} item${queue.length === 1 ? "" : "s"} needing attention at ${prop.name || prop.address}.`,
      leasing_basis: prop.leasing_basis || "unknown",
      headline: { occupancy, availability: { ...availability, list: undefined },
                  unanswered_leads: unanswered, tours_today: tours, applications_pending: applications },
      next, short_queue: queue,
      availability: availability.status === "ok" ? availability.list : [],
    };
  }

  // ════════════════════════════════════════════════════════════════════
  //  MAINTENANCE DESK — the action desk
  // ════════════════════════════════════════════════════════════════════
  async function buildMaintenance(propertyId, prop) {
    let head, items = [];
    try {
      const f = await maintenanceFacts(propertyId);
      head = {
        emergencies: { status: "ok", count: f.emergencies, label: `${f.emergencies} emergenc${f.emergencies === 1 ? "y" : "ies"}` },
        open_work_orders: { status: "ok", count: f.open, label: `${f.open} open` },
        needs_pm_review: { status: "ok", count: f.needs_pm_review, label: `${f.needs_pm_review} need PM review` },
        tenant_waiting: { status: "ok", count: f.tenant_waiting,
          label: `${f.tenant_waiting} tenant${f.tenant_waiting === 1 ? "" : "s"} waiting`,
          note: "open tenant-reported work orders with no update message sent since they were opened" },
        oldest_open: f.oldest_days == null
          ? { status: "ok", days: null, label: "nothing open" }
          : { status: "ok", days: f.oldest_days, label: `Oldest: ${f.oldest_days} day${f.oldest_days === 1 ? "" : "s"}` },
      };
      items = await maintenanceItems(propertyId);
      // tenant_waiting per item (no update since created)
      const waiting = new Set((await pool.query(
        `select w.id from work_orders w
          where w.property_id = $1 and w.status <> 'complete'
            and w.source = 'tenant' and w.person_id is not null
            and not exists (
              select 1 from comm_events ce
               where ce.person_id = w.person_id and ce.property_id = w.property_id
                 and ce.direction = 'outbound' and ce.classification = 'work_order_update'
                 and ce.occurred_at > w.created_at)`, [propertyId])).rows.map(r => r.id));
      items = items.map(i => ({ ...i, tenant_waiting: waiting.has(i.id) }));
    } catch (e) {
      head = { emergencies: unavailable(e.message) };
    }

    const queue = [];
    if (head.emergencies && head.emergencies.count > 0) queue.push({ label: head.emergencies.label, go: "emergencies" });
    if (head.needs_pm_review && head.needs_pm_review.count > 0) queue.push({ label: head.needs_pm_review.label, go: "pm_review" });
    if (head.tenant_waiting && head.tenant_waiting.count > 0) queue.push({ label: `${head.tenant_waiting.count} tenant${head.tenant_waiting.count === 1 ? "" : "s"} waiting for update`, go: "tenant_updates" });

    const firstEmergency = items.find(i => i.is_emergency);
    const next = firstEmergency
      ? { label: `Review ${firstEmergency.title.toLowerCase().startsWith("emergency") ? firstEmergency.title : "emergency: " + firstEmergency.title}${firstEmergency.unit_number ? " in unit " + firstEmergency.unit_number : ""}.`,
          go: "work_order", object_id: firstEmergency.id }
      : queue.length
        ? { label: queue[0].label.charAt(0).toUpperCase() + queue[0].label.slice(1) + ".", go: queue[0].go, object_id: null }
        : { label: "Maintenance board is clear.", go: null, object_id: null };

    return {
      receipt: head.open_work_orders
        ? `Maintenance has ${head.open_work_orders.count} open work order${head.open_work_orders.count === 1 ? "" : "s"} at ${prop.name || prop.address}.`
        : `Maintenance board unreadable at ${prop.name || prop.address}.`,
      headline: head, next, short_queue: queue, items,
    };
  }

  // ════════════════════════════════════════════════════════════════════
  //  ROUTES
  // ════════════════════════════════════════════════════════════════════
  function deskRoute(path, builder) {
    router.get(path, requireOperator, async (req, res) => {
      try {
        const prop = await getProperty(req.params.propertyId);
        if (!prop) return res.status(404).json({ receipt: "No property with that id." });
        const out = await builder(prop.id, prop);
        res.json({ property: { id: prop.id, name: prop.name, address: prop.address },
                   as_of: new Date().toISOString(), ...out });
      } catch (e) {
        console.error(path, e);
        res.status(500).json({ receipt: "Could not assemble this desk.", error: e.message });
      }
    });
  }
  deskRoute("/properties/:propertyId/management-dashboard", buildManagement);
  deskRoute("/properties/:propertyId/leasing-dashboard", buildLeasing);
  deskRoute("/properties/:propertyId/maintenance-dashboard", buildMaintenance);

  // operator home — three desk cards in one call, recommended desk first
  router.get("/properties/:propertyId/operator-home", requireOperator, async (req, res) => {
    try {
      const prop = await getProperty(req.params.propertyId);
      if (!prop) return res.status(404).json({ receipt: "No property with that id." });
      const [m, l, x] = await Promise.all([
        buildManagement(prop.id, prop), buildLeasing(prop.id, prop), buildMaintenance(prop.id, prop)]);

      const card = (d, fallback) => ({
        headline: Object.values(d.headline)
          .filter(h => h && h.status === "ok" && h.label).slice(0, 3)
          .map(h => h.label).join(" · ") || fallback,
        next: d.next,
      });
      const recommended =
        (x.headline.emergencies && x.headline.emergencies.count > 0) ? "maintenance"
        : (m.short_queue.length > 0) ? "management"
        : (l.short_queue.length > 0) ? "leasing"
        : "management";
      const recoDesk = { management: m, leasing: l, maintenance: x }[recommended];

      res.json({
        receipt: recoDesk.next.go
          ? `${recommended.charAt(0).toUpperCase() + recommended.slice(1)} needs you first at ${prop.name || prop.address}.`
          : `All three desks are quiet at ${prop.name || prop.address}.`,
        property: { id: prop.id, name: prop.name, address: prop.address },
        as_of: new Date().toISOString(),
        recommended_desk: recommended,
        desks: {
          management: card(m, "management board unreadable"),
          leasing: card(l, "leasing pipeline not wired yet"),
          maintenance: card(x, "maintenance board unreadable"),
        },
      });
    } catch (e) {
      console.error("operator-home:", e);
      res.status(500).json({ receipt: "Could not assemble the operator home.", error: e.message });
    }
  });

  return router;
};
