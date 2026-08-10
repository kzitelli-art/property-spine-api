// ════════════════════════════════════════════════════════════════════
//  property_hierarchy_service.js — WHICH CLIENT A PROPERTY BELONGS TO
//
//  1A-1 made "create a property" mean one thing. Creation is not the only
//  way the hierarchy changes: `POST /admin/organizations/:id/properties`
//  reassigned a building to a client with a bare UPDATE — no check that it
//  already belonged to someone else, and no record that it moved.
//
//  ── ADOPTION IS ALLOWED. TRANSFER IS REFUSED. ────────────────────────
//      null  →  org        ADOPTION      the repair path for legacy orphans
//      orgA  →  orgB       REPARENTING   refused
//      org   →  null       ORPHANING     refused
//
//  Refusing is the deliberate choice. A client transfer is a real event
//  needing consent, an effective date, and a decision about what the
//  previous client may still see in historical reporting. Half-built
//  transfer machinery would look like the feature while getting exactly
//  those parts wrong. Migration 151 carries the same refusal in the
//  database, so it binds every writer and not only this one.
//
//  ── ADOPTION IS NOT SILENT EITHER ────────────────────────────────────
//  The one transition that remains legal is recorded in
//  property_organization_events, with both actor identities and the
//  authority exercised. Containment that leaves the surviving path
//  unattributable has moved the problem, not solved it.
//
//  CLASSIFICATION: Class 1 permanent primitive.
// ════════════════════════════════════════════════════════════════════

"use strict";

const { resolveCreationScope } = require("./property_creation_service.js");

function refusal(status, reason, receipt, extra = {}) {
  const e = new Error(receipt);
  e.httpStatus = status;
  e.refusalReason = reason;
  e.publicMessage = receipt;
  e.detail = extra;
  return e;
}

/**
 * Place a property with a client. ADOPTION ONLY — see the header.
 *
 * ── ADOPTION IS REPAIR, NOT PROPERTY MANAGEMENT (ruling) ─────────────
 * This first reused resolveCreationScope, which lets an `org_admin` act
 * within their own organization. For creation that is right. For adoption
 * it is a hole: an ordinary org admin could CLAIM an orphaned property
 * simply because it currently has no parent, and the 1A-1 audit found the
 * orphan set was created by doors with no organization at all — so the
 * orphans are exactly the properties whose real owner is unrecorded.
 *
 * Adoption is therefore restricted to `super_admin`: legacy repair run by
 * platform infrastructure, not a management action any customer admin can
 * take. The narrower rule is stated here rather than inherited, because
 * this is a different question from "may you create a property".
 *
 * RETIREMENT CONDITION: this door exists to reconcile the production
 * orphan set that predates 1A-1. Once that set is empty — measured, not
 * assumed, by the same read that answers the keyless-property question —
 * this function and its route should be removed, not left standing as a
 * general-purpose reparenting tool with a friendly name. Until then every
 * use is attributable.
 *
 * @param spec { actor:{user_id}, property_id, organization_id, reason? }
 * @returns { property_id, organization_id, kind:'adoption', already:boolean }
 */
async function assignPropertyToOrganization(pool, spec = {}) {
  const { actor = {}, property_id, organization_id = null, reason = null } = spec;

  if (!property_id) throw refusal(400, "property_required", "property_id is required.");

  //  Creation scope first — it establishes a live, active actor and that
  //  the named organization exists, and it fails closed on every read.
  const scope = await resolveCreationScope(pool, {
    user_id: actor.user_id, requested_organization_id: organization_id,
  });
  if (!scope.ok) {
    const status = scope.reason === "no_authenticated_actor" ? 401
      : scope.reason === "organization_not_found" ? 404
      : scope.reason === "organization_required" ? 400
      : scope.reason === "identity_read_failed" ? 503
      : 403;
    throw refusal(status, scope.reason, scope.receipt);
  }

  //  …then the NARROWER adoption rule on top of it.
  if (scope.authority_basis !== "platform_role:super_admin") {
    throw refusal(403, "adoption_requires_platform_repair_authority",
      "Placing an unowned property with a client is a platform repair action, not a " +
      "management one. An organization admin cannot claim a property that currently " +
      "has no owner.",
      { authority_held: scope.authority_basis });
  }

  const client = await pool.connect();
  try {
    await client.query("begin");

    //  FOR UPDATE: hold the row for the life of the transaction so two
    //  concurrent adoptions cannot both read null and both proceed.
    const prop = (await client.query(
      `select id, name, organization_id from properties where id = $1 for update`,
      [property_id])).rows[0];
    if (!prop) {
      await client.query("rollback");
      throw refusal(404, "property_not_found", "Property not found.");
    }

    //  Already where it is being asked to go. Idempotent success, and
    //  NOT a second event — nothing happened.
    if (prop.organization_id && String(prop.organization_id) === String(scope.organization_id)) {
      await client.query("rollback");
      return { property_id: prop.id, organization_id: scope.organization_id,
               kind: "adoption", already: true,
               receipt: "This property already belongs to that organization." };
    }

    //  The refusal, raised here in words before the trigger raises it in
    //  SQL. Both exist on purpose: this one can name the organizations
    //  and offer a next step; the trigger binds writers that never come
    //  through this service.
    if (prop.organization_id) {
      await client.query("rollback");
      throw refusal(409, "property_already_has_an_organization",
        "This property already belongs to another organization, and a property cannot be " +
        "moved between clients. A transfer needs consent, an effective date and a decision " +
        "about what the previous client may still see — none of which exists yet.",
        { property_id: prop.id, current_organization_id: prop.organization_id });
    }

    await client.query(
      `update properties set organization_id = $1, updated_at = now() where id = $2`,
      [scope.organization_id, prop.id]);

    await client.query(
      `insert into property_organization_events
         (property_id, from_organization_id, to_organization_id,
          actor_user_id, actor_person_id, authority_basis, kind, reason)
       values ($1, null, $2, $3, $4, $5, 'adoption', $6)`,
      [prop.id, scope.organization_id, actor.user_id, scope.actor_person_id,
       scope.authority_basis, reason]);

    await client.query("commit");
    return { property_id: prop.id, organization_id: scope.organization_id,
             kind: "adoption", already: false,
             authority_basis: scope.authority_basis,
             receipt: `${prop.name} now belongs to this organization.` };
  } catch (e) {
    await client.query("rollback").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

module.exports = { assignPropertyToOrganization };
