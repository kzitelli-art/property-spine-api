"use strict";

const crypto = require("crypto");

function serviceError(status, code, receipt, extra = {}) {
  const e = new Error(receipt);
  e.service = true;
  e.http = status;
  e.body = { error: code, receipt, ...extra };
  return e;
}

const money = (value) => Number(Number(value || 0).toFixed(2));
const ymd = (value) => {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
};
const monthStart = (value) => {
  const d = ymd(value);
  return d ? `${d.slice(0, 7)}-01` : null;
};
const stableHash = (value) => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function loadLease(client, leaseId, { forUpdate = false } = {}) {
  const q = await client.query(
    `select l.*, s.unit_id, u.unit_number,
            er.id as executed_lease_record_id,
            er.record_state as executed_record_state,
            er.document_reference as executed_document_reference,
            er.document_sha256 as executed_document_sha256,
            er.provider_name as executed_provider_name,
            er.provider_document_id as executed_provider_document_id,
            er.provider_version_id as executed_provider_version_id
       from leases l
       join spaces s on s.id = l.space_id
       join units u on u.id = s.unit_id
       left join executed_lease_records er
         on er.lease_id = l.id and er.record_state = 'verified'
      where l.id = $1
      ${forUpdate ? "for update of l" : ""}`,
    [leaseId]
  );
  return q.rows[0] || null;
}

function normalizeFees(raw) {
  if (!Array.isArray(raw)) throw serviceError(400, "required_fees_invalid", "required_fees must be an array (use [] when no move-in fees are required).");
  if (raw.length > 25) throw serviceError(400, "required_fees_too_many", "At most 25 required move-in fees may be confirmed at once.");
  const seen = new Set();
  return raw.map((fee, index) => {
    const key = String(fee && fee.key || "").trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "_");
    const label = String(fee && fee.label || "").trim();
    const rawAmount = fee && fee.amount;
    const amount = money(rawAmount);
    if (!key || !label) throw serviceError(400, "required_fee_invalid", `Fee ${index + 1} requires key and label.`);
    if (seen.has(key)) throw serviceError(400, "required_fee_duplicate", `Fee key '${key}' is duplicated.`);
    if (rawAmount == null || !Number.isFinite(Number(rawAmount)) || amount < 0) {
      throw serviceError(400, "required_fee_invalid", `Fee '${label}' needs an explicit non-negative amount.`);
    }
    seen.add(key);
    return { key, label, amount };
  });
}

async function insertOrAdoptCharge(client, {
  chargeSetId, lease, requirementKey, chargeType, label, period, amount, dueDate,
}) {
  const existing = (await client.query(
    `select * from scheduled_charges
      where lease_id=$1 and period=$2 and charge_type=$3
      order by created_at asc limit 1 for update`,
    [lease.id, period, chargeType]
  )).rows[0] || null;

  if (existing) {
    const existingIsSameRequirement = existing.is_move_in_required === true && existing.move_in_requirement_key === requirementKey;
    if (money(existing.amount) !== money(amount) || (chargeType === "other" && !existingIsSameRequirement)) {
      throw serviceError(409, "existing_charge_conflict",
        `An existing ${chargeType} charge already occupies this lease/period slot and cannot be silently reclassified as '${requirementKey}'. Resolve the charge conflict before activation.`,
        { scheduled_charge_id: existing.id, existing_amount: money(existing.amount), confirmed_amount: money(amount), existing_requirement_key: existing.move_in_requirement_key || null });
    }
    const adopted = (await client.query(
      `update scheduled_charges
          set is_move_in_required=true,
              move_in_requirement_key=$2,
              move_in_charge_set_id=$3,
              display_label=coalesce(display_label,$4),
              updated_at=now()
        where id=$1 returning *`,
      [existing.id, requirementKey, chargeSetId, label]
    )).rows[0];
    return { charge: adopted, adopted: true };
  }

  const status = money(amount) === 0 ? "paid" : "claimed";
  const row = (await client.query(
    `insert into scheduled_charges
       (property_id, unit_id, lease_id, person_id, charge_type, period,
        amount, amount_paid, due_date, status, source, source_ref,
        is_move_in_required, move_in_requirement_key, move_in_charge_set_id, display_label)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'lease',$11,true,$12,$13,$14)
     returning *`,
    [lease.property_id, lease.unit_id, lease.id,
     Array.isArray(lease.tenant_ids) && lease.tenant_ids.length ? lease.tenant_ids[0] : null,
     chargeType, period, money(amount), money(amount) === 0 ? 0 : 0, dueDate,
     status, `move_in_charge_set:${chargeSetId}:${requirementKey}`,
     requirementKey, chargeSetId, label]
  )).rows[0];
  return { charge: row, adopted: false };
}

