// ════════════════════════════════════════════════════════════════════
//  leasing_standing_read.js — LEASING'S COMPACT STANDING PROJECTION
//
//  §40.6 asks each domain for a projection cheap enough to gather
//  routinely: current position, important unknowns, next milestone.
//  Tenancy has one (tenancy_position_read). Leasing did not, and the cost
//  was measured rather than assumed: driving a resident signature through
//  the real path and then asking every leasing surface what it knew, the
//  Person Card, the relationship stage and the application status were all
//  IDENTICAL before and after the resident executed the governing
//  instrument. The single most consequential act a resident performs was
//  invisible to every read in the domain.
//
//  ── IT DECIDES NOTHING. THAT IS THE WHOLE POINT ─────────────────────
//  Every fact here is READ FROM ITS EXISTING OWNER. This module owns no
//  business meaning and must never acquire any:
//
//      relationship_stage.resolveRelationshipStage  the stage
//      effective_pricing.resolveSpaceEconomics      asking economics
//      the application lifecycle's own next-action  what to do next
//      executed_lease_service                       execution truth
//      lease_packets' own columns                   who has signed
//      leases                                       tenancy commitment
//      obligations                                  who owns the next work
//
//  If an answer here ever disagrees with one of those, the owner is right
//  and this file is wrong. A second opinion is exactly what §17 forbids,
//  and a standing read that reinterprets its sources is a second opinion
//  wearing a summary's clothes.
//
//  ── THE FOUR SILENCES ARE KEPT APART (§40.7) ────────────────────────
//  A leasing question has four different empty answers and collapsing them
//  is how a surface lies quietly:
//
//      not_established   nobody has established this fact yet
//      blocked           a real conflict is preventing progress
//      read_failed       a source could not be read — NOT the same as absent
//      settled           nothing requires attention, and that is the answer
//
//  `uncertainty` carries them explicitly. An empty uncertainty list means
//  settled; it never means "we did not look".
//
//  READ-ONLY. Nothing here writes. Class 1 — permanent product primitive.
// ════════════════════════════════════════════════════════════════════
"use strict";

const { resolveRelationshipStage } = require("../shared/relationship_stage");
const { resolveSpaceEconomics } = require("../money/effective_pricing");

//  A source that could not be read is reported, never silently emptied.
async function attempt(label, fn, notes) {
  try { return await fn(); }
  catch (e) {
    notes.push({ kind: "read_failed", subject: label, detail: e.message });
    return null;
  }
}

/**
 * @param db          pool or client
 * @param person_id   the person
 * @param property_id SERVER-DERIVED. Never accepted from a browser.
 * @param deps        { executedLease, applicationsService } — the canonical
 *                    services, injected so this file owns neither.
 */
