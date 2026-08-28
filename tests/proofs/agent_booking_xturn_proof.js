// ════════════════════════════════════════════════════════════════════
//  CROSS-TURN + OFFER-INTEGRITY AGENT BOOKING PROOF
//  Proves (via the REAL agent route + offer_tour_slots tool + agent_tour_offers):
//   A. Offer in turn A (offer_tour_slots) → confirm in turn B → books.
//   B. Only slots STATED via offer_tour_slots are confirmable: 4 available,
//      2 presented → only those 2 book; the 2 unpresented are refused.
//   C. SUPERSESSION: turn A offers {1,2}; turn B re-offers {3,4}; confirming
//      slot 1 is refused (superseded) — only the newest offer authorizes.
//   D. Ordering changes between turns; a presented slot outside the current
//      top-N availability still books (authority = the persisted offer).
// ════════════════════════════════════════════════════════════════════
const { Pool } = require("pg");
const express = require("express"); const http = require("http"); const crypto = require("crypto");
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const uuid = () => crypto.randomUUID();
let passed = 0, failed = 0;
const chk = (n, c, d = "") => { if (c) { passed++; console.log(`  \u2713 ${n}`); } else { failed++; console.log(`  \u2717 ${n} ${d}`); } };

const ONLY = (process.env.ONLY_BLOCK||"").split(",").filter(Boolean);

// ── SCRATCH PROPERTY — this harness owns its own property ────────────
//  Every statement in this file names PROP, a property created at the top
//  of main() and removed in cleanup() by tracked id plus a '__XTURN__%'
//  name guard. No production property id appears anywhere below, so no
//  run of this file — whole file or per block — can delete a row it did
//  not create. (Convention copied from the '__CB_NO076__%' prefix in
//  src/shared/no076_failclosed_check.js.)
//
//  This replaces two property-wide `delete from tour_availability where
//  property_id = <Demo Building>` statements that destroyed 19 real demo
//  slots on 2026-07-25.
const PROP = crypto.randomUUID();
const PROP_NAME = `__XTURN__P ${PROP.slice(0, 8)}`;
const PROP_SMS = "+1555" + Math.floor(1e6 + Math.random() * 8e6);
process.env.AGENT_TOUR_BOOKING_PROPERTY_IDS = PROP;
process.env.SMS_SEND_MODE = "customer_care";
process.env.AGENT_AUTO_DISPATCH_PROPERTY_IDS = PROP;
// A scratch property is not in property_timezone.js's builtin allowlist, and
// an UNCONFIGURED property resolves to an honest null — on which offers and
// bookings correctly refuse. Register it through the PROPERTY_OPERATING_TZ_JSON
// map that module documents for QA rigs, so this harness still exercises the
// real resolver rather than bypassing it.
process.env.PROPERTY_OPERATING_TZ_JSON = JSON.stringify(Object.assign(
  (() => { try { return JSON.parse(process.env.PROPERTY_OPERATING_TZ_JSON || "{}"); } catch (_) { return {}; } })(),
  { [PROP]: "America/New_York" }));

// Scripted fake model. Per-turn behavior via module vars.
//   MODE 'offer'  → calls offer_tour_slots with PRESENT_IDS, then (2nd turn) states them
//   MODE 'book'   → calls book_tour with BOOK_ID, then (2nd turn) confirms
//   MODE 'text'   → just text
let MODE = "text", PRESENT_IDS = [], BOOK_ID = null;
const fakeAnthropic = { messages: { async create(req) {
  const msgs = JSON.stringify(req.messages || []);
  const hasToolResult = msgs.includes("tool_result");
  if (hasToolResult) return { id: "r2", content: [{ type: "text", text: "Sounds good — talk soon!" }] };
  if (MODE === "offer" && PRESENT_IDS.length) return { id: "r1", content: [{ type: "tool_use", id: "tu_o", name: "offer_tour_slots", input: { slot_ids: PRESENT_IDS } }] };
  if (MODE === "book" && BOOK_ID) return { id: "r1", content: [{ type: "tool_use", id: "tu_b", name: "book_tour", input: { slot_id: BOOK_ID } }] };
  return { id: "r1", content: [{ type: "text", text: "Happy to help — what are you looking for?" }] };
}}};

