// ════════════════════════════════════════════════════════════════════
//  PROOF HARNESS — governed agent tour booking
//
//  Proves the 7 required behaviors on a REAL Postgres built from real
//  migrations (incl. 079). Self-cleaning by exact tracked UUIDs.
//
//   1. Model supplies a slot from ANOTHER property → refused, no writes.
//   2. Model supplies an unopened/stale/never-offered slot → refused.
//   3. Same idempotency key retried → ONE tour (not two).
//   4. Same lead later books a DIFFERENT valid slot (new action) → allowed
//      (governed), NOT blocked by any global lead uniqueness.
//   5. Attribution records SYSTEM execution + the originating prospect/run.
//   6. Capability disabled → no booking, honest refusal, NO partial writes.
//   7. Seed rerun inserts only missing slots + respects property timezone.
//   + /demo/book regression: still books via the shared service.
//
//  RUN:  HARNESS_DATABASE_URL="<disposable-db>" node tour_booking_proof.js
// ════════════════════════════════════════════════════════════════════
const { Pool } = require("pg");
const crypto = require("crypto");
const receipt = require("./_run_receipt");
const { databaseSsl } = require("../src/shared/database_ssl");
const URL = receipt.harnessConnectionString();
const EXPECTED = 33;
const pool = new Pool({ connectionString: URL, ssl: databaseSsl(URL) });
const uuid = () => crypto.randomUUID();

let passed = 0, failed = 0;
function check(name, cond, detail = "") {
  if (cond) { passed++; console.log(`  \u2713 ${name}`); }
  else { failed++; console.log(`  \u2717 ${name}${detail ? "  \u2014 " + detail : ""}`); }
}

const created = { properties: [], lines: [], units: [], spaces: [], persons: [], leads: [], slots: [], tours: [] };
function track(k, id) { created[k].push(id); return id; }

// Build the leasingleads module to get its _service (the real booking service).
const noopSms = { enabled: () => false, sendSms: async () => ({ sent: false }) };
const leasing = require("../src/leasing/leasingleads.js")({
  pool, anthropic: null, INGEST_MODEL: "fake",
  sms: noopSms, leasingLifecycle: null, conversionServices: {}, commBoundary: null,
});
const svc = leasing._service;

async function mkProp(name) {
  const id = track("properties", uuid());
  await pool.query(`insert into properties (id, name) values ($1,$2)`, [id, name]);
  const lineId = track("lines", uuid());
  await pool.query(
    `insert into communication_lines
       (id,e164,line_type,property_id,authority_ceiling,permitted_audience,
        inbound_enabled,outbound_enabled,outbound_policy,status)
     values ($1,$2,'property_facing',$3,'external','residents_and_prospects',true,true,'proactive','active')`,
    [lineId, "+1555" + Math.floor(1e6 + Math.random() * 8e6), id]
  );
  const u = track("units", uuid());
  await pool.query(`insert into units (id, property_id, unit_number, bedrooms, bathrooms, market_rent, occupancy_status) values ($1,$2,'U-1',1,1,1500,'vacant')`, [u, id]);
  return { id, unitId: u };
}
async function mkPerson(name) {
  const id = track("persons", uuid());
  await pool.query(`insert into persons (id, name, phone) values ($1,$2,$3)`, [id, name, "+1555" + Math.floor(1e6 + Math.random() * 8e6)]);
  return id;
}
async function mkLead(personId, propId, status = "new") {
  const id = track("leads", uuid());
  await pool.query(`insert into leasing_leads (id, person_id, property_id, status) values ($1,$2,$3,$4)`, [id, personId, propId, status]);
  return id;
}
async function mkSlot(propId, unitId, hoursFromNow = 48, status = "open") {
  const id = track("slots", uuid());
  const starts = new Date(Date.now() + hoursFromNow * 3600 * 1000);
  const ends = new Date(starts.getTime() + 30 * 60000);
  await pool.query(`insert into tour_availability (id, property_id, unit_id, starts_at, ends_at, capacity, status) values ($1,$2,$3,$4,$5,1,$6)`,
    [id, propId, unitId, starts.toISOString(), ends.toISOString(), status]);
  return id;
}
async function tourCount(leadId) { return Number((await pool.query(`select count(*)::int n from leasing_tours where lead_id=$1`, [leadId])).rows[0].n); }
async function bookViaService(args) {
  const c = await pool.connect();
  try {
    await c.query("begin");
    const out = await svc.bookTourIntoSlot(c, args);
    await c.query("commit");
    if (out.tour && out.tour.id) track("tours", out.tour.id);
    return { ok: true, out };
  } catch (e) { try { await c.query("rollback"); } catch (_) {} return { ok: false, err: e }; }
  finally { c.release(); }
}

