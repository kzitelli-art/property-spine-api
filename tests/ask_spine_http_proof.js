#!/usr/bin/env node
// ════════════════════════════════════════════════════════════════════
//  ask_spine_http_proof.js — ASK SPINE SLICE 1, HTTP RUNG
//
//  WHAT THIS RUNG PROVES
//  A real Express server, the REAL ask_spine router mounted on it, and
//  real HTTP requests over a real socket. It proves status codes, the
//  gate's behaviour, the response envelope, and that a failed read
//  reaches the client as 500 rather than as an empty list.
//
//  WHAT IT DOES NOT PROVE
//  The session resolver and the database are STUBBED — there is no
//  Postgres server in this environment (psql client only). So this does
//  NOT prove real session resolution, the real SQL against real rows, or
//  the assignment join. Those need the isolated-Postgres rung.
//
//  Per §33 this is rung 2 of 4. Do not call the slice Proven on the back
//  of it; real Postgres and browser verification are still outstanding.
// ════════════════════════════════════════════════════════════════════

"use strict";

const http = require("http");
const path = require("path");
const receipt = require("./_run_receipt.js");

const EXPECTED_ASSERTIONS = 18;

let pass = 0, fail = 0;
function T(name, fn) {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name}\n      ${e.message}`); }
}
function eq(a, b, m) { if (a !== b) throw new Error(`${m || ""} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }
function ok(v, m) { if (!v) throw new Error(m || "expected truthy"); }

const PROP  = "a50fbdd0-3642-431e-b532-0dcd6ab8a4fe";
const OTHER = "9e2bb96e-08e2-41db-81c2-91055ceb50a3";
const TOKEN = "valid-session-token";

//  ── Stub the session resolver BEFORE the router requires it. The router
//     is otherwise the real module, unmodified.
const resolverPath = require.resolve("../src/identity/staff_session_service.js");
require.cache[resolverPath] = {
  id: resolverPath, filename: resolverPath, loaded: true, exports: {
    async resolveStaffSession(_pool, token) {
      if (token !== TOKEN) return null;
      return {
        id: "user-1", name: "QA Operator", property_id: PROP,
        allowed_modules: ["leasing", "maintenance"],
      };
    },
  },
};

//  ── A stub pool whose behaviour each test controls.
let dbMode = "rows";
let lastParams = null;
const pool = {
  async query(_sql, params) {
    lastParams = params;
    if (dbMode === "error") throw new Error("connection reset");
    if (dbMode === "empty") return { rows: [] };
    return { rows: [{
      id: "ob-1", label: "Call the lead back", module: "leasing", type: "lead_response",
      status: "open", due_at: new Date(Date.now() - 3600e3).toISOString(),
      person_id: "person-1", unit_id: "unit-9", related_type: null, related_id: null,
      assigned_user_id: null, is_overdue: true, is_unassigned: true, total_open: "23",
    }] };
  },
};

function request(method, urlPath, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: PORT, path: urlPath, method, headers: headers || {} },
      (res) => {
        let body = "";
        res.on("data", (c) => { body += c; });
        res.on("end", () => {
          let parsed = null; try { parsed = JSON.parse(body); } catch (_) {}
          resolve({ status: res.statusCode, body, json: parsed });
        });
      });
    req.on("error", reject);
    req.end();
  });
}

let PORT = 0, server = null;

