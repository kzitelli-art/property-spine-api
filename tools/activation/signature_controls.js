#!/usr/bin/env node
/* ════════════════════════════════════════════════════════════════════
   RELEASE 0 — GATE 7 SIGNATURE CONTROLS, against production

   Four controls, in a fixed order, each with a before/after row census.

     A  unsigned request            must be REFUSED, must write nothing
     B  correctly signed, text-only must be ACCEPTED and attributed
     C  signature over the WRONG url must be REFUSED, must write nothing
     D  replay of B's MessageSid    must be SUPPRESSED, no second event

   ── WHY B MUST PASS BEFORE A COUNTS ─────────────────────────────────
   A dead route refuses everything, so "unsigned was refused" proves
   nothing on its own. This script REPORTS A first but CREDITS it only
   if B also passes, and says so explicitly in the verdict.

   ── WHY C EXISTS ────────────────────────────────────────────────────
   C signs the same parameters against http:// instead of the configured
   https origin. If APP_BASE_URL were being guessed from proxy headers,
   C would pass and we would never know. It is the control for the
   fail-for-the-wrong-reason trap that APP_BASE_URL enforcement closes.

   ── SECRETS ─────────────────────────────────────────────────────────
   Reads TWILIO_AUTH_TOKEN and TEST_FROM from the environment. Neither is
   printed, logged, or written. Phone numbers appear only as last-4.

   ── WHAT IT WRITES ──────────────────────────────────────────────────
   Control B is a REAL inbound message to the production route. It writes
   one comm_event and whatever the operations turn derives from a
   text-only body. It sends NO completion language and attaches no media.

   usage (Render Shell):
     TEST_FROM='+1XXXXXXXXXX' node tools/activation/signature_controls.js
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const crypto = require("crypto");
const twilio = require("twilio");
const { Client } = require("pg");

const TOKEN = process.env.TWILIO_AUTH_TOKEN;
const BASE = process.env.APP_BASE_URL;
const FROM = process.env.TEST_FROM;
const TO = process.env.TEST_TO;                    // the operations number
const PATH = "/communications/inbound-sms";

let pass = 0, fail = 0;
const ok = (l, c, d) => { if (c) { pass++; console.log("  ok    " + l); }
  else { fail++; console.log("  FAIL  " + l + (d ? "\n          → " + d : "")); } return c; };
const sec = (t) => console.log(`\n${"═".repeat(64)}\n  ${t}\n${"═".repeat(64)}`);
const last4 = (n) => n ? "****" + String(n).slice(-4) : "(unset)";

function need(name, v) {
  if (!v) { console.error(`REFUSED: ${name} is not set.`); process.exit(1); }
  return v;
}

/*  Twilio's OWN signature function, not a reimplementation. Getting
 *  HMAC-SHA1 parameter ordering subtly wrong would produce a control
 *  that fails for a reason we invented. */
function sign(url, params) {
  return twilio.getExpectedTwilioSignature(TOKEN, url, params);
}

async function post(url, params, signature) {
  const body = new URLSearchParams(params).toString();
  const headers = { "content-type": "application/x-www-form-urlencoded" };
  if (signature) headers["x-twilio-signature"] = signature;
  const res = await fetch(url, { method: "POST", headers, body });
  return { status: res.status, text: (await res.text()).slice(0, 200) };
}

async function census(c) {
  const q = async (s, a) => Number(Object.values((await c.query(s, a)).rows[0])[0]);
  return {
    sms_events: await q("select count(*) from comm_events where channel='sms'"),
    inbound: await q("select count(*) from comm_events where channel='sms' and direction='inbound'"),
    outbound: await q("select count(*) from comm_events where channel='sms' and direction='outbound'"),
    attachments: await q("select count(*) from work_order_proof_attachments"),
    completed: await q("select count(*) from work_order_progress where kind='completed'"),
    claimed: await q("select count(*) from work_order_progress where kind='completion_claimed'"),
  };
}
const delta = (a, b) => Object.fromEntries(Object.keys(a).map(k => [k, b[k] - a[k]]));

