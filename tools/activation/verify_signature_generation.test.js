#!/usr/bin/env node
/* ════════════════════════════════════════════════════════════════════
   PROVE THE GATE 7 SIGNATURES BEFORE PRODUCTION SEES THEM

   signature_controls.js hands production a signature it generated. If
   that generation is subtly wrong, Control B fails, and it fails for OUR
   reason while looking exactly like a broken route.

   This runs the REAL sms.validateWebhook against signatures produced the
   REAL way, over a local express server. No network, no Twilio, no
   production.

   run:  node tools/activation/verify_signature_generation.test.js
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const express = require("express");
const twilio = require("twilio");
const smsTransport = require("../../src/comms/sms.js");

const TOKEN = "faketoken_for_local_signature_proof_only";
const ORIGIN = "https://property-spine-api.onrender.com";
const PATH = "/communications/inbound-sms";
const URL_OK = ORIGIN + PATH;

let pass = 0, fail = 0;
const ok = (l, c, d) => { if (c) { pass++; console.log("  ok    " + l); }
  else { fail++; console.log("  FAIL  " + l + (d ? "\n          → " + d : "")); } return c; };

const PARAMS = {
  MessageSid: "SM00000000000000000000000000000001",
  AccountSid: "AC00000000000000000000000000000001",
  From: "+15550000001", To: "+15550000002",
  NumMedia: "0", Body: "release 0 control - status?",
};

(async function main() {
  console.log("GATE 7 — SIGNATURE GENERATION PROOF (local, no network)\n");

  process.env.TWILIO_ACCOUNT_SID = "AC00000000000000000000000000000001";
  process.env.TWILIO_AUTH_TOKEN = TOKEN;
  process.env.APP_BASE_URL = ORIGIN;
  const sms = smsTransport();

  //  A local server that runs the REAL validator. The transport builds
  //  the signed URL from APP_BASE_URL, never from the request — which is
  //  exactly why a localhost server can prove a production signature.
  const app = express();
  app.post(PATH, express.urlencoded({ extended: false }), (req, res) => {
    res.json({ valid: sms.validateWebhook(req) });
  });
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const port = server.address().port;
  const local = `http://127.0.0.1:${port}${PATH}`;

  const call = async (signature) => {
    const headers = { "content-type": "application/x-www-form-urlencoded" };
    if (signature) headers["x-twilio-signature"] = signature;
    const res = await fetch(local, { method: "POST", headers,
      body: new URLSearchParams(PARAMS).toString() });
    return (await res.json()).valid;
  };

  //  THE ONE THAT MATTERS: the exact call signature_controls.js makes.
  const good = twilio.getExpectedTwilioSignature(TOKEN, URL_OK, PARAMS);
  ok("S1  a signature generated the way the control script generates it VALIDATES",
     await call(good) === true,
     "the control script would have failed production for our own reason");

  ok("S2  no signature → refused", await call(null) === false);
  ok("S3  garbage signature → refused", await call("not-a-signature") === false);

  //  Control C's shape: same params, signed over http:// instead of https://
  const wrongUrl = twilio.getExpectedTwilioSignature(TOKEN, URL_OK.replace(/^https:/, "http:"), PARAMS);
  ok("S4  signature over the WRONG url → refused  (this is Control C)",
     await call(wrongUrl) === false);

  //  A tampered parameter must invalidate — otherwise the signature is
  //  proving the sender and not the payload.
  const tampered = Object.assign({}, PARAMS, { Body: "release 0 control - DONE" });
  const sigForOriginal = twilio.getExpectedTwilioSignature(TOKEN, URL_OK, PARAMS);
  const resTampered = await (async () => {
    const res = await fetch(local, { method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded",
                 "x-twilio-signature": sigForOriginal },
      body: new URLSearchParams(tampered).toString() });
    return (await res.json()).valid;
  })();
  ok("S5  a tampered Body invalidates the signature", resTampered === false);

  //  And the APP_BASE_URL enforcement, end to end through the validator.
  delete process.env.APP_BASE_URL;
  const noBase = smsTransport();
  const app2 = express();
  app2.post(PATH, express.urlencoded({ extended: false }), (req, res) =>
    res.json({ valid: noBase.validateWebhook(req) }));
  const s2 = await new Promise((r) => { const s = app2.listen(0, () => r(s)); });
  const res2 = await fetch(`http://127.0.0.1:${s2.address().port}${PATH}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded",
               "x-twilio-signature": good },
    body: new URLSearchParams(PARAMS).toString() });
  ok("S6  a VALID signature is still refused when APP_BASE_URL is unset",
     (await res2.json()).valid === false,
     "the fail-closed contract is not holding");
  s2.close();

  server.close();
  console.log(`\n  passed ${pass}   failed ${fail}`);
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error("\nERROR:\n" + (e && e.stack || e)); process.exit(1); });
