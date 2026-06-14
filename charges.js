// ============================================================
// charges.js — CHARGE GENERATION (the claim side of the income rung)
//
// Slice 2A. The charge ledger (scheduled_charges, migration 036) is the
// CLAIM side of income proof: a charge = "$X owed on unit U for period P".
// This module POPULATES that ledger. It does not prove anything — proof is
// the payment tie (slice 3). It only states, structurally, what is owed.
//
// DOCTRINE:
//   • charge = claim · payment tie = proof · unpaid/unmatched = exposure.
//   • Every charge carries its ORIGIN (source + source_ref).
//   • Generation is IDEMPOTENT: the 036 unique index
//     (lease_id, period, charge_type) means re-running a month never
//     double-bills. We rely on ON CONFLICT DO NOTHING so a re-run is a safe
//     no-op, and we REPORT how many were created vs already-present.
//   • A charge is born from a lease's OWN rent terms — we never invent an
//     amount. A lease with null rent is skipped and reported, not guessed.
//
// ENTITY GRAPH (verified): leases.space_id → spaces.unit_id → units.
//   Payer = first of leases.tenant_ids[] when present (the lease's primary
//   tenant). Both unit and person resolved at generation; both nullable on
//   the charge so a future import path can still write unit-only rows.
//
// ENDPOINTS:
//   POST /properties/:id/charges/generate   generate rent charges for a period
//       body: { period: "2026-06-01"|"2026-06", charge_type?="rent",
//               only_active?=true }
//       → for every active lease on the property with a rent amount, create
//         one rent charge for that period (idempotent). Returns a receipt:
//         created, skipped_existing, skipped_no_rent, total_leases.
//   POST /properties/:id/charges            add ONE charge by hand (manual)
//       body: { unit_id?, lease_id?, person_id?, charge_type?, period,
//               amount, due_date?, status?, source?="manual", source_ref? }
//   GET  /properties/:id/charges            list charges (optional ?period=)
//   GET  /properties/:id/charges/summary    period totals by status (the
//                                           charge-side numbers the report reads)
//
// Factory (standing module pattern — matches bankintake/reporting):
//   const chargesModule = require('./charges');
//   app.use("/", chargesModule({ pool }));
// ============================================================

const express = require("express");

const money = (n) => Number(Number(n || 0).toFixed(2));

// normalize a period input to the 1st-of-month date string the ledger uses.
// accepts "2026-06", "2026-06-01", or a full ISO date — always returns
// "YYYY-MM-01" (the aging grain), or null if unparseable.
function normalizePeriod(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  const m = s.match(/^(\d{4})-(\d{2})/);
  if (!m) return null;
  const mm = Number(m[2]);
  if (mm < 1 || mm > 12) return null;
  return `${m[1]}-${m[2]}-01`;
}

const CHARGE_TYPES = ["rent", "first_month", "late_fee", "deposit", "utility", "parking", "other"];
const STATUSES = ["claimed", "partially_paid", "paid", "written_off", "disputed"];
const SOURCES = ["lease", "rent_roll", "import", "manual"];

