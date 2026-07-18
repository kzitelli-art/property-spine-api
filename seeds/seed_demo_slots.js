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
//  SHAPE (this refactor):
//   • The primitive is the EXPORTED function seedDemoSlots(pool, { days }).
//     It takes a caller-owned pool and NEVER creates or ends one. server.js
//     calls it fail-soft at boot so demo slots exist as a property of the app
//     being up — no manual re-seed, no separate cron scheduler to silently die.
//   • The CLI wrapper (bottom) is a thin convenience so
//     `node seeds/seed_demo_slots.js --days 7` still works by hand. It owns its
//     own pool + process exit; the function does not.
//
//  CLASS: delete-on-real-activation scaffolding (Class 4). Real availability
//  will come from staff calendars / an external scheduler feeding
//  tour_availability; this is demo inventory so the SMS booking flow has
//  something real to book into. The EXPORTED function and the boot-time call
//  retire together when real availability lands.
//
//  RUN (by hand):  DATABASE_URL="<db>" node seeds/seed_demo_slots.js
//                  DATABASE_URL="<db>" node seeds/seed_demo_slots.js --days 7
// ════════════════════════════════════════════════════════════════════
const { Pool } = require("pg");

const DEMO_PROPERTY_ID = "a50fbdd0-3642-431e-b532-0dcd6ab8a4fe";
const TZ = "America/New_York";       // Demo Building operating timezone
const HOURS_LOCAL = [10, 14, 16];    // 10:00, 14:00, 16:00 LOCAL
const SLOT_MINUTES = 30;

// Compute the UTC instant for a given local wall-clock (Y-M-D H:M) in TZ.
// Uses the offset TZ has AT that instant (handles DST) by formatting a probe.
function localWallClockToUtc(year, month, day, hour, minute) {
  const guess = new Date(Date.UTC(year, month - 1, day, hour, minute));
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(guess).reduce((a, p) => (a[p.type] = p.value, a), {});
  const rendered = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour % 24, +parts.minute);
  const wanted = Date.UTC(year, month - 1, day, hour, minute);
  const offsetMs = rendered - wanted; // how far TZ is ahead of UTC at this instant
  return new Date(guess.getTime() - offsetMs);
}

// The set of local business days starting tomorrow (skip Sat/Sun).
function nextBusinessDays(n) {
  const out = [];
  const now = new Date();
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

// ── THE PRIMITIVE ────────────────────────────────────────────────────
//  Caller owns the pool. Never creates one, never ends one, never calls
//  process.exit. Returns a receipt object. Fail-honest: if the Demo
//  Building property is absent, it seeds NOTHING and returns skipped:true
//  rather than fabricating a phantom property.
async function seedDemoSlots(pool, opts = {}) {
  const days = Math.max(1, parseInt(opts.days, 10) || 5);

  const prop = (await pool.query(`select id, name from properties where id=$1`, [DEMO_PROPERTY_ID])).rows[0];
  if (!prop) {
    return { skipped: true, reason: `Property ${DEMO_PROPERTY_ID} not found`, created: 0, existed: 0, openCount: 0, days };
  }

  const businessDays = nextBusinessDays(days);
  let created = 0, existed = 0;
  for (const d of businessDays) {
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

  const open = (await pool.query(
    `select starts_at from tour_availability
      where property_id=$1 and status='open' and starts_at > now()
      order by starts_at`, [DEMO_PROPERTY_ID])).rows;

  return { skipped: false, property: prop.name, created, existed, openCount: open.length, days, openSlots: open.map(s => s.starts_at) };
}

module.exports = { seedDemoSlots, DEMO_PROPERTY_ID, TZ };

// ── CLI WRAPPER (thin convenience; owns its own pool + exit) ──────────
if (require.main === module) {
  const i = process.argv.indexOf("--days");
  const days = i >= 0 && process.argv[i + 1] ? Math.max(1, parseInt(process.argv[i + 1], 10)) : 5;
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  seedDemoSlots(pool, { days })
    .then((r) => {
      if (r.skipped) { console.error(`Aborted — nothing seeded: ${r.reason}`); process.exitCode = 1; }
      else {
        const fmt = new Intl.DateTimeFormat("en-US", {
          timeZone: TZ, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
        });
        console.log(`\nSeed complete for ${r.property}:`);
        console.log(`  created ${r.created} new slot(s), ${r.existed} already existed.`);
        console.log(`  ${r.openCount} open future slot(s) now (property local time, ${TZ}):`);
        for (const s of r.openSlots) console.log(`    - ${fmt.format(new Date(s))}`);
      }
    })
    .catch((e) => { console.error("seed error:", e); process.exitCode = 1; })
    .finally(() => pool.end());
}