async function confirmMoveInChargeSet(client, {
  lease_id, first_period_amount, first_period_start, first_period_end,
  required_fees, confirmed_by_user_id, calculation_note, idempotency_key = null,
}) {
  if (!lease_id) throw serviceError(400, "lease_required", "lease_id is required.");
  if (!confirmed_by_user_id) throw serviceError(400, "confirmed_by_required", "A staff actor must confirm the move-in charge set.");
  const calculationNote = String(calculation_note || "").trim();
  if (!calculationNote) {
    throw serviceError(400, "calculation_note_required", "calculation_note is required — record how the exact first-period amount and required fees were verified from the governing source.");
  }
  if (calculationNote.length > 2000) throw serviceError(400, "calculation_note_too_long", "calculation_note must be 2,000 characters or fewer.");
  const firstAmount = money(first_period_amount);
  if (first_period_amount == null || !Number.isFinite(Number(first_period_amount)) || firstAmount <= 0) {
    throw serviceError(400, "first_period_amount_invalid", "first_period_amount must be explicitly provided as a positive number. A zero-dollar first period requires a future governed concession path; it cannot silently satisfy the first-rent gate.");
  }
  const start = ymd(first_period_start);
  const end = ymd(first_period_end);
  if (!start || !end || end < start) throw serviceError(400, "first_period_dates_invalid", "first_period_start and first_period_end must be valid dates in order.");
  const fees = normalizeFees(required_fees);

  const lease = await loadLease(client, lease_id, { forUpdate: true });
  if (!lease) throw serviceError(404, "lease_not_found", "Lease not found.");
  if (!["pending", "active"].includes(String(lease.lease_status || "").toLowerCase())) {
    throw serviceError(409, "lease_not_eligible", `Move-in charges cannot be confirmed for a lease in status '${lease.lease_status}'.`);
  }
  if (!lease.executed_lease_record_id || lease.executed_record_state !== "verified") {
    throw serviceError(409, "verified_execution_required", "The lease must remain linked to a live verified executed-lease record.");
  }
  if (start !== ymd(lease.start_date)) {
    throw serviceError(409, "first_period_start_mismatch", "The first-period coverage must begin on the governing lease start date.",
      { lease_start_date: ymd(lease.start_date), submitted_start_date: start });
  }
  if (end > ymd(lease.end_date)) {
    throw serviceError(409, "first_period_end_outside_lease", "The first-period coverage cannot extend beyond the lease end date.");
  }

  const canonical = {
    lease_id: lease.id,
    first_period_amount: firstAmount,
    first_period_start: start,
    first_period_end: end,
    security_deposit: money(lease.security_deposit),
    required_fees: fees,
  };
  const payloadHash = stableHash(canonical);
  const existing = (await client.query(
    `select * from lease_move_in_charge_sets
      where lease_id=$1 and status='confirmed'
      order by created_at desc limit 1 for update`, [lease.id]
  )).rows[0] || null;
  if (existing) {
    if (idempotency_key && existing.idempotency_key === idempotency_key && existing.payload_hash !== payloadHash) {
      throw serviceError(409, "idempotency_conflict",
        "That idempotency key was already used with a different move-in charge set. Nothing was changed.",
        { charge_set_id: existing.id });
    }
    if (existing.payload_hash === payloadHash) {
      const funds = await readMoveInFunds(client, lease.id);
      return { charge_set: existing, charges: funds.charges, idempotent: true, funds };
    }
    throw serviceError(409, "move_in_charge_set_exists",
      "A different confirmed move-in charge set already exists. Corrections require a governed supersession path; nothing was overwritten.",
      { charge_set_id: existing.id });
  }

  const event = (await client.query(
    `insert into events (property_id, person_id, unit_id, type, note)
     values ($1,$2,$3,'move_in_charge_set_confirmed',$4) returning id`,
    [lease.property_id,
     Array.isArray(lease.tenant_ids) && lease.tenant_ids.length ? lease.tenant_ids[0] : null,
     lease.unit_id,
     `Move-in charges confirmed from the governing lease: first period ${start} to ${end}; ${fees.length} required fee${fees.length === 1 ? "" : "s"}.`]
  )).rows[0];

  const authorityBasis = {
    source: "verified_executed_lease",
    executed_lease_record_id: lease.executed_lease_record_id,
    document_reference: lease.executed_document_reference || null,
    document_sha256: lease.executed_document_sha256 || null,
    provider_name: lease.executed_provider_name || null,
    provider_document_id: lease.executed_provider_document_id || null,
    provider_version_id: lease.executed_provider_version_id || null,
  };
  const set = (await client.query(
    `insert into lease_move_in_charge_sets
       (lease_id, property_id, executed_lease_record_id,
        first_period_amount, first_period_start, first_period_end,
        required_fees, payload_hash, confirmed_by_user_id, event_id,
        calculation_note, authority_basis, idempotency_key)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     returning *`,
    [lease.id, lease.property_id, lease.executed_lease_record_id,
     firstAmount, start, end, JSON.stringify(fees), payloadHash,
     confirmed_by_user_id, event.id, calculationNote, JSON.stringify(authorityBasis), idempotency_key]
  )).rows[0];

  const period = monthStart(start);
  const charges = [];
  charges.push((await insertOrAdoptCharge(client, {
    chargeSetId: set.id, lease, requirementKey: "first_month", chargeType: "first_month",
    label: `First rental period (${start} to ${end})`, period, amount: firstAmount, dueDate: ymd(lease.start_date),
  })).charge);

  const deposit = money(lease.security_deposit);
  if (deposit > 0) {
    charges.push((await insertOrAdoptCharge(client, {
      chargeSetId: set.id, lease, requirementKey: "deposit", chargeType: "deposit",
      label: "Security deposit", period, amount: deposit, dueDate: ymd(lease.start_date),
    })).charge);
  }

  const feeTotal = money(fees.reduce((sum, fee) => sum + fee.amount, 0));
  if (feeTotal > 0) {
    charges.push((await insertOrAdoptCharge(client, {
      chargeSetId: set.id, lease, requirementKey: "required_fees", chargeType: "other",
      label: "Required move-in fees", period, amount: feeTotal, dueDate: ymd(lease.start_date),
    })).charge);
  }

  const funds = await readMoveInFunds(client, lease.id);
  return { charge_set: set, charges, idempotent: false, funds };
}

