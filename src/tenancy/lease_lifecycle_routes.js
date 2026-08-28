// lease_lifecycle_routes.js — extracted VERBATIM from server.js (lines 927-1679).
// Route paths and registration order are unchanged: server.js mounts this
// router at "/" at the exact position these routes were registered inline.
const express = require("express");

module.exports = function leaseLifecycleRoutes({ pool, spawnObligationFromEvent }) {
  const router = express.Router();
//  REVENUE SIDE — all four blocks, paste-once.
//  Order: leases+schedule -> payments+delinquency -> PM approval -> tenant linkage.
//  Paste this ENTIRE file into server.js on the blank line ABOVE the
//  "// AI INGESTION" banner. Requires both schema files run in Neon first
//  (scheduled_charges_schema.sql, then scheduled_charges_schema_v2.sql).
// ════════════════════════════════════════════════════════════════════

// ════════════════════════════════════════════════════════════════════
//  LEASES + REVENUE SCHEDULE
//
//  The lease is the control document. Signing it generates the FULL revenue
//  schedule — not just a rent charge, but deposit, app fee, first month,
//  recurring rent, and any concessions with their booking treatment. The
//  leasing agent picks simple options; the correct schedule is derived here.
//
//  Scope of THIS build (matches the operator doc): timing and flow, not
//  payment processing. We model what's due, when, why, and whether it's
//  satisfied. Payment allocation + delinquency read from this later.
//
//  Paste into server.js among the other endpoints (before AI INGESTION).
//  Requires the scheduled_charges table (run scheduled_charges_schema.sql).
// ════════════════════════════════════════════════════════════════════

// Charge types that, by default, must be paid before keys (the move-in gate).
const MOVE_IN_GATE_TYPES = ["application_fee", "security_deposit", "first_month_rent", "move_in_fee", "deposit"];

// Add N months to a date (returns YYYY-MM-DD).
function addMonths(dateStr, n) {
  const d = new Date(dateStr + "T00:00:00Z");
  d.setUTCMonth(d.getUTCMonth() + n);
  return d.toISOString().slice(0, 10);
}

// ── create a lease ────────────────────────────────────────────────────
//  THE BARE LEASE WRITER, CONTAINED.
//
//  This route created canonical lease truth from a shared bearer key, with
//  `property_id` and `space_id` taken from the request body and believed.
//  It is the same shape as the fifth property-creation door Build 1A
//  closed — no actor, no organization, no evidence, no record that it
//  happened — one level down, on the object the whole rent roll reads.
//
//  Two governed paths now exist for a lease and this is neither:
//
//    tenancy_anchor_service.js   a NEW lease signed natively through Spine
//                                (application → countersign → confirm term).
//                                Untouched by this: it is the right path
//                                for the thing it does.
//    activation_service.js       an EXISTING lease established from a
//                                retained rent roll, with evidence, a
//                                proposal and a human confirmation behind
//                                every row.
//
//  ── CONTAINED, NOT DELETED ──────────────────────────────────────────
//  Nothing in this repo posts here — checked, including the app, whose
//  every `/leases/` reference is an `/operator/leasing/leases/:id/…`
//  sub-path. But the shared operator key is held OUTSIDE this repository
//  and source can prove a consumer exists, never that one does not. Both
//  choices break an unknown caller; this one breaks it with a refusal that
//  names the two paths that work, instead of a dead end.
//
//  RETIREMENT CONDITION — delete the route once a deploy has passed with
//  no `bare_lease_writer_contained` refusal recorded in the logs, which is
//  the only evidence available that nobody outside was calling it.
router.post("/leases", async (req, res) => {
  console.warn("bare_lease_writer_contained", JSON.stringify({
    at: new Date().toISOString(),
    property_id: (req.body || {}).property_id || null,
    space_id: (req.body || {}).space_id || null,
    ua: req.get("user-agent") || null,
  }));
  return res.status(410).json({
    error: "bare_lease_writer_contained",
    reason: "ungoverned_lease_creation",
    receipt:
      "A lease can no longer be created by posting terms with a shared key. A lease is " +
      "either signed through Spine, or established from a rent roll that Spine keeps — " +
      "both record who did it and what it came from.",
    what_you_can_do: {
      signed_in_spine:
        "The leasing flow: an application, a countersignature, then confirm the term.",
      established_from_a_rent_roll:
        "Asset Management → the deal → the property → upload the rent roll → confirm the rows.",
    },
  });
});

// ── GENERATE the revenue schedule from the lease ──
// This is the lease-as-control-document in action. One call turns lease terms
// into the full set of scheduled charges. Idempotent-ish: refuses to double-
// generate (clears+regenerates only if ?force=true).
//
// Body (optional, all have sane defaults from the operator doc):
//   { application_fee=25, security_deposit=1 month, move_in_fees=[{label,amount}],
//     recurring=[{charge_type,label,amount}],  // pet_rent, parking, etc.
//     concession: { months, treatment } }      // treatment: upfront | amortized
router.post("/leases/:id/generate-schedule", async (req, res) => {
  const force = req.query.force === "true";
  const body = req.body || {};
  const client = await pool.connect();
  try {
    await client.query("begin");

    const lr = await client.query("select * from leases where id=$1 for update", [req.params.id]);
    if (lr.rows.length === 0) { await client.query("rollback"); return res.status(404).json({ error: "lease not found" }); }
    const lease = lr.rows[0];

    if (lease.schedule_generated_at && !force) {
      await client.query("rollback");
      return res.status(409).json({ error: "schedule already generated; pass ?force=true to regenerate" });
    }
    if (force) {
      await client.query("delete from scheduled_charges where lease_id=$1", [lease.id]);
    }

    const rent = Number(lease.rent);
    const start = lease.start_date || new Date().toISOString().slice(0, 10);
    const appFee = body.application_fee ?? Number(lease.application_fee ?? 25);
    const deposit = body.security_deposit ?? Number(lease.security_deposit ?? rent); // default: 1 month
    const rows = [];

    // Helper to push a charge.
    const charge = (charge_type, label, amount, due_on, opts = {}) =>
      rows.push({ charge_type, label, amount, due_on,
        is_move_in_gate: opts.gate ?? MOVE_IN_GATE_TYPES.includes(charge_type),
        recurs: opts.recurs ?? false, recur_period: opts.recur_period ?? null,
        concession_treatment: opts.concession_treatment ?? null,
        concession_of_months: opts.concession_of_months ?? null });

    // 1. Application fee — due at application (use start as a placeholder date).
    if (appFee > 0) charge("application_fee", "Application fee", appFee, start);
    // 2. Security deposit — due at signing / before keys.
    if (deposit > 0) charge("security_deposit", "Security deposit", deposit, start);
    // 3. First month's rent — due before keys.
    charge("first_month_rent", "First month's rent", rent, start);
    // 4. Move-in fees (optional list).
    for (const f of (body.move_in_fees || [])) {
      if (f && f.amount) charge("move_in_fee", f.label || "Move-in fee", Number(f.amount), start);
    }
    // 5. Recurring monthly rent line (represented once, recurs=true; expansion later).
    charge("rent", "Monthly rent", rent, addMonths(start, 1), { recurs: true, recur_period: "monthly", gate: false });
    // 6. Other recurring charges (pet rent, parking, utilities).
    for (const rc of (body.recurring || [])) {
      if (rc && rc.amount) charge(rc.charge_type || "one_time", rc.label || rc.charge_type, Number(rc.amount),
        addMonths(start, 1), { recurs: true, recur_period: "monthly", gate: false });
    }
    // 7. Concession — simple input (months + treatment), correct booking behind the scenes.
    if (body.concession && body.concession.months) {
      const months = Number(body.concession.months);
      const treatment = body.concession.treatment === "amortized" ? "amortized" : "upfront";
      if (treatment === "upfront") {
        // Full credit at move-in / month 1.
        charge("concession_credit", `Concession: ${months} month(s) free (upfront)`, rent * months, start,
          { gate: false, concession_treatment: "upfront", concession_of_months: months });
      } else {
        // Amortized: a per-month credit across the term (represented as one recurring credit line).
        const lr2 = lease.end_date
          ? Math.max(1, Math.round((new Date(lease.end_date) - new Date(start)) / (30.44 * 86400000)))
          : 12;
        const perMonth = (rent * months) / lr2;
        charge("concession_credit", `Concession: ${months} month(s) free (amortized over ${lr2} mo)`,
          Number(perMonth.toFixed(2)), addMonths(start, 1),
          { gate: false, recurs: true, recur_period: "monthly",
            concession_treatment: "amortized", concession_of_months: months });
      }
    }

    // Write them all.
    const written = [];
    for (const c of rows) {
      const r = await client.query(
        `insert into scheduled_charges
           (lease_id, property_id, charge_type, label, amount, due_on, status,
            is_move_in_gate, recurs, recur_period, concession_treatment, concession_of_months)
         values ($1,$2,$3,$4,$5,$6,'scheduled',$7,$8,$9,$10,$11)
         returning *`,
        [lease.id, lease.property_id, c.charge_type, c.label, c.amount, c.due_on,
         c.is_move_in_gate, c.recurs, c.recur_period, c.concession_treatment, c.concession_of_months]
      );
      written.push(r.rows[0]);
    }

    await client.query("update leases set schedule_generated_at=now(), updated_at=now() where id=$1", [lease.id]);
    await client.query("commit");

    res.status(201).json({ lease_id: lease.id, generated: written.length, charges: written });
  } catch (e) {
    await client.query("rollback");
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// ── READ a lease's schedule, with the move-in gate and balance computed ──
router.get("/leases/:id/schedule", async (req, res) => {
  try {
    const lr = await pool.query("select * from leases where id=$1", [req.params.id]);
    if (lr.rows.length === 0) return res.status(404).json({ error: "lease not found" });

    const sc = await pool.query(
      "select * from scheduled_charges where lease_id=$1 order by due_on nulls last, created_at",
      [req.params.id]
    );
    const charges = sc.rows;

    // Money math. Credits (concession_credit) reduce what's owed.
    const isCredit = c => c.charge_type === "concession_credit";
    const owed = charges
      .filter(c => c.status === "scheduled" && !isCredit(c))
      .reduce((s, c) => s + Number(c.amount), 0);
    const credits = charges
      .filter(c => c.status === "scheduled" && isCredit(c))
      .reduce((s, c) => s + Number(c.amount), 0);

    // The move-in gate: every gate charge that isn't satisfied yet.
    const gateCharges = charges.filter(c => c.is_move_in_gate);
    const gateOutstanding = gateCharges.filter(c => c.status === "scheduled");
    const moveInBalance = gateOutstanding.reduce((s, c) => s + Number(c.amount), 0);

    res.json({
      lease_id: req.params.id,
      total_scheduled_owed: Number(owed.toFixed(2)),
      total_scheduled_credits: Number(credits.toFixed(2)),
      net_scheduled: Number((owed - credits).toFixed(2)),
      move_in_balance_due: Number(moveInBalance.toFixed(2)),
      keys_released: gateOutstanding.length === 0 && gateCharges.length > 0,  // gate clear?
      gate_outstanding: gateOutstanding,
      charges,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
// ════════════════════════════════════════════════════════════════════
//  PAYMENTS + ALLOCATION  (reads FROM scheduled_charges)
//
//  A tenant pays whatever amount they want. The system allocates it against
//  the schedule using the operator's default rules:
//    • oldest unpaid first
//    • rent before optional/ancillary charges
//    • unpaid balances stay open
//    • overpayment becomes a tenant credit (applied to future charges)
//
//  Each payment is recorded as a ledger_entries row (the money that HAPPENED).
//  Each fully-covered scheduled_charge flips to 'satisfied'. Partial coverage
//  is tracked so a charge can be partly paid.
//
//  Scope note: this is the allocation/flow layer. Real payment processing
//  (cards, ACH, bank linking) is still later — we record an amount + method.
//
//  Requires a small column to track partial payment on a charge:
//    alter table scheduled_charges add column if not exists amount_paid numeric(10,2) not null default 0;
//  (included in scheduled_charges_schema_v2.sql)
// ════════════════════════════════════════════════════════════════════

// Priority for allocation: lower number = paid first. Rent-type before ancillary.
function chargePriority(c) {
  const rentish = ["first_month_rent", "rent"];
  const moveIn  = ["application_fee", "security_deposit", "move_in_fee", "deposit"];
  if (moveIn.includes(c.charge_type)) return 0;   // move-in gate items first
  if (rentish.includes(c.charge_type)) return 1;  // then rent
  return 2;                                        // then ancillary (pet, parking, utilities, late fees)
}

// ── record a tenant payment and allocate it ──
// Body: { amount, method?, occurred_at? }
router.post("/leases/:id/payments", async (req, res) => {
  const { amount, method, occurred_at } = req.body || {};
  const payAmount = Number(amount);
  if (!payAmount || payAmount <= 0) return res.status(400).json({ error: "a positive amount is required" });

  const client = await pool.connect();
  try {
    await client.query("begin");

    const lr = await client.query("select * from leases where id=$1 for update", [req.params.id]);
    if (lr.rows.length === 0) { await client.query("rollback"); return res.status(404).json({ error: "lease not found" }); }
    const lease = lr.rows[0];

    // Pull outstanding charges (not credits, not satisfied/void/waived), ordered
    // by allocation priority then by due date (oldest first).
    const sc = await client.query(
      `select * from scheduled_charges
        where lease_id=$1 and status='scheduled' and charge_type <> 'concession_credit'`,
      [lease.id]
    );
    const charges = sc.rows
      .map(c => ({ ...c, remaining: Number(c.amount) - Number(c.amount_paid || 0) }))
      .filter(c => c.remaining > 0.001)
      .sort((a, b) => chargePriority(a) - chargePriority(b)
        || (new Date(a.due_on || "2999-01-01") - new Date(b.due_on || "2999-01-01")));

    // Record the payment itself in the ledger.
    const led = await client.query(
      `insert into ledger_entries (lease_id, label, kind, amount, method, occurred_at)
       values ($1,$2,'payment',$3,$4, coalesce($5, now()))
       returning *`,
      [lease.id, "Tenant payment", payAmount, method ?? null, occurred_at ?? null]
    );

    // Allocate.
    let left = payAmount;
    const applied = [];
    for (const c of charges) {
      if (left <= 0.001) break;
      const take = Math.min(left, c.remaining);
      const newPaid = Number(c.amount_paid || 0) + take;
      const fullyPaid = newPaid + 0.001 >= Number(c.amount);
      await client.query(
        `update scheduled_charges
           set amount_paid=$1, status=$2, updated_at=now()
         where id=$3`,
        [Number(newPaid.toFixed(2)), fullyPaid ? "satisfied" : "scheduled", c.id]
      );
      applied.push({ charge_id: c.id, charge_type: c.charge_type, label: c.label,
        applied: Number(take.toFixed(2)), now_satisfied: fullyPaid });
      left -= take;
    }

    // Overpayment becomes a credit (recorded as a ledger note for now).
    const creditLeft = Number(left.toFixed(2));
    if (creditLeft > 0.001) {
      await client.query(
        `insert into ledger_entries (lease_id, label, kind, amount, method)
         values ($1,'Tenant credit (overpayment)','credit',$2,$3)`,
        [lease.id, creditLeft, method ?? null]
      );
    }

    // Recompute the move-in gate after this payment.
    const gate = await client.query(
      `select count(*)::int as n from scheduled_charges
        where lease_id=$1 and is_move_in_gate=true and status='scheduled'`,
      [lease.id]
    );
    const keysReleased = gate.rows[0].n === 0;

    await client.query("commit");
    res.status(201).json({
      payment: led.rows[0],
      allocated: applied,
      credit_remaining: creditLeft,
      keys_released: keysReleased,
    });
  } catch (e) {
    await client.query("rollback");
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// ── DELINQUENCY view + the two-payments-behind legal trigger ──
// Read-time (no background job). Computes what's overdue and unpaid as of now,
// and the delinquency stage. If the tenant is effectively two payments behind,
// it spawns a collections obligation (the engine, reused) AND assembles the
// package the AI/legal review needs — once (won't duplicate).
//
// GET  /leases/:id/delinquency        → just the read (no side effects)
// POST /leases/:id/delinquency/check  → read + spawn obligation if triggered
router.get("/leases/:id/delinquency", async (req, res) => {
  try {
    const out = await computeDelinquency(pool, req.params.id);
    if (out.error) return res.status(out.code).json({ error: out.error });
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post("/leases/:id/delinquency/check", async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const out = await computeDelinquency(client, req.params.id);
    if (out.error) { await client.query("rollback"); return res.status(out.code).json({ error: out.error }); }

    let obligation = null;
    if (out.legal_trigger) {
      // Don't double-create: is there already an open collections obligation?
      const existing = await client.query(
        `select id from obligations
          where module='collections' and type='legal_process'
            and status in ('open','in_progress') and property_id=$1
            and person_id is not distinct from $2`,
        [out.property_id, out.tenant_id ?? null]
      );
      if (existing.rows.length === 0) {
        obligation = await spawnObligationFromEvent(client, {
          property_id: out.property_id,
          person_id: out.tenant_id ?? null,
          module: "collections",
          type: "legal_process",
          label: `Delinquency: ${out.lease_id} is ~${out.days_delinquent}d behind — start legal process`,
          owner_type: "human",
          assigned_role: "property_manager",
          escalates_to_role: "property_manager",
          status: "open",
          priority: "high",
          severity: "high",
          required_inputs: ["legal_review"],
        });
        // The package the AI/legal review needs, captured as an event.
        await client.query(
          `insert into events (property_id, person_id, type, note)
           values ($1,$2,'collections_package',$3)`,
          [out.property_id, out.tenant_id ?? null, JSON.stringify(out.package)]
        );
      }
    }

    await client.query("commit");
    res.json({ ...out, obligation_created: obligation });
  } catch (e) {
    await client.query("rollback");
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// Shared delinquency computation. Works with a pool or a transaction client.
async function computeDelinquency(db, leaseId) {
  const lr = await db.query("select * from leases where id=$1", [leaseId]);
  if (lr.rows.length === 0) return { error: "lease not found", code: 404 };
  const lease = lr.rows[0];

  const today = new Date();
  const sc = await db.query(
    `select * from scheduled_charges
      where lease_id=$1 and status='scheduled'
        and charge_type in ('first_month_rent','rent','move_in_fee')
        and due_on is not null and due_on <= $2`,
    [leaseId, today.toISOString().slice(0, 10)]
  );
  const overdue = sc.rows.map(c => ({ ...c, remaining: Number(c.amount) - Number(c.amount_paid || 0) }))
    .filter(c => c.remaining > 0.001);

  const totalOverdue = overdue.reduce((s, c) => s + c.remaining, 0);

  // Oldest overdue charge → days delinquent.
  let daysDelinquent = 0;
  if (overdue.length) {
    const oldest = overdue.reduce((a, b) => new Date(a.due_on) < new Date(b.due_on) ? a : b);
    daysDelinquent = Math.floor((today - new Date(oldest.due_on)) / 86400000);
  }

  // Stage. Operator rule: rent due 1st, grace to 5th, late from 6th; the big
  // trigger is effectively two payments behind (~60 days).
  const rentPeriods = overdue.filter(c => c.charge_type === "rent" || c.charge_type === "first_month_rent").length;
  let stage = "current";
  if (overdue.length) stage = "late";
  if (daysDelinquent > 5) stage = "delinquent";
  const legalTrigger = rentPeriods >= 2 || daysDelinquent >= 60;
  if (legalTrigger) stage = "legal_process";

  const tenantId = (lease.tenant_ids && lease.tenant_ids[0]) || null;

  return {
    lease_id: leaseId,
    property_id: lease.property_id,
    tenant_id: tenantId,
    stage,                                   // current | late | delinquent | legal_process
    days_delinquent: daysDelinquent,
    periods_behind: rentPeriods,
    total_overdue: Number(totalOverdue.toFixed(2)),
    legal_trigger: legalTrigger,
    overdue_charges: overdue.map(c => ({ id: c.id, type: c.charge_type, label: c.label,
      due_on: c.due_on, remaining: Number(c.remaining.toFixed(2)) })),
    // The package the AI assembles for legal review (timing + flow, not filing).
    package: {
      lease_id: leaseId,
      tenant_id: tenantId,
      stage,
      days_delinquent: daysDelinquent,
      periods_behind: rentPeriods,
      total_overdue: Number(totalOverdue.toFixed(2)),
      note: "Auto-assembled at delinquency check. For PM/legal review — system does not file.",
    },
  };
}
// ════════════════════════════════════════════════════════════════════
//  PM APPROVAL PACKAGE  (the "buck stops with the PM" surface)
//
//  Lease approval isn't just "is the document correct." It's "does this lease
//  support the asset plan." This endpoint assembles the single view a PM
//  approves against:
//    • lease abstract (terms)
//    • full revenue schedule + move-in balance (reads scheduled_charges)
//    • concession details + booking treatment
//    • asset-plan FLAGS — a coaching layer, not a rigid gate
//
//  The flags begin as comments/highlights the PM can heed or override. Over
//  time, overrides become training data for better rules. The PM can approve
//  or reject; the decision is recorded as an event.
//
//  Reads from leases + scheduled_charges + units/spaces. No new table.
// ════════════════════════════════════════════════════════════════════

// Months with historically weak student/market leasing (configurable later;
// for now, a simple heuristic the PM sees and can override). Nov–Feb flagged.
const WEAK_LEASING_MONTHS = [11, 12, 1, 2];

// Build the asset-plan flags. Pure read; produces human-readable highlights.
async function assetPlanFlags(db, lease, charges) {
  const flags = [];

  // Lease expiration in a weak leasing month → future re-lease risk.
  if (lease.end_date) {
    const endMonth = new Date(lease.end_date + "T00:00:00Z").getUTCMonth() + 1;
    if (WEAK_LEASING_MONTHS.includes(endMonth)) {
      flags.push({ level: "warn", code: "weak_expiration_month",
        message: `Lease expires in month ${endMonth}, a historically weak leasing window — re-leasing may be slow.` });
    }
  }

  // Scarce inventory of this unit type at the property → consider pushing rent.
  // (Counts spaces in the same property with no active lease, same bedroom count.)
  if (lease.space_id) {
    const u = await db.query(
      `select un.bedrooms from spaces sp join units un on un.id=sp.unit_id where sp.id=$1`,
      [lease.space_id]
    );
    const beds = u.rows[0]?.bedrooms ?? null;
    if (beds !== null) {
      const avail = await db.query(
        `select count(*)::int as n
           from spaces sp join units un on un.id=sp.unit_id
          where un.property_id=$1 and un.bedrooms=$2
            and sp.id not in (select space_id from leases where lease_status in ('active','pending'))`,
        [lease.property_id, beds]
      );
      const remaining = avail.rows[0].n;
      if (remaining <= 1) {
        flags.push({ level: "opportunity", code: "scarce_inventory",
          message: `Only ${remaining} ${beds}BR space(s) left unleased at this property — consider pushing rent; little inventory behind it.` });
      }
    }
  }

  // Concession present → note its exposure.
  const concession = charges.find(c => c.charge_type === "concession_credit");
  if (concession) {
    flags.push({ level: "info", code: "concession_applied",
      message: `Concession applied (${concession.label}) — booked ${concession.concession_treatment}. Confirm it fits the property's revenue plan.` });
  }

  // Lease start far in the future → carrying vacancy until then.
  if (lease.start_date) {
    const days = Math.floor((new Date(lease.start_date) - new Date()) / 86400000);
    if (days > 30) {
      flags.push({ level: "warn", code: "vacancy_until_start",
        message: `Unit would sit vacant ~${days} days until lease start — weigh against holding for a sooner move-in.` });
    }
  }

  return flags;
}

// ── GET the approval package ──
router.get("/leases/:id/approval-package", async (req, res) => {
  try {
    const lr = await pool.query("select * from leases where id=$1", [req.params.id]);
    if (lr.rows.length === 0) return res.status(404).json({ error: "lease not found" });
    const lease = lr.rows[0];

    const sc = await pool.query(
      "select * from scheduled_charges where lease_id=$1 order by due_on nulls last, created_at",
      [req.params.id]
    );
    const charges = sc.rows;

    const isCredit = c => c.charge_type === "concession_credit";
    const owed = charges.filter(c => !isCredit(c)).reduce((s, c) => s + Number(c.amount), 0);
    const credits = charges.filter(isCredit).reduce((s, c) => s + Number(c.amount), 0);
    const gateOutstanding = charges.filter(c => c.is_move_in_gate && c.status === "scheduled");
    const moveInBalance = gateOutstanding.reduce((s, c) => s + Number(c.amount), 0);

    const flags = await assetPlanFlags(pool, lease, charges);

    res.json({
      lease_abstract: {
        lease_id: lease.id, property_id: lease.property_id, space_id: lease.space_id,
        rent: lease.rent, start_date: lease.start_date, end_date: lease.end_date,
        status: lease.lease_status, tenant_ids: lease.tenant_ids,
      },
      revenue_schedule: charges,
      money_summary: {
        total_owed: Number(owed.toFixed(2)),
        total_credits: Number(credits.toFixed(2)),
        net: Number((owed - credits).toFixed(2)),
        move_in_balance_due: Number(moveInBalance.toFixed(2)),
      },
      concession: charges.find(isCredit) || null,
      asset_plan_flags: flags,                 // coaching layer — heed or override
      schedule_generated: !!lease.schedule_generated_at,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── PM decision: approve or reject the lease ──
// Body: { decision: "approve"|"reject", decided_by?, note? }
// Recorded as an event; on approve, lease moves pending → active.
router.patch("/leases/:id/approval", async (req, res) => {
  const { decision, decided_by, note } = req.body || {};
  if (!["approve", "reject"].includes(decision)) {
    return res.status(400).json({ error: 'decision must be "approve" or "reject"' });
  }
  try {
    const lr = await pool.query("select * from leases where id=$1", [req.params.id]);
    if (lr.rows.length === 0) return res.status(404).json({ error: "lease not found" });

    const newStatus = decision === "approve" ? "active" : "rejected";
    const r = await pool.query(
      "update leases set lease_status=$1, updated_at=now() where id=$2 returning *",
      [newStatus, req.params.id]
    );
    await pool.query(
      `insert into events (property_id, type, note)
       values ($1,$2,$3)`,
      [r.rows[0].property_id, `lease_${decision}d`,
       `Lease ${decision}d${decided_by ? " by " + decided_by : ""}${note ? ": " + note : ""}`]
    );
    res.json(r.rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
// ════════════════════════════════════════════════════════════════════
//  TENANT LINKAGE — applicant → tenant on a lease
//
//  The missing connective tissue. The leasing side builds up a person
//  (lead → applicant). The lease/money side needs to know WHO the tenant is,
//  so obligations (e.g. collections) attach to a real human instead of being
//  orphaned. This endpoint links a person to a lease and advances their
//  lifecycle to 'tenant' in one atomic step.
//
//  • adds person_id to leases.tenant_ids (no duplicates)
//  • advances the person applicant → tenant (validated; writes a funnel event)
//  • records a tenant_added event on the lease
//
//  Paste into server.js among the lease endpoints (before AI INGESTION).
// ════════════════════════════════════════════════════════════════════

// ── attach a person to a lease as a tenant ──
// Body: { person_id }
router.post("/leases/:id/tenants", async (req, res) => {
  const { person_id } = req.body || {};
  if (!person_id) return res.status(400).json({ error: "person_id is required" });

  const client = await pool.connect();
  try {
    await client.query("begin");

    const lr = await client.query("select * from leases where id=$1 for update", [req.params.id]);
    if (lr.rows.length === 0) { await client.query("rollback"); return res.status(404).json({ error: "lease not found" }); }
    const lease = lr.rows[0];

    const pr = await client.query("select * from persons where id=$1 for update", [person_id]);
    if (pr.rows.length === 0) { await client.query("rollback"); return res.status(404).json({ error: "person not found" }); }
    const person = pr.rows[0];

    // Already on the lease? No-op success (idempotent).
    const current = lease.tenant_ids || [];
    const alreadyOn = current.includes(person_id);

    // Add to tenant_ids if not present (array_append guarded by uniqueness).
    if (!alreadyOn) {
      await client.query(
        `update leases set tenant_ids = array_append(tenant_ids, $1), updated_at=now()
         where id=$2`,
        [person_id, req.params.id]
      );
    }

    // Advance lifecycle to tenant. Only valid forward moves: applicant→tenant
    // is the normal path. If they're already 'tenant', leave it. If they're a
    // 'lead' (skipping applicant), we still allow it here because attaching to a
    // signed lease is itself the proof they've become a tenant — but we record
    // the jump honestly in the event note.
    let lifecycleNote = null;
    if (person.lifecycle_status !== "tenant" && person.lifecycle_status !== "past") {
      const from = person.lifecycle_status;
      await client.query(
        `update persons set lifecycle_status='tenant', updated_at=now() where id=$1`,
        [person_id]
      );
      await client.query(
        `insert into events (property_id, person_id, type, note)
         values ($1,$2,'lifecycle_change',$3)`,
        [lease.property_id, person_id, `${from} → tenant (attached to lease ${lease.id})`]
      );
      lifecycleNote = `${from} → tenant`;
    }

    // Record the linkage as a lease event.
    await client.query(
      `insert into events (property_id, person_id, type, note)
       values ($1,$2,'tenant_added',$3)`,
      [lease.property_id, person_id, `tenant added to lease ${lease.id}`]
    );

    await client.query("commit");

    // Return the refreshed lease + person.
    const out = await pool.query("select * from leases where id=$1", [req.params.id]);
    res.status(201).json({
      lease: out.rows[0],
      person_advanced: lifecycleNote,
      already_on_lease: alreadyOn,
    });
  } catch (e) {
    await client.query("rollback");
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// ── remove a person from a lease (roommate leaves, data fix) ──
// Body: { person_id }
// Does NOT change the person's lifecycle (leaving one lease doesn't make them
// 'past' — they may be on another lease). Records the removal as an event.
router.delete("/leases/:id/tenants", async (req, res) => {
  const { person_id } = req.body || {};
  if (!person_id) return res.status(400).json({ error: "person_id is required" });
  try {
    const lr = await pool.query("select * from leases where id=$1", [req.params.id]);
    if (lr.rows.length === 0) return res.status(404).json({ error: "lease not found" });
    const lease = lr.rows[0];

    if (!(lease.tenant_ids || []).includes(person_id)) {
      return res.status(409).json({ error: "that person is not a tenant on this lease" });
    }

    const r = await pool.query(
      `update leases set tenant_ids = array_remove(tenant_ids, $1), updated_at=now()
       where id=$2 returning *`,
      [person_id, req.params.id]
    );
    await pool.query(
      `insert into events (property_id, person_id, type, note)
       values ($1,$2,'tenant_removed',$3)`,
      [lease.property_id, person_id, `tenant removed from lease ${lease.id}`]
    );
    res.json({ lease: r.rows[0] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
  return router;
}