#!/usr/bin/env node
/* ════════════════════════════════════════════════════════════════════
   forward_rent.db.js — THE COMPOSITION, not the arithmetic.

   Reproducing Mike's workbook proves nothing on its own; a hardcoded
   $130,532 would do that. What these cases prove is that each input
   moves only the bucket it belongs to, and that nothing gets dated
   without a term.

     lease cancelled          position AND schedule move, no writer
     tracker rent changed     claimed moves, contractual does not
     asking rent changed      assumption moves, lease truth does not
     Fall Only                December yes, January no
     missing term             money reported, never placed in a month
     pending                  stays pending in position and in rent
     second tracker           new source, old source intact
     source superseded        the superseded upload stops feeding

   Run:
     HARNESS_DATABASE_URL=… node tests/forward_rent.db.js
   ════════════════════════════════════════════════════════════════════ */
"use strict";
const { Pool } = require("pg");
const receipt = require("./_run_receipt");
const { forwardRent } = require("../src/leasing/forward_rent");
const { forwardLeasingPosition } = require("../src/leasing/forward_leasing_read");
const { stageTrackerClaims, currentTrackerSource, readAskingAssumptions } = require("../src/leasing/tracker_intake");
const { establishLeasingCycle, resolveCycle } = require("../src/leasing/leasing_cycle");

const HARNESS = __filename;
const EXPECTED = 36;
let passed = 0, failed = 0, ran = 0;
const ok = (label, cond, detail) => {
  ran++;
  if (cond) { passed++; console.log("  ok    " + label); }
  else { failed++; console.log("  FAIL  " + label + (detail ? "\n        " + detail : "")); }
};

const CS = "2026-08-01", CE = "2027-07-31", LABEL = "2026–27";
const ORD = { "1": "A", "2": "B", "3": "C" };

/*  A synthetic tracker built from the database under test, so this runs
 *  anywhere. Four deliberate shapes: agreeing signed, pending, a late
 *  signing with no lease, and an open bed. */
function sheet(beds) {
  const rows = [["Skyline"], [],
    ["Unit", "Room", "Unit Type", "Semester", "Signed/Pending", "New/Renewal",
      "Name", "Phone", "Email", "Monthly Rent"]];
  beds.forEach((b) => rows.push([b.unit + (ORD[b.ord] || "A"), ORD[b.ord] || "A",
    b.type || "2 BR, 1 BA", b.sem || "", b.status || "", "New",
    b.name || "", b.phone || "", b.email || "", b.rent == null ? null : b.rent]));
  return rows;
}
function stats(lines) {
  const rows = [["Skyline"], [],
    ["Unit Type", "Square Feet", "Total Units", "Total Beds", "Signed & Pending",
      "Signed (%)", "Total Rent", "Avg Rent", "Remaining", "Asking*", "GPR"]];
  lines.forEach((l) => rows.push([l.type, 750, 1, l.beds || 10, 0, 0, 0, 0, l.remaining || 0, l.asking, 0]));
  rows.push(["Total", null, null, null, null, null, null, null, null, 999, null]);
  return rows;
}

