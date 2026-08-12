/* ════════════════════════════════════════════════════════════════════
   tax_position_read.js — ARE OUR TAXES CURRENT?

   ONE canonical property-facing read. It compresses entity-level
   obligations into the property view WITHOUT changing their identity: an
   entity's BIRT return appears on each related property and remains one
   obligation with one id.

   ── A ROW IS A POSITION, NOT A PERIOD ───────────────────────────────
   The first version picked ONE period per tax type and presented it as
   the whole row. The real standing position is several at once:

       2025 BIRT return filed   ·  the 2026 estimate it carries outstanding
       2025 NPT return filed    ·  2026 NPT estimates in progress
       July U&O complete        ·  August U&O due the 25th

   So the row reasons over every ACTIVE REQUIREMENT — the periods the
   jurisdiction says ought to exist now, plus any established period
   still carrying an unsatisfied milestone — and surfaces the real next
   unsatisfied one. A row that could hold only one period could not
   express a true tax position, and would have quietly reported the wrong
   month for the rest of its life.

   ── A PAYMENT SATISFIES THE REQUIREMENT IT NAMES ────────────────────
   And only that one. "any payment exists on this obligation" used to
   satisfy every payment milestone, which meant a $50,000 payment against
   a $122,259.93 bill read as PAID and an NPT first estimate closed out
   the second. Satisfaction is now per requirement, and where the amount
   is governed it is a comparison rather than an existence check.

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
   whether a tax applies is not the same as it being fine, and the same
   rule governs a requirement whose very existence is unknown.

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
function monthsInPeriod(startISO, endISO) {
  const A = /^(\d{4})-(\d{2})-(\d{2})$/.exec(startISO);
  const B = /^(\d{4})-(\d{2})-(\d{2})$/.exec(endISO);
  if (!A || !B) return 0;
  return (+B[1] - +A[1]) * 12 + (+B[2] - +A[2]);
}
const num = (v) => (v === null || v === undefined ? null : Number(v));

//  Worst-first. A row's state is the worst of its periods, because an
//  operator needs to see the problem, not the average.
const STATE_RANK = { overdue: 0, action_required: 1, filed: 2, current: 3, paid: 4 };
const worst = (a, b) => (STATE_RANK[a] <= STATE_RANK[b] ? a : b);

/*  ── IS THIS ONE REQUIREMENT SATISFIED? ─────────────────────────────
 *  A filing is satisfied by a return. A PAYMENT is satisfied by money
 *  allocated TO THAT REQUIREMENT covering what is owed — or by a City
 *  balance of zero observed after the due date, which is the City itself
 *  saying nothing is outstanding.
 *
 *  ⚠ AN ESCROW CANNOT SATISFY EITHER, and cannot be seen from here.
 */
