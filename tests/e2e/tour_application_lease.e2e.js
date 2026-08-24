/* Full real-server proof of the tenant leasing path:
   staff invite + OTP acceptance -> native slot -> booked tour -> post-tour
   capture -> exact-bed application SMS -> public application -> separate
   resident/guarantor execution -> authorized company execution -> exact-bed
   tenancy. Dashboard and staff SMS read the same personal Ask Spine answer.
   The E2E launcher forces fake_sms_preload.js, so no real SMS can leave. */
"use strict";

module.paths.unshift(require("path").join(__dirname, "..", "..", "node_modules"));
const fs = require("fs");
const { Pool } = require("pg");
const { databaseSsl } = require("../../src/shared/database_ssl");
const staffSessions = require("../../src/identity/staff_session_service");

if (process.env.E2E_DISPOSABLE_DATABASE !== "true") {
  console.error("FATAL: E2E_DISPOSABLE_DATABASE=true is required.");
  process.exit(1);
}

const CONN = process.env.E2E_DATABASE_URL;
const BASE = process.env.E2E_BASE_URL || "http://127.0.0.1:3000";
const SMS_LOG = process.env.E2E_SMS_LOG;
if (!CONN || !SMS_LOG) {
  console.error("FATAL: E2E_DATABASE_URL and E2E_SMS_LOG are required.");
  process.exit(1);
}

