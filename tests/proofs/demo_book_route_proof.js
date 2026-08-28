// ════════════════════════════════════════════════════════════════════
//  /demo/book ROUTE + LINK LIFECYCLE PROOF (post-extraction regression)
//
//  Drives the ACTUAL /demo/intake (mint link) and /demo/book (consume link)
//  routes and asserts the link lifecycle is preserved after the booking core
//  was extracted into the shared bookTourIntoSlot service:
//   · token/link resolution (valid token books)
//   · slot booking THROUGH the extracted service (leasing_tours + slot flip)
//   · link consumed ONLY after a successful booking
//   · replay: booking the same consumed link returns the SAME tour (no dup)
//   · slot-taken: booking a slot already taken → controlled 409, link not consumed
//   · invalid token → 404
// ════════════════════════════════════════════════════════════════════
const { Pool } = require("pg");
const express = require("express"); const http = require("http"); const crypto = require("crypto");
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const uuid = () => crypto.randomUUID();
let passed = 0, failed = 0;
const chk = (n, c, d = "") => { if (c) { passed++; console.log(`  \u2713 ${n}`); } else { failed++; console.log(`  \u2717 ${n} ${d}`); } };

const DEMO_NAME = "Property Spine Demo Building";
process.env.DEMO_MODE = "true";
process.env.DEMO_BOOKING_ENABLED = "true";

const noopSms = { enabled: () => false, sendSms: async () => ({ sent: false }), validateWebhook: () => true };
const leasing = require("../../src/leasing/leasing_leads.js")({ pool, anthropic: null, INGEST_MODEL: "fake", sms: noopSms, leasingLifecycle: null, conversionServices: {}, commBoundary: null });

let srv, base;
const track = { properties: [], units: [], slots: [], persons: [], leads: [], convs: [] };
const DEMO_ID = "a50fbdd0-3642-431e-b532-0dcd6ab8a4fe"; // module-scope so cleanup() can use it

async function post(path, body) {
  const res = await fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  let j = null; try { j = await res.json(); } catch (_) {}
  return { status: res.status, json: j };
}

