// ════════════════════════════════════════════════════════════════════
//  pricing_authority.js — ONE CANONICAL AUTHORIZATION PATH
//
//  Four verbs, resolved for a person on a property:
//      may_prepare_pricing · may_review_pricing · may_publish_pricing
//      may_manage_concession_authority
//
//  ── NEVER INFERRED ───────────────────────────────────────────────────
//  Not from a name, not from a job title, not from "they can see the
//  property". Generic property membership is how nineteen leasing assignments
//  would silently become nineteen people who can set the building's rents.
//  Authority comes from exactly two sources, and both are explicit:
//
//    1. an ACTIVE owner / asset_manager assignment on THIS property
//    2. an in-window concession_authority_grant naming the verb
//
//  ── FAILS CLOSED ─────────────────────────────────────────────────────
//  Unknown person, unknown property, no assignment, expired grant, database
//  read failure — every one of them yields false. There is no branch that
//  grants a verb by default, and `basis` is null whenever a verb is false, so
//  a receipt can never show authority without saying where it came from.
//
//  ── SEPARATION OF DUTIES ─────────────────────────────────────────────
//  Preparing is not reviewing. An owner holds all four by assignment, which
//  is correct for a single-owner property, but the verbs stay distinct so a
//  larger property can split them without a schema change — and so a receipt
//  records WHICH verb was exercised, not merely that someone senior acted.
// ════════════════════════════════════════════════════════════════════

"use strict";

const VERBS = [
  "may_prepare_pricing",
  "may_review_pricing",
  "may_publish_pricing",
  "may_manage_concession_authority",
];

// An owner or asset manager holds every pricing verb on their own property.
// This is the ONLY role-derived authority, it is enumerated rather than
// pattern-matched, and no other role appears here — a property_manager or a
// leasing agent gets nothing from their role alone.
const FULL_AUTHORITY_ROLES = new Set(["owner", "asset_manager"]);

const DENY = (reason) => ({
  person_id: null, name: null,
  may_prepare_pricing: false, may_review_pricing: false,
  may_publish_pricing: false, may_manage_concession_authority: false,
  basis: { may_prepare_pricing: null, may_review_pricing: null,
           may_publish_pricing: null, may_manage_concession_authority: null },
  denied_reason: reason,
});

/**
 * Resolve the four verbs. READ-ONLY.
 * @returns { person_id, name, <four booleans>, basis:{verb: source|null}, denied_reason }
 */
// MIGRATED TO THE CANONICAL ACTOR CONTEXT. Pricing no longer resolves a
// session to a human — resolveActorContext does, once, for every governed
// surface. What remains here is the person-keyed form used by constructed
// tests and by callers that already hold a person id.
const { resolveActorContext } = require("../identity/actor_context");

