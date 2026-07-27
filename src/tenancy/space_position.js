// ═══════════════════════════════════════════════════════════════════════════
// space_position.js — CANONICAL DATED SPACE POSITION
//
// Contractual tenancy and physical possession are separate axes:
//   active/commercial lease + dates spanning as_of = current economic tenancy
//   pending lease + dates spanning as_of           = activation pending
//   effective move_in without later move_out       = physical possession
//
// A pending lease is never promoted into current rent-roll truth merely because
// its start date arrived. Required move-in funds must first activate the lease.
// ═══════════════════════════════════════════════════════════════════════════

"use strict";

const TERMINAL_LEASE_STATUSES = new Set([
  "cancelled", "terminated", "rescinded", "void", "expired", "superseded",
]);
const CURRENT_ECONOMIC_STATUSES = new Set(["active", "commercial"]);

function normalizedStatus(lease) {
  return String(lease && lease.lease_status || "").toLowerCase();
}
function leaseIsValid(lease) {
  return !!lease && !TERMINAL_LEASE_STATUSES.has(normalizedStatus(lease));
}
function datesSpan(lease, asOf) {
  return !!(lease && lease.start_date && lease.start_date <= asOf && (!lease.end_date || lease.end_date >= asOf));
}
function isFuture(lease, asOf) {
  return !!(lease && lease.start_date && lease.start_date > asOf);
}
// Two non-terminal leases on one space whose date ranges intersect. An open
// end_date runs forever. This is the ONE definition of a contested position.
function rangesOverlap(a, b) {
  if (!a || !b || !a.start_date || !b.start_date) return false;
  const aEnd = a.end_date ? String(a.end_date) : "9999-12-31";
  const bEnd = b.end_date ? String(b.end_date) : "9999-12-31";
  return String(a.start_date) <= bEnd && String(b.start_date) <= aEnd;
}

// HOW WE KNOW A LEASE IS TRUE — one answer, shared by every surface.
//   native_verified          executed through Spine AND required move-in
//                            funds cleared. The governed locked rule.
//   confirmed_opening_import accepted as the property's opening contractual
//                            truth from a governed source.
//   unproven                 anything else. Never counts as locked.
// Deliberately NOT collapsed: an imported lease is real operating truth, but
// it did not pass proof steps it never passed, and the difference stays visible.
function proofBasis(lease) {
  if (!lease) return null;
  if (lease.executed_verified && lease.move_in_funds_cleared) return "native_verified";
  if (lease.source_type === "historical_snapshot" && lease.confidence === "confirmed") return "confirmed_opening_import";
  return "unproven";
}

function tenantList(lease, personNames) {
  return (lease.tenant_ids || []).filter(Boolean).map((person_id) => ({
    person_id,
    name: personNames.has(String(person_id)) ? personNames.get(String(person_id)) : null,
  }));
}