async function main() {
  const app = express(); app.use(express.json()); app.use("/", leasing);
  srv = http.createServer(app); await new Promise(r => srv.listen(0, r));
  base = `http://127.0.0.1:${srv.address().port}`;

  // Demo property: use the CANONICAL demo UUID that /demo/intake resolves by
  // name (production has exactly one). Upsert it; do NOT create a second
  // same-named property (that would fork the name lookup).
  const propId = DEMO_ID; track.properties.push(propId); // canonical demo id
  await pool.query(`insert into properties (id,name,sms_number) values ($1,$2,$3) on conflict (id) do update set name=excluded.name`, [propId, DEMO_NAME, "+12154452021"]);
  // NO property-wide wipe — the demo property holds real prior data (historical
  // tours, seeded availability). This run creates its OWN isolated unit + slots
  // and only ever touches those. Any stray D-1 from a previously-crashed run is
  // cleared narrowly (unique to this test), never the whole property.
  await pool.query(`delete from tour_availability where property_id=$1 and unit_id in (select id from units where property_id=$1 and unit_number='D-1')`, [propId]).catch(()=>{});
  await pool.query(`delete from units where property_id=$1 and unit_number='D-1'`, [propId]).catch(()=>{});
  const unitId = uuid(); track.units.push(unitId);
  await pool.query(`insert into units (id,property_id,unit_number,bedrooms,bathrooms,market_rent,occupancy_status) values ($1,$2,'D-1',1,1,1500,'vacant')`, [unitId, propId]);
  // two open slots
  const mkSlot = async (h) => { const id = uuid(); track.slots.push(id); const st = new Date(Date.now() + h * 3600e3), en = new Date(st.getTime() + 30 * 60e3); await pool.query(`insert into tour_availability (id,property_id,unit_id,starts_at,ends_at,capacity,status) values ($1,$2,$3,$4,$5,1,'open')`, [id, propId, unitId, st.toISOString(), en.toISOString()]); return id; };
  const slot1 = await mkSlot(48);
  const slot2 = await mkSlot(72);

  // ── mint a real link via /demo/intake ──
  const phone = "+1555" + Math.floor(1e6 + Math.random() * 8e6);
  const intake = await post("/demo/intake", { first_name: "Link", last_name: "Prospect", phone, desired_bedrooms: 1 });
  chk("intake minted a booking token", intake.status === 200 && !!intake.json.booking_token, JSON.stringify({ s: intake.status, tok: !!(intake.json && intake.json.booking_token) }));
  const token = intake.json.booking_token;
  if (intake.json.conversation_id) track.convs.push(intake.json.conversation_id);
  if (intake.json.person_id) track.persons.push(intake.json.person_id);

  // ── invalid token → 404 ──
  {
    const bad = await post("/demo/book", { token: "not-a-real-token", slot_id: slot1 });
    chk("invalid token → 404 (link resolution enforced)", bad.status === 404, `status=${bad.status}`);
  }

  // ── valid token books slot1 through the extracted service ──
  let bookedTourId = null;
  {
    const ok = await post("/demo/book", { token, slot_id: slot1 });
    chk("valid token books → 200 + tour_id", ok.status === 200 && !!ok.json.tour_id, JSON.stringify({ s: ok.status }));
    bookedTourId = ok.json.tour_id;
    if (bookedTourId) track.slots.push(slot1);
    const tour = (await pool.query(`select status, slot_id from leasing_tours where id=$1`, [bookedTourId])).rows[0];
    chk("booking wrote leasing_tours status='scheduled' via shared service", tour && tour.status === "scheduled" && tour.slot_id === slot1, JSON.stringify(tour));
    const slotStatus = (await pool.query(`select status, booked_tour_id from tour_availability where id=$1`, [slot1])).rows[0];
    chk("slot1 flipped to booked pointing at the tour", slotStatus.status === "booked" && slotStatus.booked_tour_id === bookedTourId, JSON.stringify(slotStatus));
    // link consumed ONLY after success
    const link = (await pool.query(`select status, booked_tour_id from tour_booking_links where token_digest=$1`, [crypto.createHash("sha256").update(token).digest("hex")])).rows[0];
    chk("link consumed only AFTER successful booking (status=consumed, points at tour)", link.status === "consumed" && link.booked_tour_id === bookedTourId, JSON.stringify(link));
  }

  // ── replay: same consumed link → SAME tour, no duplicate ──
  {
    const replay = await post("/demo/book", { token, slot_id: slot2 }); // even a different slot
    chk("replay of consumed link → returns SAME tour (already_booked), no dup", replay.status === 200 && replay.json.already_booked === true && replay.json.tour_id === bookedTourId, JSON.stringify(replay.json));
    // Count ONLY tours for THIS booking's lead — never the whole property (the
    // demo property legitimately holds prior real tours, e.g. historical ones,
    // which must not pollute this assertion). The invariant under test is
    // "replay created no SECOND tour for this booking," so scope to its lead.
    const n = (await pool.query(
      `select count(*)::int c from leasing_tours
        where lead_id = (select lead_id from leasing_tours where id=$1)`,
      [bookedTourId])).rows[0].c;
    chk("still exactly ONE tour after replay (scoped to this booking's lead)", n === 1, `count=${n}`);
    // slot2 must remain OPEN (replay did not book it)
    const s2 = (await pool.query(`select status from tour_availability where id=$1`, [slot2])).rows[0];
    chk("replay did NOT book the other slot (slot2 still open)", s2.status === "open", s2.status);
  }

  // ── slot-taken: a FRESH link trying to book slot1 (already booked) → 409, link NOT consumed ──
  {
    const phone2 = "+1555" + Math.floor(1e6 + Math.random() * 8e6);
    const intake2 = await post("/demo/intake", { first_name: "Second", last_name: "Prospect", phone: phone2, desired_bedrooms: 1 });
    if (intake2.json.conversation_id) track.convs.push(intake2.json.conversation_id);
    if (intake2.json.person_id) track.persons.push(intake2.json.person_id);
    const token2 = intake2.json.booking_token;
    const taken = await post("/demo/book", { token: token2, slot_id: slot1 }); // slot1 is booked
    chk("booking an already-taken slot → controlled 409 (not 500)", taken.status === 409, `status=${taken.status}`);
    const link2 = (await pool.query(`select status from tour_booking_links where token_digest=$1`, [crypto.createHash("sha256").update(token2).digest("hex")])).rows[0];
    chk("failed booking did NOT consume the link (still active)", link2.status !== "consumed", link2.status);
  }

  srv.close();
  await cleanup();
  console.log(`\n\u2550 RESULT: ${passed} passed, ${failed} failed \u2550`);
  await pool.end(); process.exit(failed === 0 ? 0 : 1);
}