async function pricingAuthority(pool, { property_id, person_id, user_id = null } = {}) {
  if (!property_id) return DENY("no_property_context");

  // A session identifies a `users` row; authority is held by a `persons` row.
  // Resolution is delegated rather than repeated, so there is exactly one
  // place in the system that decides who a signed-in operator is.
  if (!person_id && user_id) {
    const ctx = await resolveActorContext(pool, { property_id, user_id });
    if (!ctx.ok) return DENY(ctx.failure_reason || "actor_context_unresolved");
    return {
      person_id: ctx.person.person_id,
      name: ctx.person.display_name,
      may_prepare_pricing: ctx.capabilities.may_prepare_pricing,
      may_review_pricing: ctx.capabilities.may_review_pricing,
      may_publish_pricing: ctx.capabilities.may_publish_pricing,
      may_manage_concession_authority: ctx.capabilities.may_manage_concession_authority,
      basis: {
        may_prepare_pricing: ctx.basis.may_prepare_pricing,
        may_review_pricing: ctx.basis.may_review_pricing,
        may_publish_pricing: ctx.basis.may_publish_pricing,
        may_manage_concession_authority: ctx.basis.may_manage_concession_authority,
      },
      denied_reason: ctx.failure_reason,
      // Carried so every downstream receipt can name BOTH identities.
      session_user_id: ctx.user.user_id,
      link_status: ctx.link_status,
    };
  }
  if (!person_id) return DENY("no_person_identified");

  let person;
  try {
    person = (await pool.query("select id, name from persons where id=$1", [person_id])).rows[0] || null;
  } catch (e) {
    // A failed authority read is a DENIAL, never an approval. This is the one
    // place where "unavailable" and "not permitted" must collapse the safe way.
    return DENY("authority_read_failed");
  }
  if (!person) return DENY("person_not_found");

  const role = (await pool.query(
    `select role from assignments
      where property_id=$1 and person_id=$2 and is_active=true
      order by case when role in ('owner','asset_manager') then 0 else 1 end
      limit 1`, [property_id, person.id])).rows[0] || null;

  const grant = (await pool.query(
    `select id, may_edit_pricing, may_review_pricing, may_publish_public_offers,
            may_manage_concession_authority, may_prepare_pricing,
            effective_from, effective_until
       from concession_authority_grants
      where property_id=$1 and person_id=$2
        and effective_from <= now()
        and (effective_until is null or effective_until > now())
      order by effective_from desc limit 1`, [property_id, person.id])).rows[0] || null;

  const byRole = !!(role && FULL_AUTHORITY_ROLES.has(role.role));
  const roleBasis = byRole ? `assignment:${role.role}` : null;

  const resolve = (grantField) => {
    if (byRole) return { granted: true, basis: roleBasis };
    if (grant && grant[grantField]) return { granted: true, basis: `grant:${grant.id}` };
    return { granted: false, basis: null };
  };

  // may_prepare is satisfied by either the new explicit column or the
  // pre-existing may_edit_pricing, which meant the same thing before the verb
  // had a name. Honouring the old column avoids silently revoking authority
  // somebody was already given.
  const prepare = byRole ? { granted: true, basis: roleBasis }
    : grant && (grant.may_prepare_pricing || grant.may_edit_pricing)
      ? { granted: true, basis: `grant:${grant.id}` }
      : { granted: false, basis: null };
  const review = resolve("may_review_pricing");
  const publish = byRole ? { granted: true, basis: roleBasis }
    : grant && grant.may_publish_public_offers
      ? { granted: true, basis: `grant:${grant.id}` }
      : { granted: false, basis: null };
  const manage = resolve("may_manage_concession_authority");

  return {
    person_id: person.id,
    name: person.name,
    may_prepare_pricing: prepare.granted,
    may_review_pricing: review.granted,
    may_publish_pricing: publish.granted,
    may_manage_concession_authority: manage.granted,
    basis: {
      may_prepare_pricing: prepare.basis,
      may_review_pricing: review.basis,
      may_publish_pricing: publish.basis,
      may_manage_concession_authority: manage.basis,
    },
    denied_reason: (prepare.granted || review.granted || publish.granted || manage.granted)
      ? null : "no_governed_pricing_authority_on_this_property",
  };
}

/**
 * Who holds pricing authority anywhere. Read-only inventory for the receipt.
 */
async function authorityInventory(pool, { property_id = null } = {}) {
  const roles = (await pool.query(
    `select a.property_id, pr.name as property_name, p.id as person_id, p.name, a.role
       from assignments a
       join persons p on p.id = a.person_id
       join properties pr on pr.id = a.property_id
      where a.is_active = true and a.role in ('owner','asset_manager')
        and ($1::uuid is null or a.property_id = $1)
      order by pr.name`, [property_id])).rows;

  const grants = (await pool.query(
    `select g.property_id, pr.name as property_name, p.id as person_id, p.name,
            g.may_prepare_pricing, g.may_edit_pricing, g.may_review_pricing,
            g.may_publish_public_offers, g.may_manage_concession_authority,
            g.effective_from, g.effective_until
       from concession_authority_grants g
       join persons p on p.id = g.person_id
       join properties pr on pr.id = g.property_id
      where g.effective_from <= now()
        and (g.effective_until is null or g.effective_until > now())
        and ($1::uuid is null or g.property_id = $1)`, [property_id])).rows;

  const propertyCount = Number((await pool.query("select count(*)::int n from properties")).rows[0].n);

  return {
    by_assignment: roles.map((r) => ({
      property_id: r.property_id, property: r.property_name,
      person_id: r.person_id, person: r.name, role: r.role,
      verbs: VERBS,   // an owner/asset manager holds all four
    })),
    by_grant: grants.map((g) => ({
      property_id: g.property_id, property: g.property_name,
      person_id: g.person_id, person: g.name,
      verbs: VERBS.filter((v) =>
        v === "may_prepare_pricing" ? (g.may_prepare_pricing || g.may_edit_pricing)
        : v === "may_publish_pricing" ? g.may_publish_public_offers
        : v === "may_review_pricing" ? g.may_review_pricing
        : g.may_manage_concession_authority),
      effective_from: g.effective_from, effective_until: g.effective_until,
    })),
    summary: {
      properties_total: propertyCount,
      properties_with_publish_authority: new Set([
        ...roles.map((r) => String(r.property_id)),
        ...grants.filter((g) => g.may_publish_public_offers).map((g) => String(g.property_id)),
      ]).size,
      grants_total: grants.length,
    },
    // Stated so an empty inventory is never read as "authority is open".
    rule: "Authority is explicit. A property with no row here has NO ONE who may publish pricing, " +
          "and the publication service fails closed for every person on it.",
  };
}

module.exports = { pricingAuthority, authorityInventory, VERBS, FULL_AUTHORITY_ROLES, DENY };
