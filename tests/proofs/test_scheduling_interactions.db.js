// ════════════════════════════════════════════════════════════════════
//  DB-BACKED TEST — scheduling intake + Twilio interaction ledger
//  Covers contract scenarios 1-4 (Acuity), 12 (Twilio idempotency),
//  13 (unified timeline shape). Real Postgres, real migrations 047+048.
//
//  Run: HARNESS_DATABASE_URL="..." node test_scheduling_interactions.db.js
// ════════════════════════════════════════════════════════════════════
const receipt = require("../_run_receipt.js");
const { Pool } = require("pg");
const buildScheduling = require("../../src/leasing/leasing_scheduling.js");
const buildInteractions = require("../../src/leasing/leasing_interactions.js");

const CONN = receipt.harnessConnectionString();
const pool = new Pool({ connectionString: CONN });

// Fake-but-faithful Twilio transport: same { enabled, sendSms } shape as sms.js.
let __sid = 1000;
const fakeSms = {
  enabled() { return true; },
  async sendSms({ to, body }) { return { sent: true, sid: "SM" + (++__sid), status: "queued" }; },
};

const sched = buildScheduling({ pool })._service;
const inter = buildInteractions({ pool, sms: fakeSms })._service;

let pass = 0, fail = 0;
function ok(l){ console.log("  PASS  " + l); pass++; }
function bad(l,e){ console.log("  FAIL  " + l + "  →  " + (e&&e.message||e)); fail++; }
async function T(l, fn){ try { await fn(); ok(l); } catch(e){ bad(l,e); } }
function assert(c,m){ if(!c) throw new Error(m||"assertion failed"); }
async function tx(fn){ const c=await pool.connect(); try{ await c.query("begin"); const r=await fn(c); await c.query("commit"); return r; } catch(e){ await c.query("rollback"); throw e; } finally{ c.release(); } }
async function read(fn){ const c=await pool.connect(); try{ return await fn(c); } finally{ c.release(); } }

let ctx = {};
async function seed() {
  await tx(async (c) => {
    // conversations is a real table (migration 027); create its minimal real
    // shape for the test (omitting optional units/leases FK targets out of scope).
    await c.query(`create table if not exists conversations (
      id uuid primary key default gen_random_uuid(),
      property_id uuid not null references properties(id) on delete cascade,
      person_id uuid not null references persons(id) on delete cascade,
      channel_primary text not null default 'sms',
      status text not null default 'open',
      last_message_at timestamptz,
      created_at timestamptz not null default now(),
      unique (property_id, person_id)
    )`);
    ctx.prop  = (await c.query(`insert into properties (name) values ('Skyline') returning id`)).rows[0].id;
    ctx.prop2 = (await c.query(`insert into properties (name) values ('Greenery') returning id`)).rows[0].id;
    ctx.katie = (await c.query(`insert into users (name) values ('Katie Leung') returning id`)).rows[0].id;
    ctx.person = (await c.query(`insert into persons (name, phone, lifecycle_status) values ('Ava Morgan','+12155550001','lead') returning id`)).rows[0].id;
    // configurable mapping: Skyline ← acuity calendar 'Skyline Tours', sender pattern 'acuityscheduling'
    await c.query(
      `insert into scheduling_source_mappings (property_id, calendar_label, sender_pattern, appointment_name)
       values ($1,'Skyline Tours','acuityscheduling','In-Person Tour')`, [ctx.prop]
    );
    await c.query(
      `insert into scheduling_source_mappings (property_id, calendar_label, sender_pattern)
       values ($1,'Greenery Tours','acuityscheduling')`, [ctx.prop2]
    );
  });
}

