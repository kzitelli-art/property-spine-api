'use strict';
// ════════════════════════════════════════════════════════════════════
//  END-TO-END SEAM TEST — adapter envelope → seam → canonical service → DB
//  Proves the Outlook/Acuity adapter connects to leasingscheduling.js (048)
//  through schedulingAdapterSeam.js, for BOTH an individual notice and a
//  multi-appointment digest. Real Postgres. Run:
//    HARNESS_DATABASE_URL="..." node test_adapter_seam.db.js
// ════════════════════════════════════════════════════════════════════
const { Pool } = require('pg');
const { parseAcuityMessage, parseDigestOccurrences } = require('../src/shared/outlookAcuitySync.js');
const { ingestSchedulingSourceEvent, translateEnvelope } = require('../src/shared/schedulingAdapterSeam.js');

const CONN = receipt.harnessConnectionString();
const pool = new Pool({ connectionString: CONN });

let pass = 0, fail = 0;
async function T(l, fn) { try { await fn(); console.log('  PASS  ' + l); pass++; } catch (e) { console.log('  FAIL  ' + l + '  →  ' + (e && e.message || e)); fail++; } }
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }

let ctx = {};
async function seed() {
  const c = await pool.connect();
  try {
    await c.query('begin');
    ctx.skyline = (await c.query(`insert into properties (name) values ('Skyline Apartments') returning id`)).rows[0].id;
    ctx.greenery = (await c.query(`insert into properties (name) values ('Greenery Apartments') returning id`)).rows[0].id;
    // configurable mappings — resolve by the property label the parser extracts (calendar_label),
    // and for the digest, by sender pattern.
    await c.query(`insert into scheduling_source_mappings (property_id, calendar_label, sender_pattern) values ($1,'Skyline Apartments','acuityscheduling')`, [ctx.skyline]);
    // Greenery is distinguished by the recipient mailbox the digest is sent to
    // (real-world: two properties on one Acuity sender are separated by calendar
    // label or destination mailbox, never by sender alone — no silent guessing).
    await c.query(`insert into scheduling_source_mappings (property_id, recipient_mailbox) values ($1,'greenery-scheduling@onefivecap.com')`, [ctx.greenery]);
    await c.query('commit');
  } catch (e) { await c.query('rollback'); throw e; } finally { c.release(); }
}

// Build a Graph message like the adapter's own test fixture.
function individualMsg() {
  return {
    id: 'graph-msg-ind-1', internetMessageId: '<ind-1@acuity>',
    subject: 'New Appointment: In Person Tour (Princess Dahn) on Monday, June 22, 2026 2:00pm EDT with Skyline Apartments',
    sender: { emailAddress: { address: 'no-reply@acuityscheduling.com' } },
    receivedDateTime: '2026-06-20T15:46:09Z',
    body: { contentType: 'html', content: '<p>Thank you.</p><a href="https://app/scheduling/appointments/view/1721249919">View</a>' },
    toRecipients: [{ emailAddress: { address: 'spine-scheduling@onefivecap.com' } }],
  };
}

// A weekly agenda digest carrying THREE appointments.
function digestMsg() {
  const body = [
    '<p>3 Appointments for week of June 22, 2026</p>',
    '<div>Mon, June 22, 2026 10:00am — In Person Tour (Alex Rivera) ',
    '<a href="https://app/scheduling/appointments/view/2001">view</a></div>',
    '<div>Tue, June 23, 2026 1:30pm — FaceTime Tour (Jordan Blake) ',
    '<a href="https://app/scheduling/appointments/view/2002">view</a></div>',
    '<div>Wed, June 24, 2026 4:15pm — In Person Tour (Sam Okafor) ',
    '<a href="https://app/scheduling/appointments/view/2003">view</a></div>',
  ].join('');
  return {
    id: 'graph-msg-digest-1', internetMessageId: '<digest-1@acuity>',
    subject: '3 Appointments for week of June 22, 2026',
    sender: { emailAddress: { address: 'no-reply@acuityscheduling.com' } },
    receivedDateTime: '2026-06-21T06:00:00Z',
    body: { contentType: 'html', content: body },
    toRecipients: [{ emailAddress: { address: 'greenery-scheduling@onefivecap.com' } }],
  };
}

