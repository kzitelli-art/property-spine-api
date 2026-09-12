"use strict";

// Class 3: owned real DB + authenticated HTTP witness for a website inquiry.
//
// This is deliberately a witness for the current first red, not a product
// fallback. The website may identify a prospect by email alone. Capture,
// source provenance, delivery replay, and explicit staff ownership are already
// canonical. The remaining question is whether the prospect's words survive
// into the same Conversation, Person Card, and Ask Spine reads staff use.
//
// Default EXPECT_INQUIRY_VISIBILITY=absent records the current released
// behavior. A later source correction can be witnessed with
// EXPECT_INQUIRY_VISIBILITY=present; that mode requires both distinct website
// submissions to be visible through every canonical read exercised here.
//
// No server, database, provider, or production setup is performed here. The
// proof_boundary launcher owns the ephemeral runtime when this file is run.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const { randomUUID } = require("node:crypto");
const { Pool } = require("pg");
const boundary = require("./proof_boundary");
require("./proof_fence_preload");
const staffSessions = require("../../src/identity/staff_session_service");
const askSpineAnswer = require("../../src/agent/ask_spine_answer");

const expectedVisibility = process.env.EXPECT_INQUIRY_VISIBILITY === "present";
const markerState = expectedVisibility ? "present" : "absent";

const readFile = (file) => file && fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";

