// ============================================================
// charges.js — CHARGE GENERATION (claim side of income proof)
//
// first_month is rent for the initial covered period. It and recurring rent are
// mutually exclusive for one lease+period; the system never double-bills the
// first period after economic tenancy activates.
// ============================================================

"use strict";

const express = require("express");
const money = (n) => Number(Number(n || 0).toFixed(2));
const CHARGE_TYPES = ["rent", "first_month", "late_fee", "deposit", "utility", "parking", "other"];
const STATUSES = ["claimed", "partially_paid", "paid", "written_off", "disputed"];
const SOURCES = ["lease", "rent_roll", "import", "manual"];

function normalizePeriod(raw) {
  if (!raw) return null;
  const match = String(raw).trim().match(/^(\d{4})-(\d{2})/);
  if (!match) return null;
  const month = Number(match[2]);
  if (month < 1 || month > 12) return null;
  return `${match[1]}-${match[2]}-01`;
}

async function hasRentEquivalent(db, leaseId, period, excludeId = null) {
  const values = [leaseId, period];
  let exclude = "";
  if (excludeId) { values.push(excludeId); exclude = ` and id<>$${values.length}`; }
  const q = await db.query(
    `select id, charge_type from scheduled_charges
      where lease_id=$1 and period=$2 and charge_type in ('rent','first_month')
        ${exclude}
      limit 1`, values
  );
  return q.rows[0] || null;
}