async function main() {
  console.log("\n══════════ SCHEDULING + INTERACTIONS — DB-BACKED PROOF ══════════\n");
  await seed();

  // helper: first result of an ingest (individual notices yield one)
  const one = (out) => out.results[0];

  // ── 1. individual Acuity notice creates ONE scheduled tour ──
  let tourId;
  await T("1 · individual Acuity notice creates one scheduled tour (property resolved via mapping)", async () => {
    const out = await tx(c => sched.ingestSourceEvent(c, {
      event_type: "created", source_event_id: "OUTLOOK-MSG-1", external_appt_id: "ACU-555",
      calendar_label: "Skyline Tours", sender: "no-reply@acuityscheduling.com", appointment_name: "In-Person Tour",
      prospect_name: "Ava Morgan", prospect_phone: "215-555-0001",
      appointment_type: "in_person", scheduled_start: "2026-07-01T15:00:00Z", scheduled_end: "2026-07-01T15:30:00Z",
      scheduled_host_user_id: ctx.katie, source_status: "scheduled",
    }));
    assert(!out.duplicate, "should not be duplicate");
    assert(out.results.length === 1, "individual notice should yield one occurrence");
    const r = one(out);
    assert(r.action === "created", "expected created, got " + r.action);
    assert(r.scheduled_tour.property_id === ctx.prop, "property not resolved to Skyline via mapping");
    assert(r.scheduled_tour.status === "scheduled", "status not scheduled");
    // envelope recorded, with a link
    assert(out.source_event.occurrence_count === 1, "envelope occurrence_count wrong");
    const links = (await pool.query(`select count(*)::int c from scheduled_tour_source_links where source_id=$1`, [out.source_event.id])).rows[0].c;
    assert(links === 1, "expected one source→tour link");
    tourId = r.scheduled_tour.id;
  });

  // ── 2. duplicate source notice creates NO duplicate ──
  await T("2 · duplicate source notice (same envelope id) creates no duplicate", async () => {
    const before = (await pool.query(`select count(*)::int c from scheduled_tours`)).rows[0].c;
    const out = await tx(c => sched.ingestSourceEvent(c, {
      event_type: "created", source_event_id: "OUTLOOK-MSG-1", external_appt_id: "ACU-555",
      calendar_label: "Skyline Tours", sender: "no-reply@acuityscheduling.com",
      prospect_name: "Ava Morgan", scheduled_start: "2026-07-01T15:00:00Z", appointment_type: "in_person",
    }));
    assert(out.duplicate === true, "second identical envelope should be a duplicate");
    const after = (await pool.query(`select count(*)::int c from scheduled_tours`)).rows[0].c;
    assert(after === before, "duplicate created a new scheduled tour");
  });

  // ── 3. reschedule updates the SAME tour and preserves schedule history ──
  await T("3 · reschedule updates the same tour + preserves prior schedule + writes a revision", async () => {
    const out = await tx(c => sched.ingestSourceEvent(c, {
      event_type: "rescheduled", source_event_id: "OUTLOOK-MSG-2", external_appt_id: "ACU-555",
      calendar_label: "Skyline Tours", sender: "no-reply@acuityscheduling.com",
      scheduled_start: "2026-07-02T18:00:00Z", scheduled_end: "2026-07-02T18:30:00Z",
    }));
    const r = one(out);
    assert(r.action === "rescheduled", "expected rescheduled, got " + r.action);
    assert(r.scheduled_tour.id === tourId, "reschedule must update the SAME tour, not a new one");
    assert(new Date(r.scheduled_tour.scheduled_start).toISOString() === "2026-07-02T18:00:00.000Z", "start not updated");
    assert(new Date(r.scheduled_tour.previous_start).toISOString() === "2026-07-01T15:00:00.000Z", "previous start not retained");
    assert(r.scheduled_tour.reschedule_count === 1, "reschedule_count not incremented");
    // envelope history: two source rows (created + rescheduled)
    const evs = (await pool.query(`select event_type from scheduled_tour_sources order by processed_at`)).rows.map(r => r.event_type);
    assert(evs.includes("created") && evs.includes("rescheduled"), "envelope history incomplete: " + evs.join(","));
    // append-only revision history for this tour shows the reschedule
    const revs = (await pool.query(`select change_type from scheduled_tour_revisions where scheduled_tour_id=$1 order by created_at`, [tourId])).rows.map(r => r.change_type);
    assert(revs.includes("created") && revs.includes("rescheduled"), "revision history missing: " + revs.join(","));
  });

  // ── 4. a weekly DIGEST cannot overwrite a more specific individual notice ──
  await T("4 · weekly digest cannot overwrite a more specific individual appointment", async () => {
    const out = await tx(c => sched.ingestSourceEvent(c, {
      event_type: "agenda_digest", source_event_id: "DIGEST-WK1",
      occurrences: [{
        external_appt_id: "ACU-555", calendar_label: "Skyline Tours", sender: "no-reply@acuityscheduling.com",
        scheduled_start: "2026-07-01T15:00:00Z",  // the OLD time the digest still shows
      }],
    }));
    assert(one(out).action === "ignored_digest_lower", "digest should be ignored against an individual, got " + one(out).action);
    const tour = (await pool.query(`select * from scheduled_tours where id=$1`, [tourId])).rows[0];
    assert(new Date(tour.scheduled_start).toISOString() === "2026-07-02T18:00:00.000Z", "digest overwrote the individual reschedule!");
    assert(tour.authority === "individual", "authority should remain individual");
  });

  // ── 4c. THE KEY CORRECTION: ONE digest envelope references MANY tours ──
  await T("4c · one weekly digest creates/backfills multiple canonical tours from one envelope", async () => {
    const out = await tx(c => sched.ingestSourceEvent(c, {
      event_type: "agenda_digest", source_event_id: "DIGEST-WK2",
      calendar_label: "Greenery Tours", sender: "no-reply@acuityscheduling.com",
      occurrences: [
        { external_appt_id: "ACU-700", prospect_name: "Prospect One", appointment_type: "facetime", scheduled_start: "2026-07-05T14:00:00Z" },
        { external_appt_id: "ACU-701", prospect_name: "Prospect Two", appointment_type: "in_person", scheduled_start: "2026-07-06T16:00:00Z" },
        { external_appt_id: "ACU-702", prospect_name: "Prospect Three", appointment_type: "in_person", scheduled_start: "2026-07-07T11:00:00Z" },
      ],
    }));
    assert(!out.duplicate, "digest should process");
    assert(out.results.length === 3, "one digest should yield 3 occurrences, got " + out.results.length);
    assert(out.source_event.occurrence_count === 3, "envelope occurrence_count should be 3");
    // ONE raw source row, THREE distinct canonical tours, THREE links
    const sources = (await pool.query(`select count(*)::int c from scheduled_tour_sources where source_event_id='DIGEST-WK2'`)).rows[0].c;
    assert(sources === 1, "should be exactly ONE source envelope for the digest, got " + sources);
    const links = (await pool.query(`select count(*)::int c from scheduled_tour_source_links where source_id=$1`, [out.source_event.id])).rows[0].c;
    assert(links === 3, "digest envelope should have 3 source→tour links, got " + links);
    const tourIds = out.results.map(r => r.scheduled_tour.id);
    assert(new Set(tourIds).size === 3, "should be 3 DISTINCT canonical tours");
    out.results.forEach(r => assert(r.action === "backfilled", "digest occurrences should backfill missing tours, got " + r.action));
  });

  // ── 4d. upcoming-tours feeds Leasing Health ──
  await T("4d · upcoming tours surface for Leasing Health (cancelled excluded)", async () => {
    const rows = await read(c => sched.upcomingTours(c, { withinDays: 60 }));
    assert(rows.some(r => r.id === tourId), "Skyline tour not in upcoming feed");
    assert(rows.filter(r => r.source_system === "acuity_squarespace").length >= 4, "digest tours not surfaced in upcoming");
    assert(rows.every(r => r.status !== "cancelled"), "cancelled tour leaked into upcoming");
  });


  // ════════════════ TWILIO LEDGER ════════════════

  // ── 13. text + call events render from the SAME comm_events timeline shape ──
  await T("13 · text and call write to one comm_events timeline with one shape", async () => {
    // outbound text (human-approved, AI-drafted)
    const t = await tx(c => inter.recordOutboundText(c, {
      person_id: ctx.person, property_id: ctx.prop, body: "Hi Ava — great meeting you today!",
      actor_user_id: ctx.katie, ai_drafted: true, human_approved_by_user_id: ctx.katie, to: "+12155550001",
    }));
    assert(t.sent === true && t.comm_event.provider_event_id, "text not sent/logged with a SID");
    assert(t.comm_event.channel === "text" && t.comm_event.direction === "outbound", "text shape wrong");
    assert(t.comm_event.ai_drafted_at && t.comm_event.human_approved_by_user_id === ctx.katie, "AI/human provenance not recorded");
    // a call on the same thread
    const c2 = await tx(c => inter.recordCall(c, {
      person_id: ctx.person, property_id: ctx.prop, actor_user_id: ctx.katie,
      call_duration_seconds: 142, call_disposition: "connected",
    }));
    assert(c2.comm_event.channel === "call" && c2.comm_event.call_disposition === "connected", "call shape wrong");
    // unified read: both rows, same shape
    const thread = await read(c => inter.readThread(c, { person_id: ctx.person, property_id: ctx.prop }));
    assert(thread.length === 2, "thread should have 2 events, has " + thread.length);
    const channels = thread.map(r => r.channel).sort();
    assert(channels[0] === "call" && channels[1] === "text", "thread missing text+call");
    // every row exposes the same columns (timeline shape)
    thread.forEach(r => { assert("channel" in r && "direction" in r && "occurred_at" in r && "provider_status" in r, "timeline shape inconsistent"); });
  });

  // ── 12. Twilio event upsert is idempotent by provider event id ──
  await T("12 · provider-event upsert is idempotent; duplicate callback updates, never duplicates", async () => {
    // simulate Twilio delivering an inbound message with SID SMINBOUND1
    const first = await tx(c => inter.upsertProviderEvent(c, {
      provider_event_id: "SMINBOUND1", direction: "inbound", person_id: ctx.person, property_id: ctx.prop,
      body: "Sounds good, what's the rent?", provider_status: "received",
    }));
    assert(first.created === true, "first inbound should create");
    const countAfterFirst = (await pool.query(`select count(*)::int c from comm_events where provider_event_id='SMINBOUND1'`)).rows[0].c;
    assert(countAfterFirst === 1, "should be exactly one row");

    // a DUPLICATE delivery callback for the same SID with a new status
    const dup = await tx(c => inter.upsertProviderEvent(c, {
      provider_event_id: "SMINBOUND1", provider_status: "read", raw: { EventType: "read" },
    }));
    assert(dup.created === false, "duplicate must NOT create a new communication");
    const countAfterDup = (await pool.query(`select count(*)::int c from comm_events where provider_event_id='SMINBOUND1'`)).rows[0].c;
    assert(countAfterDup === 1, "duplicate callback created a second row!");
    assert(dup.comm_event.provider_status === "read", "status not updated to read");
    // the callback history is appended, not parallel-laddered
    const logs = (await pool.query(`select count(*)::int c from comm_event_status_log where provider_event_id='SMINBOUND1'`)).rows[0].c;
    assert(logs >= 2, "status log should have appended both callbacks, has " + logs);
  });

  // ── 12b. inbound STOP updates canonical opt-out truth (not just the row) ──
  await T("12b · consent signal updates canonical contact_preferences", async () => {
    await tx(c => inter.applyConsentSignal(c, { person_id: ctx.person, channel: "text", consent_state: "opted_out", source: "inbound_stop" }));
    const pref = (await pool.query(`select consent_state from contact_preferences where person_id=$1 and channel='text'`, [ctx.person])).rows[0];
    assert(pref.consent_state === "opted_out", "canonical opt-out not recorded");
    // a later outbound logs the consent state known AT the event
    const t = await tx(c => inter.recordOutboundText(c, {
      person_id: ctx.person, property_id: ctx.prop, body: "follow-up", actor_user_id: ctx.katie, to: "+12155550001",
    }));
    assert(t.comm_event.consent_state_at_event === "opted_out", "event did not snapshot current consent");
  });

  console.log("\n──────────────────────────────────────────────────────────────");
  console.log(`  ${pass} / ${pass + fail} scenarios passed`);
  console.log("──────────────────────────────────────────────────────────────\n");
  await pool.end();
  if (fail > 0) process.exitCode = 1;
}
main().catch(e => { console.error(e); process.exitCode = 1; });