async function readMoveInFunds(client, leaseId) {
  const lease = await loadLease(client, leaseId);
  if (!lease) throw serviceError(404, "lease_not_found", "Lease not found.");
  const set = (await client.query(
    `select * from lease_move_in_charge_sets
      where lease_id=$1 and status='confirmed'
      order by created_at desc limit 1`, [leaseId]
  )).rows[0] || null;
  const charges = (await client.query(
    `select c.*,
            coalesce((select sum(pa.amount_applied)
                        from payment_applications pa
                       where pa.scheduled_charge_id=c.id),0)::numeric(14,2) as applied_total,
            coalesce((select sum(pa.amount_applied)
                        from payment_applications pa
                        join payments p on p.id=pa.payment_id
                       where pa.scheduled_charge_id=c.id
                         and (p.status='cash_proven' or p.processor_settled=true)),0)::numeric(14,2) as cash_proven_total
       from scheduled_charges c
      where c.lease_id=$1 and c.is_move_in_required=true
      order by c.created_at, c.id`, [leaseId]
  )).rows.map((row) => ({
    id: row.id,
    requirement_key: row.move_in_requirement_key,
    label: row.display_label || row.charge_type,
    charge_type: row.charge_type,
    amount: money(row.amount),
    amount_paid: money(row.amount_paid),
    outstanding: money(Math.max(0, Number(row.amount) - Number(row.amount_paid || 0))),
    status: row.status,
    applied_total: money(row.applied_total),
    cash_proven_total: money(row.cash_proven_total),
    cash_proven: money(row.cash_proven_total) >= money(row.amount),
  }));

  const expectedKeys = [];
  if (set) {
    expectedKeys.push("first_month");
    if (money(lease.security_deposit) > 0) expectedKeys.push("deposit");
    const fees = Array.isArray(set.required_fees) ? set.required_fees : [];
    if (money(fees.reduce((sum, fee) => sum + Number(fee.amount || 0), 0)) > 0) expectedKeys.push("required_fees");
  }
  const chargeKeys = new Set(charges.map((c) => c.requirement_key));
  const missing = expectedKeys.filter((key) => !chargeKeys.has(key));
  const fullyApplied = !!set && missing.length === 0 && charges.length > 0 && charges.every((c) => c.status === "paid" && c.outstanding <= 0);
  const totalRequired = money(charges.reduce((sum, c) => sum + c.amount, 0));
  const totalApplied = money(charges.reduce((sum, c) => sum + c.amount_paid, 0));
  const totalCashProven = money(charges.reduce((sum, c) => sum + Math.min(c.cash_proven_total, c.amount), 0));

  return {
    charge_set: set ? {
      id: set.id,
      first_period_start: ymd(set.first_period_start),
      first_period_end: ymd(set.first_period_end),
      required_fees: set.required_fees || [],
      confirmed_at: set.confirmed_at,
      confirmed_by_user_id: set.confirmed_by_user_id,
      calculation_note: set.calculation_note,
      authority_basis: set.authority_basis || null,
    } : null,
    state: !set ? "charge_set_missing" : fullyApplied ? "cleared" : "funds_outstanding",
    cleared: fullyApplied,
    missing_requirements: missing,
    total_required: totalRequired,
    total_applied: totalApplied,
    total_outstanding: money(Math.max(0, totalRequired - totalApplied)),
    total_cash_proven: totalCashProven,
    proof_strength: fullyApplied && totalCashProven >= totalRequired ? "cash_proven" : fullyApplied ? "staff_attested_collected" : "incomplete",
    charges,
  };
}