async function recordEffectivePossession(client, {
  kind,
  lease_id,
  unit_id = null,
  property_id = null,
  effective_date,
  actor = null,
  source = null,
  space_id_hint = null,
  details = null,
}) {
  if (!client || typeof client.query !== "function") throw new Error("recordEffectivePossession requires a database client");
  if (!['move_in', 'move_out'].includes(kind)) {
    throw Object.assign(new Error("kind must be move_in or move_out"), { code: "BAD_KIND" });
  }
  if (!lease_id) throw Object.assign(new Error("lease_id required for effective possession"), { code: "NO_LEASE" });
  if (!effective_date) throw Object.assign(new Error("effective_date required for effective possession"), { code: "NO_EFFECTIVE_DATE" });

  const leaseQ = await client.query(
    `select l.id, l.space_id, l.property_id, l.start_date, l.end_date, l.lease_status,
            s.unit_id as lease_unit_id, u.property_id as space_property_id
       from leases l
       left join spaces s on s.id=l.space_id
       left join units u on u.id=s.unit_id
      where l.id=$1`,
    [lease_id]
  );
  if (leaseQ.rows.length === 0) throw Object.assign(new Error("lease not found"), { code: "NO_LEASE" });
  const lease = leaseQ.rows[0];

  let space_id = space_id_hint || lease.space_id || null;
  if (!space_id && unit_id) {
    const one = await client.query("select id from spaces where unit_id=$1 order by created_at", [unit_id]);
    if (one.rows.length !== 1) {
      throw Object.assign(new Error("cannot resolve space: lease has no space_id and unit is not single-space"), { code: "AMBIGUOUS_SPACE" });
    }
    space_id = one.rows[0].id;
  }
  if (!space_id) throw Object.assign(new Error("cannot resolve space for possession event"), { code: "AMBIGUOUS_SPACE" });

  const spaceQ = await client.query(
    `select s.id, s.unit_id, u.property_id
       from spaces s join units u on u.id=s.unit_id
      where s.id=$1`,
    [space_id]
  );
  if (spaceQ.rows.length === 0) throw Object.assign(new Error("space not found"), { code: "BAD_SPACE" });
  const space = spaceQ.rows[0];
  const resolvedProperty = property_id || lease.property_id || space.property_id;
  const resolvedUnit = unit_id || space.unit_id;

  if (lease.space_id && lease.space_id !== space_id) {
    throw Object.assign(new Error("possession space differs from the governing lease"), { code: "SPACE_MISMATCH" });
  }
  if (resolvedUnit !== space.unit_id) {
    throw Object.assign(new Error("possession unit differs from the governing space"), { code: "UNIT_MISMATCH" });
  }
  if (resolvedProperty !== space.property_id || (lease.property_id && lease.property_id !== space.property_id)) {
    throw Object.assign(new Error("possession space is outside the lease/property wall"), { code: "PROPERTY_MISMATCH" });
  }

  if (kind === "move_out") {
    const held = await client.query(
      `select 1 from unit_events
        where lease_id=$1 and space_id=$2 and event_type='move_in'
          and status not in ('superseded','cancelled')
          and not exists (
            select 1 from unit_events o
             where o.lease_id=$1 and o.space_id=$2 and o.event_type='move_out'
               and o.status not in ('superseded','cancelled')
          )
        limit 1`,
      [lease_id, space_id]
    );
    if (held.rows.length === 0) {
      throw Object.assign(new Error("no live move_in for this lease+space — move_out cannot end possession that was never recorded"), { code: "NO_POSSESSION_TO_END" });
    }
  }

  const existing = await client.query(
    `select * from unit_events
      where lease_id=$1 and space_id=$2 and event_type=$3
        and status not in ('superseded','cancelled')
      order by created_at desc limit 1`,
    [lease_id, space_id, kind]
  );
  if (existing.rows.length) {
    return { event: existing.rows[0], created: false, idempotent: true, space_id };
  }

  const payload = {
    lease_id,
    resolved_from: space_id_hint ? "explicit_space" : (lease.space_id ? "lease.space_id" : "whole_unit_sole_space"),
    actor,
    ...(details && typeof details === "object" ? details : {}),
  };
  const inserted = await client.query(
    `insert into unit_events
       (unit_id, property_id, event_type, effective_date, payload, source, status, lease_id, space_id)
     values ($1,$2,$3,$4,$5,$6,'actioned',$7,$8)
     returning *`,
    [resolvedUnit, resolvedProperty, kind, effective_date, JSON.stringify(payload), source || "possession", lease_id, space_id]
  );
  return { event: inserted.rows[0], created: true, idempotent: false, space_id };
}

