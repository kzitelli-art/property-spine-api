// ============================================================
// payments.js — PAYMENT PROOF (the proof side of the income rung)
//
// Slice 3. The charge ledger (036) is the CLAIM. This proves billed rent
// became collected cash, through three SEPARATE layers (migration 037):
//
//   1. payments              — the payment-event claim (someone paid)
//   2. payment_applications  — the tie to charge(s); moves amount_paid
//   3. payment_bank_links    — the cash proof (a real bank deposit)
//
// THE DOCTRINE THIS RUNG ENFORCES:
//   Payment APPLIED to a charge   = collected CLAIM ("someone says paid").
//   Payment TIED to a bank deposit = CASH-PROVEN ("the bank confirms").
//   proven_collected income (for NOI) requires BOTH — UNLESS the payment is a
//   trusted processor settlement carrying its own proof trail.
//   Applying a payment must NOT instantly make NOI real.
//
// GROSS NEVER NET; THE SAME DOLLAR NEVER COUNTED TWICE:
//   • the sum of a payment's applications may never exceed its amount.
//   • amount_paid on a charge is the sum of its confirmed applications, never
//     written by hand. A charge over-covered shows as OVERPAID exposure.
//   • a payment links to a given bank txn at most once.
//
// Every write here is honest about what it proved: applying returns the
// charge's new balance and status; linking flips the payment to cash_proven;
// the income read separates COLLECTED-CLAIMED from CASH-PROVEN.
//
// REUSE, DON'T FORK: the cash side ties to the existing bank_transactions
// table (012) — the same rows the expense bridge uses.
//
// ENDPOINTS:
//   POST /properties/:id/payments                 record a payment (claim)
//   POST /payments/:id/apply                       apply payment → charge(s)
//   POST /payments/:id/link-bank                   tie payment → bank deposit (cash proof)
//   GET  /properties/:id/payments                  list payments + their state
//   GET  /properties/:id/income-proof              the income proof + exposure read
//
// Factory (standing module pattern):
//   const paymentsModule = require('./payments');
//   app.use("/", paymentsModule({ pool }));
// ============================================================

const express = require("express");

const money = (n) => Number(Number(n || 0).toFixed(2));

function normalizePeriod(raw) {
  if (!raw) return null;
  const m = String(raw).trim().match(/^(\d{4})-(\d{2})/);
  if (!m) return null;
  const mm = Number(m[2]);
  if (mm < 1 || mm > 12) return null;
  return `${m[1]}-${m[2]}-01`;
}

const METHODS = ["processor", "manual", "check", "cash", "ach", "import", "bank_match"];
const SOURCES = ["processor", "manual", "import", "check", "cash", "bank_match"];

