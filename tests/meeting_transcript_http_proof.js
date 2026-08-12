#!/usr/bin/env node
/* ════════════════════════════════════════════════════════════════════
   MEETING TRANSCRIPT INGEST — REAL HTTP

   The unit proof asserts the parser. This one asserts the DOOR: a real
   express app, the real router, real multipart requests over a real
   socket. What it is here to prove is not that a happy path works — it
   is that the door is SHUT, and that a refusal leaves nothing behind.

     · default is deny, with both switches unset
     · the kill switch cannot be bypassed by the allowlist
     · the allowlist alone cannot open the door
     · the cohort gate is on the USER, not the property — a correctly
       entitled operator is still refused
     · a client-supplied property_id is refused, not ignored
     · a refused transcript executes NO insert and DOES roll back

   The database is a scripted stub. That is deliberate: what is under
   test is the authority seam and the write boundary, and a stub is the
   only way to assert "no insert ran" as a fact rather than an intention.
   A real-Postgres proof of the same path is a separate rung and is named
   as not-yet-reached in the receipt.

       node tests/meeting_transcript_http_proof.js
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const path = require("path");
const express = require("express");
const multer = require("multer");
const fs = require("fs");

let pass = 0, fail = 0;
const ok = (l, c, d) => {
  if (c) { pass++; console.log("  ok    " + l); }
  else { fail++; console.log("  FAIL  " + l + (d ? "\n        " + d : "")); }
  return c;
};

const OPERATOR_USER_ID = "11111111-1111-4111-8111-111111111111";
const SESSION_PROPERTY = "22222222-2222-4222-8222-222222222222";
const OTHER_PROPERTY   = "33333333-3333-4333-8333-333333333333";

//  Every statement the request executed, in order. This is the evidence
//  for "a refused transcript writes nothing".
let executed = [];

function stubClient() {
  return {
    query: async (sql, params) => {
      const text = typeof sql === "string" ? sql : sql.text;
      executed.push(text.trim().split("\n")[0].trim().toLowerCase());
      if (/^\s*(begin|commit|rollback)/i.test(text)) return { rows: [] };
      //  The staff-session resolver.
      if (/from staff_sessions/i.test(text)) {
        return { rows: [{
          session_id: "s-1", id: OPERATOR_USER_ID, name: "Test Operator",
          phone: null, email: "op@example.com", global_role: "staff",
          account_kind: "staff", property_id: SESSION_PROPERTY,
          role_title: "Property Manager", allowed_modules: ["maintenance"],
          primary_for_modules: [], can_manage_roles: false,
          expires_at: new Date(Date.now() + 3600e3),
        }] };
      }
      //  The dedup probe: nothing on file.
      if (/from source_artifacts/i.test(text)) return { rows: [] };
      if (/insert into source_artifacts/i.test(text)) {
        return { rows: [{ id: "artifact-1", original_filename: "weekly.txt",
                          artifact_kind: "meeting_transcript", byte_size: 42,
                          sha256: "a".repeat(64), uploaded_at: new Date(),
                          source_as_of_date: "2026-08-11" }] };
      }
      if (/insert into meeting_transcript_segments/i.test(text)) return { rows: [] };
      if (/count\(\*\)/i.test(text)) return { rows: [{ n: 0 }] };
      return { rows: [] };
    },
    release: () => {},
  };
}

const pool = {
  query: (...a) => stubClient().query(...a),
  connect: async () => stubClient(),
};

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });
const app = express();
app.use(express.json());
app.use("/", require(path.join(__dirname, "..", "src/meetings/meeting_transcript_ingest.js"))({ pool, upload }));

const SPECIMEN = fs.readFileSync(
  path.join(__dirname, "fixtures", "meeting_transcript_specimen.txt"), "utf8");

async function post(base, { session, fields = {}, file = SPECIMEN, filename = "weekly.txt" } = {}) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  if (file !== null) form.append("file", new Blob([file], { type: "text/plain" }), filename);
  const headers = {};
  if (session) headers["x-staff-session"] = session;
  executed = [];
  const res = await fetch(base + "/operator/meetings/transcript",
    { method: "POST", headers, body: form });
  let body = null;
  try { body = await res.json(); } catch (_) { body = null; }
  return { status: res.status, body, executed: executed.slice() };
}

const wroteAnything = (log) => log.some((s) => s.startsWith("insert into"));

(async () => {
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = "http://127.0.0.1:" + server.address().port;

  const OLD = { e: process.env.MEETING_TRANSCRIPT_INGEST_ENABLED,
                u: process.env.MEETING_TRANSCRIPT_INGEST_USER_IDS };
  const setGate = (enabled, users) => {
    if (enabled === undefined) delete process.env.MEETING_TRANSCRIPT_INGEST_ENABLED;
    else process.env.MEETING_TRANSCRIPT_INGEST_ENABLED = enabled;
    if (users === undefined) delete process.env.MEETING_TRANSCRIPT_INGEST_USER_IDS;
    else process.env.MEETING_TRANSCRIPT_INGEST_USER_IDS = users;
  };

  console.log("\n══ THE DOOR IS SHUT BY DEFAULT ══");

  setGate(undefined, undefined);
  let r = await post(base, { session: "tok", fields: { meeting_date: "2026-08-11" } });
  ok("both switches unset → 503, not 200", r.status === 503, "got " + r.status);
  ok("default-deny stores nothing", !wroteAnything(r.executed), r.executed.join(" | "));
  ok("the refusal is sayable, not a flag name",
    r.body && /not switched on/.test(r.body.receipt) && !/[a-z]+_[a-z]+/.test(r.body.receipt),
    r.body && r.body.receipt);

  console.log("\n══ NEITHER KEY OPENS THE DOOR ALONE ══");

  setGate(undefined, OPERATOR_USER_ID);
  r = await post(base, { session: "tok", fields: { meeting_date: "2026-08-11" } });
  ok("allowlist alone cannot open the door → 503", r.status === 503, "got " + r.status);
  ok("allowlist alone stores nothing", !wroteAnything(r.executed));

  setGate("true", "");
  r = await post(base, { session: "tok", fields: { meeting_date: "2026-08-11" } });
  ok("kill switch on with an EMPTY allowlist → 503", r.status === 503, "got " + r.status);

  setGate("true", "99999999-9999-4999-8999-999999999999");
  r = await post(base, { session: "tok", fields: { meeting_date: "2026-08-11" } });
  ok("an entitled operator NOT in the cohort is still refused → 503",
    r.status === 503, "got " + r.status);
  ok("cohort refusal stores nothing", !wroteAnything(r.executed));
  ok("the cohort refusal says why, and names a next step",
    r.body && /who may hear/.test(r.body.receipt) && /Ask the Spine team/.test(r.body.receipt),
    r.body && r.body.receipt);

  console.log("\n══ IDENTITY AND PROPERTY AUTHORITY ══");

  setGate("true", OPERATOR_USER_ID);
  r = await post(base, { fields: { meeting_date: "2026-08-11" } });
  ok("no operator session → 401", r.status === 401, "got " + r.status);

  r = await post(base, { session: "tok",
    fields: { meeting_date: "2026-08-11", property_id: OTHER_PROPERTY } });
  ok("a client-supplied property_id is REFUSED, not ignored → 403",
    r.status === 403, "got " + r.status);
  ok("the refusal names the property actually being acted on",
    r.body && r.body.acting_on === SESSION_PROPERTY);
  ok("a cross-property attempt stores nothing", !wroteAnything(r.executed));

  console.log("\n══ A REFUSED TRANSCRIPT WRITES NOTHING ══");

  r = await post(base, { session: "tok", fields: {} });
  ok("a missing meeting date is refused → 400", r.status === 400, "got " + r.status);
  ok("the refusal names the date, not a column", r.body && r.body.error === "meeting_date_required");
  ok("the receipt explains why upload date will not do",
    r.body && /not the date it happened/.test(r.body.receipt), r.body && r.body.receipt);
  ok("no insert ran for a dateless transcript", !wroteAnything(r.executed), r.executed.join(" | "));
  ok("the transaction rolled back", r.executed.includes("rollback"), r.executed.join(" | "));

  r = await post(base, { session: "tok", fields: { meeting_date: "2026-08-11" },
    file: "Weekly Solo — August\n\n0:03 - Robert\nMorning." });
  ok("a file with content above the first block is refused → 400",
    r.status === 400 && r.body.error === "content_before_first_block",
    r.status + " " + (r.body && r.body.error));
  ok("a partially-readable file writes NOTHING", !wroteAnything(r.executed),
    "a stored artifact with no segments reads as 'nothing was discussed'");
  ok("the transaction rolled back", r.executed.includes("rollback"));

  r = await post(base, { session: "tok", fields: { meeting_date: "2026-08-11" },
    file: SPECIMEN, filename: "weekly.vtt" });
  ok("an export format no parser can segment is refused → 400",
    r.status === 400 && r.body.error === "unsupported_file_type",
    r.status + " " + (r.body && r.body.error));
  ok("an unsupported shape writes nothing", !wroteAnything(r.executed));

  r = await post(base, { session: "tok", fields: { meeting_date: "2026-02-31" } });
  ok("a date that does not exist is refused → 400",
    r.status === 400 && r.body.error === "meeting_date_required");

  console.log("\n══ THE PATH THAT IS ALLOWED TO WRITE ══");

  r = await post(base, { session: "tok", fields: { meeting_date: "2026-08-11" } });
  ok("cohort + session + date + readable file → 201", r.status === 201,
    r.status + " " + JSON.stringify(r.body));
  //  The session resolver runs on the POOL, before the transaction is
  //  opened, so `begin` is not the first statement of the request — it is
  //  the first statement of the WRITE. What matters is that both inserts
  //  sit inside it: an artifact committed without its segments is a
  //  meeting Spine claims to hold and cannot quote.
  ok("the artifact and the segments are written in ONE transaction",
    (() => {
      const begin = r.executed.indexOf("begin");
      const commit = r.executed.indexOf("commit");
      const inserts = r.executed
        .map((s, i) => (s.startsWith("insert into") ? i : -1)).filter((i) => i >= 0);
      return begin >= 0 && commit > begin && inserts.length === 2
        && inserts.every((i) => i > begin && i < commit);
    })(),
    r.executed.join(" | "));
  ok("the response echoes the SESSION's property, not a requested one",
    r.body && r.body.property_id === SESSION_PROPERTY);
  ok("the receipt reports the meeting date, not the upload date",
    r.body && r.body.meeting_date === "2026-08-11");
  ok("the receipt counts the turns actually stored",
    r.body && r.body.segment_count === 9, r.body && String(r.body.segment_count));
  ok("the receipt does not claim Ask Spine can read it yet",
    r.body && /not yet readable in Ask Spine/.test(r.body.receipt), r.body && r.body.receipt);

  //  API output keys are a contract — read by name. A blunt rename sweep
  //  once broke a live page silently because the proof asserted the
  //  database rather than the response shape.
  const CONTRACT = ["property_id", "artifact_id", "filename", "meeting_date",
                    "segment_count", "speaker_labels", "duplicate_timestamp_count",
                    "deduplicated", "receipt"];
  ok("the response carries exactly the contracted keys",
    r.body && CONTRACT.every((k) => k in r.body) && Object.keys(r.body).length === CONTRACT.length,
    r.body && Object.keys(r.body).join(","));

  setGate(OLD.e, OLD.u);
  server.close();
  console.log(`\n  ${pass} passed · ${fail} failed\n`);
  process.exit(fail === 0 ? 0 : 1);
})();
