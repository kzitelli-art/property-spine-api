"use strict";
// ════════════════════════════════════════════════════════════════════
//  operator_briefing.js — "WHAT SHOULD I DO TODAY?"
//
//  READ AND RECOMMEND ONLY. This module dispatches no write, and cannot:
//  it holds no service that mutates and issues no non-SELECT statement.
//
//  ── WHAT THIS IS ─────────────────────────────────────────────────
//  One governed briefing assembled from sources that already exist. It
//  invents no priority score and no new institutional ranking. Where a source
//  already ranks its own rows, that ranking is preserved.
//
//  ── THE TWO SECTIONS, AND WHY THEY ARE TWO ───────────────────────
//  MY WORK           assignment or required authority is RELIABLY ESTABLISHED.
//                    These rows may say "assigned to you".
//  PROPERTY WATCHLIST property-scoped facts whose ownership is NOT reliably
//                    established. These rows may NEVER say "assigned to you",
//                    "your work order", or "you need to complete this".
//
//  The operator work-order read filters on property and status only — it
//  carries no assignment or due predicate — so open maintenance cannot
//  honestly be called anyone's. Rather than drop it or overclaim it, it goes
//  in the watchlist with ownership stated as unconfirmed.
//
//  ── PRIORITY IS NOT AUTHORITY ────────────────────────────────────
//  An item may be urgent and not yours. Every row carries BOTH an urgency
//  basis and an authority basis, and they are separate fields.
//
//  ── FACT IS NOT RECOMMENDATION ───────────────────────────────────
//  `fact` is derived from a canonical read and could be stored.
//  `recommendation` is this module's suggestion and must NEVER be presented
//  or persisted as recorded institutional truth.
// ════════════════════════════════════════════════════════════════════

const BRIEFING_CONTRACT = "operator_briefing_v1";

//  Bands are PRESENTATION ORDERING, not a new priority engine. Within a band
//  the source's own ordering is preserved where it has one.
const BAND = Object.freeze({
  OVERDUE_ASSIGNED: 1,   // missed or overdue assigned work
  DUE_TODAY_ASSIGNED: 2, // due today, assigned
  DECISION_WAITING: 3,   // authorized decisions waiting for review
  DUE_SOON_ASSIGNED: 4,  // due soon, assigned
  WATCHLIST: 5,          // property-scoped, ownership not established
});

const AUTHORITY = Object.freeze({
  ASSIGNED: "assigned_to_you",
  COVER: "available_for_you_to_cover",
  MANAGER: "needs_manager_attention",
  VISIBLE: "visible_not_actionable",
  BLOCKED_INFO: "blocked_by_missing_information",
});

//  ── PROPERTY-LOCAL "TODAY" ───────────────────────────────────────
//  The browser's timezone is not institutional truth. A property in Phoenix
//  and a property in Boston disagree about what "today" is, and an employee
//  covering both must see each property's own answer.
//
//  A property with no governed timezone is a NAMED CONFIGURATION GAP, not a
//  guess: its rows are still shown, and their due language degrades to an
//  explicit "timezone not configured" rather than silently using UTC.
function dayBoundsInZone(tz, now) {
  if (!tz) return null;
  try {
    const fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
    });
    const localDay = fmt.format(now);              // YYYY-MM-DD in the property's zone
    //  Midnight local, expressed as an instant, by asking what UTC offset that
    //  zone had at that moment. Cheap and correct for day bucketing.
    const probe = new Date(`${localDay}T12:00:00Z`);
    const asLocal = new Date(probe.toLocaleString("en-US", { timeZone: tz }));
    const asUtc = new Date(probe.toLocaleString("en-US", { timeZone: "UTC" }));
    const offsetMs = asUtc.getTime() - asLocal.getTime();
    const startLocalMidnightUtc = new Date(`${localDay}T00:00:00Z`).getTime() + offsetMs;
    return {
      local_day: localDay,
      start: new Date(startLocalMidnightUtc),
      end: new Date(startLocalMidnightUtc + 24 * 3600 * 1000),
      soon_end: new Date(startLocalMidnightUtc + 72 * 3600 * 1000), // due-soon horizon
    };
  } catch (_) { return null; }
}

function dueState(dueAt, bounds) {
  if (!dueAt) return "no_due_date";
  if (!bounds) return "timezone_not_configured";
  const d = new Date(dueAt).getTime();
  if (d < bounds.start.getTime()) return "overdue";
  if (d < bounds.end.getTime()) return "due_today";
  if (d < bounds.soon_end.getTime()) return "due_soon";
  return "later";
}