async function attemptEconomicTenancyActivation(client, {
  lease_id, activated_by_user_id, actor_name = null, source = "operator",
}) {
  if (!activated_by_user_id) throw serviceError(400, "actor_required", "A staff actor is required to activate economic tenancy.");
  const lease = await loadLease(client, lease_id, { forUpdate: true });
  if (!lease) throw serviceError(404, "lease_not_found", "Lease not found.");
  const status = String(lease.lease_status || "").toLowerCase();
  if (status === "active") {
    const funds = await readMoveInFunds(client, lease.id);
    return { activated: false, idempotent: true, lease, funds, receipt: "Economic tenancy was already active." };
  }
  if (status !== "pending") {
    throw serviceError(409, "lease_not_pending", `Only a pending lease can activate economic tenancy (current status '${lease.lease_status}').`);
  }
  const today = (await client.query("select current_date::text as today")).rows[0].today;
  if (ymd(lease.start_date) > today) {
    throw serviceError(409, "lease_not_commenced", "Economic tenancy cannot activate before the governing lease start date.",
      { lease_start_date: ymd(lease.start_date), today });
  }
  const funds = await readMoveInFunds(client, lease.id);
  if (!funds.cleared) {
    throw serviceError(409, "move_in_funds_outstanding", "Required move-in funds are not fully applied to the confirmed charge set.", { funds });
  }

  const personId = Array.isArray(lease.tenant_ids) && lease.tenant_ids.length ? lease.tenant_ids[0] : null;
  const event = (await client.query(
    `insert into events (property_id, person_id, unit_id, type, note)
     values ($1,$2,$3,'economic_tenancy_activated',$4) returning id`,
    [lease.property_id, personId, lease.unit_id,
     `Economic tenancy activated from lease ${lease.id}: term commenced and required move-in charges were fully applied (${funds.proof_strength}). Actor: ${actor_name || activated_by_user_id}.`]
  )).rows[0];

  const updated = (await client.query(
    `update leases
        set lease_status='active',
            economic_tenancy_activated_at=now(),
            economic_tenancy_activated_by_user_id=$2,
            economic_tenancy_activation_event_id=$3
      where id=$1 returning *`,
    [lease.id, activated_by_user_id, event.id]
  )).rows[0];
  await client.query("update units set occupancy_status='occupied', updated_at=now() where id=$1", [lease.unit_id]);
  if (personId) await client.query("update persons set lifecycle_status='tenant' where id=$1", [personId]);

  return {
    activated: true,
    idempotent: false,
    lease: { ...updated, unit_id: lease.unit_id, unit_number: lease.unit_number },
    funds,
    event_id: event.id,
    receipt: `Economic tenancy activated. The lease is active and current on the rent-roll axis; physical possession remains separate until keys are handed over.`,
    source,
  };
}