function evaluate(m, { filings, payments, liability }) {
  if (m.kind === "filing") {
    const filed = filings.find((f) => ["return", "amended_return"].includes(f.filing_kind));
    return { satisfied: !!filed, detail: filed ? "Filed" : "Not filed" };
  }

  const allocated = payments.filter((p) => p.satisfies_requirement === m.key);
  const paid = allocated.reduce((a, p) => a + Number(p.amount_cents), 0);

  //  The City saying the balance is zero, after the date it was due, is
  //  evidence from the counterparty and outranks our own arithmetic.
  const cityClear = liability && liability.city_balance_cents !== null
    && Number(liability.city_balance_cents) === 0
    && liability.balance_as_of && dayDiff(m.due, isoDay(liability.balance_as_of)) >= 0;
  if (cityClear) return { satisfied: true, detail: "City balance zero", paid_cents: paid };

  //  ── A GOVERNED AMOUNT MEANS A COMPARISON, NOT AN EXISTENCE CHECK ─
  if (m.amount_basis === "annual_liability" && liability
      && liability.annual_liability_cents !== null) {
    const required = Number(liability.annual_liability_cents);
    if (required > 0 && paid >= required) {
      return { satisfied: true, detail: "Paid", paid_cents: paid, required_cents: required };
    }
    if (paid > 0) {
      //  PART PAID IS NOT PAID. The most dangerous wrong answer this
      //  domain can give, because the money is real and the screen looks
      //  reassuring.
      return { satisfied: false, partial: true, paid_cents: paid, required_cents: required,
               outstanding_cents: Math.max(0, required - paid), detail: "Partly paid" };
    }
    return { satisfied: false, paid_cents: 0, required_cents: required,
             outstanding_cents: required, detail: "Not paid" };
  }

  //  No governed amount — an estimate whose figure the City has not told
  //  us. A payment allocated to it satisfies it, and the read SAYS the
  //  amount was never checked rather than implying it was.
  if (allocated.length) {
    return { satisfied: true, detail: "Paid", paid_cents: paid, amount_unchecked: true };
  }
  return { satisfied: false, paid_cents: 0, detail: "Not paid" };
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

  const appl = (await client.query(
    `select a.* from tax_obligation_applicability a
      where (a.subject_property_id = $1
             or a.subject_legal_entity_id = any($2::uuid[]))
        and a.effective_from <= $3
        and (a.effective_to is null or a.effective_to > $3)
        and not exists (select 1 from tax_obligation_applicability s
                         where s.supersedes_id = a.id)`,
    [property_id, entityIds, today])).rows;

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

  // ── PER TAX TYPE ───────────────────────────────────────────────────
  const rows = rules.requiredTaxTypes().map((taxType) => {
    const kind = rules.SUBJECT_KIND[taxType];
    const determination = appl.find((a) => a.tax_type === taxType) || null;

    const base = {
      tax_type: taxType,
      label: rules.TAX_LABEL[taxType],
      subject_kind: kind,
      cadence: rules.CADENCE[taxType],
      requires_filing: !!rules.REQUIRES_FILING[taxType],
      applicability: determination ? determination.determination : "not_established",
      applicability_basis: determination ? determination.basis : null,
      obligation_id: null, period_label: null, amount_period_label: null,
      annual_liability_cents: null, monthly_accrual_cents: null,
      currency_code: null, city_balance_cents: null,
      next_due: null, next_due_label: null,
      appeal_open: false, evidence_count: 0,
      periods: [], unestablished_requirements: [], unallocated_payments: [],
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

    // ── APPLIES. WHICH PERIODS ARE LIVE RIGHT NOW? ───────────────────
    const mine = obligations.filter((o) => o.tax_type === taxType);
    const byStart = new Map(mine.map((o) => [isoDay(o.period_start), o]));

    const wanted = rules.activePeriods(taxType, today);
    const starts = new Map(wanted.map((p) => [p.period_start, p]));

    //  Plus any period ALREADY ESTABLISHED that still carries an
    //  unsatisfied milestone whose date has passed. A two-year-old unpaid
    //  bill does not stop being a problem because it got old, and the
    //  jurisdiction's "ought to exist now" list cannot know about it.
    for (const o of mine) {
      const start = isoDay(o.period_start);
      if (starts.has(start)) continue;
      const ms = rules.milestonesFor(taxType, start,
        { birt_filer_profile: o.birt_filer_profile });
      const ctx = {
        filings: filings.filter((f) => f.obligation_id === o.id),
        payments: payments.filter((p) => p.obligation_id === o.id),
        liability: liabilities.find((l) => l.obligation_id === o.id) || null,
      };
      const stillOpen = ms.some((m) =>
        dayDiff(m.due, today) > 0 && !evaluate(m, ctx).satisfied);
      if (stillOpen) {
        starts.set(start, { period_start: start, period_end: isoDay(o.period_end),
                            label: periodLabelOf(taxType, start, rules) });
      }
    }

    const ordered = [...starts.values()].sort((a, b) =>
      (a.period_start < b.period_start ? 1 : -1));

    const allMilestones = [];
    let rowState = "paid";
    let sawAny = false;

    for (const p of ordered) {
      const obl = byStart.get(p.period_start) || null;
      //  An OPTIONAL period nobody has established says nothing at all.
      //  It is on the list so an established one can be shown beside the
      //  live period, not so its absence can be reported as a gap.
      if (!obl && p.required === false) continue;
      if (!obl) {
        /*  ── A PERIOD WITH NO OBLIGATION YET ──────────────────────
         *  Not automatically a problem. August's U&O filing is due on
         *  the 25th; on the 12th, not having recorded it is simply not
         *  late. Treating every unestablished current period as ACTION
         *  REQUIRED would have made a healthy property look delinquent
         *  for three weeks of every month.
         *
         *  The milestones are computed from the PERIOD, which needs no
         *  obligation to exist — so the row can still say "Next Aug 25"
         *  for a month nobody has opened yet. That is the whole point of
         *  a standing read: it knows what is coming, not only what has
         *  been written down.
         */
        const ms = rules.milestonesFor(taxType, p.period_start);
        const late = ms.filter((m) => dayDiff(m.due, today) > 0);
        for (const m of ms) allMilestones.push({ ...m, satisfied: false, period_label: p.label });
        const pending = late.length;
        base.periods.push({
          period_label: p.label, obligation_id: null,
          state: pending ? "action_required" : "current",
          detail: pending ? "Not established"
            : (ms[0] ? `Next ${ms[0].label.toLowerCase()}` : "Not yet due"),
          why: pending
            ? `The ${p.label} ${rules.TAX_LABEL[taxType]} obligation is not established.`
            : null,
          requirements: ms.map((m) => ({
            key: m.key, kind: m.kind, label: m.label, due: m.due,
            date_source: m.date_source, satisfied: false,
            detail: "Not established", overdue: dayDiff(m.due, today) > 0,
          })),
        });
        rowState = worst(rowState, pending ? "action_required" : "current");
        continue;
      }
      sawAny = true;

      const ctx = {
        filings: filings.filter((f) => f.obligation_id === obl.id),
        payments: payments.filter((x) => x.obligation_id === obl.id),
        liability: liabilities.find((l) => l.obligation_id === obl.id) || null,
      };
      base.evidence_count += ctx.filings.length + ctx.payments.length + (ctx.liability ? 1 : 0);
      if (appeals.some((a) => a.obligation_id === obl.id)) base.appeal_open = true;

      //  Money that names no requirement satisfies nothing — and is
      //  SURFACED, because unattributed money is a real finding.
      for (const x of ctx.payments) {
        if (!x.satisfies_requirement) {
          base.unallocated_payments.push({
            payment_id: x.id, period_label: p.label,
            amount_cents: num(x.amount_cents), paid_at: isoDay(x.paid_at),
            why: "This payment does not say which requirement it satisfies, so it " +
                 "satisfies none of them.",
          });
        }
      }

      const ms = rules.milestonesFor(taxType, p.period_start,
        { birt_filer_profile: obl.birt_filer_profile });
      const reqs = ms.map((m) => {
        const v = evaluate(m, ctx);
        allMilestones.push({ ...m, ...v, period_label: p.label });
        return {
          key: m.key, kind: m.kind, label: m.label, due: m.due,
          date_source: m.date_source,
          ...(m.installments_electable ? { installments_electable: true } : {}),
          satisfied: v.satisfied, detail: v.detail,
          overdue: dayDiff(m.due, today) > 0 && !v.satisfied,
          ...(v.partial ? { partial: true } : {}),
          ...(v.paid_cents !== undefined ? { paid_cents: v.paid_cents } : {}),
          ...(v.required_cents !== undefined ? { required_cents: v.required_cents } : {}),
          ...(v.outstanding_cents !== undefined
              ? { outstanding_cents: v.outstanding_cents } : {}),
          ...(v.amount_unchecked ? { amount_unchecked: true } : {}),
        };
      });

      //  Requirements whose EXISTENCE is unknown — BIRT's mandatory
      //  estimate before a filer profile is established. Not knowing is
      //  not the same as absent.
      for (const u of rules.unknownRequirements(taxType,
        { birt_filer_profile: obl.birt_filer_profile })) {
        base.unestablished_requirements.push({ ...u, period_label: p.label,
                                               obligation_id: obl.id });
      }

      const late = reqs.filter((r) => r.overdue);
      const filingReqs = reqs.filter((r) => r.kind === "filing");
      const paymentReqs = reqs.filter((r) => r.kind === "payment");
      const allFiled = filingReqs.length > 0 && filingReqs.every((r) => r.satisfied);
      const allPaid = paymentReqs.length > 0 && paymentReqs.every((r) => r.satisfied);

      let pState, pDetail, pWhy = null;
      if (late.length) {
        const w = late[0];
        pState = "overdue";
        pDetail = w.partial ? "Partly paid"
          : (w.kind === "filing" ? "Return not filed" : "Payment outstanding");
        /*  ── EVERY LATE REQUIREMENT, NOT JUST THE FIRST ────────────
         *  An NPT year can be late on two estimates, an unfiled return
         *  AND its balance at once. Reporting only the earliest one
         *  would tell an operator to chase a 2025 estimate while the
         *  2025 return sits unfiled — true, and radically incomplete.
         */
        pWhy = `${p.label} — ` + late.map((r) => lateClause(r, ctx.liability)).join(" · ");
      } else if (allPaid && (filingReqs.length === 0 || allFiled)) {
        pState = "paid"; pDetail = "Paid";
      } else if (allFiled && !allPaid) {
        pState = "filed"; pDetail = "Payment outstanding";
        pWhy = `${p.label}: the return is filed; the balance is not yet evidenced as paid.`;
      } else {
        pState = "current";
        const nxt = rules.nextMilestone(reqs.filter((r) => !r.satisfied), today);
        pDetail = nxt ? `Next ${nxt.label.toLowerCase()}` : "Current";
      }

      base.periods.push({
        period_label: p.label, obligation_id: obl.id, state: pState, detail: pDetail,
        why: pWhy, requirements: reqs,
      });
      rowState = worst(rowState, pState);
    }

    //  ── THE MONEY BELONGS TO A NAMED PERIOD ────────────────────────
    //  The primary period is the one the jurisdiction says is current —
    //  this tax year for Real Estate, the reporting year for BIRT/NPT,
    //  this month for U&O. The label travels with it so no surface has
    //  to guess which year a figure describes.
    const primary = wanted.find((p) => p.required !== false) || ordered[0] || null;
    const primaryObl = primary ? byStart.get(primary.period_start) : null;
    if (primaryObl) {
      base.obligation_id = primaryObl.id;
      base.period_label = primary.label;
      base.amount_period_label = primary.label;
      const liab = liabilities.find((l) => l.obligation_id === primaryObl.id) || null;
      if (liab) {
        base.annual_liability_cents = Number(liab.annual_liability_cents);
        base.currency_code = liab.currency_code;
        base.city_balance_cents = num(liab.city_balance_cents);
        //  ── THE ACCRUAL ────────────────────────────────────────────
        //  The GOVERNED liability spread over the period it covers.
        //  Nothing about escrow, contributions or cash timing enters
        //  here, and nothing in this file can see them.
        const months = monthsInPeriod(isoDay(primaryObl.period_start),
                                      isoDay(primaryObl.period_end));
        base.monthly_accrual_cents = months > 0
          ? Math.round(Number(liab.annual_liability_cents) / months) : null;
      }
    } else if (primary) {
      base.period_label = primary.label;
    }

    //  ── THE NEXT THING ACTUALLY DUE ────────────────────────────────
    //  Across every active period, not within one. At 2026-08-12 a
    //  correctly established U&O position says 2026-08-25 — which the
    //  one-period model could not reach even in principle.
    const nextUp = rules.nextMilestone(allMilestones.filter((m) => !m.satisfied), today);
    if (nextUp) { base.next_due = nextUp.due; base.next_due_label = nextUp.label; }

    //  Nothing established anywhere. The row still reports whatever the
    //  periods concluded — a current period not yet due reads CURRENT with
    //  its next date, a period already past its date reads ACTION
    //  REQUIRED. What it must never do is invent a settled answer.
    if (!sawAny) {
      base.state = base.periods.length
        ? base.periods.reduce((a, p) => worst(a, p.state), "paid")
        : "action_required";
      const why = base.periods.map((p) => p.why).filter(Boolean);
      base.why_not_current = why.length ? why.join(" ")
        : (base.state === "current" ? null
           : `No ${rules.TAX_LABEL[taxType]} obligation is established.`);
      base.detail = base.periods[0] ? base.periods[0].detail : "Not established";
      return base;
    }

    //  A requirement whose existence is unknown may not be rounded down
    //  to fine — same rule as an unconfirmed applicability, one level in.
    if (base.unestablished_requirements.length
        && ["paid", "current"].includes(rowState)) {
      rowState = "action_required";
    }

    base.state = rowState;
    const bad = base.periods.filter((p) => p.why);
    base.why_not_current = bad.length ? bad.map((p) => p.why).join(" ")
      : (base.unestablished_requirements.length
          ? base.unestablished_requirements.map((u) => u.why).join(" ") : null);
    const worstPeriod = base.periods.find((p) => p.state === rowState);
    base.detail = base.unestablished_requirements.length && rowState === "action_required"
      ? "Requirement not established"
      : (worstPeriod ? worstPeriod.detail : null);
    return base;
  });

  // ── THE HEADLINE ───────────────────────────────────────────────────
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
    //  If the jurisdiction's own derivation ever stops reproducing the
    //  City's published calendar, that is a finding about OUR RULE and it
    //  travels with the read rather than dying in a log line.
    schedule_disagreements: rules.scheduleDisagreements(),
  };
}

