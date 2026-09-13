"use strict";
// Class 3 · Two-step leasing: AUTHOR and EXECUTE.
//
// Owned nonce-verified database, owned HTTP server (E2E_API_BASE), fake SMS
// transport (E2E_SMS_LOG) and fake model (E2E_ANTHROPIC_LOG). Two staff actors
// with the real authority split: "Mike" is a property_manager (Leasing,
// Management, Maintenance, no can_manage_roles override, no pricing grant);
// "KZ" holds the override and is the sole configured company signer. The
// ordinary path carries exactly TWO commercial decisions:
//
//   AUTHOR   KZ approves the complete immutable offer for one person, one
//            property, one exact bed (prepareApplicationOffer).
//   EXECUTE  after the applicant and guarantor sign, KZ approves the
//            application and signs for the company in ONE deliberate action
//            (POST /operator/leasing/lease-packets/:id/execute).
//
// Between them Mike prepares and attests the application link, prepares the
// signing package from the acknowledged offer (no approval, no confirmation),
// and issues the signing links. Three journeys run sequentially on ONE
// database with three distinct prospects on three genuinely separate beds;
// the first executed lease is never cancelled and no shared bed is reset.
// Every fixture write precedes the first business action; nothing is written
// by SQL after a business action to manufacture an outcome.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const boundary = require("./proof_boundary");
require("./proof_fence_preload");
const { Pool } = require("pg");
const staffSessions = require("../../src/identity/staff_session_service");

