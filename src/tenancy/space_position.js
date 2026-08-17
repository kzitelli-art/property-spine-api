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

const {
  classifyPosition,
  TERMINAL_LEASE_STATUSES, CURRENT_ECONOMIC_STATUSES,
  leaseIsValid, datesSpan, normalizedStatus,
} = require("./position_classifier");

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

/*  ══ THE ONE LOAD ═══════════════════════════════════════════════════
 *  Every rentable position at a property, with its WHOLE dated right-set:
 *  every lease on the space, no date filter, ordered by start_date, plus
 *  possession events, notice, turn state and the compat occupancy claim.
 *
 *  ⚠ THE ABSENCE OF A DATE FILTER IS THE ARCHITECTURE, NOT AN OVERSIGHT.
 *  The date has always been applied afterwards, in the pure classifier —
 *  which is exactly why an INTERVAL question needs no new query, no new
 *  table and no new column. The rights are already all here.
 *
 *  Extracted so `spacePosition` (one date) and `classifyPositionForInterval`
 *  (a span) read the SAME rows. Two temporal questions over one truth is a
 *  claim this repo can now make structurally instead of by discipline: if
 *  there were two loaders, they would eventually load two different things.
 *
 *  PURE LOADING. No meaning is decided here; that is the classifier's job. */
async function loadSpaceRows(pool, property_id) {
  if (!property_id) throw new Error("property_id required");
  return (await pool.query(
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
}

/*  Tenant names for a loaded row set. Shared by both temporal readers so a
 *  name is resolved once, the same way, whatever question is being asked.  */
async function loadPersonNames(pool, rows) {
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
  return personNames;
}

async function spacePosition(pool, { property_id, as_of = null }) {
  if (!property_id) throw new Error("property_id required");
  const asOf = as_of || new Date().toISOString().slice(0, 10);
  const rows = await loadSpaceRows(pool, property_id);

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

  // SHARED MEANING lives in position_classifier (pure). Loading stays here.
  const positions = rows.map((row) => classifyPosition(row, { asOf, personNames }));

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
  //  Exported so the interval reader loads the SAME rows rather than
  //  growing a second query beside this one.
  loadSpaceRows,
  loadPersonNames,
  _internal: { leaseIsValid, datesSpan, normalizedStatus, CURRENT_ECONOMIC_STATUSES },
};
