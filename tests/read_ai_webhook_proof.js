#!/usr/bin/env node
/* ════════════════════════════════════════════════════════════════════
   READ AI WEBHOOK — THE SIGNED INGRESS, OVER REAL HTTP

   This endpoint is the only door in the product that accepts evidence
   from something that is not a signed-in human. So the questions are:

     · does a real HMAC over the RAW bytes actually verify
     · is a bad or missing signature refused BEFORE anything is stored
     · does the global express.json() destroy the verification
     · does a retry create a second delivery
     · does the webhook invent a human actor  (it must not)
     · does an unverified body ever reach storage  (it must not)

   The ordering test is the one that matters most and is the easiest to
   lose: a router mounted after express.json() sees a parsed object, not
   bytes, and every signature check downstream becomes decorative. That
   is asserted here by mounting the app BOTH ways and requiring the
   correct order to pass and the wrong order to fail.

   Database is a scripted stub — what is under test is the security seam
   and the write boundary, and a stub is the only way to assert "nothing
   was stored" as a fact.

       node tests/read_ai_webhook_proof.js
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const path = require("path");
const crypto = require("crypto");
const express = require("express");

let pass = 0, fail = 0;
const ok = (l, c, d) => {
  if (c) { pass++; console.log("  ok    " + l); }
  else { fail++; console.log("  FAIL  " + l + (d ? "\n        " + d : "")); }
  return c;
};

const CONN_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const SECRET = "test-signing-secret-value";
process.env.READ_AI_SIGNING_SECRET_SOLO_V1 = SECRET;

let executed = [];
let deliveries = new Map();

function stubPool(opts = {}) {
  return {
    query: async (sql, params) => {
      const t = String(sql).trim().toLowerCase();
      executed.push(t.split("\n")[0].trim());
      if (/from provider_connections/.test(t)) {
        if (opts.noConnection) return { rows: [] };
        return { rows: [{ id: CONN_ID, signing_secret_ref: "solo_v1", status: "active" }] };
      }
      if (/insert into provider_delivery_refusals/.test(t)) return { rows: [] };
      if (/insert into provider_deliveries/.test(t)) {
        const key = params[1];
        if (deliveries.has(key)) return { rows: [] };          // on conflict do nothing
        const row = { id: "d-" + deliveries.size, received_at: new Date() };
        deliveries.set(key, row);
        return { rows: [row] };
      }
      if (/select id, received_at from provider_deliveries/.test(t)) {
        return { rows: [deliveries.get(params[1])].filter(Boolean) };
      }
      return { rows: [] };
    },
  };
}

const sign = (secret, buf) => crypto.createHmac("sha256", secret).update(buf).digest("hex");

//  A payload shaped like a webhook body. Deliberately NOT a claim about
//  Read's real schema — the real shape is settled from the real payload.
//  What matters here is that the BYTES round-trip, whatever they contain.
const BODY = Buffer.from(JSON.stringify({
  session_id: "sess-aug10", trigger: "meeting_end",
  title: "Weekly SOLO Meeting", zz_last_key: "ordering matters",
}));

function buildApp({ jsonFirst = false } = {}) {
  const app = express();
  const webhook = require(path.join(__dirname, "..", "src/meetings/read_ai_webhook.js"));
  if (jsonFirst) app.use(express.json({ limit: "1mb" }));      // THE WRONG ORDER
  app.use("/", webhook({ pool: stubPool() }));
  if (!jsonFirst) app.use(express.json({ limit: "1mb" }));     // the shipped order
  return app;
}

async function post(base, { body = BODY, sig, requestId = "req-1", headers = {} } = {}) {
  executed = [];
  const h = Object.assign({ "content-type": "application/json" }, headers);
  if (sig !== null) h["x-read-signature"] = sig === undefined ? sign(SECRET, body) : sig;
  if (requestId) h["x-read-request-id"] = requestId;
  const res = await fetch(base + "/integrations/read-ai/webhook",
    { method: "POST", headers: h, body });
  let json = null; try { json = await res.json(); } catch (_) {}
  return { status: res.status, body: json, executed: executed.slice() };
}

const stored = (log) => log.some((s) => s.startsWith("insert into provider_deliveries"));
const refused = (log) => log.some((s) => s.startsWith("insert into provider_delivery_refusals"));

(async () => {
  const app = buildApp();
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = "http://127.0.0.1:" + server.address().port;

  console.log("\n══ SIGNATURE OVER THE RAW BYTES ══");

  deliveries = new Map();
  let r = await post(base);
  ok("a correctly signed delivery is accepted → 202", r.status === 202, "got " + r.status);
  ok("the delivery is stored", stored(r.executed));
  ok("nothing was refused", !refused(r.executed));

  console.log("\n══ NOTHING UNVERIFIED IS STORED ══");

  deliveries = new Map();
  r = await post(base, { sig: null, requestId: "req-nosig" });
  ok("a missing signature → 401", r.status === 401, "got " + r.status);
  ok("no delivery stored", !stored(r.executed), r.executed.join(" | "));
  ok("a refusal receipt IS recorded", refused(r.executed));

  r = await post(base, { sig: "deadbeef", requestId: "req-badsig" });
  ok("a bad signature → 401", r.status === 401, "got " + r.status);
  ok("no delivery stored", !stored(r.executed));
  ok("a refusal receipt IS recorded", refused(r.executed));

  //  A signature valid for DIFFERENT bytes must not validate these bytes.
  r = await post(base, { sig: sign(SECRET, Buffer.from("other")), requestId: "req-wrongbody" });
  ok("a signature over different bytes is refused", r.status === 401);
  ok("no delivery stored", !stored(r.executed));

  //  A signature from the wrong secret.
  r = await post(base, { sig: sign("wrong-secret", BODY), requestId: "req-wrongkey" });
  ok("a signature from the wrong secret is refused", r.status === 401);

  console.log("\n══ THE ORDERING TRAP ══");

  //  Same signature, same bytes — but express.json() ran first, so the
  //  router receives a parsed object rather than the bytes that were
  //  signed. This MUST fail. If it passes, the verification is decorative.
  const bad = buildApp({ jsonFirst: true });
  const badServer = bad.listen(0);
  await new Promise((r2) => badServer.once("listening", r2));
  const badBase = "http://127.0.0.1:" + badServer.address().port;

  deliveries = new Map();
  const r2 = await post(badBase, { requestId: "req-order" });
  ok("mounted AFTER express.json(), a valid signature no longer verifies",
    r2.status !== 202,
    "got " + r2.status + " — if this is 202 the raw body survived and the " +
    "ordering guarantee is untested, not satisfied");
  ok("and nothing is stored in that configuration", !stored(r2.executed));
  badServer.close();

  console.log("\n══ IDEMPOTENCY — RETRY vs RE-PUSH ══");

  deliveries = new Map();
  const first = await post(base, { requestId: "req-retry" });
  const retry = await post(base, { requestId: "req-retry" });
  ok("first delivery → 202", first.status === 202);
  ok("a RETRY of the same request_id → 200, not a second row",
    retry.status === 200 && retry.body && retry.body.duplicate === true,
    retry.status + " " + JSON.stringify(retry.body));
  ok("only one delivery row exists", deliveries.size === 1, "rows: " + deliveries.size);

  //  A manual re-push of the SAME meeting arrives with a NEW request_id.
  //  It is a second DELIVERY and must be preserved — deduping it away
  //  would discard evidence. One meeting, two deliveries, is correct.
  const repush = await post(base, { requestId: "req-manual-2" });
  ok("a manual re-push with a new request_id is a NEW delivery",
    repush.status === 202 && deliveries.size === 2,
    "rows: " + deliveries.size);

  console.log("\n══ AUTHORITY — NO HUMAN IS INVENTED ══");

  const src = require("fs").readFileSync(
    path.join(__dirname, "..", "src/meetings/read_ai_webhook.js"), "utf8")
    .split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");

  ok("the webhook never writes uploaded_by_user_id",
    !/uploaded_by_user_id/.test(src),
    "a webhook has no human; writing one would assert a person was present");
  ok("the webhook never writes a property_id",
    !/property_id/.test(src),
    "Read does not know Spine's property model; binding is a separate governed act");
  ok("the webhook resolves no staff session",
    !/resolveStaffSession|x-staff-session/.test(src));
  ok("the delivery points at a CONNECTION",
    /connection_id/.test(src));

  console.log("\n══ WRITE WALL ══");

  const tables = (src.match(/insert into ([a-z_]+)/g) || []).map((s) => s.replace("insert into ", ""));
  const allowed = new Set(["provider_deliveries", "provider_delivery_refusals"]);
  ok("the webhook writes ONLY to the provider inbox namespace",
    tables.every((t) => allowed.has(t)),
    "wrote: " + tables.join(", "));
  ok("no model call in the request path",
    !/anthropic|messages\.create/i.test(src),
    "Read retries up to 25 times; a model call here is a processing storm");

  console.log("\n══ AVAILABILITY IS NOT REFUSAL ══");

  //  No configured connection is OUR problem, not a rejection of Read's
  //  delivery. 401 is right (we cannot authenticate it); 5xx would burn
  //  a retry on a misconfiguration we should fix.
  const noConn = express();
  noConn.use("/", require(path.join(__dirname, "..", "src/meetings/read_ai_webhook.js"))(
    { pool: stubPool({ noConnection: true }) }));
  const ns = noConn.listen(0);
  await new Promise((r3) => ns.once("listening", r3));
  deliveries = new Map();
  const r3 = await post("http://127.0.0.1:" + ns.address().port, { requestId: "req-noconn" });
  ok("no active connection → refused, nothing stored",
    r3.status === 401 && !stored(r3.executed), "got " + r3.status);
  ns.close();

  server.close();
  console.log(`\n  ${pass} passed · ${fail} failed\n`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error("PROOF CRASHED:", e); process.exit(2); });
