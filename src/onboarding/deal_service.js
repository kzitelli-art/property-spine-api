// ════════════════════════════════════════════════════════════════════
//  deal_service.js — THE CANONICAL DEAL WRITER
//
//  Build 1A made one path by which a property becomes durable truth. A
//  deal had no such path: `deal_intakes` carried no organization, and
//  eleven of twelve deal routes authenticated with a shared bearer key
//  and no actor. Anyone holding that key could open a deal owned by
//  nobody.
//
//  This is the same doctrine, one layer up, deliberately built on the SAME
//  scope resolver rather than a second one:
//
//      resolveCreationScope()  ← property_creation_service, reused verbatim
//
//  Two resolvers would be two answers to "which organization may this
//  actor write into", and the day they disagreed the safer one would be
//  the one nobody called.
//
//  ── WHAT IT GUARANTEES ──────────────────────────────────────────────
//    · organization from the session, never from the body
//    · actor from the session, never from the body
//    · an immutable creation record naming both identities
//    · a property may not be added to a deal owned by another client
//    · one CURRENT deal membership per property, history preserved
//
//  ── WHAT IT IS NOT ──────────────────────────────────────────────────
//  Not a transfer service. Moving a deal between organizations is refused
//  in the database (migration 154) and there is no method here for it.
//  Half-built transfer machinery is worse than none.
// ════════════════════════════════════════════════════════════════════

"use strict";

const { resolveCreationScope } = require("../identity/property_creation_service.js");

const CREATION_SOURCES = Object.freeze(new Set([
  "asset_management_console",   // the Asset Management surface
  "deal_intake_api",            // the existing upload-a-folder front door
  "legacy_backfill",            // migration 154 only; never a live caller
]));

const ONBOARDING_TYPES = Object.freeze(
  new Set(["new_acquisition", "existing_asset", "management_takeover"]));

function refusal(status, reason, receipt, extra = {}) {
  const e = new Error(receipt);
  e.httpStatus = status;
  e.reason = reason;
  e.receipt = receipt;
  Object.assign(e, extra);
  return e;
}

/*  ── createDeal ────────────────────────────────────────────────────
 *  The one place a deal_intakes row is born from a live actor.
 *
 *  `requested_organization_id` is NOT an actor field. A super_admin spans
 *  every organization, so it must NAME the one it is acting for; an
 *  org_admin's organization comes from their login and a named one that
 *  disagrees is refused. That asymmetry is resolveCreationScope's, not
 *  ours — which is the point of sharing it. */
