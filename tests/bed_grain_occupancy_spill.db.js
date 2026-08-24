/* ════════════════════════════════════════════════════════════════════
   bed_grain_occupancy_spill.db.js — ACTIVATING ONE BED WRITES A
   UNIT-LEVEL FACT. PIN WHAT STOPS THAT FROM BECOMING OCCUPANCY.

   ── THE OBSERVED BEHAVIOUR ──────────────────────────────────────────
   attemptEconomicTenancyActivation ends with, at the line reading
   `update units set occupancy_status='occupied'`:

       update units set occupancy_status='occupied', updated_at=now()
        where id=$1                                  -- lease.unit_id

   That is a UNIT-grain write performed for a SPACE-grain fact. On a
   bed-grain unit, activating ONE bed's lease stamps the whole unit
   'occupied', and every sibling bed inherits it through
   occupancyClaim()'s `unit_occupancy_status` fallback — including beds
   that carry no lease at all.

   Measured here on a real 3-bed unit: activating bed A alone moves the
   column 'unknown' → 'occupied' and beds B and C, which have no lease,
   begin reporting occupancy_claim='occupied'.

   ── AND YET NOTHING MOVES. THAT IS THE POINT ────────────────────────
   Every reported number is IDENTICAL before and after the spill —
   occupied, open and not_established all unchanged — because
   positionBasis() refuses to let the unit-level column establish
   anything. Its own comment states the rule:

       "THE UNIT-LEVEL COLUMN IS CONTEXT, NEVER A BASIS … a placeholder
        must not be the thing that offers a bed to a prospect, so it is
        reported as context and never establishes."

   So the defect is LATENT, not active. This harness exists because that
   is a fragile place to be: the write is wrong, the read absorbs it,
   and the ONLY thing standing between them was a comment and one
   `state: "not_established"` literal. Nothing went red if someone
   changed it.

   ── WHAT IS PINNED ──────────────────────────────────────────────────
   E1  the spill is real — one bed's activation flips the unit column
   E2  the false claim reaches sibling beds that have no lease
   E3  LATENCY: occupied / open / not_established are byte-identical
       before and after the spill
   E4  THE INVARIANT: a unit-level claim NEVER establishes a bed, and
       never makes one contractually free. This is the load-bearing one.

   E4 is falsified product-side, not by renaming a selector: flipping
   positionBasis()'s unit-level arm from `not_established` to
   `established` turns this harness red. Evidence is in
   docs/MOVE_IN_BEAT_RECEIPT.md with the exact SHA.

   ⚠ THIS HARNESS DOES NOT ENDORSE THE WRITE. It pins the wall that
   makes the write harmless. Removing the wall without fixing the write
   is what it is here to catch.

   CLASS 3 — test infrastructure. REMOVAL CONDITION: none.
   Local disposable database only. Deletes only ids it created.

     CABIN_DATABASE_URL=postgres://postgres@127.0.0.1:55434/spine_cabin \
       node tests/bed_grain_occupancy_spill.db.js
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const path = require("path");
const { Pool } = require("pg");

const URL = process.env.CABIN_DATABASE_URL
  || "postgres://postgres@127.0.0.1:55434/spine_cabin";
if (!/@(127\.0\.0\.1|localhost)[:/]/.test(URL)) {
  console.error("\n  ✗ REFUSED: local disposable database only.\n");
  process.exit(2);
}

const ROOT = path.join(__dirname, "..");
const econ = require(path.join(ROOT, "src/tenancy/economic_tenancy_service.js"));
const dp = require(path.join(ROOT, "src/tenancy/dated_positions.js"));
const tenancy = require(path.join(ROOT, "src/tenancy/tenancy_position_read.js"));

const P = "5b1d0001-0000-4000-8000-000000000001";
const U = "5b1d0001-0000-4000-8000-0000000000a1";
const PER = "5b1d0001-0000-4000-8000-0000000000c1";
const USR = "5b1d0001-0000-4000-8000-0000000000d1";
const APP = "5b1d0001-0000-4000-8000-0000000000e1";
const ELR = "5b1d0001-0000-4000-8000-0000000000f1";
const L = "5b1d0001-0000-4000-8000-000000000101";
const EV = "5b1d0001-0000-4000-8000-000000000111";
const AS_OF = "2026-08-24", START = "2026-08-01", END = "2027-07-31", RENT = 800;

let pass = 0, fail = 0;
const ok = (l) => { pass++; console.log(`  ok    ${l}`); };
const bad = (l, d) => { fail++; console.log(`  FAIL  ${l}${d ? "\n        " + d : ""}`); };
const note = (l) => console.log(`  ·     ${l}`);

async function seed(pool) {
  for (const q of [
    `delete from payment_applications where scheduled_charge_id in (select id from scheduled_charges where lease_id='${L}')`,
    `delete from payments where lease_id='${L}'`,
    `delete from scheduled_charges where lease_id='${L}'`,
    `delete from lease_move_in_charge_sets where lease_id='${L}'`,
    `delete from executed_lease_records where id='${ELR}'`,
    `delete from leases where id='${L}'`,
    `delete from unit_events where property_id='${P}'`,
    `delete from spaces where unit_id='${U}'`,
    `delete from units where id='${U}'`,
    `delete from lease_applications where id='${APP}'`,
    `delete from events where id='${EV}'`,
    `delete from properties where id='${P}'`,
    `delete from persons where id='${PER}'`,
    `delete from users where id='${USR}'`,
  ]) await pool.query(q);

  await pool.query(`insert into properties (id,name,address,leasing_basis)
                    values ($1,'CABIN bed-grain spill','5 Bed Way','bed')`, [P]);
  await pool.query(`insert into persons (id,name) values ($1,'Bed Resident')`, [PER]);
  await pool.query(`insert into users (id,name,email,role)
                    values ($1,'CABIN Op','cabin-bed@example.invalid','property_manager')`, [USR]);
  await pool.query(`insert into units (id,property_id,unit_number) values ($1,$2,'501')`, [U, P]);
  const a = (await pool.query(`select id from spaces where unit_id=$1 order by created_at limit 1`, [U])).rows[0];
  await pool.query(`update spaces set space_label='A' where id=$1`, [a.id]);
  await pool.query(`insert into spaces (unit_id,space_label) values ($1,'B')`, [U]);
  await pool.query(`insert into spaces (unit_id,space_label) values ($1,'C')`, [U]);

  await pool.query(`insert into lease_applications (id,property_id,unit_id,person_id,applicant_name,status)
                    values ($1,$2,$3,$4,'Bed Resident','accepted_term_required')`, [APP, P, U, PER]);
  await pool.query(`insert into events (id,property_id,person_id,unit_id,type,note)
                    values ($1,$2,$3,$4,'executed_lease_verified','spill fixture')`, [EV, P, PER, U]);
  await pool.query(
    `insert into leases (id,property_id,space_id,tenant_ids,rent,balance,start_date,end_date,
                         security_deposit,lease_status,application_id)
     values ($1,$2,$3,$4::uuid[],$5,0,$6,$7,$5,'pending',$8)`,
    [L, P, a.id, [PER], RENT, START, END, APP]);
  await pool.query(
    `insert into executed_lease_records (id,application_id,property_id,space_id,lease_id,rent,
        security_deposit,lease_start_date,lease_end_date,payload_hash,executed_at,signers,
        execution_channel,document_sha256,verified_by_user_id,event_id,record_state)
     values ($1,$2,$3,$4,$5,$6,$6,$7,$8,'spillhash',$7,
             '[{"name":"Bed Resident","role":"resident"}]'::jsonb,'paper',
             'b3d0000000000000000000000000000000000000000000000000000000000b3d',
             $9,$10,'verified')`,
    [ELR, APP, P, a.id, L, RENT, START, END, USR, EV]);
  return a.id;
}

const unitColumn = async (pool) =>
  (await pool.query(`select occupancy_status from units where id=$1`, [U])).rows[0].occupancy_status;

async function snapshot(pool) {
  const d = await dp.datedPropertyPositions(pool, { property_id: P, as_of: AS_OF });
  const s = await tenancy.readTenancyStanding(pool, { property_id: P, as_of: AS_OF });
  const beds = {};
  for (const p of d.positions) {
    beds[String(p.space_label)] = {
      tenancy_state: p.tenancy_state,
      basis_state: p.basis_state,
      basis_type: p.basis_type,
      occupancy_claim: p.occupancy_claim,
    };
  }
  return {
    beds,
    reported: {
      occupied: s.position.occupied,
      open: s.position.open,
      not_established: s.position.not_established,
      activation_pending: s.position.activation_pending,
      needs_review: s.position.needs_review,
    },
  };
}

(async () => {
  const pool = new Pool({ connectionString: URL });
  console.log("\nBED-GRAIN SPILL — one bed's activation, three beds' truth\n");
  try {
    const spaceA = await seed(pool);
    note(`unit 501 · 3 beds · bed A carries the pending lease · basis 'bed'`);

    const beforeColumn = await unitColumn(pool);
    const before = await snapshot(pool);
    note(`units.occupancy_status BEFORE = ${beforeColumn}`);

    // ── activate bed A through the canonical writers ──────────────────
    let c = await pool.connect();
    try {
      await c.query("begin");
      await econ.confirmMoveInChargeSet(c, {
        lease_id: L, first_period_amount: RENT,
        first_period_start: START, first_period_end: "2026-08-31",
        required_fees: [], confirmed_by_user_id: USR,
        calculation_note: "CABIN spill fixture: first period from the verified executed lease.",
      });
      await c.query("commit");
    } finally { c.release(); }
    for (const ch of (await pool.query(
      `select id, amount from scheduled_charges where lease_id=$1 and is_move_in_required=true`, [L])).rows) {
      const pay = (await pool.query(
        `insert into payments (property_id,person_id,lease_id,amount,paid_date,method,status,processor_settled)
         values ($1,$2,$3,$4,current_date,'ach','cash_proven',true) returning id`, [P, PER, L, ch.amount])).rows[0];
      await pool.query(`insert into payment_applications (payment_id,scheduled_charge_id,amount_applied,confirmed_by)
                        values ($1,$2,$3,$4)`, [pay.id, ch.id, ch.amount, USR]);
      await pool.query(`update scheduled_charges set amount_paid=$2, status='paid' where id=$1`, [ch.id, ch.amount]);
    }
    c = await pool.connect();
    try {
      await c.query("begin");
      await econ.attemptEconomicTenancyActivation(c, { lease_id: L, activated_by_user_id: USR });
      await c.query("commit");
    } finally { c.release(); }

    const afterColumn = await unitColumn(pool);
    const after = await snapshot(pool);
    note(`units.occupancy_status AFTER  = ${afterColumn}`);

    // ── E1 · the spill is real ────────────────────────────────────────
    if (beforeColumn !== afterColumn && afterColumn === "occupied")
      ok(`E1 · activating ONE bed flipped the whole unit column: ${beforeColumn} → ${afterColumn}`);
    else bad("E1 · the unit column did not flip as observed", `${beforeColumn} → ${afterColumn}`);

    // ── E2 · the false claim reaches beds with no lease ───────────────
    const siblings = ["B", "C"];
    const spilled = siblings.filter((b) => after.beds[b] && after.beds[b].occupancy_claim === "occupied");
    if (spilled.length === siblings.length)
      ok(`E2 · beds ${siblings.join(" and ")} carry occupancy_claim='occupied' with NO lease of their own`);
    else bad("E2 · the claim did not propagate as observed",
             JSON.stringify(siblings.map((b) => after.beds[b])));

    /*  ── E3 · LATENCY, ISOLATED ───────────────────────────────────────
     *  ⚠ MY FIRST VERSION OF THIS COMPARED before-activation WITH
     *  after-activation AND WENT RED. It was measuring the ACTIVATION —
     *  activation_pending 1 → occupied 1 is the product working — not the
     *  spill. Recorded because the wrong control is how a correct system
     *  gets reported as broken.
     *
     *  The spill's own contribution is isolated by holding the activation
     *  constant and toggling ONLY the unit column: 'occupied' (what the
     *  writer left) versus 'unknown' (what it would be had the unit-level
     *  write never happened). The direct UPDATE is a fixture manipulation,
     *  not a product path, and is stated as such.                        */
    const withSpill = JSON.stringify(after.reported);
    await pool.query(`update units set occupancy_status='unknown' where id=$1`, [U]);
    const withoutSpill = JSON.stringify((await snapshot(pool)).reported);
    await pool.query(`update units set occupancy_status=$2 where id=$1`, [U, afterColumn]);

    if (withSpill === withoutSpill)
      ok(`E3 · LATENT — the unit-level write moves NO reported number: ${withSpill}`);
    else bad("E3 · the spill MOVED a reported number — it is ACTIVE, not latent",
             `with spill    ${withSpill}\n        without spill ${withoutSpill}`);

    // ── E4 · THE INVARIANT ────────────────────────────────────────────
    //  A unit-level column must never establish a bed. positionBasis()
    //  says so in prose; this is the executable form.
    let violations = [];
    for (const bed of siblings) {
      const row = after.beds[bed] || {};
      if (row.basis_state === "established")
        violations.push(`bed ${bed} ESTABLISHED from ${row.basis_type}`);
      if (row.tenancy_state === "vacant")
        violations.push(`bed ${bed} reported VACANT on a unit-level claim`);
      if (row.tenancy_state === "contractually_occupied")
        violations.push(`bed ${bed} reported OCCUPIED with no lease`);
    }
    if (!violations.length)
      ok("E4 · INVARIANT HOLDS — a unit-level claim establishes nothing; both beds stay not_established");
    else bad("E4 · INVARIANT BROKEN — the unit-level column became a basis", violations.join("; "));

    const types = siblings.map((x) => (after.beds[x] || {}).basis_type);
    if (types.every((t) => t === "unit_occupancy_status_only"))
      ok("E4 · and the read NAMES the weak basis — basis_type='unit_occupancy_status_only', authoritative:false");
    else bad("E4 · the weak basis is not named as such", JSON.stringify(types));

    // ── the occupied count is the number that would reach a lender ────
    if (after.reported.occupied === 1)
      ok("E4 · occupied stays 1 — one bed is leased, and only one is counted");
    else bad("E4 · occupied count is wrong after the spill", String(after.reported.occupied));
  } catch (e) {
    bad("harness died", e.message);
    console.error(e);
  } finally {
    await pool.end();
  }
  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  process.exit(fail === 0 ? 0 : 1);
})();
