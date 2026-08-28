// ════════════════════════════════════════════════════════════════════
//  slice9_turn_priority_proof.js
//
//  Commit G. Turn priority ranks physical work by the COMMITMENT waiting on
//  it, read from canonical space-linked truth — never from application status.
//
//  Three defects proven closed:
//    1. it read lease_applications.status, ranking an approved application as
//       though it held inventory. It holds none.
//    2. it could not tell PENDING from LOCKED — an unfunded lease and an
//       executed-and-funded one produced the identical top tier.
//    3. it was FIRST-ROW-WINS on a multi-space unit: one bed's lease silently
//       set the whole unit's priority.
//
//  Run: DATABASE_URL=... node tests/proofs/slice9_turn_priority_proof.js
// ════════════════════════════════════════════════════════════════════

"use strict";
const path = require("path");
const { Pool } = require("pg");
const REPO = path.resolve(__dirname, "..", "..");
const { seedInventory } = require("./fixtures/slice9_inventory_fixture");
const { rankTurnPriority } = require(path.join(REPO, "src/maintenance/turn_priority"));
const { readNextCommittedMoveIn } = require(path.join(REPO, "src/maintenance/unit_move_in_read"));
const { closeActiveTurnoversForReadiness } = require(path.join(REPO, "src/maintenance/readiness_service"));
const { availabilityRead } = require(path.join(REPO, "src/surfaces/availability_read"));

let pass = 0, fail = 0;
const ok = (c, m, d) => {
  if (c) { pass++; console.log("   PASS  " + m); }
  else { fail++; console.log("   FAIL  " + m + (d ? "\n           " + d : "")); }
};
const ssl = /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL || "")
  ? false : { rejectUnauthorized: false };

