/* ════════════════════════════════════════════════════════════════════
   insurance_position_read.js — WHAT INSURANCE COSTS THIS PROPERTY, AND
   WHAT BELONGS TO THIS PERIOD.

   Read-only. Writes nothing, stores nothing, and derives every figure
   per request — the same discipline as room establishment, for the same
   reason: a stored derivation goes stale silently.

   ── THE ACCRUAL RULING, EXACTLY ────────────────────────────────────

       property annual insurance cost ÷ term months = monthly accrual

   Equal monthly straight-line recognition across the coverage period.
   For the ordinary twelve-month term this is the prior-year concept the
   workpapers were reaching for: allocated annual insurance cost plus
   brokerage fee, ÷ 12.

   NO DAILY PRORATION. A partial-period case is an accounting-policy
   decision this slice does not make; the model keeps enough dated facts
   to support one later without disturbing the underlying insurance
   truth.

   ── WHAT MAY NOT APPEAR IN THIS COMPUTATION ────────────────────────
   Installment timing. Down payment timing. Invoice date. Financing
   acceptance date. Bank payment date. Escrow. None of them is reachable
   from here — this module joins only programs, coverages, allocations
   and properties — and a source-governance gate fails the build if one
   is introduced.

   Cash timing is irrelevant to insurance expense. That is the whole
   correction.

   ── A CHANGE MID-TERM CHANGES THE FUTURE, NOT THE PAST ─────────────
   A slice effective 1 July governs July forward. June is answered by the
   slice that was live in June, which was never edited. Ask the history
   for a month and it tells you what was true THEN, not what is true now.
   ════════════════════════════════════════════════════════════════════ */
"use strict";

/*  Whole months between two dates. 2026-03-01 → 2027-03-01 is 12.
 *  Deliberately calendar months rather than days: the recognition policy
 *  is equal monthly, so the divisor is the count of months the term
 *  spans, not its length in days. */
function termMonths(startISO, endISO) {
  const s = new Date(startISO + "T00:00:00Z");
  const e = new Date(endISO + "T00:00:00Z");
  const months = (e.getUTCFullYear() - s.getUTCFullYear()) * 12
    + (e.getUTCMonth() - s.getUTCMonth());
  return months > 0 ? months : 1;
}

/*  The first day of a YYYY-MM period, and the first day of the next.
 *  A period is half-open [start, next) so a coverage ending on the 1st
 *  does not get counted into the month it no longer covers. */
function periodBounds(period) {
  const [y, m] = String(period).split("-").map(Number);
  const start = new Date(Date.UTC(y, m - 1, 1));
  const next = new Date(Date.UTC(y, m, 1));
  return { start: start.toISOString().slice(0, 10), next: next.toISOString().slice(0, 10) };
}

function iso(d) {
  return d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10);
}

/*  Provenance STRENGTH, derived and never stored. A document and a
 *  human's word are both legitimate sources and they are not equal;
 *  flattening them would let an emailed figure read like a binder. */
function provenanceStrength(a) {
  return a.source_artifact_id ? "documentary" : "attested";
}

/*  ── THE POSITION ───────────────────────────────────────────────────
 *  Every coverage this property participates in, the slice that governed
 *  the requested period, and what that means for the period.
 */
async function readPosition(client, { property_id, period }) {
  const { start, next } = periodBounds(period);

  //  Coverages this property is allocated to, with the allocation slice
  //  LIVE DURING THE REQUESTED PERIOD — not the newest slice. Asking for
  //  June returns June's truth even after July has been recut.
  //
  //  A slice is live when nothing supersedes it (corrections drop out);
  //  it governs the period when its effective range overlaps it.
  const { rows } = await client.query(
    `select
       a.id                as allocation_id,
       a.allocated_amount_cents,
       a.allocation_class, a.allocation_basis, a.basis_detail,
       a.effective_from, a.effective_to,
       a.source_artifact_id, a.provenance_note,
       a.confirmed_by_user_id, a.confirmed_at,
       a.supersedes_id, a.revision_reason,
       c.id                as coverage_id,
       c.coverage_type, c.carrier_name, c.broker_name,
       c.coverage_period_start, c.coverage_period_end,
       c.premium_cents, c.taxes_cents, c.fees_cents, c.broker_fee_cents, c.total_cents,
       p.id                as program_id,
       p.program_name, p.term_start, p.term_end, p.currency_code
     from insurance_property_allocations a
     join insurance_coverages c on c.id = a.coverage_id
     join insurance_programs  p on p.id = c.program_id
    where a.property_id = $1
      and not exists (select 1 from insurance_property_allocations s
                       where s.supersedes_id = a.id)
      and a.effective_from < $3
      and (a.effective_to is null or a.effective_to > $2)
      and c.coverage_period_start < $3
      and c.coverage_period_end   > $2
    order by c.coverage_type asc, c.coverage_period_start asc`,
    [property_id, start, next]);

  if (!rows.length) {
    return { established: false, period, currency_code: null, coverages: [],
             annual_cost_cents: null, period_accrual_cents: null, next_renewal: null };
  }

  //  ⚠ ONE CURRENCY PER POSITION. Summing across currencies would be a
  //  fabricated number wearing a total's authority. If a property ever
  //  participates in programs of different currencies, the position says
  //  so and refuses to total rather than picking one.
  const currencies = Array.from(new Set(rows.map((r) => r.currency_code)));
  const mixed = currencies.length > 1;

  const coverages = rows.map((r) => {
    const months = termMonths(iso(r.coverage_period_start), iso(r.coverage_period_end));
    const annual = Number(r.allocated_amount_cents);
    return {
      coverage_id: r.coverage_id,
      program_id: r.program_id,
      program_name: r.program_name,
      coverage_type: r.coverage_type,
      carrier_name: r.carrier_name,
      broker_name: r.broker_name,
      coverage_period_start: iso(r.coverage_period_start),
      coverage_period_end: iso(r.coverage_period_end),
      currency_code: r.currency_code,

      //  The coverage's own economics, for drill-down. Premium, taxes,
      //  fees and broker fee — and no finance charge, because one is not
      //  a component of insurance cost.
      coverage_total_cents: Number(r.total_cents),

      //  THE PROPERTY'S SHARE, and how it was established.
      property_annual_cost_cents: annual,
      term_months: months,
      property_monthly_accrual_cents: Math.round(annual / months),

      allocation_id: r.allocation_id,
      allocation_class: r.allocation_class,
      allocation_basis: r.allocation_basis,
      basis_detail: r.basis_detail,
      provenance_strength: provenanceStrength(r),
      effective_from: iso(r.effective_from),
      effective_to: r.effective_to ? iso(r.effective_to) : null,
    };
  });

  const annual_cost_cents = mixed ? null
    : coverages.reduce((n, c) => n + c.property_annual_cost_cents, 0);
  const period_accrual_cents = mixed ? null
    : coverages.reduce((n, c) => n + c.property_monthly_accrual_cents, 0);

  const next_renewal = coverages
    .map((c) => c.coverage_period_end).sort()[0] || null;

  return {
    established: true,
    period,
    currency_code: mixed ? null : currencies[0],
    mixed_currency: mixed,
    coverages,
    annual_cost_cents,
    period_accrual_cents,
    next_renewal,
  };
}

