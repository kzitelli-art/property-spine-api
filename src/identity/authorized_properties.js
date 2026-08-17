// ════════════════════════════════════════════════════════════════════
//  authorized_properties.js — WHICH PROPERTIES MAY THIS OPERATOR OPERATE?
//
//  ONE resolver answers one question, for every surface that needs to
//  offer a person a choice of property:
//
//      given an authenticated user, which properties do they hold an
//      ACTIVE assignment to, and what may they do inside each?
//
//  ── WHY THIS FILE EXISTS AT ALL ─────────────────────────────────────
//  The Phase Zero audit found this query written three times:
//
//    src/technician/conversation.js   actorScope()  — ids only, org-scoped
//    src/identity/super_admin.js      GET /admin/users/:id — admin view of
//                                     ANOTHER user's assignments
//    src/identity/staff_identity_resolver.js — array_agg for the identity
//                                     hygiene audit
//
//  None of the three answers the operator's own question in the operator's
//  own session, so the picker had nothing to call and the app used a
//  hard-coded fixture array instead. This is that missing read, written
//  once.
//
//  The three above are NOT migrated onto this resolver in this slice. Two
//  of them are genuinely different questions (an admin reading somebody
//  else's assignments; an audit aggregating ids), and the third lives in
//  the technician lane, which Phase Zero is scoped out of. They are
//  recorded as consolidation candidates in the handoff rather than changed
//  here — a slice that quietly refactors the technician lane is not the
//  slice it said it was.
//
//  ── WHAT MAKES IT AUTHORITY AND NOT A SUGGESTION ────────────────────
//  It reads `property_team_assignments`, which is the authority (the same
//  table `issueStaffSession` re-checks before minting). `active = true` is
//  not a filter for tidiness — a revoked assignment must vanish from the
//  list, and it must vanish for the same reason the mint would refuse it.
//
//  BUT: appearing in this list is NOT authorization to enter. This read is
//  a convenience for rendering a choice. The grant happens at the mint,
//  server-side, every time. A caller that treats presence in this list as
//  permission has reintroduced browser-held authority (§21).
//
//  ── user_id IS NEVER SUPPLIED BY A CALLER ───────────────────────────
//  Every route that uses this passes the id off a resolved staff session.
//  There is deliberately no "list properties for user X" HTTP surface here
//  — that already exists, gated to super admins, in super_admin.js.
//
//  CLASSIFICATION: Class 1 — permanent product primitive.
//  READ-ONLY. Writes nothing.
// ════════════════════════════════════════════════════════════════════

"use strict";

/*  The properties an authenticated user may operate, ordered for a human:
 *  by the name they actually read on screen.
 *
 *  `coalesce(display_name, name)` matches /operator/me and every other
 *  surface (migration 060): display_name is what humans call the property,
 *  `name` is load-bearing plumbing. A picker that showed the plumbing name
 *  would disagree with the chrome the operator sees after choosing.
 *
 *  Address is returned when present and null when not — the card UI shows
 *  it as a subtitle, and an honest blank beats a placeholder (§5).
 */
async function listAuthorizedProperties(db, { user_id } = {}) {
  if (!db || typeof db.query !== "function") {
    throw new Error("listAuthorizedProperties requires a database client");
  }
  if (!user_id) throw new Error("listAuthorizedProperties requires user_id");

  const { rows } = await db.query(
    `select p.id                              as property_id,
            coalesce(p.display_name, p.name)  as property_name,
            nullif(btrim(coalesce(p.address, '')), '') as address,
            a.role_title,
            a.role_key,
            coalesce(a.allowed_modules, '{}')     as allowed_modules,
            coalesce(a.primary_for_modules, '{}') as primary_for_modules,
            a.can_manage_roles
       from property_team_assignments a
       join properties p on p.id = a.property_id
      where a.user_id = $1
        and a.active = true
      order by coalesce(p.display_name, p.name) asc, p.id asc`,
    [user_id]
  );

  return rows.map((r) => ({
    property_id: r.property_id,
    property_name: r.property_name,
    address: r.address || null,
    role_title: r.role_title || null,
    role_key: r.role_key || null,
    allowed_modules: Array.isArray(r.allowed_modules) ? r.allowed_modules : [],
    primary_for_modules: Array.isArray(r.primary_for_modules) ? r.primary_for_modules : [],
    can_manage_roles: !!r.can_manage_roles,
  }));
}

module.exports = { listAuthorizedProperties };
