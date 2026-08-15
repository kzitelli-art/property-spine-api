// ════════════════════════════════════════════════════════════════════
//  public_site_intake.js — THE BROWSER-SAFE PUBLIC DOOR
//
//  A property's own website (Solo's site today; any property's later)
//  posts its inquiry form here. This is the third door onto the ONE
//  canonical intake service, and it is not a second implementation:
//
//    /leasing/intake     server-to-server. Shared secret bound to a
//                        property set. Zillow, Apartments.com, any
//                        syndication partner that can hold a credential.
//    /demo/intake        the boardroom demo. DEMO_MODE-gated, pinned to
//                        the Demo Building, mints a booking continuation.
//    /leasing/site-intake  THIS. A browser form on a real property's
//                        public website, which can hold no secret at all.
//
//  WHY A THIRD DOOR AND NOT A FLAG ON AN EXISTING ONE
//  A browser cannot hold LEASING_INTAKE_SECRET — client-side JS
//  publishes it, so the authenticated door is unusable from a website.
//  And /demo/intake is correctly pinned to the Demo Building and gated
//  on DEMO_MODE; widening it would make one door mean two things, which
//  §17 forbids. The service underneath is shared; only the door differs.
//
//  ── WHAT THIS DOOR DECIDES, AND WHAT IT REFUSES TO DECIDE ──────────
//
//  DECIDES   which property and which lead source this submission is
//            for, SERVER-SIDE, from a site token bound in env. A
//            client-supplied property_id or source is never read (§21).
//            Binding the source too means a website cannot claim to be
//            Zillow and corrupt channel attribution.
//
//  REFUSES   whether the prospect may be texted. That is the comms
//            boundary's decision, made from SMS_SEND_MODE, a
//            relationship at this property, and
//            contact_preferences.consent_state — the one canonical
//            consent truth. This door passes the form's consent signal
//            through and asserts nothing.
//
//  ── CONSENT IS EXPLICIT HERE, AND THAT DIFFERS FROM THE DEMO DOOR ──
//  /demo/intake treats "live SMS deliberately enabled + no consent
//  field" as consent, reasoning that an operator opened that door
//  knowingly. That is defensible for a controlled demo door.
//
//  IT IS NOT DEFENSIBLE FOR A REAL PUBLIC WEBSITE. A prospect has not
//  agreed to be texted because an operator set an env var. This door
//  therefore forwards ONLY an explicit consent signal from the form and
//  never synthesises one. Absent consent the person is still captured
//  as a lead — honestly, and un-textable.
//
//  ── THIS DOOR IS NECESSARY AND NOT SUFFICIENT ──────────────────────
//  intakeProspect writes the contact_preferences opt-in row ONLY when
//  the property is on PROSPECT_ACTIVATION_PROPERTY_IDS *and* a consent
//  signal is present. That allowlist deliberately excludes real Solo:
//
//    "a bug cannot accidentally activate an unlisted property,
//     e.g. real Solo"  — leasingleads.js
//
//  So until a property's id is deliberately added to that allowlist,
//  leads arriving here are captured but land as internal_qa: excluded
//  from outreach, reporting, metrics and AI prompts, and never texted
//  even if the prospect ticked the box. That is the correct default and
//  it is not a bug in this door — activating a real property is meant
//  to be a conscious act, like a migration release. Standing this door
//  up and adding the property to the allowlist are TWO steps.
//
//  Class 1 — permanent product primitive. The public door is how a
//  property's own website reaches Spine; it does not retire.
//
//  Env:
//    PUBLIC_SITE_INTAKE_TOKENS   required. Comma-separated bindings of
//                                token:property_uuid:source_name
//                                Absent → this door refuses (503).
// ════════════════════════════════════════════════════════════════════

const express = require("express");

//  ── THE SITE-TOKEN BINDING ──────────────────────────────────────────
//  Mirrors LEASING_INTAKE_PROPERTY_IDS: the credential does not merely
//  authenticate, it CARRIES the property it is allowed to write to. A
//  token cannot request a different property because the request never
//  supplies one — there is no field to poison.
//
//  A site token is public by nature (it ships in a web page), so it is
//  an IDENTIFIER, not a secret. It buys exactly one capability: create a
//  lead on the one property it is bound to, tagged with the one source
//  it is bound to. Rotating it is an env edit; a leaked token can create
//  spam leads on that property and nothing else, which is what the rate
//  limits below are for.
function parseBindings(raw) {
  const bindings = new Map();
  for (const entry of String(raw || "").split(",")) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(":").map((s) => s.trim());
    //  token : property_uuid : source_name — all three required. A
    //  partial binding is a configuration error, not a permissive
    //  default: skipping it means the token simply does not resolve.
    if (parts.length !== 3) continue;
    const [token, propertyId, sourceName] = parts;
    if (!token || !propertyId || !sourceName) continue;
    bindings.set(token, { propertyId, sourceName });
  }
  return bindings;
}

