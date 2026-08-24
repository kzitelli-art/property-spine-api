/* ════════════════════════════════════════════════════════════════════
   move_in_beat_drive.db.js — DRIVE THE MOVE-IN BEAT AND RECORD WHERE
   IT ACTUALLY STOPS.

   THE QUESTION (Slice 2): a lease is signed and executed. What has to
   happen for that resident to appear as live occupancy, and where does
   the existing path stop?

   §41 says the first OBSERVED red outranks the inferred gap, so this
   drives the canonical owners against real Postgres rather than reading
   them and concluding.

   ── THE CLAIM UNDER TEST ────────────────────────────────────────────
   Handed to this thread as a known gap to VERIFY, not trust:

     "the rent roll is unit-keyed with no person_id, and the
      signed-lease resident is person-keyed, so a real signed lease may
      not become live occupancy"

   D1–D6 below settle it in both directions.

   ── FIXTURE BOUNDARY, STATED ────────────────────────────────────────
   This harness seeds the DURABLE OUTPUT of confirm-term — a `pending`
   lease linked to a verified executed_lease_record — rather than
   driving confirm-term itself. Two honest reasons:

     · confirm-term lives in src/identity/operator.js behind
       dormantWriteGuard (COMMITMENT_LEDGER_MODE, fail-closed) and an
       activation perimeter. operator.js is outside this thread's lane.
     · the beat under test begins AFTER a lease anchor exists.

   So this proves the segment from the anchor onward. It does NOT prove
   confirm-term. Said plainly because a harness that seeds its own
   precondition and then claims the whole chain is how a green run
   becomes a false rung.

   CLASS 3 — test infrastructure. REMOVAL CONDITION: none.
   Local disposable database only. Deletes only ids it created.

     CABIN_DATABASE_URL=postgres://postgres@127.0.0.1:55434/spine_cabin \
       node tests/move_in_beat_drive.db.js
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
const { spacePosition } = require(path.join(ROOT, "src/tenancy/space_position.js"));
const tenancy = require(path.join(ROOT, "src/tenancy/tenancy_position_read.js"));

const P    = "cab10001-0000-4000-8000-000000000001"; // property
const UNIT = "cab10001-0000-4000-8000-0000000000a1";
const PERSON = "cab10001-0000-4000-8000-0000000000c1";
const USER = "cab10001-0000-4000-8000-0000000000d1";
const APP  = "cab10001-0000-4000-8000-0000000000e1";
const ELR  = "cab10001-0000-4000-8000-0000000000f1";
const LEASE = "cab10001-0000-4000-8000-000000000101";
const EVENT = "cab10001-0000-4000-8000-000000000111";

let pass = 0, fail = 0;
const ok  = (l) => { pass++; console.log(`  ok    ${l}`); };
const bad = (l, d) => { fail++; console.log(`  FAIL  ${l}${d ? "\n        " + d : ""}`); };
const note = (l) => console.log(`  ·     ${l}`);

const START = "2026-08-01", END = "2027-07-31", RENT = 1500, DEPOSIT = 1500;

async function seed(pool) {
  await pool.query(`delete from payment_applications where scheduled_charge_id in
                      (select id from scheduled_charges where lease_id=$1)`, [LEASE]);
  await pool.query(`delete from payments where lease_id=$1`, [LEASE]);
  await pool.query(`delete from scheduled_charges where lease_id=$1`, [LEASE]);
  await pool.query(`delete from lease_move_in_charge_sets where lease_id=$1`, [LEASE]);
  await pool.query(`delete from executed_lease_records where id=$1`, [ELR]);
  await pool.query(`delete from leases where id=$1`, [LEASE]);
  await pool.query(`delete from unit_events where property_id=$1`, [P]);
  await pool.query(`delete from spaces where unit_id=$1`, [UNIT]);
  await pool.query(`delete from units where id=$1`, [UNIT]);
  await pool.query(`delete from lease_applications where id=$1`, [APP]);
  await pool.query(`delete from events where id=$1`, [EVENT]);
  await pool.query(`delete from properties where id=$1`, [P]);
  await pool.query(`delete from persons where id=$1`, [PERSON]);
  await pool.query(`delete from users where id=$1`, [USER]);

  await pool.query(`insert into properties (id,name,address,leasing_basis)
                    values ($1,'CABIN Move-In Fixture','2 Beat Way','unit')`, [P]);
  await pool.query(`insert into persons (id,name) values ($1,'Dana Resident')`, [PERSON]);
  await pool.query(`insert into users (id,name,email,role)
                    values ($1,'CABIN Operator','cabin-op@example.invalid','property_manager')`, [USER]);
  await pool.query(`insert into units (id,property_id,unit_number) values ($1,$2,'301')`, [UNIT, P]);
  const space = (await pool.query(
    `select id from spaces where unit_id=$1 order by created_at limit 1`, [UNIT])).rows[0];
  const SPACE = space.id;

  await pool.query(
    `insert into lease_applications (id, property_id, unit_id, person_id, applicant_name, status)
     values ($1,$2,$3,$4,'Dana Resident','accepted_term_required')`, [APP, P, UNIT, PERSON]);
  await pool.query(
    `insert into events (id, property_id, person_id, unit_id, type, note)
     values ($1,$2,$3,$4,'executed_lease_verified','CABIN fixture')`, [EVENT, P, PERSON, UNIT]);

  /*  THE DURABLE OUTPUT OF CONFIRM-TERM. tenancy_anchor_service writes
      exactly this shape: a 'pending' lease carrying tenant_ids from the
      application's person_id, linked to a verified executed record.     */
  await pool.query(
    `insert into leases (id, property_id, space_id, tenant_ids, rent, balance,
                         start_date, end_date, security_deposit, lease_status, application_id)
     values ($1,$2,$3,$4::uuid[],$5,0,$6,$7,$8,'pending',$9)`,
    [LEASE, P, SPACE, [PERSON], RENT, START, END, DEPOSIT, APP]);
  await pool.query(
    `insert into executed_lease_records
       (id, application_id, property_id, space_id, lease_id, rent, security_deposit,
        lease_start_date, lease_end_date, payload_hash, executed_at, signers,
        execution_channel, document_sha256, verified_by_user_id, event_id, record_state)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,'cabinhash',$10,
             '[{"name":"Dana Resident","role":"resident"}]'::jsonb,
             'paper','cab1n0000000000000000000000000000000000000000000000000000000cab1',
             $11,$12,'verified')`,
    [ELR, APP, P, SPACE, LEASE, RENT, DEPOSIT, START, END, START, USER, EVENT]);
  return { SPACE };
}

