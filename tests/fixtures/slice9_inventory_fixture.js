// ════════════════════════════════════════════════════════════════════
//  slice9_inventory_fixture.js — DETERMINISTIC INVENTORY, SEEDED BY THE
//  PROOF THAT USES IT.
//
//  WHY THIS EXISTS
//  availability_canonical_proof and cross_surface_invariants both hardcoded
//  the Demo Building property id and seeded NOTHING. On a database where that
//  property has no spaces they failed 4 and 1 assertions respectively — not
//  because the product was wrong, but because the proofs asserted over an
//  empty set. Empty-population failures and real defects are indistinguishable
//  in that shape, and a proof that passes vacuously is worse than one that
//  fails honestly.
//
//  This builds one SCRATCH PROPERTY with every position shape the canonical
//  classifier can produce, inside the caller's TRANSACTION. Nothing is
//  committed; the caller rolls back. It never touches Demo Building, and it
//  never depends on a row it did not create.
//
//  EVERY FIXTURE IS NAMED. Assertions key on the name, never on ordinal
//  position or on `order by ... limit 1` — now() is transaction time, so every
//  row seeded here shares one created_at and time-ordering is arbitrary. That
//  exact trap produced a false green in a prior session.
//
//  WRITES ONLY INSIDE THE CALLER'S TRANSACTION.
// ════════════════════════════════════════════════════════════════════

"use strict";

const DAY = 86400000;
const ymd = (d) => new Date(d).toISOString().slice(0, 10);

/**
 * Seed the scratch property. Call inside an open transaction; roll back after.
 *
 * @param c  an open pg client (NOT a pool — this must share the caller's tx)
 * @returns  { property_id, asOf, units: {name -> {unit_id, space_ids[]}}, ids }
 */