(async () => {
  const url = process.env.DATABASE_URL;
  if (!url) { console.log("FATAL: DATABASE_URL required"); process.exit(1); }
  const pool = new Pool({ connectionString: url, ssl });
  const c = await pool.connect();
  try {
    await c.query("begin");
    const s = await seedInventory(c);
    const P = s.property_id, U = s.units;
    const soon = new Date(Date.now() + 20 * 86400000).toISOString().slice(0, 10);
    const future = new Date(Date.now() + 60 * 86400000).toISOString().slice(0, 10);
    const far = new Date(Date.now() + 120 * 86400000).toISOString().slice(0, 10);

    // A turn on a unit only ranks if a turnover is in progress on it. The base
    // fixture turns only C-turnover, so give every unit under test one.
    const turnOn = async (name) => {
      await c.query(`insert into turnovers (property_id, unit_id, status) values ($1,$2,'in_progress')`,
        [P, U[name].unit_id]);
    };
    for (const n of ["A-marketable", "J-future-locked", "I-future-pending",
                     "O-conflict", "S-two-space", "G-occupied"]) await turnOn(n);

    // An APPROVED application on a unit with no lease. This is the exact shape
    // that used to manufacture a tier-2 deadline out of nothing.
    await c.query(
      `insert into lease_applications (property_id, unit_id, applicant_name, status, person_id, approved_at)
       values ($1,$2,'Approved but uncommitted','lease_ready',$3, now())`,
      [P, U["A-marketable"].unit_id, s.person_id]);

    const out = await rankTurnPriority(c, P);
    const by = (name) => out.turns.find((t) => String(t.unit_id) === String(U[name].unit_id));

    console.log("\n── POPULATION ───────────────────────────────────────────");
    ok(out.count === 7, `7 in-progress turns ranked (${out.count})`);
    for (const n of ["A-marketable", "J-future-locked", "I-future-pending", "O-conflict", "S-two-space"]) {
      ok(!!by(n), `${n} is present in the ranking`);
    }

    console.log("\n── AN APPROVED APPLICATION CREATES NO DEADLINE ──────────");
    const approved = by("A-marketable");
    ok(approved.demand_tier_key === "raw_vacancy",
      `a lease_ready application with NO lease ranks raw_vacancy (${approved.demand_tier_key})`);
    ok(approved.deadline_known === false, "and carries no incoming-resident deadline");
    ok(approved.commitment_start_date === null, "and no invented start date");
    ok(approved.contributing_commitments.length === 0, "and no contributing commitment");
    ok(!/application/i.test(approved.reason), "its reason does not mention an application at all");

    console.log("\n── PENDING vs LOCKED ARE DIFFERENT ANSWERS ──────────────");
    const locked = by("J-future-locked"), pending = by("I-future-pending");
    ok(locked.demand_tier_key === "committed_start",
      `an executed AND funded future lease is committed_start (${locked.demand_tier_key})`);
    ok(pending.demand_tier_key === "pending_commitment",
      `an unfunded future lease is pending_commitment (${pending.demand_tier_key})`);
    ok(locked.demand_tier > pending.demand_tier,
      `locked outranks pending (${locked.demand_tier} > ${pending.demand_tier})`);
    ok(/executed and funded/i.test(locked.reason), "the locked reason states the proof it rests on");
    ok(/^Committed move-in /.test(locked.priority_label), "the locked row carries compact operator language");
    ok(/not yet both executed and funded/i.test(pending.reason),
      "the pending reason says explicitly that it is NOT yet a commitment");
    ok(/^Pending lease starts /.test(pending.priority_label), "the pending row stays visibly pending");
    ok(!/committed/i.test(pending.reason.replace(/not a commitment yet/i, "")),
      "and never presents itself as committed");
    const pendingMoveIn = await readNextCommittedMoveIn(c, { unit_id: U["I-future-pending"].unit_id });
    const lockedMoveIn = await readNextCommittedMoveIn(c, { unit_id: U["J-future-locked"].unit_id });
    ok(pendingMoveIn === null, "secondary maintenance reads do not promote a pending lease to committed");
    ok(lockedMoveIn && lockedMoveIn.commitment_state === "locked",
      "secondary maintenance reads recognize the same locked commitment");
    ok(lockedMoveIn && lockedMoveIn.proof_basis === "native_verified",
      "the committed move-in carries the canonical proof basis");
    ok(locked.commitment_start_date === future, `locked carries the canonical start date (${locked.commitment_start_date})`);
    ok(locked.deadline_known === true, "and marks the deadline known");

    console.log("\n── A CONFLICT IS SURFACED, NEVER FIRST-ROW-WINS ─────────");
    const conflict = by("O-conflict");
    ok(conflict.demand_tier_key === "conflicted_commitment",
      `overlapping claims surface as conflicted_commitment (${conflict.demand_tier_key})`);
    ok(conflict.commitment_conflict === true, "the conflict flag is set");
    ok(conflict.commitment_start_date === null, "no deadline is invented from a contested position");
    ok(conflict.deadline_known === false, "and the deadline is explicitly not known");
    ok(conflict.priority_label === "Lease commitment conflict", "the conflict label never invents a governing lease");
    ok(/unknown/i.test(conflict.reason), "the reason says which lease governs is unknown");
    ok(conflict.demand_tier === 4, "it ranks above every plannable turn");

    console.log("\n── MULTI-SPACE: ONE SPACE NEVER SILENTLY SETS THE UNIT ──");
    //  Give ONE bed of the two-space unit a locked commitment. The unit turn
    //  legitimately covers both beds, so the unit is prioritised — but the row
    //  must SAY which bed did it.
    const twoSpace = U["S-two-space"];
    const bed1 = twoSpace.space_ids[0];
    const lease = (await c.query(
      `insert into leases (property_id, space_id, lease_status, start_date, end_date, rent, tenant_ids)
       values ($1,$2,'pending',$3,$4,1500,$5) returning id`,
      [P, bed1, soon, far, [s.person_id]])).rows[0].id;
    const app = (await c.query(
      `insert into lease_applications (property_id, applicant_name, status, person_id)
       values ($1,'Bed one applicant','active',$2) returning id`, [P, s.person_id])).rows[0].id;
    const ev = (await c.query(
      `insert into events (property_id, unit_id, type, note)
       values ($1,$2,'lease_executed','multi-space fixture') returning id`,
      [P, twoSpace.unit_id])).rows[0].id;
    await c.query(
      `insert into executed_lease_records
         (application_id, property_id, space_id, rent, security_deposit, lease_start_date,
          lease_end_date, payload_hash, executed_at, signers, execution_channel,
          verified_by_user_id, event_id, record_state, document_sha256, lease_id)
       values ($1,$2,$3,1500,1500,$4,$5,'h',$4,$6,'paper',$7,$8,'verified','sha',$9)`,
      [app, P, bed1, soon, far, JSON.stringify([{ name: "S" }]), s.user_id, ev, lease]);
    await c.query(
      `insert into scheduled_charges (property_id, lease_id, period, amount, amount_paid, status, is_move_in_required)
       values ($1,$2,$3,1500,1500,'paid',true)`, [P, lease, soon]);

    const out2 = await rankTurnPriority(c, P);
    const multi = out2.turns.find((t) => String(t.unit_id) === String(twoSpace.unit_id));
    ok(multi.demand_tier_key === "committed_start",
      `the unit turn IS prioritised by its one committed bed (${multi.demand_tier_key})`);
    ok(multi.rentable_space_count === 2, `the row states the unit has 2 spaces (${multi.rentable_space_count})`);
    ok(multi.contributing_commitments.length === 1,
      `exactly ONE space contributed, and it is named (${multi.contributing_commitments.length})`);
    ok(String(multi.contributing_commitments[0].space_id) === String(bed1),
      "the contributing commitment names the exact space");
    ok(multi.contributing_commitments[0].state === "locked", "with its canonical state");
    ok(!!multi.contributing_commitments[0].lease_id, "and the lease that created it");
    ok(multi.contributing_commitments[0].proof_basis === "native_verified",
      `and the proof it rests on (${multi.contributing_commitments[0].proof_basis})`);
    ok(multi.rentable_space_count > multi.contributing_commitments.length,
      "so a reader can SEE that not every space in the unit is committed");

    console.log("\n── NO APPLICATION STATUS ANYWHERE IN SOURCE ─────────────");
    const src = require("fs").readFileSync(path.join(REPO, "src/maintenance/turn_priority.js"), "utf8");
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    ok(!/lease_applications/.test(code), "turn_priority.js never queries lease_applications");
    ok(!/'submitted'|'tenant_signed'|'lease_ready'|'accepted_term_required'/.test(code),
      "and carries no hand-maintained application status list");
    ok(!/applicant_demand/.test(code), "the applicant_demand tier is gone entirely");
    ok(!/lease_status\s*=\s*'pending'/.test(code),
      "it no longer matches lease_status directly — pending vs locked is canonical");
    ok(/availabilityRead/.test(code), "it reads canonical availability");
    ok(!/order by[\s\S]{0,60}limit 1/i.test(code),
      "no first-row-wins ordering survives");
    ok(!/unit_number\s*[=~]/.test(code), "no unit-number inference");

    console.log("\n── SORT IS BY TIER, THEN CANONICAL DATE ─────────────────");
    for (let i = 1; i < out2.turns.length; i++) {
      ok(out2.turns[i - 1].demand_tier >= out2.turns[i].demand_tier,
        `position ${i} is not ranked above position ${i - 1}`);
    }

    console.log("\n── FINAL READINESS CLOSES THE PHYSICAL TURN ─────────────");
    const closed = await closeActiveTurnoversForReadiness(c, {
      property_id: P,
      unit_id: U["A-marketable"].unit_id,
    });
    ok(closed.length === 1 && closed[0].status === "ready",
      "the active operating record closes from readiness authority");
    const afterReadyRank = await rankTurnPriority(c, P);
    ok(!afterReadyRank.turns.some((t) => String(t.unit_id) === String(U["A-marketable"].unit_id)),
      "the ready unit leaves the active maintenance queue");
    const afterReadyAvailability = await availabilityRead(c, { property_id: P });
    const readyPosition = afterReadyAvailability.rows.find(
      (r) => String(r.unit_id) === String(U["A-marketable"].unit_id));
    ok(readyPosition && readyPosition.marketing_state === "marketable_now",
      "the closed physical turn no longer blocks canonical availability");

  } catch (e) {
    fail++; console.log("   FAIL  harness threw: " + e.message + "\n" + e.stack);
  } finally {
    await c.query("rollback").catch(() => {});
    c.release(); await pool.end();
  }
  console.log("\n──────────────────────────────────────────────────────────");
  console.log(`   turn priority: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