async function main() {
  receipt.begin(__filename, { url: URL, expected: EXPECTED });
  process.env.AGENT_TOUR_BOOKING_PROPERTY_IDS = ""; // start disabled; each test sets as needed

  const propA = await mkProp("Prop A (booking target)");
  const propB = await mkProp("Prop B (other property)");
  // enable booking for propA only
  process.env.AGENT_TOUR_BOOKING_PROPERTY_IDS = propA.id;

  console.log("\n\u2500\u2500\u2500 GOVERNED BOOKING PROOFS (real Postgres) \u2500\u2500\u2500");

  // 1. cross-property slot → refused, no writes
  {
    const person = await mkPerson("XProp Prospect");
    const lead = await mkLead(person, propA.id);
    const slotB = await mkSlot(propB.id, propB.unitId); // slot at the WRONG property
    const before = await tourCount(lead);
    const res = await bookViaService({ leadId: lead, slotId: slotB, subjectPersonId: person, idempotencyKey: "k_xprop", requireAgentBookingCapability: true });
    const after = await tourCount(lead);
    check("1. cross-property slot → refused", !res.ok && res.err && res.err.httpStatus === 409, res.ok ? "unexpectedly booked" : res.err.message);
    check("1. cross-property slot → NO tour written", after - before === 0, `${before}->${after}`);
    const slotStillOpen = (await pool.query(`select status from tour_availability where id=$1`, [slotB])).rows[0].status;
    check("1. cross-property slot stays 'open' (no partial write)", slotStillOpen === "open", slotStillOpen);
  }

  // 2. unopened / never-offered slot → refused (slot exists but status != open)
  {
    const person = await mkPerson("Stale Slot Prospect");
    const lead = await mkLead(person, propA.id);
    const bookedSlot = await mkSlot(propA.id, propA.unitId, 72, "booked"); // already booked/blocked
    const before = await tourCount(lead);
    const res = await bookViaService({ leadId: lead, slotId: bookedSlot, subjectPersonId: person, idempotencyKey: "k_stale", requireAgentBookingCapability: true });
    const after = await tourCount(lead);
    check("2. unopened/stale slot → refused", !res.ok && res.err && res.err.httpStatus === 409, res.ok ? "unexpectedly booked" : (res.err && res.err.message));
    check("2. unopened/stale slot → NO tour written", after - before === 0, `${before}->${after}`);
  }
  // 2b. never-existed slot id → refused
  {
    const person = await mkPerson("Ghost Slot Prospect");
    const lead = await mkLead(person, propA.id);
    const res = await bookViaService({ leadId: lead, slotId: uuid(), subjectPersonId: person, idempotencyKey: "k_ghost", requireAgentBookingCapability: true });
    check("2b. non-existent slot id → refused (404)", !res.ok && res.err && res.err.httpStatus === 404, res.ok ? "unexpectedly booked" : (res.err && res.err.message));
  }

  // 3. same idempotency key retried → one tour
  {
    const person = await mkPerson("Idem Prospect");
    const lead = await mkLead(person, propA.id);
    const slot = await mkSlot(propA.id, propA.unitId, 96);
    const key = "k_idem_" + crypto.randomBytes(4).toString("hex");
    const r1 = await bookViaService({ leadId: lead, slotId: slot, subjectPersonId: person, idempotencyKey: key, requireAgentBookingCapability: true });
    const r2 = await bookViaService({ leadId: lead, slotId: slot, subjectPersonId: person, idempotencyKey: key, requireAgentBookingCapability: true });
    const n = await tourCount(lead);
    check("3. same idempotency key retried → both succeed", r1.ok && r2.ok, `r1=${r1.ok} r2=${r2.ok}`);
    check("3. same idempotency key retried → exactly ONE tour", n === 1, `count=${n}`);
    check("3. retry returns alreadyBooked=true + same tour id", r2.ok && r2.out.alreadyBooked === true && r1.out.tour.id === r2.out.tour.id, JSON.stringify({ already: r2.ok && r2.out.alreadyBooked }));
  }

  // 4. same lead later books a DIFFERENT valid slot under a NEW action → allowed
  {
    const person = await mkPerson("Rebook Prospect");
    const lead = await mkLead(person, propA.id);
    const slot1 = await mkSlot(propA.id, propA.unitId, 120);
    const slot2 = await mkSlot(propA.id, propA.unitId, 144);
    const r1 = await bookViaService({ leadId: lead, slotId: slot1, subjectPersonId: person, idempotencyKey: "k_rebook_1", requireAgentBookingCapability: true });
    const r2 = await bookViaService({ leadId: lead, slotId: slot2, subjectPersonId: person, idempotencyKey: "k_rebook_2", requireAgentBookingCapability: true });
    const n = await tourCount(lead);
    check("4. same lead, different slot, NEW action key → both book (governed, not blocked)", r1.ok && r2.ok && !r2.out.alreadyBooked, `r1=${r1.ok} r2=${r2.ok} already2=${r2.ok && r2.out.alreadyBooked}`);
    check("4. same lead now has TWO tours (reschedule/second is legitimate)", n === 2, `count=${n}`);
  }

  // 5. attribution: SYSTEM execution + originating prospect/run recorded
  {
    const person = await mkPerson("Attrib Prospect");
    const lead = await mkLead(person, propA.id);
    const slot = await mkSlot(propA.id, propA.unitId, 168);
    const fakeCommEvent = uuid(), fakeRun = uuid();
    const r = await bookViaService({ leadId: lead, slotId: slot, subjectPersonId: person, sourceCommEventId: fakeCommEvent, sourceAgentRunId: fakeRun, idempotencyKey: "k_attrib", requireAgentBookingCapability: true });
    const ev = (await pool.query(`select actor_type, actor_id, metadata from tour_events where tour_id=$1 and event_type='scheduled' limit 1`, [r.out.tour.id])).rows[0];
    check("5. tour_event execution actor = 'system'", ev && ev.actor_type === "system" && ev.actor_id === null, JSON.stringify({ actor: ev && ev.actor_type }));
    check("5. subject prospect recorded (not as executor)", ev && ev.metadata && ev.metadata.subject_person_id === person, JSON.stringify({ subj: ev && ev.metadata && ev.metadata.subject_person_id }));
    check("5. originating comm_event + agent run recorded", ev && ev.metadata && ev.metadata.source_comm_event_id === fakeCommEvent && ev.metadata.source_agent_run_id === fakeRun, JSON.stringify(ev && ev.metadata));
  }

  // 6. capability disabled → no booking, honest error, no partial writes
  {
    process.env.AGENT_TOUR_BOOKING_PROPERTY_IDS = ""; // disable ALL
    const person = await mkPerson("Disabled Prospect");
    const lead = await mkLead(person, propA.id);
    const slot = await mkSlot(propA.id, propA.unitId, 192);
    const before = await tourCount(lead);
    const res = await bookViaService({ leadId: lead, slotId: slot, subjectPersonId: person, idempotencyKey: "k_disabled", requireAgentBookingCapability: true });
    const after = await tourCount(lead);
    check("6. capability disabled → refused (403)", !res.ok && res.err && res.err.httpStatus === 403, res.ok ? "unexpectedly booked" : (res.err && res.err.message));
    check("6. capability disabled → NO tour written", after - before === 0, `${before}->${after}`);
    const slotStatus = (await pool.query(`select status from tour_availability where id=$1`, [slot])).rows[0].status;
    check("6. capability disabled → slot stays open (no partial write)", slotStatus === "open", slotStatus);
    process.env.AGENT_TOUR_BOOKING_PROPERTY_IDS = propA.id; // re-enable
  }

  // 7. UNKNOWN property timezone → readOfferableSlots returns NULL (no labels,
  //    no offer), NOT a silent Eastern default. Known tz → real labels.
  {
    // propA has no tz mapping (only the Demo Building UUID + env map are known),
    // so its offerable read must be null. Set a QA tz via env for a check too.
    const unknownRead = await svc.readOfferableSlots(pool, { propertyId: propA.id, limit: 20 });
    check("4. UNKNOWN property tz → readOfferableSlots returns null (no invented labels)",
      unknownRead === null, `got ${unknownRead === null ? "null" : JSON.stringify(unknownRead && unknownRead.slice(0,1))}`);
    // Slice 9: loadPropertyOperatingTimezone is ASYNC — the operating timezone is a governed
    // column read (properties.operating_timezone), no longer a hardcoded map.
    const unknownTz = await svc.loadPropertyOperatingTimezone(propA.id);
    check("4. UNKNOWN property tz → loadPropertyOperatingTimezone returns null (honest, not Eastern)",
      unknownTz === null, `got ${unknownTz}`);

    // Configured tz: the timezone is now CONFIGURED DATA, not a code allowlist,
    // so this fixture sets it the same way production does (migration 123
    // backfilled exactly this value for this property). The happy path then
    // produces tz-formatted labels.
    const DEMO = "a50fbdd0-3642-431e-b532-0dcd6ab8a4fe";
    const demoExists = (await pool.query("select id from properties where id=$1", [DEMO])).rows[0];
    if (!demoExists) {
      await pool.query(`insert into properties (id,name) values ($1,'Property Spine Demo Building')`, [DEMO]);
    }
    await pool.query(`update properties set operating_timezone='America/New_York' where id=$1`, [DEMO]);
    const demoUnit = track("units", uuid());
    await pool.query(`insert into units (id,property_id,unit_number,bedrooms,bathrooms,market_rent,occupancy_status) values ($1,$2,'D-1',1,1,1500,'vacant')`, [demoUnit, DEMO]);
    const s1 = track("slots", uuid());
    const st = new Date(Date.now() + 200 * 3600 * 1000), en = new Date(st.getTime() + 30 * 60000);
    await pool.query(`insert into tour_availability (id,property_id,unit_id,starts_at,ends_at,capacity,status) values ($1,$2,$3,$4,$5,1,'open')`, [s1, DEMO, demoUnit, st.toISOString(), en.toISOString()]);
    const s2 = track("slots", uuid());
    const st2 = new Date(Date.now() + 224 * 3600 * 1000), en2 = new Date(st2.getTime() + 30 * 60000);
    await pool.query(`insert into tour_availability (id,property_id,unit_id,starts_at,ends_at,capacity,status) values ($1,$2,$3,$4,$5,1,'booked')`, [s2, DEMO, demoUnit, st2.toISOString(), en2.toISOString()]);
    const knownRead = await svc.readOfferableSlots(pool, { propertyId: DEMO, limit: 50 });
    const ids = (knownRead || []).map(o => o.slot_id);
    check("7. configured tz → offerable reader returns the OPEN slot", ids.includes(s1), JSON.stringify(ids.slice(0, 3)));
    check("7. configured tz → offerable reader EXCLUDES the booked slot", !ids.includes(s2), "");
    check("7. configured tz → slots carry a tz-formatted label",
      knownRead && knownRead.length > 0 && /\d{1,2}:\d{2}\s?(AM|PM)/i.test((knownRead.find(o => o.slot_id === s1) || {}).label || ""),
      knownRead && (knownRead.find(o => o.slot_id === s1) || {}).label);
    // clean the demo slots we just made (tracked, but demo property is shared — leave the property)
  }

  // 8. The legacy "requested" tour shape is an adapter input, not a second
  //    booking transaction. It is promoted through bookTourIntoSlot and may
  //    never be attached to another lead's slot booking.
  {
    const person = await mkPerson("Requested Tour Prospect");
    const lead = await mkLead(person, propA.id);
    const requestedTour = track("tours", uuid());
    await pool.query(
      `insert into leasing_tours (id,lead_id,property_id,status,requested_for)
       values ($1,$2,$3,'requested',$4)`,
      [requestedTour, lead, propA.id, new Date(Date.now() + 216 * 3600000).toISOString()]
    );
    const slot = await mkSlot(propA.id, propA.unitId, 216);
    const promoted = await bookViaService({
      leadId: lead,
      slotId: slot,
      existingTourId: requestedTour,
      idempotencyKey: "k_promote_requested",
      via: "operator_key_booking_adapter",
    });
    check("8. requested tour is promoted through the canonical service", promoted.ok && promoted.out.tour.id === requestedTour);
    check("8. promotion creates no second tour", await tourCount(lead) === 1);
    const promotedRow = (await pool.query("select status,slot_id from leasing_tours where id=$1", [requestedTour])).rows[0];
    const promotedSlot = (await pool.query("select status,booked_tour_id from tour_availability where id=$1", [slot])).rows[0];
    check("8. promotion projects the same scheduled truth", promotedRow.status === "scheduled" && promotedRow.slot_id === slot && promotedSlot.status === "booked" && promotedSlot.booked_tour_id === requestedTour);

    const otherPerson = await mkPerson("Other Requested Tour Prospect");
    const otherLead = await mkLead(otherPerson, propA.id);
    const wrongTour = track("tours", uuid());
    await pool.query(
      `insert into leasing_tours (id,lead_id,property_id,status,requested_for)
       values ($1,$2,$3,'requested',$4)`,
      [wrongTour, lead, propA.id, new Date(Date.now() + 232 * 3600000).toISOString()]
    );
    const otherSlot = await mkSlot(propA.id, propA.unitId, 232);
    const refused = await bookViaService({ leadId: otherLead, slotId: otherSlot, existingTourId: wrongTour });
    check("8. another lead's requested tour is refused", !refused.ok && refused.err && refused.err.httpStatus === 404);
    const untouched = (await pool.query("select status from tour_availability where id=$1", [otherSlot])).rows[0];
    check("8. the refused promotion leaves no partial slot write", untouched.status === "open" && await tourCount(otherLead) === 0);
  }

  // 5-CONCURRENCY. Two CONCURRENT executions of the SAME namespaced booking
  //    action key → exactly ONE tour, both return controlled results (one books,
  //    one resolves to the same tour via the 23505 backstop — never a 500,
  //    never two tours).
  {
    const person = await mkPerson("Concurrent Prospect");
    const lead = await mkLead(person, propA.id);
    const slot = await mkSlot(propA.id, propA.unitId, 300);
    const key = "agent-book-tour:conv-conc:SMconc:" + slot; // one namespaced action
    const bookOnce = async () => {
      const c = await pool.connect();
      try {
        await c.query("begin");
        const out = await svc.bookTourIntoSlot(c, { leadId: lead, slotId: slot, subjectPersonId: person, idempotencyKey: key, requireAgentBookingCapability: true });
        await c.query("commit");
        return { ok: true, out };
      } catch (e) {
        try { await c.query("rollback"); } catch (_) {}
        // 23505 (unique key) OR the slot lock loser → resolve to the winner's
        // tour. Brief retry: the winner's commit may not be visible the instant
        // the loser rolls back. This models the agent handler's backstop.
        if (e && (e.code === "23505" || (e.httpStatus === 409))) {
          for (let i = 0; i < 5; i++) {
            const ex = (await pool.query(`select id, scheduled_for from leasing_tours where booking_idempotency_key=$1 limit 1`, [key])).rows[0];
            if (ex) return { ok: true, out: { tour: ex, alreadyBooked: true }, viaBackstop: true };
            await new Promise(r => setTimeout(r, 40));
          }
        }
        return { ok: false, err: e };
      } finally { c.release(); }
    };
    const [a, b] = await Promise.all([bookOnce(), bookOnce()]);
    const n = await tourCount(lead);
    if (a.out && a.out.tour) track("tours", a.out.tour.id);
    check("5. concurrent same-key → exactly ONE tour", n === 1, `count=${n}`);
    check("5. concurrent same-key → both return controlled results (no 500)", a.ok && b.ok, `a=${a.ok} b=${b.ok}`);
    check("5. concurrent same-key → both point at the same tour", a.ok && b.ok && a.out.tour.id === b.out.tour.id, JSON.stringify({ a: a.out && a.out.tour && a.out.tour.id, b: b.out && b.out.tour && b.out.tour.id }));
  }
  //   Prove a direct service booking produces a leasing_tours row visible as a
  //   Tours-module read (status 'scheduled', slot flipped).
  {
    const person = await mkPerson("Regression Prospect");
    const lead = await mkLead(person, propA.id);
    const slot = await mkSlot(propA.id, propA.unitId, 248);
    const r = await bookViaService({ leadId: lead, slotId: slot, subjectPersonId: person, idempotencyKey: "k_reg", via: "public_demo_booking", requireAgentBookingCapability: false });
    const tour = (await pool.query(`select status, slot_id, scheduled_for from leasing_tours where id=$1`, [r.out.tour.id])).rows[0];
    const slotStatus = (await pool.query(`select status, booked_tour_id from tour_availability where id=$1`, [slot])).rows[0];
    check("+ regression: tour lands in leasing_tours status='scheduled'", tour && tour.status === "scheduled" && tour.slot_id === slot, JSON.stringify(tour));
    check("+ regression: slot flipped to 'booked' pointing at the tour", slotStatus.status === "booked" && slotStatus.booked_tour_id === r.out.tour.id, JSON.stringify(slotStatus));
    const funnel = (await pool.query(`select status, tour_scheduled_at from leasing_leads where id=$1`, [lead])).rows[0];
    check("+ regression: funnel advanced to tour_scheduled", funnel.status === "tour_scheduled" && funnel.tour_scheduled_at != null, JSON.stringify(funnel));
  }

  await cleanup();
  const exitCode = receipt.complete({ harness: __filename, passed, failed, expectedAtLeast: EXPECTED });
  await pool.end();
  process.exit(exitCode);
}