const pool = new Pool({ connectionString: CONN, ssl: databaseSsl(CONN) });
const q = (sql, params) => pool.query(sql, params);
let passed = 0;
let smsCursor = 0;
function pass(message, detail) {
  passed++;
  console.log(`  PASS ${String(passed).padStart(2, "0")}  ${message}${detail ? " | " + detail : ""}`);
}
function expect(condition, message, detail) {
  if (!condition) throw new Error(`${message}${detail ? ": " + detail : ""}`);
  pass(message, detail);
}
async function api(method, route, { token, key = false, body } = {}) {
  const headers = { "content-type": "application/json" };
  if (token) headers["x-staff-session"] = token;
  if (key) headers["x-operator-key"] = "e2e-key";
  const response = await fetch(BASE + route, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json().catch(() => null);
  return { status: response.status, body: data };
}
function requireOk(result, label) {
  if (result.status >= 400) {
    throw new Error(`${label} returned HTTP ${result.status}: ${JSON.stringify(result.body)}`);
  }
  return result.body;
}
async function completeLeaseSigner({ token, name, initials, sessionId }) {
  const packet = requireOk(await api("GET", `/t/lease/${token}/data`, { key: false }),
    `${name} lease packet read`);
  const requiredFields = ((packet.packet && packet.packet.fields) || [])
    .filter((field) => field.required);
  for (const field of requiredFields) {
    requireOk(await api("POST", `/t/lease/${token}/fields/${field.id}/complete`, {
      key: false,
      body: {
        value: field.field_type === "signature" ? name : initials,
        consent: field.field_type === "signature",
        session_id: sessionId,
      },
    }), `${name} field ${field.field_key}`);
  }
  const submissionResult = await api("POST", `/t/lease/${token}/submit`, {
    key: false, body: { session_id: sessionId },
  });
  const submitted = requireOk(submissionResult, `${name} lease submission`);
  return { packet, requiredFields, submitted, submissionResult };
}
function futureLeaseDates() {
  const start = new Date();
  start.setUTCDate(start.getUTCDate() + 30);
  const end = new Date(start);
  end.setUTCFullYear(end.getUTCFullYear() + 1);
  end.setUTCDate(end.getUTCDate() - 1);
  return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
}
function smsMessages() {
  if (!fs.existsSync(SMS_LOG)) return [];
  return fs.readFileSync(SMS_LOG, "utf8").trim().split(/\r?\n/).filter(Boolean)
    .map((line) => JSON.parse(line));
}
async function waitForSms(predicate, label) {
  for (let attempt = 0; attempt < 40; attempt++) {
    const messages = smsMessages();
    for (let index = smsCursor; index < messages.length; index++) {
      if (predicate(messages[index])) {
        smsCursor = index + 1;
        return messages[index];
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`the fake transport did not record ${label}`);
}
async function sendStaffSms({ from, to, body, sid }) {
  const payload = new URLSearchParams({
    MessageSid: sid,
    From: from,
    To: to,
    Body: body,
  });
  const response = await fetch(BASE + "/communications/inbound-sms", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: payload.toString(),
  });
  const text = await response.text();
  if (response.status >= 400) {
    throw new Error(`staff SMS returned HTTP ${response.status}: ${text}`);
  }
  return { status: response.status, body: text };
}
async function waitForStaffReply(providerMessageId) {
  for (let attempt = 0; attempt < 80; attempt++) {
    const reply = (await q(
      `select inbound.id as inbound_id, inbound.needs_human, inbound.classification,
              outbound.id as outbound_id, outbound.body, outbound.reply_reason,
              outbound.sms_status, outbound.sms_sid
        from comm_events inbound
         left join comm_events outbound on outbound.in_reply_to_comm_event_id = inbound.id
        where inbound.sms_sid = $1
        order by outbound.id desc nulls last
        limit 1`,
      [providerMessageId]
    )).rows[0];
    if (reply && reply.outbound_id) return reply;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Ask Spine did not record a reply for ${providerMessageId}`);
}

(async () => {
  console.log("\n== tour to exact-bed lease ==");
  const property = (await q(
    "select id,organization_id from properties where name='Skyline E2E' order by created_at desc limit 1"
  )).rows[0];
  expect(!!property, "Skyline-shaped disposable fixture exists");
  const propertyId = property.id;
  if (!property.organization_id) {
    const organization = (await q(
      `insert into organizations (name,slug)
       values ('Skyline E2E Organization','skyline-e2e-organization')
       on conflict (slug) do update set name=excluded.name
       returning id`
    )).rows[0];
    await q("update properties set organization_id=$2 where id=$1", [propertyId, organization.id]);
    property.organization_id = organization.id;
  }
  const unit = (await q(
    "select id, unit_number from units where property_id=$1 and unit_number='3B' limit 1",
    [propertyId]
  )).rows[0];
  const spaces = (await q(
    "select id, space_label from spaces where unit_id=$1 order by space_label",
    [unit.id]
  )).rows;
  const bedB = spaces.find((space) => space.space_label === "Bed B");
  expect(!!unit && !!bedB && spaces.length > 1, "fixture is genuinely by-bed", "Unit 3B / Bed B");

  await q("update properties set operating_timezone='America/New_York' where id=$1", [propertyId]);
  await q("update spaces set use_type='residential' where unit_id=$1", [unit.id]);
  await q("update lease_applications set executed_lease_record_id=null where property_id=$1", [propertyId]);
  await q(`delete from executed_lease_admission_evaluations
            where executed_lease_record_id in
              (select id from executed_lease_records where property_id=$1)`, [propertyId]);
  await q("delete from executed_lease_records where property_id=$1", [propertyId]);
  await q("delete from leases where property_id=$1", [propertyId]);

  const companySigner = (await q(
    "select id,person_id from users where name='Mike Grivna' and is_active=true limit 1"
  )).rows[0];
  expect(!!companySigner, "configured company signer fixture exists");
  const suffix = String(Date.now()).slice(-7);
  const mikePhone = "+1312" + suffix;
  const operationsLine = "+12125550172";
  await q("delete from communication_lines where property_id=$1", [propertyId]);
  await q(`insert into communication_lines
             (e164,line_type,property_id,authority_ceiling,permitted_audience,
              inbound_enabled,outbound_enabled,outbound_policy,status)
           values ('+12155559999','property_facing',$1,'external','residents_and_prospects',
                   true,true,'proactive','active')`, [propertyId]);
  await q(`update communication_lines
              set status='retired', inbound_enabled=false,
                  outbound_policy='disabled', outbound_enabled=false
            where (organization_id=$1 and line_type='operations') or e164=$2`,
    [property.organization_id, operationsLine]);
  await q(`insert into communication_lines
             (e164,line_type,organization_id,authority_ceiling,permitted_audience,
              inbound_enabled,outbound_enabled,outbound_policy,status)
           values ($1,'operations',$2,'operational','staff',true,true,'reply_only','active')`,
    [operationsLine, property.organization_id]);

  smsCursor = smsMessages().length;
  const sessionClient = await pool.connect();
  let companyToken;
  try {
    await sessionClient.query("begin");
    const issued = await staffSessions.issueStaffSession(sessionClient, {
      userId: companySigner.id, propertyId, purpose: "bootstrap_invite",
    });
    companyToken = issued.session_token || issued.token;
    await sessionClient.query("commit");
  } catch (error) {
    await sessionClient.query("rollback").catch(() => {});
    throw error;
  } finally {
    sessionClient.release();
  }

  const mikePerson = (await q(
    `insert into persons (name,phone,primary_phone_e164,lifecycle_status,source)
     values ('Mike Grivna',$1,$1,'lead','team_invite_fixture') returning id`,
    [mikePhone]
  )).rows[0];
  const invited = requireOk(await api("POST", `/properties/${propertyId}/team-invites`, {
    token: companyToken,
    body: {
      invited_name: "Mike Grivna", phone_number: mikePhone,
      role_key: "leasing_agent", scope_type: "property", person_id: mikePerson.id,
    },
  }), "Mike staff invite");
  expect(invited.delivery === "sms_sent" && invited.person_id === mikePerson.id,
    "the governed invite texts the manager-confirmed Person");
  const inviteToken = String(invited.link || "").split("/join/")[1];
  const inviteText = await waitForSms(
    (message) => message.to === mikePhone && /\/join\//.test(message.body || ""),
    "the staff invitation"
  );
  expect(!!inviteToken && inviteText.to === mikePhone,
    "the fake carrier records the exact invite without reaching a phone");
  const joinResponse = await fetch(invited.link, { redirect: "error" });
  const joinHtml = await joinResponse.text();
  expect(joinResponse.status === 200
      && /Set up your Property Spine access/i.test(joinHtml)
      && !/Missing or wrong x-operator-key/i.test(joinHtml),
    "the literal text link reaches the public staff acceptance door without an operator key");

  const otpStarted = requireOk(await api("POST", "/auth/sms/start", {
    body: { token: inviteToken },
  }), "Mike invite OTP start");
  expect(otpStarted.delivery === "sms_sent" && otpStarted.flow === "invite_accept",
    "the invite uses the shared phone-verification door");
  const otpText = await waitForSms(
    (message) => message.to === mikePhone && /access code is \d{6}/.test(message.body || ""),
    "the staff access code"
  );
  const otpCode = String(otpText.body || "").match(/access code is (\d{6})/)[1];
  const accepted = requireOk(await api("POST", "/auth/sms/verify", {
    body: { token: inviteToken, code: otpCode },
  }), "Mike invite acceptance");
  const staffToken = accepted.session_token;
  const mike = { id: accepted.user.id, person_id: accepted.person_id };
  expect(accepted.person_id === mikePerson.id && accepted.role_key === "leasing_agent",
    "one acceptance returns Mike's confirmed identity and canonical leasing role");

  const me = requireOk(await api("GET", "/operator/me", { token: staffToken }), "operator session");
  expect(me.property_id === propertyId, "accepted staff session is bound to the fixture property");
  const acceptedIdentity = (await q(
    `select u.person_id, pta.primary_for_modules,
            exists(select 1 from person_contexts pc
                    where pc.person_id=u.person_id and pc.property_id=pta.property_id
                      and pc.context_type='staff' and pc.active_to is null) as has_staff_context,
            exists(select 1 from assignments a
                    where a.person_id=u.person_id and a.property_id=pta.property_id
                      and a.role='leasing' and a.is_active=true) as has_leasing_assignment
       from users u
       join property_team_assignments pta on pta.user_id=u.id and pta.property_id=$2
      where u.id=$1`,
    [mike.id, propertyId]
  )).rows[0];
  expect(acceptedIdentity && acceptedIdentity.person_id === mikePerson.id
      && acceptedIdentity.has_staff_context && acceptedIdentity.has_leasing_assignment
      && acceptedIdentity.primary_for_modules.includes("leasing"),
    "acceptance creates Mike's bridge, staff context, access, and work assignment together");

  const name = `Skyline Journey ${suffix}`;
  const phone = "+1215" + suffix;
  const intake = requireOk(await api("POST", "/leasing/intake", { body: {
    intake_secret: "e2e-intake", property_id: propertyId, name, phone,
    email: `skyline-${suffix}@example.com`, source: "e2e", attempt_sms: false,
  }}), "prospect intake");
  expect(!!intake.person_id && !!intake.lead_id, "prospect entered through canonical intake");
  await q(`insert into contact_preferences
             (person_id,channel,consent_state,source,updated_at)
           values ($1,'text','opted_in','internal_qa_enrollment',now())
           on conflict (person_id,channel) do update
             set consent_state='opted_in',source='internal_qa_enrollment',updated_at=now()`,
    [intake.person_id]);

  const starts = new Date(Date.now() + 3 * 86400000);
  const ends = new Date(starts.getTime() + 60 * 60000);
  const opened = requireOk(await api("POST", "/leasing/availability", { token: staffToken, key: true, body: {
    property_id: propertyId, starts_at: starts.toISOString(), ends_at: ends.toISOString(),
    unit_id: unit.id, leasing_agent_id: mike.id, capacity: 1,
    idempotency_key: `journey-slot-${suffix}`,
  }}), "publish native tour time");
  expect(opened.slot && opened.slot.id, "native scheduler published a 60-minute Mike slot");

  const booked = requireOk(await api("POST", `/leasing/slots/${opened.slot.id}/book`, {
    token: staffToken, key: true,
    body: { lead_id: intake.lead_id, idempotency_key: `journey-book-${suffix}` },
  }), "book native tour slot");
  expect(!!booked.tour_id && booked.slot_id === opened.slot.id, "prospect booked onto that exact slot");

  requireOk(await api("POST", `/leasing/tours/${booked.tour_id}/check-in`, {
    key: true, body: { actor_id: mike.id },
  }), "tour check-in");

  const vagueSid = `SM_E2E_VAGUE_${suffix}`;
  const vagueAck = await sendStaffSms({
    from: mikePhone,
    to: operationsLine,
    sid: vagueSid,
    body: `${name}'s Skyline E2E tour went really well. Send the application.`,
  });
  expect(vagueAck.status === 200 && /<Response><\/Response>/.test(vagueAck.body),
    "the real operations webhook acknowledges Mike's first text");
  const vagueReply = await waitForStaffReply(vagueSid);
  expect(vagueReply.reply_reason === "clarification"
      && /Ready to Apply, Hot Lead, Possible, or Not Moving Forward/.test(vagueReply.body),
    "Ask Spine asks for the canonical standing instead of guessing from 'went well'");
  const stillOpen = (await q(
    "select status,completed_at from leasing_tours where id=$1", [booked.tour_id]
  )).rows[0];
  expect(stillOpen.status !== "completed" && !stillOpen.completed_at,
    "the vague text records no tour outcome");

  const captureSid = `SM_E2E_CAPTURE_${suffix}`;
  await sendStaffSms({
    from: mikePhone,
    to: operationsLine,
    sid: captureSid,
    body: `${name}'s Skyline E2E tour is done. They are Ready to Apply. Send the application.`,
  });
  const captureReply = await waitForStaffReply(captureSid);
  expect(captureReply.reply_reason === "execution_receipt"
      && /Recorded .* tour as Ready to Apply/.test(captureReply.body),
    "Mike's second text records the explicit post-tour standing through Ask Spine");
  expect(/Unit 3B/.test(captureReply.body) && /Unit 3B, Bed B/.test(captureReply.body),
    "Ask Spine returns the exact-bed menu instead of choosing for Mike");

  const completed = (await q(
    `select id as conversion_id from leasing_conversions
      where origin_tour_id=$1 and property_id=$2`,
    [booked.tour_id, propertyId]
  )).rows[0];
  expect(!!completed && !!completed.conversion_id,
    "the staff text opened the canonical application conversion");
  const captureEvent = (await q(
    `select metadata from tour_events where tour_id=$1 and event_type='completed' order by event_at desc limit 1`,
    [booked.tour_id]
  )).rows[0];
  expect(captureEvent && captureEvent.metadata.standing === "ready_to_apply",
    "the agent's ready-to-apply judgment was recorded as truth");
  const followupOwner = (await q(
    `select lco.owner_user_id, o.assigned_user_id
       from leasing_conversion_obligations lco
       join obligations o on o.id=lco.obligation_id
      where lco.conversion_id=$1 and lco.rung='tour_followup' and lco.outcome is null`,
    [completed.conversion_id]
  )).rows[0];
  expect(followupOwner && followupOwner.owner_user_id === mike.id
      && followupOwner.assigned_user_id === mike.id,
    "post-tour follow-up reaches Mike through the canonical obligations queue");
  const personalAttention = requireOk(await api("POST", "/operator/ask-spine/ask", {
    token: staffToken, body: { question: "What should I do today?" },
  }), "personal Ask Spine read after the tour");
  expect(personalAttention.outcome === "answered"
      && personalAttention.grounded_on.attention_scope === "personal"
      && personalAttention.grounded_on.personal_open_items >= 1,
    "Mike's Ask Spine answer is grounded in his canonical personal queue");
  const attentionSid = `SM_E2E_ATTENTION_${suffix}`;
  await sendStaffSms({
    from: mikePhone,
    to: operationsLine,
    sid: attentionSid,
    body: "What should I do today?",
  });
  const smsAttention = await waitForStaffReply(attentionSid);
  expect(smsAttention.reply_reason === "governed_read"
      && smsAttention.body === personalAttention.answer,
    "dashboard and staff SMS return the same personal Ask Spine answer");

  const targets = requireOk(await api("GET", "/operator/leasing/leaseable-units", {
    token: staffToken,
  }), "leaseable target read");
  const chosen = (targets.eligible_targets || []).find(
    (target) => target.unit_id === unit.id && target.space_id === bedB.id
  );
  expect(!!chosen && chosen.resolution_basis === "chosen_space",
    "the application selector offers exact Bed B instead of guessing");

  const targetSid = `SM_E2E_TARGET_${suffix}`;
  await sendStaffSms({
    from: mikePhone,
    to: operationsLine,
    sid: targetSid,
    body: `Skyline E2E: send ${name} the application for Unit 3B, Bed B.`,
  });
  const targetReply = await waitForStaffReply(targetSid);
  expect(targetReply.reply_reason === "execution_receipt"
      && /Application sent to .* for Unit 3B, Bed B/.test(targetReply.body),
    "Mike's exact-bed reply invokes the canonical application send command");
  const invitation = (await q(
    `select id,conversion_id,unit_id,space_id,status
       from application_invitations
      where conversion_id=$1
      order by created_at desc limit 1`,
    [completed.conversion_id]
  )).rows[0];
  expect(invitation && invitation.unit_id === unit.id && invitation.space_id === bedB.id,
    "the staff-text application invitation persists exact Bed B");
  expect(invitation.status === "provider_dispatched",
    "the provider acceptance is recorded separately from Ask Spine's reply to Mike");
  const sms = await waitForSms(
    (message) => message.to === phone && /\/t\/application\//.test(message.body || ""),
    "the application text"
  );
  expect(sms.to === phone, "the application text was addressed to the prospect in the fake transport");
  const tokenMatch = String(sms.body).match(/\/t\/application\/([A-Za-z0-9_-]+)/);
  expect(!!tokenMatch, "the captured text contains the public application token");
  const applicationToken = tokenMatch[1];

  const context = requireOk(await api("GET", `/t/application/${applicationToken}/context`, {
    key: false,
  }), "public application context");
  expect(context.state === "open" && /Bed B/.test(context.unit_label || ""),
    "the tenant sees the exact home attached to the invitation");
  const guarantorName = `Skyline Guarantor ${suffix}`;
  const guarantorPhone = "+1412" + suffix;
  const captured = {
    application_form_version: "tenant_v3",
    date_of_birth: "1995-04-12", email: `skyline-${suffix}@example.com`, phone,
    address: { line1: "100 Test Street", line2: "", city: "Philadelphia", state: "PA", postal_code: "19147" },
    current_since: "2024-01", housing_status: "rent",
    income_status: "employed", employer: "Test Employer", job_title: "Analyst",
    income_amount: 72000, income_frequency: "annual", income_notes: "",
    desired_move_in: futureLeaseDates().start, move_flexibility: "plus_minus_7",
    occupants: 1, household_names: "", has_pets: "no", pets: "None",
    guarantor_needed: "yes",
    guarantor_contact: {
      name: guarantorName,
      phone: guarantorPhone,
      email: `guarantor-${suffix}@example.com`,
    },
    additional_notes: "",
    applicant_accuracy_certified: true,
    electronic_delivery_consent: true,
  };
  const conflictingGuarantor = await api("POST", "/applications/submit-public", {
    key: false,
    body: {
      token: applicationToken,
      applicant_name: name,
      guarantor_name: `Wrong Guarantor ${suffix}`,
      captured,
    },
  });
  expect(conflictingGuarantor.status === 400
      && /conflicts with the guarantor contact/.test(
        String(conflictingGuarantor.body && conflictingGuarantor.body.receipt || "")),
    "a contradictory V3 guarantor name is refused before application birth");
  const submitted = requireOk(await api("POST", "/applications/submit-public", {
    key: false,
    body: { token: applicationToken, applicant_name: name, captured },
  }), "public application submit");
  const appId = submitted.application && submitted.application.id;
  const appRow = (await q(
    "select id,conversion_id,unit_id,space_id,status from lease_applications where id=$1",
    [appId]
  )).rows[0];
  expect(appRow && appRow.conversion_id === completed.conversion_id,
    "the tenant application remains attached to the post-tour conversion");
  expect(appRow.unit_id === unit.id && appRow.space_id === bedB.id,
    "the tenant application persists exact Bed B");
  expect((await q("select guarantor_name from lease_applications where id=$1", [appId])).rows[0].guarantor_name
      === guarantorName,
    "the application derives the named guarantor from the validated V3 capture");

  const mikeApproval = await api("POST", `/operator/leasing/applications/${appId}/approve`, {
    token: staffToken, body: {},
  });
  expect(mikeApproval.status === 403,
    "Mike's leasing role cannot approve the application it helped collect");
  requireOk(await api("POST", `/operator/leasing/applications/${appId}/approve`, {
    token: companyToken, body: {},
  }), "authorized application approval");
  const dates = futureLeaseDates();
  requireOk(await api("POST", `/operator/leasing/applications/${appId}/proposed-terms`, {
    token: companyToken, body: {
      rent: 1025, security_deposit: 1025,
      lease_start_date: dates.start, lease_end_date: dates.end,
      concession_status: "none", idempotency_key: `journey-terms-${suffix}`,
    },
  }), "proposed terms confirmation");
  const generated = requireOk(await api(
    "POST", `/operator/leasing/applications/${appId}/lease-packet`, {
      token: companyToken, body: {},
    }
  ), "lease packet generation");
  const packetId = generated.packet && generated.packet.id;
  expect(!!packetId, "governing lease packet was generated from confirmed terms");
  const issued = requireOk(await api("POST", `/operator/leasing/lease-packets/${packetId}/send`, {
    token: companyToken, body: { idempotency_key: `journey-lease-${suffix}` },
  }), "resident and guarantor lease-link issue");
  const signingLinks = Object.fromEntries((issued.signing_links || [])
    .map((link) => [link.signer_role, link]));
  const leaseToken = String(signingLinks.tenant && signingLinks.tenant.url || "")
    .split("/t/lease/")[1];
  const guarantorToken = String(signingLinks.guarantor && signingLinks.guarantor.url || "")
    .split("/t/lease/")[1];
  expect(!!leaseToken && !!guarantorToken && leaseToken !== guarantorToken,
    "one package issues separate resident and guarantor secrets");

  const residentBeforeRoleProbe = requireOk(await api("GET", `/t/lease/${leaseToken}/data`, {
    key: false,
  }), "resident packet before signer-role isolation probe");
  const guarantorBeforeRoleProbe = requireOk(await api("GET", `/t/lease/${guarantorToken}/data`, {
    key: false,
  }), "guarantor packet before signer-role isolation probe");
  const residentSignerName = residentBeforeRoleProbe.packet
    && residentBeforeRoleProbe.packet.current_signer
    && residentBeforeRoleProbe.packet.current_signer.display_name;
  const guarantorSignature = guarantorBeforeRoleProbe.packet
    && (guarantorBeforeRoleProbe.packet.fields || [])
      .find((field) => field.required && field.field_type === "signature");
  expect(!!residentSignerName && !!guarantorSignature,
    "both signer names and the guarantor signature field exist before completion");
  const crossRoleCompletion = await api(
    "POST", `/t/lease/${leaseToken}/fields/${guarantorSignature.id}/complete`, {
      key: false,
      body: {
        value: residentSignerName, consent: true,
        session_id: `resident-cross-role-${suffix}`,
      },
    }
  );
  const crossRoleStored = (await q(
    `select field_key,completed,field_value,signed_by_person_id,signed_by_packet_signer_id
       from lease_packet_fields where id=$1`, [guarantorSignature.id]
  )).rows[0];
  const crossRoleAudits = Number((await q(
    `select count(*)::int n from lease_packet_audit_events
      where lease_packet_id=$1 and event_type='field_completed'
        and event_json->>'field_key'=$2`, [packetId, crossRoleStored.field_key]
  )).rows[0].n);
  expect(crossRoleCompletion.status === 404
      && crossRoleStored.completed === false
      && crossRoleStored.field_value == null
      && crossRoleStored.signed_by_person_id == null
      && crossRoleStored.signed_by_packet_signer_id == null
      && crossRoleAudits === 0,
    "a resident token cannot complete the guarantor's required signature field",
    `HTTP ${crossRoleCompletion.status} body=${JSON.stringify(crossRoleCompletion.body)} ` +
      `stored=${JSON.stringify(crossRoleStored)} audits=${crossRoleAudits}`);

  const guarantorSigning = await completeLeaseSigner({
    token: guarantorToken, name: guarantorName, initials: "SG",
    sessionId: `guarantor-${suffix}`,
  });
  expect(guarantorSigning.requiredFields.length > 0
      && guarantorSigning.requiredFields.every((field) => field.signer_role === "guarantor"),
    "the guarantor sees and completes only guarantor controls");
  const termsReviewObligationId = (await q(
    "select terms_review_obligation_id from lease_applications where id=$1", [appId]
  )).rows[0].terms_review_obligation_id;
  const guarantorFirstPacket = (await q(
    "select status,resident_executed_at from lease_packets where id=$1", [packetId]
  )).rows[0];
  const guarantorFirstSigners = (await q(
    `select id,signer_role,display_name,submitted_at from lease_packet_signers
      where lease_packet_id=$1 order by signer_role`, [packetId]
  )).rows;
  const guarantorFirstObligation = (await q(
    `select id,status,required_inputs,completed_at from obligations where id=$1`,
    [termsReviewObligationId]
  )).rows[0];
  const guarantorFirstEvidence = (await q(
    `select id,type,note,occurred_at from events
      where type='input_satisfied:terms_acknowledged'
        and note like '%' || $1::text || '%'
      order by occurred_at,id`, [termsReviewObligationId]
  )).rows;
  const guarantorSignerAfterFirst = guarantorFirstSigners
    .find((signer) => signer.signer_role === "guarantor");
  const tenantSignerAfterFirst = guarantorFirstSigners
    .find((signer) => signer.signer_role === "tenant");
  const guarantorFirstState = {
    submit_http: guarantorSigning.submissionResult,
    packet: guarantorFirstPacket,
    signers: guarantorFirstSigners,
    obligation: guarantorFirstObligation,
    evidence: guarantorFirstEvidence,
  };
  expect(guarantorSigning.submitted.packet.status === "tenant_in_progress"
      && guarantorFirstPacket.status === "tenant_in_progress"
      && guarantorFirstPacket.resident_executed_at == null
      && !!guarantorSignerAfterFirst && !!guarantorSignerAfterFirst.submitted_at
      && !!tenantSignerAfterFirst && tenantSignerAfterFirst.submitted_at == null
      && !!guarantorFirstObligation
      && ["open", "in_progress"].includes(guarantorFirstObligation.status)
      && (guarantorFirstObligation.required_inputs || []).includes("terms_acknowledged")
      && guarantorFirstObligation.completed_at == null
      && guarantorFirstEvidence.length === 0,
    "guarantor-first submission leaves the applicant terms-review work open",
    JSON.stringify(guarantorFirstState));

  const waitingReviewResult = await api(
    "GET", `/operator/leasing/application-review?application_id=${appId}`, { token: staffToken }
  );
  const waitingReview = requireOk(waitingReviewResult,
    "application review while the resident is outstanding");
  expect(waitingReview.execution_primary_action
      && waitingReview.execution_primary_action.action === "await_resident_execution"
      && waitingReview.execution_primary_action.reason.includes(name),
    "Application Records names the outstanding resident after guarantor-first submission",
    JSON.stringify({ http: waitingReviewResult, action: waitingReview.execution_primary_action,
      guarantor_first: guarantorFirstState }));
  const prematureCompany = await api(
    "POST", `/operator/leasing/lease-packets/${packetId}/company-sign`, {
      token: companyToken, body: {},
    }
  );
  expect(prematureCompany.status === 409,
    "the authorized company signer is blocked while the resident is outstanding",
    JSON.stringify({ http: prematureCompany, review: waitingReview.execution_primary_action,
      guarantor_first: guarantorFirstState }));

  const residentSigning = await completeLeaseSigner({
    token: leaseToken, name, initials: "SJ", sessionId: `resident-${suffix}`,
  });
  expect(residentSigning.requiredFields.length > 0
      && residentSigning.requiredFields.every((field) => field.signer_role === "tenant"),
    "the resident sees and completes only resident controls");
  const residentPacket = (await q(
    "select status,resident_executed_at from lease_packets where id=$1", [packetId]
  )).rows[0];
  const signerState = (await q(
    `select id,signer_role,display_name,submitted_at from lease_packet_signers
      where lease_packet_id=$1 order by signer_role`, [packetId]
  )).rows;
  const residentObligation = (await q(
    `select id,status,required_inputs,completed_at from obligations where id=$1`,
    [termsReviewObligationId]
  )).rows[0];
  const residentEvidence = (await q(
    `select id,type,note,occurred_at from events
      where type='input_satisfied:terms_acknowledged'
        and note like '%' || $1::text || '%'
      order by occurred_at,id`, [termsReviewObligationId]
  )).rows;
  const tenantSigner = signerState.find((signer) => signer.signer_role === "tenant");
  const guarantorSigner = signerState.find((signer) => signer.signer_role === "guarantor");
  const residentProofNote = String(residentEvidence[0] && residentEvidence[0].note || "");
  const residentCompletedState = {
    submit_http: residentSigning.submissionResult,
    packet: residentPacket,
    signers: signerState,
    obligation: residentObligation,
    evidence: residentEvidence,
  };
  expect(residentSigning.submitted.packet.status === "resident_executed"
      && residentPacket.status === "resident_executed" && !!residentPacket.resident_executed_at
      && signerState.length === 2 && signerState.every((signer) => !!signer.submitted_at)
      && residentObligation.status === "complete"
      && (residentObligation.required_inputs || []).length === 0
      && !!residentObligation.completed_at
      && residentEvidence.length === 1
      && residentProofNote.includes(`"terms_review_obligation_id":"${termsReviewObligationId}"`)
      && residentProofNote.includes('"signer_role":"tenant"')
      && residentProofNote.includes(`"packet_signer_id":"${tenantSigner && tenantSigner.id}"`)
      && !residentProofNote.includes(`"packet_signer_id":"${guarantorSigner && guarantorSigner.id}"`),
    "resident submission closes the exact terms-review obligation with tenant evidence",
    JSON.stringify(residentCompletedState));
  expect(signerState.length === 2 && signerState.every((signer) => !!signer.submitted_at),
    "both resident-side submissions are recorded on the same packet");
  expect(residentPacket.status === "resident_executed" && !!residentPacket.resident_executed_at,
    "the package becomes company-signable only after both submissions");
  expect((await q("select count(*)::int n from persons where name=$1", [guarantorName])).rows[0].n === 0,
    "the guarantor remains packet-scoped instead of becoming a fabricated Person");

  const review = requireOk(await api(
    "GET", `/operator/leasing/application-review?application_id=${appId}`, { token: staffToken }
  ), "application review after resident and guarantor signatures");
  expect(review.execution_primary_action && review.execution_primary_action.action === "company_execute_lease",
    "the review surface now asks the authorized company signer to finish");
  const unauthorizedCompany = await api(
    "POST", `/operator/leasing/lease-packets/${packetId}/company-sign`, {
      token: staffToken, body: {},
    }
  );
  expect(unauthorizedCompany.status === 403,
    "Mike's leasing access cannot substitute for company signing authority");

  const executed = requireOk(await api(
    "POST", `/operator/leasing/lease-packets/${packetId}/company-sign`, {
      token: companyToken, body: {},
    }
  ), "company lease execution");
  const leaseId = executed.tenancy && executed.tenancy.lease_id;
  expect(!!leaseId, "company signing creates the tenancy in the same act");
  const lease = (await q(
    `select id,space_id,lease_status,rent,security_deposit,start_date,end_date
       from leases where id=$1`, [leaseId]
  )).rows[0];
  expect(lease && lease.space_id === bedB.id, "the executed tenancy is anchored to exact Bed B");
  expect(Number(lease.rent) === 1025 && Number(lease.security_deposit) === 1025,
    "the tenancy carries the confirmed economics");

  const finalReview = requireOk(await api(
    "GET", `/operator/leasing/application-review?application_id=${appId}`, { token: staffToken }
  ), "final application review");
  expect(finalReview.execution_primary_action && finalReview.execution_primary_action.action === "term_confirmed",
    "the staff surface rereads the executed lease as complete");
  const card = requireOk(await api(
    "GET", `/operator/leasing/person-card?person_id=${intake.person_id}`, { token: staffToken }
  ), "final person card");
  expect(card.leasing_standing && card.leasing_standing.tenancy
      && card.leasing_standing.tenancy.lease_id === leaseId,
    "the person card reads the same executed lease truth");

  console.log(`\n==== ${passed} full-path assertions passed; no real SMS sent ====\n`);
})().catch((error) => {
  console.error("\nFIRST RED:", error.message);
  console.error(error.stack);
  process.exitCode = 1;
}).finally(async () => {
  await pool.end().catch(() => {});
});