module.exports = function briefingModule(deps = {}) {
  const { router, pool, requireOperator } = deps;
  if (!router || !pool || !requireOperator) {
    throw new Error("briefingModule requires { router, pool, requireOperator }");
  }

  //  ── THE PROMPT FAMILY ──────────────────────────────────────────
  //  A narrow, explicit set. NOT keyword similarity — an unrecognised
  //  question gets an honest boundary, never a briefing assembled because a
  //  word happened to match.
  const SUPPORTED_PROMPTS = Object.freeze([
    "what should i do today",
    "what should i focus on",
    "what is next",
    "whats next",
    "what's next",
    "anything urgent",
    "show my queue",
    "what needs my attention",
    "my queue",
    "what needs attention",
  ]);
  const normalize = (s) => String(s || "").toLowerCase()
    .replace(/[?!.,]/g, "").replace(/\s+/g, " ").trim();
  function isSupportedPrompt(q) {
    const n = normalize(q);
    if (!n) return false;
    return SUPPORTED_PROMPTS.includes(n);
  }

  //  ── AUTHORIZED PROPERTIES — SERVER-DERIVED ─────────────────────
  //  From the user's ACTIVE assignments, never from the request. The session's
  //  own property is always included; other properties appear only where the
  //  same user holds an active assignment carrying the leasing module.
  async function authorizedProperties(op) {
    const rows = (await pool.query(
      `select p.id, p.name, p.operating_timezone, a.allowed_modules
         from property_team_assignments a
         join properties p on p.id = a.property_id
        where a.user_id = $1 and a.active = true
        order by p.name asc`, [op.id])).rows;
    const seen = new Set();
    const out = [];
    for (const r of rows) {
      if (seen.has(String(r.id))) continue;
      seen.add(String(r.id));
      out.push({
        property_id: r.id, property_name: r.name,
        operating_timezone: r.operating_timezone || null,
        modules: r.allowed_modules || [],
      });
    }
    return out;
  }

  const hasLeasing = (p) => Array.isArray(p.modules) && p.modules.includes("leasing");

  //  ── SOURCE READS ───────────────────────────────────────────────
  //  Each returns { rows, failed }. A source that THROWS is reported as
  //  failed — never as empty. "Nothing needs attention" and "I could not
  //  look" are different answers and the caller must be able to tell them
  //  apart.

  //  1) Assigned obligations. The one source where assignment is unambiguous.
  async function readAssignedObligations(op, prop) {
    try {
      const rows = (await pool.query(
        `select o.id, o.type, o.label, o.status, o.due_at, o.priority, o.severity,
                o.missed_at, o.unit_id, o.assigned_user_id, o.module,
                o.related_type, o.related_id, o.created_at, u.unit_number
           from obligations o
           left join units u on u.id = o.unit_id
          where o.property_id = $1
            and o.assigned_user_id = $2
            and o.status in ('open','in_progress','escalated')
          order by o.due_at asc nulls last, o.created_at asc
          limit 50`, [prop.property_id, op.id])).rows;
      return { rows, failed: false };
    } catch (e) { return { rows: [], failed: true, error: e.message }; }
  }

  //  2) Leasing follow-ups. The strongest source: it already resolves owner
  //     basis per row through the canonical staff-identity resolver.
  async function readFollowUps(op, prop) {
    if (!hasLeasing(prop)) return { rows: [], failed: false, skipped: "no_leasing_module" };
    try {
      const rows = (await pool.query(
        `select o.id as obligation_id, o.due_at, o.status, o.created_at,
                lco.owner_user_id, c.property_id, c.person_id, pe.name as person_name
           from leasing_conversion_obligations lco
           join leasing_conversions c on c.id = lco.conversion_id
           join obligations o on o.id = lco.obligation_id
           left join persons pe on pe.id = c.person_id
          where c.property_id = $1
            and o.status in ('open','in_progress','escalated')
            and lco.outcome is null
          order by o.due_at asc nulls last, o.created_at asc
          limit 50`, [prop.property_id])).rows;
      return { rows, failed: false };
    } catch (e) { return { rows: [], failed: true, error: e.message }; }
  }

  //  3) Application decisions awaiting authorized review.
  async function readApplicationDecisions(op, prop) {
    if (!hasLeasing(prop)) return { rows: [], failed: false, skipped: "no_leasing_module" };
    try {
      const rows = (await pool.query(
        `select a.id, a.applicant_name, a.status, a.submitted_at, a.created_at,
                a.unit_id, u.unit_number, o.id as gate_id, o.due_at
           from lease_applications a
           left join units u on u.id = a.unit_id
           left join obligations o
             on o.id = a.approval_obligation_id
            and o.status in ('open','in_progress','escalated')
          where a.property_id = $1
            and a.status = 'submitted'
            and a.approval_obligation_id is not null
          order by a.submitted_at asc nulls last, a.created_at asc
          limit 25`, [prop.property_id])).rows;
      return { rows, failed: false };
    } catch (e) { return { rows: [], failed: true, error: e.message }; }
  }

  //  4) WATCHLIST — open maintenance requiring attention.
  //     Property-scoped only. The operator work-order read carries no
  //     assignment predicate, so nothing here may claim ownership.
  async function readWatchlistMaintenance(op, prop) {
    try {
      const rows = (await pool.query(
        `select w.id, w.title, w.status, w.is_emergency, w.urgency_status,
                w.urgency_basis, w.needs_pm_review, w.created_at,
                w.unit_id, u.unit_number
           from work_orders w
           left join units u on u.id = w.unit_id
          where w.property_id = $1
            and w.status not in ('completed','closed','cancelled')
            and (w.is_emergency = true or w.needs_pm_review = true)
          order by w.is_emergency desc nulls last, w.created_at asc
          limit 25`, [prop.property_id])).rows;
      return { rows, failed: false };
    } catch (e) { return { rows: [], failed: true, error: e.message }; }
  }

  //  ── ROW SHAPE ──────────────────────────────────────────────────
  //  Every field the contract requires, always present. A missing value is
  //  null — never absent, never invented.
  function row(o) {
    return {
      canonical_object: o.canonical_object,
      canonical_id: o.canonical_id,
      property_id: o.property_id,
      property_name: o.property_name,
      fact: o.fact,                       // derived from a canonical read
      recommendation: o.recommendation || null, // NOT institutional truth
      reason_it_appears: o.reason_it_appears,
      urgency_basis: o.urgency_basis,
      assignment_basis: o.assignment_basis,
      authority_basis: o.authority_basis,
      source_timestamp: o.source_timestamp || null,
      destination: o.destination,         // { surface, record_id, exact }
      band: o.band,
      section: o.band === BAND.WATCHLIST ? "property_watchlist" : "my_work",
    };
  }

  //  ── DESTINATIONS ───────────────────────────────────────────────
  //  `exact` states whether record-level navigation is supported. Where it is
  //  not, the board is opened WITH the id preserved so the surface may focus
  //  it. A destination that can do neither would be marked exact:false and
  //  must not be rendered as an "Open" action by the client.
  const dest = (surface, id, exact) => ({ surface, record_id: id || null, exact: !!exact });

  router.get("/operator/briefing", requireOperator, async (req, res) => {
    res.set("Cache-Control", "no-store");
    const op = req.operator;

    //  The prompt is optional: an empty request is the briefing itself.
    const q = req.query.q;
    if (q !== undefined && !isSupportedPrompt(q)) {
      return res.json({
        contract: BRIEFING_CONTRACT,
        supported: false,
        receipt: "I can currently help you understand what needs attention today. "
          + "I cannot answer that question yet.",
        supported_prompts: SUPPORTED_PROMPTS,
      });
    }

    const now = new Date();
    let properties = [];
    try { properties = await authorizedProperties(op); }
    catch (e) {
      return res.status(500).json({
        contract: BRIEFING_CONTRACT, supported: true,
        state: "source_unavailable",
        receipt: "I could not determine which properties you are authorized for.",
      });
    }

    if (!properties.length) {
      return res.json({
        contract: BRIEFING_CONTRACT, supported: true,
        state: "no_authorized_properties",
        receipt: "You do not have an active assignment at any property.",
        rows: [], groups: [], counts: { total: 0 }, degraded_sources: [],
      });
    }

    const rows = [];
    const degraded = [];
    const timezoneGaps = [];

    for (const prop of properties) {
      const bounds = dayBoundsInZone(prop.operating_timezone, now);
      if (!bounds) {
        timezoneGaps.push({ property_id: prop.property_id, property_name: prop.property_name,
          gap: "operating_timezone_not_configured" });
      }

      // ── MY WORK ────────────────────────────────────────────────
      const ob = await readAssignedObligations(op, prop);
      if (ob.failed) degraded.push({ source: "assigned_obligations", property_id: prop.property_id });
      for (const r of ob.rows) {
        const st = r.missed_at ? "overdue" : dueState(r.due_at, bounds);
        //  MISSED IS NOT CLOSED. A missed obligation keeps its status and
        //  stays visible, because the work still has not happened.
        if (!["overdue", "due_today", "due_soon", "timezone_not_configured"].includes(st)) continue;
        const band = st === "overdue" ? BAND.OVERDUE_ASSIGNED
          : st === "due_today" ? BAND.DUE_TODAY_ASSIGNED : BAND.DUE_SOON_ASSIGNED;
        rows.push(row({
          canonical_object: "obligation", canonical_id: r.id,
          property_id: prop.property_id, property_name: prop.property_name,
          fact: `${r.label || r.type || "Obligation"}${r.unit_number ? ` — Unit ${r.unit_number}` : ""}`
            + ` is ${st === "overdue" ? (r.missed_at ? "missed" : "overdue") : st.replace("_", " ")}`
            + ` and assigned to you.`,
          recommendation: st === "overdue"
            ? "Clear this before starting work that is not yet due." : null,
          reason_it_appears: st,
          urgency_basis: r.missed_at ? "missed_at" : (r.due_at ? "due_at" : "no_due_date"),
          assignment_basis: "obligations.assigned_user_id",
          authority_basis: AUTHORITY.ASSIGNED,
          source_timestamp: r.due_at || r.created_at,
          destination: dest("my_work", r.id, false),
          band,
        }));
      }

      const fu = await readFollowUps(op, prop);
      if (fu.failed) degraded.push({ source: "leasing_follow_ups", property_id: prop.property_id });
      for (const r of fu.rows) {
        const st = dueState(r.due_at, bounds);
        if (!["overdue", "due_today", "due_soon", "timezone_not_configured"].includes(st)) continue;
        const mine = r.owner_user_id && String(r.owner_user_id) === String(op.id);
        const unowned = !r.owner_user_id;
        //  AUTHORITY, NOT PRIORITY. An unowned follow-up is urgent and is not
        //  yours; it is offered as coverage, never asserted as assignment.
        const authority = mine ? AUTHORITY.ASSIGNED
          : unowned ? AUTHORITY.COVER : AUTHORITY.VISIBLE;
        if (authority === AUTHORITY.VISIBLE) continue; // someone else's — not your briefing
        rows.push(row({
          canonical_object: "leasing_follow_up", canonical_id: r.obligation_id,
          property_id: prop.property_id, property_name: prop.property_name,
          fact: `Follow up with ${r.person_name || "a prospect"} is ${st.replace("_", " ")}`
            + `${mine ? " and assigned to you." : ". No owner is assigned."}`,
          recommendation: null,
          reason_it_appears: st,
          urgency_basis: r.due_at ? "due_at" : "no_due_date",
          assignment_basis: mine ? "leasing_conversion_obligations.owner_user_id"
            : "unassigned",
          authority_basis: authority,
          source_timestamp: r.due_at || r.created_at,
          destination: dest("person_card", r.person_id, false),
          band: st === "overdue" ? BAND.OVERDUE_ASSIGNED
            : st === "due_today" ? BAND.DUE_TODAY_ASSIGNED : BAND.DUE_SOON_ASSIGNED,
        }));
      }

      const ap = await readApplicationDecisions(op, prop);
      if (ap.failed) degraded.push({ source: "application_decisions", property_id: prop.property_id });
      for (const r of ap.rows) {
        const waitedMs = now - new Date(r.submitted_at || r.created_at);
        const hours = Math.max(0, Math.floor(waitedMs / 3600000));
        rows.push(row({
          canonical_object: "lease_application", canonical_id: r.id,
          property_id: prop.property_id, property_name: prop.property_name,
          fact: `Application for ${r.applicant_name || "an applicant"} has been awaiting review`
            + ` for ${hours} hour${hours === 1 ? "" : "s"}.`,
          recommendation: "Review the application before lower-priority follow-ups.",
          reason_it_appears: "decision_required",
          urgency_basis: "submitted_at",
          //  The gate proves a decision is OWED. It does not prove this
          //  employee may make it — eligibility is re-checked by the door.
          assignment_basis: "lease_applications.approval_obligation_id (open gate)",
          authority_basis: AUTHORITY.MANAGER,
          source_timestamp: r.submitted_at || r.created_at,
          destination: dest("application_review", r.id, false),
          band: BAND.DECISION_WAITING,
        }));
      }

      // ── PROPERTY WATCHLIST ─────────────────────────────────────
      //  NEVER phrased as ownership.
      const wl = await readWatchlistMaintenance(op, prop);
      if (wl.failed) degraded.push({ source: "watchlist_maintenance", property_id: prop.property_id });
      for (const r of wl.rows) {
        rows.push(row({
          canonical_object: "work_order", canonical_id: r.id,
          property_id: prop.property_id, property_name: prop.property_name,
          fact: `${r.is_emergency ? "Emergency work order" : "Work order"} remains open`
            + `${r.unit_number ? ` — Unit ${r.unit_number}` : ""}.`,
          recommendation: null,
          reason_it_appears: r.is_emergency ? "emergency_open" : "needs_manager_review",
          //  The SOURCE's own recorded urgency, with its author — never a
          //  score computed here.
          urgency_basis: r.urgency_basis ? `work_orders.urgency_basis: ${r.urgency_basis}`
            : (r.is_emergency ? "work_orders.is_emergency" : "work_orders.needs_pm_review"),
          assignment_basis: "not_established_by_source",
          authority_basis: r.needs_pm_review ? AUTHORITY.MANAGER : AUTHORITY.BLOCKED_INFO,
          source_timestamp: r.created_at,
          destination: dest("work_order", r.id, false),
          band: BAND.WATCHLIST,
        }));
      }
    }

    //  ── PRESENTATION ORDERING ──────────────────────────────────────
    //  Bands first, then earliest due, then oldest source timestamp, then a
    //  stable canonical id. Documented as ordering, NOT as a priority engine.
    rows.sort((a, b) => {
      if (a.band !== b.band) return a.band - b.band;
      const at = a.source_timestamp ? new Date(a.source_timestamp).getTime() : Infinity;
      const bt = b.source_timestamp ? new Date(b.source_timestamp).getTime() : Infinity;
      if (at !== bt) return at - bt;
      return String(a.canonical_id).localeCompare(String(b.canonical_id));
    });

    const myWork = rows.filter((r) => r.section === "my_work");
    const watch = rows.filter((r) => r.section === "property_watchlist");

    //  Grouped by property — similarly named objects are never merged across
    //  properties, and every row carries its property visibly.
    const groups = properties.map((p) => ({
      property_id: p.property_id, property_name: p.property_name,
      operating_timezone: p.operating_timezone,
      my_work: myWork.filter((r) => String(r.property_id) === String(p.property_id)),
      property_watchlist: watch.filter((r) => String(r.property_id) === String(p.property_id)),
    })).filter((g) => g.my_work.length || g.property_watchlist.length);

    //  ── HONEST STATE ───────────────────────────────────────────────
    //  A failed source is NEVER rendered as an empty result.
    let state = "ok";
    let receipt;
    if (degraded.length && !rows.length) {
      state = "source_unavailable";
      receipt = "Some of your briefing could not be loaded, so I cannot tell you "
        + "whether anything needs attention. Nothing here should be read as 'all clear'.";
    } else if (degraded.length) {
      state = "partial";
      receipt = `Part of your briefing is unavailable (${degraded.map((d) => d.source).join(", ")}). `
        + "The rest is current.";
    } else if (!rows.length) {
      state = "nothing_needs_attention";
      receipt = "Nothing assigned to you is overdue or due today.";
    } else {
      receipt = `You have ${rows.length} thing${rows.length === 1 ? "" : "s"} that need attention today.`;
    }

    return res.json({
      contract: BRIEFING_CONTRACT,
      supported: true,
      state,
      receipt,
      actor: { user_id: op.id },
      counts: { total: rows.length, my_work: myWork.length, property_watchlist: watch.length },
      groups,
      rows,
      degraded_sources: degraded,
      configuration_gaps: timezoneGaps,
      //  The read-only boundary, declared in the payload so a client cannot
      //  claim it did not know.
      capabilities: { read: true, rank: true, explain: true, navigate: true, write: false },
    });
  });

  return router;
};
