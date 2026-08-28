// ════════════════════════════════════════════════════════════════════
//  SMS TRANSPORT — sms.js (Twilio)
//
//  PURE TRANSPORT. This module knows how to put a text on the wire and
//  how to prove an inbound webhook really came from Twilio. It knows
//  NOTHING about tenants, conversations, classification, or the spine —
//  that all lives in tenant_link.js. One spine, two doors; this is just
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

const https = require("https");

let twilio = null;
try { twilio = require("twilio"); } catch (e) {
  console.error("sms: twilio package not installed — SMS transport disabled.");
}

// ── GOVERNED MEDIA HOSTS ────────────────────────────────────────────
//  EXPLICIT, not suffix matching. `endsWith("twilio.com")` would accept
//  `evil-twilio.com` and `nottwilio.com`; there is no cheap way to write
//  that check safely, so it is not written at all.
//
//  Twilio serves MMS media in two hops: an authenticated resource on
//  api.twilio.com that 307s to a pre-signed URL on mms.twiliocdn.com.
//  The second host needs NO credentials and must never receive them.
const MEDIA_HOST_AUTHENTICATED = "api.twilio.com";
const MEDIA_HOST_REDIRECT = "mms.twiliocdn.com";
const MEDIA_MAX_REDIRECTS = 3;
const MEDIA_TIMEOUT_MS = 10000;
const MEDIA_ALLOWED_MIME = ["image/jpeg", "image/png", "image/webp"];

//  Content-Type minus parameters, lowercased. `image/jpeg; charset=binary`
//  and `IMAGE/JPEG` are the same media type and must compare equal.
function normalizeMime(v) {
  if (!v) return null;
  const t = String(v).split(";")[0].trim().toLowerCase();
  return t || null;
}

