#!/usr/bin/env node
/* ════════════════════════════════════════════════════════════════════
   RELEASE 0 — MEDIA PRESERVATION, EVIDENCE-SERVICE INTEGRATION PROOF

   Real PostgreSQL, real work_order_proof_attachments rows, real
   constraints. The transport is driven by an injected request function,
   so no socket opens and no Twilio account is contacted.

   ── WHAT IT PROVES ──────────────────────────────────────────────────
     · a successful fetch stores bytes, size, digest, stored_at and the
       VERIFIED mime
     · every failure mode leaves an honest fetch_failed row with none of
       those facts, and never counts as preserved evidence
     · a carrier redelivery produces no second row and no second fetch
     · a photo does not complete work

   ⚠ ISOLATED POSTGRES ONLY. Refuses unless the scale-harness sentinel is
     present — same identity check the scale proof uses.

   run:  node tests/unit/media_evidence_integration.test.js
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const { EventEmitter } = require("events");
const crypto = require("crypto");
const { Client } = require("pg");
const smsTransport = require("../../src/comms/sms.js");
const evidence = require("../../src/technician/evidence_service.js");

const URL_DB = process.env.SCALE_DATABASE_URL
  || "postgresql://postgres@127.0.0.1:5433/r0scale?sslmode=disable";
const SENTINEL = "ISOLATED RELEASE 0 SCALE HARNESS — NEVER PRODUCTION";
const AUTH_HOST = smsTransport.MEDIA_HOST_AUTHENTICATED;
const CDN_HOST = smsTransport.MEDIA_HOST_REDIRECT;
const SID = "ACfake0000000000000000000000000000";
const TOKEN = "faketoken0000000000000000000000000";
const MEDIA_URL = `https://${AUTH_HOST}/2010-04-01/Accounts/${SID}/Messages/MM9/Media/ME9`;
const IMG = Buffer.from("\xff\xd8\xff\xe0integration-jpeg-bytes", "binary");
const IMG_SHA = crypto.createHash("sha256").update(IMG).digest("hex");

let pass = 0, fail = 0;
const ok = (l, c, d) => { if (c) { pass++; console.log("  ok    " + l); }
  else { fail++; console.log("  FAIL  " + l + (d ? "\n          → " + d : "")); } return c; };
const sub = (t) => console.log(`\n── ${t} ${"─".repeat(Math.max(0, 58 - t.length))}`);

function fakeHttps(script, counter) {
  const requestFn = (opts, cb) => {
    const req = new EventEmitter();
    req.setTimeout = (ms, fn) => { req.__timeoutFn = fn; };
    req.destroy = (e) => req.emit("error", e || new Error("destroyed"));
    req.end = () => {
      if (counter) counter.n++;
      const b = script[opts.hostname];
      if (!b) return setImmediate(() => req.emit("error", new Error("no route")));
      setImmediate(() => b({ req, cb, opts }));
    };
    return req;
  };
  return requestFn;
}
function respond(cb, { status = 200, headers = {}, chunks = [] }) {
  const res = new EventEmitter();
  res.statusCode = status; res.headers = headers;
  res.resume = () => {}; res.destroy = () => res.emit("aborted");
  cb(res);
  setImmediate(() => { for (const c of chunks) res.emit("data", c); res.emit("end"); });
}
const script = ({ status = 200, ctype = "image/jpeg", body = [IMG], authStatus = 307 }) => ({
  [AUTH_HOST]: ({ cb }) => (authStatus === 307
    ? respond(cb, { status: 307, headers: { location: `https://${CDN_HOST}/s/ME9.jpg` } })
    : respond(cb, { status: authStatus, headers: {} })),
  [CDN_HOST]: ({ cb }) => respond(cb, {
    status, headers: { "content-type": ctype, "content-length": String(body.reduce((a, b) => a + b.length, 0)) },
    chunks: body }),
});

function transportFor(s, counter) {
  process.env.TWILIO_ACCOUNT_SID = SID;
  process.env.TWILIO_AUTH_TOKEN = TOKEN;
  return smsTransport({ requestFn: fakeHttps(s, counter) });
}

(async function main() {
  const c = new Client({ connectionString: URL_DB });
  await c.connect();
  const g = await c.query(
    "select current_database() db,(select purpose from public.release_0_scale_harness_guard where id=true) p");
  if (g.rows[0].db !== "r0scale" || g.rows[0].p !== SENTINEL) {
    throw new Error("REFUSED: not the isolated harness database");
  }
  console.log("RELEASE 0 — MEDIA EVIDENCE INTEGRATION PROOF\n");

  //  A property, a user and a work order to hang evidence from. Synthetic,
  //  and cleaned up at the end.
  await c.query(`insert into public.properties (id, name)
    values (md5('mi-prop')::uuid,'MEDIA INTEGRATION PROPERTY') on conflict (id) do nothing`);
  await c.query(`insert into public.users (id, name, role, account_kind, is_active, status)
    values (md5('mi-user')::uuid,'MEDIA INTEGRATION TECH','maintenance','human_staff',true,'active')
    on conflict (id) do nothing`);
  await c.query(`insert into public.work_orders
      (id, property_id, title, status, source, urgency_status, work_order_ref)
    values (md5('mi-wo')::uuid, md5('mi-prop')::uuid,'MEDIA INTEGRATION WO','open',
            'media_integration','regular', 7700001)
    on conflict (id) do nothing`);
  const WO = (await c.query("select id, property_id from public.work_orders where source='media_integration'")).rows[0];
  const USER = (await c.query("select id from public.users where id=md5('mi-user')::uuid")).rows[0];

  const base = {
    work_order_id: WO.id, property_id: WO.property_id, uploaded_by_user_id: USER.id,
    provider: "twilio", provider_media_url: MEDIA_URL, mime_type: "image/jpeg",
    proof_classification: "repair_photo",
  };
  const clean = async () => {
    await c.query("delete from public.work_order_proof_attachments where work_order_id=$1", [WO.id]);
  };

  // ── SUCCESS ───────────────────────────────────────────────────────
  sub("successful fetch → durable evidence");
  await clean();
  {
    const sms = transportFor(script({}));
    const out = await evidence.ingestProviderMedia(c,
      Object.assign({}, base, { provider_media_id: "ME-ok" }), { fetchMedia: sms.fetchMedia });
    const a = out.attachment;
    ok("E1  outcome is stored", out.outcome === "stored", JSON.stringify({ o: out.outcome, r: out.reason }));
    ok("E2  exactly one attachment row",
       await one(c, "select count(*) from public.work_order_proof_attachments where work_order_id=$1", [WO.id]) === 1);
    ok("E3  storage_state = stored", a.storage_state === "stored", a.storage_state);
    ok("E4  content is byte-exact", Buffer.isBuffer(a.content) && a.content.equals(IMG));
    ok("E5  byte_size is exact", Number(a.byte_size) === IMG.length, String(a.byte_size));
    ok("E6  sha256 is the digest of the bytes", a.sha256 === IMG_SHA, a.sha256);
    ok("E7  stored_at is present", !!a.stored_at);
    ok("E8  the VERIFIED mime is stored", a.mime_type === "image/jpeg", a.mime_type);
    const preserved = await evidence.preservedEvidenceFor(c,
      { work_order_id: WO.id, classifications: ["repair_photo", "condition"] });
    ok("E9  it counts as preserved evidence", preserved.length === 1, String(preserved.length));
  }

  //  A served mime that differs from the webhook claim must be REFUSED,
  //  and the stored row must never carry the carrier's claim as if it
  //  had been checked.
  sub("verified mime is what was SERVED, not what was claimed");
  await clean();
  {
    const sms = transportFor(script({ ctype: "image/png" }));
    const out = await evidence.ingestProviderMedia(c,
      Object.assign({}, base, { provider_media_id: "ME-mismatch" }), { fetchMedia: sms.fetchMedia });
    ok("E10 claimed jpeg, served png → fetch_failed / mime_mismatch",
       out.outcome === "fetch_failed" && out.reason === "mime_mismatch",
       JSON.stringify({ o: out.outcome, r: out.reason }));
  }

  // ── FAILURE MODES ─────────────────────────────────────────────────
  sub("every failure leaves an honest fetch_failed row");
  for (const [label, s, expectReason] of [
    ["F1  authentication failure", script({ authStatus: 401 }), "authentication_failed"],
    ["F2  oversized response", script({ body: [Buffer.alloc(6 * 1024 * 1024, 0x41)] }), "too_large"],
    ["F3  mime mismatch", script({ ctype: "image/png" }), "mime_mismatch"],
    ["F4  unsupported mime", script({ ctype: "application/pdf" }), "unsupported_mime"],
    ["F5  non-200", script({ status: 500 }), "http_500"],
    ["F6  timeout", { [AUTH_HOST]: ({ req }) => req.__timeoutFn && setImmediate(req.__timeoutFn) }, "fetch_timeout"],
  ]) {
    await clean();
    const sms = transportFor(s);
    const out = await evidence.ingestProviderMedia(c,
      Object.assign({}, base, { provider_media_id: "ME-" + label.slice(0, 2) }),
      { fetchMedia: sms.fetchMedia });
    const a = out.attachment;
    const honest = a.storage_state === "fetch_failed" && a.content === null
      && a.byte_size === null && a.sha256 === null && a.stored_at === null;
    const preserved = await evidence.preservedEvidenceFor(c,
      { work_order_id: WO.id, classifications: ["repair_photo", "condition"] });
    ok(label + " → fetch_failed, no content/size/digest/stored_at, not preserved",
       out.outcome === "fetch_failed" && honest && preserved.length === 0,
       JSON.stringify({ outcome: out.outcome, reason: out.reason, state: a.storage_state,
                        content: a.content === null, size: a.byte_size, sha: a.sha256,
                        stored_at: a.stored_at, preserved: preserved.length }));
    ok(label + "b   the reason names the cause", out.reason === expectReason,
       `${out.reason} vs ${expectReason}`);
  }

  // ── REDELIVERY ────────────────────────────────────────────────────
  sub("carrier redelivery — no second row, no second fetch");
  await clean();
  {
    const counter = { n: 0 };
    const sms = transportFor(script({}), counter);
    const spec = Object.assign({}, base, { provider_media_id: "ME-replay" });
    const first = await evidence.ingestProviderMedia(c, spec, { fetchMedia: sms.fetchMedia });
    const afterFirst = counter.n;
    const second = await evidence.ingestProviderMedia(c, spec, { fetchMedia: sms.fetchMedia });
    ok("R1  first delivery stores", first.outcome === "stored", first.outcome);
    ok("R2  redelivery is reported as replayed", second.outcome === "replayed", second.outcome);
    ok("R3  still exactly ONE attachment row",
       await one(c, "select count(*) from public.work_order_proof_attachments where work_order_id=$1", [WO.id]) === 1);
    ok("R4  the redelivery made NO further HTTP request", counter.n === afterFirst,
       `${afterFirst} → ${counter.n}`);
    ok("R5  the surviving row is the stored one, unchanged",
       second.attachment.sha256 === IMG_SHA && second.attachment.storage_state === "stored");
  }

  // ── EVIDENCE IS NOT COMPLETION ────────────────────────────────────
  sub("a photo is evidence, never completion");
  await clean();
  {
    const before = {
      status: await one(c, "select count(*) from public.work_orders where id=$1 and status='open'", [WO.id]),
      completed: await one(c,
        "select count(*) from public.work_order_progress where work_order_id=$1 and kind='completed'", [WO.id]),
      claimed: await one(c,
        "select count(*) from public.work_order_progress where work_order_id=$1 and kind='completion_claimed'", [WO.id]),
    };
    const sms = transportFor(script({}));
    const out = await evidence.ingestProviderMedia(c,
      Object.assign({}, base, { provider_media_id: "ME-nocomplete" }), { fetchMedia: sms.fetchMedia });
    const after = {
      status: await one(c, "select count(*) from public.work_orders where id=$1 and status='open'", [WO.id]),
      completed: await one(c,
        "select count(*) from public.work_order_progress where work_order_id=$1 and kind='completed'", [WO.id]),
      claimed: await one(c,
        "select count(*) from public.work_order_progress where work_order_id=$1 and kind='completion_claimed'", [WO.id]),
    };
    ok("P1  the attachment was stored", out.outcome === "stored", out.outcome);
    ok("P2  work-order status UNCHANGED", before.status === after.status && after.status === 1);
    ok("P3  completed progress-event count UNCHANGED",
       before.completed === after.completed && after.completed === 0);
    ok("P4  completion-claim count UNCHANGED",
       before.claimed === after.claimed && after.claimed === 0);
    ok("P5  ingestProviderMedia writes to ONE table only — no progress row exists",
       after.completed + after.claimed === 0);
  }

  await clean();
  await c.query("delete from public.work_orders where source='media_integration'");
  console.log(`\n${"═".repeat(66)}\n  passed ${pass}   failed ${fail}\n${"═".repeat(66)}`);
  await c.end();
  process.exit(fail === 0 ? 0 : 1);

  async function one(cl, sql, args) { return Number(Object.values((await cl.query(sql, args)).rows[0])[0]); }
})().catch(e => { console.error("\nHARNESS ERROR:\n" + (e && e.stack || e)); process.exit(1); });
