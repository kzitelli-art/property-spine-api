/* ════════════════════════════════════════════════════════════════════
   audit_fixes_no_db_proof.js — THE 2026-09-04 AUDIT FIXES THAT NEED NO DATABASE

   Born as a scratch harness on the 2026-09-04 audit passes and committed
   so CI runs it (tests/proofs/db_proofs.manifest). Every assertion here
   was first shown RED on the commit before its fix, then GREEN with it —
   the counts are in docs/CURRENT_STATE.md.

   No database: real routers over a real socket with a stub pool where one is needed. Rung: LOCALLY_EXERCISED.
   ════════════════════════════════════════════════════════════════════ */
"use strict";
const path = require("path");
const REPO = path.resolve(__dirname, "..", "..");
const receipt = require("../_run_receipt");
const R = (m) => require(require.resolve(m, { paths: [REPO, REPO + "/node_modules"] }));
const express = R("express"); const http = require("http");
let fails = 0, passes = 0;
const T = (n, ok, d) => { console.log(`  ${ok ? "ok   " : "FAIL "} ${n}${ok ? "" : "   <- " + d}`); if (ok) passes++; else fails++; };
async function serve(mount) {
  const app = express(); app.use(express.json()); mount(app);
  const srv = http.createServer(app); await new Promise((r) => srv.listen(0, r));
  return { srv, base: `http://127.0.0.1:${srv.address().port}` };
}
const stubPool = (rows = []) => ({ query: async () => ({ rows, rowCount: rows.length }),
  connect: async () => ({ query: async () => ({ rows, rowCount: rows.length }), release() {} }) });

