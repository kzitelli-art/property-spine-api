// ════════════════════════════════════════════════════════════════════
//  INTERACTION LEDGER — leasing_interactions.js
//
//  The Twilio-backed communication evidence layer, written onto the EXISTING
//  comm_events table (extended by 048) — NOT a parallel twilio_messages or
//  calls table. Texts, calls, email, voicemail render from ONE timeline.
//
//  CANONICAL RULES (server writes truth; client never does):
//   • The SERVER derives the acting human from authenticated identity. A
//     client-supplied sender identity is never trusted.
//   • Idempotency: a comm event upserts/resolves by (provider, provider_event_id).
//     A duplicate delivery callback updates the existing row's status + appends
//     to comm_event_status_log; it never creates a second communication.
//   • AI may draft; a human approves/sends the outward move. We record
//     ai_drafted_at AND human_approved_by/at AND sent_by — distinct facts.
//   • Consent: the event stores consent_state_at_event; the CURRENT canonical
//     opt-out truth lives in contact_preferences, updated on inbound STOP.
//   • A kept follow-up = the human sent on time. A later carrier failure does
//     NOT erase that — it spawns a contact-failure next action (caller's job;
//     this module exposes the status so that logic can read it).
//
//  Deps: { pool, sms }. sms is the existing pure Twilio transport (injected).
//  Operator-gated for outbound; the inbound/status webhooks validate via sms.
// ════════════════════════════════════════════════════════════════════

const express = require("express");