module.exports = function chargesModule({ pool }) {
  const router = express.Router();

  // ── POST /properties/:id/charges/generate — born from active leases ─────
  router.post("/properties/:id/charges/generate", async (req, res) => {
    const propertyId = req.params.id;
    try {
      const prop = (await pool.query("select id, name from properties where id=$1", [propertyId])).rows[0];
      if (!prop) return res.status(404).json({ error: "property not found" });

      const b = req.body || {};
      const period = normalizePeriod(b.period);
      if (!period) return res.status(400).json({ receipt: "A period is required, e.g. \"2026-06\" or \"2026-06-01\"." });

      const chargeType = CHARGE_TYPES.includes(b.charge_type) ? b.charge_type : "rent";
      const onlyActive = b.only_active !== false; // default true

      // pull every (optionally active) lease on this property, resolving its
      // unit via space, and its primary payer from tenant_ids[].
      const leases = (await pool.query(
        `select l.id as lease_id, l.rent, l.lease_status,
                s.unit_id,
                (l.tenant_ids)[1] as primary_person_id
           from leases l
           join spaces s on s.id = l.space_id
          where l.property_id = $1
            ${onlyActive ? "and l.lease_status = 'active'" : ""}`,
        [propertyId])).rows;

      let created = 0, skippedExisting = 0, skippedNoRent = 0;
      const createdIds = [];

      for (const lease of leases) {
        if (lease.rent == null || Number(lease.rent) <= 0) { skippedNoRent++; continue; }

        // idempotent insert: the 036 unique index on (lease_id, period,
        // charge_type) makes a re-run a no-op. ON CONFLICT DO NOTHING +
        // a returning id tells us whether a row was actually created.
        const ins = (await pool.query(
          `insert into scheduled_charges
             (property_id, unit_id, lease_id, person_id, charge_type, period, amount, due_date, status, source, source_ref)
           values ($1,$2,$3,$4,$5,$6,$7,$6,'claimed','lease',$8)
           on conflict (lease_id, period, charge_type) where lease_id is not null
           do nothing
           returning id`,
          [propertyId, lease.unit_id, lease.lease_id, lease.primary_person_id || null,
           chargeType, period, money(lease.rent), `lease:${lease.lease_id} ${period} ${chargeType}`])).rows[0];

        if (ins) { created++; createdIds.push(ins.id); }
        else skippedExisting++;
      }

      return res.json({
        receipt: created > 0
          ? `Generated ${created} ${chargeType} charge${created === 1 ? "" : "s"} for ${period}.`
          : (skippedExisting > 0
              ? `All ${skippedExisting} ${chargeType} charge${skippedExisting === 1 ? "" : "s"} for ${period} already existed — nothing to do.`
              : `No charges generated — no active leases with rent for ${period}.`),
        period,
        charge_type: chargeType,
        created,
        skipped_existing: skippedExisting,     // already billed (idempotent re-run)
        skipped_no_rent: skippedNoRent,        // lease has no rent amount — NOT guessed
        total_leases: leases.length,
        created_ids: createdIds,
      });
    } catch (e) {
      console.error("charges/generate error", e);
      return res.status(500).json({ error: e.message });
    }
  });

  // ── POST /properties/:id/charges — add ONE charge by hand ───────────────
  router.post("/properties/:id/charges", async (req, res) => {
    const propertyId = req.params.id;
    try {
      const prop = (await pool.query("select id from properties where id=$1", [propertyId])).rows[0];
      if (!prop) return res.status(404).json({ error: "property not found" });

      const b = req.body || {};
      const period = normalizePeriod(b.period);
      if (!period) return res.status(400).json({ receipt: "A period is required, e.g. \"2026-06\"." });
      if (b.amount == null || isNaN(Number(b.amount)) || Number(b.amount) < 0)
        return res.status(400).json({ receipt: "A non-negative amount is required." });

      const chargeType = CHARGE_TYPES.includes(b.charge_type) ? b.charge_type : "rent";
      const status = STATUSES.includes(b.status) ? b.status : "claimed";
      const source = SOURCES.includes(b.source) ? b.source : "manual";

      const row = (await pool.query(
        `insert into scheduled_charges
           (property_id, unit_id, lease_id, person_id, charge_type, period, amount, amount_paid, due_date, status, source, source_ref)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         returning *`,
        [propertyId, b.unit_id || null, b.lease_id || null, b.person_id || null,
         chargeType, period, money(b.amount), money(b.amount_paid), b.due_date || null,
         status, source, b.source_ref || null])).rows[0];

      return res.json({ receipt: "Charge added.", charge: row });
    } catch (e) {
      // a lease_id+period+type collision against the unique index is an
      // honest "already billed", not a 500.
      if (e && e.code === "23505")
        return res.status(409).json({ receipt: "A charge for that lease, period, and type already exists." });
      console.error("charges add error", e);
      return res.status(500).json({ error: e.message });
    }
  });

  // ── GET /properties/:id/charges — list (optional ?period=) ──────────────
  router.get("/properties/:id/charges", async (req, res) => {
    const propertyId = req.params.id;
    try {
      const period = req.query.period ? normalizePeriod(req.query.period) : null;
      const rows = (await pool.query(
        `select c.*, u.unit_number, p.name as person_name
           from scheduled_charges c
           left join units u on u.id = c.unit_id
           left join persons p on p.id = c.person_id
          where c.property_id = $1
            ${period ? "and c.period = $2" : ""}
          order by c.period desc, u.unit_number asc nulls last`,
        period ? [propertyId, period] : [propertyId])).rows;

      return res.json({
        property_id: propertyId,
        period: period || "all",
        count: rows.length,
        charges: rows.map(r => ({
          id: r.id, unit_id: r.unit_id, unit_number: r.unit_number,
          lease_id: r.lease_id, person_id: r.person_id, person_name: r.person_name,
          charge_type: r.charge_type, period: r.period,
          amount: money(r.amount), amount_paid: money(r.amount_paid),
          balance: money(r.amount - r.amount_paid),
          due_date: r.due_date, status: r.status,
          source: r.source, source_ref: r.source_ref,
        })),
      });
    } catch (e) {
      console.error("charges list error", e);
      return res.status(500).json({ error: e.message });
    }
  });

  // ── GET /properties/:id/charges/summary — period totals by status ───────
  // This is the charge-side number set the monthly report reads. It computes
  // ONLY what charges can answer (the claim side). Payment-side numbers are
  // NOT computed here — they belong to the payment rung (slice 3).
  router.get("/properties/:id/charges/summary", async (req, res) => {
    const propertyId = req.params.id;
    try {
      const period = req.query.period ? normalizePeriod(req.query.period) : null;

      const row = (await pool.query(
        `select
           count(*)::int                                                                 as charge_count,
           coalesce(sum(amount),0)::numeric(14,2)                                         as billed_total,
           coalesce(sum(amount - coalesce(amount_paid,0))
                    filter (where status in ('claimed','partially_paid')),0)::numeric(14,2) as billed_unpaid,
           coalesce(sum(amount) filter (where status='written_off'),0)::numeric(14,2)     as written_off,
           coalesce(sum(amount) filter (where status='disputed'),0)::numeric(14,2)        as disputed
         from scheduled_charges
        where property_id = $1
          and charge_type in ('rent','first_month')
          ${period ? "and period = $2" : ""}`,
        period ? [propertyId, period] : [propertyId])).rows[0];

      // missing-charge: active leases (with rent) that have NO rent charge for
      // the period. Only meaningful when a period is given.
      let missingCharge = null;
      if (period) {
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
      }

      return res.json({
        property_id: propertyId,
        period: period || "all",
        charge_count: row.charge_count,
        billed_total: money(row.billed_total),
        billed_unpaid: money(row.billed_unpaid),
        written_off: money(row.written_off),
        disputed: money(row.disputed),
        missing_charge: missingCharge,         // null if no period given
      });
    } catch (e) {
      console.error("charges summary error", e);
      return res.status(500).json({ error: e.message });
    }
  });

  return router;
};
