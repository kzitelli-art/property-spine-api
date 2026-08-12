/* ════════════════════════════════════════════════════════════════════
   insurance_allocation_service.js — THE canonical writer for governed
   property allocations.

   How much of a coverage's economics belongs to one property, for one
   effective slice of time. This is the fact the June 2026 workpaper was
   reconstructing from IPFS down payments and installments; here it is
   established on its own terms and financing is not reachable from it.

   ── TWO MECHANISMS, AND CONFLATING THEM IS THE MISTAKE ─────────────

     correctSlice()   THE SAME CLAIM WAS WRONG. Somebody keyed 18% as 8%.
                      Supersession, with a reason required at the
                      database. The corrected row is preserved.

     openSlice()      SOMETHING CHANGED. 4233 was added mid-term; the
                      basis was recut; an endorsement moved the cost.
                      A NEW dated slice, effective forward. The prior
                      slice is CLOSED, never edited.

   June must remain explainable after July is recut. That is only true if
   nothing ever rewrites the June row, so closing a slice sets
   effective_to and never touches the amount.

   ── ALLOCATION ARITHMETIC IS NOT ALLOWED TO INVENT A SHARE ─────────

     over-allocation   REFUSED. Allocating more than the coverage costs
                       is an arithmetic impossibility.
     under-allocation  RECORDED, and reported as an unresolved remainder.
                       NEVER plugged.

   The second is the "broker allocation omitting part of the financed
   pool" case already found in real data. The temptation is to balance
   it. Balancing it would invent a property's share out of a gap that is
   itself the finding.

   ── PROVENANCE IS REQUIRED; STRENGTH IS VISIBLE ────────────────────
   A document is not required — a broker's emailed figure confirmed by a
   human is a legitimate source. It is a WEAKER one, and the read reports
   which it was rather than flattening the two together.

   CLASS 1 — permanent product primitive.
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const { insuranceError } = require("./insurance_program_service.js");

const ALLOCATION_CLASSES = Object.freeze(["stated", "derived"]);
const ALLOCATION_BASES = Object.freeze([
  "carrier_stated", "broker_stated", "tiv_prorata", "unit_count", "negotiated", "other",
]);

//  Which bases are legitimately STATED by someone outside Spine, and
//  which are Spine's own arithmetic. Kept here rather than left to the
//  caller, because a tiv_prorata split labelled 'stated' would launder a
//  model as an external authority — the precise §38 failure.
const EXTERNALLY_STATED_BASES = Object.freeze(["carrier_stated", "broker_stated", "negotiated"]);

/*  Live rows for a scope: everything not superseded. Read as "no
 *  successor exists", never as newest — that is only the head if the
 *  chain is guaranteed linear, and it is not. */
async function liveSlices(client, { coverage_id, property_id = null }) {
  const { rows } = await client.query(
    `select a.* from insurance_property_allocations a
      where a.coverage_id = $1
        and ($2::uuid is null or a.property_id = $2)
        and not exists (select 1 from insurance_property_allocations s
                         where s.supersedes_id = a.id)
      order by a.effective_from asc`,
    [coverage_id, property_id]);
  return rows;
}

/*  THE OVER-ALLOCATION GUARD.
 *
 *  A cross-row sum cannot be a database constraint, so it is enforced
 *  here — the same shape as money_event_attributions' sum-guard, and for
 *  the same reason. Evaluated at a POINT IN TIME, because slices open and
 *  close: two properties each holding 60% is fine if one ran Jan–Jun and
 *  the other Jul–Dec.
 */
async function allocatedAtInstant(client, { coverage_id, on_date, excluding_id = null }) {
  const { rows } = await client.query(
    `select coalesce(sum(a.allocated_amount_cents), 0)::bigint as cents
       from insurance_property_allocations a
      where a.coverage_id = $1
        and ($3::uuid is null or a.id <> $3)
        and not exists (select 1 from insurance_property_allocations s
                         where s.supersedes_id = a.id)
        and a.effective_from <= $2
        and (a.effective_to is null or a.effective_to > $2)`,
    [coverage_id, on_date, excluding_id]);
  return Number(rows[0].cents);
}

