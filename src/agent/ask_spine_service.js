// ════════════════════════════════════════════════════════════════════
//  ask_spine_service.js — ASK SPINE, SLICE 1: "What needs attention?"
//
//  READ-ONLY SIBLING of the staff agent. It shares that door's authority
//  seam and nothing else. It does not call staff_agent.js, does not
//  record the operator's question as a message, and cannot propose,
//  confirm, or write anything. There is no client here, only a query.
//
//  WHY IT DOES NOT REUSE `GET /obligations` (server.js):
//  that route WAS protected only by the portfolio-wide shared OPERATOR_KEY
//  while taking property scope from the request, so any key holder could
//  read across every property. Its QUERY LOGIC is sound and is re-expressed
//  here — the read-time overdue clock, the unassigned predicate, the
//  due-date ordering.
//
//  ⚠ THAT ROUTE IS NOW RETIRED. This comment used to say the route "is"
//  unauthenticated, in the present tense, and it outlived the fix — a
//  stale security claim in a governing comment, which is its own hazard:
//  it sends the next reader hunting for an exposure that is closed, and it
//  would make a real one easier to dismiss as "the known one". The
//  separate security lane completed. `/obligations` is registered nowhere;
//  the replacement is the session-scoped `GET /operator/obligations`, and
//  `tests/smoke_release3.deployed.js` B1–B5 assert the legacy doors 404 on
//  every deployed smoke run. See docs/SECURITY_OBLIGATIONS_ROUTE.md.
//
//  RANKING — recorded facts only, no score (audit §4):
//    1  overdue AND unassigned    due_at < now() AND assigned_user_id IS NULL
//    2  overdue                   due_at < now()
//    3  unassigned                assigned_user_id IS NULL
//    4  due soonest               due_at ASC, nulls last
//  Money impact, missing proof, operational blockage and "someone
//  waiting" are DELIBERATELY ABSENT: no recorded fact supports them
//  today, and inferring them would be confident-wrong (§5).
//
//  CLASS 2 (permanent) — the first capability behind the Ask Spine
//  surface. No removal condition.
// ════════════════════════════════════════════════════════════════════

"use strict";

const MAX_ITEMS = 5;

//  Desk keys the app can actually open (openDesk, verified in the audit).
//  An obligation module only becomes a desk target when it maps EXACTLY.
//  `accounting` and `controls` have no desk today, so they map to nothing
//  rather than to a guess.
const MODULE_TO_DESK = Object.freeze({
  leasing: "leasing",
  maintenance: "maintenance",
  management: "management",
});

//  Navigation is emitted ONLY where the app has a verified opener.
//  There is no general unit opener, so a unit is never a link — it is
//  returned as context and the UI names it without making it clickable.
function navigationFor(row) {
  if (row.person_id) return { kind: "person", id: row.person_id };
  if (row.related_type === "application" && row.related_id) {
    return { kind: "application", id: row.related_id };
  }
  const desk = MODULE_TO_DESK[row.module];
  if (desk) return { kind: "desk", id: desk };
  return null;
}

function reasonFor(row) {
  if (row.is_overdue && row.is_unassigned) return "overdue_unassigned";
  if (row.is_overdue) return "overdue";
  if (row.is_unassigned) return "unassigned";
  return "due_soonest";
}

//  attention({ property_id, allowed_modules })
//
//  property_id and allowed_modules come from the RESOLVED OPERATOR
//  SESSION. This function has no other source for either and must never
//  be given one from a request body or query string.
async function attention(db, { property_id, allowed_modules }) {
  if (!property_id) throw new Error("ask_spine.attention requires a server-derived property_id");

  const modules = Array.isArray(allowed_modules) ? allowed_modules.filter(Boolean) : [];
  //  Module entitlement is part of the authority the server derives (§21).
  //  With no entitlement there is nothing this operator may be shown —
  //  an honest empty, not an error, and not everything.
  if (modules.length === 0) {
    return { items: [], total_open: 0, scope_note: "no_module_entitlement" };
  }

  //  ONE round trip. `total_open` is counted over the same predicate as
  //  the page so "5 of 23" is truthful rather than a guess.
  const sql = `
    with scoped as (
      select
        o.id, o.label, o.module, o.type, o.status,
        o.due_at, o.person_id, o.unit_id,
        o.related_type, o.related_id,
        o.assigned_user_id,
        (o.due_at is not null and o.due_at < now()) as is_overdue,
        (o.assigned_user_id is null)                as is_unassigned
      from obligations o
      where o.property_id = $1
        and o.status = 'open'
        and o.module = any($2::text[])
    )
    select
      (select count(*) from scoped) as total_open,
      s.*
    from scoped s
    order by
      case
        when s.is_overdue and s.is_unassigned then 1
        when s.is_overdue                      then 2
        when s.is_unassigned                   then 3
        else 4
      end,
      s.due_at asc nulls last,
      s.id asc
    limit ${MAX_ITEMS}`;

  const r = await db.query(sql, [property_id, modules]);
  const rows = r.rows || [];

  //  total_open is repeated on every row; with zero rows there is no row
  //  to read it from, and zero is then the truthful answer.
  const total_open = rows.length ? Number(rows[0].total_open) : 0;

  //  The SQL already carries LIMIT 5. This slice is NOT redundant: the cap
  //  is a contract of THIS function, so it must hold whatever the layer
  //  below returns. Delegating the guarantee downward is how a cap quietly
  //  stops holding when a query is later edited.
  const items = rows.slice(0, MAX_ITEMS).map((row) => ({
    obligation_id: row.id,
    label: row.label,
    module: row.module,
    type: row.type,
    due_at: row.due_at,
    is_overdue: row.is_overdue,
    is_unassigned: row.is_unassigned,
    reason: reasonFor(row),
    person_id: row.person_id,
    //  Context only. There is no unit opener in the app, so this is never
    //  turned into a link.
    unit_id: row.unit_id,
    related_type: row.related_type,
    related_id: row.related_id,
    open: navigationFor(row),
  }));

  return { items, total_open, scope_note: null };
}

module.exports = { attention, MAX_ITEMS, MODULE_TO_DESK };
