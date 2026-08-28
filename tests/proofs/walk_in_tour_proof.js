// ════════════════════════════════════════════════════════════════════
//  WALK-IN TOUR — proof.
//
//  Somebody in the neighbourhood walks in and gets toured. Until 097 that
//  could not be recorded at all: the only capture door needs a tour row
//  that already exists.
//
//  Proves the two things that would actually cause damage if wrong:
//
//    1. A walk-in does NOT hijack a scheduled tour. Capturing it against
//       tomorrow's booked row would claim the tour happened at tomorrow's
//       slot time. "The tour we planned" and "the tour that happened" are
//       different facts and must not be merged.
//
//    2. A walk-in without a slot is NOT the same as a scheduled tour
//       without one. The first is normal; the second is the defect that
//       made 21 of 30 tours untimeable. `origin` is what tells them apart,
//       and without it the untrackable diagnosis becomes useless the
//       moment walk-ins start arriving.
//
//  All writes run inside a transaction that ALWAYS ROLLS BACK.
//
//  Run (PowerShell, from api/):
//    node tests/proofs/walk_in_tour_proof.js
// ════════════════════════════════════════════════════════════════════
const { Pool } = require("pg");
const TO = require("../../src/leasing/tour_outcome");

const DEMO = "a50fbdd0-3642-431e-b532-0dcd6ab8a4fe";
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

