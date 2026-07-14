// ═══════════════════════════════════════════════════════════════════════════
//  space_position.js — CANONICAL DATED SPACE POSITION
//
//  Two exports:
//   1. recordEffectivePossession(client, {...})  — the shared possession-event
//      writer used by BOTH move-in approval and move-out. Effective, space_id-
//      anchored, idempotent (DB invariant backstop + supersede-not-duplicate).
//   2. spacePosition(pool, { property_id, as_of })  — the server-authored dated
//      position per space, assembled from contractual DATES + possession events
//      + readiness + notice/turn, emitting distinct fields (never one status).
//
//  DOCTRINE (Fable-locked, v4 spec):
//   · "current" is DATE-DERIVED, never a stored 'active', never a move-in side
//     effect. lease_status = legal operativeness only; the date window is derived.
//   · "valid lease" = executed/application-linked, NO cancellation/termination/
//     rescission/superseding-correction fact. Validity is checked BEFORE dates.
//   · possession = effective move_in with no superseding move_out, per (lease,space).
//   · occupancy_status is a COMPATIBILITY CACHE downstream of the event, not truth.
//   · conflicts (committed future over open possession / unfinished turn / a
//     commenced lease with no possession) surface as DISTINCT fields + a
//     next_required_action — never a silently chosen status.
// ═══════════════════════════════════════════════════════════════════════════

// Facts that make a lease NOT valid for position purposes. lease_status carries
// legal operativeness; these are the non-current terminal/void meanings. Dates
// are only consulted for leases that pass this gate.
const INVALID_LEASE_STATUSES = new Set(["cancelled", "terminated", "rescinded", "void", "expired"]);

function leaseIsValid(lease) {
  if (!lease) return false;
  const st = (lease.lease_status || "").toLowerCase();
  if (INVALID_LEASE_STATUSES.has(st)) return false;
  // a superseding correction is modeled as a status too (superseded); exclude it.
  if (st === "superseded") return false;
  return true;
}

// ── 1. SHARED EFFECTIVE-POSSESSION WRITER ──────────────────────────────────
// kind: 'move_in' | 'move_out'. Resolves the authoritative space from the lease
// (the lease commits a specific bed); whole-unit leases carry the unit's sole
// space. Idempotent: the DB partial-unique index guarantees one live effective
// event per (lease, space); a correction supersedes the prior, never inserts a
// competing effective row. Caller owns the transaction (client, mid-txn).
async function recordEffectivePossession(client, {
  kind, lease_id, unit_id, property_id, effective_date, actor, source, space_id_hint = null,
}) {
  if (kind !== "move_in" && kind !== "move_out") {
    throw Object.assign(new Error("kind must be move_in or move_out"), { code: "BAD_KIND" });
  }
  if (!lease_id) throw Object.assign(new Error("lease_id required for effective possession"), { code: "NO_LEASE" });

  // Resolve space: explicit hint (verified) → lease.space_id → whole-unit sole space.
  let space_id = null;
  const leaseQ = await client.query("select id, space_id, property_id from leases where id=$1", [lease_id]);
  if (leaseQ.rows.length === 0) throw Object.assign(new Error("lease not found"), { code: "NO_LEASE" });
  const lease = leaseQ.rows[0];
  const resolvedProperty = property_id || lease.property_id;

  if (space_id_hint) {
    const okS = await client.query(
      "select id, unit_id from spaces where id=$1", [space_id_hint]);
    if (okS.rows.length === 0) throw Object.assign(new Error("space_id_hint not found"), { code: "BAD_SPACE" });
    space_id = space_id_hint;
  } else if (lease.space_id) {
    space_id = lease.space_id;
  } else if (unit_id) {
    const oneSpace = await client.query(
      "select id from spaces where unit_id=$1", [unit_id]);
    if (oneSpace.rows.length === 1) space_id = oneSpace.rows[0].id;
    else throw Object.assign(new Error("cannot resolve space: lease has no space_id and unit is not single-space"), { code: "AMBIGUOUS_SPACE" });
  } else {
    throw Object.assign(new Error("cannot resolve space for possession event"), { code: "AMBIGUOUS_SPACE" });
  }

  const resolvedUnit = unit_id || (await client.query(
    "select unit_id from spaces where id=$1", [space_id])).rows[0]?.unit_id;

  // POSSESSION MUST EXIST BEFORE IT CAN END (Fable #1): a move_out is only a
  // truthful fact when there is a LIVE effective move_in for this (lease, space).
  // A turnover created for a unit nobody currently possesses (a turn that is not
  // a resident surrender, or a lease that never took possession) must NOT encode
  // a canonical move_out. Refuse, honestly — do not write a false fact.
  if (kind === "move_out") {
    const heldQ = await client.query(
      `select 1 from unit_events
        where lease_id=$1 and space_id=$2 and event_type='move_in'
          and status not in ('superseded','cancelled') limit 1`,
      [lease_id, space_id]
    );
    if (heldQ.rows.length === 0) {
      throw Object.assign(
        new Error("no live move_in for this lease+space — a move_out cannot end possession that was never recorded"),
        { code: "NO_POSSESSION_TO_END" }
      );
    }
  }

  // Idempotency: is there already a LIVE effective event of this kind for
  // (lease, space)? If so, no-op (return it). This makes repeat/concurrent
  // approval safe above the DB index (which is the hard backstop).
  const existing = await client.query(
    `select * from unit_events
      where lease_id=$1 and space_id=$2 and event_type=$3
        and status not in ('superseded','cancelled')
      limit 1`,
    [lease_id, space_id, kind]
  );
  if (existing.rows.length) {
    return { event: existing.rows[0], created: false, idempotent: true, space_id };
  }

  const payload = { lease_id, resolved_from: space_id_hint ? "hint" : (lease.space_id ? "lease.space_id" : "whole_unit_sole_space") };
  const ins = await client.query(
    `insert into unit_events (unit_id, property_id, event_type, effective_date, payload, source, status, lease_id, space_id)
     values ($1,$2,$3,$4,$5,$6,'effective',$7,$8) returning *`,
    [resolvedUnit, resolvedProperty, kind, effective_date, JSON.stringify(payload), source || "possession", lease_id, space_id]
  );
  return { event: ins.rows[0], created: true, idempotent: false, space_id };
}

