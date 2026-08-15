// ════════════════════════════════════════════════════════════════════
//  sms_delivery_status_callback.test.js
//
//  THE DEFECT THIS EXISTS TO PREVENT COMING BACK
//
//  Twilio delivered Saherah's message. Property Spine showed `queued`,
//  and kept showing it. Not a missing status — a FALSE one, which is
//  what §5 forbids and what §29 separates: intent and delivery are two
//  facts, and the delivery fact was never arriving.
//
//  The receiving door had always existed and always worked:
//    POST /interactions/provider-event  — signature-validated,
//    fail-closed, reads MessageStatus, calls recordProviderStatus.
//
//  Nothing was ever pointed at it. `client.messages.create()` was called
//  with no `statusCallback`, so Twilio had nowhere to report and the row
//  kept the status creation returned. The status was terminal by
//  omission.
//
//  THE SECOND DEFECT, WHICH WOULD HAVE BEEN WORSE
//
//  Twilio signs the URL it is GIVEN. validateWebhook re-hashes
//  `origin + req.originalUrl` to check it. If the send side and the
//  validate side derive that origin separately, they can drift — and
//  the drift is silent in the worst direction: every delivery receipt
//  fails validation, returns a correct-looking 403, and the symptom is
//  identical to the bug we just fixed. A fix that reintroduced the
//  symptom through a different door would be very hard to see.
//
//  So the load-bearing assertion here is not "a callback is set." It is
//  that BOTH SIDES DERIVE THE SAME STRING FROM ONE FUNCTION.
//
//  No database. No network. No Twilio client.
// ════════════════════════════════════════════════════════════════════

const fs = require("fs");
const path = require("path");

const SMS_PATH = path.join(__dirname, "..", "src", "comms", "sms.js");
const sms = require(SMS_PATH);
const src = fs.readFileSync(SMS_PATH, "utf8");

//  A mention is not a guard: prose must not be able to satisfy an
//  assertion about code.
function stripComments(s) {
  return s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}
const code = stripComments(src);

let run = 0, failed = 0;
function ok(label, cond, detail) {
  run++;
  if (cond) { console.log("  ok    " + label); return; }
  failed++;
  console.log("  FAIL  " + label + (detail ? "  →  " + detail : ""));
}
function section(t) { console.log("\n── " + t + " " + "─".repeat(Math.max(0, 50 - t.length))); }

const ORIGINAL_BASE = process.env.APP_BASE_URL;
function withBase(v, fn) {
  if (v === undefined) delete process.env.APP_BASE_URL;
  else process.env.APP_BASE_URL = v;
  try { return fn(); } finally {
    if (ORIGINAL_BASE === undefined) delete process.env.APP_BASE_URL;
    else process.env.APP_BASE_URL = ORIGINAL_BASE;
  }
}

//  Quiet the deliberate refusal logging so a passing run reads clean.
const realError = console.error;
function quiet(fn) {
  console.error = () => {};
  try { return fn(); } finally { console.error = realError; }
}

console.log("════════════════════════════════════════════════════════════════");
console.log("  HARNESS   sms_delivery_status_callback.test.js");
console.log("  DATABASE  (none — this harness needs no database)");
console.log("  CALLBACK  " + sms.STATUS_CALLBACK_PATH);
console.log("════════════════════════════════════════════════════════════════");

// ── 1 ────────────────────────────────────────────────────────────────
section("THE PATH MATCHES THE ROUTE THAT RECEIVES IT");

ok("the callback path is the provider-event door",
   sms.STATUS_CALLBACK_PATH === "/interactions/provider-event",
   sms.STATUS_CALLBACK_PATH);

//  The router is mounted at "/" in server.js, so originalUrl has no
//  prefix. If someone remounts it, the signature stops matching and this
//  goes red rather than the symptom returning silently.
const serverSrc = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
ok("the interactions router is still mounted at \"/\"",
   /app\.use\("\/",\s*__leasingInteractions\)/.test(serverSrc),
   "remounting it changes originalUrl and breaks signature validation");

const interactionsSrc = fs.readFileSync(
  path.join(__dirname, "..", "src", "leasing", "leasinginteractions.js"), "utf8");
ok("the receiving route exists at that exact path",
   interactionsSrc.includes('router.post("/interactions/provider-event"'));

ok("the callback URL carries no query string",
   !sms.STATUS_CALLBACK_PATH.includes("?"),
   "the signature covers the URL exactly as Twilio received it");

// ── 2 ────────────────────────────────────────────────────────────────
section("ONE DERIVATION — THE TWO SIDES CANNOT DRIFT");

