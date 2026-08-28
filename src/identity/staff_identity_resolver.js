// ════════════════════════════════════════════════════════════════════
//  staff_identity_resolver.js — THE canonical staff identity module.
//
//  DOCTRINE (Identity Bridge contract, Part 3):
//    No other API module may join users.person_id to assignments, directly
//    or indirectly. Every route needing staff identity or task ownership
//    calls THIS module. tests/gates/gate_no_raw_bridge_joins.js enforces it.
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
//      ↑ The 2026-07-26 ruling asked that an owner hold "an eligible
//        assignment for that task type". HALF-ENFORCED, and said so rather
//        than faked: there is no per-work-type column, so this module still
//        enforces only "an active assignment at this property". When a
//        work-type field exists, this reserved state becomes live and the
//        ruling is satisfied in full. Do not simulate it from role names.
//
//  SCOPE NOTES:
//    • assignments (migration 004, person-keyed) is the ONLY source that
//      GRANTS eligibility. property_team_assignments (035, user-keyed)
//      grants nothing and never will.
//
//      ⚠ SUPERSEDED IN PART — owner ruling 2026-07-26. The original note
//      read: "property_team_assignments … creates no eligibility, no
//      ownership, no second truth. (Locked decision.)" It is recorded here
//      rather than deleted, because a locked decision should be seen to
//      change, not quietly vanish.
//
//      WHY IT CHANGED. The two tables had drifted into disjoint
//      populations: at Demo Building, three people could be ASSIGNED work
//      (assignments) and four could ACT on it (property_team_assignments),
//      with ZERO overlap. Every auto-assigned obligation therefore named an
//      owner who could not open it — not overdue, not flagged, not broken,
//      just quietly false. "Honest blank beats confident wrong" (§5) makes
//      UNASSIGNED the correct answer there, and a name the incorrect one.
//
//      WHAT CHANGED, PRECISELY. property_team_assignments is now a
//      NECESSARY condition for ownership, never a sufficient one. It still
//      grants nothing: it can only DENY. A person with property authority
//      and no `assignments` row remains ineligible exactly as before, so no
//      second source of truth was created — one source still grants, and a
//      second may now veto.
//
//      WHAT DID NOT CHANGE. The two identity systems are NOT merged; that
//      remains the later structural fix. Manager COVERAGE
//      (leasing_conversion.resolveSendActionBasis) is untouched and still
//      lets an authorised manager act on work they do not own — coverage
//      authority must never make a manager a default owner. Completion
//      attribution is untouched: closure records closed_by_user_id and
//      snapshots identity at close, so a covering manager who finishes the
//      work never retroactively becomes its owner.
//    • Historical attribution is never rewritten here. This module answers
//      "who may own NEW work now" — past events keep their raw actors.
// ════════════════════════════════════════════════════════════════════

"use strict";

const LIVE_STATES = Object.freeze([
  "resolved", "unbridged", "conflicted", "user_inactive",
  "assignment_inactive", "not_assigned_here", "free_text_claim",
  // 2026-07-26: bridged, actively assigned, but holds no active team
  // assignment at this property — so they could be handed work they have no
  // authority to perform. Distinct from not_assigned_here on purpose: the
  // person genuinely works here, the authority record is what is missing.
  "no_property_authority",
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

// BRICK ONE (Gate 3)  the ONE central internal-QA output-exclusion
// predicate. Identity eligibility lives HERE, with the account-
// classification axis it reads. Output boundaries (rosters, eligible-staff,
// queues, metrics, reporting, outbound, AI context) exclude internal_qa
// through this helper  never scattered per-route checks. A QA identity
// can OPERATE (sessions issue/resolve normally); it never contaminates
// operating output.
function userIsOperational(u) {
  return userIsActive(u) && u.account_kind !== "internal_qa";
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

  // ── AUTHORITY TO PERFORM, NOT MERELY TO BE NAMED (2026-07-26) ──────
  //  An owner must be able to do the work. This is a VETO, not a grant:
  //  it can only remove eligibility the assignment already conferred, so
  //  property_team_assignments still creates nothing.
  //
  //  Deliberately NOT checked here: role, role_title, or module. Those are
  //  COVERAGE questions — "may this actor perform this action" — and they
  //  belong to resolveSendActionBasis. Reading them here would make every
  //  authorised manager a default owner, which is the collapse this fix
  //  exists to prevent.
  const authority = await client.query(
    `select 1 from property_team_assignments
      where user_id = $1 and property_id = $2 and active = true limit 1`,
    [user_id, property_id]);
  if (authority.rows.length === 0) {
    return { ...base, state: "no_property_authority", person_id: u.person_id,
             assignment_id: active.id, role: active.role,
             basis: "assigned_here_but_no_active_team_authority" };
  }

  return {
    ...base, state: "resolved", basis: "bridge_plus_active_assignment_plus_authority",
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
//  Shaping (bridge_state, divergence flags) belongs to staff_bridge.js.
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
  userIsOperational,
  LIVE_STATES,
  RESERVED_STATES,
  ACTIVE_USER_PREDICATE,
};