async function cleanup() {
  // SCOPED cleanup: only the persons + slots THIS run created. NEVER property-
  // wide — the demo property legitimately holds real prior data (historical
  // tours, the seeded availability slots) that must never be touched. Children
  // first, then parents, to respect foreign keys.
  const persons = [...new Set(track.persons)];
  const slots = [...new Set(track.slots)];

  if (persons.length) {
    const ph = persons.map((_, i) => `$${i + 1}`).join(",");
    // tour_events / conversions / tours for leads owned by our test persons
    await pool.query(`delete from tour_events where tour_id in (select t.id from leasing_tours t join leasing_leads l on l.id=t.lead_id where l.person_id in (${ph}))`, persons).catch(() => {});
    await pool.query(`delete from leasing_conversions where origin_tour_id in (select t.id from leasing_tours t join leasing_leads l on l.id=t.lead_id where l.person_id in (${ph}))`, persons).catch(() => {});
    await pool.query(`delete from leasing_tours where lead_id in (select id from leasing_leads where person_id in (${ph}))`, persons).catch(() => {});
    // booking links tied to our persons' leads
    await pool.query(`delete from tour_booking_links where lead_id in (select id from leasing_leads where person_id in (${ph}))`, persons).catch(() => {});
    await pool.query(`delete from agent_tour_offers where lead_id in (select id from leasing_leads where person_id in (${ph}))`, persons).catch(() => {});
    await pool.query(`delete from lead_events where lead_id in (select id from leasing_leads where person_id in (${ph}))`, persons).catch(() => {});
    await pool.query(`delete from leasing_leads where person_id in (${ph})`, persons).catch(() => {});
    await pool.query(`delete from comm_events where person_id in (${ph})`, persons).catch(() => {});
    await pool.query(`delete from conversations where person_id in (${ph})`, persons).catch(() => {});
  }
  // reset + remove ONLY the slots this run created (never the seeded ones)
  if (slots.length) {
    const ph = slots.map((_, i) => `$${i + 1}`).join(",");
    await pool.query(`update tour_availability set booked_tour_id=null where id in (${ph})`, slots).catch(() => {});
    await pool.query(`delete from tour_availability where id in (${ph})`, slots).catch(() => {});
  }
  for (const p of persons) await pool.query(`delete from persons where id=$1`, [p]).catch(() => {});
  // the D-1 unit this run created (unique to the test)
  await pool.query(`delete from units where property_id=$1 and unit_number='D-1'`, [DEMO_ID]).catch(() => {});
  // canonical demo property + seeded slots are shared fixtures; never deleted
  console.log("  cleanup complete (scoped to this run's data only).");
}
main().catch(async e => { console.error("ROUTE PROOF ERROR:", e); try { if (srv) srv.close(); await cleanup(); } catch (_) {} try { await pool.end(); } catch (_) {} process.exit(1); });
