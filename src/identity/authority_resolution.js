// ════════════════════════════════════════════════════════════════════
//  authority_resolution.js — EXECUTE THE RULING, SAFELY, ONCE GIVEN
//
//  DRY-RUN FIRST. Nothing here applies until ownership names the human and
//  the exact staff-person record, and `apply` is passed explicitly.
//
//  ── NINE INDEPENDENT PROOFS ──────────────────────────────────────────
//  Each is checked separately and each can veto on its own. They are not
//  collapsed into a score, because a "mostly valid" authority grant is not a
//  weaker grant — it is an invalid one that looks fine.
//
//  ── STAFFNESS IS A GOVERNED FACT, NOT A NAME ─────────────────────────
//  `person_contexts.context_type = 'staff'` is the marker, written by the
//  bridge when a human classifies someone. The Demo owner assignment sits on
//  a person with NO person_contexts row at all, which is what proves it is a
//  lead — not the "(demo)" in its label. That distinction is the whole point:
//  the label was always visible and told nobody anything.
//
//  ── IDENTITY REPAIR IS NOT AUTHORITY CREATION ────────────────────────
//  The permanent sequence is four separately attributable writes:
//      classify → link → confirm entitlement → assign/grant
//  This module never performs the first two. It refuses when they are
//  missing and names which step is outstanding, so a "make publisher"
//  operation cannot exist.
// ════════════════════════════════════════════════════════════════════

"use strict";

const { resolveActorContext } = require("./actor_context");

const VERBS = ["may_prepare_pricing", "may_review_pricing", "may_publish_pricing",
               "may_manage_concession_authority"];
const ASSIGNABLE_ROLES = new Set(["owner", "asset_manager"]);
// Lifecycle values that mean "this person is a counterparty, not staff".
const NON_STAFF_LIFECYCLES = new Set(["lead", "applicant", "tenant", "resident", "past_resident", "vendor"]);

const check = (id, passed, detail) => ({ id, passed, detail });

function evaluateReviewerPrecondition({
  reviewer_user_id = null,
  grantee_user_id = null,
  grantee_person_id = null,
  reason = null,
  reviewer_context = null,
  reviewer_staff_context_state = "absent",
  caller_granted_by_person_id = null,
} = {}) {
  const reviewerPersonId = reviewer_context && reviewer_context.person
    ? reviewer_context.person.person_id : null;
  const reasonRecorded = typeof reason === "string" && reason.trim().length > 0;
  const distinctLogin = !!reviewer_user_id
    && String(reviewer_user_id) !== String(grantee_user_id || "");
  const distinctPerson = !!reviewerPersonId
    && String(reviewerPersonId) !== String(grantee_person_id || "");
  const humanStaff = !!(reviewer_context && reviewer_context.user
    && reviewer_context.user.account_kind === "human_staff");
  const staffContext = reviewer_staff_context_state === "present";
  const mayManage = !!(reviewer_context && reviewer_context.capabilities
    && reviewer_context.capabilities.may_manage_concession_authority);
  const suppliedGrantorMatches = !caller_granted_by_person_id
    || (reviewerPersonId && String(caller_granted_by_person_id) === String(reviewerPersonId));
  const passed = !!reviewer_user_id && reasonRecorded && reviewer_context && reviewer_context.ok
    && humanStaff && staffContext && distinctLogin && distinctPerson && mayManage
    && suppliedGrantorMatches;

  let detail;
  if (!reviewer_user_id) detail = "No reviewer named.";
  else if (!reasonRecorded) detail = "No reason recorded.";
  else if (!reviewer_context || !reviewer_context.ok) {
    detail = `The reviewer did not resolve to an active governed actor (${reviewer_context && reviewer_context.failure_reason || "unresolved"}).`;
  } else if (!humanStaff) detail = "The reviewer login is not classified human_staff.";
  else if (reviewer_staff_context_state === "read_failed") detail = "The reviewer's staff-context read failed; authority review fails closed.";
  else if (!staffContext) detail = "The reviewer has no active staff context covering this property.";
  else if (!distinctLogin || !distinctPerson) detail = "The reviewer must be a different governed human from the person receiving authority.";
  else if (!mayManage) detail = "The reviewer lacks may_manage_concession_authority on this property.";
  else if (!suppliedGrantorMatches) detail = "granted_by_person_id does not match the governed reviewer identity.";
  else {
    detail = `Reviewed by a distinct authorized human (${reviewerPersonId}); authority basis: `
      + `${reviewer_context.basis.may_manage_concession_authority}. No comparison reads a display name.`;
  }

  return check("reviewed_by_distinct_authorized_human", passed, detail);
}

