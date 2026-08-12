/* ════════════════════════════════════════════════════════════════════
   tax_position_read.js — ARE OUR TAXES CURRENT?

   ONE canonical property-facing read. It compresses entity-level
   obligations into the property view WITHOUT changing their identity: an
   entity's BIRT return appears on each related property and remains one
   obligation with one id.

   ── EVERY STATE IS DERIVED. NOTHING IS PERSISTED. ───────────────────
   No status column anywhere in the tax schema. The position is a
   function of governed facts and a date, so a payment recorded today
   changes the answer with no backfill and no sweeper — and there is no
   stored label that can drift from the facts underneath it.

   ── IT CANNOT SEE FUNDING, AND THAT IS THE POINT ────────────────────
   This file imports nothing. `gate_funding_boundary.js` fails the build
   if the tax economic chain reaches tax funding. A fully funded escrow
   is not a paid tax; only City payment evidence is.

   ── THE HEADLINE CANNOT OUTRUN THE EVIDENCE ─────────────────────────
   If applicability for any required Philadelphia tax is NOT ESTABLISHED,
   the overall position is NOT ESTABLISHED — never CURRENT. Not knowing
   whether a tax applies is not the same as it being fine, and this is
   the one place that distinction is easy to lose.

   CLASS 1 — permanent product primitive.
   ════════════════════════════════════════════════════════════════════ */
"use strict";

//  ⚠ NO require() HERE, EVER. The boundary gate asserts this file imports
//  nothing, so it cannot reach funding by any path. The jurisdiction rules
//  are passed in by the caller instead.

const p2 = (n) => String(n).padStart(2, "0");

function isoDay(d) {
  if (!d) return null;
  if (typeof d === "string") return d.slice(0, 10);
  if (!(d instanceof Date)) return null;
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
}
function dayDiff(a, b) {
  const A = /^(\d{4})-(\d{2})-(\d{2})$/.exec(a), B = /^(\d{4})-(\d{2})-(\d{2})$/.exec(b);
  if (!A || !B) return null;
  return Math.round((Date.UTC(+B[1], +B[2] - 1, +B[3]) - Date.UTC(+A[1], +A[2] - 1, +A[3]))
    / 86400000);
}

/*  ── READ THE TAX POSITION ──────────────────────────────────────────
 *  `rules` is the jurisdiction policy module, injected. Philadelphia is
 *  the first jurisdiction, not the only shape — another one implements
 *  the same interface and this read does not change.
 */