/*  ── HOW A LATE REQUIREMENT IS SAID TO A PERSON ─────────────────────
 *  Operator language, not machinery. A missing filing is "not filed"; a
 *  governed amount nobody has paid is a CITY BALANCE, because that is
 *  what the operator will go and look at; a part payment names what is
 *  still outstanding, because that number is the whole point of
 *  distinguishing it from paid.
 */
function lateClause(r, liability) {
  if (r.kind === "filing") return `${r.label.toLowerCase()} not filed, due ${r.due}`;
  if (r.partial) {
    return `${r.label.toLowerCase()} partly paid — ` +
           `${money(r.outstanding_cents, liability)} still outstanding after ${r.due}`;
  }
  if (r.required_cents !== undefined && r.required_cents !== null) {
    return `City balance outstanding after the ${r.due} due date`;
  }
  return `${r.label.toLowerCase()} outstanding after ${r.due}`;
}

//  A period label for a period the rules module did not hand back.
function periodLabelOf(taxType, startISO, rules) {
  const M = /^(\d{4})-(\d{2})-(\d{2})$/.exec(startISO);
  if (!M) return startISO;
  return rules.CADENCE[taxType] === "monthly" ? `${M[1]}-${M[2]}` : M[1];
}

//  Local, tiny, and only for a sentence. The surface formats everything
//  the operator actually reads; this exists so `why_not_current` can name
//  an outstanding amount without the read importing a formatter.
function money(cents, liability) {
  if (cents === null || cents === undefined) return "an unknown amount";
  const cur = liability && liability.currency_code === "USD" ? "$" : "";
  const whole = Math.floor(Math.abs(cents) / 100).toLocaleString("en-US");
  return `${cur}${whole}.${p2(Math.abs(cents) % 100)}`;
}

module.exports = { readTaxPosition, isoDay, monthsInPeriod, evaluate };