async function spacePosition(pool, { property_id, as_of = null }) {
  if (!property_id) throw new Error("property_id required");
  const asOf = as_of || new Date().toISOString().slice(0, 10);
  const rows = (await pool.query(
    `select
        s.id as space_id,
        s.unit_id,
        u.unit_number,
        s.space_label,
        (select json_agg(json_build_object(
            'id', l.id, 'lease_status', l.lease_status,
            'start_date', l.start_date, 'end_date', l.end_date,
            'rent', l.rent, 'tenant_ids', l.tenant_ids,
            'economic_tenancy_activated_at', l.economic_tenancy_activated_at,
            -- PROOF INPUTS (shared derivation). Carried here so every surface
            -- reads ONE answer to "how do we know this lease is true" instead
            -- of each re-deriving it. native = executed AND funded through
            -- Spine; opening = accepted historical import; else unproven.
            'source_type', l.source_type,
            'confidence', l.confidence,
            'executed_verified', (er.id is not null),
            -- FUNDED means every required move-in charge is paid with nothing
            -- outstanding. Absence of a charge set is NOT funded.
            'move_in_funds_cleared', (
              exists (select 1 from scheduled_charges c
                       where c.lease_id = l.id and c.is_move_in_required = true)
              and not exists (select 1 from scheduled_charges c
                       where c.lease_id = l.id and c.is_move_in_required = true
                         and (c.status <> 'paid'
                              or coalesce(c.amount,0) - coalesce(c.amount_paid,0) > 0))
            ))
           order by l.start_date, l.created_at)
           from leases l
           left join executed_lease_records er
             on er.lease_id = l.id and er.record_state = 'verified'
          where l.space_id=s.id) as leases,
        (select json_agg(json_build_object(
            'event_type', ue.event_type, 'effective_date', ue.effective_date,
            'created_at', ue.created_at, 'status', ue.status,
            'payload', ue.payload, 'source', ue.source)
           order by ue.effective_date, ue.created_at)
           from unit_events ue
          where ue.space_id=s.id
            and ue.event_type in ('move_in','move_out')
            and ue.status not in ('superseded','cancelled')) as possession_events,
        (select ue.effective_date from unit_events ue
          where ue.space_id=s.id and ue.event_type='notice_given'
            and ue.status='scheduled' order by ue.effective_date desc limit 1) as notice_date,
        (select t.status from turnovers t
          where t.unit_id=u.id and t.status='in_progress' limit 1) as turn_status,
        u.occupancy_status as compat_occupancy
      from spaces s
      join units u on u.id=s.unit_id
     where u.property_id=$1
     order by u.unit_number, s.space_label`,
    [property_id]
  )).rows;

  const tenantIds = new Set();
  for (const row of rows) {
    for (const lease of row.leases || []) {
      for (const id of lease.tenant_ids || []) if (id) tenantIds.add(String(id));
    }
  }
  const personNames = new Map();
  if (tenantIds.size) {
    const people = await pool.query("select id, name from persons where id=any($1::uuid[])", [[...tenantIds]]);
    for (const p of people.rows) personNames.set(String(p.id), p.name || null);
  }

  const positions = rows.map((row) => {
    const leases = (row.leases || []).filter(leaseIsValid);
    const current = leases.find((lease) => CURRENT_ECONOMIC_STATUSES.has(normalizedStatus(lease)) && datesSpan(lease, asOf)) || null;
    const activationPending = leases.find((lease) => normalizedStatus(lease) === "pending" && datesSpan(lease, asOf)) || null;
    const future = leases.find((lease) => isFuture(lease, asOf)) || null;

    const events = row.possession_events || [];
    const ins = events.filter((e) => e.event_type === "move_in");
    const outs = events.filter((e) => e.event_type === "move_out");
    const lastIn = ins.length ? ins[ins.length - 1] : null;
    const lastOut = outs.length ? outs[outs.length - 1] : null;
    const possessed = !!lastIn && (!lastOut || lastOut.effective_date < lastIn.effective_date ||
      (lastOut.effective_date === lastIn.effective_date && String(lastOut.created_at) < String(lastIn.created_at)));
    const turning = row.turn_status === "in_progress";

    let availability_state = "unavailable";
    let available_from = null;
    if (current) {
      availability_state = row.notice_date ? "on_notice" : "unavailable";
      available_from = row.notice_date || null;
    } else if (activationPending) {
      availability_state = "committed_activation_pending";
    } else if (possessed) {
      availability_state = "unavailable";
    } else if (turning) {
      availability_state = "vacant_turning";
    } else if (future) {
      availability_state = "committed_future";
      available_from = future.start_date;
    } else {
      availability_state = "ready_now";
      available_from = asOf;
    }

    let next_required_action = null;
    let reason = null;
    if (activationPending) {
      next_required_action = "economic_tenancy_activation_required";
      reason = `Lease commenced ${activationPending.start_date}, but economic tenancy is not active — confirm and collect required move-in charges before current rent-roll activation.`;
    } else if (current && !possessed) {
      next_required_action = "possession_outstanding";
      reason = `Lease is active from ${current.start_date}; resident is current on the rent-roll axis, but keys/access handoff has not been recorded.`;
    } else if (future && possessed) {
      next_required_action = "review_early_possession";
      reason = `Possession was recorded before the committed lease start ${future.start_date}.`;
    } else if (future && turning) {
      next_required_action = "turn_before_committed_start";
      reason = `Committed for ${future.start_date}, but the unit turn is still in progress.`;
    } else if (!current && !activationPending && !future && possessed) {
      next_required_action = "possession_without_current_lease";
      reason = "Someone is in possession with no active current lease on the space.";
    }

    const shapeLease = (lease) => lease ? {
      lease_id: lease.id,
      lease_status: lease.lease_status,
      start_date: lease.start_date,
      end_date: lease.end_date || null,
      rent: lease.rent == null ? null : Number(lease.rent),
      tenants: tenantList(lease, personNames),
      proof_basis: proofBasis(lease),
    } : null;

    // ── SHARED DERIVATIONS (one answer, every surface) ────────────────
    // These used to be re-derived per screen: notice in three separate SQL
    // fragments, conflict nowhere, successor nowhere. Deriving them once here
    // is what keeps Current Rent Roll, Renewals, Availability and Future Rent
    // Roll as different VIEWS of one truth rather than four meanings of it.

    // CONFLICT: two non-terminal leases whose date ranges overlap. A contested
    // position is NOT a successor relationship — we cannot say which lease
    // governs, so it must never be silently resolved to the first match.
    const conflicting = [];
    for (let i = 0; i < leases.length; i++) {
      for (let j = i + 1; j < leases.length; j++) {
        if (rangesOverlap(leases[i], leases[j])) {
          conflicting.push(leases[i].id, leases[j].id);
        }
      }
    }
    const conflict_ids = [...new Set(conflicting)];

    // SUCCESSOR of the lease that governs as_of: the earliest non-terminal
    // lease starting at or after it ends, that does NOT overlap it (an
    // overlapping lease is a conflict, not a succession).
    const governing = current || activationPending || null;
    let successor = { state: "none", lease_id: null, proof_basis: null, locked: false };
    if (governing && governing.end_date) {
      const next = leases
        .filter((l) => l.id !== governing.id
          && l.start_date && String(l.start_date) >= String(governing.end_date)
          && !rangesOverlap(l, governing))
        .sort((a, b) => String(a.start_date).localeCompare(String(b.start_date)))[0] || null;
      if (next) {
        // LOCKED uses the SAME governed rule as everywhere else: executed AND
        // funded. A 'pending' lease_status alone never closes the economic
        // position — that is precisely the certainty this system must not fake.
        const locked = !!(next.executed_verified && next.move_in_funds_cleared);
        successor = {
          state: locked ? "locked" : "pending",
          lease_id: next.id,
          proof_basis: proofBasis(next),
          locked,
        };
      }
    }

    return {
      space_id: row.space_id,
      unit_id: row.unit_id,
      unit_number: row.unit_number,
      space_label: row.space_label,
      current_lease_position: shapeLease(current),
      activation_pending_lease_position: shapeLease(activationPending),
      future_lease_position: shapeLease(future),
      current_possession: possessed ? {
        since: lastIn.effective_date,
        event_recorded_at: lastIn.created_at,
        source: lastIn.source || null,
        details: lastIn.payload || {},
      } : null,
      economic_tenancy_state: current ? "active" : activationPending ? "activation_pending" : future ? "forward" : "none",
      possession_state: possessed ? "delivered" : "pending",
      physical_readiness: turning ? "turning" : "ready",
      availability_state,
      available_from,
      reason,
      next_required_action,
      // ── shared facts (additive; existing consumers are unaffected) ──
      notice_state: row.notice_date ? "on_notice" : "none",
      notice_date: row.notice_date || null,
      conflict_state: conflict_ids.length ? "conflicted" : "clear",
      conflicting_lease_ids: conflict_ids,
      successor,
      _compat_occupancy: row.compat_occupancy,
    };
  });

  return {
    property_id,
    as_of: asOf,
    count: positions.length,
    positions,
    summary: {
      current_economic_tenancies: positions.filter((p) => !!p.current_lease_position).length,
      activation_pending: positions.filter((p) => !!p.activation_pending_lease_position).length,
      possession_pending: positions.filter((p) => !!p.current_lease_position && !p.current_possession).length,
      possessed: positions.filter((p) => !!p.current_possession).length,
    },
  };
}

module.exports = {
  recordEffectivePossession,
  spacePosition,
  _internal: { leaseIsValid, datesSpan, normalizedStatus, CURRENT_ECONOMIC_STATUSES },
};
