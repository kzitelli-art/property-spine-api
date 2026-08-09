#!/usr/bin/env node
/* ════════════════════════════════════════════════════════════════════
   PROOF — THE PREFLIGHT'S SMS POSTURE SECTION

   Owner ruling: the deployed SMS_SEND_MODE posture is recorded BEFORE
   transport goes live, and it is part of the Release 0 preflight. The
   invariant being scored:

       Twilio credentials live + SMS_SEND_MODE disabled
         → technician operations replies work
         → resident outbound sends remain structurally refused

   ── WHY THIS HARNESS EXISTS ─────────────────────────────────────────

   The source side is already held by tests/gate_outbound_senders.js.
   What is NOT held anywhere is that the PREFLIGHT scores the deployed
   configuration correctly — and a preflight that scored it wrongly would
   be worse than none, because it would say SAFE over a live resident
   path. So every combination is exercised against a real database, by
   running the real tool as a child process and reading what it printed.

   ── THE TWO ASSERTIONS THAT ARE NOT ABOUT SCORING ───────────────────

   L1/L2 assert that no credential value and no provider_config content
   reaches the output. A previous screenshot exposed a live auth token
   through a shell expansion, and provider_config carries the same class
   of secret. Presence is a boolean; the value never leaves the process.

   ── THE FALSE-ALARM CASE ────────────────────────────────────────────

   P5 is the one people get wrong. An unrecognised SMS_SEND_MODE resolves
   to `disabled` in the boundary, so a retired mode string is SAFE. A
   check that flagged it would train operators to ignore this section.

       tools/build1/run_isolated.sh PREFLIGHT_DATABASE_URL \
         node tools/release0/prove_preflight_sms_posture.js
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const path = require("path");
const { execFileSync } = require("child_process");
const { Client } = require("pg");

const URL = process.env.PREFLIGHT_DATABASE_URL;
const TOOL = path.join(__dirname, "preflight_production.js");

/*  Values that must never appear in the output. Distinctive enough that
 *  a substring hit is a real leak and not a coincidence. */
const FAKE_TOKEN = "tok_LEAKCANARY_authtoken_9f31";
const FAKE_SID = "AC_LEAKCANARY_accountsid_7b02";
const FAKE_PROVIDER_SECRET = "pv_LEAKCANARY_providerconfig_4d88";

let pass = 0, fail = 0;
const ok = (l, c, d) => {
  if (c) { pass++; console.log("  ok    " + l); }
  else { fail++; console.log("  FAIL  " + l + (d ? "\n        " + d : "")); }
  return c;
};

/*  Run the real tool. It exits 1 on any contradiction — including ones
 *  that have nothing to do with SMS — so the exit code is NOT the
 *  signal here. The signal is the SMS posture line itself. */
