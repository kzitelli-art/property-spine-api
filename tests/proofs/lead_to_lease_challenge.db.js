"use strict";
// Class 3 · lead-to-lease challenge harness.
//
// Owned nonce-verified database, owned HTTP server (E2E_API_BASE), fake SMS
// transport (E2E_SMS_LOG), scripted model for the prospect agent. No provider,
// no browser, no production data. Everything it creates is synthetic and lives
// only in the disposable database the proof boundary verified.
//
// It walks one prospect from inquiry to an executed bed lease and, at each
// door, presses the things a real leasing week presses:
//   · wrong-property access (server-derived scope, foreign sessions)
//   · an occupied sibling bed in the same apartment
//   · a sibling turn plan that must not lend its expected date to a free bed
//   · changed prices after an offer, at acceptance and after acceptance
//   · uncertain readiness: expected turn date, a slipped date, a lease that
//     was extended, a notice that is not a move-out, a turn with tasks and
//     deadlines but no governed ready date
//   · representative Matterports / floor plans mistaken for an exact home
//
// Sections are independent: a failed assertion is recorded and the next
// section still runs, so one run reports the whole matrix for the tree under
// test. Exit status is non-zero when any assertion failed. Requires the
// Skyline-shaped disposable fixture (tests/e2e/property_fixture.sql +
// instrument_fixture.js) because the server allowlists that property.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const boundary = require("../e2e/proof_boundary");
require("../e2e/proof_fence_preload");
const { Pool } = require("pg");
const staffSessions = require("../../src/identity/staff_session_service");
const knowledge = require("../../src/leasing/leasing_knowledge");
const { LADDER } = require("../../src/leasing/followup_ladder");

const BASE = process.env.E2E_API_BASE;
const SMS_LOG = process.env.E2E_SMS_LOG;
assert.ok(BASE, "E2E_API_BASE (owned HTTP server) is required");
assert.ok(SMS_LOG, "E2E_SMS_LOG (fake transport log) is required");