//  Fixed window, checked BEFORE any database work so a limited request
//  creates no partial person, lead or conversation. Keyed by IP and by
//  normalized phone independently: one abusive IP cannot bury a property,
//  and one phone cannot be resubmitted in a loop from many IPs.
//
//  DUPLICATION, DECLARED: /demo/intake carries an equivalent limiter.
//  They are not shared because extracting one would mean editing
//  leasingleads.js while lifecycle work is uncommitted in it. Converge
//  them when that work lands — the shape is identical and the limits are
//  the only thing that legitimately differ per door.
function makeRateLimiter({ max, windowMs }) {
  const buckets = new Map();
  return function allow(key) {
    if (!key) return true;
    const now = Date.now();
    let e = buckets.get(key);
    if (!e || now - e.start > windowMs) { e = { start: now, n: 0 }; buckets.set(key, e); }
    e.n += 1;
    if (buckets.size > 5000) {
      for (const [k, v] of buckets) if (now - v.start > windowMs) buckets.delete(k);
    }
    return e.n <= max;
  };
}

//  The consent field names intakeProspect's extractConsentSignal already
//  understands. Forwarded VERBATIM and only when the form actually sent
//  one — this door never invents a value, so an absent checkbox stays
//  absent all the way down rather than becoming a default.
const CONSENT_FIELDS = [
  "sms_consent", "text_consent", "consent", "tcpa_consent",
  "agreed_to_texts", "agree_to_texts", "opt_in", "opted_in",
];

function explicitConsent(body) {
  for (const field of CONSENT_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(body, field) && body[field] !== undefined) {
      return { field, value: body[field] };
    }
  }
  return null;
}

//  A stated move-month is a first-party captured fact. Same validation
//  the demo door applies: a YYYY-MM inside the next twelve months, or
//  'flexible'. Anything else is null rather than a guess (§5).
function normalizeMoveMonth(v) {
  if (v === "flexible") return "flexible";
  if (typeof v !== "string" || !/^\d{4}-(0[1-9]|1[0-2])$/.test(v)) return null;
  const now = new Date();
  const current = now.getFullYear() * 12 + now.getMonth();
  const [y, m] = v.split("-").map(Number);
  const target = y * 12 + (m - 1);
  return (target >= current && target <= current + 12) ? v : null;
}