/**
 * @param spec {
 *   user_id, person_id, property_id,
 *   requested_role?          'owner' | 'asset_manager'
 *   requested_verbs?         subset of VERBS (grant path)
 *   effective_from?, effective_until?,
 *   reviewer_user_id, reason
 * }
 * @param apply  false (default) = dry run. True requires every check passed.
 */
async function resolveAuthority(pool, { spec = {}, apply = false } = {}) {
  const {
    user_id = null, person_id = null, property_id = null,
    requested_role = null, requested_verbs = null,
    effective_from = null, effective_until = null,
    reviewer_user_id = null, reason = null,
  } = spec;

  const checks = [];
  const push = (c) => { checks.push(c); return c.passed; };

  // ── 1. the user is a real login account ─────────────────────────
  const user = user_id ? (await pool.query(
    `select id, name, email, phone, person_id, is_active, account_kind
       from users where id = $1`, [user_id])).rows[0] || null : null;
  push(check("user_is_real_login", !!user && user.is_active,
    !user_id ? "No user_id supplied."
      : !user ? "No such user."
      : !user.is_active ? "The login is inactive."
      : `Active login (${user.email || user.phone || user.name}).`));

  // ── 2. the person is classified human_staff ─────────────────────
  const person = person_id ? (await pool.query(
    `select id, name, email, phone, primary_phone_e164, lifecycle_status, source, created_at
       from persons where id = $1`, [person_id])).rows[0] || null : null;
  //  ── A WITHDRAWN CONTEXT IS NOT A CONTEXT ────────────────────────
  //  This read had no active_to filter, so a staff context that had been
  //  CLOSED still satisfied both person_is_classified_staff and
  //  person_entitled_to_property. Revoking someone's entitlement did not
  //  revoke it for the purpose of granting them authority.
  //
  //  Found by falsification, not by review: a chain proof withdrew the
  //  context it had just been granted and required the grantor to refuse
  //  again. It did not. staffbridge — which OWNS this table — filters
  //  `active_to is null` everywhere; this consumer did not, and the two
  //  disagreed about who is staff.
  const staffCtx = person ? (await pool.query(
    `select id, context_type, property_id from person_contexts
      where person_id = $1 and context_type = 'staff'
        and active_to is null`, [person.id])).rows : [];
  const accountStaff = user && user.account_kind === "human_staff";
  push(check("person_is_classified_staff", !!person && staffCtx.length > 0 && accountStaff,
    !person ? "No such person."
      : staffCtx.length === 0
        ? "This person has NO staff context. Staffness is a governed fact written at classification — " +
          "not something a display name can establish."
      : !accountStaff
        ? `The login's account_kind is '${user ? user.account_kind : "unknown"}', not human_staff. ` +
          `Classify the account first; that is a separate attributable write.`
        : "Person carries a governed staff context and the login is classified human_staff."));

  // ── 3. the link is governed, or eligible through the bridge ─────
  const linkedElsewhere = person ? (await pool.query(
    `select id from users where person_id = $1 and id <> coalesce($2,'00000000-0000-0000-0000-000000000000'::uuid)`,
    [person.id, user_id])).rows : [];
  const alreadyLinked = !!(user && person && String(user.person_id) === String(person.id));
  const linkEligible = !!(user && person && !user.person_id && !linkedElsewhere.length && accountStaff);
  push(check("link_is_governed_or_eligible", alreadyLinked || linkEligible,
    alreadyLinked ? "The login is already governed-linked to this person."
      : linkedElsewhere.length ? `That person is already linked to another login (${linkedElsewhere[0].id}).`
      : user && user.person_id ? `This login is already linked to a different person (${user.person_id}).`
      : !accountStaff ? "Not eligible until the account is classified human_staff."
      : "Eligible to link through staffbridge — a separate attributable write."));

  // ── 4. the person is entitled to the property ───────────────────
  const property = property_id ? (await pool.query(
    "select id, name from properties where id = $1", [property_id])).rows[0] || null : null;
  const existingHere = person && property ? (await pool.query(
    `select id, role, is_active from assignments where person_id=$1 and property_id=$2`,
    [person.id, property.id])).rows : [];
  const contextHere = staffCtx.some((c) => !c.property_id || String(c.property_id) === String(property_id));
  push(check("person_entitled_to_property", !!property && contextHere,
    !property ? "No such property."
      : contextHere ? `Staff context covers ${property.name}.`
      : "The staff context is scoped to another property."));

  // ── 5. the proposal is property-scoped ──────────────────────────
  const scoped = !!property_id && (!requested_role || ASSIGNABLE_ROLES.has(requested_role));
  push(check("proposal_is_property_scoped", scoped,
    !property_id ? "No property scope supplied."
      : requested_role && !ASSIGNABLE_ROLES.has(requested_role)
        ? `'${requested_role}' is not an authority-bearing role. Only ${[...ASSIGNABLE_ROLES].join(", ")} confer pricing verbs.`
        : "Scoped to exactly one property."));

  // ── 6. nothing conflicting is silently overwritten ──────────────
  const conflictingAsg = existingHere.filter((a) => a.is_active && a.role !== requested_role);
  const existingGrants = person && property ? (await pool.query(
    `select id, effective_from, effective_until from concession_authority_grants
      where person_id=$1 and property_id=$2
        and (effective_until is null or effective_until > now())`, [person.id, property.id])).rows : [];
  const noSilentOverwrite = conflictingAsg.length === 0 && (!requested_verbs || existingGrants.length === 0);
  push(check("no_silent_overwrite", noSilentOverwrite,
    conflictingAsg.length
      ? `This person already holds ${conflictingAsg.map((a) => a.role).join(", ")} here. ` +
        `Changing it is a separate, explicit decision — it is not folded into this one.`
      : existingGrants.length && requested_verbs
        ? `An in-window grant (${existingGrants[0].id}) already exists. Supersede it explicitly.`
        : "No conflicting assignment or grant."));

  // ── 7. the person is not a counterparty or a demo artifact ──────
  const demoUse = person ? (await pool.query(
    "select count(*)::int n from demo_attempts where tenant_person_id = $1", [person.id])).rows[0].n : 0;

  // lifecycle_status DEFAULTS to 'lead' on every persons row, including every
  // staff record the bridge creates — all 24 existing staff persons carry it.
  // It describes a counterparty journey and says nothing about a staff human,
  // so it only disqualifies a person who has NO governed staff context. The
  // staff context is the governed fact; lifecycle_status is a default.
  //
  // Real counterparty evidence still disqualifies unconditionally: appearing
  // as the tenant in a demo run, or carrying a lifecycle that only a real
  // counterparty reaches (tenant, resident, applicant, vendor).
  const hasStaffContext = staffCtx.length > 0;
  const lifecycle = String(person && person.lifecycle_status || "");
  const HARD_COUNTERPARTY = new Set(["tenant", "resident", "past_resident", "applicant", "vendor"]);
  const lifecycleOk = person && (
    HARD_COUNTERPARTY.has(lifecycle) ? false
      : hasStaffContext ? true
      : !NON_STAFF_LIFECYCLES.has(lifecycle));
  push(check("person_is_not_a_counterparty", !!person && lifecycleOk && demoUse === 0,
    !person ? "No person."
      : demoUse > 0 ? `This person appears as the TENANT in ${demoUse} demo run(s). It is a demo artifact, not a staff human.`
      : HARD_COUNTERPARTY.has(lifecycle)
        ? `lifecycle_status is '${lifecycle}' — a real counterparty record, which a staff context cannot override.`
      : !lifecycleOk ? `lifecycle_status is '${lifecycle}' and there is no governed staff context.`
      : `Not a counterparty${hasStaffContext ? " (staff context governs; lifecycle_status is a table default)" : ""}.`));

  // ── 8. the effective window is real ─────────────────────────────
  const windowOk = !requested_verbs
    || (!!effective_from && (!effective_until || String(effective_until) > String(effective_from)));
  push(check("effective_window_valid", windowOk,
    !requested_verbs ? "Not applicable — an assignment has no window."
      : !effective_from ? "A grant must state when it begins."
      : "Window is valid."));

  // ── 9. a different governed human with grant authority reviews it ─
  // A user id and a reason used to be enough. That made self-review pass and
  // never established that the named reviewer had standing to grant authority.
  // Resolve the reviewer through the same property-scoped authority reader the
  // product uses, then independently require the governed staff classification.
  let reviewerContext = null;
  let reviewerStaffContextState = "absent";
  if (reviewer_user_id && property_id) {
    reviewerContext = await resolveActorContext(pool, { user_id: reviewer_user_id, property_id });
    if (reviewerContext && reviewerContext.person) {
      try {
        const rows = (await pool.query(
          `select id from person_contexts
            where person_id=$1 and context_type='staff' and active_to is null
              and (property_id is null or property_id=$2)
            limit 1`, [reviewerContext.person.person_id, property_id])).rows;
        reviewerStaffContextState = rows.length ? "present" : "absent";
      } catch (_) {
        reviewerStaffContextState = "read_failed";
      }
    }
  }
  push(evaluateReviewerPrecondition({
    reviewer_user_id,
    grantee_user_id: user_id,
    grantee_person_id: person_id,
    reason,
    reviewer_context: reviewerContext,
    reviewer_staff_context_state: reviewerStaffContextState,
    caller_granted_by_person_id: spec.granted_by_person_id || null,
  }));
  const reviewerPersonId = reviewerContext && reviewerContext.person
    ? reviewerContext.person.person_id : null;
  const reviewerAuthorityBasis = reviewerContext && reviewerContext.basis
    ? reviewerContext.basis.may_manage_concession_authority : null;

  const ok = checks.every((c) => c.passed);

  // ── authority consequence, shown BEFORE application ─────────────
  const wouldGrant = requested_role && ASSIGNABLE_ROLES.has(requested_role)
    ? VERBS.slice()
    : (requested_verbs || []);
  const before = user_id && property_id
    ? await resolveActorContext(pool, { user_id, property_id })
    : null;

  const receipt = {
    before: {
      login: user ? { user_id: user.id, account_kind: user.account_kind, person_id: user.person_id } : null,
      person: person ? { person_id: person.id, lifecycle_status: person.lifecycle_status,
                         staff_context: staffCtx.length > 0 } : null,
      capabilities: before ? before.capabilities : null,
      link_status: before ? before.link_status : null,
    },
    evidence: checks,
    proposed: {
      property_id, property: property ? property.name : null,
      path: requested_role ? "assignment" : requested_verbs ? "explicit_grant" : null,
      requested_role, requested_verbs,
      effective_from, effective_until,
      reviewer_user_id, reviewer_person_id: reviewerPersonId,
      reviewer_authority_basis: reviewerAuthorityBasis, reason,
    },
    authority_consequence: wouldGrant.length
      ? `Would confer ${wouldGrant.join(", ")} on ${property ? property.name : "the property"}` +
        (requested_role ? " — an assignment carries ALL four verbs and does not expire." : "")
      : "No authority would be conferred.",
    affected_properties: property ? [property.name] : [],
    after: ok ? {
      capabilities: wouldGrant.reduce((o, v) => { o[v] = true; return o; }, {}),
      basis: requested_role ? `assignment:${requested_role}` : "grant",
    } : { capabilities: before ? before.capabilities : null, basis: null, note: "unchanged — refused" },
    reviewer: reviewer_user_id || null,
    reviewer_resolution: reviewer_user_id ? {
      person_id: reviewerPersonId,
      authority_basis: reviewerAuthorityBasis,
    } : null,
    applied_at: null,
  };

  if (!apply) {
    return {
      mode: "dry_run", disposition: "dry_run_no_write_performed",
      would_apply: ok,
      blocking: checks.filter((c) => !c.passed).map((c) => c.id),
      outstanding_sequence_steps: [
        !accountStaff ? "classify_account_as_human_staff" : null,
        !alreadyLinked ? "establish_verified_user_person_link_via_staffbridge" : null,
        !contextHere ? "confirm_property_entitlement" : null,
        "assign_or_grant_specific_authority",
      ].filter(Boolean),
      receipt,
    };
  }

  if (!ok) {
    const err = new Error("authority resolution refused: " + receipt.evidence.filter((c) => !c.passed).map((c) => c.id).join(", "));
    err.httpStatus = 409; err.publicMessage = err.message;
    throw err;
  }

  // ── apply. ONE write, and only the authority write. ─────────────
  // Classification and linking are deliberately NOT performed here; they are
  // separate attributable actions with their own audit trails.
  const client = await pool.connect();
  try {
    await client.query("begin");
    let created;
    if (requested_role) {
      created = (await client.query(
        `insert into assignments (person_id, property_id, role, is_active, provenance)
         values ($1,$2,$3,true,$4) returning id`,
         [person_id, property_id, requested_role,
          JSON.stringify({ source: "authority_resolution", reviewer_user_id,
                           reviewer_person_id: reviewerPersonId,
                           reviewer_authority_basis: reviewerAuthorityBasis, reason,
                           resolved_at: new Date().toISOString() })])).rows[0];
    } else {
      created = (await client.query(
        `insert into concession_authority_grants
           (property_id, person_id, assignment_id, effective_from, effective_until,
            may_prepare_pricing, may_review_pricing, may_publish_public_offers,
            may_manage_concession_authority, granted_by_person_id, note)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning id`,
        [property_id, person_id, spec.assignment_id || null, effective_from, effective_until,
         (requested_verbs || []).includes("may_prepare_pricing"),
         (requested_verbs || []).includes("may_review_pricing"),
         (requested_verbs || []).includes("may_publish_pricing"),
         (requested_verbs || []).includes("may_manage_concession_authority"),
          reviewerPersonId, reason])).rows[0];
    }
    await client.query("commit");
    return { mode: "applied", disposition: "authority_write_performed",
             created_id: created.id, receipt: { ...receipt, applied_at: new Date().toISOString() } };
  } catch (e) {
    await client.query("rollback").catch(() => {});
    throw e;
  } finally { client.release(); }
}

module.exports = { resolveAuthority, evaluateReviewerPrecondition,
  VERBS, ASSIGNABLE_ROLES, NON_STAFF_LIFECYCLES };
