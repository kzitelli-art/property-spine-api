// ════════════════════════════════════════════════════════════════════
//  governed_lease_terms.js — WHAT SPINE CAN STAND BEHIND FOR ONE LEASE
//
//  The lease bridge is: application + exact bed + governed economics →
//  a real governing lease → an e-sign provider → resident signature →
//  company signature → executed_lease_service → the tenancy anchor.
//
//  This is the FIRST link and only the first link. It answers one
//  question and writes nothing:
//
//      For this application, which fields of the governing lease can
//      Spine supply from governed truth, and which are not established?
//
//  ── THE FIELD LIST IS NOT INVENTED ──────────────────────────────────
//  It is `executed_lease_service.verifyExecutedLease`'s own required
//  input set, read backwards. That service is THE canonical landing
//  place for a really-executed lease, and it already demands:
//
//      space_id · rent · security_deposit · lease_start_date ·
//      lease_end_date · executed_at · signers · execution_channel
//
//  So the bridge's job is to produce exactly those from governed truth,
//  hand them to whoever performs the signature ceremony, and feed the
//  provider's evidence back into that same service. Deriving the list
//  from the destination is what keeps the bridge from becoming a second
//  lease architecture with its own idea of what a lease needs.
//
//  ── IT PRODUCES NO DOCUMENT, AND MUST NOT ───────────────────────────
//  No template, no legal language, no assembled instrument. The Skyline
//  lease FORM is an external input owned by the business and legal side;
//  a developer inventing lease language is the confident-wrong this whole
//  codebase refuses, at the altitude where it is least recoverable.
//  This module supplies VALUES for a form it never sees.
//
//  ── EVERY FIELD SAYS WHETHER IT IS ESTABLISHED ──────────────────────
//  A field is `established` with a value and a stated source, or it is
//  not established with a reason. There is no third shape and no
//  defaulting: an unknown rent is not zero, an unknown term is not
//  twelve months, and an unknown landlord is not the property's name.
//
//  CLASS 1 — permanent product primitive. READ-ONLY: no insert, no
//  update, no delete anywhere in this file.
// ════════════════════════════════════════════════════════════════════
"use strict";

const { resolveSpaceEconomics } = require("../money/effective_pricing.js");

//  A field is one of exactly two shapes. Written as constructors so a
//  caller cannot accidentally build a half-populated one.
const established = (value, source, extra = {}) =>
  ({ established: true, value, source, reason: null, ...extra });
const notEstablished = (reason, detail, extra = {}) =>
  ({ established: false, value: null, source: null, reason, detail, ...extra });

/**
 * Assemble the governed lease terms for one application.
 *
 * @param q            pool or an open client. Reads only.
 * @param application_id
 * @param property_id  SERVER-DERIVED. The application's own property is
 *                     re-read and must agree; a caller cannot widen scope.
 * @param lease_term_months  the selected term. Not defaulted — see below.
 * @param lease_start_date   YYYY-MM-DD, the operator's selection.
 */