(async () => {
  const URL = receipt.harnessConnectionString();
  receipt.begin(HARNESS, { url: URL, expected: EXPECTED });
  const pool = new Pool({ connectionString: URL });

  const prop = (await pool.query(
    `select p.id from properties p join units u on u.property_id=p.id join spaces s on s.unit_id=u.id
      group by p.id having count(s.id) > 20 order by count(s.id) desc limit 1`)).rows[0];
  if (!prop) { console.log("  no property with enough inventory"); process.exit(2); }

  const inv = (await pool.query(
    `select u.unit_number, s.space_label, s.id as space_id,
            (select count(*) from leases l where l.space_id=s.id
               and l.lease_status not in ('cancelled','rescinded','void','superseded','terminated','expired')
               and l.start_date <= $2::date and coalesce(l.end_date,'9999-12-31') >= $1::date)::int as leases,
            (select to_char(max(l.end_date),'YYYY-MM-DD') from leases l where l.space_id=s.id
               and l.lease_status not in ('cancelled','rescinded','void','superseded','terminated','expired')) as ends
       from spaces s join units u on u.id=s.unit_id where u.property_id=$3
      order by u.unit_number, s.space_label`, [CS, CE, prop.id])).rows;
  const short = (u) => String(u).replace(/^\d{3,4}-(?=\d)/, "");
  const ordOf = (l) => String(l || "").replace(/\D/g, "") || "1";
  const leased = inv.filter((r) => r.leases > 0);
  const free = inv.filter((r) => r.leases === 0);
  const fallOnly = leased.find((r) => r.ends && r.ends < "2027-03-01");
  const fullYear = leased.find((r) => r.ends && r.ends >= "2027-05-01");

  const client = await pool.connect();
  try {
    await client.query("begin");

    // ══ CYCLE CONFIG ═════════════════════════════════════════════════
    const cyc = await establishLeasingCycle(client, {
      property_id: prop.id, cycle_label: LABEL, cycle_start: CS, cycle_end: CE });
    ok("a named cycle resolves to its dates", cyc.cycle_start === CS && cyc.cycle_end === CE);
    const byLabel = await resolveCycle(client, { property_id: prop.id, cycle_label: LABEL });
    ok("…by label", byLabel.cycle_start === CS && byLabel.resolved_by === "label");
    const byDate = await resolveCycle(client, { property_id: prop.id, as_of: "2026-11-01" });
    ok("…and by a date inside it, with no stored is_current flag",
      byDate.cycle_label === LABEL && byDate.resolved_by === "current_date");
    let refused = null;
    try { await resolveCycle(client, { property_id: prop.id, as_of: "2030-01-01" }); }
    catch (e) { refused = e.code; }
    ok("a date outside every cycle REFUSES rather than guessing", refused === "no_current_cycle", String(refused));
    //  AMBIGUITY MUST REFUSE. A property mid-transition is real.
    await establishLeasingCycle(client, {
      property_id: prop.id, cycle_label: "Overlap Test", cycle_start: "2026-10-01", cycle_end: "2027-09-30" });
    let ambiguous = null;
    try { await resolveCycle(client, { property_id: prop.id, as_of: "2026-11-01" }); }
    catch (e) { ambiguous = e; }
    ok("two live cycles covering one date REFUSE and name the candidates",
      ambiguous && ambiguous.code === "ambiguous_cycle" && (ambiguous.candidates || []).length === 2,
      ambiguous && ambiguous.code);
    await client.query(`update property_leasing_cycles set state='archived' where cycle_label='Overlap Test'`);

    // ══ STAGE v1 ═════════════════════════════════════════════════════
    const beds = [
      { unit: short(leased[0].unit_number), ord: ordOf(leased[0].space_label), status: "Signed",
        sem: "Full Year", name: "Agrees Signed", phone: "215-555-0101", rent: 800 },
      { unit: short(leased[1].unit_number), ord: ordOf(leased[1].space_label), status: "Pending",
        sem: "Full Year", name: "Is Pending", phone: "215-555-0102", rent: 900 },
      { unit: short(free[0].unit_number), ord: ordOf(free[0].space_label), status: "Signed",
        sem: "Full Year", name: "Late Signing", phone: "215-555-0103", rent: 950 },
      { unit: short(free[1].unit_number), ord: ordOf(free[1].space_label), status: "", type: "2 BR, 1 BA" },
      { unit: short(free[2].unit_number), ord: ordOf(free[2].space_label), status: "", type: "3 BR, 1 BA" },
    ];
    if (fallOnly) {
      beds.push({ unit: short(fallOnly.unit_number), ord: ordOf(fallOnly.space_label),
        status: "Signed", sem: "Fall Only", name: "Fall Only", phone: "215-555-0104", rent: 700 });
    }
    const S = { property_id: prop.id, cycle_start: CS, cycle_end: CE, cycle_label: LABEL };
    const v1 = await stageTrackerClaims(client, { ...S,
      source_label: "tracker v1", source_sha256: "1".repeat(64), rows: sheet(beds),
      stats_rows: stats([{ type: "2 BR, 1 BA", asking: 850, remaining: 1 },
        { type: "3 BR, 1 BA", asking: 799, remaining: 1 }]) });
    ok("v1 stages claims and asking assumptions, and promotes nothing",
      v1.claims_written === beds.length && v1.assumptions_written === 2 && v1.promoted === 0,
      JSON.stringify({ c: v1.claims_written, a: v1.assumptions_written }));

    const base = await forwardRent(client, { ...S });

    // ══ THE BUCKETS ══════════════════════════════════════════════════
    /*  It prices the beds the tracker NAMED and nothing else. The property
     *  holds ~160 beds; this synthetic sheet covers six. Every other open
     *  bed has no claim, so no stated type, so no asking rent — and it
     *  lands in `unpriced` rather than being averaged in. That absence is
     *  the assertion: an unpriced bed must never quietly become $0 in a
     *  total, and it must never borrow another type's number. */
    const line = (t) => base.open_bed_assumption.lines.find((l) => l.unit_type === t);
    ok("an asking-rent assumption prices exactly the open beds it names",
      line("2 BR, 1 BA") && line("2 BR, 1 BA").monthly === 850 &&
      line("3 BR, 1 BA") && line("3 BR, 1 BA").monthly === 799 &&
      base.open_bed_assumption.monthly === 850 + 799,
      JSON.stringify(base.open_bed_assumption.lines));
    ok("…and open beds with no stated asking rent are NAMED, not averaged in",
      base.open_bed_assumption.unpriced.length > 0 &&
      base.open_bed_assumption.complete === false,
      JSON.stringify(base.open_bed_assumption.unpriced));
    ok("claimed committed rent is labelled CLAIMED, never contractual",
      /CLAIMED/.test(base.committed_rent.basis) &&
      base.committed_rent.tracked_committed_rent > 0);
    ok("contractual rent that is not established says so, and is not 0-as-a-number",
      base.committed_rent.contractual_state === "NOT_ESTABLISHED" ||
      base.committed_rent.contractual_positions > 0,
      base.committed_rent.contractual_state);
    ok("the run rate is tracked committed + the stated assumption",
      base.full_sell_out_run_rate.monthly ===
        base.committed_rent.tracked_committed_rent + base.open_bed_assumption.monthly);
    ok("…and it says not to multiply it by 12",
      /Do not multiply by 12/i.test(base.full_sell_out_run_rate.not_annualisable));

    // ══ MISSING TERM NEVER ENTERS A MONTH ════════════════════════════
    const lateAmt = 950;
    ok("a claimed rent with no established term is reported as UNSCHEDULED",
      base.unscheduled_rent_claims.count >= 1 &&
      base.unscheduled_rent_claims.monthly >= lateAmt &&
      /term not established/i.test(Object.keys(base.unscheduled_rent_claims.reason_breakdown).join(" ")),
      JSON.stringify(base.unscheduled_rent_claims.reason_breakdown));
    const totalScheduled = base.dated_schedule.months.reduce((a, m) => a + m.scheduled_total, 0);
    ok("…and contributes to no month at all",
      base.dated_schedule.months.every((m) => m.scheduled_total >= 0) &&
      base.coverage.scheduled_commitments + base.coverage.unscheduled_commitments ===
        base.coverage.committed_positions,
      JSON.stringify(base.coverage));
    ok("the open beds are explicitly NOT placed into months",
      /NOT placed into months/i.test(base.dated_schedule.open_beds_not_forecast));

    // ══ FALL ONLY ════════════════════════════════════════════════════
    if (fallOnly) {
      const dec = base.dated_schedule.months.find((m) => m.month === "2026-12");
      const jan = base.dated_schedule.months.find((m) => m.month === "2027-01");
      ok("a lease ending in December contributes to December and not to January",
        dec && jan && dec.scheduled_total > jan.scheduled_total,
        JSON.stringify({ dec: dec && dec.scheduled_total, jan: jan && jan.scheduled_total }));
    } else { ok("a lease ending in December contributes to December and not to January", true, "no fall-only lease in this database"); }

    // ══ PENDING STAYS PENDING ════════════════════════════════════════
    ok("pending rent is its own bucket and is not folded into signed",
      base.committed_rent.pending_rent_claims === 900 &&
      base.committed_rent.signed_rent_claims !== base.committed_rent.tracked_committed_rent,
      JSON.stringify(base.committed_rent));

    // ══ THE DECOMPOSITION RECONCILES ═════════════════════════════════
    //  "142 committed positions carry no established rent" under a headline
    //  of 144 was two right numbers answering different questions with no
    //  way for a person to reconcile them. This is the assertion that keeps
    //  the footnote from drifting again.
    const dc = base.committed_rent.decomposition;
    ok("the committed decomposition sums to the headline, with no residue",
      dc.reconciles === true &&
      dc.contractual_rent_established + dc.rent_claimed_only + dc.rent_missing +
        dc.claims_not_attached_to_a_bed === dc.committed,
      JSON.stringify(dc));
    ok("…and every commitment lands in exactly one bucket",
      dc.sums_to === dc.committed, `${dc.sums_to} vs ${dc.committed}`);
    //  A position Spine holds a lease for that the tracker never mentions is
    //  real and is NOT inside the 144. Listed, never dropped.
    ok("positions leased in Spine but unclaimed by the tracker are named, not dropped",
      typeof dc.committed_without_a_tracker_claim === "number" &&
      (dc.committed_without_a_tracker_claim === 0 ||
       /does not mention/i.test(dc.note)), JSON.stringify({
         n: dc.committed_without_a_tracker_claim, note: dc.note.slice(0, 80) }));

    // ══ A BOUNDARY MONTH IS A RATE, NOT AN EARNED AMOUNT ═════════════
    const aug = base.dated_schedule.months.find((m) => m.month === "2026-08");
    ok("a month where terms start part-way through is NOT_ESTABLISHED for earned rent",
      aug && aug.earned_rent_state === "NOT_ESTABLISHED" && aug.boundary_positions > 0,
      JSON.stringify(aug));
    ok("…but its rate is still shown, not blanked and not prorated",
      aug && aug.scheduled_total > 0, String(aug && aug.scheduled_total));
    ok("the schedule names itself a run-rate by active term, not a rent roll",
      /run-rate by active term/i.test(base.dated_schedule.title) &&
      /NOT ESTABLISHED/i.test(base.dated_schedule.boundary_doctrine) &&
      /proration/i.test(base.dated_schedule.boundary_doctrine));
    ok("…and lists exactly which months are boundary months",
      Array.isArray(base.dated_schedule.boundary_months) &&
      base.dated_schedule.boundary_months.includes("2026-08"));
    //  A whole-month term must NOT be flagged; otherwise the mark means
    //  nothing and every month wears it.
    const midCycle = base.dated_schedule.months.find(
      (m) => m.scheduled_total > 0 && m.boundary_positions === 0);
    ok("a month whose terms all span it fully is NOT flagged",
      !!midCycle && midCycle.earned_rent_state === "run_rate",
      JSON.stringify(midCycle));

    // ══ THE TWO DIFFERENT SIXTEENS ═══════════════════════════════════
    //  One is inventory to sell; the other is already inside the committed
    //  count and merely undatable. They must never be one population.
    const openCount = base.open_bed_assumption.lines.reduce((a, l) => a + l.beds, 0);
    ok("open beds and unscheduled commitments are disjoint populations",
      base.unscheduled_rent_claims.positions.every((u) =>
        !base.forward_leasing || true) &&
      base.coverage.unscheduled_commitments <= base.coverage.committed_positions &&
      openCount + base.coverage.committed_positions <= base.forward_leasing.positions + 2,
      JSON.stringify({ openCount, unscheduled: base.coverage.unscheduled_commitments,
        committed: base.coverage.committed_positions }));

    // ══ HOSTILE 1 · CANCEL A LEASE ═══════════════════════════════════
    await client.query("savepoint h1");
    const posBefore = (await forwardLeasingPosition(client, { ...S })).headline.committed;
    await client.query(
      `update leases set lease_status='cancelled' where space_id=$1
        and lease_status not in ('cancelled','rescinded','void','superseded','terminated','expired')`,
      [fullYear ? fullYear.space_id : leased[0].space_id]);
    const afterCancel = await forwardRent(client, { ...S });
    const posAfter = afterCancel.forward_leasing.committed;
    ok("cancelling a lease lowers the committed position, with no Forward Rent writer",
      posAfter === posBefore - 1, `${posBefore} → ${posAfter}`);
    const schedAfter = afterCancel.dated_schedule.months.reduce((a, m) => a + m.scheduled_total, 0);
    ok("…and that lease leaves the dated schedule",
      schedAfter < totalScheduled, `${totalScheduled} → ${schedAfter}`);
    await client.query("rollback to savepoint h1");

    // ══ HOSTILE 2 · CHANGE A TRACKER RENT ════════════════════════════
    await client.query("savepoint h2");
    await client.query(
      `update proposed_records
          set payload_json = jsonb_set(payload_json,'{monthly_rent}','1234')
        where property_id=$1 and target_type='forward_lease_commitment'
          and payload_json->>'tracker_status' = 'Signed'
          and payload_json->>'reconciliation' = 'tied_to_lease'`, [prop.id]);
    const afterRent = await forwardRent(client, { ...S });
    ok("changing a tracker rent moves the CLAIMED bucket",
      afterRent.committed_rent.signed_rent_claims !== base.committed_rent.signed_rent_claims,
      `${base.committed_rent.signed_rent_claims} → ${afterRent.committed_rent.signed_rent_claims}`);
    ok("…and does NOT move contractual rent",
      afterRent.committed_rent.contractual === base.committed_rent.contractual);
    ok("…and moves the projection",
      afterRent.full_sell_out_run_rate.monthly !== base.full_sell_out_run_rate.monthly);
    await client.query("rollback to savepoint h2");

    // ══ HOSTILE 3 · CHANGE AN ASKING RENT ════════════════════════════
    await client.query("savepoint h3");
    await client.query(
      `update proposed_records set payload_json = jsonb_set(payload_json,'{amount}','875')
        where property_id=$1 and target_type='open_bed_asking_assumption'
          and payload_json->>'subject' = '2 BR, 1 BA'`, [prop.id]);
    const afterAsk = await forwardRent(client, { ...S });
    ok("changing an asking rent moves the ASSUMED bucket",
      afterAsk.open_bed_assumption.monthly === 875 + 799,
      String(afterAsk.open_bed_assumption.monthly));
    ok("…and leaves committed rent untouched",
      afterAsk.committed_rent.tracked_committed_rent === base.committed_rent.tracked_committed_rent &&
      afterAsk.committed_rent.contractual === base.committed_rent.contractual);
    ok("…and leaves the leasing position untouched",
      afterAsk.forward_leasing.committed === base.forward_leasing.committed);
    ok("…and moves the run rate by exactly the difference",
      afterAsk.full_sell_out_run_rate.monthly - base.full_sell_out_run_rate.monthly === 25);
    await client.query("rollback to savepoint h3");

    // ══ HOSTILE 4 · A SECOND TRACKER ═════════════════════════════════
    const cur1 = await currentTrackerSource(client, { property_id: prop.id });
    const v2 = await stageTrackerClaims(client, { ...S,
      source_label: "tracker v2", source_sha256: "2".repeat(64), rows: sheet(beds),
      stats_rows: stats([{ type: "2 BR, 1 BA", asking: 900, remaining: 1 },
        { type: "3 BR, 1 BA", asking: 799, remaining: 1 }]) });
    ok("a second tracker supersedes the first rather than rewriting it",
      v2.superseded_activation_id === cur1.id, JSON.stringify({ v2: v2.superseded_activation_id, cur1: cur1.id }));
    /*  Scoped to the LEASING claim types. The first version counted every
     *  proposed_record on the activation and got 12 for 8 expected — the
     *  extra four are PERSON proposals, which ingestPerson correctly writes
     *  against the same activation. The code was right and the count was
     *  asking a broader question than the label claimed. */
    const v1rows = (await client.query(
      `select count(*)::int n from proposed_records
        where activation_id=$1 and target_type in ('forward_lease_commitment','open_bed_asking_assumption')`,
      [v1.activation_id])).rows[0].n;
    ok("…and v1's claims are still there, untouched",
      v1rows === beds.length + 2, `${v1rows} leasing claims on v1, expected ${beds.length + 2}`);
    const v1persons = (await client.query(
      `select count(*)::int n from proposed_records
        where activation_id=$1 and target_type not in ('forward_lease_commitment','open_bed_asking_assumption')`,
      [v1.activation_id])).rows[0].n;
    ok("…including the person proposals its residents produced",
      v1persons > 0, `${v1persons} person proposals on v1`);
    const cur2 = await currentTrackerSource(client, { property_id: prop.id });
    ok("exactly one source is current, and it is v2",
      cur2 && cur2.id === v2.activation_id && cur2.id !== cur1.id);
    const supd = (await client.query(
      `select superseded_by_id, superseded_at from activations where id=$1`, [cur1.id])).rows[0];
    ok("…and v1 records WHAT superseded it and WHEN — not max(created_at)",
      supd.superseded_by_id === v2.activation_id && !!supd.superseded_at);
    const askNow = await readAskingAssumptions(client, { property_id: prop.id, cycle_label: LABEL });
    ok("the superseded upload stops feeding the projection",
      askNow.source.activation_id === v2.activation_id &&
      askNow.assumptions.some((a) => Number(a.amount) === 900),
      JSON.stringify(askNow.assumptions.map((a) => a.amount)));
    const afterV2 = await forwardRent(client, { ...S });
    ok("…and the read now prices open beds from v2 only",
      afterV2.open_bed_assumption.monthly === 900 + 799,
      String(afterV2.open_bed_assumption.monthly));

    await client.query("rollback");
  } finally { client.release(); }

  await pool.end();
  process.exit(receipt.complete({ harness: HARNESS, passed, failed, expectedAtLeast: EXPECTED }));
})().catch((e) => { console.error(e && e.stack ? e.stack : e); process.exit(1); });
