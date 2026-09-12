"use strict";

// Class 3: owned real DB + authenticated HTTP state witness for the website
// inquiry capture path.
//
// This proof stays on the existing intake, conversation, takeover, Person Card,
// and Ask Spine surfaces. It does not create a parallel website workflow. The
// only direct writes are ordinary fixture setup: staff/property/source rows and
// one historical ready draft seeded before the follow-up POST. Runtime,
// database, provider, and deployment ownership belongs to the proof launcher.
//
// The closed-conversion lifecycle is intentionally not invented here. This
// witness has no named conversion to close or reopen; the existing lifecycle
// helper remains the owner of that separate boundary.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const { randomUUID } = require("node:crypto");
const { Pool } = require("pg");
const boundary = require("../e2e/proof_boundary");
require("../e2e/proof_fence_preload");
const staffSessions = require("../../src/identity/staff_session_service");

(async () => {
  await boundary.assertDatabase();
  const manifest = boundary.manifest();
  const base = (process.env.E2E_API_BASE || `http://127.0.0.1:${manifest.port}`).replace(/\/+$/, "");
  await boundary.waitServer(base);

  const pool = new Pool({ connectionString: manifest.url, ssl: false });
  let checks = 0;
  const check = (value, label) => {
    assert.ok(value, label);
    checks += 1;
    console.log(`PASS ${label}`);
  };
  const one = async (sql, args = []) => (await pool.query(sql, args)).rows[0] || null;
  const many = async (sql, args = []) => (await pool.query(sql, args)).rows;
  const logText = (envName) => {
    const file = process.env[envName];
    assert(file, `${envName} is required for the transport/model negative control`);
    return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  };

  const request = async (method, path, { body, token, headers = {} } = {}) => {
    const h = { ...headers };
    if (token) h["x-staff-session"] = token;
    if (body !== undefined) h["content-type"] = "application/json";
    const response = await fetch(base + path, {
      method,
      headers: h,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    let parsed = null;
    try { parsed = await response.json(); } catch (_) { /* preserve status */ }
    return { status: response.status, body: parsed };
  };

  const intake = (body, key) => request("POST", "/leasing/intake", {
    body,
    headers: {
      "x-intake-secret": process.env.E2E_INTAKE_SECRET || "e2e-intake",
      "Idempotency-Key": key,
    },
  });
  const staff = (token, method, path, body) => request(method, path, {
    token,
    ...(body !== undefined ? { body } : {}),
  });

  try {
    const property = await one(
      "select id, name from properties where name='Skyline E2E' order by created_at desc limit 1",
    );
    assert(property, "owned Skyline E2E property fixture is required");

    const tag = randomUUID();
    const sourceName = `Website state ${tag}`;
    const prospectName = `Website Prospect ${tag.slice(0, 8)}`;
    const prospectEmail = `${tag}@example.invalid`;
    const sourceLeadId = `squarespace-state-${tag}`;
    const originalMessage = `Original website question ${tag.slice(0, 8)} about cats and a two-bedroom.`;
    const followupMessage = `Website follow-up ${tag.slice(0, 8)} asks for the floor plan.`;
    await pool.query("insert into lead_sources(name, source_type) values($1, 'website')", [sourceName]);

    const createStaff = async ({ propertyId, modules, name }) => {
      const person = await one("insert into persons(name) values($1) returning id", [`${name} ${tag.slice(0, 8)}`]);
      const user = await one(
        `insert into users(name, role, is_active, status, account_kind, person_id)
         values($1, 'leasing_agent', true, 'active', 'human_staff', $2) returning id`,
        [`${name} ${tag.slice(0, 8)}`, person.id],
      );
      await pool.query(
        `insert into property_team_assignments
           (user_id, property_id, role_title, allowed_modules, primary_for_modules, active)
         values($1, $2, 'Property Staff', $3::text[], $3::text[], true)`,
        [user.id, propertyId, modules],
      );
      const issued = await staffSessions.issueStaffSession(pool, {
        userId: user.id, propertyId, purpose: "bootstrap_invite",
      });
      return { id: user.id, token: issued.session_token || issued.token };
    };

    const owner = await createStaff({ propertyId: property.id, modules: ["leasing"], name: "Website owner" });
    const maintenance = await createStaff({ propertyId: property.id, modules: ["maintenance"], name: "Website maintenance" });
    const foreignProperty = await one(
      "insert into properties(name) values($1) returning id, name",
      [`Foreign website property ${tag}`],
    );
    const foreign = await createStaff({ propertyId: foreignProperty.id, modules: ["leasing"], name: "Foreign leasing" });

    const prospect = {
      property_id: property.id,
      name: prospectName,
      email: prospectEmail,
      source: sourceName,
      source_lead_id: sourceLeadId,
      source_listing_id: `skyline-state-listing-${tag}`,
      message: originalMessage,
      attempt_sms: false,
      sms_consent: false,
      response_channel: "website",
      raw_payload: {
        form: "native_squarespace_leasing",
        interest: "two-bedroom",
        message: originalMessage,
        submission_id: tag,
      },
    };

    const first = await intake(prospect, `website-state-${tag}-first`);
    check(first.status === 200 && first.body?.capture?.state === "captured"
      && first.body.replayed === false && first.body.conversation_id,
    "website inquiry creates one canonical capture receipt and conversation");
    check(first.body.first_response_sent === false
      && first.body.capture.response_state === "not_required"
      && !Object.prototype.hasOwnProperty.call(prospect, "phone"),
    "email-only website capture makes no text-send claim");

    const conversationId = first.body.conversation_id;
    const firstState = await one(
      `select mode, thread_version, latest_inbound_comm_event_id, current_review_obligation_id
         from agent_thread_state where conversation_id=$1`,
      [conversationId],
    );
    check(firstState && firstState.mode === "ai_active" && Number(firstState.thread_version) === 1
      && firstState.latest_inbound_comm_event_id,
    "the first website message advances the existing thread exactly once");

    const sourceLinks = await many(
      `select ce.id as comm_event_id, ce.channel, ce.direction, ce.sender_role,
              ce.provider, ce.provider_event_id, le.id as lead_event_id,
              le.comm_event_id as linked_event_id, lst.id as source_touch_id
         from comm_events ce
         join lead_events le on le.comm_event_id=ce.id and le.event_type='lead_received'
         join lead_source_touches lst on lst.id::text=ce.provider_event_id
        where ce.conversation_id=$1
        order by ce.occurred_at asc, ce.id asc`,
      [conversationId],
    );
    check(sourceLinks.length === 1 && sourceLinks[0].channel === "website"
      && sourceLinks[0].direction === "inbound" && sourceLinks[0].sender_role === "prospect"
      && sourceLinks[0].provider === "leasing_intake"
      && String(sourceLinks[0].provider_event_id) === String(sourceLinks[0].source_touch_id)
      && sourceLinks[0].linked_event_id === sourceLinks[0].comm_event_id,
    "the website communication is linked to its source touch and lead event");

    const countState = async () => {
      const row = await one(
        `select
           (select count(*)::int from lead_source_touches where lead_id=$1) as touches,
           (select count(*)::int from lead_events where lead_id=$1 and event_type='lead_received') as received,
           (select count(*)::int from comm_events where conversation_id=$2 and channel='website') as website_events,
           (select thread_version from agent_thread_state where conversation_id=$2) as thread_version`,
        [first.body.lead_id, conversationId],
      );
      return {
        touches: Number(row.touches), received: Number(row.received),
        websiteEvents: Number(row.website_events), threadVersion: Number(row.thread_version),
      };
    };
    const afterFirst = await countState();
    const initialQueue = await staff(owner.token, "GET", "/operator/leasing/conversation-queue");
    const initialQueueRow = (initialQueue.body?.conversations || [])
      .find((row) => row.conversation_id === conversationId);
    check(initialQueue.status === 200 && initialQueueRow
      && initialQueueRow.control_mode === "ai_active"
      && initialQueueRow.waiting_on === "manager"
      && initialQueueRow.control_bucket === "needs_you"
      && initialQueueRow.bucket_reason_code === "website_inquiry_pending_human"
      && initialQueueRow.control_bucket !== "ai_working",
    "an unclaimed email-only website inquiry is queued for the manager as needs_you");
    const replay = await intake(JSON.parse(JSON.stringify(prospect)), `website-state-${tag}-first`);
    check(replay.status === 200 && replay.body?.replayed === true
      && replay.body.person_id === first.body.person_id && replay.body.lead_id === first.body.lead_id
      && replay.body.conversation_id === conversationId,
    "exact website replay returns the original canonical identity");
    assert.deepEqual(await countState(), afterFirst, "exact replay creates no new source, event, or thread version");
    check((await one("select thread_version from agent_thread_state where conversation_id=$1", [conversationId])).thread_version === firstState.thread_version,
      "exact replay does not increment thread_version");

    const takeover = await staff(owner.token, "POST", `/operator/conversations/${conversationId}/take-over`, {});
    check(takeover.status === 200 && takeover.body?.ok === true && takeover.body.mode === "human_takeover"
      && takeover.body.by === owner.id,
    "entitled staff can claim the captured website conversation");
    const claimed = await one(
      `select s.mode, s.thread_version, s.current_review_obligation_id,
              o.assigned_user_id, o.status, o.type, o.related_type, o.related_id
         from agent_thread_state s left join obligations o on o.id=s.current_review_obligation_id
        where s.conversation_id=$1`,
      [conversationId],
    );
    check(claimed && claimed.mode === "human_takeover" && claimed.current_review_obligation_id
      && claimed.assigned_user_id === owner.id && claimed.status === "in_progress"
      && claimed.type === "human_thread_reply" && claimed.related_type === "conversation"
      && claimed.related_id === conversationId,
    "claim creates one durable named human obligation");
    const obligationId = claimed.current_review_obligation_id;
    const claimedVersion = Number(claimed.thread_version);

    // Historical fixture setup for the next action happens here, before the
    // follow-up POST. The draft is never inserted after the capture assertion.
    const latestInbound = await one(
      "select latest_inbound_comm_event_id as id from agent_thread_state where conversation_id=$1",
      [conversationId],
    );
    const generation = await one(
      `select coalesce(max(generation_no), 0)::int + 1 as next
         from agent_runs where conversation_id=$1 and input_thread_version=$2`,
      [conversationId, claimedVersion],
    );
    const historicalRun = await one(
      `insert into agent_runs
         (conversation_id, inbound_comm_event_id, input_thread_version, generation_no,
          generation_reason, status, prompt_revision, policy_revision, model)
       values($1,$2,$3,$4,'manager_regenerate','ready','website-state-fixture','website-state-fixture','fixture')
       returning id`,
      [conversationId, latestInbound.id, claimedVersion, generation.next],
    );
    const historicalDraft = await one(
      `insert into agent_drafts(agent_run_id, generated_body, status, review_obligation_id)
       values($1, 'Historical ready draft before website follow-up', 'ready', $2) returning id`,
      [historicalRun.id, obligationId],
    );
    check((await one("select status from agent_drafts where id=$1", [historicalDraft.id])).status === "ready",
      "a preexisting ready draft is present before the follow-up action");

    const followup = {
      ...prospect,
      message: followupMessage,
      raw_payload: {
        form: "native_squarespace_leasing",
        interest: "two-bedroom",
        message: followupMessage,
        submission_id: `${tag}-followup`,
      },
    };
    const second = await intake(followup, `website-state-${tag}-followup`);
    check(second.status === 200 && second.body?.replayed === false
      && second.body.reused_opportunity === true && second.body.conversation_id === conversationId,
    "a distinct website follow-up reuses the same opportunity and conversation");
    const afterFollowup = await countState();
    check(afterFollowup.touches === 2 && afterFollowup.received === 2
      && afterFollowup.websiteEvents === 2 && afterFollowup.threadVersion === claimedVersion + 1,
    "the follow-up records one new touch/event and increments thread_version once");
    const afterDraft = await one(
      "select status, superseded_at from agent_drafts where id=$1",
      [historicalDraft.id],
    );
    check(afterDraft.status === "superseded" && afterDraft.superseded_at,
      "new website inbound supersedes the ready draft through the shared capture writer");
    const afterClaim = await one(
      `select s.mode, s.thread_version, s.current_review_obligation_id,
              o.assigned_user_id, o.status, o.related_id
         from agent_thread_state s left join obligations o on o.id=s.current_review_obligation_id
        where s.conversation_id=$1`,
      [conversationId],
    );
    check(afterClaim.mode === claimed.mode && Number(afterClaim.thread_version) === claimedVersion + 1
      && afterClaim.current_review_obligation_id === obligationId
      && afterClaim.assigned_user_id === owner.id && afterClaim.status === claimed.status
      && afterClaim.related_id === conversationId,
    "the follow-up preserves human takeover mode, owner, and accountable work");

    const secondReplay = await intake(JSON.parse(JSON.stringify(followup)), `website-state-${tag}-followup`);
    check(secondReplay.status === 200 && secondReplay.body?.replayed === true
      && secondReplay.body.conversation_id === conversationId,
    "exact follow-up replay returns the existing receipt");
    const afterReplay = await countState();
    check(afterReplay.touches === 2 && afterReplay.received === 2
      && afterReplay.websiteEvents === 2 && afterReplay.threadVersion === claimedVersion + 1,
    "exact follow-up replay does not increment the thread or duplicate the message");

    // A phone-bearing form submission remains a website inquiry. Once a human
    // owns the thread, attempt_sms=true must not re-enter the model or create a
    // transport attempt. The initial phone is part of the fixture before this
    // follow-up action; no consent is fabricated.
    const phoneTag = `${tag}-phone`;
    const phoneName = `Phone Website Prospect ${tag.slice(0, 8)}`;
    const phoneEmail = `${phoneTag}@example.invalid`;
    const phoneInitialMessage = `Phone website inquiry ${tag.slice(0, 8)} asks about availability.`;
    const phoneFollowupMessage = `Phone website follow-up ${tag.slice(0, 8)} asks for a tour link.`;
    const phoneProspect = {
      property_id: property.id, name: phoneName, email: phoneEmail,
      phone: `+1503${String(parseInt(tag.slice(0, 6), 16)).padStart(7, "0").slice(-7)}`,
      source: sourceName, source_lead_id: phoneTag, source_listing_id: `${phoneTag}-listing`,
      message: phoneInitialMessage, attempt_sms: false, sms_consent: false,
      response_channel: "website",
      raw_payload: { form: "native_squarespace_leasing", message: phoneInitialMessage, submission_id: phoneTag },
    };
    const phoneInitial = await intake(phoneProspect, `website-state-${phoneTag}-first`);
    check(phoneInitial.status === 200 && phoneInitial.body?.capture?.state === "captured"
      && phoneInitial.body.first_response_sent === false,
    "phone-bearing website fixture is captured without a first-response send");
    const phoneConversationId = phoneInitial.body.conversation_id;
    const phoneTakeover = await staff(owner.token, "POST", `/operator/conversations/${phoneConversationId}/take-over`, {});
    check(phoneTakeover.status === 200 && phoneTakeover.body?.mode === "human_takeover",
      "staff claims the phone-bearing website conversation before its follow-up");
    const phoneClaim = await one(
      `select s.mode, s.thread_version, s.current_review_obligation_id,
              o.assigned_user_id, o.status
         from agent_thread_state s left join obligations o on o.id=s.current_review_obligation_id
        where s.conversation_id=$1`,
      [phoneConversationId],
    );
    check(phoneClaim && phoneClaim.mode === "human_takeover" && phoneClaim.current_review_obligation_id
      && phoneClaim.assigned_user_id === owner.id && phoneClaim.status === "in_progress",
    "phone-bearing website fixture has one accountable human owner");
    const phoneModelBefore = logText("E2E_ANTHROPIC_LOG");
    const phoneSmsBefore = logText("E2E_SMS_LOG");
    const phoneFollowup = await intake({
      ...phoneProspect,
      message: phoneFollowupMessage,
      attempt_sms: true,
      raw_payload: { ...phoneProspect.raw_payload, message: phoneFollowupMessage, submission_id: `${phoneTag}-followup` },
    }, `website-state-${phoneTag}-followup`);
    const phoneModelAfter = logText("E2E_ANTHROPIC_LOG");
    const phoneSmsAfter = logText("E2E_SMS_LOG");
    check(phoneFollowup.status === 200 && phoneFollowup.body?.capture?.response_state === "not_required"
      && phoneFollowup.body.replayed === false && phoneFollowup.body.reused_opportunity === true,
    "human-owned phone-bearing website follow-up is captured without a response request");
    const phoneAfter = await one(
      `select s.mode, s.thread_version, s.current_review_obligation_id,
              o.assigned_user_id, o.status,
              (select count(*)::int from comm_events where conversation_id=$1 and channel='website') as website_events
         from agent_thread_state s left join obligations o on o.id=s.current_review_obligation_id
        where s.conversation_id=$1`,
      [phoneConversationId],
    );
    check(phoneAfter.mode === "human_takeover"
      && Number(phoneAfter.thread_version) === Number(phoneClaim.thread_version) + 1
      && phoneAfter.current_review_obligation_id === phoneClaim.current_review_obligation_id
      && phoneAfter.assigned_user_id === owner.id && phoneAfter.status === "in_progress"
      && Number(phoneAfter.website_events) === 2,
    "phone-bearing website follow-up preserves human owner/work and increments once");
    check(phoneModelAfter === phoneModelBefore && phoneSmsAfter === phoneSmsBefore,
      "human-owned phone-bearing website follow-up makes no model or SMS call");

    // Separate historical fixture: an awaiting_review thread already has its
    // prior inbound, review obligation, and ready draft before this website
    // capture begins. The phone is also seeded before the action, but consent
    // remains false. This makes the no-model/no-SMS assertion exercise the
    // awaiting_review control mode rather than merely the lack of a phone.
    const awaitingTag = `${tag}-awaiting`;
    const awaitingName = `Awaiting Website Prospect ${tag.slice(0, 8)}`;
    const awaitingEmail = `${awaitingTag}@example.invalid`;
    const awaitingPhone = `+1504${String(parseInt(tag.slice(0, 6), 16)).padStart(7, "0").slice(-7)}`;
    const source = await one("select id from lead_sources where name=$1", [sourceName]);
    const awaitingPerson = await one(
      `insert into persons(name, email, phone, source) values($1,$2,$3,$4) returning id`,
      [awaitingName, awaitingEmail, awaitingPhone, sourceName],
    );
    const awaitingLead = await one(
      `insert into leasing_leads
         (person_id, property_id, source_id, source_lead_id, source_listing_id, message, raw_payload)
       values($1,$2,$3,$4,$5,$6,$7) returning id`,
      [awaitingPerson.id, property.id, source.id, `${awaitingTag}-historical`, `${awaitingTag}-listing`,
        `Historical awaiting question ${tag.slice(0, 8)}.`, JSON.stringify({ form: "historical_fixture" })],
    );
    const awaitingConversation = await one(
      `insert into conversations(property_id, person_id, channel_primary, status, last_message_at)
       values($1,$2,'website','open',now()) returning id`,
      [property.id, awaitingPerson.id],
    );
    const awaitingTouch = await one(
      `insert into lead_source_touches
         (lead_id, person_id, source_id, source_lead_id, source_listing_id, raw_payload)
       values($1,$2,$3,$4,$5,$6) returning id`,
      [awaitingLead.id, awaitingPerson.id, source.id, `${awaitingTag}-historical`, `${awaitingTag}-listing`,
        JSON.stringify({ form: "historical_fixture", message: `Historical awaiting question ${tag.slice(0, 8)}.` })],
    );
    const awaitingInbound = await one(
      `insert into comm_events
         (property_id, person_id, conversation_id, channel, direction, body,
          classification, sender_role, provider, provider_event_id)
       values($1,$2,$3,'website','inbound',$4,'leasing','prospect','fixture',$5) returning id`,
      [property.id, awaitingPerson.id, awaitingConversation.id,
        `Historical awaiting question ${tag.slice(0, 8)}.`, `${awaitingTag}-historical-event`],
    );
    await pool.query("update conversations set last_message_at=now() where id=$1", [awaitingConversation.id]);
    const awaitingLeadEvent = await one(
      `insert into lead_events
         (lead_id, event_type, actor_type, actor_id, comm_event_id, metadata)
       values($1,'lead_received','prospect',$2,$3,$4) returning id`,
      [awaitingLead.id, awaitingPerson.id, awaitingInbound.id, JSON.stringify({ source: sourceName, fixture: true })],
    );
    const awaitingObligation = await one(
      `insert into obligations
         (property_id, person_id, related_id, related_type, module, type, label,
          owner_type, assigned_role, status, required_inputs)
       values($1,$2,$3,'conversation','leasing','agent_review',$4,'human','leasing_agent','escalated',$5)
       returning id`,
      [property.id, awaitingPerson.id, awaitingConversation.id,
        `Historical website review ${tag.slice(0, 8)}`, ["review_website_inquiry"]],
    );
    await pool.query(
      `insert into agent_thread_state
         (conversation_id, mode, thread_version, latest_inbound_comm_event_id, current_review_obligation_id)
       values($1,'awaiting_review',1,$2,$3)`,
      [awaitingConversation.id, awaitingInbound.id, awaitingObligation.id],
    );
    const awaitingRun = await one(
      `insert into agent_runs
         (conversation_id, inbound_comm_event_id, input_thread_version, generation_no,
          generation_reason, status, prompt_revision, policy_revision, model)
       values($1,$2,1,1,'initial_inbound','ready','historical-fixture','historical-fixture','fixture')
       returning id`,
      [awaitingConversation.id, awaitingInbound.id],
    );
    const awaitingDraft = await one(
      `insert into agent_drafts(agent_run_id, generated_body, status, review_obligation_id)
       values($1,$2,'ready',$3) returning id`,
      [awaitingRun.id, `Historical ready website draft ${tag.slice(0, 8)}.`, awaitingObligation.id],
    );
    check(awaitingLeadEvent && awaitingTouch && awaitingDraft
      && (await one("select mode from agent_thread_state where conversation_id=$1", [awaitingConversation.id])).mode === "awaiting_review"
      && (await one("select status from agent_drafts where id=$1", [awaitingDraft.id])).status === "ready",
    "awaiting_review fixture has its historical capture, work, and ready draft before follow-up");

    const awaitingModelBefore = logText("E2E_ANTHROPIC_LOG");
    const awaitingSmsBefore = logText("E2E_SMS_LOG");
    const awaitingFollowupMessage = `Awaiting website follow-up ${tag.slice(0, 8)} asks for a floor plan.`;
    const awaitingFollowup = await intake({
      property_id: property.id,
      name: awaitingName,
      email: awaitingEmail,
      phone: awaitingPhone,
      source: sourceName,
      source_lead_id: `${awaitingTag}-followup`,
      source_listing_id: `${awaitingTag}-followup-listing`,
      message: awaitingFollowupMessage,
      attempt_sms: true,
      sms_consent: false,
      response_channel: "website",
      raw_payload: { form: "native_squarespace_leasing", message: awaitingFollowupMessage, submission_id: `${awaitingTag}-followup` },
    }, `website-state-${awaitingTag}-followup`);
    const awaitingModelAfter = logText("E2E_ANTHROPIC_LOG");
    const awaitingSmsAfter = logText("E2E_SMS_LOG");
    check(awaitingFollowup.status === 200 && awaitingFollowup.body?.capture?.response_state === "not_required"
      && awaitingFollowup.body.replayed === false && awaitingFollowup.body.conversation_id === awaitingConversation.id,
    "awaiting_review website follow-up is captured without response dispatch");
    const awaitingState = await one(
      `select s.mode, s.thread_version, s.latest_inbound_comm_event_id,
              s.current_review_obligation_id, o.status, o.related_id,
              (select status from agent_drafts where id=$2) as draft_status,
              (select superseded_at from agent_drafts where id=$2) as superseded_at
         from agent_thread_state s
         left join obligations o on o.id=s.current_review_obligation_id
        where s.conversation_id=$1`,
      [awaitingConversation.id, awaitingDraft.id],
    );
    check(awaitingState.mode === "awaiting_review" && Number(awaitingState.thread_version) === 2
      && awaitingState.current_review_obligation_id === awaitingObligation.id
      && awaitingState.status === "escalated" && awaitingState.related_id === awaitingConversation.id
      && awaitingState.latest_inbound_comm_event_id
      && awaitingState.draft_status === "superseded" && awaitingState.superseded_at,
    "awaiting_review follow-up supersedes the ready draft, increments once, and keeps review work");
    check(awaitingModelAfter === awaitingModelBefore && awaitingSmsAfter === awaitingSmsBefore,
      "awaiting_review phone-bearing follow-up makes no model or SMS call");

    const awaitingQueue = await staff(owner.token, "GET", "/operator/leasing/conversation-queue");
    const awaitingQueueRow = (awaitingQueue.body?.conversations || [])
      .find((row) => row.conversation_id === awaitingConversation.id);
    check(awaitingQueue.status === 200 && awaitingQueueRow
      && awaitingQueueRow.control_mode === "awaiting_review"
      && awaitingQueueRow.waiting_on === "manager"
      && awaitingQueueRow.control_bucket === "needs_you"
      && awaitingQueueRow.bucket_reason_code === "website_inquiry_pending_human",
    "awaiting_review queue uses website_inquiry_pending_human after the draft is superseded");
    const awaitingDetail = await staff(owner.token, "GET", `/operator/leasing/conversations/${awaitingConversation.id}`);
    check(awaitingDetail.status === 200 && awaitingDetail.body?.mode === "awaiting_review"
      && awaitingDetail.body?.waiting_on === "manager"
      && awaitingDetail.body?.control_bucket === "needs_you"
      && awaitingDetail.body?.bucket_reason_code === "website_inquiry_pending_human",
    "awaiting_review conversation detail carries the website inquiry queue reason");

    const finalLinks = await many(
      `select ce.body, ce.channel, ce.provider, ce.provider_event_id,
              le.comm_event_id as linked_event_id, lst.id as source_touch_id
         from comm_events ce
         join lead_events le on le.comm_event_id=ce.id and le.event_type='lead_received'
         join lead_source_touches lst on lst.id::text=ce.provider_event_id
        where ce.conversation_id=$1 order by ce.occurred_at asc, ce.id asc`,
      [conversationId],
    );
    check(finalLinks.length === 2 && finalLinks.map((row) => row.body).join("\n") === `${originalMessage}\n${followupMessage}`
      && finalLinks.every((row) => row.channel === "website" && row.provider === "leasing_intake"
        && row.linked_event_id && String(row.provider_event_id) === String(row.source_touch_id)),
    "both website messages retain ordered source and channel provenance");

    const detail = await staff(owner.token, "GET", `/operator/leasing/conversations/${conversationId}`);
    const detailMessages = detail.body?.messages || [];
    check(detail.status === 200 && detail.body?.mode === "human_takeover"
      && detail.body?.human_owner?.user_id === owner.id
      && detailMessages.length === 2
      && detailMessages.every((message) => message.channel === "website")
      && detailMessages.map((message) => message.body).join("\n") === `${originalMessage}\n${followupMessage}`,
    "conversation detail reads both website messages with their channel");

    const card = await staff(owner.token, "GET", `/operator/leasing/person-card?person_id=${encodeURIComponent(first.body.person_id)}`);
    const cardText = JSON.stringify(card.body || {});
    check(card.status === 200 && card.body?.person?.id === first.body.person_id
      && cardText.includes(originalMessage) && cardText.includes(followupMessage),
    "Person Card reads the original and follow-up website submissions");
    const cardWebsiteEntries = (card.body?.history || []).filter((entry) => entry.detail?.channel === "website");
    check(cardWebsiteEntries.length === 2 && cardWebsiteEntries.every((entry) => entry.claim_strength === "proven"),
      "Person Card preserves two proven website channel history entries");

    // The deterministic website-inquiry Ask branch receives exactly one field.
    // No property/person identifier is accepted from the HTTP caller.
    const askQuestion = `What did ${prospectName} ask about?`;
    const ask = await staff(owner.token, "POST", "/operator/ask-spine/ask", { question: askQuestion });
    check(ask.status === 200 && ask.body?.property_id === property.id
      && ask.body.outcome === "answered" && ask.body.answer.includes(originalMessage)
      && ask.body.answer.includes(followupMessage)
      && ask.body.grounded_on?.inquiry_read_state === "OK",
    "Ask Spine reads both website inquiries from the authenticated canonical surface");
    check(Array.isArray(ask.body.grounded_on?.inquiry_history?.messages)
      && ask.body.grounded_on.inquiry_history.messages.length === 2
      && ask.body.grounded_on.inquiry_history.messages.every((message) => message.channel === "website"),
    "Ask Spine exposes website inquiry provenance in its grounded receipt");

    // Null and blank messages remain source-touch provenance only. They are not
    // communications, so no inbound event or invented inquiry is created.
    const blankName = `Blank website ${tag.slice(0, 8)}`;
    const blankEmail = `blank-${tag}@example.invalid`;
    const blankBase = {
      property_id: property.id, name: blankName, email: blankEmail, source: sourceName,
      source_lead_id: `blank-${tag}`, attempt_sms: false, sms_consent: false,
      response_channel: "website",
      raw_payload: { form: "native_squarespace_leasing", submission_id: `${tag}-blank-null` },
    };
    const blankNull = await intake({ ...blankBase, message: null }, `website-state-${tag}-blank-null`);
    const blankSpace = await intake({
      ...blankBase,
      message: "   ",
      raw_payload: { ...blankBase.raw_payload, submission_id: `${tag}-blank-space`, message: "   " },
    }, `website-state-${tag}-blank-space`);
    check(blankNull.status === 200 && blankSpace.status === 200 && blankSpace.body.reused_opportunity === true,
      "null and blank website submissions remain valid source touches");
    const blankState = await one(
      `select
         (select count(*)::int from lead_source_touches where lead_id=$1) as touches,
         (select count(*)::int from lead_events where lead_id=$1 and event_type='lead_received') as received,
         (select count(*)::int from comm_events where conversation_id=$2) as comm_events,
         (select count(*)::int from agent_thread_state where conversation_id=$2) as thread_states,
         (select count(*)::int from lead_events where lead_id=$1 and event_type='lead_received' and comm_event_id is not null) as linked,
         (select id from conversations where id=$2) as conversation_id`,
      [blankNull.body.lead_id, blankNull.body.conversation_id],
    );
    check(blankState.touches === 2 && blankState.received === 2 && blankState.comm_events === 0
      && blankState.thread_states === 0 && blankState.linked === 0 && blankState.conversation_id,
    "null and blank messages create no invented communication, thread, or linked event");

    // Disclosure boundaries: module entitlement and session property both stay
    // server-derived for Person Card, conversation detail, and Ask.
    const deniedCard = await staff(maintenance.token, "GET", `/operator/leasing/person-card?person_id=${encodeURIComponent(first.body.person_id)}`);
    const deniedDetail = await staff(maintenance.token, "GET", `/operator/leasing/conversations/${conversationId}`);
    check(deniedCard.status === 403 && deniedDetail.status === 403,
      "a same-property non-leasing session cannot read Person Card or conversation detail");
    const deniedAsk = await staff(maintenance.token, "POST", "/operator/ask-spine/ask", { question: askQuestion });
    check(deniedAsk.status === 200 && deniedAsk.body.outcome === "not_authorized"
      && !JSON.stringify(deniedAsk.body).includes(originalMessage)
      && !JSON.stringify(deniedAsk.body).includes(followupMessage),
    "a same-property non-leasing Ask session refuses inquiry disclosure");

    const foreignCard = await staff(foreign.token, "GET", `/operator/leasing/person-card?person_id=${encodeURIComponent(first.body.person_id)}`);
    const foreignDetail = await staff(foreign.token, "GET", `/operator/leasing/conversations/${conversationId}`);
    check(foreignCard.status === 404 && foreignDetail.status === 403,
      "a leasing session at another property cannot cross the Person or conversation wall");
    const foreignAsk = await staff(foreign.token, "POST", "/operator/ask-spine/ask", { question: askQuestion });
    check(foreignAsk.status === 200 && foreignAsk.body.outcome !== "answered"
      && !JSON.stringify(foreignAsk.body).includes(originalMessage)
      && !JSON.stringify(foreignAsk.body).includes(followupMessage),
    "a foreign-property Ask session refuses inquiry disclosure");
    const claimedProperty = await staff(foreign.token, "POST", "/operator/ask-spine/ask", {
      question: askQuestion, property_id: property.id,
    });
    check(claimedProperty.status === 403 && !JSON.stringify(claimedProperty.body || {}).includes(originalMessage),
      "Ask refuses a client-supplied foreign property claim before reading facts");

    const conversions = await one(
      "select count(*)::int as n from leasing_conversions where person_id=$1 and property_id=$2",
      [first.body.person_id, property.id],
    );
    check(Number(conversions.n) === 0,
      "website capture does not invent a closed conversion or reopen lifecycle state");

    console.log(`RESULT ${checks}/${checks}`);
  } finally {
    await pool.end();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