const posFor = async (pool, asOf) => {
  const sp = await spacePosition(pool, { property_id: P, as_of: asOf });
  return sp.positions.find((x) => String(x.unit_number) === "301");
};

(async () => {
  const pool = new Pool({ connectionString: URL });
  console.log("\nMOVE-IN BEAT — driving the canonical owners against real Postgres\n");
  const AS_OF = "2026-08-24";
  try {
    await seed(pool);
    note(`pending lease ${LEASE.slice(0, 8)} · term ${START}→${END} · rent ${RENT} · deposit ${DEPOSIT}`);

    // ── D1 · the anchor is person-keyed, and the read resolves it ─────
    const p0 = await posFor(pool, AS_OF);
    if (p0.activation_pending_lease_position) ok("D1 · a pending lease reads as ACTIVATION PENDING, not empty");
    else bad("D1 · pending lease did not read as activation pending", JSON.stringify(p0.economic_tenancy_state));

    /*  THE KEY IS `tenants`, NOT `resident`. My first pass asserted
     *  `.resident` and went red against a payload that plainly carried the
     *  person. The assertion was wrong, not the product — recorded because
     *  a harness that names the wrong field manufactures a defect. */
    const t0 = (p0.activation_pending_lease_position || {}).tenants || [];
    if (t0.length && t0[0].person_id && t0[0].name)
      ok(`D1 · RESIDENT NAMED on the unit-keyed read — ${t0[0].name} <${t0[0].person_id.slice(0, 8)}> (person_id gap REFUTED)`);
    else bad("D1 · no person on the pending position — the person_id gap would be REAL",
             JSON.stringify(p0.activation_pending_lease_position));

    if (!p0.current_lease_position) ok("D1 · and it is NOT yet current occupancy — pending is not occupied");
    else bad("D1 · a pending lease already reads as current occupancy", "that would be the double-let direction");

    // ── D2 · activation refuses before funds ─────────────────────────
    let c = await pool.connect();
    try {
      await c.query("begin");
      await econ.attemptEconomicTenancyActivation(c, { lease_id: LEASE, activated_by_user_id: USER });
      bad("D2 · activation SUCCEEDED with no confirmed charge set", "the funds gate is not holding");
      await c.query("rollback");
    } catch (e) {
      await c.query("rollback").catch(() => {});
      //  serviceError carries the code on e.body.error and the status on
      //  e.http — NOT on e.code. Same class of mistake as D1.
      const code = e.body && e.body.error;
      if (code === "move_in_funds_outstanding") ok(`D2 · activation refuses before funds — ${e.http} ${code}`);
      else bad(`D2 · unexpected refusal: ${code}`, e.message);
    } finally { c.release(); }

    // ── D3 · confirm the move-in charge set ──────────────────────────
    let chargeSet = null;
    c = await pool.connect();
    try {
      await c.query("begin");
      chargeSet = await econ.confirmMoveInChargeSet(c, {
        lease_id: LEASE,
        first_period_amount: RENT,
        first_period_start: START,
        first_period_end: "2026-08-31",
        required_fees: [],
        confirmed_by_user_id: USER,
        calculation_note: "CABIN drive: first period and deposit read from the verified executed lease.",
      });
      await c.query("commit");
      ok("D3 · move-in charge set confirmed through the canonical writer");
    } catch (e) {
      await c.query("rollback").catch(() => {});
      bad(`D3 · confirmMoveInChargeSet refused: ${e.body && e.body.error}`, e.message);
    } finally { c.release(); }

    const charges = (await pool.query(
      `select id, move_in_requirement_key, amount, status from scheduled_charges
        where lease_id=$1 and is_move_in_required=true order by created_at`, [LEASE])).rows;
    note(`charges raised: ${charges.map((x) => `${x.move_in_requirement_key}=${x.amount}`).join(" · ") || "NONE"}`);

    // ── D4 · pay every required charge, through real rows ────────────
    for (const ch of charges) {
      const pay = (await pool.query(
        `insert into payments (property_id, person_id, lease_id, amount, paid_date, method, status, processor_settled)
         values ($1,$2,$3,$4,current_date,'ach','cash_proven',true) returning id`,
        [P, PERSON, LEASE, ch.amount])).rows[0];
      await pool.query(
        `insert into payment_applications (payment_id, scheduled_charge_id, amount_applied, confirmed_by)
         values ($1,$2,$3,$4)`, [pay.id, ch.id, ch.amount, USER]);
      await pool.query(
        `update scheduled_charges set amount_paid=$2, status='paid', updated_at=now() where id=$1`,
        [ch.id, ch.amount]);
    }
    const funds = await econ.readMoveInFunds(pool, LEASE);
    if (funds.cleared) ok(`D4 · funds read CLEARED — ${funds.proof_strength}, required ${funds.total_required}`);
    else bad("D4 · funds not cleared after paying every raised charge",
             JSON.stringify({ state: funds.state, missing: funds.missing_requirements }));

    // ── D5 · activate ────────────────────────────────────────────────
    c = await pool.connect();
    try {
      await c.query("begin");
      const r = await econ.attemptEconomicTenancyActivation(c, { lease_id: LEASE, activated_by_user_id: USER });
      await c.query("commit");
      if (r.activated) ok("D5 · economic tenancy ACTIVATED through the canonical writer");
      else bad("D5 · activation returned not-activated", JSON.stringify(r.receipt));
    } catch (e) {
      await c.query("rollback").catch(() => {});
      bad(`D5 · activation refused: ${e.body && e.body.error}`, e.message);
    } finally { c.release(); }

    // ── D6 · the resident is now LIVE OCCUPANCY on the same read ─────
    const p1 = await posFor(pool, AS_OF);
    if (p1.current_lease_position) ok("D6 · the unit now reads as CURRENT OCCUPANCY");
    else bad("D6 · still not current occupancy after activation", JSON.stringify(p1.economic_tenancy_state));
    const t1 = (p1.current_lease_position || {}).tenants || [];
    if (t1.length && t1[0].person_id && t1[0].name)
      ok(`D6 · and the resident is named on live occupancy — ${t1[0].name} <${t1[0].person_id.slice(0, 8)}>`);
    else bad("D6 · occupancy with no named resident", JSON.stringify(p1.current_lease_position));
    const basis = (p1.current_lease_position || {}).proof_basis;
    if (basis === "native_verified")
      ok(`D6 · proof_basis is ${basis} — executed AND funded through Spine, not an imported claim`);
    else bad("D6 · unexpected proof_basis on the activated lease", String(basis));

    const stand = await tenancy.readTenancyStanding(pool, { property_id: P, as_of: AS_OF });
    note(`standing: ${stand.standing && stand.standing.truth_state} · ` +
         `occupied=${stand.position && stand.position.occupied} ` +
         `pending=${stand.position && stand.position.activation_pending}`);
    if (stand.position && stand.position.occupied === 1)
      ok("D6 · the Ask Spine standing projection agrees: occupied = 1");
    else bad("D6 · standing projection disagrees with the rent-roll read",
             JSON.stringify(stand.position));

    // ── possession is a separate axis and must NOT be implied ────────
    if (!p1.current_possession) ok("D6 · possession remains PENDING — activation is economic, not physical (§29)");
    else bad("D6 · activation invented physical possession", "no move_in event was recorded");
  } catch (e) {
    bad("harness died", e.message);
    console.error(e);
  } finally {
    await pool.end();
  }
  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  process.exit(fail === 0 ? 0 : 1);
})();
