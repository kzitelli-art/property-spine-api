// ════════════════════════════════════════════════════════════════════
//  seed_demo_slots.js — open real tour_availability for the Demo Building.
//
//  The agent can only OFFER and BOOK real open slots. This creates them.
//
//  CORRECTIONS honored:
//   • Inserts only MISSING exact slots — it does NOT skip the whole window
//     because one slot already exists. Re-running fills only the gaps.
//   • Slot times are computed in the property's OPERATING timezone
//     (America/New_York for the Demo Building), so "10am/2pm/4pm" mean 10am/
//     2pm/4pm LOCAL, not UTC.
//
//  CLASS: delete-on-real-activation scaffolding. Real availability will come
//  from staff calendars / an external scheduler feeding tour_availability; this
//  is demo inventory so the SMS booking flow has something real to book into.
//
//  RUN:  DATABASE_URL="<db>" node seed_demo_slots.js
//        DATABASE_URL="<db>" node seed_demo_slots.js --days 5
// ════════════════════════════════════════════════════════════════════
const { Pool } = require("pg");
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const DEMO_PROPERTY_ID = "a50fbdd0-3642-431e-b532-0dcd6ab8a4fe";
const TZ = "America/New_York";       // Demo Building operating timezone
const HOURS_LOCAL = [10, 14, 16];    // 10:00, 14:00, 16:00 LOCAL
const SLOT_MINUTES = 30;
const DAYS = (() => {
  const i = process.argv.indexOf("--days");
  return i >= 0 && process.argv[i + 1] ? Math.max(1, parseInt(process.argv[i + 1])) : 5;
})();

// Compute the UTC instant for a given local wall-clock (Y-M-D H:M) in TZ.
// Uses the offset TZ has AT that instant (handles DST) by formatting a probe.
function localWallClockToUtc(year, month, day, hour, minute) {
  // start from a naive UTC guess, then correct by the zone offset at that guess
  const guess = new Date(Date.UTC(year, month - 1, day, hour, minute));
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(guess).reduce((a, p) => (a[p.type] = p.value, a), {});
  // what wall-clock did the guess render as, in TZ?
  const rendered = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour % 24, +parts.minute);
  const wanted = Date.UTC(year, month - 1, day, hour, minute);
  const offsetMs = rendered - wanted; // how far TZ is ahead of UTC at this instant
  return new Date(guess.getTime() - offsetMs);
}

// The set of local business days starting tomorrow (skip Sat/Sun).
function nextBusinessDays(n) {
  const out = [];
  const now = new Date();
  // work in TZ-local calendar terms
  let cursor = new Date(now.getTime());
  let added = 0;
  while (added < n) {
    cursor = new Date(cursor.getTime() + 24 * 3600 * 1000);
    const wd = new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "short" }).format(cursor);
    if (wd === "Sat" || wd === "Sun") continue;
    const p = new Intl.DateTimeFormat("en-US", {
      timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
    }).formatToParts(cursor).reduce((a, x) => (a[x.type] = x.value, a), {});
    out.push({ year: +p.year, month: +p.month, day: +p.day });
    added++;
  }
  return out;
}

async function main() {
  // confirm the property exists (fail honest, never seed a phantom property)
  const prop = (await pool.query(`select id, name from properties where id=$1`, [DEMO_PROPERTY_ID])).rows[0];
  if (!prop) { console.error(`Property ${DEMO_PROPERTY_ID} not found. Aborting — nothing seeded.`); await pool.end(); process.exit(1); }

  const days = nextBusinessDays(DAYS);
  let created = 0, existed = 0;
  for (const d of days) {
    for (const h of HOURS_LOCAL) {
      const starts = localWallClockToUtc(d.year, d.month, d.day, h, 0);
      const ends = new Date(starts.getTime() + SLOT_MINUTES * 60 * 1000);

      // MISSING-ONLY: insert this exact slot only if no slot with the same
      // property + starts_at already exists. Never skip the window wholesale.
      const dup = (await pool.query(
        `select id from tour_availability where property_id=$1 and starts_at=$2 limit 1`,
        [DEMO_PROPERTY_ID, starts.toISOString()])).rows[0];
      if (dup) { existed++; continue; }

      await pool.query(
        `insert into tour_availability (property_id, unit_id, leasing_agent_id, starts_at, ends_at, capacity, status)
         values ($1, null, null, $2, $3, 1, 'open')`,
        [DEMO_PROPERTY_ID, starts.toISOString(), ends.toISOString()]);
      created++;
    }
  }

  // show the resulting open future slots (in property tz) as a receipt
  const open = (await pool.query(
    `select starts_at from tour_availability
      where property_id=$1 and status='open' and starts_at > now()
      order by starts_at`, [DEMO_PROPERTY_ID])).rows;
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  });
  console.log(`\nSeed complete for ${prop.name}:`);
  console.log(`  created ${created} new slot(s), ${existed} already existed.`);
  console.log(`  ${open.length} open future slot(s) now (property local time, ${TZ}):`);
  for (const s of open) console.log(`    - ${fmt.format(new Date(s.starts_at))}`);
  await pool.end();
}

main().catch(e => { console.error("seed error:", e); process.exit(1); });