//  This is the assertion that matters. Both callers go through the same
//  function, so there is no second place for the origin to be computed.
const derivations = (code.match(/process\.env\.APP_BASE_URL/g) || []).length;
ok("APP_BASE_URL is read in exactly ONE place in the transport",
   derivations === 1,
   `found ${derivations} reads — a second read is a second derivation`);

ok("validateWebhook builds its URL from the shared resolver",
   /const\s+base\s*=\s*resolveSignedOrigin\(/.test(code) &&
   /const\s+url\s*=\s*base\s*\+\s*req\.originalUrl/.test(code));

ok("sendSms builds its callback from the shared resolver",
   /const\s+origin\s*=\s*resolveSignedOrigin\(/.test(code) &&
   /params\.statusCallback\s*=\s*origin\s*\+\s*STATUS_CALLBACK_PATH/.test(code));

//  Same input, same string, whatever the callers are called.
withBase("https://api.example.com", () => {
  const a = sms.resolveSignedOrigin("delivery-status tracking");
  const b = sms.resolveSignedOrigin("webhook validation");
  ok("both purposes resolve to an identical origin", a === b && a === "https://api.example.com",
     `${a} vs ${b}`);
});

withBase("https://api.example.com///", () => {
  ok("trailing slashes are stripped, so the URL never doubles its separator",
     sms.resolveSignedOrigin("x") + sms.STATUS_CALLBACK_PATH ===
       "https://api.example.com/interactions/provider-event",
     sms.resolveSignedOrigin("x") + sms.STATUS_CALLBACK_PATH);
});

// ── 3 ────────────────────────────────────────────────────────────────
section("THE SEND SIDE ACTUALLY WIRES IT UP");

ok("statusCallback is passed to messages.create",
   /params\.statusCallback\s*=/.test(code) &&
   /client\.messages\.create\(params\)/.test(code),
   "without this Twilio has nowhere to report and the status is terminal");

//  Order matters: assignment must happen before the create call, or the
//  parameter never reaches Twilio.
ok("statusCallback is set BEFORE messages.create is called",
   code.indexOf("params.statusCallback") < code.indexOf("client.messages.create(params)"));

ok("the send receipt states whether the status can ever move",
   /delivery_tracking:/.test(code),
   "a surface waiting on an update that cannot arrive renders stale as live");

// ── 4 ────────────────────────────────────────────────────────────────
section("REFUSES RATHER THAN GUESSES");

quiet(() => {
  withBase(undefined, () => {
    ok("unset APP_BASE_URL resolves to null, not a guessed origin",
       sms.resolveSignedOrigin("test") === null);
  });

  withBase("http://api.example.com", () => {
    ok("a non-https origin is refused",
       sms.resolveSignedOrigin("test") === null,
       "http:// where Twilio signed https:// fails every message");
  });

  withBase("not a url at all", () => {
    ok("a malformed origin is refused",
       sms.resolveSignedOrigin("test") === null);
  });

  withBase("", () => {
    ok("an empty origin is refused",
       sms.resolveSignedOrigin("test") === null);
  });
});

//  The refusal must not become a silent send-without-tracking that looks
//  identical to a healthy send.
ok("an unresolvable origin yields the honest tracking flag, not silence",
   /unavailable_no_app_base_url/.test(code));

ok("no fallback to request host survives anywhere in the transport",
   !/req\.protocol/.test(code) && !/req\.get\("host"\)/.test(code),
   "guessing the signed URL is worse than refusing to guess");

// ── 5 ────────────────────────────────────────────────────────────────
section("FALSIFICATION — THESE WOULD CATCH A REGRESSION");

//  Prove the drift assertion has teeth: a second env read must fail it.
const withSecondRead = code.replace(
  /return configured\.replace\(\/\\\/\+\$\/, ""\);/,
  'return configured.replace(/\\/+$/, "");'
) + '\nconst sneaky = process.env.APP_BASE_URL;\n';
ok("the one-derivation check FAILS on a planted second read",
   (withSecondRead.match(/process\.env\.APP_BASE_URL/g) || []).length === 2);

//  Prove the ordering assertion has teeth.
const reordered = "client.messages.create(params) params.statusCallback =";
ok("the ordering check FAILS when the assignment moves after the call",
   !(reordered.indexOf("params.statusCallback") < reordered.indexOf("client.messages.create(params)")));

console.log("\n════════════════════════════════════════════════════════════════");
console.log(`  ASSERTIONS COMPLETE · ${run} run · ${run - failed} passed · ${failed} failed`);
console.log(failed
  ? "  ✗ FAIL — sms_delivery_status_callback.test.js"
  : "  ✓ PASS — the delivery-status callback is wired and cannot drift.");
console.log("  EXIT      " + (failed ? 1 : 0));
console.log("════════════════════════════════════════════════════════════════");
process.exit(failed ? 1 : 0);
