"use strict";
// Class 3 · staff-assisted lead-to-lease journey, one prospect end to end.
//
// Owned nonce-verified database, owned HTTP server (E2E_API_BASE), fake SMS
// transport (E2E_SMS_LOG), model sentinel. Synthetic people only.
//
// ONE person, ONE lead, ONE conversation, ONE explicitly chosen bed, from the
// authenticated website inquiry to the executed tenancy:
//
//   website inquiry (authenticated relay, Idempotency-Key)
//   → staff ownership (take-over)                → native tour from the
//   conversation → actual outcome captured        → exact available bed
//   → authorized offer (governed dates, rent)     → Ask Spine proposal and
//   confirmation → application text → public       application with guarantor
//   → approval → confirmed terms → lease packet   → guarantor and resident
//   signatures → company execution → tenancy on   the exact bed.
//
// At each door the things a real week presses: a named occupied sibling bed
// must not become the free one; an ambiguous choice clarifies; a changed
// offer forces review; retries never duplicate an invitation, application,
// lease or message; wrong-property and removed-authority requests refuse; a
// home with unknown readiness refuses truthfully. Availability, certification,
// execution, activation and possession stay distinct facts in the record.
//
// JOURNEY_SHAPE=skyline (default) runs on the Skyline-shaped CI fixture
// property. JOURNEY_SHAPE=greenery builds a Greenery-shaped property through
// the existing adoption and Team-invite path (PROOF_GREENERY_ID must be the
// id the server was booted with in its allowlists) and records where the
// chain stops for want of configuration; nothing Skyline-specific is copied
// into it as truth.
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
const SHAPE = process.env.JOURNEY_SHAPE || "skyline";
assert.ok(["skyline", "greenery"].includes(SHAPE), "JOURNEY_SHAPE must be skyline or greenery");
assert.ok(BASE && SMS_LOG, "E2E_API_BASE and E2E_SMS_LOG are required");

const results = [];
let failed = 0, current = "setup";
function record(ok, label, detail, kind = "check") {
  results.push({ section: current, label, ok, kind, detail: detail === undefined ? null : detail });
  if (!ok && kind === "check") failed++;
  console.log(`  ${kind === "observe" ? "NOTE" : ok ? "PASS" : "FAIL"}  [${current}] ${label}${detail !== undefined ? " | " + JSON.stringify(detail).slice(0, 400) : ""}`);
}
const check = (c, l, d) => { record(!!c, l, d); return !!c; };
const observe = (l, d) => record(true, l, d, "observe");
const need = (c, l, d) => { record(!!c, l, d); if (!c) throw new Error(`need: ${l}`); };
// The deliberately empty Greenery fixture may stop at configuration. A stop
// records later sections as not exercised; Skyline must still complete below.
let stopped = null;
const DEPENDENT = new Set(["exact-home", "offer", "send", "application", "lease"]);
const stop = (reason) => Object.assign(new Error(reason), { configuration_stop: true });
async function section(name, fn) {
  current = name; console.log(`\n== ${name} ==`);
  if (stopped && DEPENDENT.has(name)) { observe(`not exercised: the chain stopped at ${stopped.section} (${stopped.reason})`); return; }
  try { await fn(); }
  catch (e) {
    if (e.configuration_stop) { stopped = { section: name, reason: e.message }; observe(`chain stops here: ${e.message}`); }
    else record(false, `section aborted: ${e.message}`, null);
  }
}
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
function sms() { return fs.existsSync(SMS_LOG) ? fs.readFileSync(SMS_LOG, "utf8").trim().split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)) : []; }
async function waitSms(from, pred) { for (let i = 0; i < 80; i++) { const m = sms().slice(from).find(pred); if (m) return m; await new Promise((r) => setTimeout(r, 50)); } return null; }

