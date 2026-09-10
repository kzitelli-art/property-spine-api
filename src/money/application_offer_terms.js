// application_offer_terms.js — complete, pre-application commercial proposal.
//
// This is an extension of the existing lease_offers owner. It writes no second
// terms table and deliberately creates a DRAFT: preparation is not dispatch.
"use strict";

const crypto = require("crypto");
const { resolveStaffIdentity } = require("../identity/staff_identity_resolver");
const { resolveActorContext } = require("../identity/actor_context");
const { resolveRelationshipStage } = require("../shared/relationship_stage");
const { governedCharges } = require("./governed_charges");

function failure(code, message, status = 400) {
  const e = new Error(message); e.code = code; e.httpStatus = status; return e;
}

function money(value, name) {
  if (typeof value === "boolean" || Array.isArray(value) ||
      (typeof value !== "number" && typeof value !== "string")) {
    throw failure("APPLICATION_TERMS_MISSING", `${name} is required and must be numeric.`);
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw failure("APPLICATION_TERMS_INVALID", `${name} must have at most two decimal places.`);
  }
  if (typeof value === "number" && value < 0) throw failure("APPLICATION_TERMS_INVALID", `${name} cannot be negative.`);
  const text = typeof value === "string" ? value : String(value);
  if (!text || (typeof value === "string" && text !== text.trim()) || !/^\d+(?:\.\d{1,2})?$/.test(text)) {
    if (typeof value === "number" && Number.isFinite(value)) {
      throw failure("APPLICATION_TERMS_INVALID", `${name} must have at most two decimal places.`);
    }
    throw failure("APPLICATION_TERMS_MISSING", `${name} is required and must be numeric.`);
  }
  const n = Number(text);
  if (!Number.isFinite(n) || !Number.isSafeInteger(Math.round(n * 100))) {
    throw failure("APPLICATION_TERMS_INVALID", `${name} must have at most two decimal places.`);
  }
  if (n < 0) throw failure("APPLICATION_TERMS_INVALID", `${name} cannot be negative.`);
  return n.toFixed(2);
}