module.exports = function paymentsModule({ pool }) {
  const router = express.Router();

  // recompute a charge's amount_paid + status from its CONFIRMED applications.
  // This is the ONLY path that writes scheduled_charges.amount_paid — it is
  // always the sum of applications, never a hand-set number. Returns the new
  // {amount, amount_paid, balance, status, overpaid}. Runs inside the caller's
  // transaction (takes the client).
  async function recomputeCharge(client, chargeId) {
    const c = (await client.query(
      `select amount, status from scheduled_charges where id=$1 for update`, [chargeId])).rows[0];
    if (!c) return null;
    const applied = (await client.query(
      `select coalesce(sum(amount_applied),0)::numeric(14,2) as paid
         from payment_applications where scheduled_charge_id=$1`, [chargeId])).rows[0];
    const amount = money(c.amount);
    const paid = money(applied.paid);
    // status: written_off/disputed are human states we DON'T auto-override.
    let status = c.status;
    if (status !== "written_off" && status !== "disputed") {
      if (paid <= 0) status = "claimed";
      else if (paid < amount) status = "partially_paid";
      else status = "paid";           // paid >= amount (overpay still 'paid')
    }
    await client.query(
      `update scheduled_charges set amount_paid=$2, status=$3, updated_at=now() where id=$1`,
      [chargeId, paid, status]);
    return { amount, amount_paid: paid, balance: money(amount - paid), status, overpaid: money(Math.max(0, paid - amount)) };
  }

  // recompute a payment's status from its applications + bank links.
  // claimed → applied/partially_applied (by how much is applied) → cash_proven
  // (when a bank link exists OR processor_settled). Runs in the caller's txn.
  async function recomputePayment(client, paymentId) {
    const p = (await client.query(
      `select amount, processor_settled, status from payments where id=$1 for update`, [paymentId])).rows[0];
    if (!p) return null;
    if (p.status === "void") return { status: "void" };
    const appliedRow = (await client.query(
      `select coalesce(sum(amount_applied),0)::numeric(14,2) as applied
         from payment_applications where payment_id=$1`, [paymentId])).rows[0];
    const linkedRow = (await client.query(
      `select count(*)::int as links from payment_bank_links where payment_id=$1`, [paymentId])).rows[0];
    const amount = money(p.amount);
    const applied = money(appliedRow.applied);
    const hasCashProof = linkedRow.links > 0 || p.processor_settled === true;

    let status;
    if (hasCashProof && applied >= amount) status = "cash_proven";
    else if (applied <= 0) status = "claimed";
    else if (applied < amount) status = "partially_applied";
    else status = "applied";          // fully applied, but no cash proof yet
    await client.query(`update payments set status=$2, updated_at=now() where id=$1`, [paymentId, status]);
    return { amount, applied, has_cash_proof: hasCashProof, status };
  }

  // ── POST /properties/:id/payments — record a payment (a claim) ──────────
  router.post("/properties/:id/payments", async (req, res) => {
    const propertyId = req.params.id;
    try {
      const prop = (await pool.query("select id from properties where id=$1", [propertyId])).rows[0];
      if (!prop) return res.status(404).json({ error: "property not found" });

      const b = req.body || {};
      if (b.amount == null || isNaN(Number(b.amount)) || Number(b.amount) <= 0)
        return res.status(400).json({ receipt: "A positive payment amount is required." });
      if (!b.paid_date) return res.status(400).json({ receipt: "A paid_date is required (when the payer paid)." });

      const method = METHODS.includes(b.method) ? b.method : "manual";
      const source = SOURCES.includes(b.source) ? b.source : (method === "processor" ? "processor" : "manual");
      // a processor payment may carry its own proof trail; honor an explicit flag.
      const processorSettled = b.processor_settled === true;

      const row = (await pool.query(
        `insert into payments
           (property_id, person_id, lease_id, amount, paid_date, method, reference,
            status, processor_settled, source, source_ref)
         values ($1,$2,$3,$4,$5,$6,$7,'claimed',$8,$9,$10)
         returning *`,
        [propertyId, b.person_id || null, b.lease_id || null, money(b.amount), b.paid_date,
         method, b.reference || null, processorSettled, source, b.source_ref || null])).rows[0];

      return res.json({
        receipt: `Payment of ${money(row.amount)} recorded (claim). Apply it to a charge to mark rent collected; tie it to a bank deposit to prove the cash.`,
        payment: {
          id: row.id, amount: money(row.amount), paid_date: row.paid_date,
          method: row.method, status: row.status, processor_settled: row.processor_settled,
        },
      });
    } catch (e) {
      console.error("payments create error", e);
      return res.status(500).json({ error: e.message });
    }
  });

  // ── POST /payments/:id/apply — tie a payment to charge(s) ───────────────
  // body: { applications: [{ scheduled_charge_id, amount_applied }], confirmed_by? }
  // OR the shorthand { scheduled_charge_id, amount_applied, confirmed_by? }.
  // Enforces: total applied (existing + new) must not exceed the payment.
  router.post("/payments/:id/apply", async (req, res) => {
    const client = await pool.connect();
    try {
      const b = req.body || {};
      const apps = Array.isArray(b.applications) ? b.applications
        : (b.scheduled_charge_id ? [{ scheduled_charge_id: b.scheduled_charge_id, amount_applied: b.amount_applied }] : []);
      if (apps.length === 0) return res.status(400).json({ receipt: "Provide at least one application (scheduled_charge_id + amount_applied)." });

      await client.query("begin");
      const pay = (await client.query(`select * from payments where id=$1 for update`, [req.params.id])).rows[0];
      if (!pay) { await client.query("rollback"); return res.status(404).json({ receipt: "Payment not found." }); }
      if (pay.status === "void") { await client.query("rollback"); return res.status(409).json({ receipt: "That payment is void." }); }

      // how much of this payment is ALREADY applied
      const already = money((await client.query(
        `select coalesce(sum(amount_applied),0) as s from payment_applications where payment_id=$1`,
        [pay.id])).rows[0].s);

      let toApply = 0;
      for (const a of apps) {
        const amt = money(a.amount_applied);
        if (!a.scheduled_charge_id || amt <= 0) {
          await client.query("rollback");
          return res.status(400).json({ receipt: "Each application needs a scheduled_charge_id and a positive amount_applied." });
        }
        toApply += amt;
      }

      // GROSS NEVER NET: existing + new applications can't exceed the payment.
      if (money(already + toApply) > money(pay.amount)) {
        await client.query("rollback");
        return res.status(409).json({
          receipt: `Over-application blocked: payment is ${money(pay.amount)}, already applied ${already}, this would add ${money(toApply)}.`,
          payment_amount: money(pay.amount), already_applied: already, attempted_additional: money(toApply),
        });
      }

      const results = [];
      for (const a of apps) {
        const chargeId = a.scheduled_charge_id;
        const amt = money(a.amount_applied);
        // confirm the charge exists and belongs to the same property as the payment
        const ch = (await client.query(
          `select id, property_id from scheduled_charges where id=$1`, [chargeId])).rows[0];
        if (!ch) { await client.query("rollback"); return res.status(404).json({ receipt: `Charge ${chargeId} not found.` }); }
        if (ch.property_id !== pay.property_id) {
          await client.query("rollback");
          return res.status(409).json({ receipt: "Charge and payment are on different properties." });
        }

        // upsert the application (one row per payment+charge; add to it if re-applied)
        await client.query(
          `insert into payment_applications (payment_id, scheduled_charge_id, amount_applied, confirmed_by)
           values ($1,$2,$3,$4)
           on conflict (payment_id, scheduled_charge_id)
           do update set amount_applied = payment_applications.amount_applied + excluded.amount_applied,
                         confirmed_at = now()`,
          [pay.id, chargeId, amt, b.confirmed_by || null]);

        const chargeState = await recomputeCharge(client, chargeId);
        results.push({ scheduled_charge_id: chargeId, applied: amt, charge: chargeState });
      }

      const payState = await recomputePayment(client, pay.id);
      await client.query("commit");

      return res.json({
        receipt: `Applied. ${payState.status === "cash_proven"
          ? "This payment is cash-proven (bank/processor proof exists)."
          : "Collected as a CLAIM — tie this payment to a bank deposit to prove the cash."}`,
        payment_id: pay.id,
        payment_status: payState.status,
        cash_proven: payState.status === "cash_proven",
        applications: results,
      });
    } catch (e) {
      try { await client.query("rollback"); } catch (_) {}
      console.error("payment apply error", e);
      return res.status(500).json({ error: e.message });
    } finally {
      client.release();
    }
  });

  // ── POST /payments/:id/link-bank — tie payment to a bank deposit (cash proof)
  // body: { bank_transaction_id, amount_matched?, confirmed_by? }
  router.post("/payments/:id/link-bank", async (req, res) => {
    const client = await pool.connect();
    try {
      const b = req.body || {};
      if (!b.bank_transaction_id) return res.status(400).json({ receipt: "A bank_transaction_id is required." });

      await client.query("begin");
      const pay = (await client.query(`select * from payments where id=$1 for update`, [req.params.id])).rows[0];
      if (!pay) { await client.query("rollback"); return res.status(404).json({ receipt: "Payment not found." }); }
      if (pay.status === "void") { await client.query("rollback"); return res.status(409).json({ receipt: "That payment is void." }); }

      // the bank txn must exist, be an INFLOW (positive amount), and belong to
      // this property (via its account). A negative/outflow row is money out —
      // it can't prove a rent payment.
      const txn = (await client.query(
        `select t.id, t.amount, t.txn_type, ba.property_id
           from bank_transactions t
           join bank_accounts ba on ba.id = t.bank_account_id
          where t.id=$1`, [b.bank_transaction_id])).rows[0];
      if (!txn) { await client.query("rollback"); return res.status(404).json({ receipt: "Bank transaction not found." }); }
      if (txn.property_id !== pay.property_id) {
        await client.query("rollback");
        return res.status(409).json({ receipt: "That bank transaction is on a different property." });
      }
      if (Number(txn.amount) <= 0) {
        await client.query("rollback");
        return res.status(409).json({ receipt: "That bank transaction is not a deposit (its amount is not positive). Rent cash proof must be an inflow." });
      }

      // A link attributes amount_matched when given, else the whole payment.
      // A deposit cannot prove more cash than it carries, and a link cannot
      // attribute more than the payment it proves.
      const matched = b.amount_matched != null ? money(b.amount_matched) : null;
      if (matched != null && !(matched > 0)) {
        await client.query("rollback");
        return res.status(400).json({ receipt: "amount_matched must be a positive amount when given." });
      }
      if (matched != null && matched > money(pay.amount)) {
        await client.query("rollback");
        return res.status(409).json({ receipt: `amount_matched ${matched.toFixed(2)} exceeds this payment of ${money(pay.amount).toFixed(2)}. A link cannot attribute more than the payment it proves.` });
      }
      const attributing = matched != null ? matched : money(pay.amount);
      const already = money((await client.query(
        `select coalesce(sum(coalesce(l.amount_matched, p.amount)),0) as attributed
           from payment_bank_links l join payments p on p.id = l.payment_id
          where l.bank_transaction_id = $1 and p.status <> 'void'`, [txn.id])).rows[0].attributed);
      if (money(already + attributing) > money(txn.amount)) {
        await client.query("rollback");
        return res.status(409).json({
          receipt: `That deposit of ${money(txn.amount).toFixed(2)} already proves ${already.toFixed(2)} of payments; attributing ${attributing.toFixed(2)} more would exceed it. A deposit cannot prove more cash than it carries — split it with amount_matched or link a different deposit.`,
          deposit_amount: money(txn.amount), already_attributed: already, attributing,
        });
      }

      try {
        await client.query(
          `insert into payment_bank_links (payment_id, bank_transaction_id, amount_matched, confirmed_by)
           values ($1,$2,$3,$4)`,
          [pay.id, txn.id, matched, b.confirmed_by || null]);
      } catch (e) {
        if (e && e.code === "23505") {
          await client.query("rollback");
          return res.status(409).json({ receipt: "This payment is already linked to that bank transaction." });
        }
        throw e;
      }

      const payState = await recomputePayment(client, pay.id);
      await client.query("commit");

      return res.json({
        receipt: payState.status === "cash_proven"
          ? "Cash proven. This payment is tied to a bank deposit and fully applied — it now counts as proven collected income."
          : "Bank deposit linked (cash proof recorded). The payment still needs to be fully applied to charges before it counts as proven income.",
        payment_id: pay.id,
        payment_status: payState.status,
        cash_proven: payState.status === "cash_proven",
      });
    } catch (e) {
      try { await client.query("rollback"); } catch (_) {}
      console.error("payment link-bank error", e);
      return res.status(500).json({ error: e.message });
    } finally {
      client.release();
    }
  });

  // ── GET /properties/:id/payments — list payments + state ────────────────
  router.get("/properties/:id/payments", async (req, res) => {
    const propertyId = req.params.id;
    try {
      const rows = (await pool.query(
        `select p.*, per.name as payer_name,
                coalesce((select sum(amount_applied) from payment_applications a where a.payment_id=p.id),0)::numeric(14,2) as applied,
                (select count(*) from payment_bank_links l where l.payment_id=p.id)::int as bank_links
           from payments p
           left join persons per on per.id = p.person_id
          where p.property_id=$1
          order by p.paid_date desc, p.created_at desc`, [propertyId])).rows;

      return res.json({
        property_id: propertyId,
        count: rows.length,
        payments: rows.map(r => ({
          id: r.id, amount: money(r.amount), applied: money(r.applied),
          unapplied: money(r.amount - r.applied),
          paid_date: r.paid_date, method: r.method, reference: r.reference,
          status: r.status, processor_settled: r.processor_settled,
          cash_proven: r.status === "cash_proven",
          has_bank_link: r.bank_links > 0,
          payer_name: r.payer_name,
        })),
      });
    } catch (e) {
      console.error("payments list error", e);
      return res.status(500).json({ error: e.message });
    }
  });

  // ── GET /properties/:id/income-proof — the income proof + exposure read ─
  // This is the read that makes slice-2's pending buckets REAL. It separates:
  //   billed (claim)  ·  collected-claimed (applied)  ·  cash-proven (NOI income)
  // and computes ALL FIVE exposure buckets now that payment data exists.
  router.get("/properties/:id/income-proof", async (req, res) => {
    const propertyId = req.params.id;
    try {
      const period = req.query.period ? normalizePeriod(req.query.period) : null;
      const periodFilter = period ? "and c.period = $2" : "";
      const args = period ? [propertyId, period] : [propertyId];

      // charge side
      const charge = (await pool.query(
        `select
           coalesce(sum(amount),0)::numeric(14,2)                                                 as billed,
           coalesce(sum(amount - coalesce(amount_paid,0))
                    filter (where status in ('claimed','partially_paid')),0)::numeric(14,2)        as billed_unpaid,
           coalesce(sum(greatest(coalesce(amount_paid,0) - amount, 0)),0)::numeric(14,2)           as overpaid,
           coalesce(sum(amount) filter (where status='written_off'),0)::numeric(14,2)             as written_off,
           coalesce(sum(amount) filter (where status='disputed'),0)::numeric(14,2)                as disputed
         from scheduled_charges c
        where c.property_id=$1 and c.charge_type in ('rent','first_month') ${periodFilter}`,
        args)).rows[0];

      // collected-claimed = sum of confirmed applications onto this property's
      // (rent) charges. cash-proven = applications whose PAYMENT is cash_proven.
      const collected = (await pool.query(
        `select
           coalesce(sum(a.amount_applied),0)::numeric(14,2)                                        as collected_claimed,
           coalesce(sum(a.amount_applied) filter (where p.status='cash_proven'),0)::numeric(14,2)  as cash_proven
         from payment_applications a
         join scheduled_charges c on c.id = a.scheduled_charge_id
         join payments p on p.id = a.payment_id
        where c.property_id=$1 and c.charge_type in ('rent','first_month') ${periodFilter}`,
        args)).rows[0];

      // paid-but-unmatched = payments APPLIED to charges but with NO cash proof
      // (applied/partially_applied, not cash_proven, not processor_settled).
      const unmatched = (await pool.query(
        `select coalesce(sum(amount),0)::numeric(14,2) as paid_but_unmatched
           from payments
          where property_id=$1
            and status in ('applied','partially_applied')
            and processor_settled = false`, [propertyId])).rows[0];

      // unapplied-payment = payments received but not (fully) applied to any
      // charge — money sitting on account.
      const unapplied = (await pool.query(
        `select coalesce(sum(p.amount - coalesce(ap.applied,0)),0)::numeric(14,2) as unapplied
           from payments p
           left join (select payment_id, sum(amount_applied) applied from payment_applications group by payment_id) ap
             on ap.payment_id = p.id
          where p.property_id=$1 and p.status <> 'void'
            and (p.amount - coalesce(ap.applied,0)) > 0`, [propertyId])).rows[0];

      // missing-charge (period only): active leases (with rent), no rent charge.
      let missingCharge = null;
      if (period) {
        missingCharge = (await pool.query(
          `select count(*)::int as missing
             from leases l join spaces s on s.id=l.space_id
            where l.property_id=$1 and l.lease_status='active'
              and l.rent is not null and l.rent>0
              and not exists (select 1 from scheduled_charges c
                               where c.lease_id=l.id and c.period=$2 and c.charge_type='rent')`,
          [propertyId, period])).rows[0].missing;
      }

      const billed = money(charge.billed);
      const collectedClaimed = money(collected.collected_claimed);
      const cashProven = money(collected.cash_proven);

      return res.json({
        property_id: propertyId,
        period: period || "all",
        income: {
          billed_claimed: { status: "claim", value: billed,
            reason: "scheduled charges exist for period" },
          collected_claimed: { status: "computed", value: collectedClaimed,
            reason: "payments applied to charges (claim of collection, not yet cash-proven)" },
          proven_collected: { status: "computed", value: cashProven,
            reason: "applied AND cash-proven (bank deposit or trusted processor settlement)" },
          exposure: {
            billed_but_unpaid:  { status: "computed", value: money(charge.billed_unpaid) },
            missing_charge:     period ? { status: "computed", value: missingCharge }
                                       : { status: "pending", value: null, reason: "no period given" },
            paid_but_unmatched: { status: "computed", value: money(unmatched.paid_but_unmatched) },
            overpaid:           { status: "computed", value: money(charge.overpaid) },
            unapplied_payment:  { status: "computed", value: money(unapplied.unapplied) },
          },
          written_off: money(charge.written_off),
          disputed: money(charge.disputed),
          owner: "accounting",
          note: "billed = claim; collected_claimed = applied (someone says paid); proven_collected = applied AND cash-proven (the NOI income number). All five exposure buckets are now computed.",
        },
      });
    } catch (e) {
      console.error("income-proof error", e);
      return res.status(500).json({ error: e.message });
    }
  });

  return router;
};