async function readLeasingStanding(db, { person_id, property_id, as_of = null } = {}, deps = {}) {
  if (!person_id || !property_id) {
    throw new Error("readLeasingStanding requires person_id and a server-derived property_id");
  }
  const notes = [];
  const asOf = as_of || new Date().toISOString().slice(0, 10);

  const person = await attempt("person", async () => (await db.query(
    `select id, name from persons where id=$1`, [person_id])).rows[0] || null, notes);

  // ── STAGE — the one resolver, not a second ladder ─────────────────
  const stageOut = await attempt("relationship_stage",
    () => resolveRelationshipStage(db, { personId: person_id, propertyId: property_id, asOf: as_of }), notes);

  // ── THE OPPORTUNITY AND ITS TARGET ────────────────────────────────
  const app = await attempt("application", async () => (await db.query(
    `select a.id, a.status, a.unit_id, a.space_id, a.applicant_name,
            a.terms_review_obligation_id, a.executed_lease_record_id, a.created_at,
            u.unit_number, s.space_label
       from lease_applications a
       left join units  u on u.id = a.unit_id
       left join spaces s on s.id = a.space_id
      where a.person_id=$1 and a.property_id=$2
      order by a.created_at desc limit 1`, [person_id, property_id])).rows[0] || null, notes);

  const conversion = await attempt("opportunity", async () => (await db.query(
    `select id, current_stage from leasing_conversions
      where person_id=$1 and property_id=$2 order by created_at desc limit 1`,
    [person_id, property_id])).rows[0] || null, notes);

  // ── THE INSTRUMENT AND WHO HAS SIGNED IT ──────────────────────────
  const packet = app ? await attempt("lease_packet", async () => (await db.query(
    `select id, version, status, is_placeholder, superseded_at,
            instrument_form_code, instrument_body_sha256,
            resident_executed_at, company_executed_at
       from lease_packets
      where application_id=$1 and superseded_at is null
      order by version desc limit 1`, [app.id])).rows[0] || null, notes) : null;

  const executed = app ? await attempt("executed_lease", async () => (await db.query(
    `select id, verification_basis, execution_channel, admission_status,
            document_sha256, executed_at, source_lease_packet_id
       from executed_lease_records
      where application_id=$1 and voided_at is null
      order by verified_at desc limit 1`, [app.id])).rows[0] || null, notes) : null;

  // ── THE TENANCY COMMITMENT ────────────────────────────────────────
  const lease = app ? await attempt("tenancy", async () => (await db.query(
    `select id, lease_status, space_id, rent, security_deposit, start_date, end_date
       from leases where application_id=$1 order by created_at desc limit 1`,
    [app.id])).rows[0] || null, notes) : null;

  // ── ECONOMICS — asked of the pricing owner, never derived here ────
  //  THE TERM IS SELECTED, NEVER DEFAULTED. effective_pricing refuses to
  //  assume twelve months and it is right to: a quoted term the operator
  //  never chose is a wrong number wearing a lookup's clothes. The selected
  //  term is a governed fact — it is whatever the current proposed-terms
  //  confirmation named — so it is READ, and when nothing has been confirmed
  //  the answer stays honestly unresolved.
  const confirmation = app ? await attempt("proposed_terms", async () => (await db.query(
    `select rent, security_deposit, lease_start_date, lease_end_date, concession_status
       from application_proposed_terms_confirmations
      where application_id=$1 order by created_at desc limit 1`, [app.id])).rows[0] || null, notes) : null;

  //  THE ONE PIECE OF ARITHMETIC IN THIS FILE, AND WHY IT IS SAFE.
  //  The confirmation stores DATES, not a term length, so asking the pricing
  //  owner "what is published for this term" requires converting the two.
  //  A lease runs to the day BEFORE the anniversary — 2026-09-01 through
  //  2027-08-31 is twelve months, not eleven — so the count is taken to
  //  end + 1 day. It FAILS CLOSED: if the dates do not land exactly on a
  //  whole month boundary the term is left unselected rather than rounded,
  //  because a rounded term would ask the pricing owner about a term nobody
  //  confirmed and get a confident answer to the wrong question.
  let selectedTerm = null;
  if (confirmation && confirmation.lease_start_date && confirmation.lease_end_date) {
    const a = new Date(confirmation.lease_start_date);
    const b = new Date(confirmation.lease_end_date);
    if (!isNaN(a) && !isNaN(b)) {
      const after = new Date(b.getTime());
      after.setUTCDate(after.getUTCDate() + 1);
      const months = (after.getUTCFullYear() - a.getUTCFullYear()) * 12
                   + (after.getUTCMonth() - a.getUTCMonth());
      if (months > 0 && after.getUTCDate() === a.getUTCDate()) selectedTerm = months;
      else if (months > 0) {
        notes.push({ kind: "not_established", subject: "selected_term",
          detail: "The confirmed dates do not span whole months, so no term length is established." });
      }
    }
  }

  let asking = null;
  if (app && app.space_id) {
    asking = await attempt("asking_economics",
      () => resolveSpaceEconomics(db, { property_id, space_id: app.space_id, lease_term_months: selectedTerm, as_of: asOf }), notes);
  }

  // ── WHO OWNS THE NEXT WORK — the obligation engine's answer ───────
  const openWork = app || conversion ? await attempt("open_obligations", async () => (await db.query(
    `select o.id, o.type, o.label, o.status, o.assigned_role,
            o.assigned_user_id, u.name owner_name
       from obligations o
       left join users u on u.id = o.assigned_user_id
      where o.status in ('open','in_progress')
        and ((o.related_type='lease_application' and o.related_id=$1)
          or (o.related_type='leasing_conversion'  and o.related_id=$2))
      order by o.created_at desc limit 5`,
    [app ? app.id : null, conversion ? conversion.id : null])).rows, notes) : [];

  // ── UNCERTAINTY, KEPT APART FROM ABSENCE ──────────────────────────
  const uncertainty = notes.slice();
  if (executed && executed.admission_status === "blocked") {
    uncertainty.push({ kind: "blocked", subject: "activation",
      detail: "The lease is executed and stands; operational activation is blocked." });
  }
  if (app && app.space_id && asking && asking.resolved === false) {
    uncertainty.push({ kind: "not_established", subject: "asking_economics", detail: asking.detail || asking.reason });
  }
  if (app && !app.space_id) {
    uncertainty.push({ kind: "not_established", subject: "target_space",
      detail: "This application names a unit but no exact space." });
  }

  // ── EXECUTION, STATED AS TWO SEPARATE ACTS ────────────────────────
  const leaseBand = packet ? {
    packet_id: packet.id,
    packet_version: packet.version,
    packet_status: packet.status,
    carries_governing_instrument: !!packet.instrument_body_sha256,
    instrument_form_code: packet.instrument_form_code || null,
    resident_executed_at: packet.resident_executed_at || null,
    company_executed_at: packet.company_executed_at || null,
    executed_lease: executed ? {
      present: true,
      record_id: executed.id,
      verification_basis: executed.verification_basis,
      execution_channel: executed.execution_channel,
      admission_status: executed.admission_status || null,
      document_sha256: executed.document_sha256 || null,
    } : { present: false },
  } : null;

  return {
    as_of: asOf,
    person: person ? { id: person.id, name: person.name } : null,
    property_id,
    opportunity: conversion ? { id: conversion.id, current_stage: conversion.current_stage } : null,
    target: app ? {
      property_id,
      unit_id: app.unit_id || null,
      unit_label: app.unit_number || null,
      space_id: app.space_id || null,
      space_label: app.space_label || null,
    } : null,
    current_position: stageOut ? { stage: stageOut.stage, basis: stageOut.basis } : null,
    economics: {
      asking: asking && asking.resolved
        ? { resolved: true, rent: asking.rent, authority: asking.authority }
        : { resolved: false, reason: asking ? asking.reason : "no_space_selected" },
      //  What was SIGNED wins over what is currently published. The signed
      //  instrument's terms are the ones the parties put their names to.
      executed: lease ? { rent: lease.rent, security_deposit: lease.security_deposit,
                          lease_start_date: lease.start_date, lease_end_date: lease.end_date } : null,
    },
    application: app ? { id: app.id, status: app.status, applied_at: app.created_at } : null,
    lease: leaseBand,
    tenancy: lease
      ? { state: lease.lease_status, lease_id: lease.id, space_id: lease.space_id }
      : { state: "none", lease_id: null, space_id: null },
    next: {
      //  Owned work, from the obligation engine. UNASSIGNED is stated, never
      //  implied by an absent name.
      open_work: (openWork || []).map((o) => ({
        obligation_id: o.id, type: o.type, label: o.label, status: o.status,
        owner: o.assigned_user_id ? { user_id: o.assigned_user_id, name: o.owner_name } : "UNASSIGNED",
        assigned_role: o.assigned_role || null,
      })),
    },
    uncertainty,
    settled: uncertainty.length === 0,
  };
}

module.exports = { readLeasingStanding };
