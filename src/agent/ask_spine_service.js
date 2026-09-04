// ════════════════════════════════════════════════════════════════════
//  ask_spine_service.js — ASK SPINE, SLICE 1: "What needs attention?"
//
//  READ-ONLY SIBLING of the staff agent. It shares that door's authority
//  seam and nothing else. It does not call staff_agent.js, does not
//  record the operator's question as a message, and cannot propose,
//  confirm, or write anything. There is no client here, only a query.
//
//  ONE READER (§7). The scoped obligations read is
//  operator_obligations_service.list — the same function behind
//  GET /operator/obligations. This file used to re-express its query
//  ("its QUERY LOGIC is sound and is re-expressed here"), which was a
//  second reader of the same truth: two places to fix a predicate, and
//  a cheap way for the desk and the answer to drift. It now calls the
//  canonical read and only RANKS what comes back. CURRENT_STATE #5.
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
const obligations = require("../obligations/operator_obligations_service");

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

  //  The canonical scoped read, status narrowed to open. It binds property
  //  and modules as arguments and has no other source for either.
  const scoped = await obligations.list(db, { property_id, allowed_modules: modules, status: "open" });
  const all = (scoped.items || []).map((row) => ({
    ...row,
    is_overdue: !!row.is_overdue,
    is_unassigned: row.assigned_user_id == null,
  }));
  const rank = (r) => (r.is_overdue && r.is_unassigned) ? 1 : r.is_overdue ? 2 : r.is_unassigned ? 3 : 4;
  const time = (r) => (r.due_at == null ? Infinity : new Date(r.due_at).getTime());
  all.sort((a, b) => rank(a) - rank(b) || time(a) - time(b) || String(a.id).localeCompare(String(b.id)));
  const rows = all;

  //  total_open is the whole open set, counted over the same predicate as
  //  the page so "5 of 23" is truthful rather than a guess.
  const total_open = rows.length;

  //  The cap is a contract of THIS function, so it holds whatever the
  //  canonical read returns.
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
