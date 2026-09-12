"use strict";
// Class 3 · The no-consent, two-person staff-assisted journey.
//
// Owned nonce-verified database, owned HTTP server (E2E_API_BASE), fake SMS
// transport (E2E_SMS_LOG) and fake model (E2E_ANTHROPIC_LOG). The website
// inquiry carries NO consent signal and explicit attempt_sms:false, as both
// real forms would. Two staff actors with the real authority split: "Mike"
// holds a property_manager assignment with Leasing/Management/Maintenance and
// no can_manage_roles override and no pricing grant; "KZ" holds the override
// and is the sole configured company signer. Mike owns the inquiry, records
// the email he sent outside Spine, books the tour, prepares and attests the
// application link. KZ authors and corrects terms, approves, and executes.
// Every send is an attestation, never a transport. Nothing is written by SQL
// after a business action.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const boundary = require("./proof_boundary");
require("./proof_fence_preload");
const { Pool } = require("pg");
const staffSessions = require("../../src/identity/staff_session_service");
const staffIdentity = require("../../src/identity/staff_identity_resolver");

const BASE = process.env.E2E_API_BASE;
const SMS_LOG = process.env.E2E_SMS_LOG;
const MODEL_LOG = process.env.E2E_ANTHROPIC_LOG;
assert.ok(BASE && SMS_LOG && MODEL_LOG, "E2E_API_BASE, E2E_SMS_LOG and E2E_ANTHROPIC_LOG are required");

const results = [];
let failed = 0;
let current = "setup";
function record(ok, label, detail, kind = "check") {
  results.push({ section: current, label, ok, kind, detail: detail === undefined ? null : detail });
  if (!ok && kind === "check") failed++;
  console.log(`  ${kind === "observe" ? "NOTE" : ok ? "PASS" : "FAIL"}  [${current}] ${label}${detail !== undefined ? " | " + JSON.stringify(detail).slice(0, 420) : ""}`);
}
const check = (c, l, d) => { record(!!c, l, d); return !!c; };
const observe = (l, d) => record(true, l, d, "observe");
const need = (c, l, d) => { record(!!c, l, d); if (!c) throw new Error(`need: ${l}`); };
async function section(name, fn) { current = name; console.log(`\n== ${name} ==`); try { await fn(); } catch (e) { record(false, `section aborted: ${e.message}`, null); } }
const ymd = (d) => d.toISOString().slice(0, 10);
const plusDays = (n) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + n); return ymd(d); };
const plusYear = (s) => { const d = new Date(s + "T00:00:00Z"); d.setUTCFullYear(d.getUTCFullYear() + 1); d.setUTCDate(d.getUTCDate() - 1); return ymd(d); };
async function api(method, route, { token, key = false, body, headers: extra = {} } = {}) {
  const headers = { ...extra };
  if (token) headers["x-staff-session"] = token;
  if (key) headers["x-operator-key"] = "e2e-key";
  let payload;
  if (body !== undefined) { headers["content-type"] = "application/json"; payload = JSON.stringify(body); }
  const r = await fetch(BASE + route, { method, headers, body: payload, signal: AbortSignal.timeout(60000) });
  const data = await r.json().catch(() => null);
  return { status: r.status, body: data };
}
const logText = (p) => (fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "");
function sms() { return logText(SMS_LOG).trim().split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)); }
async function waitSms(from, pred) { for (let i = 0; i < 80; i++) { const m = sms().slice(from).find(pred); if (m) return m; await new Promise((r) => setTimeout(r, 50)); } return null; }

