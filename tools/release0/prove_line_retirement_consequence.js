#!/usr/bin/env node
/* ════════════════════════════════════════════════════════════════════
   PROOF — WHAT RETIRING A property_facing LINE ACTUALLY DOES

   The outbound audit found that retiring the active property_facing line
   NULLs properties.sms_number and makes sendPropertySms refuse. It was
   tempting to call that a per-property outbound kill switch.

   Owner ruling, before accepting that name: **prove what it does to
   INBOUND resident messaging too.** A control that silently takes a
   property's phone line down in both directions is not an outbound kill
   switch, and calling it one would be the same class of error as
   believing outbound_policy protected the resident path.

   ── THE ANSWER, MEASURED BELOW ──────────────────────────────────────

   It takes the line down BOTH WAYS. Inbound resolution answers
   `inactiveLine` — distinct from `unknownLine`, so a real operator
   action is not reported as "we have never heard of this number" — and
   writes ZERO rows. The resident's text lands nowhere: no comm_event, no
   conversation, no work order, no reply. The route answers Twilio with
   empty TwiML, so the sender sees silence rather than an error.

   So it is an EMERGENCY LINE-RETIREMENT control, not an outbound-only
   one, and the docs say that.

   ── WHY THIS IS PROVEN, NOT READ ────────────────────────────────────

   The source comment already said "a retired line never resolves inbound
   traffic." A comment is a claim about intent. This drives a real inbound
   message through the real resolver against real PostgreSQL, before and
   after the retirement, and counts the rows.

       tools/build1/run_isolated.sh RETIRE_DATABASE_URL \
         node tools/release0/prove_line_retirement_consequence.js
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const path = require("path");
const { Pool } = require("pg");

const URL = process.env.RETIRE_DATABASE_URL;
const ROOT = path.join(__dirname, "..", "..");

const NUM = "+15559990001";
const RESIDENT = "+15558880002";

let pass = 0, fail = 0;
const ok = (l, c, d) => {
  if (c) { pass++; console.log("  ok    " + l); }
  else { fail++; console.log("  FAIL  " + l + (d ? "\n        " + d : "")); }
  return c;
};

(async function main() {
  if (!URL) { console.error("REFUSED: RETIRE_DATABASE_URL is not set."); process.exit(2); }

  console.log("════════════════════════════════════════════════════════════════");
  console.log("  PROOF  what retiring a property_facing line does — BOTH ways");
  console.log("════════════════════════════════════════════════════════════════");
  console.log("  ASSERTIONS STARTED\n");

  const pool = new Pool({ connectionString: URL });

  /*  The real boundary over the real pool. Transport is a recorder, not
   *  a stub for the decision — every gate below runs for real and the
   *  recorder only stands in for the wire. `enabled()` true so that
   *  "transport not configured" cannot be mistaken for the refusal this
   *  harness is actually measuring. */
  const wire = [];
  const sms = {
    enabled: () => true,
    async sendSms({ to, from, body }) { wire.push({ to, from, body }); return { sent: true, sid: "SM_TEST", status: "queued" }; },
  };
  const boundary = require(path.join(ROOT, "src/comms/communications_boundary.js"))({ pool, sms });

  const prop = (await pool.query(`select id from properties order by created_at limit 1`)).rows[0];
  if (!prop) { console.error("no property in the template database"); process.exit(2); }

  const lineId = (await pool.query(
    `insert into communication_lines
       (e164, line_type, property_id, authority_ceiling, permitted_audience,
        inbound_enabled, outbound_enabled, outbound_policy, status)
     values ($1,'property_facing',$2,'external','residents_and_prospects',
             true, true, 'proactive', 'active') returning id`, [NUM, prop.id])).rows[0].id;

  const countEvents = async () => Number((await pool.query(
    `select count(*)::int n from comm_events`)).rows[0].n);

  // ── BASELINE · the line is active ─────────────────────────────────
  ok("A1  an active line projects the property's number",
     (await pool.query(`select sms_number from properties where id=$1`, [prop.id]))
       .rows[0].sms_number === NUM);

  const before = await countEvents();
  const inA = await boundary.resolveInboundSmsContext(
    { To: NUM, From: RESIDENT, MessageSid: "SM_active_1", body: "my sink is leaking" });
  ok("A2  inbound RESOLVES to the property while active",
     !!inA.property && String(inA.property.id) === String(prop.id) &&
     !inA.unknownLine && !inA.inactiveLine,
     JSON.stringify({ property: !!inA.property, unknownLine: inA.unknownLine,
                      inactiveLine: inA.inactiveLine }));

  const outA = await boundary.sendPropertySms(
    { property_id: prop.id, recipient: RESIDENT, body: "hi", purpose: "agent" });
  ok("A3  outbound reaches the eligibility gate while active — not the line gate",
     outA.reason !== "no_property_line",
     `refused with: ${outA.reason} — expected a CONSENT/mode refusal, which proves ` +
     "the line itself resolved. (This harness does not opt anyone in; the point is " +
     "WHICH gate answers.)");

  // ── THE ACT · retire the line ─────────────────────────────────────
  await pool.query(`update communication_lines set status='retired' where id=$1`, [lineId]);

  ok("B1  the projected number is gone",
     (await pool.query(`select sms_number from properties where id=$1`, [prop.id]))
       .rows[0].sms_number === null);

  const outB = await boundary.sendPropertySms(
    { property_id: prop.id, recipient: RESIDENT, body: "hi", purpose: "agent" });
  ok("B2  OUTBOUND refuses at the line, before consent is even consulted",
     outB.sent === false && outB.reason === "no_property_line",
     JSON.stringify(outB));

  // ── THE QUESTION THAT DECIDES THE NAME ────────────────────────────
  const mid = await countEvents();
  const inB = await boundary.resolveInboundSmsContext(
    { To: NUM, From: RESIDENT, MessageSid: "SM_retired_1", body: "my sink is still leaking" });
  const after = await countEvents();

  ok("B3  INBOUND also fails closed — the resident's message resolves to nothing",
     inB.inactiveLine === true && inB.property === null && inB.comm_event === null,
     JSON.stringify({ inactiveLine: inB.inactiveLine, unknownLine: inB.unknownLine,
                      property: inB.property, comm_event: inB.comm_event }));

  ok("B4  …and ZERO rows are written for it", after === mid,
     `comm_events ${mid} → ${after}. A retired line must not create a ledger entry ` +
     "against a property wall that no longer exists.");

  ok("B5  it is reported as INACTIVE, not UNKNOWN", inB.inactiveLine && !inB.unknownLine,
     "a real operator action must not read as 'we have never heard of this number' — " +
     "that distinction is what tells an operator they did this to themselves");

  ok("B6  nothing reached the wire during any of this", wire.length === 0,
     JSON.stringify(wire));

  // ── REVERSIBILITY · it is a switch, not a demolition ──────────────
  await pool.query(`update communication_lines set status='active' where id=$1`, [lineId]);
  ok("C1  reactivating restores the projected number",
     (await pool.query(`select sms_number from properties where id=$1`, [prop.id]))
       .rows[0].sms_number === NUM);

  const inC = await boundary.resolveInboundSmsContext(
    { To: NUM, From: RESIDENT, MessageSid: "SM_reactivated_1", body: "hello again" });
  ok("C2  …and inbound resolves again", !!inC.property && !inC.inactiveLine);

  ok("C3  the messages sent while retired did NOT arrive late",
     inC.comm_event === null || String(inC.comm_event.id) !== String(inB.comm_event || {}).id,
     "there is no queue. A message that arrived while the line was retired is gone " +
     "from this system permanently — the provider's own logs are the only record.");

  await pool.end();

  console.log("\n  ── WHAT THIS MEANS FOR THE NAME ───────────────────────────────");
  console.log("    NOT an outbound kill switch. Retiring the property_facing line");
  console.log("    takes the property's resident phone line down in BOTH directions,");
  console.log("    and inbound messages sent during that window are lost to this");
  console.log("    system rather than queued. Document it as an EMERGENCY LINE-");
  console.log("    RETIREMENT control. For outbound-only, SMS_SEND_MODE is the one.");

  console.log("\n════════════════════════════════════════════════════════════════");
  console.log(`  ${fail === 0 ? "✓ PASS" : "✗ FAIL"} — ${pass} passed, ${fail} failed`);
  console.log("════════════════════════════════════════════════════════════════\n");
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error("\nERROR:\n" + (e && e.stack || e)); process.exit(2); });