async function readTaxPosition(client, { property_id, as_of = null, rules } = {}) {
  if (!rules) throw new Error("readTaxPosition requires a jurisdiction rules module");
  const today = as_of || isoDay(new Date());

  //  Entities related to this property. BIRT/NPT applicability and
  //  obligations belong to them, and surface here.
  const entities = (await client.query(
    `select distinct e.id, e.legal_name
       from legal_entity_properties r
       join legal_entities e on e.id = r.legal_entity_id
      where r.property_id = $1
        and r.effective_from <= $2
        and (r.effective_to is null or r.effective_to > $2)`,
    [property_id, today])).rows;
  const entityIds = entities.map((e) => e.id);

  //  Live applicability determinations for this property and its entities.
  const appl = (await client.query(
    `select a.* from tax_obligation_applicability a
      where (a.subject_property_id = $1
             or a.subject_legal_entity_id = any($2::uuid[]))
        and a.effective_from <= $3
        and (a.effective_to is null or a.effective_to > $3)
        and not exists (select 1 from tax_obligation_applicability s
                         where s.supersedes_id = a.id)`,
    [property_id, entityIds, today])).rows;

  //  Every obligation touching this property — its own, plus the entity
  //  obligations related to it. DISTINCT on the obligation, so one entity
  //  obligation related to two properties is still one row here.
  const obligations = (await client.query(
    `select distinct o.*
       from tax_obligations o
       left join tax_obligation_properties op on op.obligation_id = o.id
      where o.liable_property_id = $1
         or op.property_id = $1
         or o.liable_legal_entity_id = any($2::uuid[])`,
    [property_id, entityIds])).rows;

  const oblIds = obligations.map((o) => o.id);
  const liabilities = oblIds.length ? (await client.query(
    `select l.* from tax_liabilities l
      where l.obligation_id = any($1::uuid[])
        and not exists (select 1 from tax_liabilities s where s.supersedes_id = l.id)`,
    [oblIds])).rows : [];
  const filings = oblIds.length ? (await client.query(
    `select * from tax_filings where obligation_id = any($1::uuid[])`, [oblIds])).rows : [];
  const payments = oblIds.length ? (await client.query(
    `select * from tax_payments where obligation_id = any($1::uuid[])`, [oblIds])).rows : [];
  const appeals = oblIds.length ? (await client.query(
    `select * from tax_appeals where obligation_id = any($1::uuid[]) and closed_on is null`,
    [oblIds])).rows : [];

  const clearances = (await client.query(
    `select * from tax_clearances
      where (subject_property_id = $1 or subject_legal_entity_id = any($2::uuid[]))
      order by verified_through desc limit 1`,
    [property_id, entityIds])).rows[0] || null;

  //  ── PER TAX TYPE ─────────────────────────────────────────────────
  const rows = rules.requiredTaxTypes().map((taxType) => {
    const kind = rules.SUBJECT_KIND[taxType];
    const determination = appl.find((a) => a.tax_type === taxType) || null;

    const base = {
      tax_type: taxType,
      label: rules.TAX_LABEL[taxType],
      subject_kind: kind,
      cadence: rules.CADENCE[taxType],
      applicability: determination ? determination.determination : "not_established",
      applicability_basis: determination ? determination.basis : null,
      obligation_id: null, period_label: null,
      annual_liability_cents: null, monthly_accrual_cents: null,
      currency_code: null, city_balance_cents: null,
      next_due: null, next_due_label: null,
      appeal_open: false, evidence_count: 0,
      state: "not_established", detail: null, why_not_current: null,
    };

    //  ⚠ ABSENCE IS NOT AN ANSWER. No determination means Spine has not
    //  been told whether this tax applies, and that is what the row says.
    if (!determination) {
      base.why_not_current = "Applicability has not been confirmed.";
      base.detail = "Applicability not confirmed";
      return base;
    }
    if (determination.determination === "not_applicable") {
      base.state = "not_applicable";
      base.detail = determination.basis;
      return base;
    }

    //  APPLIES. Which period should be established by now?
    const period = requiredPeriod(taxType, today, rules);
    base.period_label = period ? period.label : null;

    const mine = obligations.filter((o) => o.tax_type === taxType);
    const obl = period
      ? mine.find((o) => isoDay(o.period_start) === period.period_start) || null
      : (mine.sort((a, b) => (isoDay(a.period_start) < isoDay(b.period_start) ? 1 : -1))[0] || null);

    if (!obl) {
      base.state = "action_required";
      base.why_not_current = period
        ? `The ${period.label} ${rules.TAX_LABEL[taxType]} obligation is not established.`
        : `No ${rules.TAX_LABEL[taxType]} obligation is established.`;
      base.detail = period ? `${period.label} not established` : "Not established";
      return base;
    }

    base.obligation_id = obl.id;
    base.period_label = period ? period.label : isoDay(obl.period_start);
    base.appeal_open = appeals.some((a) => a.obligation_id === obl.id);

    const liab = liabilities.find((l) => l.obligation_id === obl.id) || null;
    if (liab) {
      base.annual_liability_cents = Number(liab.annual_liability_cents);
      base.currency_code = liab.currency_code;
      base.city_balance_cents = liab.city_balance_cents === null
        ? null : Number(liab.city_balance_cents);
      //  ── THE ACCRUAL ──────────────────────────────────────────────
      //  The GOVERNED liability spread over the period it covers.
      //  Nothing about escrow, contributions or cash timing enters here,
      //  and nothing in this file can see them.
      const months = monthsInPeriod(isoDay(obl.period_start), isoDay(obl.period_end));
      base.monthly_accrual_cents = months > 0
        ? Math.round(Number(liab.annual_liability_cents) / months) : null;
    }

    const oblFilings = filings.filter((f) => f.obligation_id === obl.id);
    const oblPayments = payments.filter((p) => p.obligation_id === obl.id);
    base.evidence_count = oblFilings.length + oblPayments.length + (liab ? 1 : 0);

    const milestones = rules.milestonesFor(taxType, isoDay(obl.period_start));

    //  ── SATISFACTION, PER MILESTONE ──────────────────────────────────
    //  A filing is satisfied by a return. A PAYMENT is satisfied by
    //  evidence the City was paid, or by a City balance of zero observed
    //  after the due date. An escrow cannot satisfy either.
    const satisfied = (m) => {
      if (m.kind === "filing") {
        return oblFilings.some((f) => ["return", "amended_return"].includes(f.filing_kind));
      }
      if (oblPayments.length) return true;
      return liab && liab.city_balance_cents !== null
        && Number(liab.city_balance_cents) === 0
        && liab.balance_as_of && dayDiff(m.due, isoDay(liab.balance_as_of)) >= 0;
    };

    const overdue = milestones.filter((m) => dayDiff(m.due, today) > 0 && !satisfied(m));
    const upcoming = milestones.filter((m) => dayDiff(today, m.due) >= 0);
    const next = rules.nextMilestone(upcoming.filter((m) => !satisfied(m)), today);
    if (next) { base.next_due = next.due; base.next_due_label = next.label; }

    if (overdue.length) {
      const worst = overdue[0];
      base.state = "overdue";
      base.why_not_current = worst.kind === "filing"
        ? `${base.period_label} return not filed — was due ${worst.due}.`
        : `City balance outstanding after the ${worst.due} due date.`;
      base.detail = worst.kind === "filing" ? "Return not filed" : "Payment outstanding";
      return base;
    }

    //  Nothing overdue. Say what HAS been achieved rather than a flat
    //  "current" — an operator reading PAID learns more than one reading
    //  CURRENT, and FILED-with-payment-outstanding must never read as
    //  simply current.
    const paymentMilestones = milestones.filter((m) => m.kind === "payment");
    const filingMilestones = milestones.filter((m) => m.kind === "filing");
    const allPaid = paymentMilestones.length > 0 && paymentMilestones.every(satisfied);
    const allFiled = filingMilestones.length > 0 && filingMilestones.every(satisfied);

    if (allPaid && (filingMilestones.length === 0 || allFiled)) {
      base.state = "paid";
      base.detail = "Paid";
    } else if (allFiled && !allPaid) {
      //  FILED, AND THE BALANCE IS NOT YET DUE. Distinct from overdue and
      //  distinct from paid, and the detail says which is outstanding.
      base.state = "filed";
      base.detail = "Payment outstanding";
      base.why_not_current = "The return is filed; the balance is not yet evidenced as paid.";
    } else {
      base.state = "current";
      base.detail = next ? `Next ${next.label.toLowerCase()}` : "Current";
    }
    return base;
  });

  //  ── THE HEADLINE ─────────────────────────────────────────────────
  //  It may never outrun the evidence. An unconfirmed applicability is
  //  not a tidy blank on one row — it is the reason the whole position
  //  cannot claim to be current.
  const unestablished = rows.filter((r) => r.applicability === "not_established");
  const overdueRows = rows.filter((r) => r.state === "overdue");
  const actionRows = rows.filter((r) => ["action_required", "filed"].includes(r.state));

  let overall, overallWhy;
  if (unestablished.length) {
    overall = "not_established";
    overallWhy = `Applicability is not confirmed for ${unestablished.map((r) => r.label).join(", ")}.`;
  } else if (overdueRows.length) {
    overall = "overdue";
    overallWhy = overdueRows.map((r) => `${r.label} — ${r.why_not_current}`).join(" ");
  } else if (actionRows.length) {
    overall = "action_required";
    overallWhy = actionRows.map((r) => `${r.label} — ${r.why_not_current}`).join(" ");
  } else {
    overall = "current";
    overallWhy = null;
  }

  const nextAcross = rules.nextMilestone(
    rows.filter((r) => r.next_due).map((r) => ({ due: r.next_due, label: r.label })), today);

  //  ── CLEARANCE: EVIDENCE, AND A CONFLICT WHEN IT DISAGREES ────────
  //  A certificate saying the City is satisfied while an obligation reads
  //  overdue is a real disagreement between two pieces of evidence.
  //  Surfacing it is the honest move; silently preferring either one is
  //  how a stale certificate comes to paper over an unpaid bill.
  let clearance = null;
  if (clearances) {
    const stillValid = dayDiff(today, isoDay(clearances.verified_through)) >= 0;
    clearance = {
      verified_through: isoDay(clearances.verified_through),
      issued_on: isoDay(clearances.issued_on),
      certificate_reference: clearances.certificate_reference,
      still_valid: stillValid,
      conflicts_with: stillValid && overdueRows.length
        ? overdueRows.map((r) => r.label) : [],
    };
  }

  return {
    as_of: today,
    jurisdiction: rules.JURISDICTION,
    overall,
    overall_why: overallWhy,
    obligation_count: rows.filter((r) => r.applicability === "applies").length,
    next_due: nextAcross ? nextAcross.due : null,
    next_due_label: nextAcross ? nextAcross.label : null,
    rows,
    entities: entities.map((e) => ({ legal_entity_id: e.id, legal_name: e.legal_name })),
    clearance,
    //  Stated so a surface never has to remember it. The tax remains
    //  active and monthly; only the annual exemption ended.
    uo_exemption: rules.uoExemptionStatus(today),
  };
}