async function seedInventory(c, { as_of = null } = {}) {
  const asOf = as_of || ymd(Date.now());
  const future = ymd(Date.now() + 60 * DAY);
  const farFuture = ymd(Date.now() + 120 * DAY);
  const past = ymd(Date.now() - 300 * DAY);
  const soon = ymd(Date.now() + 20 * DAY);

  const one = async (sql, args) => (await c.query(sql, args)).rows[0];

  const prop = await one(
    `insert into properties (name, leasing_basis) values ($1,'unknown') returning id`,
    ["Slice 9 scratch property (transaction-scoped)"]
  );
  const property_id = prop.id;

  // A user + person for certifications and tenancies.
  const user = await one(
    `insert into users (name, email, role, is_active, status, account_kind)
     values ('Slice 9 fixture actor', $1, 'property_manager', true, 'active', 'internal_qa')
     returning id`,
    [`slice9.fixture.${Date.now()}@local.invalid`]
  );
  const person = await one(
    `insert into persons (name, lifecycle_status) values ('Slice 9 fixture resident','tenant') returning id`
  );

  const units = {};

  // unit + N spaces. occupancy_status drives the EVIDENCE axis; operating_use
  // and is_down drive the marketing guards that outrank everything else.
  async function unit(name, {
    spaces = 1, occupancy = "vacant", operating_use = "standard", is_down = false,
    use_type = "residential",
  } = {}) {
    const u = await one(
      `insert into units (property_id, unit_number, occupancy_status, operating_use, is_down)
       values ($1,$2,$3,$4,$5) returning id`,
      [property_id, name, occupancy, operating_use, is_down]
    );
    // ── THE DATABASE ALREADY MADE ONE ────────────────────────────────
    //  trg_unit_space (ensure_unit_space) inserts a '(whole unit)' space on
    //  every unit AFTER INSERT. A unit is therefore never born space-less.
    //  The fixture ADOPTS that space rather than adding a second one — an
    //  earlier draft inserted its own and produced 38 spaces for 19 units,
    //  turning every intended sole-space unit into a multi-space refusal.
    //  Zero-space is reached by DELETING the auto-created space, which is the
    //  only way that shape exists at all.
    const auto = (await c.query(
      `update spaces set position_kind='unit', use_type=$2
        where unit_id=$1 returning id`, [u.id, use_type])).rows[0];

    const space_ids = [];
    if (spaces === 0) {
      await c.query(`delete from spaces where unit_id=$1`, [u.id]);
    } else {
      space_ids.push(auto.id);
      for (let i = 1; i < spaces; i++) {
        const s = await one(
          `insert into spaces (unit_id, space_label, position_kind, use_type)
           values ($1,$2,'bed',$3) returning id`,
          [u.id, `Bed ${i + 1}`, use_type]
        );
        space_ids.push(s.id);
      }
      // A genuinely multi-space unit has no '(whole unit)' position.
      if (spaces > 1) {
        await c.query(`update spaces set space_label='Bed 1', position_kind='bed'
                        where id=$1`, [auto.id]);
      }
    }
    units[name] = { unit_id: u.id, space_ids, space_id: space_ids[0] || null };
    return units[name];
  }

  async function lease(space_id, {
    status = "active", start, end = null, rent = 1500,
    executed = false, funded = false,
    source_type = null, confidence = null,
  }) {
    const l = await one(
      `insert into leases (property_id, space_id, lease_status, start_date, end_date, rent,
                           tenant_ids, source_type, confidence)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id`,
      [property_id, space_id, status, start, end, rent, [person.id], source_type, confidence]
    );
    // executed_verified ⇐ a verified executed_lease_record exists
    if (executed) {
      const app = await one(
        `insert into lease_applications (property_id, applicant_name, status, person_id)
         values ($1,'Slice 9 fixture applicant','active',$2) returning id`,
        [property_id, person.id]
      );
      // executed_lease_records.event_id references `events` (the durable
      // history table), NOT `unit_events` (the scheduled-state table).
      const ev = await one(
        `insert into events (property_id, unit_id, type, note)
         select $1, unit_id, 'lease_executed', 'Slice 9 fixture executed record'
           from spaces where id=$2 returning id`,
        [property_id, space_id]
      );
      await c.query(
        `insert into executed_lease_records
           (application_id, property_id, space_id, rent, security_deposit,
            lease_start_date, lease_end_date, payload_hash, executed_at, signers,
            execution_channel, verified_by_user_id, event_id, record_state,
            document_sha256, lease_id)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'paper',$11,$12,'verified',$13,$14)`,
        [app.id, property_id, space_id, rent, rent, start, end || farFuture,
         "fixture-hash", start, JSON.stringify([{ name: "Fixture Signer" }]),
         user.id, ev.id, "fixture-sha", l.id]
      );
    }
    // move_in_funds_cleared ⇐ a required move-in charge set exists AND is fully paid.
    // Absence of a charge set is NOT funded — that is deliberate, so an
    // "unfunded" fixture simply omits the charge.
    if (funded) {
      await c.query(
        `insert into scheduled_charges (property_id, lease_id, period, amount, amount_paid,
                                        status, is_move_in_required)
         values ($1,$2,$3,$4,$4,'paid',true)`,
        [property_id, l.id, start, rent]
      );
    }
    return l.id;
  }

  const ids = {};

  // ── 1. SOLE-SPACE MARKETABLE ────────────────────────────────────────
  await unit("A-marketable");

  // ── 2. SOLE-SPACE UPCOMING, GOVERNED DATE (notice on a current lease) ─
  const up = await unit("B-upcoming", { occupancy: "occupied" });
  ids.upcoming_lease = await lease(up.space_id, { status: "active", start: past, end: farFuture });
  await c.query(
    `insert into unit_events (unit_id, space_id, event_type, effective_date, status)
     values ($1,$2,'notice_given',$3,'scheduled')`,
    [up.unit_id, up.space_id, soon]
  );

  // ── 3. SOLE-SPACE TURNOVER, UNKNOWN DATE ────────────────────────────
  const tv = await unit("C-turnover");
  await c.query(
    `insert into turnovers (property_id, unit_id, status) values ($1,$2,'in_progress')`,
    [property_id, tv.unit_id]
  );

  // ── 4. MODEL POSITION ───────────────────────────────────────────────
  await unit("D-model", { operating_use: "model" });

  // ── 5. DOWN POSITION ────────────────────────────────────────────────
  await unit("E-down", { is_down: true });

  // ── 6. EVIDENCE DISAGREEMENT — claimed occupied, no spanning lease ──
  await unit("F-evidence-disagrees", { occupancy: "occupied" });

  // ── 7. CURRENT ACTIVE LEASE (occupied, no notice) ───────────────────
  const cur = await unit("G-occupied", { occupancy: "occupied" });
  ids.current_lease = await lease(cur.space_id, { status: "active", start: past, end: farFuture });

  // ── 8. ACTIVATION-PENDING — a lease that has COMMENCED, not funded ──
  //  occupancy_status stays 'vacant': it is the CONTRACTED rent-roll axis, and
  //  economic tenancy has not activated, so this position is not yet an
  //  occupied rent-roll line. Claiming 'occupied' here is not a harmless
  //  detail — evidence disagreement OUTRANKS activation_pending in
  //  marketingState, so the position would report evidence_disagrees and the
  //  activation-pending state would never be reachable in this fixture.
  const ap = await unit("H-activation-pending", { occupancy: "vacant" });
  ids.activation_pending_lease = await lease(ap.space_id, { status: "pending", start: past, end: farFuture });

  // ── 9. STANDALONE PENDING FUTURE LEASE (vacant position) ────────────
  const sp = await unit("I-future-pending");
  ids.future_pending_lease = await lease(sp.space_id, { status: "pending", start: future, end: farFuture });

  // ── 10. STANDALONE LOCKED FUTURE LEASE — executed AND funded ────────
  const sl = await unit("J-future-locked");
  ids.future_locked_lease = await lease(sl.space_id, {
    status: "pending", start: future, end: farFuture, executed: true, funded: true });

  // ── 11. CONFIRMED-OPENING FUTURE LEASE — governed import, not native ─
  //  Real operating truth that suppresses marketing, but it never passed
  //  native execution+funding. proof_basis must stay confirmed_opening_import
  //  and the state must be pending, never locked.
  const co = await unit("K-future-confirmed-opening");
  ids.confirmed_opening_lease = await lease(co.space_id, {
    status: "pending", start: future, end: farFuture,
    source_type: "historical_snapshot", confidence: "confirmed" });

  // ── 12. CURRENT LEASE WITH PENDING SUCCESSOR ────────────────────────
  const ps = await unit("L-successor-pending", { occupancy: "occupied" });
  ids.succ_pending_current = await lease(ps.space_id, { status: "active", start: past, end: soon });
  ids.succ_pending_next = await lease(ps.space_id, { status: "pending", start: future, end: farFuture });

  // ── 13. CURRENT LEASE WITH LOCKED SUCCESSOR ─────────────────────────
  const ls = await unit("M-successor-locked", { occupancy: "occupied" });
  ids.succ_locked_current = await lease(ls.space_id, { status: "active", start: past, end: soon });
  ids.succ_locked_next = await lease(ls.space_id, {
    status: "pending", start: future, end: farFuture, executed: true, funded: true });

  // ── 14. CANCELLED FUTURE LEASE — terminal, must create NO commitment ─
  const cn = await unit("N-future-cancelled");
  ids.cancelled_lease = await lease(cn.space_id, { status: "cancelled", start: future, end: farFuture });

  // ── 15. OVERLAPPING LEASE CONFLICT ──────────────────────────────────
  const cf = await unit("O-conflict", { occupancy: "occupied" });
  ids.conflict_a = await lease(cf.space_id, { status: "active", start: past, end: farFuture });
  ids.conflict_b = await lease(cf.space_id, { status: "active", start: soon, end: farFuture });

  // ── 16. READINESS UNKNOWN — walk assigned, never answered ───────────
  const ru = await unit("P-readiness-unknown");
  await c.query(
    `insert into obligations (property_id, unit_id, type, status)
     values ($1,$2,'initial_unit_walk','open')`,
    [property_id, ru.unit_id]
  );

  // ── 17. CERTIFIED READY BUT COMMITMENT-BLOCKED ──────────────────────
  //  Certification settles the PHYSICAL axis only. A locked future commitment
  //  outranks it, so this must NOT read marketable. This is the fixture that
  //  proves certification cannot override another axis.
  const cb = await unit("Q-certified-but-committed");
  ids.certified_blocked_lease = await lease(cb.space_id, {
    status: "pending", start: future, end: farFuture, executed: true, funded: true });
  // A certification requires the walk it rests on — the certification is
  // evidence of a human's inspection, never a standalone flag.
  //  A 'ready' outcome requires EVERY confirmation — the database refuses a
  //  partial one. Setting them explicitly is the point: readiness is an
  //  affirmative human answer to each question, never a default.
  const walk = await one(
    `insert into unit_readiness_walks
       (property_id, unit_id, walked_by_user_id, outcome, walked_at,
        work_complete_confirmed, cleaning_acceptable_confirmed,
        appliances_present_confirmed, appliance_function_confirmed,
        no_repair_blocker_confirmed, keys_accounted_confirmed,
        condition_acceptable_confirmed, no_unknowns_confirmed)
     values ($1,$2,$3,'ready',now(), true,true,true,true,true,true,true,true)
     returning id`,
    [property_id, cb.unit_id, user.id]
  );
  await c.query(
    `insert into unit_readiness_certifications
       (walk_id, property_id, unit_id, certified_by_user_id, walked_by_user_id, state, certified_at)
     values ($1,$2,$3,$4,$4,'ready',now())`,
    [walk.id, property_id, cb.unit_id, user.id]
  );

  // ── 18. ZERO-SPACE UNIT — configured as a unit, no rentable position ─
  await unit("R-zero-space", { spaces: 0 });

  // ── 19. TWO-SPACE UNIT — the grain refusal ──────────────────────────
  await unit("S-two-space", { spaces: 2 });

  return { property_id, asOf, units, ids, user_id: user.id, person_id: person.id };
}

module.exports = { seedInventory };
