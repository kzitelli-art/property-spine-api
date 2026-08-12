/* ════════════════════════════════════════════════════════════════════
   insurance_funding_read.js — HOW IS THIS PROPERTY'S INSURANCE PAID?

   Reads funding arrangements and their instrument detail. It reports; it
   never totals anything into insurance expense, because nothing here is
   insurance expense.

   ── THE ONE NUMBER THIS FILE IS ALLOWED TO ADD UP ───────────────────
   `total_of_payments_cents` — down payment plus installments — is what
   the property will PAY THE FINANCE COMPANY. It is a financing figure
   and it is named as one. It is deliberately NOT called a cost, a
   premium or an annual figure, and the surface must never place it where
   an insurance cost belongs.

   What insurance COSTS is the allocated premium over the coverage
   period, computed in `insurance_position_read.js`, which cannot see
   this file. The two numbers routinely differ and both are correct.

   ── ABSENCE IS UNKNOWN ──────────────────────────────────────────────
   No arrangement means Spine does not know how this is paid, and the
   read says exactly that. It never reports `direct` as a default: that
   would be a healthy state invented from missing information.

   CLASS 1 — permanent product primitive.
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const METHOD_LABEL = Object.freeze({
  direct: "Paid directly",
  lender_escrow: "Paid from lender escrow",
  premium_financed: "Premium financed",
});

function iso(d) {
  if (!d) return null;
  if (typeof d === "string") return d.slice(0, 10);
  return d instanceof Date ? d.toISOString().slice(0, 10) : null;
}

/*  ── READ FUNDING ───────────────────────────────────────────────────
 *  The arrangement live during the requested period, per coverage this
 *  property is named on. Liveness is the same rule the allocation read
 *  uses: nothing supersedes it, and its range overlaps the period.
 */
async function readFunding(client, { property_id, period }) {
  const [y, m] = String(period || "").split("-").map(Number);
  const start = `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-01`;
  const next = m === 12 ? `${y + 1}-01-01`
    : `${y}-${String(m + 1).padStart(2, "0")}-01`;

  const { rows } = await client.query(
    `select
       a.id as arrangement_id, a.coverage_id, a.funding_method,
       a.effective_from, a.effective_to,
       a.source_artifact_id, a.provenance_note,
       a.supersedes_id, a.revision_reason, a.recorded_at,
       c.coverage_type, c.carrier_name,
       f.finance_provider, f.agreement_reference,
       f.down_payment_cents, f.principal_financed_cents, f.finance_charge_cents,
       f.installment_count, f.installment_cents, f.first_payment_date,
       e.lender_name, e.servicer_name, e.escrow_account_reference
     from insurance_funding_arrangements a
     join insurance_coverages c on c.id = a.coverage_id
     left join premium_finance_agreements f on f.arrangement_id = a.id
     left join insurance_escrow_arrangements e on e.arrangement_id = a.id
    where a.property_id = $1
      and not exists (select 1 from insurance_funding_arrangements s
                       where s.supersedes_id = a.id)
      and a.effective_from < $3
      and (a.effective_to is null or a.effective_to > $2)
    order by c.coverage_type asc, a.effective_from asc`,
    [property_id, start, next]);

  const arrangements = rows.map((r) => {
    const out = {
      arrangement_id: r.arrangement_id,
      coverage_id: r.coverage_id,
      coverage_type: r.coverage_type,
      carrier_name: r.carrier_name,
      funding_method: r.funding_method,
      method_label: METHOD_LABEL[r.funding_method] || r.funding_method,
      effective_from: iso(r.effective_from),
      effective_to: iso(r.effective_to),
      provenance_strength: r.source_artifact_id ? "documentary" : "attested",
      provenance_note: r.provenance_note,
      corrected: !!r.supersedes_id,
      revision_reason: r.revision_reason,
      recorded_at: r.recorded_at,
      finance: null,
      escrow: null,
    };

    if (r.funding_method === "premium_financed" && r.finance_provider) {
      const down = r.down_payment_cents === null ? null : Number(r.down_payment_cents);
      const inst = r.installment_cents === null ? null : Number(r.installment_cents);
      const count = r.installment_count === null ? null : Number(r.installment_count);
      out.finance = {
        finance_provider: r.finance_provider,
        agreement_reference: r.agreement_reference,
        down_payment_cents: down,
        principal_financed_cents: r.principal_financed_cents === null
          ? null : Number(r.principal_financed_cents),
        //  THE COST OF BORROWING. Reported here and nowhere near the
        //  accrual. Adding it to the premium would make insurance look
        //  more expensive because of how it was financed — the exact
        //  defect migration 161 exists to prevent.
        finance_charge_cents: r.finance_charge_cents === null
          ? null : Number(r.finance_charge_cents),
        installment_count: count,
        installment_cents: inst,
        first_payment_date: iso(r.first_payment_date),
        //  WHAT WILL BE PAID TO THE FINANCE COMPANY. A financing figure,
        //  named as one. Unknown when either part is unknown — never a
        //  partial sum presented as a total.
        total_of_payments_cents:
          (down !== null && inst !== null && count !== null) ? down + inst * count : null,
      };
    }

    if (r.funding_method === "lender_escrow") {
      out.escrow = {
        lender_name: r.lender_name || null,
        servicer_name: r.servicer_name || null,
        escrow_account_reference: r.escrow_account_reference || null,
      };
    }
    return out;
  });

  return {
    period,
    //  ESTABLISHED means somebody recorded how this is paid — including
    //  recording that it is paid directly, which is a positive finding.
    established: arrangements.length > 0,
    arrangements,
    methods: Array.from(new Set(arrangements.map((a) => a.funding_method))),
  };
}

module.exports = { readFunding, METHOD_LABEL };