async function main() {
  console.log('\n══════════ ADAPTER → SEAM → SERVICE — END-TO-END PROOF ══════════\n');
  await seed();

  // ── translation: adapter shape → canonical shape ──
  await T('1 · translateEnvelope maps an individual notice to event_type+occurrences', async () => {
    const env = parseAcuityMessage(individualMsg());
    assert(env.source_event_type === 'appointment_created', 'parser event type wrong');
    const canon = translateEnvelope(env);
    assert(canon.event_type === 'created', 'event_type not translated to created');
    assert(Array.isArray(canon.occurrences) && canon.occurrences.length === 1, 'should be one occurrence');
    assert(canon.occurrences[0].external_appt_id === '1721249919', 'appt id not carried');
    assert(canon.occurrences[0].calendar_label === 'Skyline Apartments', 'property label hint not carried');
    assert(canon.occurrences[0].appointment_type === 'in_person', 'appt type not normalized');
  });

  // ── individual notice flows all the way to a canonical scheduled tour ──
  let indTourId;
  await T('2 · individual Acuity email → seam → ONE canonical scheduled tour (Skyline)', async () => {
    const env = parseAcuityMessage(individualMsg());
    const out = await ingestSchedulingSourceEvent({ pool, envelope: env, context: {}, logger: console });
    assert(out.status === 'ingested', 'status not ingested: ' + out.status);
    assert(out.occurrences === 1, 'should process one occurrence');
    const r = out.result.results[0];
    assert(r.action === 'created', 'expected created, got ' + r.action);
    assert(r.scheduled_tour.property_id === ctx.skyline, 'not resolved to Skyline via mapping');
    assert(r.scheduled_tour.external_appt_id === '1721249919', 'appt id not on tour');
    indTourId = r.scheduled_tour.id;
  });

  // ── re-delivery of the same email is idempotent at the envelope level ──
  await T('3 · re-delivering the same Graph message does not duplicate', async () => {
    const before = (await pool.query(`select count(*)::int c from scheduled_tours`)).rows[0].c;
    const env = parseAcuityMessage(individualMsg());
    const out = await ingestSchedulingSourceEvent({ pool, envelope: env, context: {}, logger: console });
    assert(out.duplicate === true, 'second delivery should be a duplicate');
    const after = (await pool.query(`select count(*)::int c from scheduled_tours`)).rows[0].c;
    assert(after === before, 'duplicate created a new tour');
  });

  // ── THE KEY PROOF: a digest parses to 3 occurrences → 3 canonical tours ──
  await T('4 · digest parser extracts 3 occurrences from one email', async () => {
    const occ = parseDigestOccurrences(digestMsg().body.content, require('../src/shared/outlookAcuitySync.js').normalizeHtmlToText(digestMsg().body.content));
    assert(occ.length === 3, 'expected 3 occurrences, got ' + occ.length);
    const ids = occ.map((o) => o.external_appointment_id).sort();
    assert(ids[0] === '2001' && ids[2] === '2003', 'appt ids not extracted: ' + ids.join(','));
    assert(occ.some((o) => o.prospect_name === 'Alex Rivera'), 'names not extracted');
    assert(occ.some((o) => o.appointment_type === 'facetime'), 'facetime type not extracted');
  });

  await T('5 · digest email → seam → THREE distinct canonical tours from ONE envelope', async () => {
    const env = parseAcuityMessage(digestMsg());
    assert(Array.isArray(env.occurrences) && env.occurrences.length === 3, 'parser did not emit 3 occurrences on the envelope');
    const out = await ingestSchedulingSourceEvent({ pool, envelope: env, context: {}, logger: console });
    assert(out.status === 'ingested', 'digest not ingested: ' + out.status);
    assert(out.occurrences === 3, 'should process 3 occurrences, got ' + out.occurrences);
    // one source envelope, three links, three distinct tours
    const sources = (await pool.query(`select count(*)::int c from scheduled_tour_sources where source_event_id='graph-msg-digest-1'`)).rows[0].c;
    assert(sources === 1, 'should be ONE source envelope for the digest, got ' + sources);
    const srcId = out.result.source_event.id;
    const links = (await pool.query(`select count(*)::int c from scheduled_tour_source_links where source_id=$1`, [srcId])).rows[0].c;
    assert(links === 3, 'digest should have 3 source→tour links, got ' + links);
    const tourIds = out.result.results.map((r) => r.scheduled_tour.id);
    assert(new Set(tourIds).size === 3, 'should be 3 distinct canonical tours');
    out.result.results.forEach((r) => assert(r.scheduled_tour.property_id === ctx.greenery, 'digest tours not resolved to Greenery'));
  });

  // ── boundary: an unknown subject is not ingested as a scheduling event ──
  await T('6 · unknown subject → unmapped, no ingest, no tour', async () => {
    const env = parseAcuityMessage({ id: 'x', subject: 'Hello world', sender: { emailAddress: { address: 'no-reply@acuityscheduling.com' } }, receivedDateTime: '2026-06-21T00:00:00Z', body: { contentType: 'text', content: '' } });
    const out = await ingestSchedulingSourceEvent({ pool, envelope: env, context: {}, logger: console });
    assert(out.status === 'unmapped' && out.forwarded === false, 'unknown should be unmapped, not ingested');
  });

  console.log('\n──────────────────────────────────────────────────────────────');
  console.log(`  ${pass} / ${pass + fail} scenarios passed`);
  console.log('──────────────────────────────────────────────────────────────\n');
  await pool.end();
  if (fail > 0) process.exitCode = 1;
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