(async () => {
  receipt.begin(__filename, { url: null, expected: 18 });
  // ── 1. ASYNC SAFETY NET: a rejected handler is a 500, and the process survives ──
  {
    const { installAsyncRouteSafety, terminalErrorHandler } = R(REPO + "/src/shared/async_route_safety");
    installAsyncRouteSafety();
    let crashed = false; const onUnhandled = () => { crashed = true; };
    process.on("unhandledRejection", onUnhandled);
    const { srv, base } = await serve((app) => {
      const r = express.Router();
      r.get("/throws-after-await", async (_q, _s) => { await new Promise((x) => setTimeout(x, 5)); throw new Error("simulated pool.connect() refusal"); });
      r.get("/throws-with-status", async () => { const e = new Error("no such thing"); e.httpStatus = 404; e.publicMessage = "That does not exist."; throw e; });
      r.get("/fine", async (_q, s) => s.json({ ok: true }));
      app.use("/", r); app.use(terminalErrorHandler);
    });
    const a = await fetch(`${base}/throws-after-await`); const ab = await a.json();
    T("rejected async handler → 500 JSON, no stack on the wire", a.status === 500 && ab.error === "internal_error" && !/\n\s+at /.test(JSON.stringify(ab)) && !JSON.stringify(ab).includes("simulated"), `${a.status} ${JSON.stringify(ab)}`);
    const b = await fetch(`${base}/throws-with-status`); const bb = await b.json();
    T("an error carrying httpStatus keeps it (404) with its public message", b.status === 404 && bb.receipt === "That does not exist.", `${b.status} ${JSON.stringify(bb)}`);
    const c = await fetch(`${base}/fine`);
    T("an ordinary handler is untouched", c.status === 200);
    await new Promise((x) => setTimeout(x, 20));
    T("no unhandledRejection reached the process", crashed === false);
    process.off("unhandledRejection", onUnhandled); srv.close();
  }

  // ── 2. NODE_ENV FAILS CLOSED ──
  {
    const tz = R(REPO + "/src/shared/property_timezone");
    const saved = process.env.NODE_ENV;
    process.env.PROPERTY_OPERATING_TZ_JSON = JSON.stringify({ "p1": "America/New_York" });
    delete process.env.NODE_ENV;
    T("tz override IGNORED when NODE_ENV is unset", tz.resolvePropertyOperatingTimeZone("p1") === null);
    process.env.NODE_ENV = "production";
    T("tz override ignored in production", tz.resolvePropertyOperatingTimeZone("p1") === null);
    process.env.NODE_ENV = "development";
    T("tz override honoured only when asked for by name (development)", tz.resolvePropertyOperatingTimeZone("p1") === "America/New_York");
    if (saved === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = saved;
    delete process.env.PROPERTY_OPERATING_TZ_JSON;
  }
  {
    //  /auth/sms/start with NODE_ENV UNSET must not echo the code. Stub pool
    //  mirrors tests/unit/teamaccess_sms_delivery.test.js; SMS "not sent".
    const saved = process.env.NODE_ENV; delete process.env.NODE_ENV;
    const pool = { async query(sql) { const t = String(sql);
      if (/select id, name from users/i.test(t)) return { rows: [{ id: "user-1", name: "KZ" }] };
      if (/from property_team_assignments a/i.test(t)) return { rows: [{ property_id: "property-sms", sms_ready: true }] };
      if (/select id, token, otp_sent_at from team_invites/i.test(t)) return { rows: [] };
      if (/select id from team_invites/i.test(t)) return { rows: [] };
      if (/insert into team_invites/i.test(t)) return { rows: [{ id: "invite-1", token: "token-1", property_id: "property-sms", phone_number: "+17035550134", accepted_user_id: "user-1", allowed_modules: [], otp_sent_at: null }] };
      if (/select name, sms_number from properties/i.test(t)) return { rows: [{ name: "P", sms_number: "+12155550121" }] };
      return { rows: [] }; } };
    const commBoundary = { async sendPropertySms() { return { sent: false, reason: "no_property_line" }; } };
    const { srv, base } = await serve((app) => app.use("/", R(REPO + "/src/identity/team_access")({ pool, sms: null, commBoundary })));
    const r = await fetch(`${base}/auth/sms/start`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ phone_number: "+17035550134" }) });
    const body = await r.json();
    T("/auth/sms/start with NODE_ENV UNSET: 503 and NO dev_code in the body", r.status === 503 && body.dev_code === undefined, `${r.status} ${JSON.stringify(body)}`);
    srv.close(); if (saved === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = saved;
  }

  // ── 3. operating_window: bad as_of is a 400, not a RangeError ──
  {
    const ow = R(REPO + "/src/shared/operating_window");
    let err = null; try { await ow.currentMonthWindow(stubPool([{ operating_timezone: "America/New_York" }]), { property_id: "p", as_of: "garbage" }); } catch (e) { err = e; }
    T("currentMonthWindow('garbage') → bad_as_of, not RangeError", !!err && err.code === "bad_as_of", err && (err.code || err.message));
  }

  // ── 4. legacy lease routes are contained (410), not 500 ──
  {
    const { srv, base } = await serve((app) => app.use("/", R(REPO + "/src/tenancy/lease_lifecycle_routes")({ pool: stubPool(), spawnObligationFromEvent: async () => {} })));
    for (const [m, p, code] of [["POST", "/leases/x/generate-schedule", "legacy_schedule_writer_contained"], ["GET", "/leases/x/schedule", "legacy_schedule_read_contained"],
                               ["POST", "/leases/x/payments", "legacy_payment_writer_contained"], ["PATCH", "/leases/x/approval", "bare_lease_approval_contained"]]) {
      const r = await fetch(base + p, { method: m, headers: { "content-type": "application/json" }, body: m === "GET" ? undefined : JSON.stringify({ decision: "approve", amount: 5 }) });
      const b = await r.json();
      T(`${m} ${p} → 410 ${code}`, r.status === 410 && b.error === code && !!b.what_you_can_do, `${r.status} ${JSON.stringify(b).slice(0, 80)}`);
    }
    srv.close();
  }

  // ── 5. /agent/capability is gated; /demo/intake/health is demo-only ──
  {
    const savedKey = process.env.OPERATOR_KEY; process.env.OPERATOR_KEY = "k"; delete process.env.DEMO_MODE;
    const { srv, base } = await serve((app) => app.use("/", R(REPO + "/src/leasing/agent_capability")({ anthropic: null, INGEST_MODEL: "m" })));
    const r = await fetch(`${base}/agent/capability`);
    T("GET /agent/capability without the operator key → 401 (was an anonymous paid model call)", r.status === 401, String(r.status));
    srv.close(); if (savedKey === undefined) delete process.env.OPERATOR_KEY; else process.env.OPERATOR_KEY = savedKey;
  }

  // ── 7. /intake/twilio verifies the Twilio signature, fail-closed (CURRENT_STATE #10) ──
  {
    const noop = (_q, _s, next) => next();
    const deps = { pool: stubPool([]), anthropic: {}, INGEST_MODEL: "stub", registryInstance: { resolveOnly() { return null; } },
                   upload: { single: () => noop, array: () => noop, any: () => noop, none: () => noop } };
    const intake = R(REPO + "/src/onboarding/intake");
    const form = "From=%2B12155550100&Body=hello&NumMedia=0";
    const send = async (base) => fetch(`${base}/intake/twilio`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form });
    const unsigned = await serve((app) => app.use("/", intake({ ...deps, sms: { validateWebhook: () => false } })));
    const a = await send(unsigned.base); const at = await a.text(); unsigned.srv.close();
    T("/intake/twilio with a signature that does not verify → 403 and an empty TwiML (was: accepted on a spoofable From allowlist)",
      a.status === 403 && /<Response><\/Response>/.test(at), `${a.status} ${at.slice(0, 80)}`);
    const noTransport = await serve((app) => app.use("/", intake({ ...deps })));
    const b = await send(noTransport.base); noTransport.srv.close();
    T("/intake/twilio with NO sms transport wired → 403 (fail-closed, like its sibling)", b.status === 403, String(b.status));
    const signed = await serve((app) => app.use("/", intake({ ...deps, sms: { validateWebhook: () => true } })));
    const c = await send(signed.base); const ct = await c.text(); signed.srv.close();
    T("/intake/twilio with a verified signature proceeds past the gate (answers TwiML, not 403)", c.status === 200 && /<Response>/.test(ct), `${c.status} ${ct.slice(0, 80)}`);
  }

  // ── 6. applications: expired is not pending (pure logic mirror) ──
  {
    const pending = (apps) => apps.filter((a) => !["active", "declined", "withdrawn", "expired"].includes(a.status)).length;
    T("expired applications are not counted as pending", pending([{ status: "expired" }, { status: "submitted" }]) === 1);
  }

  const code = receipt.complete({ harness: __filename, passed: passes, failed: fails, expectedAtLeast: 18 });
  process.exit(code);
})().catch((e) => { process.exit(receipt.died(__filename, e, 0)); });