(async function main() {
  need("TWILIO_AUTH_TOKEN", TOKEN);
  need("APP_BASE_URL", BASE);
  need("TEST_FROM", FROM);
  need("TEST_TO", TO);
  need("DATABASE_URL", process.env.DATABASE_URL);

  //  The URL must be built EXACTLY as the server builds it, or every
  //  control fails for the wrong reason.
  const origin = BASE.replace(/\/+$/, "");
  if (!/^https:\/\//.test(origin)) { console.error("REFUSED: APP_BASE_URL is not https."); process.exit(1); }
  const URL_OK = origin + PATH;
  const URL_WRONG = URL_OK.replace(/^https:/, "http:");

  console.log("RELEASE 0 — GATE 7 SIGNATURE CONTROLS");
  console.log("  target        " + URL_OK);
  console.log("  from          " + last4(FROM));
  console.log("  to            " + last4(TO));

  const c = new Client({ connectionString: process.env.DATABASE_URL,
                         ssl: { rejectUnauthorized: false } });
  await c.connect();
  const c0 = await census(c);
  console.log("  census before " + JSON.stringify(c0));

  //  ONE sid for B, reused verbatim by D. A fresh sid in D would prove
  //  nothing about idempotency — it would just be a second message.
  const SID_B = "SM" + crypto.randomBytes(16).toString("hex");
  const paramsB = {
    MessageSid: SID_B, AccountSid: process.env.TWILIO_ACCOUNT_SID || "AC" + "0".repeat(32),
    From: FROM, To: TO, NumMedia: "0",
    //  NO completion language. "status" is a question, not a claim.
    Body: "release 0 control - status?",
  };

  // ══ A — UNSIGNED ═══════════════════════════════════════════════════
  sec("CONTROL A — unsigned request must be REFUSED");
  const a = await post(URL_OK, paramsB, null);
  const cA = await census(c);
  const dA = delta(c0, cA);
  console.log("  http " + a.status + "   delta " + JSON.stringify(dA));
  const aRefused = ok("A1  refused with 403", a.status === 403, "got " + a.status + " " + a.text);
  ok("A2  wrote ZERO rows", Object.values(dA).every(v => v === 0), JSON.stringify(dA));

  // ══ B — CORRECTLY SIGNED ═══════════════════════════════════════════
  sec("CONTROL B — correctly signed, text-only, must be ACCEPTED");
  const b = await post(URL_OK, paramsB, sign(URL_OK, paramsB));
  await new Promise(r => setTimeout(r, 4000));   // the route acks, then works
  const cB = await census(c);
  const dB = delta(cA, cB);
  console.log("  http " + b.status + "   delta " + JSON.stringify(dB));
  const bAccepted = ok("B1  NOT refused", b.status !== 403, "got " + b.status + " " + b.text);
  ok("B2  exactly one inbound comm_event", dB.inbound === 1, JSON.stringify(dB));
  ok("B3  no attachment (text-only)", dB.attachments === 0, String(dB.attachments));
  ok("B4  no completion event", dB.completed === 0, String(dB.completed));
  ok("B5  no completion claim", dB.claimed === 0, String(dB.claimed));

  const ev = (await c.query(
    `select id, direction, classification, created_object_type, created_object_id,
            left(body,70) as body
       from comm_events where channel='sms' order by occurred_at desc limit 2`)).rows;
  console.log("  most recent events:");
  for (const e of ev) console.log("    " + e.direction + " | " + (e.classification || "-")
    + " | obj: " + (e.created_object_type || "-") + " | " + e.body);

  // ══ C — SIGNATURE OVER THE WRONG URL ═══════════════════════════════
  sec("CONTROL C — signature over http:// must be REFUSED");
  const paramsC = Object.assign({}, paramsB, {
    MessageSid: "SM" + crypto.randomBytes(16).toString("hex") });
  const cc = await post(URL_OK, paramsC, sign(URL_WRONG, paramsC));
  const cC = await census(c);
  const dC = delta(cB, cC);
  console.log("  http " + cc.status + "   delta " + JSON.stringify(dC));
  ok("C1  refused with 403", cc.status === 403, "got " + cc.status + " " + cc.text);
  ok("C2  wrote ZERO rows", Object.values(dC).every(v => v === 0), JSON.stringify(dC));
  ok("C3  proves APP_BASE_URL is not being guessed from proxy headers",
     cc.status === 403 && bAccepted);

  // ══ D — DUPLICATE PROVIDER IDENTITY ════════════════════════════════
  sec("CONTROL D — replay of B's MessageSid must be SUPPRESSED");
  const d = await post(URL_OK, paramsB, sign(URL_OK, paramsB));
  await new Promise(r => setTimeout(r, 4000));
  const cD = await census(c);
  const dD = delta(cC, cD);
  console.log("  http " + d.status + "   delta " + JSON.stringify(dD));
  ok("D1  not refused (a replay is a legitimate carrier retry)", d.status !== 403,
     "got " + d.status);
  ok("D2  NO second inbound event for the same sid", dD.inbound === 0, JSON.stringify(dD));
  ok("D3  no second domain consequence at all",
     Object.values(dD).every(v => v === 0), JSON.stringify(dD));

  // ══ VERDICT ════════════════════════════════════════════════════════
  sec("VERDICT");
  console.log("  census after  " + JSON.stringify(cD));
  console.log("  total delta   " + JSON.stringify(delta(c0, cD)));
  if (!bAccepted) {
    console.log("\n  ⚠ CONTROL A IS NOT CREDITED.");
    console.log("    B did not pass, so a refusing route is indistinguishable from");
    console.log("    a dead one. 'Unsigned was refused' proves nothing here.");
    fail++;
  } else if (aRefused) {
    console.log("\n  A is credited: unsigned refused AND signed accepted.");
  }
  console.log(`\n  passed ${pass}   failed ${fail}`);
  await c.end();
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error("\nCONTROL HARNESS ERROR:\n" + (e && e.stack || e)); process.exit(1); });
