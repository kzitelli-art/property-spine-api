// ════════════════════════════════════════════════════════════════════
//  staff_identity_resolver.js — THE canonical staff identity module.
//
//  DOCTRINE (Identity Bridge contract, Part 3):
//    No other API module may join users.person_id to assignments, directly
//    or indirectly. Every route needing staff identity or task ownership
//    calls THIS module. tests/gate_no_raw_bridge_joins.js enforces it.
//
//  THE RESOLUTION CHAIN:
//    authenticated user
//      → deliberate users.person_id bridge (audited, never inferred)
//      → active person-keyed assignment (004) at THIS property
//      → eligible owner
//    anything uncertain → fail closed, never a faked owner.
//
//  THE V1 ACTIVE-USER RULE (locked, fail-closed):
//    eligible = users.is_active = true AND users.status = 'active'
//  Anything else — is_active=false, 'suspended', 'invited', or ANY unknown
//    future status — is ineligible to receive newly created work.
//
//  LIVE STATES (every one reads a real, Neon-confirmed column):
//    resolved · unbridged · conflicted · user_inactive ·
//    assignment_inactive · not_assigned_here · free_text_claim
//
//  RESERVED STATES (no column exists yet — this module NEVER returns them,
//  and never silently treats the unreadable condition as passing):
//    assignment_ended                  (assignments has no end-date)
//    assignment_not_eligible_by_work_type (no per-work-type field; V1
//                                       eligibility is any active assignment
//                                       at the property, matching the prior
//                                       eligibleOwner behavior)
//
//  SCOPE NOTES:
//    • assignments (migration 004, person-keyed) is the ONLY eligibility
//      source. property_team_assignments (035, user-keyed) is a
//      reconciliation/divergence-report source ONLY — it creates no
//      eligibility, no ownership, no second truth. (Locked decision.)
//    • Historical attribution is never rewritten here. This module answers
//      "who may own NEW work now" — past events keep their raw actors.
// ════════════════════════════════════════════════════════════════════

"use strict";

const LIVE_STATES = Object.freeze([
  "resolved", "unbridged", "conflicted", "user_inactive",
  "assignment_inactive", "not_assigned_here", "free_text_claim",
]);

const RESERVED_STATES = Object.freeze([
  "assignment_ended", "assignment_not_eligible_by_work_type",
]);

// The one active-user predicate. Referenced everywhere; never re-derived.
const ACTIVE_USER_PREDICATE = `u.is_active = true and u.status = 'active'`;

// ── the canonical user read (id, activity, bridge, classification) ──
async function readUser(client, userId) {
  if (!userId) return null;
  const r = await client.query(
    `select u.id, u.name, u.email, u.role, u.is_active, u.status,
            u.person_id, u.account_kind
       from users u where u.id = $1`, [userId]);
  return r.rows[0] || null;
}

function userIsActive(u) {
  return !!u && u.is_active === true && u.status === "active";
}

// A person linked from MORE THAN ONE currently-active user account is a
// conflict: no automatic ownership until an admin deliberately resolves it.
async function personHasConflictingLinks(client, personId) {
  const r = await client.query(
    `select count(*)::int as n from users u
      where u.person_id = $1 and ${ACTIVE_USER_PREDICATE}`, [personId]);
  return (r.rows[0]?.n || 0) > 1;
}

// ════════════════════════════════════════════════════════════════════
//  resolveStaffIdentity(client, { user_id, property_id })
//  → { state, basis, user_id, person_id?, assignment_id?, property_id,
//      role?, resolved_at }
//  work_type is accepted and recorded but NOT used for eligibility in V1
//  (reserved — see header). Passing it never changes the answer.
// ════════════════════════════════════════════════════════════════════
async function resolveStaffIdentity(client, { user_id, property_id, work_type = null }) {
  const resolved_at = new Date().toISOString();
  const base = { user_id: user_id || null, property_id: property_id || null,
                 work_type_considered: false, resolved_at };

  if (!user_id) return { ...base, state: "free_text_claim", basis: "no_user_id" };

  const u = await readUser(client, user_id);
  if (!u) return { ...base, state: "unbridged", basis: "user_not_found" };

  // Fail-closed active rule FIRST: an inactive/suspended/invited/unknown-
  // status account can never proceed to ownership, bridged or not.
  if (!userIsActive(u)) {
    return { ...base, state: "user_inactive",
             basis: `is_active=${u.is_active} status=${u.status}` };
  }

  if (!u.person_id) return { ...base, state: "unbridged", basis: "no_bridge" };

  // Defense in depth: only classified human staff resolve, even if a bridge
  // pointer somehow exists on another kind (the workflow forbids creating one).
  if (u.account_kind !== "human_staff") {
    return { ...base, state: "unbridged",
             basis: `account_kind_not_bridgeable:${u.account_kind}` };
  }

  if (await personHasConflictingLinks(client, u.person_id)) {
    return { ...base, state: "conflicted", person_id: u.person_id,
             basis: "person_linked_to_multiple_active_users" };
  }

  if (!property_id) {
    return { ...base, state: "not_assigned_here", person_id: u.person_id,
             basis: "no_property_scope" };
  }

  const asg = await client.query(
    `select a.id, a.role, a.is_active
       from assignments a
      where a.person_id = $1 and a.property_id = $2
      order by a.is_active desc, a.created_at desc`,
    [u.person_id, property_id]);

  if (asg.rows.length === 0) {
    return { ...base, state: "not_assigned_here", person_id: u.person_id,
             basis: "no_assignment_at_property" };
  }
  const active = asg.rows.find((a) => a.is_active === true);
  if (!active) {
    return { ...base, state: "assignment_inactive", person_id: u.person_id,
             basis: "assignment_exists_inactive" };
  }

  return {
    ...base, state: "resolved", basis: "bridge_plus_active_assignment",
    person_id: u.person_id, assignment_id: active.id, role: active.role,
  };
}