const BASE = process.env.E2E_API_BASE;
const SMS_LOG = process.env.E2E_SMS_LOG;
const MODEL_LOG = process.env.E2E_ANTHROPIC_LOG;
assert.ok(BASE && SMS_LOG && MODEL_LOG, "E2E_API_BASE, E2E_SMS_LOG and E2E_ANTHROPIC_LOG are required");
// WITNESS mode: on the unmodified baseline the two-step doors do not exist.
// The proof then records the refusals it meets and exits red by design.
const WITNESS = process.env.TWO_STEP_WITNESS === "1";

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
  const F = { leases: [] };
  const dates = { start: plusDays(30) }; dates.end = plusYear(dates.start);
  const quiet = () => ({ sms: logText(SMS_LOG).length, model: logText(MODEL_LOG).length });
  const stillQuiet = (before) => logText(SMS_LOG).length === before.sms && logText(MODEL_LOG).length === before.model;
  let P = null;

  async function inviteAndAccept({ token, propertyId, phone, name, role_key }) {
    const from = sms().length;
    const invite = await api("POST", `/properties/${propertyId}/team-invites`, { token, body: { invited_name: name, phone_number: phone, role_key, scope_type: "property" } });
    if (invite.status >= 400) return { invite };
    const joinToken = String(invite.body.link || "").split("/join/")[1];
    const start = await api("POST", "/auth/sms/start", { body: { token: joinToken } });
    let code = null;
    if (invite.body.delivery === "sms_sent") { const t = await waitSms(from, (m) => m.to === phone && /access code is \d{6}/.test(m.body || "")); code = t ? t.body.match(/access code is (\d{6})/)[1] : null; }
    else if (start.body && start.body.dev_code) code = start.body.dev_code;
    const verify = code ? await api("POST", "/auth/sms/verify", { body: { token: joinToken, code } }) : { status: 0, body: null };
    return { invite, joinToken, verify };
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
  //  Fixture: a bed established the way the product does it (one confirmed
  //  vacancy row under the fixture activation, with produced_* lineage). Same
  //  shape as property_fixture.sql's Bed B. All calls precede the first action.
  async function establishBed(unitNumber, label) {
    const unit = await one("insert into units (property_id, unit_number, unit_type_id) select $1,$2,(select id from property_unit_types where property_id=$1 order by sort_order limit 1) returning id, unit_number", [P, unitNumber]);
    await q("delete from spaces where unit_id=$1", [unit.id]);
    const whole = await one("insert into spaces (unit_id, space_label, use_type) values ($1,'(whole unit)','residential') returning id", [unit.id]);
    const bed = await one("insert into spaces (unit_id, space_label, use_type, position_kind) values ($1,$2,'residential','bed') returning id, space_label", [unit.id, label]);
    const batch = await one("select b.id, a.id as activation_id from import_batches b join activations a on a.import_batch_id=b.id where b.property_id=$1 and b.source_file='skyline-e2e-fixture.csv'", [P]);
    const rowIndex = (await one("select coalesce(max(row_index),0)+1 as n from import_source_rows where import_batch_id=$1", [batch.id])).n;
    const row = await one("insert into import_source_rows (import_batch_id,row_index,raw,parse_note,produced_unit_id,produced_space_id) values ($1,$2,$3,'fixture: confirmed vacancy',$4,$5) returning id",
      [batch.id, rowIndex, JSON.stringify({ unit_number: unitNumber, space_label: label, is_vacant: true }), unit.id, bed.id]);
    await q("insert into proposed_records (activation_id,property_id,module,target_type,natural_key,normalized_json,status,status_reason,import_source_row_id,confirmed_at) values ($1,$2,'leasing','lease',$3,$4,'promoted','Fixture: confirmed as a vacant rentable position. No lease was created.',$5,now())",
      [batch.activation_id, P, `${unitNumber}|${label}`, JSON.stringify({ section: "current", unit_number: unitNumber, space_label: label, is_vacant: true }), row.id]);
    void whole;
    return { unit, bed };
  }
  const deskRead = async (J, label) => {
    const d = await api("GET", "/operator/leasing/desk", { token: F.mike.tok });
    need(d.status === 200 && d.body && d.body.property_id === P && Array.isArray(d.body.application_records && d.body.application_records.records),
      `[${J.label}] the Leasing desk loads for Mike ${label}`, { status: d.status, error: d.body && d.body.error });
    if (J.app) {
      const records = d.body.application_records.records.filter((r) => r.application_id === J.app);
      check(records.length === 1 && records[0].person_id === J.person && records[0].unit_id === J.unit.id && (!J.leaseId || records[0].lease_id === J.leaseId),
        `[${J.label}] the desk retains this application, person, unit and tenancy identity ${label}`, { count: records.length, lease_id: records[0] && records[0].lease_id });
    }
    for (const prior of F.leases) {
      const rec = d.body.application_records.records.find((r) => r.application_id === prior.app);
      check(rec && rec.lease_id === prior.leaseId, `[${J.label}] the desk still carries the earlier executed lease (${prior.label}) ${label}`, { lease_id: rec && rec.lease_id });
    }
  };
  const queueRead = async (J, label) => {
    const r = await api("GET", "/operator/leasing/conversation-queue", { token: F.mike.tok });
    need(r.status === 200 && r.body && r.body.property_id === P && Array.isArray(r.body.conversations), `[${J.label}] the conversation queue loads ${label}`, { status: r.status, error: r.body && r.body.error });
    return r.body.conversations.find((x) => x.conversation_id === J.conversation) || null;
  };
  const reviewRead = async (J, label) => {
    const r = await api("GET", `/operator/leasing/application-review?application_id=${J.app}`, { token: F.mike.tok });
    need(r.status === 200 && r.body && r.body.application_id === J.app, `[${J.label}] Application Review loads ${label}`, { status: r.status, error: r.body && r.body.error });
    return r.body;
  };
  const operatingReads = async (J, label) => { await deskRead(J, label); await queueRead(J, label); if (J.app) await reviewRead(J, label); };
  const decisionCount = async (J) => ({
    approvals: (await one("select count(*)::int n from events where property_id=$1 and person_id=$2 and type='application_approved'", [P, J.person])).n,
    company_signatures: (await one("select count(*)::int n from lease_packet_fields f join lease_packets pk on pk.id=f.lease_packet_id where pk.application_id=$1 and f.signer_role='company' and f.field_type='signature' and f.completed", [J.app])).n,
    operator_confirmations: (await one("select count(*)::int n from application_proposed_terms_confirmations where application_id=$1 and source='operator_proposed_terms'", [J.app])).n,
    derived_confirmations: (await one("select count(*)::int n from application_proposed_terms_confirmations where application_id=$1 and source='authored_offer_acknowledged'", [J.app])).n,
    offers: (await one("select count(*)::int n from lease_offers where person_id=$1 and source='application_proposal'", [J.person])).n,
    leases: (await one("select count(*)::int n from leases where space_id=$1 and lease_status not in ('cancelled','void','superseded')", [J.bed.id])).n,
  });

  // ── the journey, parameterised ─────────────────────────────────────
  async function journey(J) {
    const offer = (tok, space, rent, key, extra = {}) => api("POST", `/operator/leasing/conversions/${J.conversion.id}/application-offer`, { token: tok, body: { space_id: space, rent, security_deposit: rent, lease_start_date: dates.start, lease_end_date: dates.end, fees: [], concessions: { status: "none" }, idempotency_key: key, ...extra } });
    const prepare = (tok, key, extra = {}) => api("POST", `/operator/leasing/conversions/${J.conversion.id}/send-application`, { token: tok, body: { delivery_method: "manual_email", unit_id: J.unit.id, space_id: J.bed.id, application_offer_id: J.offer, intended_move_in: dates.start, idempotency_key: key, ...extra } });

    await section(`${J.label} · inquiry, ownership, tour`, async () => {
      J.prospect = { name: `TwoStep Prospect ${J.label} ${nonce}`, phone: num(J.index * 10 + 2), email: `prospect-${J.label}-${nonce}@example.test` };
      const before = quiet();
      const first = await api("POST", "/leasing/intake", { headers: { "x-intake-secret": "e2e-intake", "Idempotency-Key": `form-${J.label}-${nonce}` }, body: { property_id: P, name: J.prospect.name, email: J.prospect.email, phone: J.prospect.phone, source: "Website", source_lead_id: `sq-${J.label}-${nonce}`, response_channel: "website", message: `Is a bed available for ${dates.start}? ${nonce}`, attempt_sms: false } });
      need(first.status === 200 && first.body.person_id && first.body.conversation_id, "the website inquiry is captured (no consent, capture only)", { status: first.status });
      J.person = first.body.person_id; J.conversation = first.body.conversation_id;
      check(first.body.first_response_sent === false && stillQuiet(before), "no model call, no text");
      const take = await api("POST", `/operator/conversations/${J.conversation}/take-over`, { token: F.mike.tok, body: {} });
      need(take.status === 200, "Mike takes ownership", { status: take.status });
      const rec = await api("POST", `/operator/leasing/conversations/${J.conversation}/reply`, { token: F.mike.tok, body: { channel: "email", body: `Hi, thanks for asking. ${nonce}`, recipient: J.prospect.email, occurred_at: new Date().toISOString(), idempotency_key: `email-${J.label}-${nonce}`, already_sent: true } });
      check(rec.status === 200 && rec.body.recorded === true && rec.body.dispatched === false, "Mike records the email he already sent", { status: rec.status });
      const starts = new Date(Date.now() + (2 + J.index) * 86400000), ends = new Date(starts.getTime() + 3600000);
      const slot = await api("POST", "/leasing/availability", { token: F.mike.tok, key: true, body: { property_id: P, starts_at: starts.toISOString(), ends_at: ends.toISOString(), unit_id: J.unit.id, leasing_agent_id: F.mike.id, capacity: 1, idempotency_key: `slot-${J.label}-${nonce}` } });
      need(slot.status < 400 && slot.body.slot, "a native slot is published", { status: slot.status, body: slot.body });
      const booked = await api("POST", `/operator/leasing/conversations/${J.conversation}/book-tour`, { token: F.mike.tok, body: { slot_id: slot.body.slot.id, idempotency_key: `book-${J.label}-${nonce}` } });
      need(booked.status === 200 && booked.body.tour_id, "Mike books the tour", { status: booked.status, body: booked.body });
      await api("POST", `/leasing/tours/${booked.body.tour_id}/check-in`, { key: true, body: { actor_id: F.mike.id } });
      const done = await api("POST", `/operator/leasing/tours/${booked.body.tour_id}/complete`, { token: F.mike.tok, body: { actual_tour_host_user_id: F.mike.id, preferred_unit_id: J.unit.id, feedback: { standing: "ready_to_apply", notes: `Wants ${J.bed.space_label}` }, idempotency_key: `done-${J.label}-${nonce}` } });
      need(done.status === 200, "Mike records the outcome as ready to apply", { status: done.status, body: done.body });
      J.conversion = await one("select id, person_id from leasing_conversions where origin_tour_id=$1 and property_id=$2", [booked.body.tour_id, P]);
      need(J.conversion && J.conversion.person_id === J.person, "the conversion belongs to the same person");
    });

    await section(`${J.label} · AUTHOR (decision 1)`, async () => {
      need(J.conversion, "conversion exists");
      const targets = await api("GET", "/operator/leasing/leaseable-units", { token: F.mike.tok });
      need(targets.status === 200 && Array.isArray(targets.body && targets.body.eligible_targets), "the exact-home selector read succeeds", { status: targets.status });
      const chosen = (targets.body.eligible_targets || []).find((t) => t.space_id === J.bed.id);
      need(!!chosen && chosen.marketing_state === "marketable_now", `${J.unit.unit_number} ${J.bed.space_label} is offerable as an exact choice`, chosen && { marketing_state: chosen.marketing_state, basis: chosen.resolution_basis });
      for (const prior of F.leases) {
        check(!(targets.body.eligible_targets || []).some((t) => t.space_id === prior.bed.id), `the earlier leased bed (${prior.label}) is still absent from the selector`);
      }
      const mikeOffer = await offer(F.mike.tok, J.bed.id, J.rent, `mike-${J.label}-${nonce}`);
      check(mikeOffer.status === 403 && mikeOffer.body.error === "NO_APPLICATION_OFFER_AUTHORITY", "Mike cannot author terms (no override, no pricing grant)", { status: mikeOffer.status, error: mikeOffer.body && mikeOffer.body.error });
      const first = await offer(F.kzTok, J.bed.id, J.rent - 75, `offer-${J.label}-${nonce}`);
      need(first.status === 200 && first.body.application_offer_id, "KZ authors the offer for the chosen bed", { status: first.status, body: first.body });
      J.offer1 = first.body.application_offer_id;
      const fix = await offer(F.kzTok, J.bed.id, J.rent, `fix-${J.label}-${nonce}`, { supersedes_application_offer_id: J.offer1 });
      need(fix.status === 200 && fix.body.draft_revision === true, "KZ corrects the unsent draft (explicit successor)", { status: fix.status, body: fix.body });
      J.offer = fix.body.application_offer_id;
      const row = await one("select authority_basis_snapshot->>'actor_user_id' as author, offered_terms_snapshot->>'application_terms_hash' as hash, supersedes_application_offer_id from lease_offers where id=$1", [J.offer]);
      check(row.author === F.kz.id && row.supersedes_application_offer_id === J.offer1 && !!row.hash, "the authored offer carries KZ as author, its hash and its lineage", { author_is_kz: row.author === F.kz.id });
      J.offerHash = row.hash;
      await operatingReads(J, "after the authored offer exists");
    });

    await section(`${J.label} · Mike prepares, attests; applicant and guarantor apply`, async () => {
      need(J.offer, "authored offer exists");
      const before = quiet();
      const prepared = await prepare(F.mike.tok, `prep-${J.label}-${nonce}`);
      need(prepared.status === 200 && prepared.body.prepared === true && prepared.body.sent === false && /\/t\/application\//.test(prepared.body.link || ""), "Mike prepares the application link for email; nothing is sent", { status: prepared.status, body: prepared.body });
      J.invitation = prepared.body.invitation_id; J.link = prepared.body.link;
      check(stillQuiet(before), "preparation sent nothing and called no model");
      const attest = await api("POST", `/operator/leasing/application-invitations/${J.invitation}/sent`, { token: F.mike.tok, body: { send_obligation_id: prepared.body.send_obligation_id, channel: "email", recipient_snapshot: J.prospect.email, note: "sent from my mailbox" } });
      need(attest.status === 200, "Mike attests that he emailed the link", { status: attest.status, body: attest.body });
      J.appToken = J.link.split("/t/application/")[1];
      const ctx = await api("GET", `/t/application/${J.appToken}/context`);
      need(ctx.status === 200 && ctx.body.application_terms && Number(ctx.body.application_terms.rent) === J.rent, "the applicant sees the authored terms", { status: ctx.status, rent: ctx.body && ctx.body.application_terms && ctx.body.application_terms.rent });
      J.guarantor = { name: `Guarantor ${J.label} ${nonce}`, phone: num(J.index * 10 + 3) };
      const body = { token: J.appToken, applicant_name: J.prospect.name, captured: captured(J.prospect.phone, J.prospect.email, dates.start, J.guarantor), application_terms_hash: ctx.body.application_terms.terms_hash, application_terms_acknowledged: true };
      const submitted = await api("POST", "/applications/submit-public", { body });
      need(submitted.status === 200 && submitted.body.application && submitted.body.application.id, "the applicant submits against the acknowledged terms", { status: submitted.status, body: submitted.body });
      J.app = submitted.body.application.id;
      const row = await one("select status, person_id, space_id, application_offer_id, application_terms_hash, approval_obligation_id, terms_review_obligation_id, proposed_terms_confirmation_id, approved_at from lease_applications where id=$1", [J.app]);
      check(row.status === "submitted" && row.person_id === J.person && row.space_id === J.bed.id && row.application_offer_id === J.offer && row.application_terms_hash === J.offerHash && row.approval_obligation_id && !row.terms_review_obligation_id && !row.proposed_terms_confirmation_id && !row.approved_at,
        "the application is submitted, bound to the acknowledged offer and exact bed, unapproved, with its approval obligation open", { status: row.status });
      await operatingReads(J, "after the application is submitted");
      const review = await reviewRead(J, "before any packet");
      check(review.next_action && review.next_action.code === "prepare_lease_packet" && review.next_action.preparation_basis === "authored_offer", "Application Review's next action is to prepare the signing package from the acknowledged offer (not to approve)", { code: review.next_action && review.next_action.code, label: review.next_action && review.next_action.label });
    });

    await section(`${J.label} · packet from the acknowledged offer (no approval, no reconfirmation)`, async () => {
      need(J.app, "application exists");
      const before = await decisionCount(J);
      const packet = await api("POST", `/operator/leasing/applications/${J.app}/lease-packet`, { token: F.mike.tok, body: {} });
      need(packet.status === 200 && packet.body.packet && packet.body.packet.application_id === J.app && packet.body.packet.status === "draft", "Mike prepares the signing package while the application is still submitted", { status: packet.status, error: packet.body && packet.body.error, receipt: packet.body && packet.body.receipt });
      J.packet = packet.body.packet.id;
      const pk = await one("select application_offer_id, application_terms_hash, proposed_terms_confirmation_id, terms_json->>'space_id' as space_id, unit_id from lease_packets where id=$1", [J.packet]);
      check(pk.application_offer_id === J.offer && pk.application_terms_hash === J.offerHash && pk.space_id === J.bed.id && pk.unit_id === J.unit.id, "the packet carries the authored offer, its hash and the exact bed", { space_matches: pk.space_id === J.bed.id });
      const conf = await one("select c.source, c.authority_basis, c.actor_user_id, c.application_offer_id, c.application_terms_hash, c.rent, c.supersedes_confirmation_id from application_proposed_terms_confirmations c where c.id=$1", [pk.proposed_terms_confirmation_id]);
      check(conf && conf.source === "authored_offer_acknowledged" && conf.authority_basis === "authored_offer" && conf.actor_user_id === F.mike.id && conf.application_offer_id === J.offer && conf.application_terms_hash === J.offerHash && Number(conf.rent) === J.rent,
        "the lineage record is SYSTEM-DERIVED from the acknowledged offer: named as such, actor = preparer (Mike), economics = the author's", conf && { source: conf.source, authority_basis: conf.authority_basis });
      const app = await one("select status, approved_at, terms_review_obligation_id, term_source, terms_completed_by, rent from lease_applications where id=$1", [J.app]);
      check(app.status === "submitted" && !app.approved_at && !app.terms_review_obligation_id && app.term_source === "authored_offer_acknowledged" && app.terms_completed_by === F.kz.id && Number(app.rent) === J.rent,
        "preparing the packet approved nothing: still submitted, no approval instant, no terms-review gate; terms attributed to their author", { status: app.status, term_source: app.term_source });
      const after = await decisionCount(J);
      check(after.approvals === before.approvals && after.operator_confirmations === 0 && after.derived_confirmations === 1 && after.company_signatures === 0, "no human decision was recorded by preparation (0 approvals, 0 operator confirmations)", after);
      const gen = await one("select count(*)::int n from lease_packet_audit_events where lease_packet_id=$1 and event_type='packet_generated' and event_json->>'actor_user_id'=$2", [J.packet, F.mike.id]);
      check(gen.n === 1, "the packet-generated audit names Mike as the actor", gen);
      const late = await offer(F.kzTok, J.bed.id, J.rent + 20, `late-${J.label}-${nonce}`, { supersedes_application_offer_id: J.offer });
      check(late.status === 409, "a prepared packet blocks a further offer change (changed terms need a new package, never a silent swap)", { status: late.status, error: late.body && late.body.error });
      const again = await api("POST", `/operator/leasing/applications/${J.app}/lease-packet`, { token: F.mike.tok, body: {} });
      check(again.status === 200 && again.body.packet && again.body.packet.id === J.packet, "regenerating before issue returns the same draft (idempotent, one derived record)", { status: again.status, id: again.body && again.body.packet && again.body.packet.id });
      check((await decisionCount(J)).derived_confirmations === 1, "still exactly one derived lineage record");
      const issued = await api("POST", `/operator/leasing/lease-packets/${J.packet}/send`, { token: F.mike.tok, body: { idempotency_key: `issue-${J.label}-${nonce}` } });
      need(issued.status === 200 && issued.body.already_issued === false && Array.isArray(issued.body.signing_links) && issued.body.signing_links.length === 2, "Mike issues the resident and guarantor links", { status: issued.status, body: issued.body });
      J.links = Object.fromEntries(issued.body.signing_links.map((l) => [l.signer_role, String(l.url).split("/t/lease/")[1]]));
      await operatingReads(J, "after the links are issued");
      const review = await reviewRead(J, "after issue");
      check(review.next_action && review.next_action.code === "await_resident_acknowledgment" && review.status === "submitted", "review: awaiting the resident's signature, application still submitted", { code: review.next_action && review.next_action.code });
    });

    await section(`${J.label} · signatures, then refusals before EXECUTE`, async () => {
      need(J.links, "links exist");
      const early = await api("POST", `/operator/leasing/lease-packets/${J.packet}/execute`, { token: F.kzTok, body: { application_decision: "approve" } });
      check(early.status === 409 && early.body && early.body.error === "resident_has_not_executed", "KZ cannot execute before the resident and guarantor sign", { status: early.status, error: early.body && early.body.error });
      const g = await completeSigner({ token: J.links.guarantor, name: J.guarantor.name, initials: "JG", sessionId: `g-${J.label}-${nonce}` });
      check(g.submit && g.submit.status < 400, "the guarantor signs", { status: g.submit && g.submit.status, failed: g.failed });
      const gOnly = await api("POST", `/operator/leasing/lease-packets/${J.packet}/execute`, { token: F.kzTok, body: { application_decision: "approve" } });
      check(gOnly.status === 409 && gOnly.body.error === "resident_has_not_executed" && Array.isArray(gOnly.body.outstanding_signers) && gOnly.body.outstanding_signers.length === 1, "with the applicant still outstanding, Execute is refused and names who is outstanding", { status: gOnly.status, outstanding: gOnly.body && gOnly.body.outstanding_signers });
      const r = await completeSigner({ token: J.links.tenant, name: J.prospect.name, initials: "TP", sessionId: `r-${J.label}-${nonce}` });
      need(r.submit && r.submit.status < 400 && r.submit.body.packet && r.submit.body.packet.status === "resident_executed", "the applicant signs and the package reads resident executed", { status: r.submit && r.submit.status, failed: r.failed, body: r.submit && r.submit.body });
      const ack = await one("select event_json->>'two_step_preparation' as two_step, event_json->'acknowledgment_evidence'->>'rendered_snapshot_hash' as snap from lease_packet_audit_events where lease_packet_id=$1 and event_type='tenant_submitted'", [J.packet]);
      check(ack && ack.two_step === "true" && !!ack.snap, "the resident's acknowledgment evidence is frozen on the packet audit (obligation to be satisfied from it at Execute)");
      const app = await one("select status, approved_at, terms_review_obligation_id from lease_applications where id=$1", [J.app]);
      check(app.status === "submitted" && !app.approved_at && !app.terms_review_obligation_id, "signatures changed no application status and approved nothing");
      await operatingReads(J, "after both signatures");
      const review = await reviewRead(J, "with both signatures");
      check(review.next_action && review.next_action.code === "execute_lease" && review.execution_primary_action && review.execution_primary_action.action === "execute_lease" && /approve the application and sign for the company/i.test(review.execution_primary_action.label), "review: the one remaining act is Execute, labelled as approve + sign", { next: review.next_action && review.next_action.code, primary: review.execution_primary_action && review.execution_primary_action.action, label: review.execution_primary_action && review.execution_primary_action.label });
      check(review.execution_primary_action && Array.isArray(review.execution_primary_action.commercial_decisions_remaining) && review.execution_primary_action.commercial_decisions_remaining.join(",") === "application_approval,company_signature", "review names both remaining commercial decisions");
      const before = await decisionCount(J);
      // actor matrix
      const mike = await api("POST", `/operator/leasing/lease-packets/${J.packet}/execute`, { token: F.mike.tok, body: { application_decision: "approve" } });
      check(mike.status === 403 && mike.body.error === "execute_not_authorized" && (mike.body.missing || []).length === 2, "Mike (staff, preparation only): refused, holding neither approval authority nor signer standing", { status: mike.status, error: mike.body && mike.body.error, missing: mike.body && mike.body.missing });
      const mikeSign = await api("POST", `/operator/leasing/lease-packets/${J.packet}/company-sign`, { token: F.mike.tok, body: {} });
      check(mikeSign.status === 403, "Mike cannot use the released company-sign door either", { status: mikeSign.status, error: mikeSign.body && mikeSign.body.error });
      const signerOnly = await api("POST", `/operator/leasing/lease-packets/${J.packet}/execute`, { token: F.signerOnly.tok, body: { application_decision: "approve" } });
      check(signerOnly.status === 403 && signerOnly.body.error === "application_approval_not_authorized" && (signerOnly.body.missing || []).join() === "application_approval", "a signer-list member WITHOUT approval authority cannot decide: signer-list entry alone confers no approval", { status: signerOnly.status, error: signerOnly.body && signerOnly.body.error });
      const approverOnly = await api("POST", `/operator/leasing/lease-packets/${J.packet}/execute`, { token: F.approverOnly.tok, body: { application_decision: "approve" } });
      check(approverOnly.status === 403 && approverOnly.body.error === "company_signer_not_authorized" && (approverOnly.body.missing || []).join() === "company_signature", "an approver who is NOT a configured signer cannot execute: approval authority alone confers no signature", { status: approverOnly.status, error: approverOnly.body && approverOnly.body.error });
      const foreign = await api("POST", `/operator/leasing/lease-packets/${J.packet}/execute`, { token: await session(F.kz.id, F.other.id), body: { application_decision: "approve" } });
      check(foreign.status === 403 && foreign.body.error === "packet_not_at_your_property", "KZ's session at another property cannot execute this packet", { status: foreign.status });
      const wrongDecision = await api("POST", `/operator/leasing/lease-packets/${J.packet}/execute`, { token: F.kzTok, body: { application_decision: "decline" } });
      check(wrongDecision.status === 400 && wrongDecision.body.error === "application_decision_required", "Execute carries exactly one explicit decision; anything else is refused before any write", { status: wrongDecision.status });
      const noDecision = await api("POST", `/operator/leasing/lease-packets/${J.packet}/execute`, { token: F.kzTok, body: {} });
      check(noDecision.status === 400, "an empty body is not a decision", { status: noDecision.status });
      const released = await api("POST", `/operator/leasing/lease-packets/${J.packet}/company-sign`, { token: F.kzTok, body: {} });
      check(released.status === 409 && released.body.error === "application_not_approved", "ALTERNATIVE ROUTE CLOSED: the released company-sign door refuses to sign an unapproved application and points at Execute", { status: released.status, error: released.body && released.body.error });
      const after = await decisionCount(J);
      check(JSON.stringify(after) === JSON.stringify(before), "every refusal above wrote no approval, signature, confirmation, offer or lease", { before, after });
      const app2 = await one("select status, approved_at from lease_applications where id=$1", [J.app]);
      check(app2.status === "submitted" && !app2.approved_at, "the application is still submitted after every refusal");
    });

    if (J.mode === "handoff") {
      //  Left at resident_executed for the browser slice (two_step_execute.browser.js),
      //  which performs Execute through the actual staff UI. Runtime identifiers
      //  only; the file lives in the run's evidence directory and is never committed.
      {
        const outDir = process.env.PROOF_OUTPUT_DIR || path.join(require("node:os").tmpdir(), "two-step-leasing");
        fs.mkdirSync(outDir, { recursive: true });
        fs.writeFileSync(path.join(outDir, "two_step_handoff.json"), JSON.stringify({
          property_id: P, application_id: J.app, packet_id: J.packet, person_id: J.person, prospect_name: J.prospect.name,
          bed_id: J.bed.id, unit_number: J.unit.unit_number, rent: J.rent,
          kz_user_id: F.kz.id, mike_user_id: F.mike.id, signer_only_user_id: F.signerOnly.id,
        }, null, 2));
        observe(`${J.label} left at resident_executed for the browser slice`, { handoff: "two_step_handoff.json" });
      }
      return;
    }
    if (J.mode === "withdraw") {
      await section(`${J.label} · withdrawal before EXECUTE`, async () => {
        need(J.packet, "packet exists");
        const before = await decisionCount(J);
        const deny = await api("POST", `/applications/${J.app}/deny`, { key: true, body: { reason: "withdrawn", note: "applicant withdrew by phone", decided_by_user_id: F.mike.id } });
        need(deny.status === 200, "the applicant's withdrawal is recorded through the existing disposition door", { status: deny.status, body: deny.body });
        const exec = await api("POST", `/operator/leasing/lease-packets/${J.packet}/execute`, { token: F.kzTok, body: { application_decision: "approve" } });
        check(exec.status === 409 && exec.body.error === "application_terminal", "a withdrawn application cannot be executed even with every signature and every authority", { status: exec.status, error: exec.body && exec.body.error });
        const after = await decisionCount(J);
        check(after.approvals === before.approvals && after.company_signatures === 0 && after.leases === 0, "no approval, signature or lease resulted", after);
        const row = await one("select status from lease_applications where id=$1", [J.app]);
        check(row.status === "withdrawn", "the application reads withdrawn");
        await operatingReads(J, "after the withdrawal");
        const review = await reviewRead(J, "after withdrawal");
        check(review.status === "withdrawn" && review.next_action && review.next_action.code === "closed", "review reads the closed application honestly", { code: review.next_action && review.next_action.code });
        const targets = await api("GET", "/operator/leasing/leaseable-units", { token: F.mike.tok });
        check(targets.status === 200 && (targets.body.eligible_targets || []).some((t) => t.space_id === J.bed.id), "the bed returns to the selector: nothing was reserved", { status: targets.status });
      });
      return;
    }

    if (J.mode === "rollback") {
      await section(`${J.label} · rollback of a failing composition boundary`, async () => {
        need(J.packet, "packet exists");
        const leasePacketsModule = require("../../src/applications/lease_packets");
        const engine = require("../../src/shared/obligation_engine");
        const svc = leasePacketsModule({ pool, satisfyObligation: engine.satisfyObligation, completeObligation: engine.completeObligation, executionServices: () => ({}) })._service;
        const before = await decisionCount(J);
        const beforeAudit = (await one("select count(*)::int n from lease_packet_audit_events where lease_packet_id=$1", [J.packet])).n;
        const operator = { id: F.kz.id, property_id: P, can_manage_roles: true, name: "KZ (rehearsal signer)", allowed_modules: ["leasing", "management"] };
        const probeNote = `rollback-probe-${nonce}`;
        //  The failing dependency: a company-sign stage that writes, then throws.
        //  Approval (decision 1) is the REAL service; the failure is injected
        //  at the second boundary, after the first decision's rows exist.
        const failingApplications = {
          approveApplication: async (client, args) => {
            const real = require("../../src/applications/applications");
            void real;
            await client.query("insert into events (property_id, person_id, type, note) values ($1,$2,'application_approved',$3)", [P, J.person, probeNote]);
            throw Object.assign(new Error("injected failure at the approval→signature boundary"), { injected: true });
          },
        };
        const client = await pool.connect();
        let thrown = null;
        try {
          await client.query("begin");
          await svc.executeLeasePacketDecision(client, { packetId: J.packet, operator, req: { headers: {} }, decision: "approve", idempotencyKey: `probe-${nonce}` }, { applications: failingApplications });
          await client.query("commit");
        } catch (e) { thrown = e; await client.query("rollback").catch(() => {}); } finally { client.release(); }
        check(thrown && thrown.injected === true, "the composition surfaces the boundary failure instead of swallowing it", { message: thrown && thrown.message });
        const after = await decisionCount(J);
        const probe = await one("select count(*)::int n from events where note=$1", [probeNote]);
        const afterAudit = (await one("select count(*)::int n from lease_packet_audit_events where lease_packet_id=$1", [J.packet])).n;
        const pk = await one("select status, company_executed_at from lease_packets where id=$1", [J.packet]);
        const app = await one("select status, approved_at, terms_review_obligation_id from lease_applications where id=$1", [J.app]);
        check(probe.n === 0 && JSON.stringify(after) === JSON.stringify(before) && afterAudit === beforeAudit && pk.status === "resident_executed" && !pk.company_executed_at && app.status === "submitted" && !app.approved_at && !app.terms_review_obligation_id,
          "ROLLBACK: the partial write from the failing boundary is gone; packet still resident_executed, application still submitted, no lease", { probe_rows: probe.n, packet: pk.status, application: app.status });
      });
    }

    await section(`${J.label} · EXECUTE (decision 2): approve + sign for the company, once`, async () => {
      need(J.packet, "packet exists");
      const before = await decisionCount(J);
      const beforeQuiet = quiet();
      const body = { application_decision: "approve", idempotency_key: `exec-${J.label}-${nonce}` };
      //  Double click / concurrent submission: three requests at once.
      const burst = await Promise.all([1, 2, 3].map(() => api("POST", `/operator/leasing/lease-packets/${J.packet}/execute`, { token: F.kzTok, body })));
      const created = burst.filter((r) => r.status === 201);
      const replays = burst.filter((r) => r.status === 200 && r.body && r.body.idempotent === true);
      const conflicts = burst.filter((r) => r.status === 409);
      need(created.length === 1, "exactly ONE of three concurrent Execute requests decides", { statuses: burst.map((r) => r.status), errors: burst.map((r) => r.body && r.body.error) });
      check(replays.length + conflicts.length === 2, "the other two are replays or refusals, never a second decision", { replays: replays.length, conflicts: conflicts.length });
      const exec = created[0];
      need(exec.body.tenancy && exec.body.tenancy.lease_id && Array.isArray(exec.body.decisions) && exec.body.decisions.length === 2, "Execute returns the pending tenancy and the two decisions it recorded", { body: exec.body && { decisions: exec.body.decisions, tenancy: exec.body.tenancy } });
      J.leaseId = exec.body.tenancy.lease_id;
      const [d1, d2] = exec.body.decisions;
      check(d1.decision === "application_approved" && d1.actor_user_id === F.kz.id && d1.authority_basis === "managed_role_override" && !!d1.event_id && !!d1.terms_review_obligation_id, "decision 1 · application approved by KZ under the governed override, with its own event", d1);
      check(d2.decision === "company_signed" && d2.actor_user_id === F.kz.id && d2.packet_id === J.packet && !!d2.at, "decision 2 · company signature by KZ on this packet, with its own timestamp", d2);
      check(new Date(d1.at).getTime() <= new Date(d2.at).getTime(), "the approval instant precedes or equals the signature instant");
      const after = await decisionCount(J);
      check(after.approvals === before.approvals + 1 && after.company_signatures === 1 && after.operator_confirmations === 0 && after.leases === 1, "server evidence counts exactly two commercial decisions for this lease: 1 approval + 1 company signature (0 operator confirmations)", after);
      const app = await one("select status, approved_at, terms_review_obligation_id, activation_obligation_id, proposed_terms_confirmation_id from lease_applications where id=$1", [J.app]);
      check(!!app.approved_at && !!app.terms_review_obligation_id, "the application carries an approval instant and its terms-review gate", { status: app.status, approved_at: !!app.approved_at });
      const gate = await one("select status, assigned_role from obligations where id=$1", [app.terms_review_obligation_id]);
      const proof = await one("select count(*)::int n from obligation_input_events e where e.obligation_id=$1 and e.input='terms_acknowledged'", [app.terms_review_obligation_id]).catch(() => null);
      check(gate && ["complete", "completed"].includes(gate.status), "the terms-review obligation spawned by approval is complete, satisfied from the packet's frozen acknowledgment", { gate: gate && gate.status, proof_rows: proof && proof.n });
      const approvalGate = await one("select o.status from lease_applications a join obligations o on o.id=a.approval_obligation_id where a.id=$1", [J.app]);
      check(approvalGate && ["complete", "completed", "closed"].includes(approvalGate.status), "the approval obligation born at submission is closed by the decision", approvalGate);
      const audit = await one("select event_json from lease_packet_audit_events where lease_packet_id=$1 and event_type='executed_by_decision'", [J.packet]);
      check(audit && audit.event_json.actor_user_id === F.kz.id && audit.event_json.application_decision === "approve" && audit.event_json.decisions.length === 2, "the packet audit records the one decision act with both consequences");
      const lease = await one("select l.space_id, s.unit_id, l.rent, l.lease_status, l.start_date, l.economic_tenancy_activated_at, l.application_id from leases l join spaces s on s.id=l.space_id where l.id=$1", [J.leaseId]);
      check(lease.space_id === J.bed.id && lease.unit_id === J.unit.id && Number(lease.rent) === J.rent && ymd(new Date(lease.start_date)) === dates.start && lease.application_id === J.app, "the tenancy is anchored to the exact bed at the authored rent", { rent: lease.rent, space_matches: lease.space_id === J.bed.id });
      const possession = await one("select count(*)::int n from unit_events where space_id=$1 and event_type='move_in' and status not in ('cancelled','superseded')", [J.bed.id]);
      check(lease.lease_status === "pending" && lease.economic_tenancy_activated_at === null && possession.n === 0, "execution leaves a PENDING lease: no economic activation, no possession", { lease_status: lease.lease_status, move_in_events: possession.n });
      check(stillQuiet(beforeQuiet) && sms().filter((m) => m.to === J.prospect.phone).length === 0, "Execute sent no text and called no model");
      const retry = await api("POST", `/operator/leasing/lease-packets/${J.packet}/execute`, { token: F.kzTok, body });
      check(retry.status === 200 && retry.body.idempotent === true && retry.body.tenancy && retry.body.tenancy.lease_id === J.leaseId && Array.isArray(retry.body.decisions) && retry.body.decisions.length === 2, "a lost-response retry returns the recorded decisions and the same tenancy; nothing is decided twice", { status: retry.status });
      const otherKey = await api("POST", `/operator/leasing/lease-packets/${J.packet}/execute`, { token: F.kzTok, body: { application_decision: "approve", idempotency_key: `other-${nonce}` } });
      check(otherKey.status === 200 && otherKey.body.idempotent === true && otherKey.body.tenancy.lease_id === J.leaseId, "a different retry key on an executed packet still yields the one existing decision");
      const releasedAgain = await api("POST", `/operator/leasing/lease-packets/${J.packet}/company-sign`, { token: F.kzTok, body: {} });
      check(releasedAgain.status === 409 && releasedAgain.body.error === "packet_already_executed", "the released company-sign door refuses the executed packet", { status: releasedAgain.status, error: releasedAgain.body && releasedAgain.body.error });
      const reapprove = await api("POST", `/operator/leasing/applications/${J.app}/approve`, { token: F.kzTok, body: {} });
      check(reapprove.status === 409 && reapprove.body && reapprove.body.idempotent === true, "the released approve door reports the application already approved", { status: reapprove.status });
      const lateWithdraw = await api("POST", `/applications/${J.app}/deny`, { key: true, body: { reason: "withdrawn" } });
      check(lateWithdraw.status === 409, "a withdrawal after execution is refused", { status: lateWithdraw.status });
      check((await decisionCount(J)).leases === 1 && (await one("select count(*)::int n from leases where application_id=$1", [J.app])).n === 1, "exactly one lease exists for this application and this bed");
      const targets = await api("GET", "/operator/leasing/leaseable-units", { token: F.mike.tok });
      need(targets.status === 200 && Array.isArray(targets.body && targets.body.eligible_targets), "the selector read succeeds after execution", { status: targets.status });
      check(!(targets.body.eligible_targets || []).some((t) => t.space_id === J.bed.id), "the leased bed leaves the selector");
      const review = await reviewRead(J, "after execution");
      check(review.lease_id === J.leaseId && review.space && review.space.space_id === J.bed.id && review.next_action && ["executed_lease_recorded", "confirm_term", "active"].includes(review.next_action.code), "Application Review reads the same tenancy and bed with a truthful next action", { next: review.next_action && review.next_action.code, primary: review.execution_primary_action && review.execution_primary_action.action });
      const card = await api("GET", `/operator/leasing/person-card?person_id=${J.person}`, { token: F.mike.tok });
      const standing = card.body && card.body.leasing_standing;
      check(card.status === 200 && standing && standing.tenancy && standing.tenancy.lease_id === J.leaseId && standing.tenancy.space_id === J.bed.id && standing.tenancy.state === "pending", "the Person Card reads the exact pending-bed tenancy", { status: card.status });
      check(standing && Array.isArray(standing.uncertainty) && !standing.uncertainty.some((i) => i.kind === "read_failed"), "Person Card success conceals no leasing-standing read failure", { uncertainty: standing && standing.uncertainty });
      const ask = await api("POST", "/operator/ask-spine/ask", { token: F.mike.tok, body: { question: `What is the leasing standing for ${J.prospect.name}?` } });
      check(ask.status === 200 && typeof ask.body.answer === "string" && ask.body.outcome !== "read_failed", "Ask Spine answers about this person after execution without a read failure", { outcome: ask.body && ask.body.outcome, answer: ask.body && String(ask.body.answer).slice(0, 160) });
      await operatingReads(J, "after execution");
      F.leases.push({ label: J.label, app: J.app, leaseId: J.leaseId, bed: J.bed });
    });
  }

  try {
    await section("fixture · property, beds and the four actors", async () => {
      F.property = await one("select id, organization_id, name from properties where name in ('Skyline E2E','Property Spine Demo Building') order by created_at desc limit 1");
      need(!!F.property, "Skyline-shaped fixture property exists");
      P = F.property.id;
      if (!F.property.organization_id) {
        const org = await one("insert into organizations (name,slug) values ($1,$2) returning id", [`TwoStep Org ${nonce}`, `twostep-org-${nonce}`]);
        await q("update properties set organization_id=$2 where id=$1", [P, org.id]); F.property.organization_id = org.id;
      }
      F.kz = await one("select u.id, u.person_id from users u join property_team_assignments pta on pta.user_id=u.id and pta.property_id=$1 and pta.active and pta.can_manage_roles where (u.name='Mike Grivna' or u.name like 'KZ (rehearsal signer)%') and u.is_active order by u.created_at limit 1", [P]);
      need(!!F.kz, "the fixture's configured company signer with the governed override exists");
      await q("update users set name=$2 where id=$1", [F.kz.id, `KZ (rehearsal signer) ${nonce}`]);
      if (!F.kz.person_id) {
        const p = await one("insert into persons (name,source) values ('KZ rehearsal identity','journey_fixture') returning id");
        await q("update users set person_id=$2, account_kind='human_staff' where id=$1", [F.kz.id, p.id]);
        await q("insert into assignments (person_id,property_id,role,provenance) values ($1,$2,'asset_manager',$3)", [p.id, P, JSON.stringify({ source: "journey_fixture" })]);
      }
      await q("update communication_lines set outbound_enabled=true, outbound_policy='proactive' where property_id=$1 and line_type='property_facing' and status='active'", [P]);
      await q("update properties set operating_timezone=coalesce(operating_timezone,'America/New_York') where id=$1", [P]);
      observe("fixture: the property's operating timezone is set so tour times can be published (an owner input in production)");
      await q("insert into lead_sources (name,source_type) values ($1,'website') on conflict do nothing", ["Website"]);
      //  Three genuinely separate beds, each established as the product does.
      //  Bed B in 3B is the CI fixture's; the other two are added here, before
      //  any action. Journey 2 never touches journey 1's bed.
      F.unit3B = await one("select id, unit_number from units where property_id=$1 and unit_number='3B' limit 1", [P]);
      F.bedB = await one("select id, space_label from spaces where unit_id=$1 and space_label='Bed B'", [F.unit3B.id]);
      need(F.unit3B && F.bedB, "fixture unit 3B with established Bed B exists");
      await q("update spaces set use_type='residential' where unit_id=$1", [F.unit3B.id]);
      need((await one("select count(*)::int n from leases where space_id=$1 and lease_status not in ('cancelled','rescinded','void','superseded','terminated','expired')", [F.bedB.id])).n === 0, "Bed B carries no live lease at the start (fresh database; no reset performed)");
      F.two = await establishBed(`C8-${nonce}`, "Bed A");
      F.three = await establishBed(`C9-${nonce}`, "Bed A");
      F.four = await establishBed(`D1-${nonce}`, "Bed A");
      observe("fixture: three further beds established under the fixture activation with confirmed-vacancy lineage", { units: [F.two.unit.unit_number, F.three.unit.unit_number, F.four.unit.unit_number] });
      F.other = await one("insert into properties (name,address,organization_id) values ($1,'2 Scope Wall',$2) returning id", [`TwoStep Other ${nonce}`, F.property.organization_id]);
      await q("insert into property_team_assignments (property_id,user_id,role_title,allowed_modules,primary_for_modules,active,can_manage_roles) values ($1,$2,'property_admin','{management,leasing}','{management}',true,true)", [F.other.id, F.kz.id]);
      F.kzTok = await session(F.kz.id, P);
      const signerCfg = await one("select lease_config->'execution_authority'->'company_signer_user_ids' as signers from properties where id=$1", [P]);
      need(Array.isArray(signerCfg.signers) && signerCfg.signers.map(String).includes(String(F.kz.id)), "KZ is a configured company signer", { signers: (signerCfg.signers || []).length });
      //  Two further staff shapes for the actor matrix, joined through the
      //  governed invite (real role presets), then adjusted ONLY in the
      //  property's signer configuration — a production configuration act.
      //   signerOnly   leasing_agent on the signer list, no approval authority
      //   approverOnly property_admin override, NOT on the signer list
      F.mikePhone = num(1);
      const mike = await inviteAndAccept({ token: F.kzTok, propertyId: P, phone: F.mikePhone, name: `Mike (rehearsal) ${nonce}`, role_key: "property_manager" });
      need(mike.verify && mike.verify.status === 200, "Mike joins through the governed invite and OTP as property_manager", { invite: mike.invite && mike.invite.status, verify: mike.verify && mike.verify.status });
      F.mike = { id: mike.verify.body.user.id, tok: mike.verify.body.session_token };
      const asg = await one("select role_key, can_manage_roles, allowed_modules from property_team_assignments where user_id=$1 and property_id=$2 and active", [F.mike.id, P]);
      check(asg && asg.role_key === "property_manager" && asg.can_manage_roles === false, "Mike: property_manager, no can_manage_roles", asg);
      const so = await inviteAndAccept({ token: F.kzTok, propertyId: P, phone: num(4), name: `Signer Only ${nonce}`, role_key: "leasing_agent" });
      need(so.verify && so.verify.status === 200, "a leasing_agent joins (will be placed on the signer list only)", { verify: so.verify && so.verify.status });
      F.signerOnly = { id: so.verify.body.user.id, tok: so.verify.body.session_token };
      const ao = await inviteAndAccept({ token: F.kzTok, propertyId: P, phone: num(5), name: `Approver Only ${nonce}`, role_key: "property_admin" });
      need(ao.verify && ao.verify.status === 200, "a property_admin joins (override, not a signer)", { verify: ao.verify && ao.verify.status });
      F.approverOnly = { id: ao.verify.body.user.id, tok: ao.verify.body.session_token };
      const aoAsg = await one("select can_manage_roles from property_team_assignments where user_id=$1 and property_id=$2 and active", [F.approverOnly.id, P]);
      check(aoAsg && aoAsg.can_manage_roles === true, "the approver-only actor holds the governed override");
      //  Fixture (configuration, before any leasing action): add the leasing
      //  agent to the signer list. KZ stays; approverOnly is NOT added.
      await q("update properties set lease_config = jsonb_set(lease_config, '{execution_authority,company_signer_user_ids}', (lease_config->'execution_authority'->'company_signer_user_ids') || to_jsonb($2::text)) where id=$1", [P, F.signerOnly.id]);
      const signers = await one("select lease_config->'execution_authority'->'company_signer_user_ids' as s from properties where id=$1", [P]);
      check(signers.s.map(String).includes(String(F.signerOnly.id)) && !signers.s.map(String).includes(String(F.approverOnly.id)), "signer list: KZ + the leasing agent; the approver-only admin is absent", { signers: signers.s.length });
    });
    need(F.mike && F.kzTok && F.signerOnly && F.approverOnly, "actors ready");

    const J1 = { label: "J1", index: 1, unit: F.unit3B, bed: F.bedB, rent: 1100, mode: "rollback" };
    const J2 = { label: "J2", index: 2, unit: F.two.unit, bed: F.two.bed, rent: 990, mode: "plain" };
    const J3 = { label: "J3", index: 3, unit: F.three.unit, bed: F.three.bed, rent: 1010, mode: "withdraw" };
    const J4 = { label: "J4", index: 4, unit: F.four.unit, bed: F.four.bed, rent: 1005, mode: "handoff" };
    await journey(J1);
    await journey(J2);
    await section("both leases stand", async () => {
      need(J1.leaseId && J2.leaseId, "both journeys executed");
      const l1 = await one("select lease_status, space_id from leases where id=$1", [J1.leaseId]);
      const l2 = await one("select lease_status, space_id from leases where id=$1", [J2.leaseId]);
      check(l1 && l1.lease_status === "pending" && l1.space_id === F.bedB.id && l2 && l2.lease_status === "pending" && l2.space_id === F.two.bed.id && l1.space_id !== l2.space_id, "two pending leases on two distinct beds; the first was never cancelled or reset");
      const total = await one("select count(*)::int n from leases where property_id=$1 and application_id in ($2,$3)", [P, J1.app, J2.app]);
      check(total.n === 2, "exactly two leases for the two applications");
    });
    await journey(J3);
    await journey(J4);

    await section("second property shape · incomplete setup refuses honestly", async () => {
      const tok = await session(F.kz.id, F.other.id);
      const cfg = await api("GET", "/operator/leasing/lease-configuration", { token: tok });
      observe("what the lease configuration read says for a property with no governing instrument", { status: cfg.status, body: cfg.body && JSON.stringify(cfg.body).slice(0, 300) });
      check(cfg.status === 200 || cfg.status === 404 || cfg.status === 409, "the configuration read answers rather than failing", { status: cfg.status });
      const starts = new Date(Date.now() + 5 * 86400000), ends = new Date(starts.getTime() + 3600000);
      const unit = await one("insert into units (property_id, unit_number) values ($1,$2) returning id", [F.other.id, `G1-${nonce}`]);
      const slot = await api("POST", "/leasing/availability", { token: tok, key: true, body: { property_id: F.other.id, starts_at: starts.toISOString(), ends_at: ends.toISOString(), unit_id: unit.id, leasing_agent_id: F.kz.id, capacity: 1, idempotency_key: `slot-other-${nonce}` } });
      check(slot.status === 422 && slot.body && slot.body.error === "property_operating_timezone_not_configured", "a property whose setup is incomplete names the missing input instead of publishing a tour time", { status: slot.status, error: slot.body && slot.body.error });
      const foreignExec = await api("POST", `/operator/leasing/lease-packets/${J2.packet}/execute`, { token: tok, body: { application_decision: "approve" } });
      check(foreignExec.status === 403 && foreignExec.body.error === "packet_not_at_your_property", "the other property's session cannot execute the first property's packet", { status: foreignExec.status });
    });
  } finally { await pool.end(); }
  current = "completion";
  check(F.leases.length === 2, "two journeys each completed with exactly two commercial decisions and one pending lease", { leases: F.leases.map((l) => l.label) });
  const summary = { passed: results.filter((r) => r.ok && r.kind === "check").length, failed, observations: results.filter((r) => r.kind === "observe").length, witness: WITNESS };
  if (process.env.PROOF_OUTPUT_DIR) fs.writeFileSync(path.join(process.env.PROOF_OUTPUT_DIR, `two_step_leasing.${process.env.PROOF_EVIDENCE_LABEL || "run"}.json`), JSON.stringify({ server: process.env.PROOF_SERVER_SHA || null, summary, results }, null, 2));
  console.log(`\ntwo-step leasing: ${summary.passed} passed, ${failed} failed, ${summary.observations} observations`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
