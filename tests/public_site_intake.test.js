// ════════════════════════════════════════════════════════════════════
//  public_site_intake.test.js
//
//  The public site door: a property's own website posting an inquiry.
//  It is the one door a browser can reach, so every refusal here is a
//  refusal a stranger can provoke.
//
//  WHAT THIS PROVES, AND WHY EACH ONE EARNED ITS PLACE
//
//   1  property and source are SERVER-DERIVED from the site token. A
//      client-supplied property_id or source is not merely ignored, it
//      never reaches the service (§21).
//   2  consent is EXPLICIT ONLY. /demo/intake may treat an operator
//      opening the door as consent; a real prospect has not agreed to be
//      texted because someone set an env var. The door must never
//      synthesise a consent value.
//   3  attempt_sms is NOT passed. Its default means "ask the comms
//      boundary", not "send". Passing false would write the demo
//      semantic (ai_response_prepared / channel 'demo_browser') for a
//      real prospect, which is a false record of what happened.
//   4  the guards fire BEFORE any service call — honeypot, unbound door,
//      unknown token, rate limit, validation. A refused request must
//      create no partial person, lead or conversation.
//
//  The service is a SPY, so these assert what the door actually hands
//  the canonical intake — not what a copy of its logic would hand it.
//  No database, no network.
// ════════════════════════════════════════════════════════════════════

const express = require("express");
const http = require("http");
const publicSiteIntakeModule = require("../src/leasing/public_site_intake.js");

let run = 0, failed = 0;
function ok(label, cond, detail) {
  run++;
  if (cond) { console.log("  ok    " + label); return; }
  failed++;
  console.log("  FAIL  " + label + (detail ? "  →  " + detail : ""));
}
function section(t) { console.log("\n── " + t + " " + "─".repeat(Math.max(0, 52 - t.length))); }

const PROPERTY = "11111111-2222-3333-4444-555555555555";
const OTHER_PROPERTY = "99999999-8888-7777-6666-555555555555";
const TOKEN = "solo-site-tok";
const SOURCE = "solo_website";

//  Stand the REAL router up behind the same global JSON parser server.js
//  applies, so body handling is exercised as deployed rather than assumed.
function harness() {
  const calls = [];
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use("/", publicSiteIntakeModule({
    intakeProspect: async (payload) => {
      calls.push(payload);
      return { conversation_id: "conv-1", person_id: "p-1", lead_id: "l-1",
               receipt: "Known prospect — added a touch." };
    },
  }));
  return { app, calls };
}