(async () => {
  await boundary.assertDatabase();
  const pool = new Pool({ connectionString: boundary.manifest().url, ssl: false });
  const q = (sql, args = []) => pool.query(sql, args);
  const one = async (sql, args = []) => (await q(sql, args)).rows[0];
  const nonce = randomUUID().slice(0, 8);
  const numBase = 4000000 + (parseInt(nonce.slice(0, 6), 16) % 5000000);
  const num = (k) => "+1215" + String(numBase + k);
  const session = async (userId, propertyId) => (await staffSessions.issueStaffSession(pool, { userId, propertyId, purpose: "bootstrap_invite" })).session_token;
  const F = {};
  const dates = { start: plusDays(30) }; dates.end = plusYear(dates.start);
  const quiet = () => ({ sms: logText(SMS_LOG).length, model: logText(MODEL_LOG).length });
  const stillQuiet = (before) => logText(SMS_LOG).length === before.sms && logText(MODEL_LOG).length === before.model;

  async function inviteAndAccept({ token, propertyId, phone, name, role_key, person_id = null }) {
    const from = sms().length;
    const invite = await api("POST", `/properties/${propertyId}/team-invites`, { token, body: { invited_name: name, phone_number: phone, role_key, scope_type: "property", ...(person_id ? { person_id } : {}) } });
    if (invite.status >= 400) return { invite };
    const joinToken = String(invite.body.link || "").split("/join/")[1];
    const start = await api("POST", "/auth/sms/start", { body: { token: joinToken } });
    let code = null;
    if (invite.body.delivery === "sms_sent") { const t = await waitSms(from, (m) => m.to === phone && /access code is \d{6}/.test(m.body || "")); code = t ? t.body.match(/access code is (\d{6})/)[1] : null; }
    else if (start.body && start.body.dev_code) code = start.body.dev_code;
    const verify = code ? await api("POST", "/auth/sms/verify", { body: { token: joinToken, code } }) : { status: 0, body: null };
    return { invite, joinToken, verify, delivery: invite.body.delivery };
  }
  async function completeSigner({ token, name, initials, sessionId }) {
    const data = await api("GET", `/t/lease/${token}/data`);
    const fields = ((data.body && data.body.packet && data.body.packet.fields) || []).filter((f) => f.required);
    for (const f of fields) {
      const r = await api("POST", `/t/lease/${token}/fields/${f.id}/complete`, { body: { value: f.field_type === "signature" ? name : initials, consent: f.field_type === "signature", session_id: sessionId } });
      if (r.status >= 400) return { fields, failed: { field: f.field_key, status: r.status, body: r.body } };
    }
    const submit = await api("POST", `/t/lease/${token}/submit`, { body: { session_id: sessionId } });
    return { fields, submit };
  }
  const captured = (phone, email, start, guarantor) => ({ application_form_version: "tenant_v3", date_of_birth: "1995-04-12", email, phone,
    address: { line1: "100 Test Street", line2: "", city: "Philadelphia", state: "PA", postal_code: "19147" }, current_since: "2024-01", housing_status: "rent",
    income_status: "employed", employer: "Test Employer", job_title: "Analyst", income_amount: 72000, income_frequency: "annual", income_notes: "",
    desired_move_in: start, move_flexibility: "plus_minus_7", occupants: 1, household_names: "", has_pets: "no", pets: "None",
    guarantor_needed: "yes", guarantor_contact: { name: guarantor.name, phone: guarantor.phone, email: `guarantor-${nonce}@example.test` },
    additional_notes: "", applicant_accuracy_certified: true, electronic_delivery_consent: true });
  let P = null;
  const offer = (tok, space, rent, start, key, extra = {}) => api("POST", `/operator/leasing/conversions/${F.conversion.id}/application-offer`, { token: tok, body: { space_id: space, rent, security_deposit: rent, lease_start_date: start, lease_end_date: plusYear(start), fees: [], concessions: { status: "none" }, idempotency_key: key, ...extra } });
  const prepare = (tok, key, extra = {}) => api("POST", `/operator/leasing/conversions/${F.conversion.id}/send-application`, { token: tok, body: { delivery_method: "manual_email", unit_id: F.unit.id, space_id: F.bedB.id, application_offer_id: F.offer2, intended_move_in: dates.start, idempotency_key: key, ...extra } });
  const deskRead = async (label) => { const d = await api("GET", "/operator/leasing/desk", { token: F.mike.tok }); check(d.status === 200, `the Leasing desk still loads for Mike ${label}`, { status: d.status, error: d.body && d.body.error }); return d; };
  const queueRow = async (tok) => { const r = await api("GET", "/operator/leasing/conversation-queue", { token: tok }); return (r.body && (r.body.items || r.body.conversations) || []).find((x) => x.conversation_id === F.conversation) || null; };

  try {
    // ── 1 · property and the two actors ─────────────────────────────
    await section("staff", async () => {
      F.property = await one("select id, organization_id, name from properties where name in ('Skyline E2E','Property Spine Demo Building') order by created_at desc limit 1");
      need(!!F.property, "Skyline-shaped fixture property exists");
      P = F.property.id;
      if (!F.property.organization_id) {
        const org = await one("insert into organizations (name,slug) values ($1,$2) returning id", [`Journey Org ${nonce}`, `journey-org-${nonce}`]);
        await q("update properties set organization_id=$2 where id=$1", [P, org.id]); F.property.organization_id = org.id;
      }
      // Fixture SQL before any action. KZ-shaped actor = the CI instrument fixture's configured company signer
      // (can_manage_roles override). Renamed so no reader mistakes it for the restricted Mike.
      F.kz = await one("select u.id, u.person_id from users u join property_team_assignments pta on pta.user_id=u.id and pta.property_id=$1 and pta.active and pta.can_manage_roles where (u.name='Mike Grivna' or u.name like 'KZ (rehearsal signer)%') and u.is_active order by u.created_at limit 1", [P]);
      need(!!F.kz, "the fixture's configured company signer with the governed override exists");
      await q("update users set name=$2 where id=$1", [F.kz.id, `KZ (rehearsal signer) ${nonce}`]);
      if (!F.kz.person_id) {
        const p = await one("insert into persons (name,source) values ('KZ rehearsal identity','journey_fixture') returning id");
        await q("update users set person_id=$2, account_kind='human_staff' where id=$1", [F.kz.id, p.id]);
        await q("insert into assignments (person_id,property_id,role,provenance) values ($1,$2,'asset_manager',$3)", [p.id, P, JSON.stringify({ source: "journey_fixture" })]);
      }
      const signer = await one("select lease_config->'execution_authority'->'company_signer_user_ids' as signers from properties where id=$1", [P]);
      check(Array.isArray(signer.signers) && signer.signers.map(String).includes(String(F.kz.id)), "KZ is the configured company signer", { signers: (signer.signers || []).length });
      await q("update communication_lines set outbound_enabled=true, outbound_policy='proactive' where property_id=$1 and line_type='property_facing' and status='active'", [P]);
      // Operating prerequisite, set as fixture: tour times cannot be published without a property timezone.
      await q("update properties set operating_timezone=coalesce(operating_timezone,'America/New_York') where id=$1", [P]);
      observe("fixture: the property's operating timezone is set so tour times can be published (an owner input in production)");
      F.unit = await one("select id, unit_number from units where property_id=$1 and unit_number='3B' limit 1", [P]);
      F.bedB = await one("select id, space_label from spaces where unit_id=$1 and space_label='Bed B'", [F.unit.id]);
      need(F.unit && F.bedB, "fixture unit 3B with established Bed B exists");
      await q("update spaces set use_type='residential' where unit_id=$1", [F.unit.id]);
      await q("update leases set lease_status='cancelled' where property_id=$1 and space_id=$2 and lease_status not in ('cancelled','rescinded','void','superseded','terminated','expired')", [P, F.bedB.id]);
      // A foreign property where KZ also holds authority: the property wall control.
      F.other = await one("insert into properties (name,address,organization_id) values ($1,'2 Scope Wall',$2) returning id", [`Journey Other ${nonce}`, F.property.organization_id]);
      await q("insert into property_team_assignments (property_id,user_id,role_title,allowed_modules,primary_for_modules,active,can_manage_roles) values ($1,$2,'property_admin','{management,leasing}','{management}',true,true)", [F.other.id, F.kz.id]);
      F.kzTok = await session(F.kz.id, P);
      // Mike joins through the governed door with the real role preset: property_manager, no override.
      F.mikePhone = num(1);
      const made = await inviteAndAccept({ token: F.kzTok, propertyId: P, phone: F.mikePhone, name: `Mike (rehearsal) ${nonce}`, role_key: "property_manager" });
      need(made.verify && made.verify.status === 200, "Mike joins through the governed invite and OTP as property_manager", { invite: made.invite && made.invite.status, verify: made.verify && made.verify.status });
      F.mike = { id: made.verify.body.user.id, tok: made.verify.body.session_token };
      const asg = await one("select role_key, can_manage_roles, allowed_modules from property_team_assignments where user_id=$1 and property_id=$2 and active", [F.mike.id, P]);
      check(asg && asg.can_manage_roles === false && ["management", "leasing", "maintenance"].every((m) => asg.allowed_modules.includes(m)), "Mike's assignment: Leasing, Management, Maintenance, no can_manage_roles", asg);
      const grants = await one("select count(*)::int n from concession_authority_grants where property_id=$1 and person_id=$2", [P, (await one("select person_id from users where id=$1", [F.mike.id])).person_id]);
      check(grants.n === 0, "Mike holds no pricing or concession authority grant", grants);
      const id = await staffIdentity.resolveStaffIdentity(pool, { user_id: F.mike.id, property_id: P });
      check(id.state === "resolved", "Mike resolves as staff at the property", { state: id.state });
    });
    need(F.mike && F.kzTok, "actors ready");

    // ── 2 · the website inquiry, no consent, capture only ───────────
    await section("inquiry", async () => {
      F.prospect = { name: `NoConsent Prospect ${nonce}`, phone: num(2), email: `prospect-${nonce}@example.test` };
      await q("insert into lead_sources (name,source_type) values ($1,'website') on conflict do nothing", ["Website"]);
      F.q1 = `Can you send me the floor plan for a two-bedroom? ${nonce}`;
      const body = { property_id: P, name: F.prospect.name, email: F.prospect.email, phone: F.prospect.phone, source: "Website", source_lead_id: `sq-${nonce}`, response_channel: "website", message: F.q1, attempt_sms: false };
      const before = quiet();
      const first = await api("POST", "/leasing/intake", { headers: { "x-intake-secret": "e2e-intake", "Idempotency-Key": `form-${nonce}` }, body });
      need(first.status === 200 && first.body.person_id && first.body.conversation_id, "the website inquiry (phone present, no consent field) is captured", { status: first.status, receipt: first.body && first.body.receipt, first_response_sent: first.body && first.body.first_response_sent });
      F.person = first.body.person_id; F.lead = first.body.lead_id; F.conversation = first.body.conversation_id;
      check(first.body.first_response_sent === false && stillQuiet(before), "capture only: no model call, no text, no first response", { first_response_sent: first.body.first_response_sent });
      const outbound = await one("select count(*)::int n from comm_events where conversation_id=$1 and direction='outbound'", [F.conversation]);
      check(outbound.n === 0, "no phantom outbound message exists on the thread", outbound);
      const consent = await one("select consent_state from contact_preferences where person_id=$1 and channel='text'", [F.person]);
      check(!consent || consent.consent_state !== "opted_in", "no text consent was recorded (absent stays absent)", { consent_state: consent ? consent.consent_state : "absent" });
      const replay = await api("POST", "/leasing/intake", { headers: { "x-intake-secret": "e2e-intake", "Idempotency-Key": `form-${nonce}` }, body });
      check(replay.status === 200 && replay.body.replayed === true && replay.body.conversation_id === F.conversation && stillQuiet(before), "an exact relay retry replays the capture and sends nothing", { replayed: replay.body && replay.body.replayed });
      const row = await queueRow(F.mike.tok);
      check(row && row.control_bucket === "needs_you" && row.bucket_reason_code === "website_inquiry_pending_human", "Mike's queue shows the inquiry as needing a person", { control_bucket: row && row.control_bucket, reason: row && row.bucket_reason_code });
      const detail = await api("GET", `/operator/leasing/conversations/${F.conversation}`, { token: F.mike.tok });
      check(detail.status === 200 && (detail.body.messages || []).some((m) => m.channel === "website" && m.direction === "inbound" && m.body === F.q1), "the conversation carries the original website question");
    });

    // ── 3 · ownership and the email Mike already sent ───────────────
    await section("ownership-and-email", async () => {
      need(F.conversation, "conversation exists");
      // The email was sent after the inquiry arrived: its occurrence must follow the inbound to count as an answer.
      const emailBody = { channel: "email", body: `Hi ${F.prospect.name.split(" ")[0]}, thanks for asking. Floor plan attached. ${nonce}`, recipient: F.prospect.email, occurred_at: new Date().toISOString(), idempotency_key: `email-${nonce}`, already_sent: true };
      const early = await api("POST", `/operator/leasing/conversations/${F.conversation}/reply`, { token: F.mike.tok, body: emailBody });
      check(early.status === 409, "recording an email before taking ownership is refused", { status: early.status, error: early.body && early.body.error });
      const take = await api("POST", `/operator/conversations/${F.conversation}/take-over`, { token: F.mike.tok, body: {} });
      need(take.status === 200, "Mike takes ownership", { status: take.status });
      const kzTake = await api("POST", `/operator/conversations/${F.conversation}/take-over`, { token: F.kzTok, body: {} });
      check(kzTake.status === 409, "KZ cannot take the owned inquiry away silently", { status: kzTake.status });
      const kzEmail = await api("POST", `/operator/leasing/conversations/${F.conversation}/reply`, { token: F.kzTok, body: { ...emailBody, idempotency_key: `kz-${nonce}` } });
      check(kzEmail.status === 409, "a staff member who does not own the conversation cannot record the reply", { status: kzEmail.status });
      const before = quiet();
      const rec = await api("POST", `/operator/leasing/conversations/${F.conversation}/reply`, { token: F.mike.tok, body: emailBody });
      need(rec.status === 200 && rec.body.recorded === true && rec.body.dispatched === false && rec.body.provider_delivery === "not_verified", "Mike records the email he already sent; delivery stays unverified", { status: rec.status, body: rec.body && { recorded: rec.body.recorded, replayed: rec.body.replayed, dispatched: rec.body.dispatched, provider_delivery: rec.body.provider_delivery } });
      check(stillQuiet(before), "recording the email sent nothing and called no model");
      const again = await api("POST", `/operator/leasing/conversations/${F.conversation}/reply`, { token: F.mike.tok, body: emailBody });
      check(again.status === 200 && again.body.replayed === true, "the same recording key replays, never a second event", { replayed: again.body && again.body.replayed });
      const drift = await api("POST", `/operator/leasing/conversations/${F.conversation}/reply`, { token: F.mike.tok, body: { ...emailBody, body: emailBody.body + " (edited)" } });
      check(drift.status === 409, "the same key with a different claim is refused", { status: drift.status });
      const wrongTo = await api("POST", `/operator/leasing/conversations/${F.conversation}/reply`, { token: F.mike.tok, body: { ...emailBody, idempotency_key: `wrongto-${nonce}`, recipient: `someone-else-${nonce}@example.test` } });
      check(wrongTo.status === 409, "the recipient must be the person's recorded email", { status: wrongTo.status });
      const notSent = await api("POST", `/operator/leasing/conversations/${F.conversation}/reply`, { token: F.mike.tok, body: { ...emailBody, idempotency_key: `notsent-${nonce}`, already_sent: false } });
      check(notSent.status === 400, "an email not yet sent cannot be recorded as sent", { status: notSent.status });
      const events = await one("select count(*)::int n, min(provider_status) status from comm_events where conversation_id=$1 and direction='outbound' and channel='email'", [F.conversation]);
      check(events.n === 1 && events.status === "recorded_external", "exactly one recorded-external email event exists", events);
      const row = await queueRow(F.mike.tok);
      check(row && row.waiting_on === "prospect" && row.last_delivered_outbound_at === null, "the queue now waits on the prospect without inventing a delivery", { waiting_on: row && row.waiting_on, last_delivered_outbound_at: row && row.last_delivered_outbound_at });
      // The prospect writes again through the website: same owner, unanswered again.
      F.q2 = `Thanks. Is a bed in 3B available for ${dates.start}? ${nonce}`;
      const before2 = quiet();
      const second = await api("POST", "/leasing/intake", { headers: { "x-intake-secret": "e2e-intake", "Idempotency-Key": `form2-${nonce}` }, body: { property_id: P, name: F.prospect.name, email: F.prospect.email, phone: F.prospect.phone, source: "Website", source_lead_id: `sq-${nonce}`, response_channel: "website", message: F.q2, attempt_sms: false } });
      check(second.status === 200 && second.body.conversation_id === F.conversation && stillQuiet(before2), "the follow-up lands on the same conversation with no model or text", { status: second.status, same_conversation: second.body && second.body.conversation_id === F.conversation });
      const row2 = await queueRow(F.mike.tok);
      const detail = await api("GET", `/operator/leasing/conversations/${F.conversation}`, { token: F.mike.tok });
      check(row2 && row2.waiting_on === "manager" && detail.body.human_owner && detail.body.human_owner.user_id === F.mike.id, "the follow-up is unanswered again and still Mike's", { waiting_on: row2 && row2.waiting_on, reason: row2 && row2.bucket_reason_code, owner_is_mike: detail.body.human_owner && detail.body.human_owner.user_id === F.mike.id });
      const ask = await api("POST", "/operator/ask-spine/ask", { token: F.mike.tok, body: { question: `Show website inquiries for ${F.prospect.name}.` } });
      check(ask.status === 200 && typeof ask.body.answer === "string" && ask.body.answer.includes(F.q1) && ask.body.answer.includes(F.q2), "Ask Spine reads both website questions through its scoped inquiry read", { outcome: ask.body && ask.body.outcome });
    });

    // ── 4 · native tour ─────────────────────────────────────────────
    await section("tour", async () => {
      need(F.conversation, "conversation exists");
      const starts = new Date(Date.now() + 2 * 86400000), ends = new Date(starts.getTime() + 3600000);
      const slot = await api("POST", "/leasing/availability", { token: F.mike.tok, key: true, body: { property_id: P, starts_at: starts.toISOString(), ends_at: ends.toISOString(), unit_id: F.unit.id, leasing_agent_id: F.mike.id, capacity: 1, idempotency_key: `slot-${nonce}` } });
      need(slot.status < 400 && slot.body.slot, "a native slot is published for Mike", { status: slot.status, body: slot.body });
      const before = quiet();
      const booked = await api("POST", `/operator/leasing/conversations/${F.conversation}/book-tour`, { token: F.mike.tok, body: { slot_id: slot.body.slot.id, idempotency_key: `book-${nonce}` } });
      need(booked.status === 200 && booked.body.tour_id, "Mike books the prospect onto the slot from the conversation", { status: booked.status, body: booked.body });
      F.tour = booked.body.tour_id;
      const replay = await api("POST", `/operator/leasing/conversations/${F.conversation}/book-tour`, { token: F.mike.tok, body: { slot_id: slot.body.slot.id, idempotency_key: `book-${nonce}` } });
      check(replay.status === 200 && replay.body.idempotent && replay.body.tour_id === F.tour && stillQuiet(before), "a repeated booking returns the same tour and sends nothing");
      const checkin = await api("POST", `/leasing/tours/${F.tour}/check-in`, { key: true, body: { actor_id: F.mike.id } });
      check(checkin.status < 400, "tour check-in", { status: checkin.status });
      const done = await api("POST", `/operator/leasing/tours/${F.tour}/complete`, { token: F.mike.tok, body: { actual_tour_host_user_id: F.mike.id, preferred_unit_id: F.unit.id, feedback: { standing: "ready_to_apply", notes: "Wants Bed B" }, idempotency_key: `done-${nonce}` } });
      need(done.status === 200, "Mike records the actual outcome as ready to apply", { status: done.status, body: done.body });
      F.conversion = await one("select id, person_id from leasing_conversions where origin_tour_id=$1 and property_id=$2", [F.tour, P]);
      need(F.conversion && F.conversion.person_id === F.person, "the outcome opened the conversion for the same person");
    });

    // ── 5 · exact home, KZ authors and corrects the terms ───────────
    await section("offer", async () => {
      need(F.conversion, "conversion exists");
      const targets = await api("GET", "/operator/leasing/leaseable-units", { token: F.mike.tok });
      const chosen = (targets.body.eligible_targets || []).find((t) => t.space_id === F.bedB.id);
      need(!!chosen && chosen.resolution_basis === "chosen_space" && chosen.marketing_state === "marketable_now", "Bed B is offerable as an exact choice", chosen && { marketing_state: chosen.marketing_state });
      // Sibling apartment C7: Bed A leased (possession), Bed B free. Fixture rows before the offers.
      const baseline = await one("select ib.id as import_batch_id, a.id as activation_id from import_batches ib join activations a on a.property_id=ib.property_id where ib.property_id=$1 order by ib.created_at limit 1", [P]);
      const c7 = await one("insert into units (property_id,unit_number) values ($1,$2) returning id", [P, `C7-${nonce}`]);
      await q("update spaces set space_label='Bed A', use_type='residential', position_kind='bed' where unit_id=$1", [c7.id]);
      F.c7A = await one("select id from spaces where unit_id=$1 and space_label='Bed A'", [c7.id]);
      await q("insert into leases (property_id,space_id,start_date,end_date,lease_status,rent) values ($1,$2,$3,$4,'active',950)", [P, F.c7A.id, plusDays(-100), plusDays(200)]);
      const mikeOffer = await offer(F.mike.tok, F.bedB.id, 1025, dates.start, `mike-${nonce}`);
      check(mikeOffer.status === 403 && mikeOffer.body.error === "NO_APPLICATION_OFFER_AUTHORITY", "Mike cannot author terms: no override, no pricing grant", { status: mikeOffer.status, error: mikeOffer.body && mikeOffer.body.error });
      const occupied = await offer(F.kzTok, F.c7A.id, 950, dates.start, `occ-${nonce}`);
      check(occupied.status === 409 && occupied.body.error === "not_offerable", "KZ cannot offer a bed another resident holds", { status: occupied.status, error: occupied.body && occupied.body.error });
      const first = await offer(F.kzTok, F.bedB.id, 1025, dates.start, `offer-${nonce}`);
      need(first.status === 200 && first.body.application_offer_id, "KZ authors the offer for the chosen bed", { status: first.status });
      F.offer1 = first.body.application_offer_id;
      const mikeFix = await offer(F.mike.tok, F.bedB.id, 1100, dates.start, `mikefix-${nonce}`, { supersedes_application_offer_id: F.offer1 });
      check(mikeFix.status === 403, "Mike cannot correct the draft either", { status: mikeFix.status });
      const fix = await offer(F.kzTok, F.bedB.id, 1100, dates.start, `fix-${nonce}`, { supersedes_application_offer_id: F.offer1 });
      need(fix.status === 200 && fix.body.draft_revision === true && fix.body.applicant_review_required === false, "KZ corrects the unsent draft before any invitation exists (explicit successor, no message)", { status: fix.status, body: fix.body && { draft_revision: fix.body.draft_revision, applicant_review_required: fix.body.applicant_review_required, receipt: fix.body.receipt } });
      F.offer2 = fix.body.application_offer_id;
      await deskRead("after the corrected draft offer exists");
      const branch = await offer(F.kzTok, F.bedB.id, 1150, dates.start, `branch-${nonce}`, { supersedes_application_offer_id: F.offer1 });
      check(branch.status === 409, "the superseded draft cannot be corrected twice", { status: branch.status, error: branch.body && branch.body.error });
    });

    // ── 6 · Mike prepares the link for email; nothing is sent ───────
    await section("prepare", async () => {
      need(F.offer2, "corrected offer exists");
      const smsAttempt = await api("POST", `/operator/leasing/conversions/${F.conversion.id}/send-application`, { token: F.mike.tok, body: { delivery_method: "sms", unit_id: F.unit.id, space_id: F.bedB.id, application_offer_id: F.offer2, intended_move_in: dates.start, idempotency_key: `sms-${nonce}` } });
      check(smsAttempt.status >= 400 && sms().filter((m) => m.to === F.prospect.phone).length === 0, "a text delivery is refused without consent and nothing is texted", { status: smsAttempt.status, error: smsAttempt.body && smsAttempt.body.error });
      const stale = await prepare(F.mike.tok, `stale-${nonce}`, { application_offer_id: F.offer1 });
      check(stale.status === 409, "the superseded offer cannot be prepared", { status: stale.status, error: stale.body && stale.body.error });
      const wrongBed = await prepare(F.mike.tok, `wrongbed-${nonce}`, { space_id: F.c7A.id, unit_id: (await one("select unit_id from spaces where id=$1", [F.c7A.id])).unit_id });
      check(wrongBed.status >= 400, "a bed another resident holds cannot be prepared", { status: wrongBed.status, error: wrongBed.body && wrongBed.body.error });
      const foreign = await api("POST", `/operator/leasing/conversions/${F.conversion.id}/send-application`, { token: await session(F.kz.id, F.other.id), body: { delivery_method: "manual_email", unit_id: F.unit.id, space_id: F.bedB.id, application_offer_id: F.offer2, intended_move_in: dates.start, idempotency_key: `foreign-${nonce}` } });
      check(foreign.status === 403, "a session at another property cannot prepare this conversation's link", { status: foreign.status });
      const before = quiet();
      const prepared = await prepare(F.mike.tok, `prep-${nonce}`);
      need(prepared.status === 200 && prepared.body.prepared === true && prepared.body.sent === false && prepared.body.dispatched === false && /\/t\/application\//.test(prepared.body.link || ""), "Mike prepares the application link for email; nothing is sent", { status: prepared.status, body: prepared.body && { prepared: prepared.body.prepared, sent: prepared.body.sent, invitation: !!prepared.body.invitation_id, email: prepared.body.email } });
      F.invitation = prepared.body.invitation_id; F.sendObligation = prepared.body.send_obligation_id; F.link = prepared.body.link;
      check(stillQuiet(before), "preparation sent nothing and called no model");
      const lost = await prepare(F.mike.tok, `prep-${nonce}`);
      check(lost.status === 409 && lost.body.error === "APPLICATION_LINK_ALREADY_PREPARED" && lost.body.invitation_id === F.invitation && lost.body.link === null, "a lost-response retry names the existing invitation and never re-mints the link", { status: lost.status, error: lost.body && lost.body.error, link: lost.body && lost.body.link });
      const expiry = await prepare(F.mike.tok, `prep-${nonce}`, { expires_at: new Date(Date.now() + 3 * 86400000).toISOString() });
      check(expiry.status === 409 && expiry.body.error === "APPLICATION_PREPARATION_CONFLICT", "a retry with a changed expiry is a conflict, not a silent change", { status: expiry.status, error: expiry.body && expiry.body.error });
      await deskRead("after the link is prepared");
      const detail = await api("GET", `/operator/leasing/conversations/${F.conversation}`, { token: F.mike.tok });
      const preparedList = JSON.stringify(detail.body).includes(F.invitation);
      check(detail.status === 200 && preparedList && !JSON.stringify(detail.body).includes(F.link.split("/t/application/")[1]), "reload: conversation detail names the prepared invitation and exposes no token", { listed: preparedList });
      const regen = await api("POST", `/operator/leasing/application-invitations/${F.invitation}/regenerate`, { token: F.mike.tok, body: {} });
      need(regen.status === 200 && regen.body.link && regen.body.invitation_id, "a replacement link is issued for the lost one", { status: regen.status, body: regen.body && { invitation_id: regen.body.invitation_id, replaced: regen.body.invitation_id !== F.invitation } });
      const oldToken = F.link.split("/t/application/")[1];
      const oldCtx = await api("GET", `/t/application/${oldToken}/context`);
      const oldInv = await one("select status, revoked_reason, superseded_by_invitation_id is not null as superseded from application_invitations where id=$1", [F.invitation]);
      observe("what the replaced link shows the applicant after regeneration (the invitation row is revoked)", { context_status: oldCtx.status, context_state: oldCtx.body && (oldCtx.body.state || oldCtx.body.status || oldCtx.body.error || null), invitation: oldInv });
      F.oldToken = oldToken;
      F.invitation = regen.body.invitation_id; F.sendObligation = regen.body.send_obligation_id || F.sendObligation; F.link = regen.body.link;
      F.appToken = F.link.split("/t/application/")[1];
      check(stillQuiet(before), "still nothing sent after the replacement");
    });

    // ── 7 · Mike attests the email he sent; the applicant applies ───
    await section("attest-and-apply", async () => {
      need(F.appToken && F.invitation, "prepared link exists");
      const sendOb = F.sendObligation;
      const attest = await api("POST", `/operator/leasing/application-invitations/${F.invitation}/sent`, { token: F.mike.tok, body: { send_obligation_id: sendOb, channel: "email", recipient_snapshot: F.prospect.email, note: "sent from my mailbox" } });
      need(attest.status === 200, "Mike attests that he emailed the link", { status: attest.status, body: attest.body });
      const inv = await one("select status, dispatch_source, channel from application_invitations where id=$1", [F.invitation]);
      check(inv.status === "manually_sent" && inv.dispatch_source === "manual" && inv.channel === "email", "the invitation reads manually sent by email, never provider dispatched", inv);
      const twice = await api("POST", `/operator/leasing/application-invitations/${F.invitation}/sent`, { token: F.mike.tok, body: { send_obligation_id: sendOb, channel: "email", recipient_snapshot: F.prospect.email } });
      const sentInvitations = await one("select count(*)::int n, min(sent_at)::text first_sent from application_invitations where conversion_id=$1 and status in ('manually_sent','provider_dispatched')", [F.conversion.id]);
      check(twice.status === 200 && twice.body.idempotent === true && twice.body.finalized === false && sentInvitations.n === 1, "a second attestation is a replay: one sent invitation, the first send fact stands", { status: twice.status, idempotent: twice.body && twice.body.idempotent, receipt: twice.body && twice.body.receipt, sent_invitations: sentInvitations.n });
      check(sms().filter((m) => m.to === F.prospect.phone).length === 0, "no text ever reached the prospect");
      const ctx = await api("GET", `/t/application/${F.appToken}/context`);
      need(ctx.status === 200 && ctx.body.application_terms && ctx.body.application_terms.rent === "1100.00", "the applicant opens the emailed link and sees the corrected terms", { status: ctx.status, rent: ctx.body && ctx.body.application_terms && ctx.body.application_terms.rent, unit_label: ctx.body && ctx.body.unit_label });
      F.guarantor = { name: `Journey Guarantor ${nonce}`, phone: num(3) };
      const body = { token: F.appToken, applicant_name: F.prospect.name, captured: captured(F.prospect.phone, F.prospect.email, dates.start, F.guarantor), application_terms_hash: ctx.body.application_terms.terms_hash, application_terms_acknowledged: true };
      const replaced = await api("POST", "/applications/submit-public", { body: { ...body, token: F.oldToken } });
      check(replaced.status >= 400, "the replaced (revoked) link cannot submit an application", { status: replaced.status, error: replaced.body && replaced.body.error });
      const oldHash = (await one("select offered_terms_snapshot->>'application_terms_hash' h from lease_offers where id=$1", [F.offer1])).h;
      const staleSubmit = await api("POST", "/applications/submit-public", { body: { ...body, application_terms_hash: oldHash } });
      check(staleSubmit.status === 409, "acknowledging the superseded terms cannot submit", { status: staleSubmit.status });
      const submitted = await api("POST", "/applications/submit-public", { body });
      need(submitted.status === 200 && submitted.body.application && submitted.body.application.id, "the applicant submits with a guarantor against the acknowledged terms", { status: submitted.status, body: submitted.body });
      F.app = submitted.body.application.id;
      const again = await api("POST", "/applications/submit-public", { body });
      check(again.status === 200 && again.body.idempotent && again.body.application.id === F.app, "a repeated submission returns the same application");
      await deskRead("after the application is submitted");
      const row = await one("select person_id, space_id, application_offer_id, conversion_id from lease_applications where id=$1", [F.app]);
      check(row.person_id === F.person && row.space_id === F.bedB.id && row.application_offer_id === F.offer2 && row.conversion_id === F.conversion.id, "the application is the same person, conversion, bed and corrected offer");
    });

    // ── 8 · approval, terms, packet, signatures, KZ execution ───────
    await section("lease", async () => {
      need(F.app, "application exists");
      const ob = await one("select o.assigned_role, o.assigned_user_id from lease_applications a join obligations o on o.id=a.approval_obligation_id where a.id=$1", [F.app]);
      const mikeApprove = await api("POST", `/operator/leasing/applications/${F.app}/approve`, { token: F.mike.tok, body: {} });
      check(mikeApprove.status === 403, "Mike is not the approval obligation's owner and holds no override", { status: mikeApprove.status, obligation_role: ob && ob.assigned_role });
      const foreign = await api("POST", `/operator/leasing/applications/${F.app}/approve`, { token: await session(F.kz.id, F.other.id), body: {} });
      check(foreign.status === 403, "KZ's session at another property cannot approve", { status: foreign.status });
      const approved = await api("POST", `/operator/leasing/applications/${F.app}/approve`, { token: F.kzTok, body: {} });
      need(approved.status < 400, "KZ approves under the governed override", { status: approved.status });
      const changed = await api("POST", `/operator/leasing/applications/${F.app}/proposed-terms`, { token: F.mike.tok, body: { rent: 1150, security_deposit: 1100, lease_start_date: dates.start, lease_end_date: dates.end, concession_status: "none", idempotency_key: `changed-${nonce}` } });
      check(changed.status === 409, "terms the applicant did not acknowledge cannot be confirmed", { status: changed.status });
      let terms = await api("POST", `/operator/leasing/applications/${F.app}/proposed-terms`, { token: F.mike.tok, body: { rent: 1100, security_deposit: 1100, lease_start_date: dates.start, lease_end_date: dates.end, concession_status: "none", idempotency_key: `terms-${nonce}` } });
      let termsBy = "mike";
      if (terms.status >= 400) { terms = await api("POST", `/operator/leasing/applications/${F.app}/proposed-terms`, { token: F.kzTok, body: { rent: 1100, security_deposit: 1100, lease_start_date: dates.start, lease_end_date: dates.end, concession_status: "none", idempotency_key: `terms-${nonce}` } }); termsBy = "kz"; }
      need(terms.status < 400, "the acknowledged terms are confirmed", { status: terms.status, by: termsBy });
      observe("who confirmed the acknowledged terms", { by: termsBy });
      let packet = await api("POST", `/operator/leasing/applications/${F.app}/lease-packet`, { token: F.mike.tok, body: {} }); let packetBy = "mike";
      if (packet.status >= 400) { packet = await api("POST", `/operator/leasing/applications/${F.app}/lease-packet`, { token: F.kzTok, body: {} }); packetBy = "kz"; }
      need(packet.status < 400 && packet.body.packet, "the governing lease packet is generated", { status: packet.status, by: packetBy });
      observe("who generated the packet", { by: packetBy });
      F.packet = packet.body.packet.id;
      const late = await offer(F.kzTok, F.bedB.id, 1120, dates.start, `late-${nonce}`, { supersedes_application_offer_id: F.offer2 });
      check(late.status === 409, "a prepared packet blocks a further offer change", { status: late.status });
      const before = quiet();
      let issued = await api("POST", `/operator/leasing/lease-packets/${F.packet}/send`, { token: F.mike.tok, body: { idempotency_key: `issue-${nonce}` } }); let issuedBy = "mike";
      if (issued.status >= 400) { issued = await api("POST", `/operator/leasing/lease-packets/${F.packet}/send`, { token: F.kzTok, body: { idempotency_key: `issue-${nonce}` } }); issuedBy = "kz"; }
      need(issued.status < 400 && Array.isArray(issued.body.signing_links), "resident and guarantor signing links are issued", { status: issued.status, by: issuedBy });
      observe("who issued the signing links; no text left for the prospect", { by: issuedBy, texts_to_prospect: sms().filter((m) => m.to === F.prospect.phone).length, quiet: stillQuiet(before) });
      const links = Object.fromEntries(issued.body.signing_links.map((l) => [l.signer_role, String(l.url).split("/t/lease/")[1]]));
      need(links.tenant && links.guarantor && links.tenant !== links.guarantor, "separate resident and guarantor secrets");
      const reissue = await api("POST", `/operator/leasing/lease-packets/${F.packet}/send`, { token: issuedBy === "mike" ? F.mike.tok : F.kzTok, body: { idempotency_key: `issue-${nonce}` } });
      check(reissue.status < 400 && (reissue.body.already_issued === true || reissue.body.idempotent), "re-issuing is a replay, not a second package", { status: reissue.status });
      const g = await completeSigner({ token: links.guarantor, name: F.guarantor.name, initials: "JG", sessionId: `g-${nonce}` });
      check(g.submit && g.submit.status < 400 && g.fields.every((f) => f.signer_role === "guarantor"), "the guarantor completes only guarantor controls", { status: g.submit && g.submit.status, failed: g.failed });
      const premature = await api("POST", `/operator/leasing/lease-packets/${F.packet}/company-sign`, { token: F.kzTok, body: {} });
      check(premature.status === 409, "the company cannot execute before the resident has signed", { status: premature.status });
      const r = await completeSigner({ token: links.tenant, name: F.prospect.name, initials: "NP", sessionId: `r-${nonce}` });
      check(r.submit && r.submit.status < 400 && r.submit.body.packet && r.submit.body.packet.status === "resident_executed", "the resident completes and the package reads resident executed", { status: r.submit && r.submit.status, failed: r.failed });
      const mikeSign = await api("POST", `/operator/leasing/lease-packets/${F.packet}/company-sign`, { token: F.mike.tok, body: {} });
      check(mikeSign.status === 403, "Mike is not the company signer", { status: mikeSign.status, error: mikeSign.body && mikeSign.body.error });
      const executed = await api("POST", `/operator/leasing/lease-packets/${F.packet}/company-sign`, { token: F.kzTok, body: {} });
      need(executed.status < 400 && executed.body.tenancy && executed.body.tenancy.lease_id, "KZ executes and the tenancy is created", { status: executed.status, body: executed.body });
      F.leaseId = executed.body.tenancy.lease_id;
      const twice = await api("POST", `/operator/leasing/lease-packets/${F.packet}/company-sign`, { token: F.kzTok, body: {} });
      check(twice.status === 409 || (twice.status < 400 && twice.body.tenancy && twice.body.tenancy.lease_id === F.leaseId), "executing again creates no second tenancy", { status: twice.status });
      const lease = await one("select space_id, rent, lease_status, start_date, economic_tenancy_activated_at from leases where id=$1", [F.leaseId]);
      check(lease.space_id === F.bedB.id && Number(lease.rent) === 1100 && ymd(new Date(lease.start_date)) === dates.start, "the tenancy is anchored to the exact bed at the acknowledged corrected rent", { rent: lease.rent, lease_status: lease.lease_status });
      const possession = await one("select count(*)::int n from unit_events where space_id=$1 and event_type='move_in' and status not in ('cancelled','superseded')", [F.bedB.id]);
      check(lease.lease_status === "pending" && lease.economic_tenancy_activated_at === null && possession.n === 0, "execution leaves a pending lease without economic activation or possession", { lease_status: lease.lease_status, activated: lease.economic_tenancy_activated_at, move_in_events: possession.n });
      check((await one("select count(*)::int n from leases where property_id=$1 and space_id=$2 and lease_status not in ('cancelled','void','superseded')", [P, F.bedB.id])).n === 1, "exactly one lease exists on the bed");
      const targets = await api("GET", "/operator/leasing/leaseable-units", { token: F.mike.tok });
      check(!(targets.body.eligible_targets || []).some((t) => t.space_id === F.bedB.id), "the leased bed leaves the selector");
      const review = await api("GET", `/operator/leasing/application-review?application_id=${F.app}`, { token: F.mike.tok });
      check(review.status === 200 && review.body.application_id === F.app && review.body.lease_id === F.leaseId && review.body.space && review.body.space.space_id === F.bedB.id, "Application Review reads the same application, bed and tenancy", { status: review.status });
      const card = await api("GET", `/operator/leasing/person-card?person_id=${F.person}`, { token: F.mike.tok });
      check(card.status === 200 && card.body.leasing_standing && card.body.leasing_standing.tenancy && card.body.leasing_standing.tenancy.lease_id === F.leaseId, "the Person Card reads the same pending tenancy", { status: card.status });
      await deskRead("after execution");
      check(sms().filter((m) => m.to === F.prospect.phone).length === 0 && sms().filter((m) => m.to === F.guarantor.phone).length === 0, "no text was ever sent to the prospect or the guarantor in the whole journey");
    });

    // ── 9 · removed authority ───────────────────────────────────────
    await section("removed-authority", async () => {
      need(F.mike, "Mike exists");
      const asg = await one("select id from property_team_assignments where user_id=$1 and property_id=$2 and active", [F.mike.id, P]);
      const off = await api("PATCH", `/property-team-assignments/${asg.id}`, { token: F.kzTok, body: { active: false } });
      need(off.status === 200, "KZ removes Mike's access through the governed door", { status: off.status });
      const gone = await api("GET", "/operator/leasing/conversation-queue", { token: F.mike.tok });
      check(gone.status === 401 || gone.status === 403, "Mike's live session loses access immediately", { status: gone.status });
      const noPrep = await prepare(F.mike.tok, `after-${nonce}`);
      check(noPrep.status === 401 || noPrep.status === 403, "a removed assignment cannot prepare a link", { status: noPrep.status });
      const on = await api("PATCH", `/property-team-assignments/${asg.id}`, { token: F.kzTok, body: { active: true } });
      observe("access restored through the same door", { status: on.status });
    });
  } finally { await pool.end(); }
  current = "completion";
  check(!!F.leaseId, "the no-consent, two-person chain completes with an executed pending lease", { lease_created: !!F.leaseId });
  const summary = { passed: results.filter((r) => r.ok && r.kind === "check").length, failed, observations: results.filter((r) => r.kind === "observe").length };
  if (process.env.PROOF_OUTPUT_DIR) fs.writeFileSync(path.join(process.env.PROOF_OUTPUT_DIR, `no_consent_two_person_journey.${process.env.PROOF_EVIDENCE_LABEL || "run"}.json`), JSON.stringify({ server: process.env.PROOF_SERVER_SHA || null, summary, results }, null, 2));
  console.log(`\nno-consent two-person journey: ${summary.passed} passed, ${failed} failed, ${summary.observations} observations`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