function run(env) {
  const base = {
    PATH: process.env.PATH, HOME: process.env.HOME,
    DATABASE_URL: URL,
  };
  let out;
  try {
    out = execFileSync(process.execPath, [TOOL], {
      env: Object.assign(base, env), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (e) {
    out = String(e.stdout || "") + String(e.stderr || "");
  }
  const line = out.split("\n").find((l) => /SMS posture/.test(l)) || "";
  return {
    all: out,
    line,
    red: /^\s*⛔\s+SMS posture/.test(line),
    green: /^\s*ok\s+SMS posture/.test(line),
  };
}

const ONINST = { RENDER_GIT_COMMIT: "deadbeefdeadbeefdeadbeef" };
const CREDS = { TWILIO_ACCOUNT_SID: FAKE_SID, TWILIO_AUTH_TOKEN: FAKE_TOKEN };

(async function main() {
  if (!URL) { console.error("REFUSED: PREFLIGHT_DATABASE_URL is not set."); process.exit(2); }

  console.log("════════════════════════════════════════════════════════════════");
  console.log("  PROOF  the preflight's SMS posture section");
  console.log("════════════════════════════════════════════════════════════════");
  console.log("  ASSERTIONS STARTED\n");

  const db = new Client({ connectionString: URL });
  await db.connect();

  const prop = (await db.query(
    `select id from properties order by created_at limit 1`)).rows[0];
  if (!prop) { console.error("no property in the template database"); process.exit(2); }

  /*  Give the property a number the ONLY way there is one.
   *
   *  A first version of this harness wrote properties.sms_number
   *  directly and was refused by the database: it is a READ-ONLY
   *  PROJECTION of the active property_facing line (migration 130). That
   *  refusal corrected the audit — the resident path does not read
   *  communication_lines at send time, but the number it reads is
   *  maintained FROM that table. Seeding through the canonical row is
   *  not a workaround; it is the only write path there is. */
  await db.query(
    `insert into communication_lines
       (e164, line_type, property_id, authority_ceiling, permitted_audience,
        inbound_enabled, outbound_enabled, outbound_policy, status)
     values ('+15550000000','property_facing',$1,'external','residents_and_prospects',
             true, true, 'proactive', 'active')`, [prop.id]);
  const projected = (await db.query(
    `select sms_number from properties where id = $1`, [prop.id])).rows[0].sms_number;
  ok("X1  properties.sms_number is projected from the active property_facing line",
     projected === "+15550000000",
     "read back: " + String(projected) +
     " — the resident `from` is downstream of communication_lines, by trigger");

  await db.query(
    `update communication_lines set provider_config = jsonb_build_object('auth', $1::text)
      where e164 = '+15550000000'`, [FAKE_PROVIDER_SECRET]);
  ok("X2  configuring a PROVIDER on that line does not change the projection",
     (await db.query(`select sms_number from properties where id = $1`,
       [prop.id])).rows[0].sms_number === "+15550000000",
     "provider_config is not in the projection, so wiring a carrier to the " +
     "resident line does not by itself arm resident sending. This is the claim " +
     "the whole audit turns on, and it is measured here rather than reasoned.");

  await db.query(`update communication_lines set status = 'retired' where e164 = '+15550000000'`);
  ok("X3  RETIRING that line NULLs the projection — a second, independent kill switch",
     (await db.query(`select sms_number from properties where id = $1`,
       [prop.id])).rows[0].sms_number === null,
     "sendPropertySms refuses with no_property_line when there is no number, and " +
     "never falls back to a Messaging Service default. So resident sending can be " +
     "stopped at the DATA layer too, not only by SMS_SEND_MODE.");
  await db.query(`update communication_lines set status = 'active' where e164 = '+15550000000'`);

  // ── the dangerous combinations ────────────────────────────────────
  const p1 = run(Object.assign({}, ONINST, CREDS, { SMS_SEND_MODE: "customer_care" }));
  ok("P1  credentials live + customer_care  → RED", p1.red, p1.line.trim() || "(no line)");

  const p2 = run(Object.assign({}, ONINST, CREDS, { SMS_SEND_MODE: "proof_only" }));
  ok("P2  credentials live + proof_only     → RED", p2.red,
     "proof_only still puts a message on a real handset — the aperture is narrow, " +
     "not closed\n        " + (p2.line.trim() || "(no line)"));

  // ── the safe combinations ─────────────────────────────────────────
  const p3 = run(Object.assign({}, ONINST, CREDS, { SMS_SEND_MODE: "disabled" }));
  ok("P3  credentials live + disabled       → green", p3.green, p3.line.trim() || "(no line)");
  ok("P3b …and it states BOTH consequences, not just the refusal",
     /resident sends\s+structurally refused/.test(p3.all) &&
     /technician replies\s+available/.test(p3.all),
     "the point of the posture is that one lane works while the other cannot. " +
     "Printing only 'resident sends refused' would read as 'SMS is off', which is " +
     "the opposite of what Step 4 needs.");

  const p4 = run(Object.assign({}, ONINST, CREDS));   // SMS_SEND_MODE absent entirely
  ok("P4  credentials live + mode UNSET     → green", p4.green && /unset/.test(p4.line),
     p4.line.trim() || "(no line)");

  const p5 = run(Object.assign({}, ONINST, CREDS, { SMS_SEND_MODE: "internal_qa_autonomous" }));
  ok("P5  credentials live + a RETIRED mode → green (fails closed, not a false alarm)",
     p5.green,
     "an unrecognised mode resolves to `disabled` in the boundary. Flagging it would " +
     "train operators to ignore this section, which is how a real red gets missed.\n" +
     "        " + (p5.line.trim() || "(no line)"));

  const p6 = run(Object.assign({}, ONINST, { SMS_SEND_MODE: "customer_care" }));
  ok("P6  NO credentials + customer_care    → green, with the warning", p6.green &&
     /Verify this mode again immediately BEFORE/.test(p6.all),
     "nothing can send without transport, so this is not a contradiction — but it is " +
     "the exact state that becomes dangerous the moment credentials are added, and " +
     "the operator must be told so at the moment they read it.\n        " +
     (p6.line.trim() || "(no line)"));

  // ── honesty about where it is running ─────────────────────────────
  const p7 = run(Object.assign({}, CREDS, { SMS_SEND_MODE: "disabled" }));  // no SHA
  ok("P7  off-instance → UNKNOWN and RED, never 'unset'",
     p7.red && /UNKNOWN/.test(p7.line),
     "off the deployed instance this process's env is not production's. Reporting it " +
     "as the deployed posture is the same lie as reporting the local checkout's SHA " +
     "as the running one.\n        " + (p7.line.trim() || "(no line)"));

  // ── the leak canaries ─────────────────────────────────────────────
  ok("L1  no credential VALUE reaches the output",
     !p1.all.includes(FAKE_TOKEN) && !p1.all.includes(FAKE_SID) &&
     !p3.all.includes(FAKE_TOKEN) && !p3.all.includes(FAKE_SID),
     "presence is a boolean computed in JS. A live auth token once reached a " +
     "screenshot through `${VAR:-no}`; nothing here may print a credential.");

  //  provider_config carries carrier secrets. The line inventory reports
  //  `provider CONFIGURED` — a boolean — and must never select the jsonb.
  /*  An operations line is OWNED BY AN ORGANIZATION, never by a property
   *  — ck_cl_exactly_one_owner makes the two mutually exclusive, because
   *  the operations number establishes an organization and never a
   *  building. The template carries no organization, so one is created
   *  here rather than passing null and discovering the constraint. */
  const org = (await db.query(
    `insert into organizations (name) values ('SMS posture proof org') returning id`)).rows[0];
  await db.query(
    `insert into communication_lines
       (e164, line_type, property_id, organization_id, authority_ceiling,
        permitted_audience, inbound_enabled, outbound_enabled, outbound_policy,
        status, provider_config)
     values ('+15550000001','operations',null,$1,'operational','staff',true,true,
             'reply_only','active', jsonb_build_object('auth', $2::text))`,
    [org.id, FAKE_PROVIDER_SECRET]);

  const p8 = run(Object.assign({}, ONINST, CREDS, { SMS_SEND_MODE: "disabled" }));
  ok("L2  no provider_config CONTENT reaches the output",
     !p8.all.includes(FAKE_PROVIDER_SECRET),
     "the inventory reports `provider CONFIGURED`, a boolean. Selecting the jsonb " +
     "would put a carrier credential in every preflight transcript.");
  ok("L3  …and no e164 is printed either — operations or resident",
     !p8.all.includes("+15550000001") && !p8.all.includes("+15550000000"),
     "the inbound number is never recorded in a receipt (Step 4 package, RECEIPT " +
     "FIELDS), and the resident line's number is no more printable than the " +
     "technician's");

  // ── the Step 4 blocker, read rather than recited ──────────────────
  ok("S1  an active provider-configured operations line clears the Step 4 blocker",
     /Step 4 transport\s+an active operations line with a provider is present/.test(p8.all),
     "seeded exactly that row above; the preflight must read it from the database " +
     "rather than repeat the 2026-08-06 note");
  ok("S2  …and the line inventory shows presence, not values",
     /operations\s+1 · active · outbound_policy=reply_only · provider CONFIGURED/.test(p8.all),
     p8.all.split("\n").filter((l) => /operations/.test(l)).join("\n        "));

  await db.query(`delete from communication_lines where e164 = '+15550000001'`);
  const p9 = run(Object.assign({}, ONINST, CREDS, { SMS_SEND_MODE: "disabled" }));
  ok("S3  with the line gone the blocker returns — the check is live, not decorative",
     /Step 4 transport\s+BLOCKED/.test(p9.all));

  // ── read-only, measured ───────────────────────────────────────────
  const before = (await db.query(
    `select count(*)::int n, coalesce(max(updated_at)::text,'') t from work_orders`)).rows[0];
  run(Object.assign({}, ONINST, CREDS, { SMS_SEND_MODE: "disabled" }));
  const after = (await db.query(
    `select count(*)::int n, coalesce(max(updated_at)::text,'') t from work_orders`)).rows[0];
  ok("R1  the preflight changed nothing", before.n === after.n && before.t === after.t,
     `${before.n}/${before.t} → ${after.n}/${after.t}`);

  await db.end();

  console.log("\n════════════════════════════════════════════════════════════════");
  console.log(`  ${fail === 0 ? "✓ PASS" : "✗ FAIL"} — ${pass} passed, ${fail} failed`);
  console.log("════════════════════════════════════════════════════════════════\n");
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error("\nERROR:\n" + (e && e.stack || e)); process.exit(2); });
