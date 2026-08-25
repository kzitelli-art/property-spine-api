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
const { spacePosition, recordEffectivePossession } = require(path.join(ROOT, "src/tenancy/space_position.js"));
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

    /* ══ D7/D8 · THE TEMPORAL BOUNDARY OF THE POSSESSION AXIS ═══════════
     *
     *  A position at as_of D may use only possession events effective on
     *  or before D. position_classifier.js used to take the GLOBALLY
     *  latest move_in/move_out and never consult asOf, so a historical
     *  answer could describe possession that had not happened yet — and,
     *  in the mirror direction, could end possession that had not ended.
     *
     *  These two cases exist to hold ONE filter honest in BOTH directions.
     *  A repair proved in only one direction is half a repair, and the
     *  half left behind here is the quieter, worse one: a bed reported
     *  empty while someone is living in it.
     *
     *  ── THE WRITER IS NOT UNDER TEST ────────────────────────────────
     *  recordEffectivePossession accepts future-effective events, and
     *  that is deliberate — a scheduled move-in is a legitimate record.
     *  The defect was never the write; it was historical READS consuming
     *  it too early. So the events below go in through the canonical
     *  writer, unchanged, and only the read is asserted.
     *
     *  ── CONTROLS BEFORE CLAIMS ──────────────────────────────────────
     *  D7a and D8b read from dates where the event IS in the past and
     *  require the expected answer. E3 in the bed-grain harness went red
     *  against a correct system by using the wrong control; the mirror
     *  risk here is a red that looks temporal but is really a write that
     *  never landed. The controls rule that out first.
     */
    const MOVE_IN_AT  = "2026-09-15";
    const MOVE_OUT_AT = "2026-10-15";
    const BEFORE_IN   = AS_OF;          // 2026-08-24 — before the move-in
    const BETWEEN     = "2026-09-20";   // in possession: after in, before out
    const AFTER_OUT   = "2026-10-20";   // after the move-out

    const possessionAt = async (asOf) => {
      const p = await posFor(pool, asOf);
      return {
        as_of: asOf,
        current_possession: p.current_possession,
        possession_state: p.possession_state,
        availability_state: p.availability_state,
        economic_tenancy_state: p.economic_tenancy_state,
      };
    };

    // ── D7 · a FUTURE MOVE-IN must not appear in an earlier answer ────
    c = await pool.connect();
    try {
      await c.query("begin");
      await recordEffectivePossession(c, {
        kind: "move_in", lease_id: LEASE, effective_date: MOVE_IN_AT,
        actor: USER, source: "cabin_asof_probe",
      });
      await c.query("commit");
      ok(`D7 · move_in effective ${MOVE_IN_AT} recorded through the canonical writer`);
    } catch (e) {
      await c.query("rollback").catch(() => {});
      bad(`D7 · the canonical writer refused a future-dated move_in`, (e.body && e.body.error) || e.message);
    } finally { c.release(); }

    const inSeen = await possessionAt(BETWEEN);
    if (inSeen.current_possession && String(inSeen.current_possession.since) === MOVE_IN_AT)
      ok(`D7a · CONTROL — at ${BETWEEN} possession reads delivered since ${MOVE_IN_AT}`);
    else bad(`D7a · CONTROL FAILED — the move_in did not land or is not readable at ${BETWEEN}`,
             JSON.stringify(inSeen));

    const beforeIn = await possessionAt(BEFORE_IN);
    console.log("\n  " + JSON.stringify(beforeIn));
    if (beforeIn.current_possession === null)
      ok(`D7b · at ${BEFORE_IN} there is NO possession from an event effective ${MOVE_IN_AT}`);
    else bad(`D7b · FUTURE MOVE-IN LEAK — ${BEFORE_IN} reports possession since ${beforeIn.current_possession.since}`,
             `possession claimed to begin ${beforeIn.current_possession.since}, AFTER the date asked about`);
    if (beforeIn.possession_state === "pending")
      ok(`D7c · and possession_state is "pending" at ${BEFORE_IN}, not "delivered"`);
    else bad(`D7c · possession_state is "${beforeIn.possession_state}" at ${BEFORE_IN}`,
             `a move_in effective ${MOVE_IN_AT} treated as delivered three weeks earlier`);

    // ── D8 · the MIRROR: a future MOVE-OUT must not end it early ──────
    c = await pool.connect();
    try {
      await c.query("begin");
      await recordEffectivePossession(c, {
        kind: "move_out", lease_id: LEASE, effective_date: MOVE_OUT_AT,
        actor: USER, source: "cabin_asof_probe",
      });
      await c.query("commit");
      ok(`D8 · move_out effective ${MOVE_OUT_AT} recorded through the canonical writer`);
    } catch (e) {
      await c.query("rollback").catch(() => {});
      bad(`D8 · the canonical writer refused a future-dated move_out`, (e.body && e.body.error) || e.message);
    } finally { c.release(); }

    /*  THE MIRROR ASSERTION. On ${BETWEEN} the resident had moved in and
     *  had not moved out. An unbounded classifier sees the later move_out
     *  and concludes possession already ended — reporting a bed as empty
     *  on a date someone was living in it. Quieter than the D7b leak and
     *  worse, because "empty" is what gets offered to a prospect.        */
    const between = await possessionAt(BETWEEN);
    console.log("  " + JSON.stringify(between));
    if (between.current_possession && String(between.current_possession.since) === MOVE_IN_AT
        && between.possession_state === "delivered")
      ok(`D8a · at ${BETWEEN} possession is STILL delivered — a move_out effective ${MOVE_OUT_AT} does not end it early`);
    else bad(`D8a · FUTURE MOVE-OUT LEAK — ${BETWEEN} lost possession to an event effective ${MOVE_OUT_AT}`,
             JSON.stringify(between));

    const afterOut = await possessionAt(AFTER_OUT);
    console.log("  " + JSON.stringify(afterOut));
    if (afterOut.current_possession === null && afterOut.possession_state === "pending")
      ok(`D8b · CONTROL — at ${AFTER_OUT} possession is no longer delivered; the move_out is honoured once it is past`);
    else bad(`D8b · CONTROL FAILED — possession survived a move_out effective ${MOVE_OUT_AT}`,
             JSON.stringify(afterOut));

    /* ══ D9 · THE DATE-INPUT CONTRACT ═══════════════════════════════════
     *
     *  The temporal boundary is only as good as the key it is given. Its
     *  first version fell back to "apply no bound" whenever it could not
     *  parse asOf — which sounds conservative and is the opposite. It
     *  silently reinstated the very leak the boundary closes, and it did so
     *  for inputs Postgres HAPPILY ACCEPTS, so nothing upstream refused
     *  them: openingBaselineAsOf casts $2::date, and '2026-9-20',
     *  '20260920' and '09/20/2026' all cast fine.
     *
     *  Measured on this exact fixture before the correction — resident in
     *  possession since 2026-09-15, asked about 2026-09-20:
     *
     *      as_of=2026-09-20   possession delivered · econ active
     *      as_of=2026-9-20    possession PENDING   · econ active
     *      as_of=09/20/2026   possession PENDING   · econ FORWARD
     *
     *  The last line is the one that matters. `forward` on an occupied bed
     *  means availability_state committed_future — Spine offering a bed
     *  someone lives in, with a story attached. D9g is that control, and it
     *  is the assertion this whole case exists to protect.
     *
     *  WHY REFUSE RATHER THAN NORMALISE. '2026-9-20' is unambiguous, but
     *  '09/20/2026' is a date only under DateStyle MDY; under DMY the same
     *  request means a different day. An answer that depends on a database
     *  session setting is not a governed answer, so all three are refused.
     */
    const REF = "2026-09-20";                 // canonical, in possession
    const truth = await possessionAt(REF);

    // ── D9a · canonical bounds BOTH axes ──────────────────────────────
    if (truth.possession_state === "delivered"
        && String(truth.current_possession && truth.current_possession.since) === MOVE_IN_AT
        && truth.economic_tenancy_state === "active")
      ok(`D9a · canonical ${REF} bounds both axes — possession delivered AND lease active`);
    else bad("D9a · canonical date did not bound both axes", JSON.stringify(truth));

    // ── D9b/c · other ACCEPTED representations give the SAME answer ───
    const sameAnswer = async (label, value) => {
      try {
        const p = await posFor(pool, value);
        const got = {
          possession_state: p.possession_state,
          since: p.current_possession ? String(p.current_possession.since) : null,
          economic_tenancy_state: p.economic_tenancy_state,
          availability_state: p.availability_state,
        };
        const want = {
          possession_state: truth.possession_state,
          since: truth.current_possession ? String(truth.current_possession.since) : null,
          economic_tenancy_state: truth.economic_tenancy_state,
          availability_state: truth.availability_state,
        };
        if (JSON.stringify(got) === JSON.stringify(want))
          ok(`${label} — identical answer to canonical ${REF}`);
        else bad(`${label} — DIFFERENT answer from the same day`,
                 `canonical ${JSON.stringify(want)}\n        this     ${JSON.stringify(got)}`);
      } catch (e) { bad(`${label} — threw ${e.code || ""}`, e.message); }
    };
    await sameAnswer("D9b · ISO timestamp 2026-09-20T13:45:00Z", "2026-09-20T13:45:00Z");
    await sameAnswer("D9c · JS Date object", new Date(Date.UTC(2026, 8, 20)));

    // ── D9d · absent asOf preserves the existing undated behaviour ────
    /*  spacePosition defaults a missing as_of to today, so `null` here is
        the production shape. It must not refuse.                         */
    try {
      const undated = await posFor(pool, null);
      ok(`D9d · absent as_of still answers (undated behaviour preserved) — econ ${undated.economic_tenancy_state}`);
    } catch (e) { bad("D9d · absent as_of was refused", `${e.code || ""} ${e.message}`); }

    // ── D9e · the three PG-valid noncanonical forms REFUSE ────────────
    const mustRefuse = async (label, value) => {
      try {
        const p = await posFor(pool, value);
        bad(`${label} — ACCEPTED instead of refused`,
            `answered possession=${p.possession_state} econ=${p.economic_tenancy_state} ` +
            `avail=${p.availability_state} — an unbounded answer to a date Spine cannot key`);
      } catch (e) {
        if (e.code === "INVALID_AS_OF") ok(`${label} — refused INVALID_AS_OF`);
        else bad(`${label} — refused with the WRONG code ${e.code || "(none)"}`, e.message);
      }
    };
    await mustRefuse("D9e · 2026-9-20 (unpadded)", "2026-9-20");
    await mustRefuse("D9e · 20260920 (ISO basic)", "20260920");
    await mustRefuse("D9e · 09/20/2026 (DateStyle-dependent)", "09/20/2026");

    // ── D9f · impossible days refuse INSIDE the classifier ────────────
    /*  Postgres also rejects these, at openingBaselineAsOf's $2::date — but
     *  that is an accident of the read path, not a contract, and it arrives
     *  as an untyped driver error. The classifier must refuse them itself,
     *  with its own code, so a caller that does not touch Postgres first is
     *  refused too. Asserted through the PURE function for exactly that
     *  reason: routing through spacePosition would let Postgres answer and
     *  prove nothing about the classifier.                                */
    const PC = require(path.join(ROOT, "src/tenancy/position_classifier.js"));
    const bareRow = { space_id: "s", unit_id: "u", unit_number: "x", space_label: "A",
                      leases: [], possession_events: [] };
    for (const bad_date of ["2026-02-31", "2026-99-99"]) {
      try {
        PC.classifyPosition(bareRow, { asOf: bad_date, personNames: new Map() });
        bad(`D9f · ${bad_date} accepted by the classifier`, "a well-formed string that is not a day");
      } catch (e) {
        if (e.code === "INVALID_AS_OF") ok(`D9f · ${bad_date} refused INVALID_AS_OF inside the classifier`);
        else bad(`D9f · ${bad_date} refused with the WRONG code ${e.code || "(none)"}`, e.message);
      }
    }

    // ── D9g · THE CONTROL THIS CASE EXISTS FOR ────────────────────────
    /*  Occupied space must never read pending or committed_future through
     *  ANY representation Spine accepts. Refused inputs cannot reach an
     *  answer at all, so the accepted set is the whole risk surface.      */
    let leaked = null;
    for (const rep of [REF, "2026-09-20T13:45:00Z", new Date(Date.UTC(2026, 8, 20))]) {
      const p = await posFor(pool, rep);
      if (p.possession_state !== "delivered" || p.availability_state === "committed_future"
          || p.economic_tenancy_state === "forward") {
        leaked = { rep: String(rep), possession: p.possession_state,
                   avail: p.availability_state, econ: p.economic_tenancy_state };
        break;
      }
    }
    if (leaked === null)
      ok("D9g · CONTROL — occupied space stays occupied through every ACCEPTED date representation");
    else bad("D9g · OCCUPIED SPACE LEAKED through an accepted representation", JSON.stringify(leaked));
  } catch (e) {
    bad("harness died", e.message);
    console.error(e);
  } finally {
    await pool.end();
  }
  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  process.exit(fail === 0 ? 0 : 1);
})();
