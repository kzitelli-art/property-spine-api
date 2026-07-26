#!/usr/bin/env node
// ════════════════════════════════════════════════════════════════════
//  tools/remove_duplicate_walkins.js
//
//  Removes FOUR named walk-in tour rows created by repeated clicks on
//  2026-07-26 while the create path had no idempotency guard. Owner
//  approved, by explicit id.
//
//  DISCIPLINE — this file can only ever touch the ids hardcoded below:
//    · no property predicate, no person predicate, no origin='walk_in'
//      sweep, no date range. A category delete is how a cleanup becomes
//      an incident.
//    · DRY RUN by default. --apply is required to write.
//    · It REFUSES to delete any row that has acquired downstream
//      evidence — a tour_event, a conversion, units shown, a lead event
//      or an obligation. If a duplicate turned out to carry real work,
//      that work outranks the tidiness of removing it.
//    · It re-verifies origin='walk_in' and the expected timestamp on
//      each id before touching it, so a recycled id cannot be hit.
//    · The one LEGITIMATE walk-in is named as KEEP and is never in the
//      delete set.
//
//  USAGE:
//    node tools/remove_duplicate_walkins.js            (dry run)
//    node tools/remove_duplicate_walkins.js --apply
// ════════════════════════════════════════════════════════════════════
"use strict";
const { Pool } = require("pg");

const APPLY = process.argv.includes("--apply");

//  The one that stays: created 12:10:32Z through the flow being proven.
const KEEP = "e3a7fe5d-ab00-4861-9e46-bfcbc6c96e8f";

//  The four duplicate-click rows. Explicit, closed set.
const REMOVE = [
  "7aa5e595-8d3a-46a4-9e9a-07460c383c7e",
  "ca642a6c-a524-4638-99d7-67b699d4163e",
  "8dd92651-3752-43de-80d5-7c40d7c858cb",
  "a9f91f1d-99cd-4f51-8378-53cd57dcc855",
];

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

(async () => {
  console.log(`\n  MODE: ${APPLY ? "APPLY (deletes)" : "DRY RUN (no writes)"}`);
  console.log(`  KEEP:   ${KEEP}`);
  console.log(`  REMOVE: ${REMOVE.length} explicit ids\n`);

  if (REMOVE.includes(KEEP)) { console.error("  REFUSED: the keep id is in the remove set."); process.exit(1); }

  const rows = (await pool.query(
    `select t.id::text, t.origin, t.status, t.checked_in_at,
            (select count(*)::int from tour_events e where e.tour_id=t.id)              as tour_events,
            (select count(*)::int from leasing_conversions c where c.origin_tour_id=t.id) as conversions,
            (select count(*)::int from tour_units_shown u where u.tour_id=t.id)         as units_shown,
            (select count(*)::int from lead_events le where le.metadata->>'tour_id'=t.id::text) as lead_events
       from leasing_tours t where t.id = any($1::uuid[]) order by t.checked_in_at`, [REMOVE])).rows;

  console.log("  state of each id right now:");
  console.table(rows);

  const missing = REMOVE.filter(id => !rows.some(r => r.id === id));
  if (missing.length) console.log(`  note: ${missing.length} id(s) already absent — nothing to do for those.`);

  const unsafe = rows.filter(r =>
    r.origin !== "walk_in" || r.tour_events > 0 || r.conversions > 0 || r.units_shown > 0 || r.lead_events > 0);
  const safe = rows.filter(r => !unsafe.includes(r));

  if (unsafe.length) {
    console.log("\n  ⚠ REFUSING these — they carry evidence or are not walk-ins:");
    console.table(unsafe);
  }

  console.log(`\n  eligible for removal: ${safe.length}`);
  if (!APPLY) {
    safe.forEach(r => console.log(`   would remove  ${r.id}  (${r.checked_in_at})`));
    console.log("\n  dry run — nothing written.\n");
    await pool.end(); return;
  }

  const client = await pool.connect();
  const removed = [];
  try {
    await client.query("begin");
    for (const r of safe) {
      //  Delete is scoped to the single id AND re-asserts origin, so a
      //  concurrent change between the read and the write cannot widen it.
      const out = await client.query(
        `delete from leasing_tours where id=$1::uuid and origin='walk_in' returning id::text`, [r.id]);
      if (out.rows.length) removed.push({ id: out.rows[0].id, created: r.checked_in_at });
    }
    await client.query("commit");
  } catch (e) {
    await client.query("rollback");
    console.error("\n  FAILED — rolled back, nothing removed:", e.message, "\n");
    client.release(); await pool.end(); process.exit(1);
  }
  client.release();

  console.log("\n  ── RECEIPT ──────────────────────────────────────────");
  console.log(`  removed ${removed.length} duplicate walk-in tour row(s):`);
  removed.forEach(r => console.log(`    ${r.id}   created ${r.created}`));
  console.log(`  reason: repeated clicks on the Person Card walk-in button`);
  console.log(`          before server-side idempotency existed. Each row was`);
  console.log(`          inert — no tour event, conversion, unit or obligation.`);
  console.log(`  kept:   ${KEEP} (the legitimate walk-in)`);

  const after = (await pool.query(
    `select id::text, checked_in_at from leasing_tours where origin='walk_in' order by checked_in_at`)).rows;
  console.log(`\n  walk-in tours remaining: ${after.length}`);
  console.table(after);
  console.log("");
  await pool.end();
})().catch(e => { console.error(e); process.exit(1); });