async function composeMoveInState(client, leaseId) {
  const lease = await loadLease(client, leaseId);
  if (!lease) throw serviceError(404, "lease_not_found", "Lease not found.");
  const funds = await readMoveInFunds(client, lease.id);
  const today = (await client.query("select current_date::text as today")).rows[0].today;
  const personId = Array.isArray(lease.tenant_ids) && lease.tenant_ids.length ? lease.tenant_ids[0] : null;
  const person = personId ? (await client.query("select id, name from persons where id=$1", [personId])).rows[0] || null : null;
  const delivery = (await client.query(
    `select * from obligations
      where related_id=$1 and related_type='lease' and type='move_in_delivery'
      order by created_at desc limit 1`, [lease.id]
  )).rows[0] || null;
  const possession = (await client.query(
    `select id, effective_date, created_at, payload, source
       from unit_events
      where lease_id=$1 and space_id=$2 and event_type='move_in'
        and status not in ('superseded','cancelled')
      order by effective_date desc, created_at desc limit 1`, [lease.id, lease.space_id]
  )).rows[0] || null;
  const outstanding = delivery && Array.isArray(delivery.required_inputs) ? delivery.required_inputs : [];
  const leaseActive = String(lease.lease_status).toLowerCase() === "active";
  const started = ymd(lease.start_date) <= today;

  let state, primaryAction;
  if (!started) {
    state = "forward_lease";
    primaryAction = { code: "none_until_start", label: "Lease has not started", method: null, endpoint: null };
  } else if (!leaseActive && !funds.charge_set) {
    state = "funds_setup_required";
    primaryAction = { code: "confirm_move_in_charges", label: "Confirm Move-In Charges", method: "POST", endpoint: `/operator/leasing/leases/${lease.id}/move-in-charges/confirm` };
  } else if (!leaseActive && !funds.cleared) {
    state = "funds_outstanding";
    primaryAction = { code: "record_apply_payment", label: "Record / Apply Payment", method: null, endpoint: null };
  } else if (!leaseActive) {
    state = "ready_to_activate";
    primaryAction = { code: "activate_tenancy", label: "Activate Tenancy", method: "POST", endpoint: `/operator/leasing/leases/${lease.id}/activate-tenancy` };
  } else if (!funds.cleared) {
    state = "active_money_exception";
    primaryAction = { code: "review_payment_exception", label: "Review Payment Exception", method: null, endpoint: null };
  } else if (possession) {
    state = "possession_delivered";
    primaryAction = { code: "view_completed_move_in", label: "View Completed Move-In", method: null, endpoint: null };
  } else if (outstanding.includes("unit_ready")) {
    state = "unit_not_ready";
    primaryAction = { code: "complete_unit_readiness", label: "Complete Unit Readiness", method: null, endpoint: null };
  } else if (outstanding.includes("keys_access_ready")) {
    state = "keys_not_ready";
    primaryAction = { code: "confirm_keys_prepared", label: "Confirm Keys Prepared", method: "POST", endpoint: `/operator/leasing/leases/${lease.id}/delivery/keys-ready` };
  } else {
    state = "ready_for_handoff";
    primaryAction = { code: "keys_handed_over", label: "Keys Handed Over", method: "POST", endpoint: `/operator/leasing/leases/${lease.id}/delivery/keys-handed-over` };
  }

  return {
    lease: {
      id: lease.id, property_id: lease.property_id, space_id: lease.space_id,
      unit_id: lease.unit_id, unit_number: lease.unit_number,
      start_date: ymd(lease.start_date), end_date: ymd(lease.end_date),
      lease_status: lease.lease_status,
      economic_tenancy_activated_at: lease.economic_tenancy_activated_at || null,
    },
    person,
    state,
    current_rent_roll_tenancy: leaseActive,
    possession: possession ? {
      event_id: possession.id, effective_date: ymd(possession.effective_date), recorded_at: possession.created_at,
      source: possession.source, details: possession.payload || {},
    } : null,
    funds,
    delivery: delivery ? {
      obligation_id: delivery.id, status: delivery.status,
      accountable_role: delivery.assigned_role,
      outstanding_inputs: outstanding,
      unit_ready: !outstanding.includes("unit_ready"),
      keys_access_ready: !outstanding.includes("keys_access_ready"),
    } : null,
    primary_action: primaryAction,
    blockers: [
      ...(!started ? [{ code: "lease_not_commenced", date: ymd(lease.start_date) }] : []),
      ...(!leaseActive && funds.state === "charge_set_missing" ? [{ code: "move_in_charge_set_missing" }] : []),
      ...(!leaseActive && funds.state === "funds_outstanding" ? [{ code: "move_in_funds_outstanding", amount: funds.total_outstanding }] : []),
      ...(leaseActive && !funds.cleared ? [{ code: "move_in_funds_reversed_or_reopened", amount: funds.total_outstanding }] : []),
      ...(leaseActive && outstanding.includes("unit_ready") ? [{ code: "unit_not_ready" }] : []),
      ...(leaseActive && outstanding.includes("keys_access_ready") ? [{ code: "keys_not_ready" }] : []),
    ],
  };
}

module.exports = {
  serviceError,
  confirmMoveInChargeSet,
  readMoveInFunds,
  attemptEconomicTenancyActivation,
  composeMoveInState,
  _internal: { money, ymd, monthStart, normalizeFees, stableHash, loadLease },
};