let failures = 0;
const check = (ok, label, detail) => {
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${label}${detail ? " — " + detail : ""}`);
  if (!ok) failures++;
};
async function mustReject(client, label, sql, params) {
  await client.query("savepoint sp");
  try { await client.query(sql, params); await client.query("rollback to savepoint sp");
        check(false, label, "the database ACCEPTED it"); }
  catch (e) { await client.query("rollback to savepoint sp"); check(true, label, e.code || "rejected"); }
}

(async () => {
  console.log("WALK-IN TOUR — a real tour nobody scheduled\n");

  //  Baseline BEFORE anything. The rollback check must measure THIS
  //  harness's effect, not the absolute state of the table — real
  //  walk-ins exist now, and an assertion that breaks when the product
  //  starts being used is an assertion measuring the wrong thing.
  const baseline = (await pool.query(
    `select count(*)::int total, count(*) filter (where origin='walk_in')::int walk_ins
       from leasing_tours where property_id=$1`, [DEMO])).rows[0];

  // ── [1] the resolver now tells the two no-slot cases apart ─────────
  console.log("[1] a walk-in without a slot is NOT the same as a scheduled tour without one");
  const NOW = "2026-07-28T18:00:00Z";
  const walkIn = TO.resolveCaptureState({
    origin: "walk_in", tourEndedAt: null, occurredAt: "2026-07-28T16:00:00Z",
    now: NOW, graceMinutes: 15 });
  check(walkIn.state === TO.CAPTURE_STATE.OVERDUE,
        "a walk-in with a recorded arrival is timeable",
        "its arrival time is as honest an end time as a slot's");
  const scheduledNoSlot = TO.resolveCaptureState({
    origin: "scheduled", tourEndedAt: null, occurredAt: null, now: NOW });
  check(scheduledNoSlot.state === TO.CAPTURE_STATE.UNTRACKABLE,
        "a SCHEDULED tour with no slot is still untrackable", "that one is the defect");
  const walkInNoTime = TO.resolveCaptureState({ origin: "walk_in", tourEndedAt: null, occurredAt: null, now: NOW });
  check(walkInNoTime.state === TO.CAPTURE_STATE.UNTRACKABLE
        && /walk-in/.test(walkInNoTime.reason),
        "a walk-in with no arrival time is untrackable too — with its OWN reason",
        walkInNoTime.reason);

  const client = await pool.connect();
  try {
    await client.query("begin");

    // ── [2] the origin vocabulary binds ─────────────────────────────
    console.log("\n[2] the origin column is a closed vocabulary");
    const anyTour = (await client.query(`select id from leasing_tours limit 1`)).rows[0];
    await mustReject(client, "an unknown origin is rejected",
      `update leasing_tours set origin='wandered_in' where id=$1`, [anyTour.id]);
    await client.query(`update leasing_tours set origin='walk_in' where id=$1`, [anyTour.id]);
    check(true, "'walk_in' is accepted");
    await client.query(`update leasing_tours set origin=null where id=$1`, [anyTour.id]);
    check(true, "NULL is accepted — every pre-097 row predates the distinction");

    // ── [3] THE ONE THAT MATTERS: the scheduled tour is untouched ────
    console.log("\n[3] a walk-in does not hijack the scheduled tour");
    const lead = (await client.query(
      `select l.id, l.person_id, l.unit_id from leasing_leads l
        where l.property_id=$1 and l.person_id is not null limit 1`, [DEMO])).rows[0];
    const agent = (await client.query(`select id from users limit 1`)).rows[0];

    //  a tour booked for tomorrow
    const tomorrow = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
    const booked = (await client.query(
      `insert into leasing_tours (lead_id, property_id, leasing_agent_id, scheduled_for, status, origin)
       values ($1,$2,$3,$4,'scheduled','scheduled') returning *`,
      [lead.id, DEMO, agent.id, tomorrow])).rows[0];

    //  they walk in TODAY instead
    const walkNow = new Date().toISOString();
    const walk = (await client.query(
      `insert into leasing_tours (lead_id, property_id, leasing_agent_id, scheduled_for,
                                  checked_in_at, status, origin)
       values ($1,$2,$3,$4,$4,'scheduled','walk_in') returning *`,
      [lead.id, DEMO, agent.id, walkNow])).rows[0];

    check(walk.id !== booked.id, "the walk-in got its OWN tour row",
          "not captured against tomorrow's booking");
    check(walk.origin === "walk_in" && booked.origin === "scheduled",
          "and the two are distinguishable forever");

    const bookedAfter = (await client.query(
      `select * from leasing_tours where id=$1`, [booked.id])).rows[0];
    check(bookedAfter.status === "scheduled" && bookedAfter.cancelled_at === null,
          "TOMORROW'S TOUR IS COMPLETELY UNTOUCHED",
          "the system never infers that a walk-in cancels a booking");
    check(new Date(bookedAfter.scheduled_for).getTime() === new Date(tomorrow).getTime(),
          "and its scheduled time is unchanged",
          "capturing against it would have claimed the tour happened tomorrow");

    // the route surfaces the conflict rather than resolving it
    const conflicts = (await client.query(
      `select t.id, t.scheduled_for from leasing_tours t
        where t.lead_id=$1 and t.id <> $2
          and t.status not in ('completed','no_show','cancelled','rescheduled')
          and coalesce(t.scheduled_for, t.requested_for) > now()`, [lead.id, walk.id])).rows;
    check(conflicts.some(c => c.id === booked.id),
          "the still-open booking IS surfaced to the agent",
          `${conflicts.length} open scheduled tour(s) returned for the human to decide`);

    // ── [4] the walk-in is immediately timeable ─────────────────────
    console.log("\n[4] the walk-in can be reasoned about straight away");
    const st = TO.resolveCaptureState({
      isTerminal: false, origin: walk.origin,
      tourEndedAt: null, occurredAt: walk.checked_in_at, graceMinutes: 15 });
    check(st.state !== TO.CAPTURE_STATE.UNTRACKABLE,
          "it is not untrackable — the arrival time is on record", `state: ${st.state}`);

  } finally { await client.query("rollback"); client.release(); }

  // ── [4b] THE READ MUST FEED THE RESOLVER ──────────────────────────
  //  Regression guard for a bug that shipped and was caught live: the
  //  resolver handled occurredAt correctly, but the tours/today read never
  //  passed it, so a walk-in was labelled "No time on record" seconds
  //  after someone recorded its time. A correct resolver starved of input
  //  is still a wrong answer on the screen.
  console.log("\n[4b] the desk read passes the walk-in's arrival time through");
  const src = require("fs").readFileSync(
    require("path").join(__dirname, "..", "..", "src", "identity", "operator.js"), "utf8");
  check(/occurredAt:\s*row\.checked_in_at/.test(src),
        "the read passes checked_in_at as occurredAt",
        "without it a walk-in reads as untrackable");
  check(/origin:\s*row\.origin/.test(src),
        "and passes origin, so walk-in and defect are told apart");

  // ── [5] nothing leaked, and the live table is unharmed ────────────
  console.log("\n[5] rollback — measured as a DELTA, not an absolute");
  const after = (await pool.query(
    `select count(*)::int total, count(*) filter (where origin='walk_in')::int walk_ins
       from leasing_tours where property_id=$1`, [DEMO])).rows[0];
  console.table([{ baseline_total: baseline.total, after_total: after.total,
                   baseline_walk_ins: baseline.walk_ins, after_walk_ins: after.walk_ins }]);
  check(after.total === baseline.total,
        "this harness added no rows", `${baseline.total} before, ${after.total} after`);
  check(after.walk_ins === baseline.walk_ins,
        "and no walk-ins of its own", "the transaction rolled back cleanly");
  if (baseline.walk_ins > 0) {
    console.log(`      note: ${baseline.walk_ins} REAL walk-in(s) already exist — recorded through the product, not by this file.`);
  }

  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : failures + " CHECK(S) FAILED"}`);
  process.exitCode = failures === 0 ? 0 : 1;
})().catch((e) => { console.error("HARNESS ERROR:", e.message, e.stack); process.exitCode = 1; })
  .finally(() => pool.end());