const noopSms = { enabled: () => false, sendSms: async () => ({ sent: false }), validateWebhook: () => true };
const boundary = require("../../src/comms/communications_boundary.js")({ pool, sms: noopSms });
const leasing = require("../../src/leasing/leasing_leads.js")({ pool, anthropic: fakeAnthropic, INGEST_MODEL: "fake", sms: noopSms, leasingLifecycle: null, conversionServices: {}, commBoundary: boundary });
async function spawnOb(c, o) { const r = await c.query(`insert into obligations (id,property_id,person_id,module,type,label,owner_type,status) values (gen_random_uuid(),$1,$2,$3,$4,$5,$6,'open') returning id`, [o.property_id, o.person_id, o.module, o.type, o.label, o.owner_type]).catch(() => ({ rows: [{ id: null }] })); return r.rows[0]; }
const agent = require("../../src/agent/agent.js")({ pool, anthropic: fakeAnthropic, INGEST_MODEL: "fake", spawnObligationFromEvent: spawnOb, completeObligation: async () => ({}), leasingLifecycle: { maybeReopenOnQualifyingInbound: async () => ({}) }, commBoundary: boundary, leasingBookingService: leasing._service });

let srv, base; const track = { persons: [], leads: [], slots: [] };

// /agent/inbound is operator-gated (2026-07-26) — it used to let anyone write
// words into a real conversation as a real person. This harness starts its own
// server below, so it owns the key it sets here.
const OP_KEY = process.env.OPERATOR_KEY || (process.env.OPERATOR_KEY = "harness-op-key");
const AGENT_HEADERS = { "content-type": "application/json", "x-operator-key": OP_KEY };
async function blockReset() { MODE = "text"; PRESENT_IDS = []; BOOK_ID = null; await new Promise(r => setTimeout(r, 1200)); }
async function inbound(pid, body) { const ms = "SM" + crypto.randomBytes(10).toString("hex"); const res = await fetch(`${base}/agent/inbound`, { method: "POST", headers: AGENT_HEADERS, body: JSON.stringify({ property_id: PROP, person_id: pid, body, sms_sid: ms, idempotency_key: ms }) }); await res.json().catch(() => ({})); await new Promise(r => setTimeout(r, 500)); }
async function mkSlot(h) { const id = uuid(); track.slots.push(id); const st = new Date(Date.now() + h * 3600e3), en = new Date(st.getTime() + 30 * 60e3); await pool.query(`insert into tour_availability (id,property_id,starts_at,ends_at,capacity,status) values ($1,$2,$3,$4,1,'open')`, [id, PROP, st.toISOString(), en.toISOString()]); return id; }
async function newProspect(name) { const pid = uuid(); track.persons.push(pid); await pool.query(`insert into persons (id,name,phone) values ($1,$2,$3)`, [pid, name, "+1555" + Math.floor(1e6 + Math.random() * 8e6)]); const lead = uuid(); track.leads.push(lead); await pool.query(`insert into leasing_leads (id,person_id,property_id,status) values ($1,$2,$3,'new')`, [lead, pid, PROP]);
  // classify internal_qa + opted_in (valid source 'system') so the presenting reply dispatches
  await pool.query(`insert into person_property_classifications (person_id,property_id,record_class,classification_source) values ($1,$2,'internal_qa','system')`, [pid, PROP]).catch(e => console.error("cls:", e.message));
  await pool.query(`insert into contact_preferences (person_id,channel,consent_state,source,updated_at) values ($1,'text','opted_in','internal_qa_enrollment',now()) on conflict (person_id,channel) do update set consent_state='opted_in'`, [pid]).catch(e => console.error("cp:", e.message));
  return { pid, lead }; }
async function convOf(pid) { return (await pool.query(`select id from conversations where person_id=$1 and property_id=$2`, [pid, PROP])).rows[0]?.id; }
async function toursOf(lead) { return (await pool.query(`select id, slot_id, booking_idempotency_key from leasing_tours where lead_id=$1`, [lead])).rows; }