(async () => {
  receipt.begin(__filename, { expected: EXPECTED_ASSERTIONS });

  const express = require("express");
  const app = express();
  app.use(express.json());
  app.use("/", require("../src/agent/ask_spine.js")({ pool }));   // the REAL router

  server = http.createServer(app);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  PORT = server.address().port;
  console.log(`  (real HTTP server on 127.0.0.1:${PORT})\n`);

  const URL = "/operator/ask-spine/attention";

  // ── the gate ───────────────────────────────────────────────────────
  {
    const r = await request("GET", URL, {});
    T("G1  no session header → 401, not 200-with-empty", () => {
      eq(r.status, 401);
      ok(!r.json || !Array.isArray(r.json.items), "an unauthenticated call must not return an items list");
    });
    const r2 = await request("GET", URL, { "x-staff-session": "bogus" });
    T("G2  an unrecognised session → 401", () => eq(r2.status, 401));
  }

  // ── client cannot choose the property ──────────────────────────────
  {
    const r = await request("GET", `${URL}?property_id=${OTHER}`, { "x-staff-session": TOKEN });
    T("G3  a mismatched client property_id → 403 refusal", () => eq(r.status, 403));
    T("G4  the refusal names server-derived authority and the acting property", () => {
      ok(/server-derived/.test(r.json.error));
      eq(r.json.acting_on, PROP);
    });
    const r2 = await request("GET", `${URL}?property_id=${PROP}`, { "x-staff-session": TOKEN });
    T("G5  a MATCHING client property_id is allowed through (it selects nothing)", () => eq(r2.status, 200));
    T("G6  the query was still bound to the SESSION property", () => eq(lastParams[0], PROP));
  }

  // ── the happy read ─────────────────────────────────────────────────
  {
    dbMode = "rows";
    const r = await request("GET", URL, { "x-staff-session": TOKEN });
    T("H1  200 with a live envelope", () => {
      eq(r.status, 200);
      ok(r.json && Array.isArray(r.json.items));
    });
    T("H2  property_id is echoed from the session", () => eq(r.json.property_id, PROP));
    T("H3  the item carries its ranking reason", () => eq(r.json.items[0].reason, "overdue_unassigned"));
    T("H4  total_open reports the true total, not the page size", () => eq(r.json.total_open, 23));
    T("H5  a person-backed item carries the verified opener", () => {
      eq(r.json.items[0].open.kind, "person");
      eq(r.json.items[0].open.id, "person-1");
    });
    T("H6  the unit is context, never a link", () => {
      eq(r.json.items[0].unit_id, "unit-9");
      ok(r.json.items[0].open.kind !== "unit");
    });
    T("H7  module entitlement came from the session, not the request", () => {
      ok(Array.isArray(lastParams[1]));
      eq(lastParams[1].join(","), "leasing,maintenance");
    });
  }

  // ── empty vs unavailable, over real HTTP ───────────────────────────
  {
    dbMode = "empty";
    const r = await request("GET", URL, { "x-staff-session": TOKEN });
    T("E1  a genuine empty result is 200 with items:[] and total_open:0", () => {
      eq(r.status, 200); eq(r.json.items.length, 0); eq(r.json.total_open, 0);
    });

    dbMode = "error";
    const r2 = await request("GET", URL, { "x-staff-session": TOKEN });
    T("E2  a failed read is 500 — NOT 200", () => eq(r2.status, 500));
    T("E3  the failure body carries NO items key at all", () => {
      ok(!("items" in (r2.json || {})), "a failure must not be shaped like an empty result");
    });
    T("E4  the failure is legible to the operator", () => {
      ok(/Could not read the work queue/.test(r2.json.error));
    });
    dbMode = "rows";
  }

  // ── read-only surface ──────────────────────────────────────────────
  {
    const r = await request("POST", URL, { "x-staff-session": TOKEN });
    T("R1  POST to the Ask Spine path is not routed (GET-only surface)", () => {
      ok(r.status === 404 || r.status === 405, `expected 404/405, got ${r.status}`);
    });
    const r2 = await request("GET", "/operator/staff-agent/thread", { "x-staff-session": TOKEN });
    T("R2  Ask Spine's router does not answer staff-agent paths", () => eq(r2.status, 404));
  }

  await new Promise((r) => server.close(r));
  process.exit(receipt.complete({
    harness: __filename, passed: pass, failed: fail,
    expectedAtLeast: EXPECTED_ASSERTIONS,
  }));
})().catch((e) => {
  try { if (server) server.close(); } catch (_) {}
  receipt.died(__filename, e, pass + fail);
  process.exit(1);
});