// ════════════════════════════════════════════════════════════════════
//  resolveEligibleOwner(client, propertyId, candidates)
//  Drop-in successor to the scattered eligibleOwner helpers. Walks a
//  preference-ordered candidate list (caller supplies: actual host first,
//  scheduled host second, explicit assignee last — or its own order) and
//  returns the FIRST candidate that fully resolves, else honest UNASSIGNED.
//  Return shape kept compatible: { owner, basis } (+ trail for receipts).
// ════════════════════════════════════════════════════════════════════
async function resolveEligibleOwner(client, propertyId, candidates) {
  const trail = [];
  for (const uid of candidates || []) {
    if (!uid) continue;
    const res = await resolveStaffIdentity(client, { user_id: uid, property_id: propertyId });
    trail.push({ user_id: uid, state: res.state, basis: res.basis });
    if (res.state === "resolved") {
      return { owner: uid, basis: "eligible_assignment",
               person_id: res.person_id, assignment_id: res.assignment_id, trail };
    }
  }
  return { owner: null, basis: "unassigned", trail };
}

// ════════════════════════════════════════════════════════════════════
//  listEligibleStaff(client, propertyId)
//  The roster: ONLY fully-resolving people — classified human staff,
//  active-eligible accounts, deliberately bridged, unconflicted, with an
//  active assignment at THIS property. Honest empty until population.
// ════════════════════════════════════════════════════════════════════
async function listEligibleStaff(client, propertyId) {
  const r = await client.query(
    `select distinct u.id, u.name, u.role
       from users u
       join assignments a on a.person_id = u.person_id
      where a.property_id = $1
        and a.is_active = true
        and ${ACTIVE_USER_PREDICATE}
        and u.account_kind = 'human_staff'
        and u.person_id is not null
        and (select count(*) from users u2
              where u2.person_id = u.person_id
                and u2.is_active = true and u2.status = 'active') = 1
      order by u.name asc`, [propertyId]);
  return r.rows;
}

// A free-text host name is an attributed CLAIM, display-only, never an owner.
function freeTextClaim(name) {
  return { state: "free_text_claim", basis: "display_only",
           display: name ? String(name).slice(0, 120) : null };
}

// ════════════════════════════════════════════════════════════════════
//  coverageRows(client) — the raw read behind the bridge coverage +
//  divergence report. Lives HERE because it joins users↔persons↔
//  assignments: the static gate forbids that read anywhere else.
//  Shaping (bridge_state, divergence flags) belongs to staffbridge.js.
// ════════════════════════════════════════════════════════════════════
async function coverageRows(client) {
  const r = await client.query(`
    select u.id, u.name, u.email, u.role::text as role,
           u.is_active, u.status, u.account_kind, u.person_id,
           p.name as person_name,
           (select count(*)::int from users u2
             where u2.person_id = u.person_id
               and u2.is_active = true and u2.status = 'active'
               and u.person_id is not null)                       as active_links_to_person,
           (select count(*)::int from assignments a
             where a.person_id = u.person_id and a.is_active = true
               and u.person_id is not null)                       as active_assignments_004,
           coalesce((select array_agg(distinct a.property_id) from assignments a
             where a.person_id = u.person_id and a.is_active = true
               and u.person_id is not null), '{}')                as assignment_properties_004,
           (select count(*)::int from property_team_assignments t
             where t.user_id = u.id and t.active = true)          as active_team_assignments_035,
           coalesce((select array_agg(distinct t.property_id) from property_team_assignments t
             where t.user_id = u.id and t.active = true), '{}')   as team_properties_035,
           (select row_to_json(b) from (
              select action, performed_at, performed_by_user_id, reason_code
                from user_person_bridge_audit ba
               where ba.user_id = u.id order by performed_at desc limit 1) b) as last_bridge_event
      from users u
      left join persons p on p.id = u.person_id
     order by u.name asc`);
  return r.rows;
}

module.exports = {
  resolveStaffIdentity,
  resolveEligibleOwner,
  listEligibleStaff,
  coverageRows,
  freeTextClaim,
  readUser,
  userIsActive,
  LIVE_STATES,
  RESERVED_STATES,
  ACTIVE_USER_PREDICATE,
};
