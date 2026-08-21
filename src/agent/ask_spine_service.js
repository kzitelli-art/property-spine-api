// ════════════════════════════════════════════════════════════════════
//  ask_spine_service.js — ASK SPINE, SLICE 1: "What needs attention?"
//
//  READ-ONLY SIBLING of the staff agent. It shares that door's authority
//  seam and nothing else. It does not call staff_agent.js, does not
//  record the operator's question as a message, and cannot propose,
//  confirm, or write anything. There is no client here, only a projection
//  over the canonical obligations read.
//
//  THE OBLIGATION READ IS NOT RE-EXPRESSED HERE. Ask Spine consumes the same
//  authenticated canonical read service as the operator queue. This module
//  owns only the conversational projection: plain ranking reasons and verified
//  navigation metadata. Property/module authority, open-state filtering,
//  overdue meaning, ordering and the cap all live in that canonical service.
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

const obligationRead = require("../obligations/operator_obligations_service");
const MAX_ITEMS = obligationRead.ATTENTION_LIMIT;

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
  const out = await obligationRead.attention(db, { property_id, allowed_modules });
  const items = out.items.map((row) => {
    const isUnassigned = row.assigned_user_id == null;
    return {
      obligation_id: row.id,
      label: row.label,
      module: row.module,
      type: row.type,
      due_at: row.due_at,
      is_overdue: row.is_overdue,
      is_unassigned: isUnassigned,
      reason: reasonFor({ ...row, is_unassigned: isUnassigned }),
      person_id: row.person_id,
      //  Context only. There is no unit opener in the app, so this is never
      //  turned into a link.
      unit_id: row.unit_id,
      related_type: row.related_type,
      related_id: row.related_id,
      open: navigationFor(row),
    };
  });

  return { items, total_open: out.total, scope_note: out.scope_note };
}

module.exports = { attention, MAX_ITEMS, MODULE_TO_DESK };
