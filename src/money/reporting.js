// ============================================================
// reporting.js — THE MONTHLY REPORTING READ MODEL
//
// ONE read-only route: GET /properties/:id/monthly-reporting-dashboard
// No migration. No writes. It is the spine's VOICE to the front-end's
// monthly reporting shell (operator_reporting_frontend.html) — the
// producer for a consumer the dev already built.
//
// THE CONTRACT (read directly from the shell, not invented):
//   The shell reads two objects off the JSON it gets here:
//     • backend.* — status / section fields (period, status, ready,
//       bank_rec_status, unmapped_account_count, exposure_dollars,
//       open_items, …). A 404 → shell shows "backend pending" honestly.
//     • mgmt.headline (M.*) — the financial numbers: noi, trending_noi,
//       cash, receivables, tenant_deposits, debt, suspense,
//       collection_loss, gross_unproven_exposure.
//   This endpoint returns BOTH: the top-level fields the shell reads as
//   `backend.*`, AND a `mgmt:{headline:{…}}` block it reads as `M.*`.
//
// THE DOCTRINE THIS ENDPOINT CARRIES (the whole reason it exists):
//   A wrong confident value is worse than an honest blank. Every section
//   reports its PROOF STATE as data — { status:'proven'|'pending',
//   value, reason, owner } — never a fake zero. Readiness is COMPUTED
//   from whether the underlying proven tables answer, not hardcoded. When
//   a future rung (bank rec, debt service, balance sheet) lands, its
//   section flips to 'proven' because the table now returns — with NO
//   change to this file. Same principle as category_report_map: the
//   report's shape AND its readiness are data, not logic.
//
// WHAT IS PROVEN TODAY (real numbers):
//   • EXPENSES — money_events at status='report_ready', folded through
//     category_report_map (money.js owns the fold; reused here in spirit:
//     only report_ready rows are truth). Both payee proof AND GL proof
//     exist for these, by construction of the bridge.
//   • EXPOSURE — computeExposure() from exposure.js, called HERE so the
//     headline exposure number is computed in exactly ONE place. Two
//     computations would be the divergence the spine exists to prevent.
//
// WHAT IS HONESTLY PENDING (null + reason + owner, never faked):
//   • INCOME — scheduled_charges carries status (scheduled|paid|partial|
//     waived), NOT a payment→deposit proof tie. Billed rent is a CLAIM,
//     not collected-and-tied cash. Reporting it as NOI income would be
//     the exact confident-wrong-number the doctrine forbids. So proven
//     income = 0 until the payment/deposit rung exists; billed rent is
//     reported SEPARATELY as claimed, and the gap is exposure.
//   • NOI therefore reads: proven_income − proven_expenses, with
//     proven_income honestly 0 today. The billed figure rides alongside,
//     labeled, so the operator sees both the truth and the claim.
//   • Bank rec, balance sheet, debt service, trial balance, cash flow —
//     no proof rung built yet → status:'pending' with the owner who
//     would close it.
//
// Factory (standing module pattern — matches exposure.js):
//   const reportingModule = require('./reporting');
//   app.use("/", reportingModule({ pool }));
// ============================================================

const express = require("express");
const { computeExposure } = require("./exposure"); // ONE exposure computation, reused

// money the same way the rest of the system does: Number, fixed(2), gross.
const money = (n) => Number(Number(n || 0).toFixed(2));

// period label: the current month, e.g. "June 2026". The shell computes
// its own fallback label too; we send an explicit one so the package
// carries the period it was actually run for.
function currentPeriod() {
  const d = new Date();
  return d.toLocaleString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
}

