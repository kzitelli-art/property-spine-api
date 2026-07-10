#!/usr/bin/env node
// ════════════════════════════════════════════════════════════════════
//  http_negative_smoke.js — DEPLOYED HTTP SECURITY NEGATIVES (Phase A)
//
//  Proves the boundary's security behavior through REAL HTTP against the
//  DEPLOYED Render service — middleware order, parsers, signature
//  validation, and route exposure included. No Twilio credentials
//  needed: every test here is a NEGATIVE (a refusal that must happen).
//
//  Run in Render Shell (DATABASE_URL present there enables the
//  write-zero verification) or anywhere with network access:
//
//    API_BASE=https://property-spine-api.onrender.com \
//    [DATABASE_URL=...] [INTAKE_SECRET=...] \
//    node http_negative_smoke.js
//
//  Expected results in PHASE A (no Twilio env vars, SMS_SEND_MODE unset):
//    inbound-sms webhook  → 503 (transport not configured — fail closed
//                           BEFORE any parsing/resolution; zero writes)
//    provider-event       → 403 (signature validation fails with
//                           transport off; zero writes) — the injection
//                           attempt in this test is the exact payload the
//                           OLD code would have accepted into history
//    /leasing/intake      → 401 without the secret; with the secret but
//                           no LEASING_INTAKE_PROPERTY_IDS binding → 503;
//                           with binding but wrong property → 403
//  After Phase B (Twilio vars set), rerun: inbound-sms and provider-event
//  move from 503/403-transport to 403-signature on forged requests —
//  still refusals, still zero writes.
// ════════════════════════════════════════════════════════════════════
const API = (process.env.API_BASE || "https://property-spine-api.onrender.com").replace(/\/$/, "");
const INTAKE_SECRET = process.env.INTAKE_SECRET || null;
const DATABASE_URL = process.env.DATABASE_URL || null;

let pass = 0, fail = 0;
const check = (name, ok, detail) => { ok ? (pass++, console.log(`  ✓ ${name}`)) : (fail++, console.log(`  ✗ ${name}${detail ? " — " + detail : ""}`)); };

async function post(path, { form = null, json = null, headers = {} } = {}) {
  const opts = { method: "POST", headers: { ...headers } };
  if (form) {
    opts.headers["Content-Type"] = "application/x-www-form-urlencoded";
    opts.body = new URLSearchParams(form).toString();
  } else if (json) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(json);
  }
  const r = await fetch(API + path, opts);
  let body = null; try { body = await r.text(); } catch (_) {}
  return { status: r.status, body };
}

(async () => {
  console.log(`═══ DEPLOYED HTTP NEGATIVE SMOKE — ${API} ═══\n`);

  let pool = null, commBefore = null;
  if (DATABASE_URL) {
    const { Pool } = require("pg");
    pool = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });
    commBefore = Number((await pool.query(`select count(*) as count from comm_events`)).rows[0].count);
    console.log(`  (write-zero verification armed: comm_events baseline = ${commBefore})\n`);
  } else {
    console.log("  (DATABASE_URL not set — HTTP codes only; run in Render Shell for write-zero receipts)\n");
  }

  // 1. Forged inbound webhook — no valid Twilio signature.
  const r1 = await post("/communications/inbound-sms", {
    form: { MessageSid: "SM_FORGED_1", From: "+15550001111", To: "+12154452021", Body: "forged inbound" },
    headers: { "X-Twilio-Signature": "forged" },
  });
  check(`forged inbound webhook refused (got ${r1.status}; Phase A expects 503 transport-off, Phase B expects 403 signature)`,
    r1.status === 503 || r1.status === 403);

  // 2. Provider-event injection — the EXACT payload shape the old code
  //    accepted into communication history (body property + message body).
  const r2 = await post("/interactions/provider-event", {
    json: {
      provider_event_id: "SM_INJECT_1", direction: "inbound",
      property_id: "a50fbdd0-3642-431e-b532-0dcd6ab8a4fe",
      person_id: null, body: "INJECTED MESSAGE — should never enter history",
      provider_status: "received",
    },
  });
  check(`provider-event injection refused (got ${r2.status}; expects 403)`, r2.status === 403);

  // 2b. provider-event with form-encoded Twilio-status shape, forged signature.
  const r2b = await post("/interactions/provider-event", {
    form: { MessageSid: "SM_INJECT_2", MessageStatus: "delivered" },
    headers: { "X-Twilio-Signature": "forged" },
  });
  check(`provider-event forged status callback refused (got ${r2b.status}; expects 403)`, r2b.status === 403);

  // 3. Intake without the secret.
  const r3 = await post("/leasing/intake", {
    json: { property_id: "a50fbdd0-3642-431e-b532-0dcd6ab8a4fe", phone: "+15550002222", name: "Smoke Test" },
  });
  check(`intake without secret refused (got ${r3.status}; expects 401 — or 503 if secret unset server-side)`,
    r3.status === 401 || r3.status === 503);

  // 3b/3c. Intake WITH the secret (only if provided to this script).
  if (INTAKE_SECRET) {
    const r3b = await post("/leasing/intake", {
      json: { property_id: "9e2bb96e-08e2-41db-81c2-91055ceb50a3", phone: "+15550002223", name: "Smoke Cross" },
      headers: { "x-intake-secret": INTAKE_SECRET },
    });
    check(`intake to a NON-entitled property refused (got ${r3b.status}; expects 403 — or 503 if property binding unset)`,
      r3b.status === 403 || r3b.status === 503);
  } else {
    console.log("  (INTAKE_SECRET not provided — skipped entitled/cross-property intake checks)");
  }

  // 4. Write-zero verification (Render Shell / DATABASE_URL runs).
  if (pool) {
    const commAfter = Number((await pool.query(`select count(*) as count from comm_events`)).rows[0].count);
    check(`all refused requests wrote ZERO comm_events (${commBefore} → ${commAfter})`, commAfter === commBefore);
    const injected = Number((await pool.query(
      `select count(*) as count from comm_events where provider_event_id in ('SM_INJECT_1','SM_INJECT_2') or sms_sid = 'SM_FORGED_1'`)).rows[0].count);
    check("no forged/injected identifier appears anywhere in communication history", injected === 0);
    await pool.end();
  }

  console.log(`\n═══ RESULT: ${pass} passed · ${fail} failed ═══`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error("SMOKE CRASH:", e.message); process.exit(2); });
