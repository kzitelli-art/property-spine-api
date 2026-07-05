#!/usr/bin/env node
/* ════════════════════════════════════════════════════════════════════
   seed_demo_live_tour.js — put ONE real, completable tour on the
   Property Spine Demo Building so the live capture → obligation →
   Follow-Ups loop can be walked end to end.

   RULES (locked by the acceptance brief review):
   • DEMO_MODE=true required — refuses to run otherwise.
   • Property SERVER-DERIVED by the exact constant name; never an argument.
   • Every run creates a NEW isolated prospect + conversation + tour.
     Prior runs are RETAINED as attributable history — never erased.
   • The conversation is threaded (the queue projection inner-joins
     conversations; an unthreaded lead is invisible — the /leasing/intake
     lesson).
   • The tour cannot enter prospect outreach and sends nothing: no
     comm_events are written, no transport is touched.
   • Records tagged boardroom_demo in source fields.
   • Scheduled host = the bridged demo Katie, scheduled_for = 2h ago →
     the capture workspace opens straight in POST-TOUR mode.

   RUN (Render shell):  DEMO_MODE=true node seeds/seed_demo_live_tour.js
   ════════════════════════════════════════════════════════════════════ */
const { Pool } = require("pg");

const DEMO_PROP_NAME = "Property Spine Demo Building"; // verification only — see below
// THE TARGET IS AN IMMUTABLE ID, never a display name (names can collide or
// be renamed; an id cannot). The production Demo Building's id. QA rigs may
// override via DEMO_PROPERTY_ID; the NAME must still verify — belt and braces.
const DEMO_PROPERTY_ID = process.env.DEMO_PROPERTY_ID || "a50fbdd0-3642-431e-b532-0dcd6ab8a4fe";
const SCHEDULED_HOST_EMAIL_CANDIDATES = [
  "katie.demo@propertyspine.internal",
  "demo-manager@propertyspine.internal", // fallback: the seeded manager
];

const FIRST = ["Avery", "Rowan", "Quinn", "Sasha", "Milan", "Jules", "Devin", "Harper", "Reese", "Marlow"];
const LAST  = ["Prospect", "Walkthrough", "Demo", "Visitor", "Tourgoer"];

async function main() {
  if (String(process.env.DEMO_MODE || "").toLowerCase() !== "true") {
    console.error("REFUSED: DEMO_MODE=true is required. This seed only ever touches the demo property.");
    process.exit(1);
  }
  const ssl = process.env.PGSSL_OFF === "1" ? false : { rejectUnauthorized: false };
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl });
  const client = await pool.connect();
  try {
    await client.query("begin");

    // 1) the demo property — resolved by IMMUTABLE ID, then the display name
    //    is VERIFIED against the constant. Wrong id, renamed property, or a
    //    lookalike all refuse loudly. Never name-only targeting.
    const prop = (await client.query(
      "select id, name from properties where id=$1", [DEMO_PROPERTY_ID])).rows[0];
    if (!prop) throw new Error(`No property with id ${DEMO_PROPERTY_ID}. (Set DEMO_PROPERTY_ID for a QA rig.)`);
    if (prop.name !== DEMO_PROP_NAME) {
      throw new Error(`REFUSED: property ${prop.id} is named "${prop.name}", not "${DEMO_PROP_NAME}". This seed only ever touches the designated demo property.`);
    }
    // the run's own immutable identifier — printed in the receipt, stamped on
    // the lead. Runs append; they are never reset or deleted.
    const { randomUUID } = require("crypto");
    const demoRunId = randomUUID();

    // 2) the scheduled host — the bridged demo Katie (fallback: demo manager).
    let host = null;
    for (const email of SCHEDULED_HOST_EMAIL_CANDIDATES) {
      const r = (await client.query("select id, name, email from users where email=$1 limit 1", [email])).rows[0];
      if (r) { host = r; break; }
    }
    if (!host) {
      // last resort: any bridged demo-named user assigned at the demo property
      host = (await client.query(
        `select u.id, u.name, u.email from users u
           join property_team_assignments a on a.user_id=u.id and a.property_id=$1 and a.active=true
          where u.name ilike '%demo%' order by u.created_at asc limit 1`, [prop.id])).rows[0];
    }
    if (!host) throw new Error("No demo staff user found to schedule as host. Run seed_bridge_demo_staff.js first.");

    // 3) a NEW prospect — one per run; prior runs stay (append-only demo history).
    const runTag = new Date().toISOString().slice(5, 16).replace(/[-T:]/g, "");
    const name = `${FIRST[Math.floor(Math.random() * FIRST.length)]} ${LAST[Math.floor(Math.random() * LAST.length)]} ${runTag}`;
    const phone = "+1555" + String(Math.floor(1000000 + Math.random() * 8999999));
    const person = (await client.query(
      `insert into persons (name, phone, lifecycle_status, leasing_stage, source)
       values ($1, $2, 'lead', 'lead', 'boardroom_demo') returning id, name`,
      [name, phone])).rows[0];

    // 4) the lead — the opportunity record on THIS property.
    const lead = (await client.query(
      `insert into leasing_leads (person_id, property_id, message, status, source_lead_id)
       values ($1, $2, $3, 'tour_scheduled', 'boardroom_demo')
       returning id`,
      [person.id, prop.id,
       `Seeded live demo tour (demo_run ${demoRunId}) — walk the capture → obligation → Follow-Ups loop.`])).rows[0];

    // 5) the THREADED conversation — without it the person is invisible to the
    //    queue projection (inner join). One per (property, person); upsert-safe.
    const conv = (await client.query(
      `insert into conversations (property_id, person_id, channel_primary, status)
       values ($1, $2, 'sms', 'open')
       on conflict (property_id, person_id) do update set status='open'
       returning id`,
      [prop.id, person.id])).rows[0];

    // 6) the tour — scheduled 2 hours AGO so the capture opens in post-tour
    //    mode, hosted by the bridged demo staff member.
    const tour = (await client.query(
      `insert into leasing_tours (lead_id, property_id, scheduled_for, status, leasing_agent_id)
       values ($1, $2, now() - interval '2 hours', 'scheduled', $3)
       returning id, scheduled_for`,
      [lead.id, prop.id, host.id])).rows[0];

    await client.query("commit");

    // count of retained prior demo tours — honest history, never erased
    const prior = (await client.query(
      `select count(*)::int as n from leasing_tours t
         join leasing_leads l on l.id = t.lead_id
        where t.property_id=$1 and l.source_lead_id='boardroom_demo'`, [prop.id])).rows[0];

    console.log("✓ Live demo tour seeded on the Demo Building.");
    console.log(`  demo_run_id:   ${demoRunId}`);
    console.log(`  property:      ${prop.id}  ("${prop.name}", verified)`);
    console.log(`  prospect:      ${person.name}  (${person.id})`);
    console.log(`  lead:          ${lead.id}`);
    console.log(`  conversation:  ${conv.id}  (threaded — visible to the queue)`);
    console.log(`  tour:          ${tour.id}  · scheduled ${tour.scheduled_for.toISOString()} · host ${host.name || host.email}`);
    console.log(`  demo tours retained on this property (incl. this one): ${prior.n} — prior runs are history, not clutter.`);
    console.log("");
    console.log("Next: in the app (live session) → Leasing → Tours → open this tour → capture the outcome.");
  } catch (e) {
    await client.query("rollback").catch(() => {});
    console.error("SEED FAILED (rolled back, nothing written):", e.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}
main();