function post(server, body, headers) {
  return new Promise((resolve) => {
    const data = JSON.stringify(body);
    const req = http.request({
      port: server.address().port, method: "POST", path: "/leasing/site-intake",
      headers: Object.assign({
        "content-type": "application/json",
        "content-length": Buffer.byteLength(data),
      }, headers || {}),
    }, (res) => {
      let raw = "";
      res.on("data", (c) => { raw += c; });
      res.on("end", () => {
        let parsed = null;
        try { parsed = JSON.parse(raw); } catch (_) { /* non-JSON is a finding */ }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on("error", () => resolve({ status: 0, body: null }));
    req.end(data);
  });
}

function listen(app) {
  return new Promise((resolve) => {
    const s = http.createServer(app).listen(0, "127.0.0.1", () => resolve(s));
  });
}

const VALID = { name: "Saherah Q", phone: "724-309-8434" };
const ORIGINAL_ENV = process.env.PUBLIC_SITE_INTAKE_TOKENS;

async function main() {
  console.log("════════════════════════════════════════════════════════════════");
  console.log("  HARNESS   public_site_intake.test.js");
  console.log("  DATABASE  (none — the canonical intake service is a spy)");
  console.log("════════════════════════════════════════════════════════════════");

  process.env.PUBLIC_SITE_INTAKE_TOKENS = `${TOKEN}:${PROPERTY}:${SOURCE}`;

  // ── 1 ──────────────────────────────────────────────────────────────
  section("SERVER-DERIVED PROPERTY AND SOURCE");
  {
    const { app, calls } = harness();
    const s = await listen(app);

    const r = await post(s, VALID, { "x-site-token": TOKEN });
    ok("a bound token is accepted", r.status === 200, `status ${r.status}`);
    ok("the service was called exactly once", calls.length === 1, String(calls.length));
    ok("property comes from the binding", calls[0] && calls[0].property_id === PROPERTY,
       calls[0] && calls[0].property_id);
    ok("source comes from the binding", calls[0] && calls[0].source === SOURCE,
       calls[0] && calls[0].source);

    //  The attack this exists to stop: a website claiming another
    //  property, or claiming to be Zillow to corrupt attribution.
    calls.length = 0;
    await post(s, Object.assign({}, VALID, {
      property_id: OTHER_PROPERTY, source: "zillow", source_name: "zillow",
    }), { "x-site-token": TOKEN });
    ok("a client-supplied property_id CANNOT redirect the lead",
       calls[0] && calls[0].property_id === PROPERTY, calls[0] && calls[0].property_id);
    ok("a client-supplied source CANNOT claim another channel",
       calls[0] && calls[0].source === SOURCE, calls[0] && calls[0].source);

    ok("the token itself is never stored in the payload",
       !JSON.stringify(calls[0]).includes(TOKEN));

    s.close();
  }

  // ── 2 ──────────────────────────────────────────────────────────────
  section("CONSENT IS EXPLICIT, NEVER SYNTHESISED");
  {
    const { app, calls } = harness();
    const s = await listen(app);

    await post(s, VALID, { "x-site-token": TOKEN });
    const noConsent = calls[0];
    const consentKeys = ["sms_consent", "text_consent", "consent", "tcpa_consent",
                         "agreed_to_texts", "agree_to_texts", "opt_in", "opted_in"];
    ok("no consent field on the form → NO consent key reaches the service",
       consentKeys.every((k) => !(k in noConsent)),
       consentKeys.filter((k) => k in noConsent).join(","));
    ok("and the absence is recorded rather than left ambiguous",
       noConsent.raw_payload.consent_field === null);

    calls.length = 0;
    await post(s, Object.assign({}, VALID, { sms_consent: "yes" }), { "x-site-token": TOKEN });
    ok("an explicit consent field is forwarded under the name the form used",
       calls[0].sms_consent === "yes" && calls[0].raw_payload.consent_field === "sms_consent");

    calls.length = 0;
    await post(s, Object.assign({}, VALID, { agreed_to_texts: false }), { "x-site-token": TOKEN });
    ok("an explicit REFUSAL is forwarded too, not dropped",
       calls[0].agreed_to_texts === false,
       "dropping it would let a later default read as consent");

    s.close();
  }

  // ── 3 ──────────────────────────────────────────────────────────────
  section("attempt_sms IS LEFT TO THE COMMS BOUNDARY");
  {
    const { app, calls } = harness();
    const s = await listen(app);
    await post(s, Object.assign({}, VALID, { attempt_sms: false }), { "x-site-token": TOKEN });

    ok("the door does not pass attempt_sms",
       !("attempt_sms" in calls[0]),
       "false writes the demo semantic; the boundary is the send authority");
    ok("nor response_channel — 'demo_browser' is not what happened here",
       !("response_channel" in calls[0]));
    s.close();
  }

  // ── 4 ──────────────────────────────────────────────────────────────
  section("EVERY GUARD FIRES BEFORE THE SERVICE IS CALLED");
  {
    const { app, calls } = harness();
    const s = await listen(app);

    calls.length = 0;
    const hp = await post(s, Object.assign({}, VALID, { company: "bot corp" }), { "x-site-token": TOKEN });
    ok("honeypot → bland success and NOTHING created",
       hp.status === 200 && hp.body.ok === true && calls.length === 0);
    ok("and the honeypot response does not reveal it was detected",
       !/bot|honeypot|spam/i.test(JSON.stringify(hp.body)));

    calls.length = 0;
    const noTok = await post(s, VALID, {});
    ok("missing token → 401, zero rows", noTok.status === 401 && calls.length === 0);

    calls.length = 0;
    const badTok = await post(s, VALID, { "x-site-token": "not-a-real-token" });
    ok("unknown token → 401, zero rows", badTok.status === 401 && calls.length === 0);

    calls.length = 0;
    const noName = await post(s, { phone: "724-309-8434" }, { "x-site-token": TOKEN });
    ok("missing name → 400, zero rows", noName.status === 400 && calls.length === 0);

    calls.length = 0;
    const noContact = await post(s, { name: "Saherah Q" }, { "x-site-token": TOKEN });
    ok("no phone and no email → 400, zero rows", noContact.status === 400 && calls.length === 0);
    ok("and the refusal is sayable to a stranger",
       /phone|email/i.test(noContact.body.receipt) && !/property_id|intakeProspect/i.test(noContact.body.receipt),
       noContact.body.receipt);

    s.close();
  }

  // ── 5 ──────────────────────────────────────────────────────────────
  section("AN UNBOUND DOOR REFUSES");
  {
    delete process.env.PUBLIC_SITE_INTAKE_TOKENS;
    const { app, calls } = harness();
    const s = await listen(app);
    const r = await post(s, VALID, { "x-site-token": TOKEN });
    ok("unset PUBLIC_SITE_INTAKE_TOKENS → 503, zero rows",
       r.status === 503 && calls.length === 0, `status ${r.status}`);
    ok("and it does not 404 — the route exists, it is unconfigured",
       r.status !== 404);
    s.close();

    process.env.PUBLIC_SITE_INTAKE_TOKENS = `${TOKEN}:${PROPERTY}:${SOURCE}`;
  }

  // ── 6 ──────────────────────────────────────────────────────────────
  section("RATE LIMITING, BEFORE ANY SERVICE CALL");
  {
    const { app, calls } = harness();
    const s = await listen(app);

    //  The phone limiter is the tighter of the two (3 per window), so it
    //  bites first for one prospect resubmitting.
    let limited = null;
    for (let i = 0; i < 6; i++) {
      const r = await post(s, VALID, { "x-site-token": TOKEN });
      if (r.status === 429) { limited = r; break; }
    }
    ok("a repeated submission is eventually rate-limited", limited !== null);
    ok("the limited response is sayable, not a stack trace",
       limited && /touch|inquiry/i.test(limited.body.receipt), limited && limited.body.receipt);
    ok("the limiter stopped the service being called for the refused request",
       calls.length < 6, `service calls: ${calls.length}`);
    s.close();
  }

  // ── 7 ──────────────────────────────────────────────────────────────
  section("BINDING PARSER — PARTIAL CONFIG IS NOT A PERMISSIVE DEFAULT");
  {
    const { parseBindings } = publicSiteIntakeModule({ intakeProspect: async () => ({}) }).__contract;

    ok("a full binding parses", parseBindings("t:p:s").get("t").propertyId === "p");
    ok("a two-part binding is DROPPED, not defaulted", parseBindings("t:p").size === 0);
    ok("a token-only binding is DROPPED", parseBindings("t").size === 0);
    ok("an empty entry is skipped", parseBindings("t:p:s,,").size === 1);
    ok("multiple properties bind independently",
       parseBindings("a:p1:s1,b:p2:s2").get("b").propertyId === "p2");
    ok("whitespace around entries is tolerated",
       parseBindings(" a : p1 : s1 ").get("a").sourceName === "s1");
  }

  // ── 8 ──────────────────────────────────────────────────────────────
  section("THE SERVICE IS NOT FORKED");
  {
    let threw = false;
    try { publicSiteIntakeModule({}); } catch (_) { threw = true; }
    ok("the module REFUSES to construct without the canonical service", threw,
       "a door that can build its own intake is a second implementation");
  }

  if (ORIGINAL_ENV === undefined) delete process.env.PUBLIC_SITE_INTAKE_TOKENS;
  else process.env.PUBLIC_SITE_INTAKE_TOKENS = ORIGINAL_ENV;

  console.log("\n════════════════════════════════════════════════════════════════");
  console.log(`  ASSERTIONS COMPLETE · ${run} run · ${run - failed} passed · ${failed} failed`);
  console.log(failed
    ? "  ✗ FAIL — public_site_intake.test.js"
    : "  ✓ PASS — the public door derives its own authority and invents no consent.");
  console.log("  EXIT      " + (failed ? 1 : 0));
  console.log("════════════════════════════════════════════════════════════════");
  process.exit(failed ? 1 : 0);
}

main();
