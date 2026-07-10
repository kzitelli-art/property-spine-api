#!/usr/bin/env node
// ════════════════════════════════════════════════════════════════════
//  comm_boundary_harness.js — COMMUNICATIONS BOUNDARY PHASE A PROOF
//
//  Proves the boundary's acceptance points against REAL Postgres.
//  Run locally against the mirrored schema, then in Render Shell against
//  Neon (claim discipline: local = locally exercised; Neon = proven).
//
//    DATABASE_URL=postgres://... node comm_boundary_harness.js
//
//  The harness uses a FAKE transport that records every wire attempt —
//  so "the gate refused" vs "the wire was reached" is directly observable.
//  It creates its own throwaway rows (properties named __CB_HARNESS__*)
//  and deletes them at the end (harness rows only; nothing else).
// ════════════════════════════════════════════════════════════════════
const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || "postgres://claude:claude@localhost/spinetest",
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes("render") === false && process.env.DATABASE_URL.includes("neon") ? { rejectUnauthorized: false } : (process.env.PGSSL ? { rejectUnauthorized: false } : false),
});

// ── fake transport: records what reaches the wire ──
const wireLog = [];
const fakeSms = {
  enabled: () => true,
  async sendSms({ to, from, body }) {
    wireLog.push({ to, from, body });
    if (!from) return { sent: false, reason: "harness_saw_no_from" }; // should be unreachable
    return { sent: true, sid: "SM_HARNESS_" + wireLog.length, status: "queued" };
  },
  validateWebhook: () => true,
};
const boundaryFactory = require("./communications_boundary");