async function createDeal(db, {
  user_id, deal_name, onboarding_type = "existing_asset",
  requested_organization_id = null, creation_source,
} = {}) {
  if (!CREATION_SOURCES.has(creation_source)) {
    throw refusal(500, "unknown_creation_source",
      "This deal was created by a path that has not been registered.",
      { creation_source });
  }
  if (!ONBOARDING_TYPES.has(onboarding_type)) {
    throw refusal(400, "invalid_onboarding_type",
      "A deal is a new acquisition, an existing asset, or a management takeover.",
      { received: onboarding_type });
  }
  const name = deal_name == null ? "" : String(deal_name).trim();
  if (!name) {
    throw refusal(400, "deal_name_required",
      "Give the deal a name. It is how you will find it again.");
  }

  const scope = await resolveCreationScope(db, {
    user_id, requested_organization_id,
  });
  if (!scope.ok) {
    throw refusal(scope.reason === "no_authenticated_actor" ? 401 : 403,
      scope.reason, scope.receipt, { authority: scope });
  }

  const client = await db.connect();
  try {
    await client.query("begin");

    const deal = (await client.query(
      `insert into deal_intakes (onboarding_type, deal_name, organization_id, status)
       values ($1,$2,$3,'created')
       returning id, deal_name, onboarding_type, status, organization_id,
                 organization_absent_reason, created_at`,
      [onboarding_type, name, scope.organization_id])).rows[0];

    await client.query(
      `insert into deal_creation_events
         (deal_intake_id, organization_id, actor_user_id, actor_person_id,
          authority_basis, creation_source, deal_name, onboarding_type)
       values ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [deal.id, scope.organization_id, user_id, scope.actor_person_id || null,
       scope.authority_basis, creation_source, name, onboarding_type]);

    await client.query("commit");
    return { ...deal, authority_basis: scope.authority_basis };
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}

/*  Can this actor operate this deal?  One answer, used by every read and
 *  write below, so "who may see it" and "who may change it" cannot drift.
 *  super_admin spans organizations; everyone else is confined to theirs. */
async function resolveDealScope(db, { user_id, deal_intake_id } = {}) {
  if (!user_id) {
    return { ok: false, status: 401, reason: "no_authenticated_actor",
      receipt: "This requires a signed-in operator. A shared operator key is not an actor." };
  }
  const u = (await db.query(
    `select id, person_id, is_active, status, platform_role, organization_id
       from users where id = $1`, [user_id])).rows[0];
  if (!u) return { ok: false, status: 403, reason: "actor_not_found", receipt: "No such user." };
  if (!u.is_active || u.status !== "active") {
    return { ok: false, status: 403, reason: "actor_inactive", receipt: "This account is not active." };
  }

  const deal = (await db.query(
    `select id, deal_name, onboarding_type, status, organization_id,
            organization_absent_reason, created_at, updated_at
       from deal_intakes where id = $1`, [deal_intake_id])).rows[0];
  if (!deal) return { ok: false, status: 404, reason: "deal_not_found", receipt: "Deal not found." };

  const role = u.platform_role || "member";
  if (role === "super_admin") {
    return { ok: true, deal, actor: u, authority_basis: "platform_role:super_admin" };
  }

  //  A deal with no owner cannot be reached by an organization actor: there
  //  is no organization to compare against, and "unowned" must never read
  //  as "everyone's". Platform repair adopts it first.
  if (!deal.organization_id) {
    return { ok: false, status: 403, reason: "deal_has_no_owner",
      receipt: "This deal has no owning client on record, so it cannot be opened from an " +
               "organization account. It needs to be placed with a client first.",
      absent_reason: deal.organization_absent_reason };
  }
  if (!u.organization_id || u.organization_id !== deal.organization_id) {
    return { ok: false, status: 403, reason: "organization_scope_violation",
      receipt: "This deal belongs to a different client." };
  }
  return { ok: true, deal, actor: u, authority_basis: `platform_role:${role}` };
}

/*  ── addProperty ───────────────────────────────────────────────────
 *  Membership, through the table that already exists (migration 025).
 *  The human picks; a mention is never membership.
 *
 *  Two refusals matter here and neither is a formality:
 *    · a property owned by another client may not join this deal
 *    · a property already current in another deal may not join a second */
async function addProperty(db, { user_id, deal_intake_id, property_id, note = null } = {}) {
  const scope = await resolveDealScope(db, { user_id, deal_intake_id });
  if (!scope.ok) throw refusal(scope.status, scope.reason, scope.receipt, scope);

  const prop = (await db.query(
    `select id, name, display_name, address, city, state, organization_id
       from properties where id = $1`, [property_id])).rows[0];
  if (!prop) throw refusal(404, "property_not_found", "Property not found.");

  if (scope.deal.organization_id && prop.organization_id
      && prop.organization_id !== scope.deal.organization_id) {
    throw refusal(403, "property_belongs_to_another_client",
      `${prop.name || prop.address} belongs to a different client than this deal. ` +
      `Adding it here would put one client's building inside another's deal.`);
  }

  const held = (await db.query(
    `select dp.intake_id, d.deal_name
       from deal_intake_properties dp
       join deal_intakes d on d.id = dp.intake_id
      where dp.property_id = $1 and dp.status = 'current'
      limit 1`, [property_id])).rows[0];
  if (held && held.intake_id !== deal_intake_id) {
    throw refusal(409, "property_already_in_a_current_deal",
      `${prop.name || prop.address} is already part of "${held.deal_name || "another deal"}". ` +
      `A property belongs to one deal at a time — remove it there first.`,
      { current_deal_id: held.intake_id });
  }
  if (held && held.intake_id === deal_intake_id) {
    return { already_member: true, property: prop,
      receipt: `${prop.name || prop.address} is already part of this deal.` };
  }

  await db.query(
    `insert into deal_intake_properties
       (intake_id, property_id, note, status, added_by_user_id, authority_basis)
     values ($1,$2,$3,'current',$4,$5)
     on conflict (intake_id, property_id) do update
        set status = 'current', released_at = null, released_reason = null,
            added_by_user_id = excluded.added_by_user_id,
            authority_basis  = excluded.authority_basis`,
    [deal_intake_id, property_id, note, user_id, scope.authority_basis]);

  return { already_member: false, property: prop,
    receipt: `${prop.name || prop.address} is now part of "${scope.deal.deal_name}".` };
}

/*  Release, not delete. The membership stays as history with a stated
 *  reason; the property itself is untouched. */
async function releaseProperty(db, { user_id, deal_intake_id, property_id, reason = null } = {}) {
  const scope = await resolveDealScope(db, { user_id, deal_intake_id });
  if (!scope.ok) throw refusal(scope.status, scope.reason, scope.receipt, scope);

  const r = await db.query(
    `update deal_intake_properties
        set status = 'released', released_at = now(),
            released_reason = coalesce($3, 'removed_by_operator')
      where intake_id = $1 and property_id = $2 and status = 'current'
      returning id`,
    [deal_intake_id, property_id, reason]);
  if (r.rowCount === 0) {
    throw refusal(404, "not_a_current_member", "That property is not currently on this deal.");
  }
  return { receipt: "Removed from the deal. The property itself is untouched, and the " +
                    "record that it was once on this deal remains." };
}

/*  ── reads ─────────────────────────────────────────────────────────
 *  Scoped by the actor's organization for everyone but super_admin, so a
 *  list is never a way to learn that another client's deals exist. */
async function listDeals(db, { user_id } = {}) {
  if (!user_id) throw refusal(401, "no_authenticated_actor", "Sign in to see deals.");
  const u = (await db.query(
    `select id, platform_role, organization_id, is_active, status from users where id=$1`,
    [user_id])).rows[0];
  if (!u || !u.is_active || u.status !== "active") {
    throw refusal(403, "actor_inactive", "This account is not active.");
  }
  const isSuper = (u.platform_role || "member") === "super_admin";

  const rows = (await db.query(
    `select d.id, d.deal_name, d.onboarding_type, d.status, d.organization_id,
            d.organization_absent_reason, d.created_at,
            o.name as organization_name,
            count(dp.id) filter (where dp.status='current')::int as property_count,
            count(op.id) filter (where op.status='established')::int as established_count
       from deal_intakes d
       left join organizations o on o.id = d.organization_id
       left join deal_intake_properties dp on dp.intake_id = d.id
       left join opening_positions op
              on op.deal_intake_id = d.id and op.status = 'established'
      where ($1::boolean or d.organization_id = $2::uuid)
      group by d.id, o.name
      order by d.created_at desc
      limit 200`,
    [isSuper, u.organization_id || null])).rows;
  return rows;
}

/*  One deal, with its current properties and where each stands. This is
 *  the Asset Management deal page's whole read. */
async function getDeal(db, { user_id, deal_intake_id } = {}) {
  const scope = await resolveDealScope(db, { user_id, deal_intake_id });
  if (!scope.ok) throw refusal(scope.status, scope.reason, scope.receipt, scope);

  const properties = (await db.query(
    `select p.id, p.name, p.display_name, p.address, p.city, p.state, p.zip,
            p.canonical_key, p.canonical_key_absent_reason, p.leasing_basis,
            dp.note, dp.created_at as added_at,
            (select count(*)::int from units u where u.property_id = p.id) as unit_count,
            op.id            as opening_position_id,
            op.as_of_date    as opening_as_of,
            op.positions_established,
            op.positions_unresolved,
            op.established_at,
            act.id           as open_activation_id,
            act.status       as activation_status
       from deal_intake_properties dp
       join properties p on p.id = dp.property_id
       left join opening_positions op
              on op.property_id = p.id and op.status = 'established'
       left join lateral (
            select a.id, a.status from activations a
             where a.property_id = p.id and a.deal_id = dp.intake_id
             order by a.created_at desc limit 1) act on true
      where dp.intake_id = $1 and dp.status = 'current'
      order by p.name nulls last, p.address`,
    [deal_intake_id])).rows;

  return { deal: scope.deal, properties, authority_basis: scope.authority_basis };
}

module.exports = {
  createDeal, addProperty, releaseProperty, listDeals, getDeal,
  resolveDealScope, CREATION_SOURCES, ONBOARDING_TYPES, refusal,
};