async function main() {
  const app = express(); app.use(express.json()); app.use("/", agent);
  srv = http.createServer(app); await new Promise(r => srv.listen(0, r)); base = `http://127.0.0.1:${srv.address().port}`;
  // Create the scratch property. No `on conflict do nothing`: a fresh uuid
  // cannot collide, and if it somehow did we want the run to fail loudly
  // rather than silently adopt an existing property.
  await pool.query(`insert into properties (id,name,sms_number) values ($1,$2,$3)`, [PROP, PROP_NAME, PROP_SMS]);
  console.log(`  scratch property ${PROP} (${PROP_NAME})`);
  // (No availability reset here — a property created seconds ago has none.)

  if(!ONLY.length||ONLY.includes("A")){ // ── A. offer turn A → confirm turn B ──
  console.log("\n\u2500\u2500\u2500 A. offer (turn A) \u2192 confirm (turn B) \u2192 books \u2500\u2500\u2500");
  {
    await blockReset();
    const { pid, lead } = await newProspect("A Prospect");
    const s1 = await mkSlot(48), s2 = await mkSlot(72);
    MODE = "offer"; PRESENT_IDS = [s1, s2];
    await inbound(pid, "any tour times?");
    const conv = await convOf(pid);
    const active = await leasing._service.resolveActiveOfferedSlotIds(pool, { conversationId: conv });
    chk("A. offer recorded as active (s1 present)", active.ids.has(s1), `set=${[...active.ids]}`);
    MODE = "book"; BOOK_ID = s1;
    await inbound(pid, "thursday works");
    const t = await toursOf(lead);
    chk("A. cross-turn confirm booked one tour on s1", t.length === 1 && t[0].slot_id === s1, JSON.stringify(t));
    chk("A. idempotency key is server-namespaced", t[0] && /^agent-book-tour:/.test(t[0].booking_idempotency_key || ""), t[0] && t[0].booking_idempotency_key);
  }

  } if(!ONLY.length||ONLY.includes("B")){ // ── B. 4 available, only 2 presented → only those 2 confirmable ──
  console.log("\n\u2500\u2500\u2500 B. 4 available, 2 presented \u2192 only presented are confirmable \u2500\u2500\u2500");
  {
    await blockReset();
    const { pid, lead } = await newProspect("B Prospect");
    const a = await mkSlot(48), b = await mkSlot(72), c = await mkSlot(96), d = await mkSlot(120);
    // present ONLY a and b (c, d are available but never stated)
    MODE = "offer"; PRESENT_IDS = [a, b];
    await inbound(pid, "what's open?");
    const conv = await convOf(pid);
    const active = await leasing._service.resolveActiveOfferedSlotIds(pool, { conversationId: conv });
    chk("B. only the 2 presented are in the active offer", active.ids.has(a) && active.ids.has(b) && !active.ids.has(c) && !active.ids.has(d), `set=${[...active.ids]}`);
    // confirm a presented one → books
    MODE = "book"; BOOK_ID = a;
    await inbound(pid, "the first one");
    let t = await toursOf(lead);
    chk("B. confirming a PRESENTED slot books it", t.length === 1 && t[0].slot_id === a, JSON.stringify(t));
    // now try to confirm an UNPRESENTED slot (c) → refused (no new tour)
    MODE = "book"; BOOK_ID = c;
    await inbound(pid, "actually the other time");
    t = await toursOf(lead);
    const cBooked = t.some(x => x.slot_id === c);
    chk("B. confirming an UNPRESENTED slot is REFUSED (not booked)", !cBooked, JSON.stringify(t.map(x => x.slot_id)));
    const cStatus = (await pool.query(`select status from tour_availability where id=$1`, [c])).rows[0].status;
    chk("B. unpresented slot stays open (no partial write)", cStatus === "open", cStatus);
  }

  } if(!ONLY.length||ONLY.includes("C")){ // ── C. supersession: A offers {1,2}; B re-offers {3,4}; confirm 1 → refused ──
  console.log("\n\u2500\u2500\u2500 C. supersession: newer offer replaces older \u2500\u2500\u2500");
  {
    await blockReset();
    const { pid, lead } = await newProspect("C Prospect");
    const s1 = await mkSlot(48), s2 = await mkSlot(72), s3 = await mkSlot(96), s4 = await mkSlot(120);
    MODE = "offer"; PRESENT_IDS = [s1, s2];
    await inbound(pid, "times?");
    const conv = await convOf(pid);
    // wait until offer 1 is the active offer before making offer 2 (quiescence, not a race)
    for (let i = 0; i < 20; i++) {
      const a = await leasing._service.resolveActiveOfferedSlotIds(pool, { conversationId: conv });
      if (a.ids.has(s1)) break;
      await new Promise(r => setTimeout(r, 100));
    }
    MODE = "offer"; PRESENT_IDS = [s3, s4]; // a NEW offer supersedes the first
    await inbound(pid, "actually what else is there?");
    // wait until offer 2 has superseded offer 1 (the active offer is now {s3,s4})
    for (let i = 0; i < 20; i++) {
      const a = await leasing._service.resolveActiveOfferedSlotIds(pool, { conversationId: conv });
      if (a.ids.has(s3) && !a.ids.has(s1)) break;
      await new Promise(r => setTimeout(r, 100));
    }
    const active = await leasing._service.resolveActiveOfferedSlotIds(pool, { conversationId: conv });
    chk("C. only the NEWEST offer is active ({3,4}, not {1,2})", active.ids.has(s3) && active.ids.has(s4) && !active.ids.has(s1) && !active.ids.has(s2), `set=${[...active.ids]}`);
    // confirm slot 1 from the SUPERSEDED offer → refused
    MODE = "book"; BOOK_ID = s1;
    await inbound(pid, "the very first time you mentioned");
    const t = await toursOf(lead);
    chk("C. confirming a slot from the SUPERSEDED offer is refused", !t.some(x => x.slot_id === s1), JSON.stringify(t.map(x => x.slot_id)));
    // confirm slot 3 from the active offer → books
    MODE = "book"; BOOK_ID = s3;
    await inbound(pid, "the newer one then");
    const t2 = await toursOf(lead);
    chk("C. confirming a slot from the ACTIVE offer books", t2.some(x => x.slot_id === s3), JSON.stringify(t2.map(x => x.slot_id)));
  }

  } if(!ONLY.length||ONLY.includes("D")){ // ── D. ordering changes; presented slot outside current top-N still books ──
  console.log("\n\u2500\u2500\u2500 D. presented slot outside current top-N still books \u2500\u2500\u2500");
  {
    await blockReset();
    const { pid, lead } = await newProspect("D Prospect");
    const offered = await mkSlot(50);
    MODE = "offer"; PRESENT_IDS = [offered];
    await inbound(pid, "one time please");
    // add 6 earlier slots so `offered` falls outside the top-4 availability
    for (let i = 0; i < 6; i++) await mkSlot(1 + i);
    const top4 = await leasing._service.readOfferableSlots(pool, { propertyId: PROP, limit: 4 });
    chk("D. presented slot has fallen outside current top-4", !(top4 || []).some(s => s.slot_id === offered), "");
    MODE = "book"; BOOK_ID = offered;
    await inbound(pid, "yes that one");
    const t = await toursOf(lead);
    chk("D. presented slot still books despite being outside top-4", t.length === 1 && t[0].slot_id === offered, JSON.stringify(t));
  }

  } srv.close(); await cleanup();
  console.log(`\n\u2550 RESULT: ${passed} passed, ${failed} failed \u2550`);
  await pool.end(); process.exit(failed === 0 ? 0 : 1);
}
async function cleanup() {
  for (const lead of track.leads) {
    await pool.query(`delete from tour_events where lead_id=$1`, [lead]).catch(() => {});
    await pool.query(`delete from lead_events where lead_id=$1`, [lead]).catch(() => {});
    await pool.query(`delete from leasing_tours where lead_id=$1`, [lead]).catch(() => {});
    await pool.query(`delete from leasing_leads where id=$1`, [lead]).catch(() => {});
  }
  for (const pid of track.persons) {
    await pool.query(`delete from person_property_classifications where person_id=$1`, [pid]).catch(() => {});
    await pool.query(`delete from agent_tour_offers where conversation_id in (select id from conversations where person_id=$1)`, [pid]).catch(() => {});
    await pool.query(`delete from agent_runs where conversation_id in (select id from conversations where person_id=$1)`, [pid]).catch(() => {});
    await pool.query(`delete from agent_thread_state where conversation_id in (select id from conversations where person_id=$1)`, [pid]).catch(() => {});
    await pool.query(`delete from comm_events where person_id=$1`, [pid]).catch(() => {});
    await pool.query(`delete from obligations where person_id=$1`, [pid]).catch(() => {});
    await pool.query(`delete from conversations where person_id=$1`, [pid]).catch(() => {});
    await pool.query(`delete from persons where id=$1`, [pid]).catch(() => {});
  }
  const s = [...new Set(track.slots)];
  if (s.length) { const ph = s.map((_, i) => `$${i + 1}`).join(","); await pool.query(`update tour_availability set booked_tour_id=null where id in (${ph})`, s).catch(() => {}); await pool.query(`delete from tour_availability where id in (${ph})`, s).catch(() => {}); }
  // The scratch property itself — tracked id AND a name guard, so this
  // statement is structurally incapable of removing a property this harness
  // did not create. Slots are already gone above by tracked id, so nothing
  // here deletes by property_id.
  const gone = await pool.query(
    `delete from properties where id=$1 and name like '__XTURN__%'`, [PROP]
  ).catch(e => { console.error("  scratch property NOT removed:", e.message); return { rowCount: 0 }; });
  console.log(`  cleanup complete. scratch property removed: ${gone.rowCount}`);
}
main().catch(async e => { console.error("XTURN ERROR:", e); try { if (srv) srv.close(); await cleanup(); } catch (_) {} try { await pool.end(); } catch (_) {} process.exit(1); });