const results = [];
let failed = 0;
function record(ok, section, label, detail) {
  results.push({ section, label, ok, detail: detail === undefined ? null : detail });
  if (!ok) failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  [${section}] ${label}${detail !== undefined ? " | " + JSON.stringify(detail) : ""}`);
}
let current = "setup";
function check(cond, label, detail) { record(!!cond, current, label, detail); return !!cond; }
function need(cond, label, detail) { record(!!cond, current, label, detail); if (!cond) throw new Error(`need: ${label}`); }
async function section(name, fn) {
  current = name;
  console.log(`\n== ${name} ==`);
  try { await fn(); }
  catch (e) { record(false, name, `section aborted: ${e.message}`, null); }
}
const ymd = (d) => d.toISOString().slice(0, 10);
const plusDays = (n) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + n); return ymd(d); };
const plusYear = (start) => { const d = new Date(start + "T00:00:00Z"); d.setUTCFullYear(d.getUTCFullYear() + 1); d.setUTCDate(d.getUTCDate() - 1); return ymd(d); };
async function api(method, route, { token, key = false, body, query } = {}) {
  const headers = { "content-type": "application/json" };
  if (token) headers["x-staff-session"] = token;
  if (key) headers["x-operator-key"] = "e2e-key";
  const url = BASE + route + (query ? "?" + new URLSearchParams(query).toString() : "");
  const r = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await r.json().catch(() => null);
  return { status: r.status, body: data };
}
function sms() {
  if (!fs.existsSync(SMS_LOG)) return [];
  return fs.readFileSync(SMS_LOG, "utf8").trim().split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
}
async function waitSms(from, pred) {
  for (let i = 0; i < 60; i++) {
    const m = sms().slice(from).find(pred);
    if (m) return m;
    await new Promise((r) => setTimeout(r, 50));
  }
  return null;
}

(async () => {
  await boundary.assertDatabase();
  const pool = new Pool({ connectionString: boundary.manifest().url, ssl: false });
  const q = (sql, args = []) => pool.query(sql, args);
  const one = async (sql, args = []) => (await q(sql, args)).rows[0];
  const nonce = randomUUID().slice(0, 8);
  const suffix = String(Date.now()).slice(-7);
  const dates = { start: plusDays(30) }; dates.end = plusYear(dates.start);
  const F = {};
  try {
    await section("fixture", async () => {
      F.property = await one(
        `select id, organization_id, name from properties
          where name in ('Skyline E2E','Property Spine Demo Building') order by created_at desc limit 1`);
      need(!!F.property, "Skyline-shaped disposable fixture property exists");
      const P = F.property.id;
      if (!F.property.organization_id) {
        const org = await one(`insert into organizations (name,slug) values ('Challenge Org','challenge-org-${nonce}') returning id`);
        await q("update properties set organization_id=$2 where id=$1", [P, org.id]);
        F.property.organization_id = org.id;
      }
      F.baseline = await one(`select otp.id, otp.activation_id, otp.import_batch_id from opening_tenancy_positions otp
        where otp.property_id=$1 and otp.status='established' order by otp.as_of_date desc limit 1`, [P]);
      need(!!F.baseline, "an established opening position exists to carry vacancy claims");
      F.other = await one(`insert into properties (name,address,organization_id) values ($1,'2 Scope Wall',$2) returning id`,
        [`Challenge Scope ${nonce}`, F.property.organization_id]);
      // units: C7 (Bed A occupied, Bed B free), W1 whole unit turning with an
      // expected date, N1 on notice with no turn plan, D1 turn with tasks and
      // deadlines but no ready date.
      async function unit(number) {
        const u = await one("insert into units (property_id,unit_number) values ($1,$2) returning id", [P, number]);
        await q("delete from spaces where unit_id=$1", [u.id]);
        return u;
      }
      async function space(u, label, kind) {
        return one("insert into spaces (unit_id,space_label,use_type,position_kind) values ($1,$2,'residential',$3) returning id,space_label", [u.id, label, kind]);
      }
      let rowIndex = 1000 + Math.floor(Math.random() * 100000);
      async function vacancyClaim(u, s, number, label) {
        const isr = await one(`insert into import_source_rows (import_batch_id,row_index,raw,parse_note,produced_unit_id,produced_space_id)
          values ($1,$2,$3::jsonb,'challenge fixture: confirmed vacancy',$4,$5) returning id`,
          [F.baseline.import_batch_id, rowIndex++, JSON.stringify({ unit_number: number, space_label: label, is_vacant: true }), u.id, s.id]);
        await q(`insert into proposed_records (activation_id,property_id,module,target_type,natural_key,normalized_json,status,status_reason,import_source_row_id,confirmed_at)
          values ($1,$2,'leasing','lease',$3,$4::jsonb,'promoted','challenge fixture: confirmed vacant position',$5,now())`,
          [F.baseline.activation_id, P, `${number}|${label}`, JSON.stringify({ section: "current", unit_number: number, space_label: label, is_vacant: true }), isr.id]);
      }
      F.c7 = await unit(`C7-${nonce}`);
      F.bedA = await space(F.c7, "Bed A", "bed");
      F.bedB = await space(F.c7, "Bed B", "bed");
      await vacancyClaim(F.c7, F.bedB, `C7-${nonce}`, "Bed B");
      F.leaseA = await one(`insert into leases (property_id,space_id,start_date,end_date,lease_status,rent) values ($1,$2,$3,$4,'active',950) returning id`,
        [P, F.bedA.id, plusDays(-100), plusDays(200)]);
      F.w1 = await unit(`W1-${nonce}`);
      F.w1s = await space(F.w1, "(whole unit)", "unit");
      F.leaseW = await one(`insert into leases (property_id,space_id,start_date,end_date,lease_status,rent) values ($1,$2,$3,$4,'active',1400) returning id`,
        [P, F.w1s.id, plusDays(-300), plusDays(-5)]);
      F.turnW = await one(`insert into turnovers (property_id,unit_id,outgoing_lease_id,status,ready_date) values ($1,$2,$3,'in_progress',$4) returning id`,
        [P, F.w1.id, F.leaseW.id, plusDays(25)]);
      F.n1 = await unit(`N1-${nonce}`);
      F.n1s = await space(F.n1, "(whole unit)", "unit");
      F.leaseN = await one(`insert into leases (property_id,space_id,start_date,end_date,lease_status,rent) values ($1,$2,$3,$4,'active',1300) returning id`,
        [P, F.n1s.id, plusDays(-200), plusDays(90)]);
      await q(`insert into unit_events (unit_id,property_id,event_type,effective_date,payload,source,status,lease_id,space_id)
        values ($1,$2,'notice_given',$3,'{"note":"challenge fixture notice"}'::jsonb,'challenge_fixture','scheduled',$4,$5)`,
        [F.n1.id, P, plusDays(40), F.leaseN.id, F.n1s.id]);
      F.d1 = await unit(`D1-${nonce}`);
      F.d1s = await space(F.d1, "(whole unit)", "unit");
      await vacancyClaim(F.d1, F.d1s, `D1-${nonce}`, "(whole unit)");
      await q(`insert into turnovers (property_id,unit_id,status,ready_date,needs) values ($1,$2,'in_progress',null,$3::text[])`,
        [P, F.d1.id, [`paint (due ${plusDays(10)})`, `clean (due ${plusDays(12)})`]]);
      // staff: an agent (leasing only) and a manager (can_manage_roles), each
      // with a resolved staff identity; the company signer is the fixture's
      // instrument signer and is only used to execute the lease.
      async function staff(name, role, modules, manage) {
        const person = await one("insert into persons (name,source) values ($1,'challenge_fixture') returning id", [name]);
        const user = await one(`insert into users (name,role,is_active,status,account_kind,person_id) values ($1,$2,true,'active','human_staff',$3) returning id`, [name, role, person.id]);
        for (const prop of [P, F.other.id]) {
          await q(`insert into property_team_assignments (user_id,property_id,role_title,allowed_modules,primary_for_modules,active,can_manage_roles)
            values ($1,$2,$3,$4,$4,true,$5)`, [user.id, prop, role, modules, manage]);
          await q(`insert into assignments (person_id,property_id,role,provenance) values ($1,$2,$3,$4)`,
            [person.id, prop, manage ? "property_manager" : "leasing", JSON.stringify({ source: "challenge_fixture", user_id: user.id })]);
        }
        const tokens = {};
        for (const [k, prop] of [["p", P], ["o", F.other.id]]) {
          const issued = await staffSessions.issueStaffSession(pool, { userId: user.id, propertyId: prop, purpose: "bootstrap_invite" });
          tokens[k] = issued.session_token || issued.token;
        }
        return { id: user.id, person_id: person.id, tokens };
      }
      F.agent = await staff(`Challenge Agent ${nonce}`, "leasing_agent", "{leasing}", false);
      F.manager = await staff(`Challenge Manager ${nonce}`, "property_manager", "{leasing,management}", true);
      const signerCfg = await one("select lease_config->'execution_authority'->'company_signer_user_ids' as ids from properties where id=$1", [P]);
      const signerId = signerCfg && Array.isArray(signerCfg.ids) ? signerCfg.ids[0] : null;
      need(!!signerId, "fixture governing instrument names a company signer");
      const issued = await staffSessions.issueStaffSession(pool, { userId: signerId, propertyId: P, purpose: "bootstrap_invite" });
      F.signer = { id: signerId, token: issued.session_token || issued.token };
      await q(`update communication_lines set status='retired', outbound_enabled=false, outbound_policy='disabled' where property_id=$1 and line_type='property_facing' and status='active' and e164<>'+12155559999'`, [P]);
      const line = await one("select id from communication_lines where property_id=$1 and line_type='property_facing' and status='active' limit 1", [P]);
      if (!line) await q(`insert into communication_lines (e164,line_type,property_id,authority_ceiling,permitted_audience,inbound_enabled,outbound_enabled,outbound_policy,status)
        values ('+12155559999','property_facing',$1,'external','residents_and_prospects',true,true,'proactive','active')`, [P]);
      check(true, "synthetic fixture created in the owned database only");
    });
    if (!F.property || !F.signer) throw new Error("fixture section failed; nothing else can be exercised");
    const P = F.property.id;

    // ── inquiry ──────────────────────────────────────────────────────
    async function prospect(tag) {
      const name = `Challenge ${tag} ${suffix}`;
      const phone = "+1215" + String(Math.floor(1000000 + Math.random() * 8999999));
      const intake = await api("POST", "/leasing/intake", { body: {
        intake_secret: "e2e-intake", property_id: P, name, phone, email: `challenge-${tag}-${suffix}@example.com`, source: "challenge", attempt_sms: false } });
      need(intake.status < 400 && intake.body && intake.body.person_id && intake.body.lead_id, `${tag}: inquiry enters through the canonical intake door`, { status: intake.status });
      await q(`insert into contact_preferences (person_id,channel,consent_state,source,updated_at) values ($1,'text','opted_in','internal_qa_enrollment',now())
        on conflict (person_id,channel) do update set consent_state='opted_in',source='internal_qa_enrollment',updated_at=now()`, [intake.body.person_id]);
      return { name, phone, person_id: intake.body.person_id, lead_id: intake.body.lead_id };
    }
    async function tourAndCapture(pr, unitId, note) {
      const starts = new Date(Date.now() + 2 * 86400000), ends = new Date(starts.getTime() + 3600000);
      const opened = await api("POST", "/leasing/availability", { token: F.agent.tokens.p, key: true, body: {
        property_id: P, starts_at: starts.toISOString(), ends_at: ends.toISOString(), unit_id: unitId, leasing_agent_id: F.agent.id, capacity: 1, idempotency_key: `slot-${pr.name}` } });
      need(opened.status < 400 && opened.body.slot && opened.body.slot.id, `${pr.name}: native tour slot published`, { status: opened.status, body: opened.body });
      const booked = await api("POST", `/leasing/slots/${opened.body.slot.id}/book`, { token: F.agent.tokens.p, key: true, body: { lead_id: pr.lead_id, idempotency_key: `book-${pr.name}` } });
      need(booked.status < 400 && booked.body.tour_id, `${pr.name}: prospect booked onto the exact slot`, { status: booked.status, body: booked.body });
      const checkin = await api("POST", `/leasing/tours/${booked.body.tour_id}/check-in`, { key: true, body: { actor_id: F.agent.id } });
      need(checkin.status < 400, `${pr.name}: tour check-in`, { status: checkin.status });
      const done = await api("POST", `/leasing/tours/${booked.body.tour_id}/complete`, { token: F.agent.tokens.p, key: true, body: {
        actor_id: F.agent.id, actual_tour_host_user_id: F.agent.id, preferred_unit_id: unitId, units_shown: [unitId],
        feedback: { standing: "ready_to_apply", notes: note }, idempotency_key: `complete-${pr.name}` } });
      need(done.status < 400, `${pr.name}: tour outcome captured as ready to apply`, { status: done.status, body: done.body });
      const conv = await one("select id, tour_outcome from leasing_conversions where origin_tour_id=$1 and property_id=$2", [booked.body.tour_id, P]);
      need(!!conv, `${pr.name}: the captured tour opened the canonical conversion`);
      return { tour_id: booked.body.tour_id, conversion_id: conv.id, tour_outcome: conv.tour_outcome };
    }
    async function offer(token, conversionId, spaceId, rent, start, key, extra = {}) {
      return api("POST", `/operator/leasing/conversions/${conversionId}/application-offer`, { token, body: {
        space_id: spaceId, rent, security_deposit: rent, lease_start_date: start, lease_end_date: plusYear(start),
        fees: [], concessions: { status: "none" }, idempotency_key: key, ...extra } });
    }
    async function proposal(token, name, label) {
      return api("POST", "/operator/ask-spine/message", { token, body: { message: `Send ${name} the application for ${label}.` } });
    }
    function captured(pr, start) {
      return { application_form_version: "tenant_v3", date_of_birth: "1995-04-12", email: `challenge-${suffix}@example.com`, phone: pr.phone,
        address: { line1: "100 Test Street", line2: "", city: "Philadelphia", state: "PA", postal_code: "19147" }, current_since: "2024-01", housing_status: "rent",
        income_status: "employed", employer: "Test Employer", job_title: "Analyst", income_amount: 72000, income_frequency: "annual", income_notes: "",
        desired_move_in: start, move_flexibility: "plus_minus_7", occupants: 1, household_names: "", has_pets: "no", pets: "None", guarantor_needed: "no",
        additional_notes: "", applicant_accuracy_certified: true, electronic_delivery_consent: true };
    }
    async function sendViaAskSpine(pr, label) {
      const smsFrom = sms().length;
      const prop = await proposal(F.agent.tokens.p, pr.name, label);
      need(prop.status === 200 && prop.body.kind === "application_send_proposal" && prop.body.confirmation && prop.body.confirmation.token,
        `${pr.name}: Ask Spine proposes the send for ${label} and asks for confirmation`, { status: prop.status, outcome: prop.body && prop.body.outcome, answer: prop.body && prop.body.answer });
      const confirmation = prop.body.confirmation.token;
      const wrongProperty = await api("POST", "/operator/ask-spine/application-send/confirm", { token: F.agent.tokens.o, body: { confirmation } });
      check(wrongProperty.status === 403 && wrongProperty.body.outcome === "confirmation_property_mismatch",
        "the same agent's session at another property cannot redeem the confirmation", { status: wrongProperty.status, outcome: wrongProperty.body && wrongProperty.body.outcome });
      const wrongActor = await api("POST", "/operator/ask-spine/application-send/confirm", { token: F.manager.tokens.p, body: { confirmation } });
      check(wrongActor.status === 403 && wrongActor.body.outcome === "confirmation_actor_mismatch",
        "another staff member cannot redeem the agent's confirmation", { status: wrongActor.status, outcome: wrongActor.body && wrongActor.body.outcome });
      const sent = await api("POST", "/operator/ask-spine/application-send/confirm", { token: F.agent.tokens.p, body: { confirmation } });
      need(sent.status === 200 && sent.body.sent === true, `${pr.name}: the agent's own confirmation sends the application`, { status: sent.status, body: sent.body });
      const text = await waitSms(smsFrom, (m) => m.to === pr.phone && /\/t\/application\//.test(m.body || ""));
      need(!!text, `${pr.name}: the application text reached the fake transport only`);
      const token = String(text.body).match(/\/t\/application\/([A-Za-z0-9_-]+)/)[1];
      const inv = await one("select id,unit_id,space_id,status,intended_move_in,application_offer_id from application_invitations where conversion_id=$1 order by created_at desc limit 1", [await one("select conversion_id from application_invitations where person_id=$1 and property_id=$2 order by created_at desc limit 1", [pr.person_id, P]).then((r) => r.conversion_id)]);
      return { token, invitation: inv, proposal: prop.body };
    }

    // ── A. inquiry ───────────────────────────────────────────────────
    await section("inquiry", async () => { F.p1 = await prospect("One"); });

    // ── B. matching (service, scripted model) ────────────────────────
    await section("matching", async () => {
      const mp = await one("insert into properties (name) values ($1) returning id", [`Challenge matching ${nonce}`]);
      const mk = async (n) => one("insert into units (property_id,unit_number,bedrooms,occupancy_status) values ($1,$2,1,'vacant') returning id,unit_number", [mp.id, n]);
      const c7 = await mk("C7"), w1 = await mk("W1");
      const bedOffers = [{ ...c7, space_id: randomUUID(), space_label: "Bed A", selection_eligible: true }, { ...c7, space_id: randomUUID(), space_label: "Bed B", selection_eligible: true }, w1];
      const model = { messages: { create: async () => ({ id: "scripted", content: [{ type: "text", text: "Please clarify your preferred home." }] }) } };
      const agent = require("../../src/agent/agent")({ pool, anthropic: model })._service;
      const cases = [
        ["I saw the Matterport of C7, I'll take C7", null, bedOffers, "a unit label backed by a representative Matterport does not pick a bed"],
        ["not C7, the other one", null, bedOffers, "a negation is not a choice"],
        ["C7 or W1?", null, bedOffers, "a question is not a choice"],
        ["I'll take W1", w1.id, [w1], "an explicit single-position choice is recorded"],
        ["W1 please", "observe", [w1], "observation: a polite bare label outside the explicit grammar"],
        ["yes", w1.id, [w1], "a bare affirmative to one whole-unit offer is recorded"],
        ["yes", null, bedOffers, "a bare affirmative cannot choose among beds"],
        ["is W1 still available", null, [w1], "an availability question is not a choice"],
      ];
      for (const [body, expected, offered, label] of cases) {
        const person = await one("insert into persons (name) values ('Challenge matching prospect') returning id");
        const lead = await one("insert into leasing_leads (property_id,person_id) values ($1,$2) returning id", [mp.id, person.id]);
        const conv = await one("insert into conversations (property_id,person_id,channel_primary,status) values ($1,$2,'sms','open') returning id", [mp.id, person.id]);
        const inbound = await one("insert into comm_events (property_id,person_id,conversation_id,channel,direction,body) values ($1,$2,$3,'sms','inbound','What homes?') returning id", [mp.id, person.id, conv.id]);
        const outbound = await one("insert into comm_events (property_id,person_id,conversation_id,channel,direction,body) values ($1,$2,$3,'sms','outbound','Historical fixture: homes offered') returning id", [mp.id, person.id, conv.id]);
        const run = await one(`insert into agent_runs (conversation_id,inbound_comm_event_id,input_thread_version,generation_no,generation_reason,status,prompt_revision,policy_revision,model,offered_units_json)
          values ($1,$2,0,1,'initial_inbound','ready','fixture','fixture','scripted',$3) returning id`, [conv.id, inbound.id, JSON.stringify(offered)]);
        await q("insert into agent_drafts (agent_run_id,generated_body,status,dispatched_comm_event_id,dispatched_at) values ($1,'Historical fixture','dispatched',$2,now())", [run.id, outbound.id]);
        const response = await agent.processInbound({ property_id: mp.id, person_id: person.id, body });
        const selected = await one("select unit_id from leasing_leads where id=$1", [lead.id]);
        check(response.status === 200 && (expected === "observe" || selected.unit_id === expected), `${label} (${JSON.stringify(body)})`,
          { attached: selected.unit_id ? (selected.unit_id === c7.id ? "C7" : selected.unit_id === w1.id ? "W1" : "other") : null, expected: expected === "observe" ? "recorded only" : expected ? (expected === w1.id ? "W1" : "C7") : null });
      }
      check(true, "matching is a scripted-model service proof: the model reply text is not under test, only the durable unit attachment");
    });

    // ── C. availability and siblings ─────────────────────────────────
    async function canonical() {
      const r = await api("GET", "/operator/leasing/availability-canonical", { token: F.agent.tokens.p, query: { as_of: plusDays(0) } });
      need(r.status === 200 && Array.isArray(r.body.rows), "staff availability read answers", { status: r.status });
      return r.body.rows;
    }
    const pick = (rows, spaceId) => rows.find((r) => r.space_id === spaceId) || null;
    await section("availability-and-siblings", async () => {
      let rows = await canonical();
      const a = pick(rows, F.bedA.id), b = pick(rows, F.bedB.id), w = pick(rows, F.w1s.id), n = pick(rows, F.n1s.id), d = pick(rows, F.d1s.id);
      check(a && a.marketing_state !== "marketable_now", "the leased sibling bed is not marketable", a && { marketing_state: a.marketing_state });
      check(b && b.marketing_state === "marketable_now" && b.availability_confidence === "confirmed", "the free bed beside a leased sibling is marketable now", b && { marketing_state: b.marketing_state, available_from: b.available_from, availability_confidence: b.availability_confidence });
      check(w && w.availability_confidence === "expected" && w.available_from === plusDays(25) && w.physical_readiness !== "ready", "a whole unit turning with a ready date is expected, not confirmed", w && { marketing_state: w.marketing_state, available_from: w.available_from, availability_confidence: w.availability_confidence, physical_readiness: w.physical_readiness });
      check(n && n.availability_confidence !== "confirmed" && n.physical_readiness !== "ready", "a notice is not a move-out and not readiness", n && { marketing_state: n.marketing_state, available_from: n.available_from, availability_confidence: n.availability_confidence, notice: n.notice_state || null });
      check(d && d.available_from === null && d.availability_confidence !== "confirmed", "turn tasks with deadlines are not a governed ready date", d && { marketing_state: d.marketing_state, available_from: d.available_from, availability_confidence: d.availability_confidence, blocking_fact: d.blocking_fact });
      const targets = await api("GET", "/operator/leasing/leaseable-units", { token: F.agent.tokens.p });
      need(targets.status === 200, "leaseable targets read answers");
      const eligible = targets.body.eligible_targets || [];
      check(eligible.some((t) => t.space_id === F.bedB.id && t.resolution_basis === "chosen_space"), "the selector offers the free bed as an exact choice");
      check(!eligible.some((t) => t.space_id === F.bedA.id), "the selector never offers the leased sibling bed");
      check(!eligible.some((t) => t.unit_id === F.d1.id), "the selector never offers a turn without a governed ready date");
      // sibling expected-date inheritance: Bed A's turn plan must not lend
      // its date to Bed B, and must not block an application for Bed B.
      await q("update leases set end_date=$2 where id=$1", [F.leaseA.id, plusDays(-5)]);
      const turn = await one("insert into turnovers (property_id,unit_id,outgoing_lease_id,status,ready_date) values ($1,$2,$3,'in_progress',$4) returning id", [P, F.c7.id, F.leaseA.id, plusDays(45)]);
      try {
        rows = await canonical();
        const a2 = pick(rows, F.bedA.id), b2 = pick(rows, F.bedB.id);
        check(a2 && a2.available_from === plusDays(45) && a2.availability_confidence === "expected", "the outgoing bed carries its own expected date", a2 && { available_from: a2.available_from, availability_confidence: a2.availability_confidence });
        check(b2 && b2.marketing_state === "marketable_now" && b2.availability_confidence === "confirmed" && b2.turnover == null, "the free sibling bed does not inherit the outgoing bed's expected date", b2 && { marketing_state: b2.marketing_state, available_from: b2.available_from, availability_confidence: b2.availability_confidence, turnover: b2.turnover });
        const probe = await api("GET", "/operator/leasing/leaseable-units", { token: F.agent.tokens.p });
        const pb = (probe.body.eligible_targets || []).find((t) => t.space_id === F.bedB.id);
        check(pb && pb.marketing_state === "marketable_now" && pb.available_from === plusDays(0), "the selector still offers the free bed today under the sibling's turn plan", pb && { marketing_state: pb.marketing_state, available_from: pb.available_from, availability_confidence: pb.availability_confidence });
      } finally {
        await q("delete from turnovers where id=$1", [turn.id]);
        await q("update leases set end_date=$2 where id=$1", [F.leaseA.id, plusDays(200)]);
      }
    });

    // ── D. explicit choice and tour ──────────────────────────────────
    await section("tour-and-choice", async () => {
      F.j1 = await tourAndCapture(F.p1, F.c7.id, "Wants Bed B");
      check(F.j1.tour_outcome === "ready_to_apply", "the agent's ready-to-apply standing is the recorded truth", { tour_outcome: F.j1.tour_outcome });
      const shown = await one("select count(*)::int n from tour_units_shown where tour_id=$1 and unit_id=$2", [F.j1.tour_id, F.c7.id]);
      check(shown.n === 1, "the toured apartment is recorded at unit grain");
      const lead = await one("select unit_id from leasing_leads where id=$1", [F.p1.lead_id]);
      check(true, "observation: the tour records no bed-grain choice; the exact bed enters only with the offer and invitation", { lead_unit_attached: lead.unit_id === F.c7.id, bed_grain_tour_record: false });
    });

    // ── E. offers under occupancy and readiness ──────────────────────
    await section("offers-readiness", async () => {
      need(F.j1, "journey conversion exists");
      const occupied = await offer(F.manager.tokens.p, F.j1.conversion_id, F.bedA.id, 950, dates.start, `occupied-${nonce}`);
      check(occupied.status === 409 && occupied.body.error === "not_offerable", "an offer cannot be prepared for the leased sibling bed", { status: occupied.status, error: occupied.body && occupied.body.error });
      const early = await offer(F.manager.tokens.p, F.j1.conversion_id, F.w1s.id, 1400, plusDays(24), `early-${nonce}`);
      check(early.status === 409 && early.body.error === "application_move_in_before_expected_ready", "a start before the expected turn date refuses", { status: early.status, error: early.body && early.body.error });
      const notice = await offer(F.manager.tokens.p, F.j1.conversion_id, F.n1s.id, 1300, plusDays(40), `notice-${nonce}`);
      check(notice.status === 409, "a notice date is not a move-out: an offer on the notice date refuses", { status: notice.status, error: notice.body && notice.body.error });
      const tasks = await offer(F.manager.tokens.p, F.j1.conversion_id, F.d1s.id, 1200, dates.start, `tasks-${nonce}`);
      check(tasks.status === 409 && tasks.body.error === "application_ready_date_not_governed", "task deadlines on a turn are not a governed ready date", { status: tasks.status, error: tasks.body && tasks.body.error });
      const agentOffer = await offer(F.agent.tokens.p, F.j1.conversion_id, F.bedB.id, 1025, dates.start, `agent-${nonce}`);
      check(agentOffer.status === 403, "a leasing agent without pricing authority cannot author terms", { status: agentOffer.status, error: agentOffer.body && agentOffer.body.error });
      const ok = await offer(F.manager.tokens.p, F.j1.conversion_id, F.bedB.id, 1025, dates.start, `bedb-${nonce}`);
      need(ok.status === 200 && ok.body.application_offer_id, "a complete offer for the free bed is retained", { status: ok.status, body: ok.body });
      F.offerB = ok.body.application_offer_id;
      const expected = await offer(F.manager.tokens.p, F.j1.conversion_id, F.w1s.id, 1400, plusDays(25), `expected-${nonce}`);
      check(expected.status === 200, "observation: an offer may be prepared on an EXPECTED (not confirmed) ready date; readiness confidence is not carried to the applicant", { status: expected.status, error: expected.body && expected.body.error });
    });

    // ── F. wrong-property access ─────────────────────────────────────
    await section("wrong-property", async () => {
      need(F.j1, "journey conversion exists");
      const foreignOffer = await offer(F.manager.tokens.o, F.j1.conversion_id, F.bedB.id, 1025, dates.start, `foreign-${nonce}`);
      check(foreignOffer.status === 404, "a manager session at another property cannot author terms on this case", { status: foreignOffer.status });
      const foreignTargets = await api("GET", "/operator/leasing/leaseable-units", { token: F.agent.tokens.o });
      const ids = new Set([F.bedA.id, F.bedB.id, F.w1s.id, F.n1s.id, F.d1s.id]);
      check(foreignTargets.status === 200 && !(foreignTargets.body.eligible_targets || []).some((t) => ids.has(t.space_id)), "another property's selector shows none of these homes");
      const foreignLead = await api("GET", `/leasing/leads/${F.p1.lead_id}`, { token: F.agent.tokens.o });
      check(foreignLead.status >= 400, "another property's session alone cannot read this lead through the legacy lead door", { status: foreignLead.status });
      const keyedLead = await api("GET", `/leasing/leads/${F.p1.lead_id}`, { token: F.agent.tokens.o, key: true });
      check(true, "observation: with the shared operator key present, the legacy lead door answers regardless of the session's property (key-scoped, not property-scoped)", { status: keyedLead.status, answered_this_lead: !!(keyedLead.body && (keyedLead.body.lead || keyedLead.body.id)) });
      const foreignProposal = await proposal(F.agent.tokens.o, F.p1.name, `Unit C7-${nonce}, Bed B`);
      check(foreignProposal.status !== 200 || foreignProposal.body.kind !== "application_send_proposal", "Ask Spine at another property cannot propose this prospect's send", { status: foreignProposal.status, outcome: foreignProposal.body && foreignProposal.body.outcome });
      const foreignCanonical = await api("GET", "/operator/leasing/availability-canonical", { token: F.agent.tokens.o, query: { as_of: plusDays(0) } });
      check(foreignCanonical.status === 200 && !(foreignCanonical.body.rows || []).some((r) => ids.has(r.space_id)), "another property's availability read shows none of these homes");
      const claimed = await api("GET", "/operator/leasing/leaseable-units", { token: F.agent.tokens.o, query: { property_id: P } });
      check(claimed.status >= 400 || !(claimed.body.eligible_targets || []).some((t) => ids.has(t.space_id)), "a client-supplied property id is never authority", { status: claimed.status });
    });

    // ── G. send through Ask Spine ────────────────────────────────────
    await section("send", async () => {
      need(F.offerB, "offer exists");
      const occupiedSend = await proposal(F.agent.tokens.p, F.p1.name, `Unit C7-${nonce}, Bed A`);
      const proposedLabel = occupiedSend.body && occupiedSend.body.target && occupiedSend.body.target.label;
      check(occupiedSend.body.kind !== "application_send_proposal" || /Bed A/.test(String(proposedLabel)),
        "naming the leased sibling bed cannot be re-aimed at a bed the agent did not name", { status: occupiedSend.status, outcome: occupiedSend.body && occupiedSend.body.outcome, proposed_target: proposedLabel || null, answer: occupiedSend.body && occupiedSend.body.answer });
      F.s1 = await sendViaAskSpine(F.p1, `Unit C7-${nonce}, Bed B`);
      check(F.s1.invitation && F.s1.invitation.space_id === F.bedB.id && F.s1.invitation.status === "provider_dispatched", "the invitation persists the exact bed", { status: F.s1.invitation && F.s1.invitation.status });
      check(!JSON.stringify(F.s1.proposal).includes(F.bedB.id) && !JSON.stringify(F.s1.proposal).includes(P), "the proposal exposes no database identifiers");
    });

    // ── H. changed prices ────────────────────────────────────────────
    await section("changed-prices", async () => {
      need(F.s1 && F.s1.token, "invitation token exists");
      const ctx1 = await api("GET", `/t/application/${F.s1.token}/context`);
      need(ctx1.status === 200 && ctx1.body.application_terms, "the applicant reads server-owned terms");
      const h1 = ctx1.body.application_terms.terms_hash;
      check(ctx1.body.application_terms.rent === "1025.00" && /Bed B/.test(ctx1.body.unit_label || ""), "the applicant sees the exact bed and the offered rent", { rent: ctx1.body.application_terms.rent, unit_label: ctx1.body.unit_label });
      check(!("availability_confidence" in ctx1.body) && !("readiness" in ctx1.body), "observation: the applicant context carries no readiness confidence field", Object.keys(ctx1.body));
      const revised = await offer(F.manager.tokens.p, F.j1.conversion_id, F.bedB.id, 1100, dates.start, `revise-${nonce}`, { supersedes_application_offer_id: F.offerB });
      need(revised.status === 200 && revised.body.application_offer_id, "management revises the offer before acceptance", { status: revised.status, body: revised.body });
      F.offerB2 = revised.body.application_offer_id;
      const ctx2 = await api("GET", `/t/application/${F.s1.token}/context`);
      const h2 = ctx2.body.application_terms.terms_hash;
      check(ctx2.body.application_terms.rent === "1100.00" && h2 !== h1, "the same link now shows the replacement terms with a new hash", { rent: ctx2.body.application_terms.rent });
      const stale = await api("POST", "/applications/submit-public", { body: { token: F.s1.token, applicant_name: F.p1.name, captured: captured(F.p1, dates.start), application_terms_hash: h1, application_terms_acknowledged: true } });
      check(stale.status === 409, "acknowledging the old price cannot submit against the new terms", { status: stale.status, receipt: stale.body && (stale.body.receipt || stale.body.error) });
      const tampered = await api("POST", "/applications/submit-public", { body: { token: F.s1.token, applicant_name: F.p1.name, rent: 999, captured: captured(F.p1, dates.start), application_terms_hash: h2, application_terms_acknowledged: true } });
      check(tampered.status === 400 && /set by the offer/.test(JSON.stringify(tampered.body)), "a form-supplied rent cannot override the offer", { status: tampered.status, error: tampered.body && tampered.body.error });
      check(true, "observation: the public submit door returns the refusal sentence as `error`; the stable code APPLICATION_TERMS_TAMPERED is not surfaced", { keys: Object.keys(tampered.body || {}) });
      await q("update units set market_rent=1500 where id=$1", [F.c7.id]);
      const ctx3 = await api("GET", `/t/application/${F.s1.token}/context`);
      check(ctx3.body.application_terms.rent === "1100.00" && ctx3.body.application_terms.terms_hash === h2, "a changed asking rent on the unit does not touch the negotiated terms", { rent: ctx3.body.application_terms.rent });
      check((await q("select count(*)::int n from lease_applications where person_id=$1 and property_id=$2", [F.p1.person_id, P])).rows[0].n === 0, "refused submissions created no application");
      const submitted = await api("POST", "/applications/submit-public", { body: { token: F.s1.token, applicant_name: F.p1.name, captured: captured(F.p1, dates.start), application_terms_hash: h2, application_terms_acknowledged: true } });
      need(submitted.status === 200 && submitted.body.application && submitted.body.application.id, "the applicant submits against the acknowledged replacement terms", { status: submitted.status, body: submitted.body });
      F.app1 = submitted.body.application.id;
      const row = await one("select rent,space_id,application_offer_id,application_terms_hash from lease_applications where id=$1", [F.app1]);
      check(row.rent === "1100.00" && row.space_id === F.bedB.id && row.application_offer_id === F.offerB2 && row.application_terms_hash === h2, "the application retains the exact bed and the acknowledged offer", { rent: row.rent });
      const silent = await api("POST", `/operator/leasing/applications/${F.app1}/proposed-terms`, { token: F.manager.tokens.p, body: { rent: 1150, security_deposit: 1100, lease_start_date: dates.start, lease_end_date: dates.end, concession_status: "none", idempotency_key: `silent-${nonce}` } });
      check(silent.status === 409, "management cannot silently change applicant-acknowledged rent after submission", { status: silent.status });
    });

    // ── I. readiness at submission (second prospect, whole unit W1) ─
    await section("readiness-at-submission", async () => {
      F.p2 = await prospect("Two");
      F.j2 = await tourAndCapture(F.p2, F.w1.id, "Wants W1 when it is ready");
      const start = plusDays(25);
      const o = await offer(F.manager.tokens.p, F.j2.conversion_id, F.w1s.id, 1400, start, `w1-${nonce}`);
      need(o.status === 200, "offer on the expected ready date is prepared", { status: o.status, body: o.body });
      F.s2 = await sendViaAskSpine(F.p2, `Unit W1-${nonce}`);
      check(F.s2.invitation && ymd(new Date(F.s2.invitation.intended_move_in)) === start, "the invitation durably carries the intended move-in", { intended_move_in: F.s2.invitation && F.s2.invitation.intended_move_in });
      const ctx = await api("GET", `/t/application/${F.s2.token}/context`);
      const h = ctx.body.application_terms.terms_hash;
      const submit = () => api("POST", "/applications/submit-public", { body: { token: F.s2.token, applicant_name: F.p2.name, captured: captured(F.p2, start), application_terms_hash: h, application_terms_acknowledged: true } });
      await q("update leases set end_date=$2 where id=$1", [F.leaseW.id, plusDays(60)]);
      const extended = await submit();
      check(extended.status === 409 && /no longer available/.test(String(extended.body && extended.body.error)), "an outgoing lease extended past the start refuses the submission as no longer offerable", { status: extended.status, error: extended.body && extended.body.error });
      await q("update leases set end_date=$2 where id=$1", [F.leaseW.id, plusDays(-5)]);
      await q("update turnovers set ready_date=$2 where id=$1", [F.turnW.id, plusDays(35)]);
      const slipped = await submit();
      check(slipped.status === 409 && /before the current turn plan expects/.test(String(slipped.body && slipped.body.error)), "a slipped turn date refuses the submission with the readiness reason, not 'unavailable'", { status: slipped.status, error: slipped.body && slipped.body.error });
      check((await q("select count(*)::int n from lease_applications where person_id=$1 and property_id=$2", [F.p2.person_id, P])).rows[0].n === 0, "no application was born while readiness was uncertain");
      const inv = await one("select status,consumed_at from application_invitations where id=$1", [F.s2.invitation.id]);
      check(inv.status === "provider_dispatched" && !inv.consumed_at, "refusals leave the link unconsumed");
      await q("update turnovers set ready_date=$2 where id=$1", [F.turnW.id, start]);
      const ok = await submit();
      check(ok.status === 200 && ok.body.application && ok.body.application.id, "the restored expected date lets the same link submit", { status: ok.status });
      const w = pick(await canonical(), F.w1s.id);
      check(w && w.availability_confidence === "expected" && w.physical_readiness !== "ready", "observation: the application was born on an expected date; physical readiness remains unconfirmed", w && { availability_confidence: w.availability_confidence, physical_readiness: w.physical_readiness });
    });

    // ── J. lease ─────────────────────────────────────────────────────
    await section("lease", async () => {
      need(F.app1, "application exists");
      const agentApprove = await api("POST", `/operator/leasing/applications/${F.app1}/approve`, { token: F.agent.tokens.p, body: {} });
      check(agentApprove.status === 403, "the collecting agent cannot approve", { status: agentApprove.status });
      const foreignApprove = await api("POST", `/operator/leasing/applications/${F.app1}/approve`, { token: F.manager.tokens.o, body: {} });
      check(foreignApprove.status === 403, "a manager session at another property cannot approve", { status: foreignApprove.status });
      const approved = await api("POST", `/operator/leasing/applications/${F.app1}/approve`, { token: F.manager.tokens.p, body: {} });
      need(approved.status < 400, "the property manager approves", { status: approved.status, body: approved.body });
      const terms = await api("POST", `/operator/leasing/applications/${F.app1}/proposed-terms`, { token: F.manager.tokens.p, body: { rent: 1100, security_deposit: 1100, lease_start_date: dates.start, lease_end_date: dates.end, concession_status: "none", idempotency_key: `terms-${nonce}` } });
      need(terms.status < 400, "the acknowledged terms are confirmed for the lease", { status: terms.status, body: terms.body });
      const packet = await api("POST", `/operator/leasing/applications/${F.app1}/lease-packet`, { token: F.manager.tokens.p, body: {} });
      need(packet.status < 400 && packet.body.packet && packet.body.packet.id, "the governing lease packet is generated", { status: packet.status, body: packet.body });
      const packetId = packet.body.packet.id;
      const lateRevision = await offer(F.manager.tokens.p, F.j1.conversion_id, F.bedB.id, 1120, dates.start, `late-${nonce}`, { supersedes_application_offer_id: F.offerB2 });
      check(lateRevision.status === 409, "a prepared packet blocks another price change", { status: lateRevision.status });
      const issued = await api("POST", `/operator/leasing/lease-packets/${packetId}/send`, { token: F.manager.tokens.p, body: { idempotency_key: `issue-${nonce}` } });
      need(issued.status < 400 && Array.isArray(issued.body.signing_links), "resident signing link issued", { status: issued.status, body: issued.body });
      const tenantLink = issued.body.signing_links.find((l) => l.signer_role === "tenant");
      need(tenantLink, "tenant link present");
      const leaseToken = String(tenantLink.url).split("/t/lease/")[1];
      const data = await api("GET", `/t/lease/${leaseToken}/data`);
      need(data.status === 200 && data.body.packet, "resident reads the packet");
      const fields = (data.body.packet.fields || []).filter((f) => f.required);
      for (const f of fields) {
        const r = await api("POST", `/t/lease/${leaseToken}/fields/${f.id}/complete`, { body: { value: f.field_type === "signature" ? F.p1.name : "CO", consent: f.field_type === "signature", session_id: `sess-${nonce}` } });
        need(r.status < 400, `resident completes ${f.field_key}`, { status: r.status, body: r.body });
      }
      const residentSubmit = await api("POST", `/t/lease/${leaseToken}/submit`, { body: { session_id: `sess-${nonce}` } });
      need(residentSubmit.status < 400, "resident executes", { status: residentSubmit.status, body: residentSubmit.body });
      const agentSign = await api("POST", `/operator/leasing/lease-packets/${packetId}/company-sign`, { token: F.agent.tokens.p, body: {} });
      check(agentSign.status === 403, "leasing access is not company signing authority", { status: agentSign.status });
      const managerSign = await api("POST", `/operator/leasing/lease-packets/${packetId}/company-sign`, { token: F.manager.tokens.p, body: {} });
      check(managerSign.status === 403, "management authority is not company signing authority", { status: managerSign.status, error: managerSign.body && managerSign.body.error });
      const executed = await api("POST", `/operator/leasing/lease-packets/${packetId}/company-sign`, { token: F.signer.token, body: {} });
      need(executed.status < 400 && executed.body.tenancy && executed.body.tenancy.lease_id, "the recorded company signer executes the lease", { status: executed.status, body: executed.body });
      const lease = await one("select space_id,rent,lease_status from leases where id=$1", [executed.body.tenancy.lease_id]);
      check(lease.space_id === F.bedB.id && Number(lease.rent) === 1100, "the tenancy is anchored to the exact bed at the acknowledged rent", { rent: lease.rent, lease_status: lease.lease_status });
      const rows = await canonical();
      const b = pick(rows, F.bedB.id), a = pick(rows, F.bedA.id);
      check(b && b.marketing_state !== "marketable_now", "the leased bed leaves the market", b && { marketing_state: b.marketing_state });
      check(a && a.marketing_state !== "marketable_now", "the sibling stays off the market", a && { marketing_state: a.marketing_state });
      const targets = await api("GET", "/operator/leasing/leaseable-units", { token: F.agent.tokens.p });
      check(!(targets.body.eligible_targets || []).some((t) => t.unit_id === F.c7.id), "the selector offers neither bed of the apartment");
      const again = await offer(F.manager.tokens.p, F.j2.conversion_id, F.bedB.id, 1100, dates.start, `again-${nonce}`);
      check(again.status === 409, "another prospect cannot be offered the bed just leased", { status: again.status, error: again.body && again.body.error });
    });

    // ── K. representative Matterports and floor plans ────────────────
    await section("representative-media", async () => {
      const existingFact = await one("select id from agent_facts where property_id=$1 and fact_key='virtual_tours' and status='active'", [P]);
      let insertedFact = null;
      if (!existingFact) insertedFact = await one(`insert into agent_facts (property_id,fact_key,category,rendered_text,source_type,status,confirmed_at,approved_by_user_id)
        values ($1,'virtual_tours','marketing',$2,'staff_entry','active',now(),$3) returning id`,
        [P, `Matterport of a 3-bed apartment (recorded in Unit C7-${nonce}): https://matterport.example/skyline-3bed`, F.manager.id]);
      try {
      const ask = await api("POST", "/operator/ask-spine/message", { token: F.agent.tokens.p, body: { message: `Where is the Matterport for Unit C7-${nonce}, Bed B?` } });
      need(ask.status === 200, "Ask Spine answers a media question", { status: ask.status });
      check(ask.body.outcome === "answered" && ask.body.grounded_on && ask.body.grounded_on.exact_home_association === "NOT_ESTABLISHED" && ask.body.grounded_on.scope === "property_wide",
        "a Matterport that names a unit is still not an exact-home fact", ask.body.grounded_on);
      check(/representative/i.test(ask.body.answer || "") && /exact-home match still needs verification/i.test(ask.body.answer || ""), "the wording carries the representative caveat", { answer: ask.body.answer });
      if (insertedFact) check((ask.body.references || []).some((r) => r.kind === "leasing_knowledge_link"), "the link is passed through as knowledge, not as a listing");
      const plan = await api("POST", "/operator/ask-spine/message", { token: F.agent.tokens.p, body: { message: "Which floor plan is Bed B?" } });
      check(plan.status === 200 && plan.body.outcome === "not_established" && (plan.body.grounded_on.missing_topics || []).includes("floor_plans"), "an unrecorded floor plan is an honest blank, never a bed", { outcome: plan.body.outcome, grounded_on: plan.body.grounded_on });
      const direct = await knowledge.answer(pool, { property_id: P, allowed_modules: ["leasing"], question: "Send me the Matterports" });
      check(direct.grounded_on && direct.grounded_on.exact_home_association === "NOT_ESTABLISHED", "the canonical knowledge read carries the same NOT_ESTABLISHED association");
      const runnerSource = fs.readFileSync(path.join(__dirname, "..", "..", "src", "leasing", "followup_runner.js"), "utf8");
      check(/recorded virtual tours\. These may show representative/.test(runnerSource) && Array.isArray(LADDER), "source-level: the follow-up rung that offers recorded tours says they may be representative");
      const foreign = await api("POST", "/operator/ask-spine/message", { token: F.agent.tokens.o, body: { message: "Where are the Matterports?" } });
      check(foreign.status === 200 && foreign.body.outcome !== "answered", "another property's session cannot read this property's media facts", { outcome: foreign.body && foreign.body.outcome });
      check(true, "deliberately unavailable here: the prospect-facing model wording about media is a provider test (scripted model only)");
      } finally { if (insertedFact) await q("update agent_facts set status='retired' where id=$1", [insertedFact.id]); }
    });
  } finally {
    await pool.end();
  }
  const summary = { passed: results.filter((r) => r.ok).length, failed, sections: [...new Set(results.map((r) => r.section))] };
  if (process.env.PROOF_OUTPUT_DIR) {
    const file = path.join(process.env.PROOF_OUTPUT_DIR, `lead_to_lease_challenge.${process.env.PROOF_EVIDENCE_LABEL || "run"}.json`);
    fs.writeFileSync(file, JSON.stringify({ server: process.env.PROOF_SERVER_SHA || null, summary, results }, null, 2));
  }
  console.log(`\nlead-to-lease challenge: ${summary.passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