function validateShape({ allocated_amount_cents, allocation_class, allocation_basis, basis_detail,
                         source_artifact_id, provenance_note, user_id }) {
  if (!Number.isInteger(allocated_amount_cents) || allocated_amount_cents <= 0) {
    throw insuranceError("BAD_INPUT", "allocated_amount_cents must be a positive integer of cents");
  }
  if (!ALLOCATION_CLASSES.includes(allocation_class)) {
    throw insuranceError("BAD_INPUT", `allocation_class must be one of ${ALLOCATION_CLASSES.join(", ")}`);
  }
  if (!ALLOCATION_BASES.includes(allocation_basis)) {
    throw insuranceError("BAD_INPUT", `allocation_basis must be one of ${ALLOCATION_BASES.join(", ")}`);
  }
  //  A DERIVED allocation must name its model. §38: derived attribution
  //  must name the model that produced it, the way UNASSIGNED is a
  //  different class from a person's name.
  if (allocation_class === "derived" && !(basis_detail && String(basis_detail).trim())) {
    throw insuranceError("DERIVED_NEEDS_MODEL",
      "a derived allocation must record basis_detail — the model and inputs that produced it");
  }
  //  And a STATED allocation may not claim an internally-computed basis.
  if (allocation_class === "stated" && !EXTERNALLY_STATED_BASES.includes(allocation_basis)) {
    throw insuranceError("STATED_NEEDS_EXTERNAL_BASIS",
      `allocation_basis '${allocation_basis}' is computed by Spine and cannot be recorded as 'stated'. ` +
      "Labelling a model's output as externally stated is how an internal estimate acquires a carrier's authority.");
  }
  if (!source_artifact_id && !(provenance_note && String(provenance_note).trim())) {
    throw insuranceError("PROVENANCE_REQUIRED",
      "an allocation requires provenance: a source artifact, or a note recording where the figure came from");
  }
  if (!user_id) throw insuranceError("BAD_INPUT", "user_id is required");
}

/*  ── OPEN A NEW EFFECTIVE SLICE ─────────────────────────────────────
 *  The prior live slice for this (coverage, property), if any, is CLOSED
 *  at effective_from — its amount is never touched. That is what keeps
 *  June explainable after July changes.
 */
async function openSlice(client, spec = {}) {
  const {
    coverage_id, property_id, allocated_amount_cents,
    allocation_class, allocation_basis, basis_detail = null,
    effective_from, effective_to = null,
    source_artifact_id = null, provenance_note = null, user_id,
  } = spec;

  if (!coverage_id || !property_id) {
    throw insuranceError("BAD_INPUT", "coverage_id and property_id are required");
  }
  if (!effective_from) throw insuranceError("BAD_INPUT", "effective_from is required");
  validateShape(spec);

  const cov = (await client.query(
    `select * from insurance_coverages where id = $1 for update`, [coverage_id])).rows[0];
  if (!cov) throw insuranceError("NOT_FOUND", "coverage not found");

  //  ── ALLOCATION REQUIRES PARTICIPATION ──────────────────────────────
  //  Migration 162 enforces this with a foreign key, which is what makes
  //  it an invariant rather than a convention. This check exists so the
  //  refusal is SAYABLE: a raw FK violation is our machinery leaking at
  //  someone who is trying to record a number off a policy document.
  //
  //  You cannot hold a share of a policy you are not named on. Record the
  //  participation first — that is the smaller, better-evidenced fact,
  //  and it is what the schedule of locations actually says.
  const named = (await client.query(
    `select 1 from insurance_coverage_properties
      where coverage_id = $1 and property_id = $2`, [coverage_id, property_id])).rows[0];
  if (!named) {
    throw insuranceError("PARTICIPATION_REQUIRED",
      "this property is not recorded as named on this coverage, so it cannot hold a share " +
      "of it. Record that the property is on the policy first.");
  }

  //  CLOSE the prior live slice for this scope before opening the next.
  //  Only slices that are still open, or that extend past the new start.
  await client.query(
    `update insurance_property_allocations a
        set effective_to = $3
      where a.coverage_id = $1 and a.property_id = $2
        and not exists (select 1 from insurance_property_allocations s where s.supersedes_id = a.id)
        and a.effective_from < $3
        and (a.effective_to is null or a.effective_to > $3)`,
    [coverage_id, property_id, effective_from]);

  //  THE OVER-ALLOCATION REFUSAL, at the instant the new slice begins.
  const already = await allocatedAtInstant(client, { coverage_id, on_date: effective_from });
  const total = Number(cov.total_cents);
  if (already + allocated_amount_cents > total) {
    throw insuranceError("OVER_ALLOCATED",
      `allocating ${allocated_amount_cents} would bring this coverage to ` +
      `${already + allocated_amount_cents} against a total of ${total}. ` +
      "A coverage cannot allocate more than it costs.",
      { coverage_total_cents: total, already_allocated_cents: already });
  }

  //  Stamp the Deal membership CURRENT AT ORIGIN. Never derived later.
  const mem = (await client.query(
    `select id from deal_intake_properties
      where property_id = $1 and status = 'current' limit 1`, [property_id])).rows[0];

  const { rows } = await client.query(
    `insert into insurance_property_allocations
       (coverage_id, property_id, deal_membership_id, allocated_amount_cents,
        allocation_class, allocation_basis, basis_detail,
        effective_from, effective_to,
        source_artifact_id, provenance_note, confirmed_by_user_id)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning *`,
    [coverage_id, property_id, mem ? mem.id : null, allocated_amount_cents,
     allocation_class, allocation_basis, basis_detail,
     effective_from, effective_to,
     source_artifact_id, provenance_note, user_id]);
  return rows[0];
}