/*  Which period ought to be established by now.
 *  Annual: the most recent tax year whose first milestone has arrived.
 *  Monthly: the most recent month whose filing is already due.
 */
function requiredPeriod(taxType, today, rules) {
  const T = /^(\d{4})-(\d{2})-(\d{2})$/.exec(today);
  if (!T) return null;
  const y = +T[1], m = +T[2];

  if (rules.CADENCE[taxType] === "monthly") {
    //  U&O for month M is due the 25th of M+1, so the period that should
    //  be established today is the previous month once we are past it.
    let py = y, pm = m - 1;
    if (pm === 0) { pm = 12; py = y - 1; }
    return rules.periodFor(taxType, { year: py, month: pm });
  }
  //  Annual. Real estate is due within its own year; BIRT/NPT are filed
  //  the following April, so the year that should be established is the
  //  current one for real_estate and the prior one for the return taxes.
  const year = taxType === "real_estate" ? y : y - 1;
  return rules.periodFor(taxType, { year });
}

function monthsInPeriod(startISO, endISO) {
  const A = /^(\d{4})-(\d{2})-(\d{2})$/.exec(startISO);
  const B = /^(\d{4})-(\d{2})-(\d{2})$/.exec(endISO);
  if (!A || !B) return 0;
  return (+B[1] - +A[1]) * 12 + (+B[2] - +A[2]);
}

module.exports = { readTaxPosition, isoDay, monthsInPeriod, requiredPeriod };