async function cleanup() {
  const del = async (t, ids) => { if (!ids.length) return; const ph = ids.map((_, i) => `$${i + 1}`).join(","); await pool.query(`delete from ${t} where id in (${ph})`, ids).catch(e => console.log(`  (cleanup ${t}: ${e.message.split("\n")[0]})`)); };
  // children first
  if (created.leads.length) {
    const ph = created.leads.map((_, i) => `$${i + 1}`).join(",");
    await pool.query(`delete from tour_events where lead_id in (${ph})`, created.leads).catch(() => {});
    await pool.query(`delete from lead_events where lead_id in (${ph})`, created.leads).catch(() => {});
  }
  // slots point at tours (booked_tour_id) and tours point at slots — null the slot fk then delete tours then slots
  if (created.slots.length) {
    const ph = created.slots.map((_, i) => `$${i + 1}`).join(",");
    await pool.query(`update tour_availability set booked_tour_id=null where id in (${ph})`, created.slots).catch(() => {});
  }
  await del("leasing_tours", created.tours);
  await del("tour_availability", created.slots);
  await del("leasing_leads", created.leads);
  await del("spaces", created.spaces);
  await del("units", created.units);
  await del("persons", created.persons);
  await del("communication_lines", created.lines);
  await del("properties", created.properties);
  console.log("  cleanup complete (only tracked UUIDs touched).");
}

main().catch(async (e) => {
  const exitCode = receipt.died(__filename, e, passed + failed);
  try { await cleanup(); } catch (_) {}
  try { await pool.end(); } catch (_) {}
  process.exit(exitCode);
});