/*  ── CORRECT AN EXISTING SLICE ──────────────────────────────────────
 *  The same claim, restated. The predecessor is preserved and remains
 *  readable; the reason is required and the database enforces it.
 *
 *  This is NOT how a mid-term change is recorded. If the world changed,
 *  openSlice() is the verb — otherwise the correction would erase the
 *  fact that the earlier figure was ever true.
 */
async function correctSlice(client, {
  allocation_id, allocated_amount_cents, allocation_class, allocation_basis,
  basis_detail = null, revision_reason,
  source_artifact_id = null, provenance_note = null, user_id,
} = {}) {
  if (!allocation_id) throw insuranceError("BAD_INPUT", "allocation_id is required");
  if (!(revision_reason && String(revision_reason).trim())) {
    throw insuranceError("REASON_REQUIRED",
      "a correction requires a reason. Without one the record cannot explain why the earlier figure changed.");
  }

  const prev = (await client.query(
    `select * from insurance_property_allocations where id = $1 for update`,
    [allocation_id])).rows[0];
  if (!prev) throw insuranceError("NOT_FOUND", "allocation not found");

  const spec = {
    allocated_amount_cents: allocated_amount_cents === undefined
      ? Number(prev.allocated_amount_cents) : allocated_amount_cents,
    allocation_class: allocation_class || prev.allocation_class,
    allocation_basis: allocation_basis || prev.allocation_basis,
    basis_detail: basis_detail === null ? prev.basis_detail : basis_detail,
    source_artifact_id: source_artifact_id === null ? prev.source_artifact_id : source_artifact_id,
    provenance_note: provenance_note === null ? prev.provenance_note : provenance_note,
    user_id,
  };
  validateShape(spec);

  //  The corrected figure must still fit the coverage. Exclude the row
  //  being superseded from the sum — it is about to stop being live.
  const cov = (await client.query(
    `select * from insurance_coverages where id = $1`, [prev.coverage_id])).rows[0];
  const already = await allocatedAtInstant(client, {
    coverage_id: prev.coverage_id, on_date: prev.effective_from, excluding_id: prev.id });
  if (already + spec.allocated_amount_cents > Number(cov.total_cents)) {
    throw insuranceError("OVER_ALLOCATED",
      "the corrected allocation would exceed the coverage total",
      { coverage_total_cents: Number(cov.total_cents), already_allocated_cents: already });
  }

  const { rows } = await client.query(
    `insert into insurance_property_allocations
       (coverage_id, property_id, deal_membership_id, allocated_amount_cents,
        allocation_class, allocation_basis, basis_detail,
        effective_from, effective_to,
        source_artifact_id, provenance_note, confirmed_by_user_id,
        supersedes_id, revision_reason)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) returning *`,
    [prev.coverage_id, prev.property_id, prev.deal_membership_id, spec.allocated_amount_cents,
     spec.allocation_class, spec.allocation_basis, spec.basis_detail,
     prev.effective_from, prev.effective_to,
     spec.source_artifact_id, spec.provenance_note, user_id,
     prev.id, String(revision_reason).trim()]);
  return rows[0];
}

module.exports = {
  ALLOCATION_CLASSES, ALLOCATION_BASES, EXTERNALLY_STATED_BASES,
  openSlice, correctSlice, liveSlices, allocatedAtInstant,
};