(async () => {
  await boundary.assertDatabase();
  const pool = new Pool({ connectionString: boundary.manifest().url, ssl: false });
  const q = (sql, args = []) => pool.query(sql, args);
  const one = async (sql, args = []) => (await q(sql, args)).rows[0];
  const nonce = randomUUID().slice(0, 8);
  const numBase = 2000000 + (parseInt(nonce.slice(0, 6), 16) % 7000000);
  const num = (k) => "+1215" + String(numBase + k);
  const session = async (userId, propertyId) => (await staffSessions.issueStaffSession(pool, { userId, propertyId, purpose: "bootstrap_invite" })).session_token;
  const F = { shape: SHAPE };
  const dates = { start: plusDays(30) }; dates.end = plusYear(dates.start);

  // Governed invite + OTP acceptance (the real staff onboarding door).
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
  const captured = (phone, start, guarantor) => ({ application_form_version: "tenant_v3", date_of_birth: "1995-04-12", email: `journey-${nonce}@example.test`, phone,
    address: { line1: "100 Test Street", line2: "", city: "Philadelphia", state: "PA", postal_code: "19147" }, current_since: "2024-01", housing_status: "rent",
    income_status: "employed", employer: "Test Employer", job_title: "Analyst", income_amount: 72000, income_frequency: "annual", income_notes: "",
    desired_move_in: start, move_flexibility: "plus_minus_7", occupants: 1, household_names: "", has_pets: "no", pets: "None",
    guarantor_needed: "yes", guarantor_contact: { name: guarantor.name, phone: guarantor.phone, email: `guarantor-${nonce}@example.test` },
    additional_notes: "", applicant_accuracy_certified: true, electronic_delivery_consent: true });

  try {
    // ── property and staff ───────────────────────────────────────────
    await section("property-and-staff", async () => {
      if (SHAPE === "skyline") {
        F.property = await one("select id, organization_id, name from properties where name in ('Skyline E2E','Property Spine Demo Building') order by created_at desc limit 1");
        need(!!F.property, "Skyline-shaped fixture property exists");
        if (!F.property.organization_id) {
          const org = await one("insert into organizations (name,slug) values ($1,$2) returning id", [`Journey Org ${nonce}`, `journey-org-${nonce}`]);
          await q("update properties set organization_id=$2 where id=$1", [F.property.id, org.id]); F.property.organization_id = org.id;
        }
        await q("update properties set operating_timezone=coalesce(operating_timezone,'America/New_York') where id=$1", [F.property.id]);
        // The fixture's manager is the retained instrument's company signer.
        F.manager = await one("select u.id, u.person_id from users u join property_team_assignments pta on pta.user_id=u.id and pta.property_id=$1 and pta.active and pta.can_manage_roles where u.name='Mike Grivna' and u.is_active=true order by u.created_at limit 1", [F.property.id]);
        need(!!F.manager, "fixture manager (instrument company signer) exists");
        if (!F.manager.person_id) {
          // Fixture identity for the manager, exactly as the CI suite does it, before any action.
          const p = await one("insert into persons (name,source) values ('Journey manager identity','journey_fixture') returning id");
          await q("update users set person_id=$2, account_kind='human_staff' where id=$1", [F.manager.id, p.id]);
          await q("insert into assignments (person_id,property_id,role,provenance) values ($1,$2,'property_manager',$3)", [p.id, F.property.id, JSON.stringify({ source: "journey_fixture" })]);
        }
        // Lines: the fixture property line must be able to send (CI does the same in SQL).
        await q("update communication_lines set outbound_enabled=true, outbound_policy='proactive' where property_id=$1 and line_type='property_facing' and status='active'", [F.property.id]);
        if (!(await one("select 1 from communication_lines where property_id=$1 and line_type='property_facing' and status='active'", [F.property.id]))) {
          await q(`insert into communication_lines (e164,line_type,property_id,authority_ceiling,permitted_audience,inbound_enabled,outbound_enabled,outbound_policy,status) values ('+12155559999','property_facing',$1,'external','residents_and_prospects',true,true,'proactive','active')`, [F.property.id]);
        }
        F.unit = await one("select id, unit_number from units where property_id=$1 and unit_number='3B' limit 1", [F.property.id]);
        F.bedB = await one("select id, space_label from spaces where unit_id=$1 and space_label='Bed B'", [F.unit.id]);
        need(F.unit && F.bedB, "fixture unit 3B with established Bed B exists");
        await q("update spaces set use_type='residential' where unit_id=$1", [F.unit.id]);
        // Fixture SQL before any action: a prior suite run may have executed a lease on this bed;
        // it is retired with the inventory vocabulary (leasing_inventory.js), never deleted.
        await q("update leases set lease_status='cancelled' where property_id=$1 and space_id=$2 and lease_status not in ('cancelled','rescinded','void','superseded','terminated','expired')", [F.property.id, F.bedB.id]);
      } else {
        // Greenery shape: adopted through the governed path proven in
        // docs/handoffs/new-hp/greenery-staff-onboarding. Nothing of Skyline's is copied.
        F.property = await one(`insert into properties (id,name,display_name,address,organization_id,leasing_basis,canonical_key_absent_reason,operating_timezone)
          values ($1,'Greenery','The Greenery (rehearsal)','1325 N 15th (rehearsal)',null,'unknown','predates_canonical_identity_requirement','America/New_York') returning id, organization_id`, [process.env.PROOF_GREENERY_ID]);
        const org = await one("insert into organizations (name,slug) values ($1,$2) returning id", [`Greenery client ${nonce}`, `greenery-client-${nonce}`]);
        const sa = await one(`insert into users (name,phone,email,role,auth_provider,platform_role,is_active,status,account_kind) values ($1,$2,$3,'property_manager','phone_otp','super_admin',true,'active','human_staff') returning id`, [`Platform Admin ${nonce}`, num(90), `sa-${nonce}@example.test`]);
        const anchor = await one("insert into properties (name,organization_id) values ($1,$2) returning id", [`Anchor ${nonce}`, org.id]);
        await q("insert into property_team_assignments (property_id,user_id,role_title,allowed_modules,primary_for_modules,active,can_manage_roles) values ($1,$2,'property_admin','{management,leasing}','{management}',true,true)", [anchor.id, sa.id]);
        const saTok = await session(sa.id, anchor.id);
        const adopt = await api("POST", `/admin/organizations/${org.id}/properties`, { token: saTok, body: { property_id: F.property.id, reason: "journey rehearsal" } });
        need(adopt.status === 200, "the Greenery-shaped property is adopted through the governed door", { status: adopt.status, body: adopt.body });
        F.property.organization_id = org.id;
        const prov = await api("POST", `/admin/organizations/${org.id}/invite`, { token: saTok, body: { name: `Greenery Manager ${nonce}`, phone: num(91), email: `gm-${nonce}@example.test`, property_id: F.property.id, role_key: "property_admin", platform_role: "member" } });
        need(prov.status === 201, "a manager receives the first assignment through the admin door", { status: prov.status, body: prov.body });
        F.manager = { id: prov.body.user.id };
        // Manager identity for offers comes from the governed invite path (person context + assignment).
        const mgrTok0 = await session(F.manager.id, F.property.id);
        await q(`insert into communication_lines (e164,line_type,property_id,authority_ceiling,permitted_audience,inbound_enabled,outbound_enabled,outbound_policy,status) values ($1,'property_facing',$2,'external','residents_and_prospects',true,true,'proactive','active')`, [num(92), F.property.id]);
        observe("configuration: the Greenery text line is a fixture here; its real number and outbound policy are owner and provider inputs");
        const self = await inviteAndAccept({ token: mgrTok0, propertyId: F.property.id, phone: num(91), name: `Greenery Manager ${nonce}`, role_key: "property_admin", person_id: null });
        observe("manager re-invited through the governed door to acquire person identity", { invite: self.invite && self.invite.status, verify: self.verify && self.verify.status });
        F.unit = null; F.bedB = null;
      }
      F.managerTok = await session(F.manager.id, F.property.id);
      // The leasing agent (Mike-shaped) joins through the governed door.
      F.agentPhone = num(1);
      const made = await inviteAndAccept({ token: F.managerTok, propertyId: F.property.id, phone: F.agentPhone, name: `Mike (journey) ${nonce}`, role_key: "leasing_agent" });
      need(made.verify && made.verify.status === 200, "the leasing agent joins through the governed invite and OTP", { invite: made.invite && made.invite.status, delivery: made.delivery, verify: made.verify && made.verify.status, body: made.verify && made.verify.body });
      F.agent = { id: made.verify.body.user.id, tok: made.verify.body.session_token };
      const id = await staffIdentity.resolveStaffIdentity(pool, { user_id: F.agent.id, property_id: F.property.id });
      check(id.state === "resolved", "the agent resolves as staff at the property", { state: id.state });
      const mid = await staffIdentity.resolveStaffIdentity(pool, { user_id: F.manager.id, property_id: F.property.id });
      check(mid.state === "resolved", "the manager resolves as staff at the property", { state: mid.state, basis: mid.basis });
    });
    need(F.agent && F.managerTok, "staff ready");
    const P = F.property.id;

    // ── 1 · website inquiry ─────────────────────────────────────────
    await section("inquiry", async () => {
      F.prospect = { name: `Journey Prospect ${nonce}`, phone: num(2), email: `prospect-${nonce}@example.test` };
      await q("insert into lead_sources (name,source_type) values ($1,'website') on conflict do nothing", ["Website"]);
      const key = `form-${nonce}`;
      F.inquiryMessage = `Can you send me the floor plan for journey ${nonce}?`;
      const body = { property_id: P, name: F.prospect.name, email: F.prospect.email, phone: F.prospect.phone, source: "Website", source_lead_id: `sq-${nonce}`, response_channel: "website", message: F.inquiryMessage, attempt_sms: false, sms_consent: true };
      const first = await api("POST", "/leasing/intake", { headers: { "x-intake-secret": "e2e-intake", "Idempotency-Key": key }, body });
      need(first.status === 200 && first.body.person_id && first.body.lead_id && first.body.conversation_id, "the authenticated website inquiry is captured once", { status: first.status, body: first.body });
      F.person = first.body.person_id; F.lead = first.body.lead_id; F.conversation = first.body.conversation_id;
      const again = await api("POST", "/leasing/intake", { headers: { "x-intake-secret": "e2e-intake", "Idempotency-Key": key }, body });
      check(again.status === 200 && again.body.replayed === true && again.body.person_id === F.person && again.body.lead_id === F.lead && again.body.conversation_id === F.conversation, "a relay redelivery replays the same person, lead and conversation", { replayed: again.body && again.body.replayed });
      const consent = await one("select consent_state from contact_preferences where person_id=$1 and channel='text'", [F.person]);
      check(consent && consent.consent_state === "opted_in", "the form's positive consent is recorded (no consent would leave the prospect untextable)", consent);
      check(sms().filter((m) => m.to === F.prospect.phone).length === 0, "capture sent nothing to the prospect");
    });

    // ── 2 · staff ownership ─────────────────────────────────────────
    await section("ownership", async () => {
      need(F.conversation, "conversation exists");
      const take = await api("POST", `/operator/conversations/${F.conversation}/take-over`, { token: F.agent.tok, body: {} });
      need(take.status === 200, "the agent takes ownership of the inquiry", { status: take.status, body: take.body });
      const detail = await api("GET", `/operator/leasing/conversations/${F.conversation}`, { token: F.agent.tok });
      check(detail.status === 200 && detail.body.human_owner && detail.body.human_owner.user_id === F.agent.id, "the conversation detail names the agent as accountable owner", { owner: detail.body && detail.body.human_owner && detail.body.human_owner.user_id === F.agent.id });
      check(detail.status === 200 && (detail.body.messages || []).some((m) => m.channel === "website" && m.direction === "inbound" && m.body === F.inquiryMessage), "the conversation reads the original website question from communications");
      const inquiry = await api("POST", "/operator/ask-spine/ask", { token: F.agent.tok, body: { question: `Show website inquiries for ${F.prospect.name}.` } });
      check(inquiry.status === 200 && inquiry.body.property_id === P && inquiry.body.grounded_on?.inquiry_read_state === "OK" && typeof inquiry.body.answer === "string" && inquiry.body.answer.includes(F.inquiryMessage), "Ask Spine reads the same original website question through its scoped inquiry read");
      const again = await api("POST", `/operator/conversations/${F.conversation}/take-over`, { token: F.agent.tok, body: {} });
      observe("repeating the take-over by the same owner", { status: again.status });
      const other = await api("POST", `/operator/conversations/${F.conversation}/take-over`, { token: F.managerTok, body: {} });
      check(other.status === 409, "a second staff member cannot take an owned inquiry away silently", { status: other.status });
      const ask = await api("POST", "/operator/ask-spine/ask", { token: F.agent.tok, body: { question: "What needs my attention?" } });
      observe("the agent's personal Ask read after taking ownership", { outcome: ask.body && ask.body.outcome, open_items: ask.body && ask.body.grounded_on && ask.body.grounded_on.personal_open_items });
    });

    // ── 3 · native tour from the conversation ───────────────────────
    await section("tour", async () => {
      need(F.conversation, "conversation exists");
      const starts = new Date(Date.now() + 2 * 86400000), ends = new Date(starts.getTime() + 3600000);
      const slot = await api("POST", "/leasing/availability", { token: F.agent.tok, key: true, body: { property_id: P, starts_at: starts.toISOString(), ends_at: ends.toISOString(), unit_id: F.unit ? F.unit.id : null, leasing_agent_id: F.agent.id, capacity: 1, idempotency_key: `slot-${nonce}` } });
      if (slot.status >= 400) { observe("configuration stop: a native tour slot could not be published for this property", { status: slot.status, body: slot.body }); throw stop("no native tour slot could be published"); }
      const k = `book-${nonce}`;
      const booked = await api("POST", `/operator/leasing/conversations/${F.conversation}/book-tour`, { token: F.agent.tok, body: { slot_id: slot.body.slot.id, idempotency_key: k } });
      need(booked.status === 200 && booked.body.tour_id, "the agent books the prospect onto a native slot from the conversation", { status: booked.status, body: booked.body });
      F.tour = booked.body.tour_id;
      const replay = await api("POST", `/operator/leasing/conversations/${F.conversation}/book-tour`, { token: F.agent.tok, body: { slot_id: slot.body.slot.id, idempotency_key: k } });
      check(replay.status === 200 && replay.body.idempotent && replay.body.tour_id === F.tour, "a repeated booking returns the same tour", { status: replay.status });
      const tour = await one("select lead_id, property_id from leasing_tours where id=$1", [F.tour]);
      check(tour.lead_id === F.lead && tour.property_id === P, "the tour is on the same lead and property");
      check(sms().filter((m) => m.to === F.prospect.phone).length === 0, "booking sent no message");
      const checkin = await api("POST", `/leasing/tours/${F.tour}/check-in`, { key: true, body: { actor_id: F.agent.id } });
      check(checkin.status < 400, "tour check-in", { status: checkin.status });
      const done = await api("POST", `/operator/leasing/tours/${F.tour}/complete`, { token: F.agent.tok, body: { actual_tour_host_user_id: F.agent.id, preferred_unit_id: F.unit ? F.unit.id : undefined, feedback: { standing: "ready_to_apply", notes: "Wants Bed B" }, idempotency_key: `done-${nonce}` } });
      need(done.status === 200, "the agent records the actual outcome as ready to apply", { status: done.status, body: done.body });
      const again = await api("POST", `/operator/leasing/tours/${F.tour}/complete`, { token: F.agent.tok, body: { actual_tour_host_user_id: F.agent.id, feedback: { standing: "ready_to_apply" }, idempotency_key: `done-${nonce}` } });
      check(again.status === 200 && again.body.replayed === true, "re-saving the same outcome replays instead of recording twice", { status: again.status });
      F.conversion = await one("select id, person_id from leasing_conversions where origin_tour_id=$1 and property_id=$2", [F.tour, P]);
      need(F.conversion && F.conversion.person_id === F.person, "the outcome opened the conversion for the same person");
      const followup = await one("select o.assigned_user_id from leasing_conversion_obligations l join obligations o on o.id=l.obligation_id where l.conversion_id=$1 and l.rung='tour_followup' and l.outcome is null", [F.conversion.id]);
      check(followup && followup.assigned_user_id === F.agent.id, "post-tour follow-up is the agent's accountable work");
    });

    // ── 4 · exact available home ────────────────────────────────────
    await section("exact-home", async () => {
      need(F.conversion, "conversion exists");
      const targets = await api("GET", "/operator/leasing/leaseable-units", { token: F.agent.tok });
      need(targets.status === 200, "leaseable targets read");
      const eligible = targets.body.eligible_targets || [];
      if (!F.bedB) {
        need(SHAPE === "greenery" && Array.isArray(targets.body.eligible_targets) && eligible.length === 0, "the deliberately empty Greenery fixture returns no eligible targets", { eligible: eligible.length });
        observe("configuration stop: no established, use-configured position exists in this empty fixture, so nothing is offerable", { eligible: eligible.length });
        throw stop("no established, use-configured position to offer");
      }
      const chosen = eligible.find((t) => t.space_id === F.bedB.id);
      check(!!chosen && chosen.resolution_basis === "chosen_space" && chosen.marketing_state === "marketable_now", "the established vacant bed is offerable as an exact choice", chosen && { marketing_state: chosen.marketing_state, availability_confidence: chosen.availability_confidence });
      // A sibling apartment with an occupied Bed A and a free Bed B, and a home with unknown readiness.
      const c7 = await one("insert into units (property_id,unit_number) values ($1,$2) returning id", [P, `C7-${nonce}`]);
      await q("delete from spaces where unit_id=$1", [c7.id]);
      F.c7 = { id: c7.id };
      F.c7A = await one("insert into spaces (unit_id,space_label,use_type,position_kind) values ($1,'Bed A','residential','bed') returning id", [c7.id]);
      F.c7B = await one("insert into spaces (unit_id,space_label,use_type,position_kind) values ($1,'Bed B','residential','bed') returning id", [c7.id]);
      const baseline = await one("select activation_id, import_batch_id from opening_tenancy_positions where property_id=$1 and status='established' order by as_of_date desc limit 1", [P]);
      const isr = await one("insert into import_source_rows (import_batch_id,row_index,raw,parse_note,produced_unit_id,produced_space_id) values ($1,$2,$3::jsonb,'journey fixture vacancy',$4,$5) returning id", [baseline.import_batch_id, 5000 + (numBase % 4000), JSON.stringify({ unit_number: `C7-${nonce}`, space_label: "Bed B", is_vacant: true }), c7.id, F.c7B.id]);
      await q("insert into proposed_records (activation_id,property_id,module,target_type,natural_key,normalized_json,status,status_reason,import_source_row_id,confirmed_at) values ($1,$2,'leasing','lease',$3,$4::jsonb,'promoted','journey fixture',$5,now())", [baseline.activation_id, P, `C7-${nonce}|Bed B`, JSON.stringify({ section: "current", unit_number: `C7-${nonce}`, space_label: "Bed B", is_vacant: true }), isr.id]);
      await q("insert into leases (property_id,space_id,start_date,end_date,lease_status,rent) values ($1,$2,$3,$4,'active',950)", [P, F.c7A.id, plusDays(-100), plusDays(200)]);
      const d1 = await one("insert into units (property_id,unit_number) values ($1,$2) returning id", [P, `D1-${nonce}`]);
      await q("update spaces set use_type='residential' where unit_id=$1", [d1.id]);
      F.d1s = await one("select id from spaces where unit_id=$1", [d1.id]);
      const isr2 = await one("insert into import_source_rows (import_batch_id,row_index,raw,parse_note,produced_unit_id,produced_space_id) values ($1,$2,$3::jsonb,'journey fixture vacancy',$4,$5) returning id", [baseline.import_batch_id, 5001 + (numBase % 4000), JSON.stringify({ unit_number: `D1-${nonce}`, space_label: "(whole unit)", is_vacant: true }), d1.id, F.d1s.id]);
      await q("insert into proposed_records (activation_id,property_id,module,target_type,natural_key,normalized_json,status,status_reason,import_source_row_id,confirmed_at) values ($1,$2,'leasing','lease',$3,$4::jsonb,'promoted','journey fixture',$5,now())", [baseline.activation_id, P, `D1-${nonce}|(whole unit)`, JSON.stringify({ section: "current", unit_number: `D1-${nonce}`, space_label: "(whole unit)", is_vacant: true }), isr2.id]);
      await q("insert into turnovers (property_id,unit_id,status,ready_date) values ($1,$2,'in_progress',null)", [P, d1.id]);
      const after = await api("GET", "/operator/leasing/leaseable-units", { token: F.agent.tok });
      const el = after.body.eligible_targets || [];
      check(el.some((t) => t.space_id === F.c7B.id) && !el.some((t) => t.space_id === F.c7A.id) && !el.some((t) => t.unit_id === d1.id), "the free sibling is offerable, the leased sibling and the unknown-readiness home are not");
    });

    // ── 5 · authorized offer ────────────────────────────────────────
    const offer = (space, rent, start, key, extra = {}) => api("POST", `/operator/leasing/conversions/${F.conversion.id}/application-offer`, { token: F.managerTok, body: { space_id: space, rent, security_deposit: rent, lease_start_date: start, lease_end_date: plusYear(start), fees: [], concessions: { status: "none" }, idempotency_key: key, ...extra } });
    await section("offer", async () => {
      need(F.bedB, "exact bed exists");
      const byAgent = await api("POST", `/operator/leasing/conversions/${F.conversion.id}/application-offer`, { token: F.agent.tok, body: { space_id: F.bedB.id, rent: 1025, security_deposit: 1025, lease_start_date: dates.start, lease_end_date: dates.end, fees: [], concessions: { status: "none" }, idempotency_key: `agent-${nonce}` } });
      check(byAgent.status === 403, "the leasing agent cannot author terms without pricing authority", { status: byAgent.status, error: byAgent.body && byAgent.body.error });
      const occupied = await offer(F.c7A.id, 950, dates.start, `occ-${nonce}`);
      check(occupied.status === 409 && occupied.body.error === "not_offerable", "an offer on the leased sibling bed refuses", { status: occupied.status, error: occupied.body && occupied.body.error });
      const unknown = await offer(F.d1s.id, 1200, dates.start, `unk-${nonce}`);
      check(unknown.status === 409 && unknown.body.error === "application_ready_date_not_governed", "an offer on a home with no governed ready date refuses truthfully", { status: unknown.status, error: unknown.body && unknown.body.error });
      const ok = await offer(F.bedB.id, 1025, dates.start, `offer-${nonce}`);
      need(ok.status === 200 && ok.body.application_offer_id, "the manager authors a complete offer for the chosen bed", { status: ok.status, body: ok.body });
      F.offer1 = ok.body.application_offer_id;
      const replay = await offer(F.bedB.id, 1025, dates.start, `offer-${nonce}`);
      check(replay.status === 200 && replay.body.idempotent && replay.body.application_offer_id === F.offer1, "an identical retry returns the same offer");
      const conflict = await offer(F.bedB.id, 1030, dates.start, `offer-${nonce}`);
      check(conflict.status === 409, "the same request identity with different terms is refused", { status: conflict.status, error: conflict.body && conflict.body.error });
    });

    // ── 6 · proposal, exact-target refusals, changed offer, send ────
    const proposal = (label, tok = F.agent.tok) => api("POST", "/operator/ask-spine/message", { token: tok, body: { message: `Send ${F.prospect.name} the application for ${label}.` } });
    await section("send", async () => {
      need(F.offer1, "offer exists");
      const namedOccupied = await proposal(`Unit C7-${nonce}, Bed A`);
      const label = namedOccupied.body && namedOccupied.body.target && namedOccupied.body.target.label;
      check(namedOccupied.body.kind !== "application_send_proposal" || /Bed A/.test(String(label)), "naming the occupied sibling bed is refused or clarified, never re-aimed at the free bed", { status: namedOccupied.status, outcome: namedOccupied.body && namedOccupied.body.outcome, proposed: label || null });
      const ambiguous = await proposal(`Unit C7-${nonce}`);
      check(ambiguous.body.kind !== "application_send_proposal", "naming the apartment without the bed asks for clarification", { outcome: ambiguous.body && ambiguous.body.outcome, answer: ambiguous.body && String(ambiguous.body.answer).slice(0, 120) });
      const first = await proposal("Unit 3B, Bed B");
      need(first.status === 200 && first.body.kind === "application_send_proposal" && first.body.confirmation && first.body.confirmation.token, "the agent's request for the chosen bed becomes a server-selected proposal", { status: first.status, outcome: first.body && first.body.outcome, answer: first.body && first.body.answer });
      check(first.body.target && first.body.target.label === "Unit 3B, Bed B" && !JSON.stringify(first.body).includes(F.bedB.id), "the proposal names the exact bed and exposes no identifiers");
      // Pre-invitation correction and stale-confirmation refusal are exercised
      // by draft_offer_correction.e2e.js. Keep this chain's original terms until
      // its post-send revision below, so it proves applicant review separately.
      const wrongActor = await api("POST", "/operator/ask-spine/application-send/confirm", { token: F.managerTok, body: { confirmation: first.body.confirmation.token } });
      check(wrongActor.status === 403 && wrongActor.body.outcome === "confirmation_actor_mismatch", "another staff member cannot redeem the agent's confirmation", { status: wrongActor.status });
      const smsFrom = sms().length;
      const sent = await api("POST", "/operator/ask-spine/application-send/confirm", { token: F.agent.tok, body: { confirmation: first.body.confirmation.token } });
      need(sent.status === 200 && sent.body.sent === true, "the agent's confirmation sends the application", { status: sent.status, body: sent.body });
      const text = await waitSms(smsFrom, (m) => m.to === F.prospect.phone && /\/t\/application\//.test(m.body || ""));
      need(!!text, "the application text reached the fake transport");
      F.appToken = String(text.body).match(/\/t\/application\/([A-Za-z0-9_-]+)/)[1];
      const replay = await api("POST", "/operator/ask-spine/application-send/confirm", { token: F.agent.tok, body: { confirmation: first.body.confirmation.token } });
      check(replay.status === 409 && replay.body.outcome === "confirmation_used", "a repeated confirmation is a used receipt, not a second send");
      // A second staff request for the same applicant after the send: whatever it mints must not become a second link.
      const again = await proposal("Unit 3B, Bed B");
      observe("a second send request after the invitation exists", { status: again.status, kind: again.body && again.body.kind, outcome: again.body && again.body.outcome });
      // The offer changes after the send: the existing link carries the revised terms and the applicant must review.
      const before = sms().length;
      const revised = await offer(F.bedB.id, 1100, dates.start, `revise-${nonce}`, { supersedes_application_offer_id: F.offer1 });
      need(revised.status === 200 && revised.body.applicant_review_required === true, "the manager revises the offer on the existing invitation; applicant review is required", { status: revised.status, body: revised.body });
      F.offer2 = revised.body.application_offer_id;
      check(sms().length === before, "a revision sends no new message");
      if (again.body && again.body.confirmation && again.body.confirmation.token) {
        const stale = await api("POST", "/operator/ask-spine/application-send/confirm", { token: F.agent.tok, body: { confirmation: again.body.confirmation.token } });
        check(stale.status === 409 && stale.body.outcome === "APPLICATION_TERMS_REVIEW_REQUIRED", "a confirmation minted for the old terms is refused after the offer changed", { status: stale.status, outcome: stale.body && stale.body.outcome });
      } else observe("no stale confirmation could be minted after the send; the confirm-time terms guard was not exercised here");
      const branch = await offer(F.bedB.id, 1150, dates.start, `branch-${nonce}`, { supersedes_application_offer_id: F.offer1 });
      check(branch.status === 409, "a second revision of the already-superseded offer is refused", { status: branch.status, error: branch.body && branch.body.error });
      const invs = await one("select count(*)::int n from application_invitations where conversion_id=$1", [F.conversion.id]);
      const texts = sms().filter((m) => m.to === F.prospect.phone && /\/t\/application\//.test(m.body || "")).length;
      check(invs.n === 1 && texts === 1, "one invitation and one message exist", { invitations: invs.n, texts });
      F.invitation = await one("select id, space_id, application_offer_id, person_id from application_invitations where conversion_id=$1", [F.conversion.id]);
      check(F.invitation.space_id === F.bedB.id && F.invitation.application_offer_id === F.offer2 && F.invitation.person_id === F.person, "the invitation carries the exact bed, the current offer and the same person");
    });

    // ── 7 · application ─────────────────────────────────────────────
    await section("application", async () => {
      need(F.appToken, "application link exists");
      const ctx = await api("GET", `/t/application/${F.appToken}/context`);
      need(ctx.status === 200 && ctx.body.application_terms, "the applicant reads server-owned terms");
      check(ctx.body.application_terms.rent === "1100.00" && /Bed B/.test(ctx.body.unit_label || ""), "the applicant sees the current rent and the exact bed", { rent: ctx.body.application_terms.rent, unit_label: ctx.body.unit_label });
      const hash = ctx.body.application_terms.terms_hash;
      F.guarantor = { name: `Journey Guarantor ${nonce}`, phone: num(3) };
      const body = { token: F.appToken, applicant_name: F.prospect.name, captured: captured(F.prospect.phone, dates.start, F.guarantor), application_terms_hash: hash, application_terms_acknowledged: true };
      const oldHash = (await one("select offered_terms_snapshot->>'application_terms_hash' h from lease_offers where id=$1", [F.offer1])).h;
      const staleSubmit = await api("POST", "/applications/submit-public", { body: { ...body, application_terms_hash: oldHash } });
      check(staleSubmit.status === 409 && (staleSubmit.body.code === "APPLICATION_TERMS_REVIEW_REQUIRED" || /acknowledge the current application terms/.test(String(staleSubmit.body.error))), "acknowledging the superseded terms cannot submit", { status: staleSubmit.status, code: staleSubmit.body && staleSubmit.body.code, error: staleSubmit.body && staleSubmit.body.error });
      const submitted = await api("POST", "/applications/submit-public", { body });
      need(submitted.status === 200 && submitted.body.application && submitted.body.application.id, "the prospect submits against the acknowledged terms", { status: submitted.status, body: submitted.body });
      F.app = submitted.body.application.id;
      const again = await api("POST", "/applications/submit-public", { body });
      check(again.status === 200 && again.body.idempotent && again.body.application.id === F.app, "a repeated submission returns the same application");
      const row = await one("select person_id, space_id, application_offer_id, guarantor_name, conversion_id from lease_applications where id=$1", [F.app]);
      check(row.person_id === F.person && row.space_id === F.bedB.id && row.application_offer_id === F.offer2 && row.conversion_id === F.conversion.id && row.guarantor_name === F.guarantor.name, "the application is the same person, conversion, bed and offer, with the named guarantor");
      check((await one("select count(*)::int n from lease_applications where person_id=$1 and property_id=$2", [F.person, P])).n === 1, "exactly one application exists for this person here");
    });

    // ── 8 · approval, terms, packet, signatures, execution ──────────
    await section("lease", async () => {
      need(F.app, "application exists");
      const agentApprove = await api("POST", `/operator/leasing/applications/${F.app}/approve`, { token: F.agent.tok, body: {} });
      check(agentApprove.status === 403, "the agent cannot approve the application they collected", { status: agentApprove.status });
      const other = await one("insert into properties (name,address,organization_id) values ($1,'2 Scope Wall',$2) returning id", [`Journey Other ${nonce}`, F.property.organization_id]);
      await q("insert into property_team_assignments (property_id,user_id,role_title,allowed_modules,primary_for_modules,active,can_manage_roles) values ($1,$2,'property_admin','{management,leasing}','{management}',true,true)", [other.id, F.manager.id]);
      const foreignTok = await session(F.manager.id, other.id);
      const foreignApprove = await api("POST", `/operator/leasing/applications/${F.app}/approve`, { token: foreignTok, body: {} });
      check(foreignApprove.status === 403, "the manager's session at another property cannot approve", { status: foreignApprove.status });
      const approved = await api("POST", `/operator/leasing/applications/${F.app}/approve`, { token: F.managerTok, body: {} });
      need(approved.status < 400, "the manager approves", { status: approved.status, body: approved.body });
      const changed = await api("POST", `/operator/leasing/applications/${F.app}/proposed-terms`, { token: F.managerTok, body: { rent: 1150, security_deposit: 1100, lease_start_date: dates.start, lease_end_date: dates.end, concession_status: "none", idempotency_key: `changed-${nonce}` } });
      check(changed.status === 409, "terms the applicant did not acknowledge cannot be confirmed", { status: changed.status });
      const terms = await api("POST", `/operator/leasing/applications/${F.app}/proposed-terms`, { token: F.managerTok, body: { rent: 1100, security_deposit: 1100, lease_start_date: dates.start, lease_end_date: dates.end, concession_status: "none", idempotency_key: `terms-${nonce}` } });
      need(terms.status < 400, "the acknowledged terms are confirmed", { status: terms.status, body: terms.body });
      const packet = await api("POST", `/operator/leasing/applications/${F.app}/lease-packet`, { token: F.managerTok, body: {} });
      need(packet.status < 400 && packet.body.packet, "the governing lease packet is generated", { status: packet.status, body: packet.body });
      F.packet = packet.body.packet.id;
      const packet2 = await api("POST", `/operator/leasing/applications/${F.app}/lease-packet`, { token: F.managerTok, body: {} });
      observe("generating the packet again", { status: packet2.status, same: packet2.body && packet2.body.packet && packet2.body.packet.id === F.packet });
      const lateChange = await offer(F.bedB.id, 1120, dates.start, `late-${nonce}`, { supersedes_application_offer_id: F.offer2 });
      check(lateChange.status === 409, "a prepared packet blocks a further offer change", { status: lateChange.status });
      const smsFrom = sms().length;
      const issued = await api("POST", `/operator/leasing/lease-packets/${F.packet}/send`, { token: F.managerTok, body: { idempotency_key: `issue-${nonce}` } });
      need(issued.status < 400 && Array.isArray(issued.body.signing_links), "resident and guarantor links are issued", { status: issued.status, body: issued.body });
      const links = Object.fromEntries(issued.body.signing_links.map((l) => [l.signer_role, String(l.url).split("/t/lease/")[1]]));
      need(links.tenant && links.guarantor && links.tenant !== links.guarantor, "separate resident and guarantor secrets");
      const reissue = await api("POST", `/operator/leasing/lease-packets/${F.packet}/send`, { token: F.managerTok, body: { idempotency_key: `issue-${nonce}` } });
      const leaseTexts = sms().slice(smsFrom).filter((m) => /\/t\/lease\//.test(m.body || "")).length;
      check(reissue.status < 400 && (reissue.body.already_issued === true || reissue.body.idempotent), "re-issuing is a replay, not a second package", { status: reissue.status, already_issued: reissue.body && reissue.body.already_issued, lease_texts_after_both: leaseTexts });
      const crossRole = await api("GET", `/t/lease/${links.guarantor}/data`);
      const gFields = ((crossRole.body && crossRole.body.packet && crossRole.body.packet.fields) || []);
      const residentSig = gFields.find((f) => f.signer_role === "tenant" && f.field_type === "signature");
      if (residentSig) {
        const wrong = await api("POST", `/t/lease/${links.guarantor}/fields/${residentSig.id}/complete`, { body: { value: "x", consent: true, session_id: `g-${nonce}` } });
        check(wrong.status >= 400, "the guarantor's token cannot complete the resident's signature", { status: wrong.status });
      }
      const g = await completeSigner({ token: links.guarantor, name: F.guarantor.name, initials: "JG", sessionId: `g-${nonce}` });
      check(g.submit && g.submit.status < 400 && g.fields.every((f) => f.signer_role === "guarantor"), "the guarantor completes only guarantor controls", { status: g.submit && g.submit.status, failed: g.failed });
      const premature = await api("POST", `/operator/leasing/lease-packets/${F.packet}/company-sign`, { token: F.managerTok, body: {} });
      check(premature.status === 409, "the company cannot execute before the resident has signed", { status: premature.status });
      const r = await completeSigner({ token: links.tenant, name: F.prospect.name, initials: "JP", sessionId: `r-${nonce}` });
      check(r.submit && r.submit.status < 400 && r.submit.body.packet && r.submit.body.packet.status === "resident_executed", "the resident completes and the package reads resident executed", { status: r.submit && r.submit.status, packet: r.submit && r.submit.body && r.submit.body.packet && r.submit.body.packet.status });
      const resubmit = await api("POST", `/t/lease/${links.tenant}/submit`, { body: { session_id: `r-${nonce}` } });
      observe("re-submitting the resident signature", { status: resubmit.status, receipt: resubmit.body && (resubmit.body.receipt || resubmit.body.error) });
      const agentSign = await api("POST", `/operator/leasing/lease-packets/${F.packet}/company-sign`, { token: F.agent.tok, body: {} });
      check(agentSign.status === 403, "leasing access is not company signing authority", { status: agentSign.status });
      const executed = await api("POST", `/operator/leasing/lease-packets/${F.packet}/company-sign`, { token: F.managerTok, body: {} });
      need(executed.status < 400 && executed.body.tenancy && executed.body.tenancy.lease_id, "the recorded company signer executes and the tenancy is created", { status: executed.status, body: executed.body });
      F.leaseId = executed.body.tenancy.lease_id;
      const twice = await api("POST", `/operator/leasing/lease-packets/${F.packet}/company-sign`, { token: F.managerTok, body: {} });
      check(twice.status === 409 || (twice.status < 400 && twice.body.tenancy && twice.body.tenancy.lease_id === F.leaseId), "executing again creates no second tenancy", { status: twice.status });
      const lease = await one("select space_id, rent, lease_status, start_date, economic_tenancy_activated_at from leases where id=$1", [F.leaseId]);
      check(lease.space_id === F.bedB.id && Number(lease.rent) === 1100 && ymd(new Date(lease.start_date)) === dates.start, "the tenancy is anchored to the exact bed at the acknowledged rent and dates", { rent: lease.rent, lease_status: lease.lease_status });
      const possession = await one("select count(*)::int n from unit_events where space_id=$1 and event_type='move_in' and status not in ('cancelled','superseded')", [F.bedB.id]);
      check(lease.lease_status === "pending" && lease.economic_tenancy_activated_at === null && possession.n === 0, "execution leaves a pending lease without economic activation or possession", { lease_status: lease.lease_status, economic_tenancy_activated_at: lease.economic_tenancy_activated_at, move_in_events: possession.n });
      check((await one("select count(*)::int n from leases where property_id=$1 and space_id=$2 and lease_status not in ('cancelled','void','superseded')", [P, F.bedB.id])).n === 1, "exactly one lease exists on the bed");
      const targets = await api("GET", "/operator/leasing/leaseable-units", { token: F.agent.tok });
      check(!(targets.body.eligible_targets || []).some((t) => t.space_id === F.bedB.id), "the leased bed leaves the selector");
      const review = await api("GET", `/operator/leasing/application-review?application_id=${F.app}`, { token: F.agent.tok });
      check(review.status === 200 && review.body.application_id === F.app && review.body.applicant?.person_id === F.person && review.body.lease_id === F.leaseId && review.body.space?.space_id === F.bedB.id && review.body.packet?.id === F.packet, "Application Review reads the same application, person, exact bed, packet and tenancy", { status: review.status });
      const card = await api("GET", `/operator/leasing/person-card?person_id=${F.person}`, { token: F.agent.tok });
      check(card.status === 200 && card.body.person?.id === F.person && card.body.leasing_standing?.tenancy?.lease_id === F.leaseId && card.body.leasing_standing.tenancy.space_id === F.bedB.id && card.body.leasing_standing.tenancy.state === "pending", "the Person Card reads the same pending tenancy on the exact bed", { status: card.status });
      const askSign = await api("POST", "/operator/ask-spine/message", { token: F.agent.tok, body: { message: `Has ${F.prospect.name}'s application link been sent?` } });
      observe("Ask Spine read of the same person after execution", { outcome: askSign.body && askSign.body.outcome, stage: askSign.body && askSign.body.grounded_on && askSign.body.grounded_on.leasing_opportunity_stage });
    });

    // ── 9 · removed authority ───────────────────────────────────────
    await section("removed-authority", async () => {
      need(F.agent, "agent exists");
      const asg = await one("select id from property_team_assignments where user_id=$1 and property_id=$2 and active", [F.agent.id, P]);
      const off = await api("PATCH", `/property-team-assignments/${asg.id}`, { token: F.managerTok, body: { active: false } });
      need(off.status < 400, "the manager removes the agent's access through the governed door", { status: off.status, body: off.body });
      const read = await api("GET", "/operator/leasing/leaseable-units", { token: F.agent.tok });
      check(read.status === 401 || read.status === 403, "the agent's live session loses access immediately", { status: read.status });
      const prop = await proposal("Unit 3B, Bed B");
      check(prop.status === 401 || prop.status === 403, "a removed agent cannot propose a send", { status: prop.status });
      const on = await api("PATCH", `/property-team-assignments/${asg.id}`, { token: F.managerTok, body: { active: true } });
      observe("access restored through the same door", { status: on.status });
    });
  } finally { await pool.end(); }
  current = "completion";
  if (SHAPE === "skyline") check(stopped === null && !!F.leaseId, "Skyline completes the chain with an executed lease and no configuration stop", { stopped_at: stopped, lease_created: !!F.leaseId });
  else check(stopped?.section === "exact-home" && !!F.conversion && !F.leaseId, "the deliberately empty Greenery fixture reaches its exact-home boundary after the tour outcome", { stopped_at: stopped });
  const summary = { shape: SHAPE, stopped_at: stopped, passed: results.filter((r) => r.ok && r.kind === "check").length, failed, observations: results.filter((r) => r.kind === "observe").length };
  if (process.env.PROOF_OUTPUT_DIR) fs.writeFileSync(path.join(process.env.PROOF_OUTPUT_DIR, `staff_assisted_journey.${process.env.PROOF_EVIDENCE_LABEL || SHAPE}.json`), JSON.stringify({ server: process.env.PROOF_SERVER_SHA || null, summary, results }, null, 2));
  console.log(`\nstaff-assisted journey (${SHAPE}): ${summary.passed} passed, ${failed} failed, ${summary.observations} observations${stopped ? `; chain stopped at ${stopped.section}: ${stopped.reason}` : "; chain complete"}`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