let pass = 0, fail = 0;
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? " — " + detail : ""}`); }
}
async function count(sql, params) { return Number((await pool.query(sql, params)).rows[0].count); }

(async () => {
  const boundary = boundaryFactory({ pool, sms: fakeSms });
  console.log("═══ COMMUNICATIONS BOUNDARY PHASE A HARNESS ═══\n");

  // ── seed the harness world ──
  const propA = (await pool.query(`insert into properties (name, sms_number) values ('__CB_HARNESS__A', '+15550000001') returning *`)).rows[0];
  const propB = (await pool.query(`insert into properties (name, sms_number) values ('__CB_HARNESS__B', '+15550000002') returning *`)).rows[0];
  const propNoLine = (await pool.query(`insert into properties (name, sms_number) values ('__CB_HARNESS__NOLINE', null) returning *`)).rows[0];

  // residents: same phone in TWO properties (the wall test)
  const sharedPhone = "+15551110001";
  const resA = (await pool.query(`insert into persons (name, phone) values ('__CB_HARNESS__ResA', $1) returning *`, [sharedPhone])).rows[0];
  const resB = (await pool.query(`insert into persons (name, phone) values ('__CB_HARNESS__ResB', $1) returning *`, [sharedPhone])).rows[0];
  // FK chain: leases.space_id → spaces.unit_id → units.property_id. Seed a real
  // unit + space under each throwaway property, then attach the test lease to it.
  async function seedSpace(propertyId, label) {
    const unit = (await pool.query(
      `insert into units (property_id, unit_number) values ($1, $2) returning id`,
      [propertyId, "__CB_" + label])).rows[0];
    const space = (await pool.query(
      `insert into spaces (unit_id) values ($1) returning id`, [unit.id])).rows[0];
    return space.id;
  }
  const spaceA = await seedSpace(propA.id, "A");
  const spaceB = await seedSpace(propB.id, "B");
  await pool.query(`insert into leases (property_id, space_id, tenant_ids, balance, lease_status) values ($1, $2, array[$3::uuid], 0, 'active')`, [propA.id, spaceA, resA.id]);
  await pool.query(`insert into leases (property_id, space_id, tenant_ids, balance, lease_status) values ($1, $2, array[$3::uuid], 0, 'active')`, [propB.id, spaceB, resB.id]);
  await pool.query(`insert into tenant_invites (person_id, property_id, token, status) values ($1,$2,'__cb_tok_'||gen_random_uuid(),'used'),($3,$4,'__cb_tok_'||gen_random_uuid(),'used')`, [resA.id, propA.id, resB.id, propB.id]);

  // a QA tester with a lead relationship in propA
  const qa = (await pool.query(`insert into persons (name, phone) values ('__CB_HARNESS__QA', '+15551110002') returning *`)).rows[0];
  await pool.query(`insert into leasing_leads (person_id, property_id) values ($1,$2)`, [qa.id, propA.id]);
  // a stranger with no relationship anywhere
  const stranger = (await pool.query(`insert into persons (name, phone) values ('__CB_HARNESS__Stray', '+15551110003') returning *`)).rows[0];
  // an opted-out resident in propA
  const optedOut = (await pool.query(`insert into persons (name, phone) values ('__CB_HARNESS__Stop', '+15551110004') returning *`)).rows[0];
  await pool.query(`insert into leasing_leads (person_id, property_id) values ($1,$2)`, [optedOut.id, propA.id]);
  await pool.query(`insert into contact_preferences (person_id, channel, consent_state, source) values ($1,'text','opted_out','harness')`, [optedOut.id]);

  // ════ SECTION 1 — INBOUND RESOLVER ════
  console.log("── inbound: To → property first, sender within property ──");
  {
    // A3/A4: shared phone follows the RECEIVING line
    const rA = await boundary.resolveInboundSmsContext({ To: propA.sms_number, From: sharedPhone, MessageSid: "SIDA1", body: "hello A" });
    check("To resolves property A", rA.property && rA.property.id === propA.id);
    check("sender resolved within property A only (no ambiguity despite shared phone)", !rA.ambiguous && rA.person && rA.person.id === resA.id);
    const rB = await boundary.resolveInboundSmsContext({ To: propB.sms_number, From: sharedPhone, MessageSid: "SIDB1", body: "hello B" });
    check("same phone at property B resolves the OTHER person", !rB.ambiguous && rB.person && rB.person.id === resB.id, rB.person && rB.person.id);
    check("resolved path writes NO event in the resolver (runInbound owns it)", rA.comm_event === null && rB.comm_event === null);
  }
  {
    // A7: duplicate MessageSid — write once, replay detected
    const before = await count(`select count(*) as count from comm_events where sms_sid='SIDAMB1'`);
    const r1 = await boundary.resolveInboundSmsContext({ To: propA.sms_number, From: stranger.phone, MessageSid: "SIDAMB1", body: "who am I" });
    check("unmatched sender creates ONE person-less property-scoped event", r1.ambiguous && r1.comm_event && r1.comm_event.property_id === propA.id && r1.comm_event.person_id === null);
    const r2 = await boundary.resolveInboundSmsContext({ To: propA.sms_number, From: stranger.phone, MessageSid: "SIDAMB1", body: "who am I" });
    const after = await count(`select count(*) as count from comm_events where sms_sid='SIDAMB1'`);
    check("duplicate MessageSid is idempotent (one event ever)", r2.idempotentReplay === true && after === before + 1, `events=${after - before}`);
  }
  {
    // A5/T2: unknown To line writes ZERO rows
    const before = await count(`select count(*) as count from comm_events`);
    const r = await boundary.resolveInboundSmsContext({ To: "+19999999999", From: sharedPhone, MessageSid: "SIDUNK1", body: "lost" });
    const after = await count(`select count(*) as count from comm_events`);
    check("unknown receiving line → unknownLine:true", r.unknownLine === true);
    check("unknown receiving line writes ZERO operating history (T2)", after === before, `delta=${after - before}`);
  }
  {
    // A8/T3: ambiguity dispatches ZERO outbound
    const wiresBefore = wireLog.length;
    await boundary.resolveInboundSmsContext({ To: propA.sms_number, From: "+15559998888", MessageSid: "SIDAMB2", body: "??" });
    check("ambiguous sender dispatches ZERO outbound (Phase A)", wireLog.length === wiresBefore);
    // and >1 match: give stranger TWO verified identities in propA
    const dup1 = (await pool.query(`insert into persons (name, phone) values ('__CB_HARNESS__Dup1', '+15551110009') returning *`)).rows[0];
    const dup2 = (await pool.query(`insert into persons (name, phone) values ('__CB_HARNESS__Dup2', '+15551110009') returning *`)).rows[0];
    const spaceDup1 = await seedSpace(propA.id, "D1");
    const spaceDup2 = await seedSpace(propA.id, "D2");
    await pool.query(`insert into leases (property_id, space_id, tenant_ids, balance, lease_status) values ($1, $2, array[$3::uuid], 0, 'active'),($1, $4, array[$5::uuid], 0, 'active')`, [propA.id, spaceDup1, dup1.id, spaceDup2, dup2.id]);
    await pool.query(`insert into tenant_invites (person_id, property_id, token, status) values ($1,$2,'__cb_tok_'||gen_random_uuid(),'used'),($3,$2,'__cb_tok_'||gen_random_uuid(),'used')`, [dup1.id, propA.id, dup2.id]);
    const rMulti = await boundary.resolveInboundSmsContext({ To: propA.sms_number, From: "+15551110009", MessageSid: "SIDAMB3", body: "two of me" });
    check(">1 sender match → ambiguous, person-less, no guessed identity", rMulti.ambiguous && rMulti.comm_event.person_id === null);
  }
  {
    // malformed at domain layer writes nothing
    const before = await count(`select count(*) as count from comm_events`);
    const r = await boundary.resolveInboundSmsContext({ To: propA.sms_number, From: null, MessageSid: null });
    const after = await count(`select count(*) as count from comm_events`);
    check("malformed payload (domain layer) writes zero rows", r.malformed === true && after === before);
  }

  // ════ SECTION 2 — OUTBOUND GATE, MODE: disabled ════
  console.log("── outbound: send modes ──");
  delete process.env.SMS_SEND_MODE; // absent ⇒ disabled
  {
    const wiresBefore = wireLog.length;
    const r = await boundary.sendPropertySms({ property_id: propA.id, recipient: resA.phone, body: "hi", purpose: "agent", person_id: resA.id });
    check("mode absent/unset defaults to disabled (safe default)", r.sent === false && r.reason === "send_mode_disabled");
    check("disabled: nothing reaches the wire", wireLog.length === wiresBefore);
  }
  process.env.SMS_SEND_MODE = "garbage_mode";
  {
    const r = await boundary.sendPropertySms({ property_id: propA.id, recipient: resA.phone, body: "hi", purpose: "agent", person_id: resA.id });
    check("unknown mode value resolves to disabled", r.reason === "send_mode_disabled");
  }

  // ── no property line: NO send, NO default fallback, any mode ──
  process.env.SMS_SEND_MODE = "customer_care";
  {
    const wiresBefore = wireLog.length;
    const r = await boundary.sendPropertySms({ property_id: propNoLine.id, recipient: resA.phone, body: "hi", purpose: "agent", person_id: resA.id });
    check("property without sms_number cannot send (no_property_line)", r.sent === false && r.reason === "no_property_line");
    check("no Messaging Service default fallback (wire untouched)", wireLog.length === wiresBefore);
  }

  // ════ SECTION 3 — proof_only ════
  process.env.SMS_SEND_MODE = "proof_only";
  process.env.SMS_PROOF_CELL = "+17243098434";
  delete process.env.SMS_ALLOW_CREDENTIAL_SENDS;
  {
    const r1 = await boundary.sendPropertySms({ property_id: propA.id, recipient: "+17243098434", body: "proof", purpose: "proof_text" });
    check("proof_only permits the exact proof aperture", r1.sent === true, r1.reason);
    check("proof aperture leaves on the PROPERTY line", wireLog[wireLog.length - 1].from === propA.sms_number);
    const r2 = await boundary.sendPropertySms({ property_id: propA.id, recipient: resA.phone, body: "proof", purpose: "proof_text" });
    check("proof_only refuses proof purpose to a NON-proof cell", r2.sent === false && r2.reason === "proof_only_recipient_not_proof_cell");
    const r3 = await boundary.sendPropertySms({ property_id: propA.id, recipient: resA.phone, body: "hey", purpose: "agent", person_id: resA.id });
    check("proof_only refuses agent sends", r3.sent === false);
    const r4 = await boundary.sendPropertySms({ property_id: propA.id, recipient: resA.phone, body: "code 123", purpose: "otp", person_id: resA.id });
    check("proof_only refuses OTP without the named flag (no smuggling)", r4.sent === false && r4.reason === "credential_sends_disabled_in_proof_only");
    process.env.SMS_ALLOW_CREDENTIAL_SENDS = "1";
    const r5 = await boundary.sendPropertySms({ property_id: propA.id, recipient: resA.phone, body: "code 123", purpose: "otp", person_id: resA.id });
    check("OTP allowed only via the named SMS_ALLOW_CREDENTIAL_SENDS flag", r5.sent === true, r5.reason);
    delete process.env.SMS_ALLOW_CREDENTIAL_SENDS;
  }

  // ════ SECTION 4 — internal_qa_autonomous + classification ════
  console.log("── classification: unclassified ≠ production; enrollment; QA mode ──");
  process.env.SMS_SEND_MODE = "internal_qa_autonomous";
  process.env.SMS_QA_PROPERTY_ID = propA.id;
  {
    // no classification row → refuse (absence is explicit)
    const r0 = await boundary.sendPropertySms({ property_id: propA.id, recipient: qa.phone, body: "auto", purpose: "agent", person_id: qa.id });
    check("no classification row → record_unclassified (refuse)", r0.sent === false && r0.reason === "record_unclassified");

    // enrollment refuses a person with NO relationship (classification never invents one)
    let enrollErr = null;
    try { await boundary.enrollInternalQa({ person_id: stranger.id, property_id: propB.id, reason: "should fail" }); }
    catch (e) { enrollErr = e.message; }
    check("enrollment refuses when no Person×Property relationship exists", !!enrollErr, enrollErr);

    // governed enrollment: classification + consent, one transaction
    const enr = await boundary.enrollInternalQa({ person_id: qa.id, property_id: propA.id, reason: "harness QA" });
    check("enrollInternalQa writes a current internal_qa classification", enr.classification.record_class === "internal_qa");
    const consent = (await pool.query(`select consent_state from contact_preferences where person_id=$1 and channel='text'`, [qa.id])).rows[0];
    check("enrollment writes consent opted_in as a SEPARATE canonical fact", consent && consent.consent_state === "opted_in");

    // now the autonomous send passes
    const r1 = await boundary.sendPropertySms({ property_id: propA.id, recipient: qa.phone, body: "auto", purpose: "agent", person_id: qa.id });
    check("QA-enrolled + opted_in → autonomous send allowed", r1.sent === true, r1.reason);
    check("QA autonomous send uses the property line", wireLog[wireLog.length - 1].from === propA.sms_number);

    // classification is PROPERTY-SCOPED: same person, other property → refuse
    await pool.query(`insert into leasing_leads (person_id, property_id) values ($1,$2)`, [qa.id, propB.id]);
    const r2 = await boundary.sendPropertySms({ property_id: propB.id, recipient: qa.phone, body: "auto", purpose: "agent", person_id: qa.id });
    check("classification is property-scoped (same person, property B → refuse)", r2.sent === false && r2.reason === "record_unclassified");

    // unknown consent blocks autonomous even when classified:
    // supersede consent to unknown by deleting the row (simulating absence)
    await pool.query(`delete from contact_preferences where person_id=$1`, [qa.id]);
    const r3 = await boundary.sendPropertySms({ property_id: propA.id, recipient: qa.phone, body: "auto", purpose: "agent", person_id: qa.id });
    check("unknown consent blocks autonomous sends even for QA-classified", r3.sent === false && r3.reason === "qa_autonomous_requires_opted_in_consent");
    // restore
    await pool.query(`insert into contact_preferences (person_id, channel, consent_state, source) values ($1,'text','opted_in','harness')`, [qa.id]);

    // STOP always blocks
    const r4 = await boundary.sendPropertySms({ property_id: propA.id, recipient: optedOut.phone, body: "auto", purpose: "agent", person_id: optedOut.id });
    check("opted_out blocks in every mode (consent_opted_out)", r4.sent === false && r4.reason === "consent_opted_out");

    // append-only supersession: reclassify to production, old row retained
    const before = await count(`select count(*) as count from person_property_classifications where person_id=$1 and property_id=$2`, [qa.id, propA.id]);
    await boundary.reclassify({ person_id: qa.id, property_id: propA.id, record_class: "production", reason: "harness flip" });
    const after = await count(`select count(*) as count from person_property_classifications where person_id=$1 and property_id=$2`, [qa.id, propA.id]);
    const current = (await pool.query(`select record_class from person_property_classifications where person_id=$1 and property_id=$2 and superseded_at is null`, [qa.id, propA.id])).rows[0];
    check("reclassify is append-only (rows grow, history retained)", after === before + 1 && current.record_class === "production");
    const r5 = await boundary.sendPropertySms({ property_id: propA.id, recipient: qa.phone, body: "auto", purpose: "agent", person_id: qa.id });
    check("QA mode refuses a now-production record (record_not_internal_qa)", r5.sent === false && r5.reason === "record_not_internal_qa");
    // flip back for cleanliness of later checks
    await boundary.reclassify({ person_id: qa.id, property_id: propA.id, record_class: "internal_qa", reason: "harness flip back" });
  }

  // ════ SECTION 5 — customer_care held ════
  process.env.SMS_SEND_MODE = "customer_care";
  {
    const r1 = await boundary.sendPropertySms({ property_id: propB.id, recipient: resB.phone, body: "care", purpose: "agent", person_id: resB.id });
    check("customer_care agent send fails closed on unclassified record", r1.sent === false && r1.reason === "record_unclassified");
    const r2 = await boundary.sendPropertySms({ property_id: propA.id, recipient: qa.phone, body: "care", purpose: "agent", person_id: qa.id });
    check("customer_care refuses internal_qa records (needs production)", r2.sent === false && r2.reason === "customer_care_requires_production_classification");
    // cross-property recipient scope: resB has no tie to propA
    const r3 = await boundary.sendPropertySms({ property_id: propA.id, recipient: resB.phone, body: "care", purpose: "otp", person_id: resB.id });
    check("cross-property recipient refused (recipient_not_in_property_scope)", r3.sent === false && r3.reason === "recipient_not_in_property_scope");
  }

  // ════ SECTION 6 — provider status is status-only ════
  console.log("── provider events: status-only ──");
  {
    const commBefore = await count(`select count(*) as count from comm_events`);
    const r1 = await boundary.recordProviderStatus({ provider_event_id: "SM_NEVER_SEEN", provider_status: "delivered", raw: { property_id: propA.id, body: "INJECTED" } });
    const commAfter = await count(`select count(*) as count from comm_events`);
    check("unknown provider event → no-op, ZERO new communications", r1.updated === false && commAfter === commBefore);

    // status for a REAL event updates + appends to the log
    const ev = (await pool.query(`select id, sms_sid from comm_events where sms_sid='SIDAMB1'`)).rows[0];
    const r2 = await boundary.recordProviderStatus({ provider_event_id: ev.sms_sid, provider_status: "delivered", raw: { s: 1 } });
    const logN = await count(`select count(*) as count from comm_event_status_log where comm_event_id=$1`, [ev.id]);
    check("known event → status recorded + appended to status log", r2.updated === true && logN >= 1);
    const commAfter2 = await count(`select count(*) as count from comm_events`);
    check("status recording creates no communications", commAfter2 === commBefore);
  }

  // ════ SECTION 7 — every refusal is stamped (attempt/refusal logged) ════
  {
    process.env.SMS_SEND_MODE = "disabled";
    const ev = (await pool.query(
      `insert into comm_events (property_id, person_id, channel, direction, body) values ($1,$2,'text','outbound','stamp me') returning id`,
      [propA.id, resA.id])).rows[0];
    await boundary.sendPropertySms({ property_id: propA.id, recipient: resA.phone, body: "stamp me", purpose: "agent", person_id: resA.id, eventId: ev.id });
    const st = (await pool.query(`select sms_status, sms_error from comm_events where id=$1`, [ev.id])).rows[0];
    check("refusal is stamped on the comm_event (refused + gate reason)", st.sms_status === "refused" && /gate:send_mode_disabled/.test(st.sms_error || ""), JSON.stringify(st));
  }

  // ════ SECTION 8 — STOP/START: canonical consent persistence ════
  console.log("── consent keywords: STOP updates the application's canonical truth ──");
  {
    process.env.SMS_SEND_MODE = "customer_care"; // a mode where a credential send WOULD pass, to prove STOP blocks it
    // resA texts STOP to property A's line
    const commBefore = await count(`select count(*) as count from comm_events where person_id=$1`, [resA.id]);
    const wiresBefore = wireLog.length;
    const rStop = await boundary.resolveInboundSmsContext({ To: propA.sms_number, From: resA.phone, MessageSid: "SIDSTOP1", body: "STOP" });
    const commAfter = await count(`select count(*) as count from comm_events where person_id=$1`, [resA.id]);
    check("STOP is recognized as a consent signal on the resolved path", rStop.consentSignal === "opted_out");
    check("STOP is recorded ONCE as a consent_signal event", commAfter === commBefore + 1 && rStop.comm_event.classification === "consent_signal");
    const pref1 = (await pool.query(`select consent_state, source from contact_preferences where person_id=$1 and channel='text'`, [resA.id])).rows[0];
    check("STOP updates contact_preferences.consent_state = opted_out (canonical truth)", pref1 && pref1.consent_state === "opted_out", JSON.stringify(pref1));
    check("STOP dispatches ZERO outbound (no reply, no AI turn)", wireLog.length === wiresBefore);
    // the application's own gate now refuses — not merely Twilio
    const rBlocked = await boundary.sendPropertySms({ property_id: propA.id, recipient: resA.phone, body: "code 999", purpose: "otp", person_id: resA.id });
    check("after STOP, the application gate refuses (consent_opted_out), not just the carrier", rBlocked.sent === false && rBlocked.reason === "consent_opted_out");
    // STOP replay is idempotent via sms_sid
    const rReplay = await boundary.resolveInboundSmsContext({ To: propA.sms_number, From: resA.phone, MessageSid: "SIDSTOP1", body: "STOP" });
    check("STOP replay (same MessageSid) is idempotent", rReplay.idempotentReplay === true);
    // START re-opts in
    const rStart = await boundary.resolveInboundSmsContext({ To: propA.sms_number, From: resA.phone, MessageSid: "SIDSTART1", body: "START" });
    const pref2 = (await pool.query(`select consent_state from contact_preferences where person_id=$1 and channel='text'`, [resA.id])).rows[0];
    check("START re-opts in (consent_state = opted_in)", rStart.consentSignal === "opted_in" && pref2.consent_state === "opted_in");
  }

  // ── cleanup harness rows ──
  await pool.query(`delete from comm_event_status_log where comm_event_id in (select id from comm_events where property_id in ($1,$2,$3))`, [propA.id, propB.id, propNoLine.id]);
  await pool.query(`delete from comm_events where property_id in ($1,$2,$3)`, [propA.id, propB.id, propNoLine.id]);
  await pool.query(`delete from person_property_classifications where property_id in ($1,$2,$3)`, [propA.id, propB.id, propNoLine.id]);
  await pool.query(`delete from contact_preferences where person_id in (select id from persons where name like '__CB_HARNESS__%')`);
  await pool.query(`delete from tenant_invites where property_id in ($1,$2,$3)`, [propA.id, propB.id, propNoLine.id]);
  await pool.query(`delete from leasing_leads where property_id in ($1,$2,$3)`, [propA.id, propB.id, propNoLine.id]);
  await pool.query(`delete from leases where property_id in ($1,$2,$3)`, [propA.id, propB.id, propNoLine.id]);
  await pool.query(`delete from spaces where unit_id in (select id from units where property_id in ($1,$2,$3))`, [propA.id, propB.id, propNoLine.id]);
  await pool.query(`delete from units where property_id in ($1,$2,$3)`, [propA.id, propB.id, propNoLine.id]);
  await pool.query(`delete from persons where name like '__CB_HARNESS__%'`);
  await pool.query(`delete from properties where name like '__CB_HARNESS__%'`);

  console.log(`\n═══ RESULT: ${pass} passed · ${fail} failed ═══`);
  console.log(`Wire attempts recorded by fake transport: ${wireLog.length} (every one carried an explicit property from)`);
  const noFrom = wireLog.filter(w => !w.from).length;
  console.log(noFrom === 0 ? "✓ ZERO wire attempts without a from line" : `✗ ${noFrom} wire attempts WITHOUT from`);
  await pool.end();
  process.exit(fail === 0 && noFrom === 0 ? 0 : 1);
})().catch(async (e) => { console.error("HARNESS CRASH:", e); try { await pool.end(); } catch (_) {} process.exit(2); });