module.exports = function publicSiteIntakeModule({ intakeProspect }) {
  const router = express.Router();

  //  Injected rather than required: intakeProspect is created inside the
  //  leasingleads factory with its own pool, comms boundary and strategy
  //  runtime. Reaching around that to build a second one would be the
  //  fork this module exists to avoid.
  if (typeof intakeProspect !== "function") {
    throw new Error("public_site_intake requires the canonical intakeProspect service.");
  }

  const allowIp = makeRateLimiter({ max: 8, windowMs: 10 * 60 * 1000 });
  const allowPhone = makeRateLimiter({ max: 3, windowMs: 10 * 60 * 1000 });

  //  NO route-level body parser. server.js applies express.json({limit:"1mb"})
  //  globally, and Express skips a second parser once req._body is set — so a
  //  tighter cap declared here would read like a guard and enforce nothing.
  //  The cap is global; change it there or not at all.
  //
  //  JSON only, which is the existing convention: /demo/intake relies on the
  //  same global parser and the site posting to it today works. If a property
  //  site ever posts a plain urlencoded form, that is a deliberate one-line
  //  addition with a real reason, not a speculative one now.
  router.post("/leasing/site-intake",
    async (req, res) => {
      res.set("Cache-Control", "no-store");
      try {
        //  ── fail closed on an unbound door ──
        //  Not a 404: the route exists and is simply not configured. An
        //  operator reading the log needs to know which of those it is.
        const bindings = parseBindings(process.env.PUBLIC_SITE_INTAKE_TOKENS);
        if (bindings.size === 0) {
          console.error("site-intake: PUBLIC_SITE_INTAKE_TOKENS is not set — the public site door refuses.");
          return res.status(503).json({
            receipt: "This inquiry form is not connected yet. Please call the office.",
          });
        }

        const b = req.body || {};

        //  ── honeypot, before anything else ──
        //  A hidden field no human sees. Bots that fill it get a bland
        //  success and NOTHING is created — telling a bot it was detected
        //  only teaches it to try again differently.
        if (typeof b.company === "string" && b.company.trim() !== "") {
          return res.json({ ok: true, receipt: "Your inquiry was received." });
        }

        //  ── resolve the door, SERVER-SIDE ──
        const token = String(req.headers["x-site-token"] || b.site_token || "").trim();
        const binding = token ? bindings.get(token) : null;
        if (!binding) {
          console.error("site-intake: unrecognised or missing site token — refused, zero rows.");
          return res.status(401).json({
            receipt: "This inquiry form is not recognised. Please call the office.",
          });
        }

        //  ── rate limit BEFORE any database work ──
        const ip = (req.headers["x-forwarded-for"] || "").split(",")[0].trim()
          || req.ip || req.connection?.remoteAddress || "unknown";
        if (!allowIp(ip)) {
          return res.status(429).json({ receipt: "Too many inquiries from this connection. Please try again shortly." });
        }
        //  Keyed on the raw submitted phone. This is deliberately NOT the
        //  canonical E.164 normalization: doing that here would mean a
        //  second phone-identity implementation, and phone_identity.js is
        //  the one door for that (it is applied inside intakeProspect).
        //  A limiter key only has to be stable, not canonical.
        const phoneKey = typeof b.phone === "string" ? b.phone.replace(/\D/g, "") : "";
        if (phoneKey && !allowPhone(phoneKey)) {
          return res.status(429).json({ receipt: "We already have your inquiry. Someone will be in touch shortly." });
        }

        //  ── validation ──
        const firstNameRaw = typeof b.first_name === "string" ? b.first_name.trim().slice(0, 40) : "";
        const lastNameRaw = typeof b.last_name === "string" ? b.last_name.trim().slice(0, 40) : "";
        const name = (typeof b.name === "string" && b.name.trim())
          ? b.name.trim()
          : [firstNameRaw, lastNameRaw].filter(Boolean).join(" ");
        if (name.length < 2 || name.length > 80 || !/[a-zA-Z]/.test(name)) {
          return res.status(400).json({ receipt: "Please enter your name." });
        }
        //  intakeProspect requires a phone or an email to identify the
        //  person. Refusing here gives the prospect a sayable message
        //  rather than surfacing the service's internal wording.
        const hasPhone = typeof b.phone === "string" && b.phone.trim() !== "";
        const hasEmail = typeof b.email === "string" && b.email.includes("@");
        if (!hasPhone && !hasEmail) {
          return res.status(400).json({ receipt: "Please enter a phone number or an email address." });
        }

        //  ── explicit consent only ──
        //  Forwarded under the name the form used so extractConsentSignal
        //  reads the prospect's actual answer. No field, no assertion.
        const consent = explicitConsent(b);

        const payload = {
          //  SERVER-DERIVED. The browser supplies neither of these and
          //  there is no field for it to supply them in.
          property_id: binding.propertyId,
          source: binding.sourceName,
          name,
          phone: hasPhone ? b.phone : null,
          email: hasEmail ? b.email : null,
          message: typeof b.message === "string" ? b.message.slice(0, 2000) : null,
          //  attempt_sms is deliberately NOT set. Its default is true,
          //  which means "ask the comms boundary" — not "send". The
          //  boundary refuses unless SMS_SEND_MODE is customer_care, the
          //  person has a relationship at this property, and consent is
          //  recorded as opted_in. Passing false here would instead write
          //  the demo semantic (ai_response_prepared, channel
          //  'demo_browser'), which for a real prospect who filled in a
          //  form and expects a reply is a false record of what happened.
          raw_payload: {
            channel: "public_site_intake",
            desired_move_month: normalizeMoveMonth(b.desired_move_month),
            first_name: firstNameRaw || null,
            last_name: lastNameRaw || null,
            //  The token is a credential-shaped binding and never lands
            //  in a stored payload; the source name it resolved to is
            //  the durable attribution and is already on the lead.
            consent_field: consent ? consent.field : null,
          },
        };
        if (consent) payload[consent.field] = consent.value;

        const out = await intakeProspect(payload);

        //  The prospect sees a plain acknowledgement. The service's
        //  receipt is operator language ("Known prospect — added a touch
        //  to their open opportunity") and is not for this audience.
        return res.json({
          ok: true,
          receipt: "Thanks — your inquiry is in. Someone will be in touch shortly.",
          //  Not shown to the prospect; useful to the site's own code and
          //  to anyone reading a browser network tab during a proof.
          conversation_id: out.conversation_id || null,
        });
      } catch (e) {
        //  intakeProspect throws { httpStatus, publicReceipt } on known
        //  failures. Anything else is ours and must not leak its message
        //  to a public caller.
        if (e && e.httpStatus && e.publicReceipt) {
          return res.status(e.httpStatus).json({ receipt: e.publicReceipt });
        }
        console.error("site-intake failed:", e && e.message);
        return res.status(500).json({ receipt: "We couldn't record that inquiry. Please call the office." });
      }
    });

  //  Published so proofs bind to the same values the door uses.
  router.__contract = { parseBindings, explicitConsent, normalizeMoveMonth, CONSENT_FIELDS };
  return router;
};