// ── 2. DATED SPACE POSITION (server-authored read) ─────────────────────────
// One row per SPACE. Distinct fields; the renderer displays, never re-derives.
async function spacePosition(pool, { property_id, as_of = null }) {
  const asOf = as_of || new Date().toISOString().slice(0, 10);

  // Pull every space + the lease facts + possession events + turn/notice state.
  // Leases are pulled WITH status so validity is applied in JS (INVALID set),
  // then current-vs-forward is a pure DATE test on the valid ones.
  const rows = (await pool.query(
    `select
        s.id                as space_id,
        s.unit_id,
        u.unit_number,
        s.space_label,
        -- all leases on this space (valid-or-not; filtered in JS)
        (select json_agg(json_build_object(
            'id', l.id, 'lease_status', l.lease_status,
            'start_date', l.start_date, 'end_date', l.end_date,
            'rent', l.rent, 'tenant_ids', l.tenant_ids))
           from leases l where l.space_id = s.id)          as leases,
        -- live effective possession events on this space
        (select json_agg(json_build_object(
            'event_type', ue.event_type, 'effective_date', ue.effective_date, 'status', ue.status)
            order by ue.effective_date)
           from unit_events ue
          where ue.space_id = s.id
            and ue.event_type in ('move_in','move_out')
            and ue.status not in ('superseded','cancelled'))  as possession_events,
        -- open notice on this space (scheduled intent)
        (select ue.effective_date from unit_events ue
          where ue.space_id = s.id and ue.event_type='notice_given'
            and ue.status='scheduled' order by ue.effective_date desc limit 1) as notice_date,
        -- open turn on the unit
        (select t.status from turnovers t
          where t.unit_id = u.id and t.status='in_progress' limit 1)          as turn_status,
        u.occupancy_status                                                     as compat_occupancy
      from spaces s
      join units u on u.id = s.unit_id
     where u.property_id = $1
     order by u.unit_number, s.space_label`,
    [property_id]
  )).rows;

  const positions = rows.map(r => {
    const leases = r.leases || [];
    const valid = leases.filter(leaseIsValid);

    // current contractual position: valid lease, start<=asOf<=end
    const current = valid.find(l =>
      l.start_date && l.start_date <= asOf &&
      (!l.end_date || l.end_date >= asOf));
    // future contractual position: valid lease, start>asOf
    const future = valid.find(l => l.start_date && l.start_date > asOf);

    // possession: live effective move_in with no later move_out
    const pe = r.possession_events || [];
    const lastIn = [...pe].filter(e => e.event_type === "move_in").pop();
    const lastOut = [...pe].filter(e => e.event_type === "move_out").pop();
    const possessed = !!lastIn && (!lastOut || lastOut.effective_date < lastIn.effective_date);

    // readiness
    const turning = r.turn_status === "in_progress";

    // availability (aligned with availability.js precedence, position-scoped)
    let availability_state, available_from = null;
    if (!current && !possessed && turning) { availability_state = "vacant_turning"; }
    else if (!current && future) { availability_state = "committed_future"; available_from = future.start_date; }
    else if (!current && !possessed) { availability_state = "ready_now"; available_from = asOf; }
    else if (current && r.notice_date) { availability_state = "on_notice"; available_from = r.notice_date; }
    else { availability_state = "unavailable"; }

    // conflicts → next_required_action (never a silent status)
    let next_required_action = null, reason = null;
    if (current && !possessed) {
      // commenced lease, no possession — rent owed, keys/readiness unresolved
      next_required_action = "possession_outstanding";
      reason = `Lease commenced ${current.start_date} but no move-in recorded — resident owes rent while possession is unresolved.`;
    } else if (future && possessed) {
      next_required_action = "review_early_possession";
      reason = `Possession recorded before the committed lease start ${future.start_date}.`;
    } else if (future && turning) {
      next_required_action = "turn_before_committed_start";
      reason = `Committed for ${future.start_date} but the unit turn is still in progress.`;
    } else if (!current && !future && possessed) {
      next_required_action = "possession_without_current_lease";
      reason = `Someone is in possession with no valid current lease on the space.`;
    }

    return {
      space_id: r.space_id, unit_id: r.unit_id, unit_number: r.unit_number, space_label: r.space_label,
      current_lease_position: current ? { lease_id: current.id, start_date: current.start_date, end_date: current.end_date, rent: current.rent } : null,
      future_lease_position: future ? { lease_id: future.id, start_date: future.start_date, rent: future.rent } : null,
      current_possession: possessed ? { since: lastIn.effective_date } : null,
      physical_readiness: turning ? "turning" : "ready",
      availability_state,
      available_from,
      reason,
      next_required_action,
      _compat_occupancy: r.compat_occupancy, // visibility into the cache during migration
    };
  });

  return { as_of: asOf, property_id, count: positions.length, positions };
}

module.exports = { recordEffectivePossession, spacePosition, leaseIsValid, INVALID_LEASE_STATUSES };