module.exports = function leasingInteractionsModule({ pool, sms, leasingLifecycle, commBoundary }) {
  const router = express.Router();

  function requireOperator(req, res, next) {
    const expected = process.env.OPERATOR_KEY;
    if (!expected) return res.status(503).json({ receipt: "Operator routes are locked: set OPERATOR_KEY." });
    if (req.headers["x-operator-key"] !== expected) return res.status(401).json({ receipt: "Operator key missing or wrong." });
    next();
  }
  function smsReady() { return !!(sms && sms.enabled && sms.enabled()); }

  // ── Resolve-or-create the thread (conversations) for a person+property. ──
  async function ensureConversation(client, { person_id, property_id }) {
    let conv = (await client.query(
      `select * from conversations where person_id=$1 and property_id=$2 order by created_at limit 1`,
      [person_id, property_id]
    )).rows[0];
    if (!conv) {
      conv = (await client.query(
        `insert into conversations (property_id, person_id) values ($1,$2) returning *`,
        [property_id, person_id]
      )).rows[0];
    }
    return conv;
  }

  // ════════════════════════════════════════════════════════════════════
  //  recordOutboundText — the human's approved message goes out + is logged.
  //  The SERVER stamps actor identity (passed as actor_user_id from auth in
  //  the real app; here it's an explicit param the route fills from session).
  //  Idempotent on the returned Twilio SID.
  // ════════════════════════════════════════════════════════════════════
  async function recordOutboundText(client, {
    person_id, property_id, body, actor_user_id,
    ai_drafted = false, human_approved_by_user_id = null,
    conversion_case_id = null, obligation_id = null, to,
  }) {
    if (!person_id || !property_id) throw httpErr(400, "person_id and property_id are required.");
    if (!body) throw httpErr(400, "body is required.");
    if (!actor_user_id) throw httpErr(400, "actor_user_id is required (server-derived sender identity).");

    const conv = await ensureConversation(client, { person_id, property_id });

    // current consent snapshot for this person/text channel
    const pref = (await client.query(
      `select consent_state from contact_preferences where person_id=$1 and channel='text'`, [person_id]
    )).rows[0];
    const consentAtEvent = pref ? pref.consent_state : "unknown";

    // COMMUNICATIONS BOUNDARY — save-first, then the gate. The event is
    // real whether or not the wire cooperates. The gate derives the
    // property line server-side (the old raw sendSms({to, body}) here had
    // NO `from` and could have left on the Messaging Service default line;
    // that path is structurally gone).
    const now = new Date().toISOString();
    const row = (await client.query(
      `insert into comm_events
         (property_id, person_id, conversation_id, channel, direction, body, sender_role,
          provider, provider_event_id, provider_status, provider_status_updated_at,
          actor_user_id, ai_drafted_at, human_approved_by_user_id, human_approved_at, sent_by_user_id,
          consent_state_at_event, conversion_case_id, obligation_id, occurred_at)
       values ($1,$2,$3,'text','outbound',$4,'agent',
               'twilio',$5,$6,$7,
               $8,$9,$10,$11,$12,
               $13,$14,$15, now())
       returning *`,
      [property_id, person_id, conv.id, body,
       null, "pending", now,
       actor_user_id, ai_drafted ? now : null, human_approved_by_user_id, human_approved_by_user_id ? now : now, actor_user_id,
       consentAtEvent, conversion_case_id, obligation_id]
    )).rows[0];

    let providerStatus = "pending", sendReason = null, sent = false;
    if (to) {
      const wire = await commBoundary.sendPropertySms({
        property_id, recipient: to, body,
        purpose: ai_drafted ? "ai_reply" : "agent",
        person_id, eventId: row.id, actor_user_id,
      }, client);
      sent = wire.sent;
      if (wire.sent) { providerStatus = "queued"; }
      else if (wire.reason === "transport_not_configured") { providerStatus = "not_sent_transport_off"; }
      else { providerStatus = "refused"; sendReason = wire.reason; }
      await client.query(
        `update comm_events set provider_event_id = $1, provider_status = $2, provider_status_updated_at = now() where id = $3`,
        [wire.sid, providerStatus, row.id]
      );
      row.provider_event_id = wire.sid; row.provider_status = providerStatus;
    } else {
      providerStatus = "not_sent_no_recipient";
      await client.query(
        `update comm_events set provider_status = $1, provider_status_updated_at = now() where id = $2`,
        [providerStatus, row.id]
      );
      row.provider_status = providerStatus;
    }

    return { comm_event: row, sent, provider_status: providerStatus, send_reason: sendReason };
  }

  // ════════════════════════════════════════════════════════════════════
  //  COMMUNICATIONS BOUNDARY — provider events are STATUS-ONLY here.
  //  The old upsertProviderEvent could INSERT an inbound comm_event with a
  //  caller-supplied property_id and body through an unauthenticated
  //  route: an open inbound-message injection hole. That branch is
  //  structurally gone. Inbound messages have exactly ONE door —
  //  POST /communications/inbound-sms → resolveInboundSmsContext, where
  //  the property derives from the receiving line. Delivery/status
  //  callbacks land here through the boundary's recordProviderStatus,
  //  which never creates a communication, never accepts a property, and
  //  never lets body text enter history. Unknown event id → logged no-op.
  //  (The Foundation-054 inbound-reopen hook rode the removed insert
  //  branch; genuine inbound reopen continues to fire on the canonical
  //  inbound door via runInbound, not on status callbacks.)
  // ════════════════════════════════════════════════════════════════════
  async function recordProviderStatus(client, { provider = "twilio", provider_event_id, provider_status = null, raw = null }) {
    if (!provider_event_id) throw httpErr(400, "provider_event_id is required.");
    return commBoundary.recordProviderStatus(
      { provider, provider_event_id, provider_status, raw }, client
    );
  }

  // ── inbound STOP/START maintains canonical opt-out truth. ──
  async function applyConsentSignal(client, { person_id, channel = "text", consent_state, source = "inbound" }) {
    if (!person_id || !consent_state) throw httpErr(400, "person_id and consent_state required.");
    await client.query(
      `insert into contact_preferences (person_id, channel, consent_state, source, updated_at)
       values ($1,$2,$3,$4, now())
       on conflict (person_id, channel)
       do update set consent_state=excluded.consent_state, source=excluded.source, updated_at=now()`,
      [person_id, channel, consent_state, source]
    );
    return { person_id, channel, consent_state };
  }

  // ── record a call (v1: metadata + disposition; recording/transcription later) ──
  async function recordCall(client, {
    person_id, property_id, actor_user_id, direction = "outbound",
    provider_event_id = null, call_duration_seconds = null, call_disposition = null,
    conversion_case_id = null, obligation_id = null,
  }) {
    if (!person_id || !property_id) throw httpErr(400, "person_id and property_id required.");
    if (!actor_user_id) throw httpErr(400, "actor_user_id required (server-derived).");
    const conv = await ensureConversation(client, { person_id, property_id });
    const row = (await client.query(
      `insert into comm_events
         (property_id, person_id, conversation_id, channel, direction, sender_role,
          provider, provider_event_id, actor_user_id, sent_by_user_id,
          call_duration_seconds, call_disposition, conversion_case_id, obligation_id, occurred_at)
       values ($1,$2,$3,'call',$4,'agent','twilio',$5,$6,$6,$7,$8,$9,$10, now())
       returning *`,
      [property_id, person_id, conv.id, direction, provider_event_id, actor_user_id,
       call_duration_seconds, call_disposition, conversion_case_id, obligation_id]
    )).rows[0];
    return { comm_event: row };
  }

  // ── the unified thread read (texts + calls + email + voicemail, one shape) ──
  async function readThread(client, { person_id, property_id }) {
    const r = await client.query(
      `select id, channel, direction, body, transcript, ai_summary,
              provider, provider_event_id, provider_status, provider_status_updated_at,
              actor_user_id, ai_drafted_at, human_approved_by_user_id, sent_by_user_id,
              call_duration_seconds, call_disposition, media_refs,
              conversion_case_id, obligation_id, occurred_at
         from comm_events
        where person_id=$1 and property_id=$2
        order by occurred_at asc`,
      [person_id, property_id]
    );
    return r.rows;
  }

  // ── HTTP ──
  function httpErr(status, message) { const e = new Error(message); e.http = status; return e; }
  async function tx(fn, res) {
    const c = await pool.connect();
    try { await c.query("begin"); const out = await fn(c); await c.query("commit"); return res.json(out); }
    catch (e) { await c.query("rollback"); return res.status(e.http || 500).json({ receipt: e.message }); }
    finally { c.release(); }
  }

  // POST /interactions/text — record (and send) an outbound text. actor_user_id
  // is taken from the operator session in the real app; passed explicitly here.
  router.post("/interactions/text", requireOperator, (req, res) => tx(async (client) => {
    const out = await recordOutboundText(client, req.body || {});
    return { receipt: out.sent ? "Text sent and logged." : `Text logged (not delivered: ${out.provider_status}).`, ...out };
  }, res));

  // POST /interactions/call — record a call (metadata + disposition)
  router.post("/interactions/call", requireOperator, (req, res) => tx(async (client) => {
    const out = await recordCall(client, req.body || {});
    return { receipt: "Call logged.", ...out };
  }, res));

  // POST /interactions/provider-event — DELIVERY/STATUS CALLBACK ONLY.
  // Twilio-signature-validated at the route (fail-closed: no signature or
  // bad signature → 403, zero rows). It cannot create inbound messages,
  // cannot accept a caller-supplied property, and cannot land arbitrary
  // body text in communication history. Inbound messages have one door:
  // POST /communications/inbound-sms.
  router.post("/interactions/provider-event",
    express.urlencoded({ extended: false, limit: "100kb" }),
    (req, res) => {
      if (!smsReady() || !sms.validateWebhook(req)) {
        console.error("provider-event: signature validation FAILED or transport off — rejected, zero rows.");
        return res.status(403).json({ receipt: "Invalid signature." });
      }
      const b = req.body || {};
      const provider_event_id = b.MessageSid || b.provider_event_id || b.SmsSid;
      const provider_status = b.MessageStatus || b.SmsStatus || b.provider_status || null;
      return tx(async (client) => {
        const out = await recordProviderStatus(client, {
          provider: "twilio", provider_event_id, provider_status, raw: b,
        });
        return {
          receipt: out.updated ? "Delivery status recorded." : "Unknown provider event — status ignored (status-only route).",
          ...out,
        };
      }, res);
    });

  // POST /interactions/consent — apply an opt-out/opt-in signal
  router.post("/interactions/consent", requireOperator, (req, res) => tx(async (client) => {
    const out = await applyConsentSignal(client, req.body || {});
    return { receipt: `Consent updated to ${out.consent_state}.`, ...out };
  }, res));

  // GET /interactions/thread — the unified timeline
  router.get("/interactions/thread", requireOperator, async (req, res) => {
    const client = await pool.connect();
    try {
      const rows = await readThread(client, { person_id: req.query.person_id, property_id: req.query.property_id });
      return res.json({ thread: rows });
    } catch (e) { return res.status(500).json({ receipt: e.message }); }
    finally { client.release(); }
  });

  router._service = { recordOutboundText, recordProviderStatus, applyConsentSignal, recordCall, readThread, ensureConversation };
  return router;
};
