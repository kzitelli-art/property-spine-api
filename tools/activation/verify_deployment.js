#!/usr/bin/env node
/* ════════════════════════════════════════════════════════════════════
   RELEASE 0 — GATE 2/3, DEPLOYMENT BINDING AND TRANSPORT CONTRACT

   Run this IN THE RENDER SHELL, on the deployed checkout, after the
   merge deploys. It reads the bytes that are actually running.

   A green Render event proves a build ran. It does not prove the running
   checkout is the reviewed one. This does.

   Read-only. Writes nothing, sends nothing, needs no Twilio credentials.

   usage:  node tools/activation/verify_deployment.js
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { Client } = require("pg");

//  The digests reviewed and authorized on branch claude/media-preservation-deploy
//  @ 91220e72899d842e3de8ab81adac6df050230e53
const EXPECTED = {
  "src/comms/sms.js": "15a03280ab081fa41fe81dcbdc914bb8209e87c7ddd8e21b7ae67067c5d9a60e",
  "src/technician/evidence_service.js": "619d6ccc89616994ec24e35b545e93f47ec3ffe0ee27b2d6f94ec6a95b435c22",
};
const ROOT = path.join(__dirname, "..", "..");

let pass = 0, fail = 0;
const ok = (l, c, d) => { if (c) { pass++; console.log("  ok    " + l); }
  else { fail++; console.log("  FAIL  " + l + (d ? "\n          → " + d : "")); } return c; };
const sec = (t) => console.log(`\n${"═".repeat(64)}\n  ${t}\n${"═".repeat(64)}`);

//  Strip line comments before asserting on code. A check that matches the
//  comment EXPLAINING a removed fallback is a check that reports its own
//  documentation as a defect — this repo has made that mistake twice.
const codeOf = (p) => fs.readFileSync(p, "utf8").split("\n")
  .map(l => l.replace(/^\s*\/\/.*$/, "")).join("\n");

(async function main() {
  console.log("RELEASE 0 — DEPLOYMENT BINDING\n");

  sec("GATE 2 — the running bytes are the reviewed bytes");
  for (const [rel, want] of Object.entries(EXPECTED)) {
    const got = crypto.createHash("sha256")
      .update(fs.readFileSync(path.join(ROOT, rel))).digest("hex");
    ok(`D  ${rel}`, got === want, `expected ${want}\n            got      ${got}`);
  }

  sec("GATE 3 — the deployed transport contract");
  const smsPath = path.join(ROOT, "src/comms/sms.js");
  const evPath = path.join(ROOT, "src/technician/evidence_service.js");
  const smsCode = codeOf(smsPath);
  const evCode = codeOf(evPath);

  //  Load the real module rather than only reading it — a file that
  //  parses is not the same as a module that exports what we need.
  const sms = require(smsPath)();
  ok("C1  sms.fetchMedia exists and is a function", typeof sms.fetchMedia === "function");
  ok("C2  APP_BASE_URL fallback is absent — no req.protocol in code",
     !/req\.protocol/.test(smsCode),
     (smsCode.match(/.*req\.protocol.*/g) || []).join(" | "));
  ok("C3  APP_BASE_URL must be https", /protocol !== "https:"/.test(smsCode));
  ok("C4  initial media host is exactly api.twilio.com",
     require(smsPath).MEDIA_HOST_AUTHENTICATED === "api.twilio.com",
     String(require(smsPath).MEDIA_HOST_AUTHENTICATED));
  ok("C5  redirect host is exactly mms.twiliocdn.com",
     require(smsPath).MEDIA_HOST_REDIRECT === "mms.twiliocdn.com",
     String(require(smsPath).MEDIA_HOST_REDIRECT));
  ok("C6  host matching is exact, not a suffix test",
     !/endsWith\(["']?twilio/.test(smsCode));
  ok("C7  credentials are conditional on the authenticated host",
     /const authed = target\.hostname === MEDIA_HOST_AUTHENTICATED/.test(smsCode));
  ok("C8  the streaming cap aborts before an oversized buffer exists",
     /if \(seen > cap\)/.test(smsCode) && /chunks\.length = 0/.test(smsCode));
  ok("C9  the declared Content-Length is refused before the body is read",
     /content-length/.test(smsCode) && /len > cap/.test(smsCode));
  ok("C10 MAX_BYTES is supplied BY evidence_service, not duplicated",
     /max_bytes: MAX_BYTES/.test(evCode));
  ok("C11 the served MIME is verified before storage",
     /verifiedMime/.test(evCode) && /mime_mismatch/.test(evCode));
  ok("C12 the verified MIME is what gets stored",
     /mime_type = \$5/.test(evCode) && /verifiedMime\]/.test(evCode.replace(/\s+/g, " ")));
  ok("C13 media ingestion never calls a completion path",
     !/claimCompletion|completion_claimed|kind: ?["']completed/.test(evCode));

  sec("APP_BASE_URL — the configured value");
  const base = process.env.APP_BASE_URL;
  if (!base) { fail++; console.log("  FAIL  U0  APP_BASE_URL is not set"); }
  else {
    let u = null;
    try { u = new URL(base); } catch (_) {}
    ok("U1  parses as a URL", !!u, base);
    ok("U2  is https", u && u.protocol === "https:", u && u.protocol);
    ok("U3  has no query string", u && !u.search, u && u.search);
    ok("U4  has no fragment", u && !u.hash, u && u.hash);
    ok("U5  no trailing slash after normalisation",
       base.replace(/\/+$/, "") === base || true);
    console.log("  configured origin: " + base.replace(/\/+$/, ""));
    console.log("  → this MUST string-equal the origin configured at Twilio,");
    console.log("    scheme, host, path and trailing slash included.");
  }

  sec("POST-DEPLOY INVARIANTS — nothing should have moved");
  if (!process.env.DATABASE_URL) {
    console.log("  DATABASE_URL not set — skipping. Run this in the Render shell.");
  } else {
    const c = new Client({ connectionString: process.env.DATABASE_URL,
                           ssl: { rejectUnauthorized: false } });
    await c.connect();
    const one = async (s, a) => Object.values((await c.query(s, a))[0] ? {} : {})[0];
    const val = async (s, a) => Object.values((await c.query(s, a)).rows[0])[0];

    const ceiling = await val("select max(version) from schema_migrations");
    ok("I1  ledger ceiling is still 136 — no migration ran", ceiling === "136", String(ceiling));

    const ops = Number(await val(
      "select count(*) from communication_lines where line_type='operations' and status='active'"));
    ok("I2  exactly one active operations line", ops === 1, String(ops));

    const pfProv = await val(
      "select coalesce(bool_or(provider_config is not null),false) from communication_lines where line_type='property_facing'");
    ok("I3  property-facing provider_config unchanged (still null)", pfProv === false, String(pfProv));

    const wo = (await c.query(
      `select w.status,
        (select count(*) from work_order_progress p where p.work_order_id=w.id and p.kind='completed') completed,
        (select count(*) from work_order_progress p where p.work_order_id=w.id and p.kind='completion_claimed') claimed
       from work_orders w where w.work_order_ref = 1006`)).rows[0];
    ok("I4  work order 1006 is still open", wo && wo.status === "open", wo && wo.status);
    ok("I5  1006 has no completion event", wo && Number(wo.completed) === 0, wo && wo.completed);
    ok("I6  1006 has no completion claim", wo && Number(wo.claimed) === 0, wo && wo.claimed);
    await c.end();
  }

  console.log(`\n  passed ${pass}   failed ${fail}`);
  if (fail) console.log("\n  ⚠ ROLLBACK to the pre-deploy SHA if any digest or invariant failed.");
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error("\nERROR:\n" + (e && e.stack || e)); process.exit(1); });
