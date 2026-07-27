// ════════════════════════════════════════════════════════════════════
//  actor_context.js — WHO THE SIGNED-IN OPERATOR IS AS A HUMAN ACTOR
//
//  THE canonical path. Pricing publication, concession approval, renewal
//  decisions, money actions, work ownership, Text-to-Spine attribution and
//  reporting sign-off will all resolve the acting human here, once.
//
//  ── A USER IS NOT A PERSON ───────────────────────────────────────────
//  `users` is a LOGIN. `persons` is a HUMAN. They are different tables with
//  different lifecycles, and the schema has always known this — assignments,
//  grants and most attribution columns are keyed to persons. The defect this
//  service exists to prevent is a session's user_id being written where a
//  person_id belongs, which produces an audit trail pointing at a credential
//  instead of a human.
//
//  ── ENTITLEMENT AND AUTHORITY ARE SEPARATE ───────────────────────────
//  A user with no linked person may still READ the property their session is
//  scoped to — that entitlement comes from the session itself and predates
//  this service. What they may not do is anything a human is answerable for.
//  Collapsing the two would either lock everyone out of a working product or
//  let an unidentified login approve money. Both are worse than the split.
//
//  ── NAMES NEVER PARTICIPATE ──────────────────────────────────────────
//  Resolution is users.person_id and nothing else. The portfolio contains
//  248 duplicated person labels, including four rows called "Jordan Avery
//  (demo)" of which exactly one holds an owner assignment. A name match would
//  pick a building's owner by sort order.
//
//  FAILS CLOSED on every error path.
// ════════════════════════════════════════════════════════════════════

"use strict";

const CAPABILITIES = [
  // person-governed: require a linked, assigned human
  "may_prepare_pricing", "may_review_pricing", "may_publish_pricing",
  "may_manage_concession_authority",
  // read entitlement: session-scoped, person-independent
  "may_read_property",
];

const PERSON_GOVERNED = CAPABILITIES.filter((c) => c !== "may_read_property");

// The ONLY role-derived authority, enumerated rather than pattern-matched.
// A property_manager is deliberately absent: managing a property is not the
// same as setting its rents, and the two are conflated by every system that
// treats "manager" as a seniority ladder instead of a job.
const FULL_AUTHORITY_ROLES = new Set(["owner", "asset_manager"]);

const deny = (reason, extra = {}) => ({
  ok: false,
  user: null, person: null, link_status: "unresolved",
  property_id: extra.property_id || null,
  property_entitlement: extra.property_entitlement || "none",
  assignments: [], grants: [],
  capabilities: CAPABILITIES.reduce((o, c) => { o[c] = false; return o; }, {}),
  basis: CAPABILITIES.reduce((o, c) => { o[c] = null; return o; }, {}),
  failure_reason: reason,
  identity_provenance: extra.identity_provenance || null,
  reconciliation_required: !!extra.reconciliation_required,
  ...extra.carry,
});

/**
 * Resolve the acting human for a session. READ-ONLY.
 *
 * @param {uuid}  user_id      from the SESSION. Never from a request body.
 * @param {uuid}  property_id  from the SESSION. Never from a request body.
 */
