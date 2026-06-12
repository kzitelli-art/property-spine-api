// ════════════════════════════════════════════════════════════════════
//  SMS TRANSPORT — sms.js (Twilio)
//
//  PURE TRANSPORT. This module knows how to put a text on the wire and
//  how to prove an inbound webhook really came from Twilio. It knows
//  NOTHING about tenants, conversations, classification, or the spine —
//  that all lives in tenantlink.js. One spine, two doors; this is just
//  the second door's hinge.
//
//  Fail-soft by design:
//    • twilio package missing → transport disabled, server still boots.
//    • env vars missing       → transport disabled, callers get an
//      honest { sent:false, reason } — never a throw, never a crash.
//    • Webhook validation is FAIL-CLOSED: no auth token or bad
//      signature → reject. An unverifiable webhook is not a message.
//
//  Env (set in Render):
//    TWILIO_ACCOUNT_SID            required to enable
//    TWILIO_AUTH_TOKEN             required to enable (also signs webhooks)
//    TWILIO_MESSAGING_SERVICE_SID  optional — the A2P campaign's service;
//                                  pass it so carriers see registered traffic
//    APP_BASE_URL                  required for webhook signature validation
//                                  (Render sits behind a proxy; the signed
//                                  URL must be the PUBLIC https URL)
// ════════════════════════════════════════════════════════════════════

let twilio = null;
try { twilio = require("twilio"); } catch (e) {
  console.error("sms: twilio package not installed — SMS transport disabled.");
}

module.exports = function smsTransport() {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const messagingServiceSid = process.env.TWILIO_MESSAGING_SERVICE_SID || null;
  const client = (twilio && accountSid && authToken) ? twilio(accountSid, authToken) : null;
  if (!client) console.error("sms: transport NOT configured (set TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN). Text line runs link-only.");

  return {
    enabled() { return !!client; },

    // Send one SMS. Returns a receipt object, never throws.
    //   { sent:true, sid, status }  or  { sent:false, reason, error? }
    async sendSms({ to, from, body }) {
      if (!client) return { sent: false, reason: "transport_not_configured" };
      if (!to) return { sent: false, reason: "no_destination" };
      if (!body) return { sent: false, reason: "empty_body" };
      try {
        const params = { to, body: String(body).slice(0, 1500) };
        if (messagingServiceSid) params.messagingServiceSid = messagingServiceSid;
        if (from) params.from = from; // pins the property line even under a messaging service
        const m = await client.messages.create(params);
        return { sent: true, sid: m.sid, status: m.status };
      } catch (e) {
        console.error("sms send failed:", e.message);
        return { sent: false, reason: "send_failed", error: e.message };
      }
    },

    // Verify X-Twilio-Signature on an inbound webhook. FAIL-CLOSED.
    // Requires the route to have parsed the form body (urlencoded) first.
    validateWebhook(req) {
      if (!twilio || !authToken) return false;
      const signature = req.headers["x-twilio-signature"];
      if (!signature) return false;
      const base = process.env.APP_BASE_URL
        ? process.env.APP_BASE_URL.replace(/\/+$/, "")
        : `${req.protocol}://${req.get("host")}`;
      const url = base + req.originalUrl;
      try {
        return twilio.validateRequest(authToken, signature, url, req.body || {});
      } catch (e) {
        console.error("sms webhook validation error:", e.message);
        return false;
      }
    },
  };
};
