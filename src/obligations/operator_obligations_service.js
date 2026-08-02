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

function normalizeStatus(requested) {
  if (!requested) return null;
  const s = String(requested).trim().toLowerCase();
  return STATUS_WHITELIST.has(s) ? s : null;
}

//  list(db, { property_id, allowed_modules, status })
//
//  property_id and allowed_modules come from the RESOLVED OPERATOR
//  SESSION. `status` is the only caller-influenced input and cannot
//  widen scope — at worst it narrows a set already bounded by both
//  mandatory predicates.
async function list(db, { property_id, allowed_modules, status } = {}) {
  if (!property_id) {
    throw new Error("operator_obligations.list requires a server-derived property_id");
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

  const sql = `
    select ${FIELDS.split(", ").map((f) => "o." + f).join(", ")},
           (o.due_at is not null and o.due_at < now()) as is_overdue
      from obligations o
     where o.property_id = $1
       and o.module = any($2::text[])${statusPredicate}
     order by o.due_at asc nulls last, o.created_at desc, o.id asc`;

  const r = await db.query(sql, vals);
  const rows = r.rows || [];
  return { items: rows, total: rows.length, scope_note: null };
}

module.exports = { list, FIELDS, STATUS_WHITELIST };