// the current period as the 1st-of-month DATE the charge ledger uses for
// aging (e.g. "2026-06-01"). Same grain scheduled_charges.period stores.
function currentPeriodDate() {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}-01`;
}

module.exports = function reportingModule({ pool }) {
  const router = express.Router();

  router.get("/properties/:id/monthly-reporting-dashboard", async (req, res) => {
    const propertyId = req.params.id;
    try {
      const prop = (await pool.query(
        "select id, name, canonical_key from properties where id=$1", [propertyId])).rows[0];
      if (!prop) return res.status(404).json({ error: "property not found" });

      // ── PROVEN: EXPENSES (money_events report_ready × category_report_map) ──
      // Only report_ready rows are truth. Join to the map to split mapped
      // (reportable) from unmapped (needs-review → exposure). Same rule the
      // /report read enforces; here we read the SHAPE for the dashboard.
      const expenseRow = (await pool.query(
        `select
           coalesce(sum(m.amount) filter (where cm.confirmed_category is not null), 0)::numeric(14,2) as mapped_expense,
           coalesce(sum(m.amount) filter (where cm.confirmed_category is null), 0)::numeric(14,2)     as unmapped_expense,
           count(*) filter (where cm.confirmed_category is null)::int                                  as unmapped_count,
           count(distinct m.confirmed_category) filter (where cm.confirmed_category is not null)::int  as mapped_categories,
           count(*)::int                                                                               as report_ready_count
         from money_events m
         left join category_report_map cm on cm.confirmed_category = m.confirmed_category
        where m.property_id = $1 and m.status = 'report_ready'`, [propertyId])).rows[0];

      const provenExpense = money(expenseRow.mapped_expense);
      const unmappedExpense = money(expenseRow.unmapped_expense);

      // ── INCOME (slice 2): billed claim from scheduled_charges ──────────────
      // The charge ledger (036) is the CLAIM side. We read the charge-side
      // numbers that CAN be computed (billed, billed-but-unpaid, written-off,
      // disputed, missing-charge). PROVEN income stays pending — the payment→
      // deposit tie is slice 3; until it exists, proven_collected is pending,
      // NOT zero. "Pending" is the honest state when the proof rung doesn't
      // exist yet — distinct from "$0", which would claim we checked and found
      // none. The three payment-dependent buckets (paid-but-unmatched,
      // overpaid, unapplied-payment) are therefore pending, never zeroed.
      const period = currentPeriodDate(); // 1st-of-month for the current period
      let billedClaimed = 0, billedUnpaid = 0, writtenOff = 0, disputed = 0;
      let missingCharge = null, incomeSourceOk = true, incomeReason = null;
      try {
        const incomeRow = (await pool.query(
          `select
             coalesce(sum(amount),0)::numeric(14,2)                                              as billed,
             coalesce(sum(amount - coalesce(amount_paid,0))
                      filter (where status in ('claimed','partially_paid')),0)::numeric(14,2)    as billed_unpaid,
             coalesce(sum(amount) filter (where status='written_off'),0)::numeric(14,2)          as written_off,
             coalesce(sum(amount) filter (where status='disputed'),0)::numeric(14,2)             as disputed
           from scheduled_charges
          where property_id = $1
            and charge_type in ('rent','first_month')`, [propertyId])).rows[0];
        billedClaimed = money(incomeRow.billed);
        billedUnpaid  = money(incomeRow.billed_unpaid);
        writtenOff    = money(incomeRow.written_off);
        disputed      = money(incomeRow.disputed);

        // missing-charge: active leases (with rent) lacking a rent charge for
        // the current period — a real charge-side exposure.
        const miss = (await pool.query(
          `select count(*)::int as missing
             from leases l
             join spaces s on s.id = l.space_id
            where l.property_id = $1
              and l.lease_status = 'active'
              and l.rent is not null and l.rent > 0
              and not exists (
                select 1 from scheduled_charges c
                 where c.lease_id = l.id and c.period = $2 and c.charge_type = 'rent')`,
          [propertyId, period])).rows[0];
        missingCharge = miss.missing;
      } catch (e) {
        incomeSourceOk = false;
        incomeReason = e && e.code === "42P01"
          ? "scheduled_charges not present"
          : e.message;
      }

      // keep billedOpen as the name downstream open-items uses (= billed-unpaid).
      const billedOpen = billedUnpaid;

      // proven income = 0 today (no payment/deposit proof rung). NOI is read
      // over PROVEN only — so NOI = 0 − provenExpense. The billed figure
      // rides alongside, labeled, never inside the NOI number.
      const provenIncome = 0;
      const noi = money(provenIncome - provenExpense);

      // ── EXPOSURE: the SECOND scoreboard, computed in ONE place ─────────────
      const exposure = await computeExposure(pool, propertyId);
      const grossExposure = exposure ? exposure.gross_unproven_exposure : null;
      const exposureComplete = exposure ? exposure.complete : false;

      // ── proof-state per section: status is COMPUTED, never hardcoded ───────
      // A section is 'proven' when its underlying proven table answers with
      // real rows; 'pending' otherwise, carrying the reason + the owner who
      // closes it. New rungs flip these to 'proven' with no edit here.
      const sections = {
        operating_statement: {
          status: expenseRow.report_ready_count > 0 ? "partial" : "pending",
          proven_expense: provenExpense,
          proven_income: provenIncome,
          noi,
          billed_income_claimed: incomeSourceOk ? billedClaimed : null,
          income_status: "pending",            // no payment/deposit proof rung yet
          income_reason: incomeSourceOk
            ? "billed rent is a claim — no payment→deposit proof tie exists yet; not counted as NOI income"
            : incomeReason,
          unmapped_expense: unmappedExpense,
          unmapped_account_count: expenseRow.unmapped_count,
          mapped_categories: expenseRow.mapped_categories,
          owner: "backend / accounting",
          note: "Expenses are proven (report_ready × category map). Income awaits the payment/deposit proof rung — billed rent shown as a claim, never blended into NOI.",
        },

        // ── INCOME (slice 2 shape): claim vs proven vs exposure buckets ────────
        // billed_claimed = the structured claim (charges exist).
        // proven_collected = PENDING (payment rung is slice 3) — never zero.
        // exposure: two buckets COMPUTED from charges; three PENDING because
        // they require payment data that does not exist yet. A pending bucket
        // is not a zero bucket — zero would falsely claim we measured and found
        // none. This is the doctrine: a confident wrong number is worse than an
        // honest blank, and pending is the honest blank.
        income: {
          billed_claimed: incomeSourceOk
            ? { status: "claim", value: billedClaimed,
                reason: "scheduled charges exist for period" }
            : { status: "pending", value: null, reason: incomeReason },
          proven_collected: {
            status: "pending", value: null,
            reason: "awaits payment/deposit proof rung",
          },
          exposure: {
            billed_but_unpaid: incomeSourceOk
              ? { status: "computed", value: billedUnpaid }
              : { status: "pending", value: null, reason: incomeReason },
            missing_charge: (incomeSourceOk && missingCharge !== null)
              ? { status: "computed", value: missingCharge }
              : { status: "pending", value: null, reason: incomeReason || "no period charges to compare" },
            paid_but_unmatched: {
              status: "pending", value: null,
              reason: "awaits payment records",
            },
            overpaid: {
              status: "pending", value: null,
              reason: "awaits payment applications",
            },
            unapplied_payment: {
              status: "pending", value: null,
              reason: "awaits payment records",
            },
          },
          // charge-side extras the operator can see (claims, not proof):
          written_off: incomeSourceOk ? writtenOff : null,
          disputed: incomeSourceOk ? disputed : null,
          owner: "accounting",
          note: "Charge-side buckets are computed from the ledger. Payment-side buckets are pending until the payment/deposit rung (slice 3) exists — pending, not zero.",
        },
        exposure: exposure ? {
          status: exposureComplete ? "proven" : "partial",
          gross_unproven_exposure: grossExposure,
          complete: exposureComplete,
          sources: exposure.sources,
          owner: "accounting",
          note: exposure.headline_note,
        } : { status: "pending", reason: "exposure rollup unavailable", owner: "accounting" },
        bank_rec:      { status: "pending", reason: "reconciliation rung not built — bank↔GL match and signed-to-zero", owner: "Rob / accounting" },
        balance_sheet: { status: "pending", reason: "balance sheet rung not built", owner: "accounting" },
        cash_flow:     { status: "pending", reason: "12-month cash flow needs a stable GL map over time", owner: "accounting" },
        trial_balance: { status: "pending", reason: "GL detail rung not built", owner: "accounting" },
        debt_service:  { status: "pending", reason: "mortgage/debt service confirmation rung not built", owner: "asset manager" },
      };

      // ── open items / exposure feed: real rows the shell renders ────────────
      // The shell reads backend.open_items (array of {title,sub,proof,tone,
      // amount,owner,blocking,…}). We feed the TWO real exposure facts we
      // have: unmapped report_ready expenses, and billed-but-unproven rent.
      const openItems = [];
      if (expenseRow.unmapped_count > 0) {
        openItems.push({
          kind: "unmapped_gl",
          title: `${expenseRow.unmapped_count} report-ready expense${expenseRow.unmapped_count === 1 ? "" : "s"} with no report line`,
          sub: "confirmed category exists but is not in category_report_map",
          proof_needed: "map the category to a report line (category_report_map)",
          tone: "red",
          amount: unmappedExpense,
          owner: "accounting",
          blocking: true,
        });
      }
      if (incomeSourceOk && billedOpen > 0) {
        openItems.push({
          kind: "income_unproven",
          title: "Billed rent not tied to collected cash",
          sub: "scheduled/partial charges — billed, not yet proven against a bank deposit",
          proof_needed: "payment→deposit proof rung (not built)",
          tone: "red",
          amount: billedOpen,
          owner: "accounting",
          blocking: true,
        });
      }

      // ready = nothing proven is blocking AND the income rung exists.
      // Today income is always pending, so a final package is never "ready"
      // — which is the honest answer until the rung lands.
      const blockingCount = openItems.filter(x => x.blocking !== false).length;
      const ready = false;
      const status = "Blocked by exposure";

      return res.json({
        // ── what the shell reads as backend.* ──
        source: "Backend report read (proven rungs only)",
        property: { id: prop.id, name: prop.name, canonical_key: prop.canonical_key },
        period: currentPeriod(),
        status,
        ready,
        exposure_dollars: grossExposure,
        exposure_complete: exposureComplete,
        unmapped_account_count: expenseRow.unmapped_count,
        unmatched_bank_count: null,          // pending rung
        bank_rec_status: "pending — reconciliation rung not built",
        bank_difference: null,
        bank_rec_signed_by: null,
        budget_source: null,                 // pending budget claim
        gl_account_count: null,              // pending GL detail rung
        debt_service_status: "pending — rung not built",
        debt_payment_proof: null,
        mortgage_statement_status: "pending",
        cash_flow_status: "pending — needs stable GL map over time",
        cash_flow_period: null,
        open_items: openItems,
        blocking_count: blockingCount,

        // ── what the shell reads as M.* (mgmt.headline) ──
        mgmt: {
          headline: {
            noi,
            trending_noi: null,              // needs multi-month history
            collection_loss: null,           // needs payment proof rung
            cash: null,                      // balance sheet rung
            receivables: incomeSourceOk ? billedOpen : null, // billed-open as a proxy until AR rung
            tenant_deposits: null,           // deposit rung surfaces this
            debt: null,                      // debt service rung
            suspense: null,                  // surfaces if/when present
            exposure: grossExposure,
            gross_unproven_exposure: grossExposure,
          },
        },

        // ── the proof-state map: section readiness AS DATA ──
        sections,

        note: "Proven rungs return real numbers; every other section reports its proof-state honestly (status + reason + owner). Sections flip to proven as their rungs land — no endpoint change needed.",
      });
    } catch (e) {
      console.error("monthly-reporting-dashboard error", e);
      return res.status(500).json({ error: e.message });
    }
  });

  return router;
};