async function governedLeaseTerms(q, {
  application_id, property_id, lease_term_months = null, lease_start_date = null,
} = {}) {
  if (!application_id) throw new Error("governedLeaseTerms requires application_id");
  if (!property_id) throw new Error("governedLeaseTerms requires a server-derived property_id");

  const app = (await q.query(
    `select la.id, la.property_id, la.unit_id, la.space_id, la.person_id,
            la.applicant_name, la.status,
            p.name person_name, p.email person_email, p.phone person_phone
       from lease_applications la
       left join persons p on p.id = la.person_id
      where la.id = $1`, [application_id]
  )).rows[0];

  if (!app) {
    return { application_id, ready: false, blocking: ["application_not_found"],
             fields: {}, detail: "No application with that id." };
  }
  if (String(app.property_id) !== String(property_id)) {
    return { application_id, ready: false, blocking: ["application_not_at_property"],
             fields: {}, detail: "That application is not at this property." };
  }

  const fields = {};

  // ── THE BED (182) ─────────────────────────────────────────────────
  //  The whole reason the bridge can exist. Before 182 the application
  //  could not name a bed and the space was asserted at execution time
  //  with no lineage; now it travels from the aim.
  fields.space = app.space_id
    ? established(app.space_id, "lease_applications.space_id",
        { unit_id: app.unit_id })
    : notEstablished("space_not_aimed",
        "This application is not aimed at a specific rentable space. A governing "
        + "lease attaches to one space, so the bed must be chosen before a lease "
        + "can be prepared.");

  // ── THE RESIDENT ──────────────────────────────────────────────────
  //  A durable person, never a name on a row. The application birth
  //  guard already refuses a nameless identity; this refuses the inverse.
  fields.residents = app.person_id
    ? established(
        [{ person_id: app.person_id, name: app.person_name || app.applicant_name,
           email: app.person_email || null, phone: app.person_phone || null }],
        "persons via lease_applications.person_id")
    : notEstablished("resident_identity_not_established",
        "The application references no durable person.");

  // ── THE LANDLORD ──────────────────────────────────────────────────
  //  Read from the governed entity chain, never from the property's
  //  display name. A property name is a label an operator reads; the
  //  party to a lease is a legal entity, and confusing the two puts the
  //  wrong name on an instrument somebody signs.
  //  relationship_type is a CHECKED vocabulary (164): owner | operating_entity
  //  | other. Only `owner` is the party to a lease — an operating entity manages
  //  the asset and does not hold title, and treating the two as interchangeable
  //  is how the wrong name reaches a signed instrument. Matched exactly, not by
  //  pattern, so a vocabulary addition goes unrecognised rather than absorbed.
  const landlord = (await q.query(
    `select le.id, le.legal_name, le.entity_type, lep.relationship_type, lep.effective_from
       from legal_entity_properties lep
       join legal_entities le on le.id = lep.legal_entity_id
      where lep.property_id = $1
        and (lep.effective_to is null or lep.effective_to > current_date)
      order by lep.effective_from desc nulls last`, [property_id]
  )).rows;
  const owners = landlord.filter((r) => String(r.relationship_type) === "owner");
  fields.landlord = owners.length === 1
    ? established({ legal_entity_id: owners[0].id, legal_name: owners[0].legal_name,
                    relationship_type: owners[0].relationship_type },
                  "legal_entity_properties")
    : notEstablished(
        owners.length === 0 ? "landlord_entity_not_established" : "landlord_entity_ambiguous",
        owners.length === 0
          ? "No governed legal entity holds an ownership relationship to this property. "
            + "The party to the lease is a legal entity, not the property's display name."
          : `${owners.length} entities hold an ownership relationship to this property; `
            + "which one is the landlord on this lease is not established.",
        { candidates: owners.length });

  // ── TERM AND DATES ────────────────────────────────────────────────
  //  Neither is defaulted. Twelve months is the commonest lease, which is
  //  precisely why assuming it would put a term on an instrument that
  //  nobody selected.
  fields.lease_term_months = lease_term_months != null
    ? established(Number(lease_term_months), "operator selection")
    : notEstablished("lease_term_not_selected",
        "A lease term must be selected. It is never defaulted.");

  fields.lease_start_date = lease_start_date
    ? established(String(lease_start_date).slice(0, 10), "operator selection")
    : notEstablished("lease_start_not_selected",
        "A lease start date must be selected.");

  //  The end date is DERIVED, not asked for twice. Asking for both is how
  //  a term and its dates come to disagree on a signed document.
  if (lease_start_date && lease_term_months != null) {
    const d = new Date(String(lease_start_date).slice(0, 10) + "T00:00:00Z");
    if (isNaN(d.getTime())) {
      fields.lease_end_date = notEstablished("lease_start_unparseable",
        "The supplied start date is not a date.");
    } else {
      //  Last day of the term: start + N months, minus one day.
      const end = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + Number(lease_term_months), d.getUTCDate()));
      end.setUTCDate(end.getUTCDate() - 1);
      fields.lease_end_date = established(end.toISOString().slice(0, 10),
        "derived from start + term", { derivation: "start + term_months - 1 day" });
    }
  } else {
    fields.lease_end_date = notEstablished("lease_end_not_derivable",
      "The end date is derived from the start date and the term; both must be selected.");
  }

  // ── THE ECONOMICS — ONE OWNER, ALREADY GOVERNED ───────────────────
  //  Nothing is computed here. resolveSpaceEconomics is the single owner
  //  of authorized asking economics; this reads it and reports what it
  //  said, refusal included.
  let econ = null;
  if (app.space_id && lease_term_months != null) {
    econ = await resolveSpaceEconomics(q, {
      property_id, space_id: app.space_id, lease_term_months,
      as_of: lease_start_date ? String(lease_start_date).slice(0, 10) : null,
    });
  }

  if (!econ) {
    const why = !app.space_id ? "space_not_aimed" : "lease_term_not_selected";
    fields.rent = notEstablished(why, "Economics cannot be resolved without a bed and a term.");
    fields.security_deposit = notEstablished(why, "Economics cannot be resolved without a bed and a term.");
    fields.fees = notEstablished(why, "Economics cannot be resolved without a bed and a term.");
    fields.concessions = notEstablished(why, "Economics cannot be resolved without a bed and a term.");
  } else if (!econ.resolved) {
    //  The pricing refusal travels through UNCHANGED. Restating it in this
    //  module's own words would create a second vocabulary for one fact.
    fields.rent = notEstablished(econ.reason, econ.detail, { pricing: econ });
    fields.security_deposit = notEstablished(econ.reason, econ.detail);
    fields.fees = notEstablished(econ.reason, econ.detail);
    fields.concessions = notEstablished(econ.reason, econ.detail);
  } else {
    fields.rent = established(econ.rent.new_lease_rent,
      "published pricing version", { authority: econ.authority });
    fields.security_deposit = econ.deposit.established
      ? established(econ.deposit.text, "agent_facts (transitional)",
          { scope: econ.deposit.scope })
      : notEstablished("security_deposit_not_established",
          "No approved security-deposit fact applies to this position.");
    const feeKeys = ["application_fee", "amenity_fee", "admin_fee", "telecom_fee"];
    const feesPresent = feeKeys.filter((k) => econ.fees[k] && econ.fees[k].established);
    fields.fees = established(
      Object.fromEntries(feesPresent.map((k) => [k, econ.fees[k].text])),
      "agent_facts (transitional)",
      { established_keys: feesPresent, missing_keys: feeKeys.filter((k) => !feesPresent.includes(k)) });
    fields.concessions = established(econ.concessions.advertisable,
      "published concession policies",
      { withheld: econ.concessions.withheld });
  }

  // ── THE TWO THINGS SPINE HAS NO MODEL FOR ─────────────────────────
  //  Named rather than omitted. An omitted field reads as "not needed";
  //  these are needed and absent, which is a different fact and the one
  //  the lease bridge must not paper over.
  fields.required_addenda = notEstablished("addenda_model_not_built",
    "Spine has no model of which addenda a jurisdiction or a lease form requires. "
    + "This must come from the governing lease form, which is an external input.");
  fields.company_signer = notEstablished("company_signer_not_established",
    "Spine has no model of who is authorised to sign a lease on the company's "
    + "behalf. Module entitlement governs who may operate; it does not say who "
    + "may bind the company.");

  const blocking = Object.entries(fields)
    .filter(([, f]) => !f.established)
    .map(([name, f]) => ({ field: name, reason: f.reason }));

  return {
    application_id,
    property_id,
    application_status: app.status,
    //  READY means every field the canonical landing point requires is
    //  established. It is computed from the fields, never asserted.
    ready: blocking.length === 0,
    blocking,
    fields,
    //  Stated so a reader is never left inferring it from an absence.
    contract: {
      target: "executed_lease_service.verifyExecutedLease",
      note: "Field list is that service's required input set, read backwards. "
          + "This module produces no document and supplies no legal language.",
      produces_document: false,
    },
  };
}

module.exports = { governedLeaseTerms };