module.exports = function chargesModule({ pool }) {
  const router = express.Router();
  if (!pool) throw new Error("charges module requires pool");

  router.post("/properties/:id/charges/generate", async (req, res) => {
    const propertyId = req.params.id;
    try {
      const property = (await pool.query("select id, name from properties where id=$1", [propertyId])).rows[0];
      if (!property) return res.status(404).json({ error: "property not found" });
      const body = req.body || {};
      const period = normalizePeriod(body.period);
      if (!period) return res.status(400).json({ receipt: "A period is required, e.g. 2026-06 or 2026-06-01." });
      const chargeType = CHARGE_TYPES.includes(body.charge_type) ? body.charge_type : "rent";
      const onlyActive = body.only_active !== false;

      const leases = (await pool.query(
        `select l.id as lease_id, l.rent, l.lease_status, s.unit_id,
                (l.tenant_ids)[1] as primary_person_id
           from leases l
           join spaces s on s.id=l.space_id
          where l.property_id=$1
            ${onlyActive ? "and l.lease_status='active'" : ""}`,
        [propertyId]
      )).rows;

      let created = 0;
      let skippedExisting = 0;
      let skippedNoRent = 0;
      let skippedFirstPeriodCovered = 0;
      const createdIds = [];
      for (const lease of leases) {
        if (lease.rent == null || Number(lease.rent) <= 0) { skippedNoRent++; continue; }
        if (chargeType === "rent") {
          const equivalent = await hasRentEquivalent(pool, lease.lease_id, period);
          if (equivalent) {
            skippedExisting++;
            if (equivalent.charge_type === "first_month") skippedFirstPeriodCovered++;
            continue;
          }
        }
        const inserted = (await pool.query(
          `insert into scheduled_charges
             (property_id,unit_id,lease_id,person_id,charge_type,period,amount,due_date,status,source,source_ref)
           values ($1,$2,$3,$4,$5,$6,$7,$6,'claimed','lease',$8)
           on conflict do nothing
           returning id`,
          [propertyId, lease.unit_id, lease.lease_id, lease.primary_person_id || null,
           chargeType, period, money(lease.rent), `lease:${lease.lease_id} ${period} ${chargeType}`]
        )).rows[0];
        if (inserted) { created++; createdIds.push(inserted.id); }
        else skippedExisting++;
      }

      return res.json({
        receipt: created > 0
          ? `Generated ${created} ${chargeType} charge${created === 1 ? "" : "s"} for ${period}.`
          : skippedFirstPeriodCovered > 0
            ? `No duplicate rent created — ${skippedFirstPeriodCovered} lease${skippedFirstPeriodCovered === 1 ? " has" : "s have"} a first-month charge covering ${period}.`
            : skippedExisting > 0
              ? `All ${skippedExisting} ${chargeType} charge${skippedExisting === 1 ? "" : "s"} already existed.`
              : `No charges generated — no eligible leases with rent for ${period}.`,
        period,
        charge_type: chargeType,
        created,
        skipped_existing: skippedExisting,
        skipped_first_period_covered: skippedFirstPeriodCovered,
        skipped_no_rent: skippedNoRent,
        total_leases: leases.length,
        created_ids: createdIds,
      });
    } catch (e) {
      console.error("charges/generate error", e);
      return res.status(500).json({ error: e.message });
    }
  });

  router.post("/properties/:id/charges", async (req, res) => {
    const propertyId = req.params.id;
    try {
      const property = (await pool.query("select id from properties where id=$1", [propertyId])).rows[0];
      if (!property) return res.status(404).json({ error: "property not found" });
      const body = req.body || {};
      const period = normalizePeriod(body.period);
      if (!period) return res.status(400).json({ receipt: "A period is required, e.g. 2026-06." });
      if (body.amount == null || !Number.isFinite(Number(body.amount)) || Number(body.amount) < 0) {
        return res.status(400).json({ receipt: "A non-negative amount is required." });
      }
      const chargeType = CHARGE_TYPES.includes(body.charge_type) ? body.charge_type : "rent";
      const status = STATUSES.includes(body.status) ? body.status : "claimed";
      const source = SOURCES.includes(body.source) ? body.source : "manual";
      if (body.lease_id && ["rent", "first_month"].includes(chargeType)) {
        const equivalent = await hasRentEquivalent(pool, body.lease_id, period);
        if (equivalent) {
          return res.status(409).json({
            receipt: `A ${equivalent.charge_type} charge already covers this lease and period; rent and first_month cannot both be billed.`,
            existing_charge_id: equivalent.id,
            existing_charge_type: equivalent.charge_type,
          });
        }
      }
      const row = (await pool.query(
        `insert into scheduled_charges
           (property_id,unit_id,lease_id,person_id,charge_type,period,amount,amount_paid,due_date,status,source,source_ref)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         returning *`,
        [propertyId, body.unit_id || null, body.lease_id || null, body.person_id || null,
         chargeType, period, money(body.amount), money(body.amount_paid), body.due_date || null,
         status, source, body.source_ref || null]
      )).rows[0];
      return res.json({ receipt: "Charge added.", charge: row });
    } catch (e) {
      if (e && e.code === "23505") return res.status(409).json({ receipt: "A charge for that lease, period, and type already exists." });
      console.error("charges add error", e);
      return res.status(500).json({ error: e.message });
    }
  });

  router.get("/properties/:id/charges", async (req, res) => {
    const propertyId = req.params.id;
    try {
      const period = req.query.period ? normalizePeriod(req.query.period) : null;
      const rows = (await pool.query(
        `select c.*,u.unit_number,p.name as person_name
           from scheduled_charges c
           left join units u on u.id=c.unit_id
           left join persons p on p.id=c.person_id
          where c.property_id=$1 ${period ? "and c.period=$2" : ""}
          order by c.period desc,u.unit_number asc nulls last`,
        period ? [propertyId, period] : [propertyId]
      )).rows;
      return res.json({
        property_id: propertyId,
        period: period || "all",
        count: rows.length,
        charges: rows.map((row) => ({
          id: row.id,
          unit_id: row.unit_id,
          unit_number: row.unit_number,
          lease_id: row.lease_id,
          person_id: row.person_id,
          person_name: row.person_name,
          charge_type: row.charge_type,
          period: row.period,
          amount: money(row.amount),
          amount_paid: money(row.amount_paid),
          balance: money(Number(row.amount) - Number(row.amount_paid || 0)),
          due_date: row.due_date,
          status: row.status,
          source: row.source,
          source_ref: row.source_ref,
          is_move_in_required: row.is_move_in_required === true,
          move_in_requirement_key: row.move_in_requirement_key || null,
          display_label: row.display_label || null,
        })),
      });
    } catch (e) {
      console.error("charges list error", e);
      return res.status(500).json({ error: e.message });
    }
  });

  router.get("/properties/:id/charges/summary", async (req, res) => {
    const propertyId = req.params.id;
    try {
      const period = req.query.period ? normalizePeriod(req.query.period) : null;
      const row = (await pool.query(
        `select count(*)::int as charge_count,
                coalesce(sum(amount),0)::numeric(14,2) as billed_total,
                coalesce(sum(amount-coalesce(amount_paid,0)) filter (where status in ('claimed','partially_paid')),0)::numeric(14,2) as billed_unpaid,
                coalesce(sum(amount) filter (where status='written_off'),0)::numeric(14,2) as written_off,
                coalesce(sum(amount) filter (where status='disputed'),0)::numeric(14,2) as disputed
           from scheduled_charges
          where property_id=$1 and charge_type in ('rent','first_month')
            ${period ? "and period=$2" : ""}`,
        period ? [propertyId, period] : [propertyId]
      )).rows[0];
      let missingCharge = null;
      if (period) {
        missingCharge = (await pool.query(
          `select count(*)::int as missing
             from leases l
            where l.property_id=$1 and l.lease_status='active' and l.rent>0
              and not exists (
                select 1 from scheduled_charges c
                 where c.lease_id=l.id and c.period=$2
                   and c.charge_type in ('rent','first_month'))`,
          [propertyId, period]
        )).rows[0].missing;
      }
      return res.json({
        property_id: propertyId,
        period: period || "all",
        charge_count: row.charge_count,
        billed_total: money(row.billed_total),
        billed_unpaid: money(row.billed_unpaid),
        written_off: money(row.written_off),
        disputed: money(row.disputed),
        missing_charge: missingCharge,
      });
    } catch (e) {
      console.error("charges summary error", e);
      return res.status(500).json({ error: e.message });
    }
  });

  return router;
};

module.exports._internal = { normalizePeriod, money, hasRentEquivalent };