async function resolveActorContext(pool, { user_id, property_id, as_of = null } = {}) {
  if (!user_id) return deny("no_session_user");
  if (!property_id) return deny("no_property_context");
  const asOf = as_of || new Date().toISOString().slice(0, 10);

  let user;
  try {
    user = (await pool.query(
      `select id, name, email, phone, person_id, role, is_active, status, account_kind
         from users where id = $1`, [user_id])).rows[0] || null;
  } catch (e) {
    // A failed identity read denies privileged actions. "Unavailable" and
    // "permitted" must never collapse in the permissive direction.
    return deny("identity_read_failed");
  }
  if (!user) return deny("user_not_found");
  if (!user.is_active) return deny("user_inactive");

  const userOut = {
    user_id: user.id, display_name: user.name,
    login_identifier: user.email || user.phone || null,
    account_kind: user.account_kind,
  };

  // Read entitlement comes from the SESSION's property scope and does not
  // depend on a person link — this is what keeps an unlinked operator able to
  // use the read-only product while being unable to act as a human.
  const readEntitlement = "session_scoped";

  if (!user.person_id) {
    return deny("session_identity_not_linked_to_a_person", {
      property_id, property_entitlement: readEntitlement,
      reconciliation_required: true,
      identity_provenance: { user_row: "found", person_link: "absent" },
      carry: {
        user: userOut,
        link_status: "unlinked",
        capabilities: { ...CAPABILITIES.reduce((o, c) => { o[c] = false; return o; }, {}), may_read_property: true },
      },
    });
  }

  let person, assignments, grants;
  try {
    person = (await pool.query(
      `select id, name, email, phone, primary_phone_e164, lifecycle_status, source, created_at
         from persons where id = $1`, [user.person_id])).rows[0] || null;
    if (!person) {
      return deny("person_link_dangling", {
        property_id, property_entitlement: readEntitlement, reconciliation_required: true,
        carry: { user: userOut, link_status: "dangling",
                 capabilities: { ...CAPABILITIES.reduce((o, c) => { o[c] = false; return o; }, {}), may_read_property: true } },
      });
    }

    // Assignments are read for THIS property only. Cross-property authority
    // is not filtered out afterwards — it is never loaded, so there is no
    // object in memory that could leak into a decision.
    assignments = (await pool.query(
      `select id, role, property_id, is_active, created_at
         from assignments
        where person_id = $1 and property_id = $2 and is_active = true`,
      [person.id, property_id])).rows;

    grants = (await pool.query(
      `select id, effective_from, effective_until,
              may_prepare_pricing, may_edit_pricing, may_review_pricing,
              may_publish_public_offers, may_manage_concession_authority
         from concession_authority_grants
        where person_id = $1 and property_id = $2
          and effective_from <= $3::timestamptz
          and (effective_until is null or effective_until > $3::timestamptz)`,
      [person.id, property_id, asOf])).rows;
  } catch (e) {
    return deny("authority_read_failed", {
      property_id, property_entitlement: readEntitlement,
      carry: { user: userOut, link_status: "linked" },
    });
  }

  const authorityRole = assignments.find((a) => FULL_AUTHORITY_ROLES.has(a.role)) || null;
  const roleBasis = authorityRole ? `assignment:${authorityRole.role}` : null;
  const grant = grants[0] || null;

  const resolve = (grantField) => {
    if (authorityRole) return { granted: true, basis: roleBasis };
    if (grant && grant[grantField]) return { granted: true, basis: `grant:${grant.id}` };
    return { granted: false, basis: null };
  };
  // may_prepare honours the older may_edit_pricing column, which meant the
  // same thing before the verb had a name — silently revoking authority
  // somebody was already given would be its own defect.
  const prepare = authorityRole ? { granted: true, basis: roleBasis }
    : grant && (grant.may_prepare_pricing || grant.may_edit_pricing)
      ? { granted: true, basis: `grant:${grant.id}` } : { granted: false, basis: null };
  const review = resolve("may_review_pricing");
  const publish = authorityRole ? { granted: true, basis: roleBasis }
    : grant && grant.may_publish_public_offers
      ? { granted: true, basis: `grant:${grant.id}` } : { granted: false, basis: null };
  const manage = resolve("may_manage_concession_authority");

  const capabilities = {
    may_prepare_pricing: prepare.granted,
    may_review_pricing: review.granted,
    may_publish_pricing: publish.granted,
    may_manage_concession_authority: manage.granted,
    may_read_property: true,
  };
  const basis = {
    may_prepare_pricing: prepare.basis, may_review_pricing: review.basis,
    may_publish_pricing: publish.basis, may_manage_concession_authority: manage.basis,
    may_read_property: "session_scope",
  };

  const anyPersonGoverned = PERSON_GOVERNED.some((c) => capabilities[c]);
  return {
    ok: true,
    user: userOut,
    person: {
      person_id: person.id, display_name: person.name,
      lifecycle_status: person.lifecycle_status,
      source: person.source, created_at: person.created_at,
    },
    link_status: "linked",
    property_id,
    property_entitlement: readEntitlement,
    assignments: assignments.map((a) => ({ assignment_id: a.id, role: a.role, property_id: a.property_id })),
    grants: grants.map((g) => ({ grant_id: g.id, effective_from: g.effective_from, effective_until: g.effective_until })),
    capabilities, basis,
    failure_reason: anyPersonGoverned ? null : "no_governed_authority_on_this_property",
    identity_provenance: {
      resolved_by: "users.person_id",
      never_uses: ["display_name", "request_body_person_id", "request_body_property_id"],
    },
    reconciliation_required: false,
    as_of: asOf,
  };
}

/** The attribution block every privileged receipt must carry. */
function actorReceipt(ctx, verb) {
  return {
    session_user_id: ctx.user ? ctx.user.user_id : null,
    acting_person_id: ctx.person ? ctx.person.person_id : null,
    property_id: ctx.property_id || null,
    verb: verb || null,
    authority_basis: ctx.basis ? ctx.basis[verb] || null : null,
    link_status: ctx.link_status,
    // Both identities, always. A receipt naming only one of them cannot
    // answer "which human did this" or "which credential was used".
    attribution_rule: "user_id is the credential; person_id is the human. Both are recorded.",
  };
}

module.exports = {
  resolveActorContext, actorReceipt,
  CAPABILITIES, PERSON_GOVERNED, FULL_AUTHORITY_ROLES,
};
