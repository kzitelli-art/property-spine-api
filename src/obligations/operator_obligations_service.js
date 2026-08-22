// ════════════════════════════════════════════════════════════════════
//  operator_obligations_service.js — the scoped obligations read
//
//  Replaces the query behind the retired `GET /obligations`, which took
//  its property scope from the query string and returned `select *`.
//
//  This service is given property and module scope as ARGUMENTS. It has
//  no other source for either and must never be handed a request value.
//  Both predicates are MANDATORY: there is no code path here that emits
//  a query without them.
//
//  Explicit projection. `select *` is what let the legacy route return
//  every column, including any future sensitive one, to anyone holding
//  the portfolio key.
//
//  TWO PROJECTIONS, ONE READ. The operator queue needs the complete scoped
//  list; Ask Spine needs the five highest-attention open items. Both call
//  scopedRead below, so property/module authority, overdue meaning and the
//  projected columns cannot drift between the screen and conversation.
//
//  CLASS 2 (permanent).
// ════════════════════════════════════════════════════════════════════

"use strict";

//  The columns the operator surface actually reads. Adding one is a
//  deliberate act — that is the point of enumerating them.
const FIELDS = [
  "id", "property_id", "module", "type", "label", "status",
  "due_at", "assigned_user_id", "assigned_role",
  "person_id", "unit_id", "related_type", "related_id",
  "created_at", "updated_at",
].join(", ");

//  A query PREFERENCE, not authority. Anything outside this list is
//  ignored rather than passed to SQL.
const STATUS_WHITELIST = new Set(["open", "in_progress", "complete", "blocked", "escalated"]);
const ATTENTION_LIMIT = 5;

function normalizeStatus(requested) {
  if (!requested) return null;
  const s = String(requested).trim().toLowerCase();
  return STATUS_WHITELIST.has(s) ? s : null;
}

async function scopedRead(db, {
  property_id, allowed_modules, status = null, attention = false,
  operator_user_id = null, primary_for_modules = [], personal = false,
} = {}) {
  if (!property_id) {
    throw new Error("operator_obligations read requires a server-derived property_id");
  }
  if (personal && !operator_user_id) {
    throw new Error("personal obligation attention requires a server-derived operator_user_id");
  }

  const modules = Array.isArray(allowed_modules) ? allowed_modules.filter(Boolean) : [];

  //  No entitlement → no query at all. Returning everything would be a
  //  privilege escalation; returning an error would be dishonest, because
  //  "you may see nothing here" is a true and complete answer.
  if (modules.length === 0) {
    return { items: [], total: 0, scope_note: "no_module_entitlement" };
  }

  const wantStatus = normalizeStatus(status);
  const vals = [property_id, modules];
  let statusPredicate = "";
  if (wantStatus) { vals.push(wantStatus); statusPredicate = ` and o.status = $${vals.length}`; }

  let personalProjection = "";
  let personalPredicate = "";
  if (personal) {
    const primary = Array.isArray(primary_for_modules)
      ? primary_for_modules.filter((module) => modules.includes(module)) : [];
    vals.push(operator_user_id, primary);
    const userParam = `$${vals.length - 1}`;
    const primaryParam = `$${vals.length}`;
    personalProjection = `,
           case
             when o.assigned_user_id = ${userParam} then 'assigned_to_you'
             when o.escalates_to_user_id = ${userParam} then 'escalated_to_you'
             else 'unassigned_in_your_module'
           end as personal_basis`;
    personalPredicate = `
       and (o.assigned_user_id = ${userParam}
            or o.escalates_to_user_id = ${userParam}
            or (o.assigned_user_id is null and o.module = any(${primaryParam}::text[])))`;
  }

  const order = attention
    ? `case
         when o.due_at is not null and o.due_at < now() and o.assigned_user_id is null then 1
         when o.due_at is not null and o.due_at < now() then 2
         when o.assigned_user_id is null then 3
         else 4
       end,
       o.due_at asc nulls last,
       o.id asc`
    : "o.due_at asc nulls last, o.created_at desc, o.id asc";

  const sql = `
    select ${FIELDS.split(", ").map((f) => "o." + f).join(", ")},
           (o.due_at is not null and o.due_at < now()) as is_overdue,
           count(*) over()::int as total_open${personalProjection}
      from obligations o
     where o.property_id = $1
       and o.module = any($2::text[])${statusPredicate}${personalPredicate}
     order by ${order}${attention ? `\n     limit ${ATTENTION_LIMIT}` : ""}`;

  const r = await db.query(sql, vals);
  const rawRows = r.rows || [];
  const total = rawRows.length
    ? Number(rawRows[0].total_open == null ? rawRows.length : rawRows[0].total_open)
    : 0;
  const items = rawRows.map((row) => {
    const { total_open: _totalOpen, ...item } = row;
    return item;
  });
  return {
    items: attention ? items.slice(0, ATTENTION_LIMIT) : items,
    total,
    scope_note: null,
  };
}

//  list(db, { property_id, allowed_modules, status })
//
//  property_id and allowed_modules come from the RESOLVED OPERATOR
//  SESSION. `status` is the only caller-influenced input and cannot
//  widen scope — at worst it narrows a set already bounded by both
//  mandatory predicates.
async function list(db, { property_id, allowed_modules, status } = {}) {
  return scopedRead(db, { property_id, allowed_modules, status });
}

//  The compact standing projection used by Ask Spine. The ranking contains
//  only recorded obligation facts; it does not infer money, proof, blockage
//  or somebody waiting. The cap is owned here with the query, not repeated by
//  a conversational reader.
async function attention(db, { property_id, allowed_modules } = {}) {
  return scopedRead(db, {
    property_id, allowed_modules, status: "open", attention: true,
  });
}

//  The compact answer to "What should I do today?" It is narrower than the
//  property attention board and uses only recorded accountability fields:
//  direct assignment, explicit escalation, or unassigned work in a module the
//  current property assignment says this user owns. Role/title inference is
//  deliberately absent.
async function personalAttention(db, {
  property_id, allowed_modules, operator_user_id, primary_for_modules,
} = {}) {
  return scopedRead(db, {
    property_id, allowed_modules, operator_user_id, primary_for_modules,
    status: "open", attention: true, personal: true,
  });
}

module.exports = {
  list, attention, personalAttention, FIELDS, STATUS_WHITELIST, ATTENTION_LIMIT,
};