/*  ── ALLOCATION COMPLETENESS ────────────────────────────────────────
 *  Per coverage: what is allocated at the period start, against what the
 *  coverage costs.
 *
 *  AN UNRESOLVED REMAINDER IS THE FINDING, NOT AN ERROR TO CLEAR. The
 *  broker allocation that omitted part of the pool is real, already
 *  observed, and stating the gap is the honest answer. Plugging it would
 *  invent a property's share out of the very thing worth knowing.
 */
async function readCompleteness(client, { property_id, period }) {
  const { start, next } = periodBounds(period);
  const { rows } = await client.query(
    `select c.id as coverage_id, c.coverage_type, c.total_cents,
            coalesce(sum(live.allocated_amount_cents), 0)::bigint as allocated_cents
       from insurance_coverages c
       join insurance_property_allocations mine
            on mine.coverage_id = c.id and mine.property_id = $1
           and not exists (select 1 from insurance_property_allocations s
                            where s.supersedes_id = mine.id)
           and mine.effective_from < $3
           and (mine.effective_to is null or mine.effective_to > $2)
       left join insurance_property_allocations live
            on live.coverage_id = c.id
           and not exists (select 1 from insurance_property_allocations s2
                            where s2.supersedes_id = live.id)
           and live.effective_from < $3
           and (live.effective_to is null or live.effective_to > $2)
      where c.coverage_period_start < $3 and c.coverage_period_end > $2
      group by c.id, c.coverage_type, c.total_cents`,
    [property_id, start, next]);

  return rows.map((r) => {
    const total = Number(r.total_cents);
    const allocated = Number(r.allocated_cents);
    return {
      coverage_id: r.coverage_id,
      coverage_type: r.coverage_type,
      coverage_total_cents: total,
      allocated_cents: allocated,
      unallocated_cents: total - allocated,
      reconciles: total === allocated,
    };
  });
}

/*  ── HISTORY ────────────────────────────────────────────────────────
 *  Every slice and every correction for this property, in order. This is
 *  what makes "June is still explainable after July" checkable by a
 *  human rather than merely true in the schema.
 */
async function readHistory(client, { property_id }) {
  const { rows } = await client.query(
    `select a.id, a.coverage_id, c.coverage_type, p.program_name,
            a.allocated_amount_cents, a.allocation_class, a.allocation_basis,
            a.effective_from, a.effective_to,
            a.supersedes_id, a.revision_reason, a.confirmed_at,
            a.source_artifact_id,
            exists (select 1 from insurance_property_allocations s
                     where s.supersedes_id = a.id) as superseded
       from insurance_property_allocations a
       join insurance_coverages c on c.id = a.coverage_id
       join insurance_programs  p on p.id = c.program_id
      where a.property_id = $1
      order by a.effective_from asc, a.created_at asc`,
    [property_id]);

  return rows.map((r) => ({
    allocation_id: r.id,
    coverage_id: r.coverage_id,
    coverage_type: r.coverage_type,
    program_name: r.program_name,
    amount_cents: Number(r.allocated_amount_cents),
    allocation_class: r.allocation_class,
    allocation_basis: r.allocation_basis,
    effective_from: iso(r.effective_from),
    effective_to: r.effective_to ? iso(r.effective_to) : null,
    //  A correction and a new slice are different events and the history
    //  says which. Rendering them identically is how a restatement comes
    //  to look like a change in the world.
    change_kind: r.supersedes_id ? "correction" : "effective_change",
    revision_reason: r.revision_reason,
    superseded: r.superseded,
    provenance_strength: r.source_artifact_id ? "documentary" : "attested",
    recorded_at: r.confirmed_at,
  }));
}

module.exports = { readPosition, readCompleteness, readHistory, termMonths, periodBounds };