(async () => {
  await boundary.assertDatabase();
  const manifest = boundary.manifest();
  const base = (process.env.E2E_API_BASE || `http://127.0.0.1:${manifest.port}`).replace(/\/+$/, "");
  await boundary.waitServer(base);

  const transportLog = process.env.E2E_SMS_LOG;
  assert(transportLog, "E2E_SMS_LOG is required so the no-phone transport claim is observable");
  const transportBefore = readFile(transportLog);
  const pool = new Pool({ connectionString: manifest.url, ssl: false });
  let checks = 0;
  const check = (value, label) => {
    assert.ok(value, label);
    checks += 1;
    console.log(`PASS ${label}`);
  };
  const one = async (sql, args = []) => (await pool.query(sql, args)).rows[0] || null;
  const many = async (sql, args = []) => (await pool.query(sql, args)).rows;

  const request = async (method, path, { body, headers = {} } = {}) => {
    const h = { ...headers };
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

  const intake = async (payload, key) => request("POST", "/leasing/intake", {
    body: payload,
    headers: {
      "x-intake-secret": process.env.E2E_INTAKE_SECRET || "e2e-intake",
      ...(key !== undefined ? { "Idempotency-Key": key } : {}),
    },
  });
  const staff = (method, path, body) => request(method, path, {
    ...(body !== undefined ? { body } : {}),
    headers: { "x-staff-session": token },
  });
  const containsBoth = (value) => {
    const text = JSON.stringify(value || {});
    return text.includes(originalMessage) && text.includes(followupMessage);
  };

  let token;
  let staffUserId;
  let prospect;
  let originalMessage;
  let followupMessage;
  try {
    const property = await one(
      "select id, name from properties where name='Skyline E2E' order by created_at desc limit 1",
    );
    assert(property, "owned Skyline E2E property fixture is required");

    const tag = randomUUID();
    const sourceName = `Website visibility ${tag}`;
    const prospectName = `Website Prospect ${tag.slice(0, 8)}`;
    const prospectEmail = `${tag}@example.invalid`;
    const sourceLeadId = `squarespace-${tag}`;
    originalMessage = `I need to know whether the ${tag.slice(0, 8)} two-bedroom allows cats.`;
    followupMessage = `Also, can I see the ${tag.slice(0, 8)} floor plan?`;

    // Fixture setup happens before the HTTP witness. Nothing here pretends to
    // be a website delivery or repairs a read after the actions begin.
    await pool.query(
      "insert into lead_sources(name, source_type) values($1, 'website')",
      [sourceName],
    );
    const staffPerson = await one(
      "insert into persons(name) values($1) returning id",
      [`Website proof staff ${tag.slice(0, 8)}`],
    );
    const user = await one(
      `insert into users(name, role, is_active, status, account_kind, person_id)
       values($1, 'leasing_agent', true, 'active', 'human_staff', $2) returning id`,
      [`Website proof staff ${tag.slice(0, 8)}`, staffPerson.id],
    );
    staffUserId = user.id;
    await pool.query(
      `insert into property_team_assignments
         (user_id, property_id, role_title, allowed_modules, primary_for_modules, active)
       values($1, $2, 'Leasing Agent', '{leasing}', '{leasing}', true)`,
      [staffUserId, property.id],
    );
    await pool.query(
      "insert into assignments(person_id, property_id, role, is_active) values($1, $2, 'leasing', true)",
      [staffPerson.id, property.id],
    );
    const issued = await staffSessions.issueStaffSession(pool, {
      userId: staffUserId,
      propertyId: property.id,
      purpose: "bootstrap_invite",
    });
    token = issued.session_token || issued.token;
    assert(token, "owned staff session token is required");

    prospect = {
      property_id: property.id,
      name: prospectName,
      email: prospectEmail,
      source: sourceName,
      source_lead_id: sourceLeadId,
      source_listing_id: `skyline-listing-${tag}`,
      // Deliberately no phone: this is the native form's valid email-only case.
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
    const firstKey = `website-${tag}-first`;
    const first = await intake(prospect, firstKey);
    check(first.status === 200 && first.body && first.body.capture?.state === "captured"
      && first.body.replayed === false, "email-only website delivery is captured with a canonical receipt");
    check(first.body.first_response_sent === false && first.body.capture.response_state === "not_required",
      "email-only capture makes no text-send claim");
    check(!Object.prototype.hasOwnProperty.call(prospect, "phone"), "witness payload contains no phone");

    const firstPerson = await one(
      "select id, phone, email from persons where id=$1",
      [first.body.person_id],
    );
    const firstLead = await one(
      "select id, person_id, property_id, message, raw_payload from leasing_leads where id=$1",
      [first.body.lead_id],
    );
    check(firstPerson && firstPerson.phone === null && firstPerson.email === prospect.email,
      "canonical person retains email identity and no phone");
    check(firstLead && firstLead.person_id === first.body.person_id
      && firstLead.property_id === property.id && firstLead.message === originalMessage
      && firstLead.raw_payload?.message === originalMessage,
    "canonical opportunity retains the original inquiry and source payload");

    const snapshot = async () => {
      const row = await one(
        `select
           (select count(*)::int from lead_source_touches where lead_id=$1) as touches,
           (select count(*)::int from lead_events where lead_id=$1 and event_type='lead_received') as received,
           (select count(*)::int from comm_events where conversation_id=$2) as comm_events,
           (select count(*)::int from agent_runs where conversation_id=$2) as agent_runs`,
        [first.body.lead_id, first.body.conversation_id],
      );
      return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, Number(value)]));
    };
    const afterFirst = await snapshot();
    check(afterFirst.touches === 1 && afterFirst.received === 1
      && afterFirst.agent_runs === 0 && afterFirst.comm_events === (expectedVisibility ? 1 : 0),
    `first submission has one capture and ${markerState} canonical communication event`);

    const replay = await intake(JSON.parse(JSON.stringify(prospect)), firstKey);
    check(replay.status === 200 && replay.body.replayed === true
      && replay.body.person_id === first.body.person_id
      && replay.body.lead_id === first.body.lead_id
      && replay.body.conversation_id === first.body.conversation_id,
    "exact email-only retry returns the same person, opportunity, and conversation");
    assert.deepEqual(await snapshot(), afterFirst, "exact retry creates no additional records");
    check(true, "exact retry creates no additional touch, lead event, or communication event");

    const changedSameKey = { ...prospect, message: `${originalMessage} Changed.` };
    const conflict = await intake(changedSameKey, firstKey);
    check(conflict.status === 409, "same delivery identity with changed inquiry is refused");
    assert.deepEqual(await snapshot(), afterFirst, "conflicting retry leaves capture counts unchanged");
    check(true, "conflicting retry leaves the canonical capture unchanged");

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
    const second = await intake(followup, `website-${tag}-followup`);
    check(second.status === 200 && second.body.replayed === false
      && second.body.reused_opportunity === true
      && second.body.person_id === first.body.person_id
      && second.body.lead_id === first.body.lead_id
      && second.body.conversation_id === first.body.conversation_id,
    "distinct website submission reuses the opportunity without collapsing the person");
    const afterSecond = await snapshot();
    check(afterSecond.touches === 2 && afterSecond.received === 2
      && afterSecond.comm_events === (expectedVisibility ? 2 : 0),
    `distinct submission preserves two arrivals and ${markerState} communication events`);
    const touchMessages = await many(
      "select raw_payload->>'message' as message from lead_source_touches where lead_id=$1 order by arrived_at",
      [first.body.lead_id],
    );
    check(touchMessages.map((row) => row.message).join("\n") === `${originalMessage}\n${followupMessage}`,
      "both website messages survive in ordered source-touch provenance");
    const unchangedLead = await one("select message from leasing_leads where id=$1", [first.body.lead_id]);
    check(unchangedLead.message === originalMessage,
      "a follow-up touch does not overwrite the opportunity's original message");

    const queue = await staff("GET", "/operator/leasing/conversation-queue");
    const queueRow = (queue.body && queue.body.conversations || [])
      .find((row) => row.conversation_id === first.body.conversation_id);
    check(queue.status === 200 && queueRow, "email-only conversation appears in the authenticated staff queue");
    if (!expectedVisibility) {
      check(queueRow.control_bucket === "exception"
        && queueRow.bucket_reason_code === "unowned_no_engagement",
      "current no-event intake is honestly routed as unowned with no qualifying engagement");
    }
    check(!Object.prototype.hasOwnProperty.call(queueRow || {}, "message"),
      "queue rows do not pretend to carry the source inquiry body");

    const conversationId = first.body.conversation_id;
    const takeover = await staff("POST", `/operator/conversations/${conversationId}/take-over`, {});
    check(takeover.status === 200 && takeover.body && takeover.body.ok === true
      && takeover.body.mode === "human_takeover" && takeover.body.by === staffUserId,
    "authenticated staff can explicitly claim the email-only conversation");
    const thread = await one(
      "select mode, current_review_obligation_id from agent_thread_state where conversation_id=$1",
      [conversationId],
    );
    const obligation = thread && thread.current_review_obligation_id
      ? await one(
        `select assigned_user_id, status, type, label, related_type, related_id
           from obligations where id=$1`,
        [thread.current_review_obligation_id],
      ) : null;
    check(thread && thread.mode === "human_takeover" && thread.current_review_obligation_id
      && obligation && obligation.assigned_user_id === staffUserId
      && obligation.status === "in_progress"
      && obligation.type === "human_thread_reply"
      && obligation.related_type === "conversation"
      && obligation.related_id === conversationId,
    "takeover writes one accountable human obligation for this conversation");

    const ownedQueue = await staff("GET", "/operator/leasing/conversation-queue");
    const ownedRow = (ownedQueue.body && ownedQueue.body.conversations || [])
      .find((row) => row.conversation_id === conversationId);
    check(ownedQueue.status === 200 && ownedRow && ownedRow.control_bucket === "you_own",
      "the queue reflects server-authored human ownership after claim");

    const detail = await staff("GET", `/operator/leasing/conversations/${conversationId}`);
    const detailMessages = detail.body && Array.isArray(detail.body.messages) ? detail.body.messages : [];
    check(detail.status === 200 && detail.body && detail.body.mode === "human_takeover"
      && detail.body.human_owner && detail.body.human_owner.user_id === staffUserId,
    "conversation detail exposes the server-derived staff owner");
    check(expectedVisibility ? containsBoth(detailMessages) : !containsBoth(detailMessages),
      `conversation detail shows original and follow-up inquiry text: ${markerState}`);

    const card = await staff("GET", `/operator/leasing/person-card?person_id=${encodeURIComponent(first.body.person_id)}`);
    check(card.status === 200 && card.body && card.body.person
      && card.body.person.id === first.body.person_id,
    "Person Card reads the email-only person through the property wall");
    check(expectedVisibility ? containsBoth({ history: card.body.history, recent_messages: card.body.relationship?.recent_messages })
      : !containsBoth({ history: card.body.history, recent_messages: card.body.relationship?.recent_messages }),
    `Person Card exposes original and follow-up inquiry text: ${markerState}`);

    const askQuestion = `What did ${prospectName} ask about?`;
    const ask = await staff("POST", "/operator/ask-spine/ask", { question: askQuestion });
    check(ask.status === 200 && ask.body && ask.body.property_id === property.id
      && typeof ask.body.outcome === "string" && typeof ask.body.answer === "string",
    "Ask Spine answers through its authenticated read-only envelope");
    const gathered = await askSpineAnswer.gatherFacts(pool, {
      property_id: property.id,
      allowed_modules: ["leasing"],
      subject: "leasing_person",
      question: askQuestion,
    });
    check(expectedVisibility ? containsBoth(gathered) : !containsBoth(gathered),
      `Ask Spine's canonical fact bundle carries original and follow-up inquiry text: ${markerState}`);
    check(expectedVisibility ? containsBoth(ask.body) : !containsBoth(ask.body),
      `Ask Spine HTTP response carries original and follow-up inquiry text: ${markerState}`);

    check(readFile(transportLog) === transportBefore,
      "email-only capture, replay, claim, and reads produce no text transport attempt");
    console.log(`RESULT ${checks}/${checks} EXPECT_INQUIRY_VISIBILITY=${markerState}`);
  } finally {
    await pool.end();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