module.exports = function smsTransport(opts) {
  //  Injected ONLY so the media path can be proven without a socket. It
  //  defaults to the real https.request, so production has exactly one
  //  code path and the tests exercise that path rather than a copy.
  const requestFn = (opts && opts.requestFn) || https.request;
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

    // ── MEDIA PRESERVATION ──────────────────────────────────────────
    //  Turn an authenticated Twilio media reference into bytes, or say
    //  exactly why not. NEVER THROWS to its caller — evidence_service
    //  treats a throw and a soft failure differently and only one of
    //  them is a truthful outcome.
    //
    //  This is a TWILIO MEDIA TRANSPORT, not a URL downloader. It will
    //  fetch from two governed hosts and nowhere else.
    //
    //  Credentials appear in an Authorization header sent to
    //  api.twilio.com only. They are never placed in the URL, never
    //  logged, never returned in an error, and never forwarded across a
    //  redirect that changes origin.
    async fetchMedia({ url, mime_type, max_bytes } = {}) {
      if (!accountSid || !authToken) return { ok: false, reason: "transport_not_configured" };

      //  The cap is SUPPLIED by the evidence boundary, not invented here.
      //  A second hidden limit in the transport would drift from the one
      //  the database actually enforces.
      const cap = Number(max_bytes);
      if (!Number.isFinite(cap) || cap <= 0) return { ok: false, reason: "invalid_max_bytes" };

      const declared = normalizeMime(mime_type);
      if (!declared || !MEDIA_ALLOWED_MIME.includes(declared)) {
        return { ok: false, reason: "unsupported_mime" };
      }

      let target;
      try { target = new URL(String(url)); }
      catch (e) { return { ok: false, reason: "invalid_media_url" }; }
      if (target.protocol !== "https:") return { ok: false, reason: "invalid_media_url" };
      if (target.hostname !== MEDIA_HOST_AUTHENTICATED) {
        return { ok: false, reason: "unsupported_media_url" };
      }

      let hops = 0;
      while (true) {
        const authed = target.hostname === MEDIA_HOST_AUTHENTICATED;
        let res;
        try {
          res = await new Promise((resolve, reject) => {
            const headers = { Accept: MEDIA_ALLOWED_MIME.join(", ") };
            //  BASIC AUTH ON THE AUTHENTICATED HOST ONLY. The redirect
            //  target carries its own signature in the URL and must not
            //  see the account credentials.
            if (authed) {
              headers.Authorization = "Basic "
                + Buffer.from(`${accountSid}:${authToken}`).toString("base64");
            }
            const req = requestFn({
              protocol: target.protocol, hostname: target.hostname,
              port: target.port || undefined,
              path: target.pathname + target.search,
              method: "GET", headers,
            }, resolve);
            req.on("error", reject);
            req.setTimeout(MEDIA_TIMEOUT_MS, () => {
              req.destroy(Object.assign(new Error("timeout"), { __timeout: true }));
            });
            req.end();
          });
        } catch (e) {
          if (e && e.__timeout) return { ok: false, reason: "fetch_timeout" };
          //  The message may carry a host or a path; the reason must not.
          return { ok: false, reason: "fetch_failed" };
        }

        const status = res.statusCode;

        if (status === 401 || status === 403) {
          res.resume();
          return { ok: false, reason: "authentication_failed" };
        }

        if (status >= 300 && status < 400) {
          res.resume();
          const loc = res.headers && res.headers.location;
          if (!loc) return { ok: false, reason: `http_${status}` };
          if (++hops > MEDIA_MAX_REDIRECTS) return { ok: false, reason: "too_many_redirects" };
          let next;
          try { next = new URL(loc, target); }
          catch (e) { return { ok: false, reason: "invalid_media_url" }; }
          if (next.protocol !== "https:") return { ok: false, reason: "invalid_media_url" };
          if (next.hostname !== MEDIA_HOST_AUTHENTICATED
              && next.hostname !== MEDIA_HOST_REDIRECT) {
            return { ok: false, reason: "unsupported_media_url" };
          }
          target = next;
          continue;
        }

        if (status !== 200) { res.resume(); return { ok: false, reason: `http_${status}` }; }

        //  DECLARED LENGTH FIRST — refuse before a single body byte is
        //  buffered. The post-fetch check in evidence_service stays as
        //  defense in depth, but it cannot protect memory.
        const len = Number(res.headers && res.headers["content-length"]);
        if (Number.isFinite(len) && len > cap) { res.resume(); return { ok: false, reason: "too_large" }; }

        const actual = normalizeMime(res.headers && res.headers["content-type"]);
        if (!actual || !MEDIA_ALLOWED_MIME.includes(actual)) {
          res.resume();
          return { ok: false, reason: "unsupported_mime" };
        }
        //  What the carrier CLAIMED in the webhook versus what the origin
        //  actually served. A mismatch is not a preservable photo.
        if (actual !== declared) { res.resume(); return { ok: false, reason: "mime_mismatch" }; }

        //  STREAM AND COUNT. An oversized Buffer is never constructed —
        //  the read is aborted the moment the cap is crossed.
        const outcome = await new Promise((resolve) => {
          const chunks = [];
          let seen = 0, settled = false;
          const done = (v) => { if (!settled) { settled = true; resolve(v); } };
          res.on("data", (chunk) => {
            if (settled) return;
            seen += chunk.length;
            if (seen > cap) {
              //  SETTLE THE REASON BEFORE DESTROYING. res.destroy() emits
              //  'aborted' synchronously, and the aborted handler would
              //  otherwise win the race and report `fetch_aborted` — true,
              //  but a worse diagnosis than the one we actually know.
              chunks.length = 0;
              done({ ok: false, reason: "too_large" });
              res.destroy();
              return;
            }
            chunks.push(chunk);
          });
          res.on("aborted", () => done({ ok: false, reason: "fetch_aborted" }));
          res.on("error", () => done({ ok: false, reason: "fetch_failed" }));
          res.on("end", () => {
            if (!seen) return done({ ok: false, reason: "empty_body" });
            done({ ok: true, buffer: Buffer.concat(chunks, seen), mime: actual });
          });
        });
        return outcome;
      }
    },

    // Verify X-Twilio-Signature on an inbound webhook. FAIL-CLOSED.
    // Requires the route to have parsed the form body (urlencoded) first.
    validateWebhook(req) {
      if (!twilio || !authToken) return false;
      const signature = req.headers["x-twilio-signature"];
      if (!signature) return false;
      //  APP_BASE_URL IS REQUIRED, AND NOW ENFORCED.
      //  The header above has always said so. The code used to fall back
      //  to `${req.protocol}://${req.get("host")}`, which behind a proxy
      //  reconstructs http:// where Twilio signed https:// — every message
      //  then fails validation with a correct-looking 403, and a negative
      //  control passes for entirely the wrong reason. Guessing the signed
      //  URL is worse than refusing to guess.
      const configured = process.env.APP_BASE_URL;
      if (!configured) {
        console.error("sms: APP_BASE_URL is not set — webhook validation refuses.");
        return false;
      }
      let base;
      try {
        const u = new URL(configured);
        if (u.protocol !== "https:") {
          console.error("sms: APP_BASE_URL must be an https origin — webhook validation refuses.");
          return false;
        }
        base = configured.replace(/\/+$/, "");
      } catch (e) {
        console.error("sms: APP_BASE_URL is malformed — webhook validation refuses.");
        return false;
      }
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

//  Published so the proof binds to the SAME values the transport uses,
//  rather than to a copy that could drift.
module.exports.MEDIA_HOST_AUTHENTICATED = MEDIA_HOST_AUTHENTICATED;
module.exports.MEDIA_HOST_REDIRECT = MEDIA_HOST_REDIRECT;
module.exports.MEDIA_MAX_REDIRECTS = MEDIA_MAX_REDIRECTS;
module.exports.MEDIA_TIMEOUT_MS = MEDIA_TIMEOUT_MS;
module.exports.MEDIA_ALLOWED_MIME = MEDIA_ALLOWED_MIME.slice();
module.exports.normalizeMime = normalizeMime;