function date(value, name) {
  const s = String(value == null ? "" : value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw failure("APPLICATION_TERMS_INVALID", `${name} must be YYYY-MM-DD.`);
  const d = new Date(`${s}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) {
    throw failure("APPLICATION_TERMS_INVALID", `${name} is not a real calendar date.`);
  }
  return s;
}

function canonicalFees(fees) {
  if (!Array.isArray(fees)) throw failure("APPLICATION_FEES_UNRESOLVED", "fees must be an explicit array; unknown fees cannot be treated as zero.");
  const seen = new Set();
  const cadences = new Set(["monthly", "one_time", "per_applicant"]);
  return fees.map((f, i) => {
    if (!f || !f.code || !f.label || !f.cadence) throw failure("APPLICATION_FEES_INVALID", `fees[${i}] needs code, label, and cadence.`);
    const code = String(f.code);
    const cadence = String(f.cadence);
    if (seen.has(code)) throw failure("APPLICATION_FEES_INVALID", `fees[${i}].code must be unique.`);
    if (!cadences.has(cadence)) throw failure("APPLICATION_FEES_INVALID", `fees[${i}].cadence is unsupported.`);
    seen.add(code);
    return { code, label: String(f.label), amount: money(f.amount, `fees[${i}].amount`), cadence };
  });
}

function canonicalConcessions(concessions) {
  if (!concessions || typeof concessions !== "object") throw failure("APPLICATION_CONCESSIONS_UNRESOLVED", "concessions must explicitly state none or structured.");
  const status = String(concessions.status || "");
  if (!new Set(["none", "structured"]).has(status)) throw failure("APPLICATION_CONCESSIONS_INVALID", "concessions.status must be none or structured.");
  if (status === "structured") throw failure("APPLICATION_CONCESSIONS_UNSUPPORTED", "structured concessions require an existing governed concession schedule before they can be offered.", 409);
  return { status: "none" };
}

async function bindGovernedCharges(q, property_id, fees, security_deposit) {
  const catalog = await governedCharges(q, { property_id });
  const active = [
    ...(catalog.one_time_fees || []), ...(catalog.recurring_charges || []),
    ...(catalog.deposit_requirements || []),
  ].filter((c) => c.effective_now && (c.applies_to_new_lease !== false || c.economic_class === "deposit_required"));
  if (active.length === 0) return fees;

  // A proposal has no condition or unit-type selector. Preserve unknown rather
  // than deciding that a conditional or scoped catalog row does not apply.
  for (const c of active) {
    if (c.obligation === "conditional" || c.applicability_scope !== "property") {
      throw failure("APPLICATION_FEES_UNRESOLVED", `governed charge ${c.charge_code} has unresolved applicability for this proposal.`);
    }
    if (c.quotable_precisely !== true || c.amount == null || !c.cadence) {
      throw failure("APPLICATION_FEES_UNRESOLVED", `governed charge ${c.charge_code} has no precise quotable terms.`);
    }
  }

  const catalogFees = active.filter((c) => c.economic_class !== "deposit_required");
  for (const c of catalogFees) {
    if (!["monthly", "one_time", "one_time_per_term"].includes(c.cadence)) {
      throw failure("APPLICATION_FEES_UNRESOLVED", `governed charge ${c.charge_code} has unsupported cadence ${c.cadence}.`);
    }
    if (c.assessed_per === "unit") {
      throw failure("APPLICATION_FEES_UNRESOLVED", `unit-assessed governed charge ${c.charge_code} cannot be quoted for an exact bed without a unit-grained fee shape.`);
    }
    if (c.assessed_per !== "applicant") {
      throw failure("APPLICATION_FEES_UNRESOLVED", `governed charge ${c.charge_code} has no supported assessment basis.`);
    }
  }
  const requiredFees = catalogFees.filter((c) => c.obligation === "required");
  const out = fees.map((fee) => {
    const c = catalogFees.find((candidate) => candidate.charge_code === fee.code);
    if (!c) return fee;
    const expected = Number(c.amount).toFixed(2);
    const cadenceMatches = c.cadence === "monthly" ? fee.cadence === "monthly" : fee.cadence === "per_applicant";
    if (fee.amount !== expected || !cadenceMatches) {
      throw failure("APPLICATION_FEES_CONTRADICTED", `fee ${c.charge_code} does not match the active governed amount or cadence.`);
    }
    return { ...fee, governed_charge_id: c.charge_id, source: "property_governed_charges" };
  });
  for (const c of requiredFees) {
    if (!out.some((fee) => fee.code === c.charge_code)) {
      throw failure("APPLICATION_FEES_MISSING", `required governed fee ${c.charge_code} must be included in the application terms.`);
    }
  }

  const deposits = active.filter((c) => c.economic_class === "deposit_required" && c.obligation === "required");
  if (deposits.length > 1) throw failure("APPLICATION_DEPOSIT_UNRESOLVED", "multiple required governed deposits cannot be reduced to one proposal deposit.");
  if (deposits.length === 1) {
    const c = deposits[0];
    if (money(security_deposit, "security_deposit") !== Number(c.amount).toFixed(2)) {
      throw failure("APPLICATION_DEPOSIT_CONTRADICTED", `security_deposit does not match required governed deposit ${c.charge_code}.`);
    }
  }
  return out;
}

function termsHash(terms) {
  const stable = (v) => Array.isArray(v)
    ? v.map(stable)
    : v && typeof v === "object"
      ? Object.keys(v).sort().reduce((o, k) => { o[k] = stable(v[k]); return o; }, {})
      : v;
  return crypto.createHash("sha256").update(JSON.stringify(stable(terms))).digest("hex");
}

async function prepareApplicationOffer(q, {
  actor, person_id, space_id, lease_start_date, lease_end_date, rent,
  security_deposit, fees, concessions, idempotency_key,
  application_id = null, supersedes_application_offer_id = null, create_only = false,
  source_comm_event_ids = [],
} = {}) {
  if (!q || typeof q.query !== "function") throw failure("QUERY_REQUIRED", "a transaction query client is required.", 500);
  if (!actor || !(actor.id || actor.user_id) || !actor.property_id) throw failure("ACTOR_CONTEXT_REQUIRED", "actor user and property are required.");
  if (!person_id || !space_id || !idempotency_key) throw failure("APPLICATION_TERMS_MISSING", "person_id, space_id, and idempotency_key are required.");
  const actorUserId = actor.id || actor.user_id;
  const identity = await resolveStaffIdentity(q, { user_id: actorUserId, property_id: actor.property_id });
  if (identity.state !== "resolved") throw failure("ACTOR_IDENTITY_UNRESOLVED", `staff identity is not resolved (${identity.basis}).`, 403);
  const actorContext = await resolveActorContext(q, { user_id: actorUserId, property_id: actor.property_id });
  const manager = (await q.query(
    `select 1 from property_team_assignments where user_id=$1 and property_id=$2
      and active=true and can_manage_roles=true limit 1`, [actorUserId, actor.property_id])).rows.length > 0;
  const authority = actorContext.ok && actorContext.capabilities.may_publish_pricing
    ? { basis: actorContext.basis.may_publish_pricing }
    : manager
      ? { basis: "assignment:can_manage_roles" }
      : null;
  if (!authority) throw failure("NO_APPLICATION_OFFER_AUTHORITY", "application terms require server-established pricing authority or can_manage_roles.", 403);
  const prop = (await q.query("select id from properties where id=$1", [actor.property_id])).rows[0];
  if (!prop) throw failure("PROPERTY_NOT_FOUND", "property not found.", 404);
  const person = (await q.query("select id from persons where id=$1", [person_id])).rows[0];
  if (!person) throw failure("PERSON_NOT_FOUND", "person not found.", 404);
  const relationship = await resolveRelationshipStage(q, { personId: person_id, propertyId: actor.property_id });
  if (!relationship.stage) throw failure("PERSON_PROPERTY_MISMATCH", "person has no canonical relationship with this property.", 403);
  const target = (await q.query(
    `select s.id, s.unit_id from spaces s join units u on u.id=s.unit_id
      where s.id=$1 and u.property_id=$2`, [space_id, actor.property_id])).rows[0];
  if (!target) throw failure("SPACE_NOT_ON_PROPERTY", "space does not belong to this property.", 403);
  if (application_id) {
    const linkedApplication = (await q.query(
      `select id from lease_applications where id=$1 and property_id=$2 and person_id=$3 and space_id=$4`,
      [application_id, actor.property_id, person_id, space_id])).rows[0];
    if (!linkedApplication) throw failure("APPLICATION_OFFER_APPLICATION_MISMATCH", "application_id must resolve to this property, person, and exact space.", 409);
  }
  let predecessor = null;
  if (supersedes_application_offer_id) {
    predecessor = (await q.query(
      `select * from lease_offers where id=$1 and property_id=$2 and person_id=$3
        and space_id=$4 and source='application_proposal' for update`,
      [supersedes_application_offer_id, actor.property_id, person_id, space_id])).rows[0];
    if (!predecessor) throw failure("APPLICATION_OFFER_PREDECESSOR_INVALID", "successor must name an existing exact application offer for the same property, person, and space.", 409);
    if (predecessor.application_id && String(predecessor.application_id) !== String(application_id || "")) {
      throw failure("APPLICATION_OFFER_APPLICATION_MISMATCH", "successor must retain the predecessor application link.", 409);
    }
  }
  const start = date(lease_start_date, "lease_start_date");
  const end = date(lease_end_date, "lease_end_date");
  if (end <= start) throw failure("APPLICATION_TERMS_INVALID", "lease_end_date must be after lease_start_date.");
  const boundFees = await bindGovernedCharges(q, actor.property_id, canonicalFees(fees), security_deposit);
  const applicationTerms = {
    schema_version: 1,
    property_id: actor.property_id,
    person_id: String(person_id),
    target: { space_id: String(space_id), unit_id: String(target.unit_id) },
    rent: money(rent, "rent"),
    security_deposit: money(security_deposit, "security_deposit"),
    lease_start_date: start,
    lease_end_date: end,
    fees: boundFees,
    concessions: canonicalConcessions(concessions),
  };
  const application_terms_hash = termsHash(applicationTerms);
  const existing = (await q.query(
    `select * from lease_offers
      where property_id=$1 and person_id=$2 and source='application_proposal'
        and authority_basis_snapshot->>'actor_user_id'=$3
        and authority_basis_snapshot->>'idempotency_key'=$4
      order by created_at desc limit 1`, [actor.property_id, person_id, String(actorUserId), String(idempotency_key)])).rows[0];
  if (existing) {
    const old = existing.offered_terms_snapshot && existing.offered_terms_snapshot.application_terms;
    const oldHash = existing.offered_terms_snapshot && existing.offered_terms_snapshot.application_terms_hash;
    const oldPredecessor = existing.authority_basis_snapshot && existing.authority_basis_snapshot.supersedes_application_offer_id;
    if (old && oldHash === application_terms_hash && String(oldPredecessor || "") === String(supersedes_application_offer_id || "")
        && String(existing.application_id || "") === String(application_id || "")) return { idempotent: true, offer: existing, application_terms: old };
    throw failure("APPLICATION_OFFER_IDEMPOTENCY_CONFLICT", "same idempotency key carries different application terms.", 409);
  }
  if (create_only && (await currentApplicationOfferIds(q,{property_id:actor.property_id,person_id,space_id})).length) {
    throw failure('APPLICATION_OFFER_ALREADY_EXISTS','An application offer already exists; review it before creating revised terms.',409);
  }
  if (predecessor) {
    const successor = (await q.query(
      `select id from lease_offers where source='application_proposal' and supersedes_application_offer_id=$1 limit 1`,
      [supersedes_application_offer_id])).rows[0];
    if (successor) throw failure("APPLICATION_TERMS_REVIEW_REQUIRED", "the predecessor already has a current successor; review it instead of branching another revision.", 409);
  }
  const snapshot = {
    unit_type: "application_exact_space",
    lease_term_months: null,
    base_rent: Number(applicationTerms.rent),
    concessions: [],
    source: "application_proposal",
    target: { space_id: String(space_id) },
    envelope: null,
    application_terms: applicationTerms,
    application_terms_hash,
  };
  const authoritySnapshot = {
    via: "application_proposal",
    basis: authority.basis,
    actor_user_id: String(actorUserId),
    idempotency_key: String(idempotency_key),
    supersedes_application_offer_id: supersedes_application_offer_id ? String(supersedes_application_offer_id) : null,
    acting_person_id: String(identity.person_id),
    property_id: String(actor.property_id),
    source_comm_event_ids,
  };
  if (!authoritySnapshot.acting_person_id) throw failure("ACTOR_PERSON_REQUIRED", "server-resolved acting person is required.");
  const ins = await q.query(
    `insert into lease_offers
    (property_id, person_id, application_id, space_id, supersedes_application_offer_id, scope, scope_ref,
       source, source_policy_id, offered_terms_snapshot, authority_basis_snapshot,
       source_pricing_version_id, concession_authority_value, guardrail_flag,
       status, qualifying_action, expires_at, communicated_at, evidence_type,
       evidence_ref, granted_by_person_id)
     values ($1,$2,$3,$4,$5,null,null,'application_proposal',null,$6,$7,null,0,false,
       'draft','application_submitted',null,null,null,null,$8)
     on conflict (property_id, person_id,
       (authority_basis_snapshot->>'actor_user_id'),
       (authority_basis_snapshot->>'idempotency_key'))
       where source='application_proposal' do nothing returning *`,
    [actor.property_id, person_id, application_id, space_id, supersedes_application_offer_id, JSON.stringify(snapshot), JSON.stringify(authoritySnapshot), authoritySnapshot.acting_person_id]
  );
  if (ins.rows.length === 0) {
    const retry = (await q.query(`select * from lease_offers where property_id=$1 and person_id=$2 and source='application_proposal' and authority_basis_snapshot->>'actor_user_id'=$3 and authority_basis_snapshot->>'idempotency_key'=$4 order by created_at desc limit 1`, [actor.property_id, person_id, String(actorUserId), String(idempotency_key)])).rows[0];
    if (retry) {
      const old = retry.offered_terms_snapshot && retry.offered_terms_snapshot.application_terms;
      const oldHash = retry.offered_terms_snapshot && retry.offered_terms_snapshot.application_terms_hash;
      const oldPredecessor = retry.authority_basis_snapshot && retry.authority_basis_snapshot.supersedes_application_offer_id;
      if (old && oldHash === application_terms_hash && String(oldPredecessor || "") === String(supersedes_application_offer_id || "")
          && String(retry.application_id || "") === String(application_id || "")) return { idempotent: true, offer: retry, application_terms: old };
      throw failure("APPLICATION_OFFER_IDEMPOTENCY_CONFLICT", "same idempotency key carries different application terms.", 409);
    }
    throw failure("APPLICATION_OFFER_REPLAY_UNRESOLVED", "application offer idempotency conflict could not be read back.", 409);
  }
  return { idempotent: false, offer: ins.rows[0], application_terms: applicationTerms };
}

async function assertCurrentApplicationOffer(q, offer_id) {
  const row = (await q.query(
    `select id from lease_offers where id=$1 and source='application_proposal'`, [offer_id])).rows[0];
  if (!row) throw failure("APPLICATION_OFFER_NOT_FOUND", "application offer not found.", 404);
  const successor = (await q.query(
    `select id from lease_offers where source='application_proposal' and supersedes_application_offer_id=$1 limit 1`, [offer_id])).rows[0];
  if (successor) throw failure("APPLICATION_TERMS_REVIEW_REQUIRED", "these application terms were superseded; review the current offer.", 409);
  return row;
}

async function readApplicationOffer(q, { offer_id, property_id, person_id, space_id } = {}) {
  if (!offer_id || !property_id || !person_id || !space_id) throw failure("APPLICATION_OFFER_CONTEXT_REQUIRED", "offer_id, property_id, person_id, and space_id are required.");
  const row = (await q.query(
    `select * from lease_offers where id=$1 and property_id=$2 and person_id=$3
      and source='application_proposal' and space_id=$4
      and status in ('draft','sent','earned') for update`,
    [offer_id, property_id, person_id, space_id || null])).rows[0];
  if (!row) throw failure("APPLICATION_OFFER_NOT_FOUND", "application offer not found for this property/person/space.", 404);
  if (row.expires_at && new Date(row.expires_at).getTime() <= Date.now()) {
    throw failure("APPLICATION_OFFER_EXPIRED", "application offer has expired.", 409);
  }
  const terms = row.offered_terms_snapshot && row.offered_terms_snapshot.application_terms;
  const hash = row.offered_terms_snapshot && row.offered_terms_snapshot.application_terms_hash;
  if (!terms || !hash || termsHash(terms) !== hash) throw failure("APPLICATION_OFFER_CORRUPT", "application offer terms hash does not match the retained terms.", 409);
  return { offer_id: row.id, terms_hash: hash, rent: terms.rent,
    security_deposit: terms.security_deposit, lease_start_date: terms.lease_start_date,
    lease_end_date: terms.lease_end_date, fees: terms.fees, concessions: terms.concessions,
    application_terms: terms };
}

// One selection rule for preparation and conversational review. Multiple
// current offers require an explicit choice; never choose the newest silently.
async function currentApplicationOfferIds(q,{property_id,person_id,space_id}) {
  return (await q.query(`select id from lease_offers
      where property_id=$1 and person_id=$2 and space_id=$3
        and source='application_proposal' and status in ('draft','sent')
        and not exists (select 1 from lease_offers child where child.supersedes_application_offer_id=lease_offers.id)
        and (expires_at is null or expires_at>now()) limit 2`,
      [property_id,person_id,space_id])).rows;
}
async function resolveApplicationOffer(q, {offer_id=null,property_id,person_id,space_id}) {
  if (!offer_id) {
    const offers=await currentApplicationOfferIds(q,{property_id,person_id,space_id});
    if (offers.length===1) offer_id=offers[0].id;
  }
  if (!offer_id) throw failure('APPLICATION_TERMS_REQUIRED',
    'Confirm one complete application offer before sending a link.',409);
  const offer=await readApplicationOffer(q,{offer_id,property_id,person_id,space_id});
  await assertCurrentApplicationOffer(q,offer.offer_id);
  return offer;
}

// Shared decision-language projection used by Ask and pre-send review.
function describeApplicationTerms(t) {
  const money = value => value == null || String(value).trim() === "" || !Number.isFinite(Number(value))
    ? "not established" : "$" + Number(value).toLocaleString("en-US", {minimumFractionDigits:2,maximumFractionDigits:2});
  const fees = !Array.isArray(t.fees) ? "fees not established" : !t.fees.length ? "no applicable fees"
    : "fees: " + t.fees.map(f => `${f.label || f.code}: ${money(f.amount)} ${
      ({monthly:"per month",one_time:"one time",per_applicant:"per applicant"})[f.cadence] || "(cadence not established)"}`).join(", ");
  return `${money(t.rent)} per month; deposit ${money(t.security_deposit)}; lease ${t.lease_start_date || "start not established"} to ${t.lease_end_date || "end not established"}; ${fees}; ${t.concessions && t.concessions.status === "none" ? "no concessions" : "concessions require review"}.`;
}

module.exports = { prepareApplicationOffer, readApplicationOffer, assertCurrentApplicationOffer, resolveApplicationOffer, termsHash, describeApplicationTerms };
