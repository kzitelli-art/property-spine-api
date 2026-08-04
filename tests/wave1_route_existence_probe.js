#!/usr/bin/env node
// ════════════════════════════════════════════════════════════════════
//  wave1_route_existence_probe.js — DOES THE ROUTE EXIST AT ALL?
//
//  Wave 1 asks for tour completion, post-tour capture, follow-up creation,
//  follow-up completion and the remaining application decisions to be moved
//  onto session-derived authority. Before migrating a browser call site, the
//  route it calls has to actually exist.
//
//  A grep miss is not proof of absence — a path can be composed, mounted
//  under a prefix, or registered from a table. So this asks the running app
//  over real HTTP, with the shared operator key attached so an existing
//  route answers with its own status rather than an auth refusal.
//
//  READING THE RESULT
//    404 with Express's HTML "Cannot POST …"  → NO SUCH ROUTE. Nothing to
//        migrate; the browser has been writing into the void.
//    ANY other status (400/401/403/404-json/409/422/500) → the route EXISTS
//        and answered. It is a migration candidate.
//
//  Writes nothing. Bodies are deliberately empty so an existing route fails
//  its own validation instead of creating data.
// ════════════════════════════════════════════════════════════════════
"use strict";
const path = require("path");
const http = require("http");
const { Pool } = require("pg");
const receipt = require("./_run_receipt.js");

const CONN = receipt.harnessConnectionString();
const PORT = Number(process.env.PROOF_PORT || 3117);
const KEY = process.env.OPERATOR_KEY || "harness-operator-key";

let pass = 0, fail = 0;
const ok = (m, c) => { if (c) { pass++; console.log("   PASS  " + m); }
                       else { fail++; console.log("   FAIL  " + m); } };
const section = (s) => console.log("\n── " + s + " " + "─".repeat(Math.max(0, 58 - s.length)));

function req(method, p, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body || {});
    const h = { "content-type": "application/json", "x-operator-key": KEY,
                "content-length": Buffer.byteLength(data) };
    const r = http.request({ hostname: "127.0.0.1", port: PORT, path: p, method, headers: h }, (res) => {
      let buf = ""; res.on("data", (d) => (buf += d));
      res.on("end", () => { let j = null; try { j = JSON.parse(buf); } catch (_) {}
        resolve({ status: res.statusCode, body: j, raw: buf }); });
    });
    r.on("error", reject);
    r.write(data); r.end();
  });
}

//  Express's default 404 is HTML beginning "Cannot POST". A JSON 404 came
//  from a route that ran and did not find a row — a very different fact.
const isNoSuchRoute = (r) => r.status === 404 && !r.body && /Cannot (POST|GET)/i.test(r.raw || "");

//  Every browser write path in the app whose Wave 1 status is unresolved.
//  `expect` records what the app's call site believes it is calling.
const PATHS = [
  ["/leasing/tour-coverage/rules",            "saveCoverageRule"],
  ["/leasing/tour-coverage/exceptions",       "saveCoverageException"],
  ["/leasing/tours/capture",                  "captureTourBooking"],
  ["/leasing/tours/00000000-0000-0000-0000-000000000000/reassign", "reassignTour"],
  ["/leasing/plan/select",                    "ptStripCommit — FOLLOW-UP CREATION"],
  ["/leasing/plan/send",                      "ptStripRecordSend — FOLLOW-UP COMPLETION"],
  ["/leasing/tours/00000000-0000-0000-0000-000000000000/send-followup", "sendFollowUpNow — FOLLOW-UP COMPLETION"],
  ["/leasing/application/signal",             "ptStripAppSignal"],
  ["/leasing/cadence/run",                    "ptStripRunChecks"],
  ["/leasing/applications/00000000-0000-0000-0000-000000000000/decide", "submitApprovalDecision — APPLICATION DECISION"],
];

//  The controls. These are known-live routes; if the probe calls them
//  "missing" the probe itself is broken, and the run must not be believed.
const CONTROLS = [
  ["/applications/00000000-0000-0000-0000-000000000000/deny",              "deny (migrated this packet)"],
  ["/leasing/tours/00000000-0000-0000-0000-000000000000/check-in",         "check-in (migrated this packet)"],
  ["/leasing/tours/00000000-0000-0000-0000-000000000000/complete",         "complete"],
  ["/leasing/tours/00000000-0000-0000-0000-000000000000/correct-outcome",  "correct-outcome"],
  ["/leasing/tours/00000000-0000-0000-0000-000000000000/no-show",          "no-show"],
  ["/leasing/tours/00000000-0000-0000-0000-000000000000/cancel",           "cancel"],
  ["/leasing/tours/00000000-0000-0000-0000-000000000000/confirm-prospect", "confirm-prospect"],
  ["/leasing/tours/00000000-0000-0000-0000-000000000000/reminder",         "reminder"],
];

(async () => {
  const t0 = receipt.begin(__filename, { url: CONN, expected: PATHS.length + CONTROLS.length + 1 });
  const pool = new Pool({ connectionString: CONN, ssl: false });
  //  server.js listens on process.env.PORT itself and exports nothing.
  process.env.DATABASE_URL = CONN;
  process.env.OPERATOR_KEY = KEY;
  process.env.PORT = String(PORT);
  require(path.join(__dirname, "..", "server.js"));
  await new Promise((r) => setTimeout(r, 1500));

  const missing = [], present = [];
  try {
    section("CONTROLS — known-live routes must NOT read as missing");
    let controlsAllPresent = true;
    for (const [p, label] of CONTROLS) {
      const r = await req("POST", p);
      const gone = isNoSuchRoute(r);
      if (gone) controlsAllPresent = false;
      ok(`control  ${label} answered (status ${r.status})`, !gone);
    }
    //  THE PROBE REFUSES TO REPORT IF ITS OWN DETECTOR IS UNSOUND.
    ok("CONTROL GATE — the detector distinguishes live routes from absent ones",
      controlsAllPresent);
    if (!controlsAllPresent) {
      console.log("\n   REFUSING to classify the unresolved paths: a known-live route");
      console.log("   read as missing, so 'missing' means nothing in this run.");
    }

    section("UNRESOLVED — what the browser actually calls");
    for (const [p, label] of PATHS) {
      const r = await req("POST", p);
      const gone = isNoSuchRoute(r);
      (gone ? missing : present).push([p, label, r.status]);
      console.log(`   ${gone ? "NO ROUTE " : "EXISTS   "} ${label}`);
      console.log(`             ${p}  →  ${r.status}${gone ? "  (Express default 404)" : ""}`);
      ok(`${label} classified from a real response`, controlsAllPresent);
    }

    console.log("\n── SUMMARY ───────────────────────────────────────────────────");
    console.log(`   ROUTE EXISTS : ${present.length}`);
    present.forEach(([p, l, s]) => console.log(`        ${l}  (${s})  ${p}`));
    console.log(`   NO SUCH ROUTE: ${missing.length}`);
    missing.forEach(([p, l]) => console.log(`        ${l}   ${p}`));
  } finally {
    await pool.end();
  }
  const code = receipt.complete({ harness: __filename, passed: pass, failed: fail,
    expectedAtLeast: PATHS.length + CONTROLS.length + 1 });
  process.exit(code);
})().catch((e) => { console.error("DIED:", e); process.exit(1); });
